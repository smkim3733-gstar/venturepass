import { describe, expect, it, vi } from "vitest";
import { caseSchema, emptyProfile, type StudioCase } from "@/lib/studio-schema";
import type { ManualPlanSave } from "./manual-plan-save";
import {
  ManualPlanJournal,
  ManualPlanRecoveryError,
  manualPlanRecoveryKey,
  manualPlanRecoveryMessage,
  type ManualPlanReceipt,
} from "./manual-plan-recovery";
const id = "11111111-1111-4111-8111-111111111111";
const planId = "22222222-2222-4222-8222-222222222222";
const savedId = "33333333-3333-4333-8333-333333333333";
function fixture() {
  const company = caseSchema.parse({
    id,
    profile: { ...emptyProfile(), companyName: "합성 수정본 단위 검증" },
    sources: [],
    analysis: null,
    selectedCandidateId: null,
    tasks: [],
    stage: "drafting",
    revision: 7,
    createdAt: "2026-10-10",
    updatedAt: "2026-10-10",
    plans: [
      {
        id: planId,
        version: 3,
        mode: "ai",
        generatedAt: "2026-10-09",
        candidateId: "synthetic",
        sourceRevision: 2,
        confirmedAt: null,
        review: [],
        content: {
          title: "원래 제목",
          summary: "원래 요약",
          sections: [
            {
              key: "problem",
              title: "고객 문제",
              content: "원래 본문",
              evidence: [],
              needsConfirmation: true,
            },
          ],
          actionItems: ["남은 확인"],
          interviewQuestions: [],
        },
      },
    ],
  });
  const content = structuredClone(company.plans[0].content);
  content.sections[0].content = "명시 수정 본문";
  const pending: ManualPlanSave = { company, mutation: { action: "save-plan", planId, content } };
  const next = structuredClone(company);
  next.revision++;
  next.plans.push({
    ...structuredClone(company.plans[0]),
    id: savedId,
    version: 4,
    mode: "manual",
    content: structuredClone(content),
  });
  return { pending, next };
}

type Transport = ConstructorParameters<typeof ManualPlanJournal>[3];
function setup(transport?: Transport) {
  const { pending, next } = fixture();
  const values = new Map<string, string>();
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
  };
  const lock: ConstructorParameters<typeof ManualPlanJournal>[2] = async (_name, task) => task();
  const send = vi.fn<Transport>(transport ?? (async () => next));
  const create = (t: Transport = send) => new ManualPlanJournal(id, storage, lock, t);
  return { pending, next, values, storage, send, create, current: () => pending.company };
}
async function unknown() {
  const f = setup(async () => {
    throw Error("HTTP details must stay internal");
  });
  let receipt: ManualPlanReceipt | undefined;
  await expect(
    f.create().save(f.pending, f.current, (r) => {
      receipt = r;
    }),
  ).rejects.toThrow();
  expect(f.send).toHaveBeenCalledTimes(1);
  return { ...f, receipt: receipt! };
}
describe("수정본의 최소 식별 복구 기록", () => {
  it("첫 명시 저장 전에 본문 없는 식별만 읽기 대조하고 정확한 응답으로 해제한다", async () => {
    const f = setup();
    const onPending = vi.fn((r: ManualPlanReceipt) => {
      const raw = f.values.get(manualPlanRecoveryKey(id))!;
      expect(JSON.parse(raw)).toEqual(r);
      expect(raw.length).toBeLessThan(1024);
      for (const secret of [
        "원래 제목",
        "원래 요약",
        "원래 본문",
        "명시 수정 본문",
        "synthetic",
        "남은 확인",
      ])
        expect(raw).not.toContain(secret);
      expect(Object.keys(r).sort()).toEqual(
        [
          "format",
          "caseId",
          "planId",
          "revision",
          "nextVersion",
          "previousDigest",
          "contentDigest",
        ].sort(),
      );
    });
    expect(await f.create().save(f.pending, f.current, onPending)).toEqual(f.next);
    expect(onPending).toHaveBeenCalledOnce();
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ ...f.pending.mutation, revision: 7 });
    expect(f.values.size).toBe(0);
  });
  it("응답 오류에는 자동 GET/재전송 없이 기록을 남기고 새 인스턴스에서 명시 GET으로 확인한다", async () => {
    const f = await unknown();
    const transport = vi.fn<Transport>(async () => f.next);
    const journal = f.create(transport);
    expect(await journal.read()).toEqual(f.receipt);
    expect(await journal.recover(f.receipt, f.current)).toEqual(f.next);
    expect(transport).toHaveBeenCalledExactlyOnceWith();
    expect(f.values.size).toBe(0);
  });
  it.each([
    [
      "다른 제목",
      (c: StudioCase) => {
        c.plans[1].content.title = "다른 제목";
      },
    ],
    [
      "다른 요약",
      (c: StudioCase) => {
        c.plans[1].content.summary = "다른 요약";
      },
    ],
    [
      "다른 본문",
      (c: StudioCase) => {
        c.plans[1].content.sections[0].content = "다른 본문";
      },
    ],
    [
      "항목 확인 승격",
      (c: StudioCase) => {
        c.plans[1].content.sections[0].needsConfirmation = false;
      },
    ],
    [
      "이전 원고 변경",
      (c: StudioCase) => {
        c.plans[0].content.summary = "바뀐 이전 요약";
      },
    ],
    [
      "이전 원고 누락",
      (c: StudioCase) => {
        c.plans.shift();
      },
    ],
    [
      "다른 회사",
      (c: StudioCase) => {
        c.id = savedId;
      },
    ],
    [
      "이전 revision",
      (c: StudioCase) => {
        c.revision = 7;
      },
    ],
    [
      "다른 버전",
      (c: StudioCase) => {
        c.plans[1].version = 5;
      },
    ],
    [
      "새 버전 누락",
      (c: StudioCase) => {
        c.plans.pop();
      },
    ],
    [
      "전체 확인 승격",
      (c: StudioCase) => {
        c.plans[1].confirmedAt = "2026-10-10";
      },
    ],
    [
      "중복 원고 ID",
      (c: StudioCase) => {
        c.plans[1].id = planId;
      },
    ],
  ] as const)("%s 응답은 기록을 해제하지 않는다", async (_name, change) => {
    const f = await unknown();
    change(f.next);
    await expect(f.create(async () => f.next).recover(f.receipt, f.current)).rejects.toThrow();
    expect(await f.create().read()).toEqual(f.receipt);
  });
  it("저장 전 기록 쓰기 실패는 PATCH를 보내지 않는다", async () => {
    const f = setup();
    f.storage.setItem.mockImplementation(() => {
      throw Error("quota");
    });
    await expect(f.create().save(f.pending, f.current, vi.fn())).rejects.toMatchObject({
      reason: "storage",
    });
    expect(f.send).not.toHaveBeenCalled();
  });
  it("기록 읽기 대조 실패는 PATCH를 보내지 않는다", async () => {
    const f = setup();
    f.storage.setItem.mockImplementation(() => {});
    await expect(f.create().save(f.pending, f.current, vi.fn())).rejects.toMatchObject({
      reason: "storage",
    });
    expect(f.send).not.toHaveBeenCalled();
  });
  it("기록 읽기 실패는 저장 전 차단한다", async () => {
    const f = setup();
    f.storage.getItem.mockImplementation(() => {
      throw Error("denied");
    });
    await expect(f.create().save(f.pending, f.current, vi.fn())).rejects.toMatchObject({
      reason: "storage",
    });
    expect(f.send).not.toHaveBeenCalled();
  });
  it("기록 삭제 실패도 성공으로 수락하지 않는다", async () => {
    const f = await unknown();
    f.storage.removeItem.mockImplementation(() => {
      throw Error("denied");
    });
    await expect(f.create(async () => f.next).recover(f.receipt, f.current)).rejects.toMatchObject({
      reason: "storage",
    });
    expect(await f.create().read()).toEqual(f.receipt);
  });
  it("기존 미확인 기록은 새 저장보다 우선하며 덮어쓰지 않는다", async () => {
    const f = await unknown();
    await expect(f.create().save(f.pending, f.current, vi.fn())).rejects.toThrow();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(await f.create().read()).toEqual(f.receipt);
  });
  it.each(["malformed", "extra", "foreign", "oversized"] as const)(
    "%s 복구 기록은 읽기 단계에서 거절한다",
    async (mode) => {
      const f = await unknown();
      const raw =
        mode === "malformed"
          ? "{"
          : mode === "oversized"
            ? "x".repeat(1025)
            : JSON.stringify(
                mode === "foreign"
                  ? { ...f.receipt, caseId: savedId }
                  : { ...f.receipt, title: "본문 복제 금지" },
              );
      f.values.set(manualPlanRecoveryKey(id), raw);
      await expect(f.create().read()).rejects.toThrow();
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.values.get(manualPlanRecoveryKey(id))).toBe(raw);
    },
  );
  it("다른 기록으로 바뀌었으면 GET 전 거절하고 새 기록을 보존한다", async () => {
    const f = await unknown();
    const replacement = { ...f.receipt, contentDigest: "f".repeat(64) };
    f.values.set(manualPlanRecoveryKey(id), JSON.stringify(replacement));
    const t = vi.fn<Transport>(async () => f.next);
    await expect(f.create(t).recover(f.receipt, f.current)).rejects.toThrow();
    expect(t).not.toHaveBeenCalled();
    expect(await f.create().read()).toEqual(replacement);
  });
  it("GET 도중 기록이 바뀌면 정확한 응답도 거절하고 새 기록을 보존한다", async () => {
    const f = await unknown();
    const replacement = { ...f.receipt, revision: 8 };
    await expect(
      f
        .create(async () => {
          f.values.set(manualPlanRecoveryKey(id), JSON.stringify(replacement));
          return f.next;
        })
        .recover(f.receipt, f.current),
    ).rejects.toThrow();
    expect(await f.create().read()).toEqual(replacement);
  });
  it("기록이 없어도 원래 식별과 정확한 GET이 있어야 해제하며 재생성하지 않는다", async () => {
    const f = await unknown();
    f.values.clear();
    const transport = vi.fn<Transport>(async () => f.pending.company);
    const journal = f.create(transport);
    await expect(journal.recover(f.receipt, f.current)).rejects.toThrow();
    expect(f.values.size).toBe(0);
    transport.mockResolvedValueOnce(f.next);
    expect(await journal.recover(f.receipt, f.current)).toEqual(f.next);
    expect(transport.mock.calls.every((call) => call.length === 0)).toBe(true);
    expect(f.storage.setItem).toHaveBeenCalledTimes(1);
  });
  it("변조된 원래 revision도 결합 digest 대조에서 거절한다", async () => {
    const f = await unknown();
    const altered = { ...f.receipt, revision: 6 };
    f.values.set(manualPlanRecoveryKey(id), JSON.stringify(altered));
    await expect(f.create(async () => f.next).recover(altered, f.current)).rejects.toThrow();
  });
  it("현재 회사가 바뀌면 GET 전에, 현재 revision이 앞서면 수락 전에 거절한다", async () => {
    const f = await unknown();
    const transport = vi.fn<Transport>(async () => f.next),
      journal = f.create(transport);
    await expect(
      journal.recover(f.receipt, () => ({ id: savedId, revision: 7 })),
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
    await expect(journal.recover(f.receipt, () => ({ id, revision: 9 }))).rejects.toThrow();
    expect(await journal.read()).toEqual(f.receipt);
  });
  it("같은 회사의 잠금을 얻지 못하면 전송과 기록 변경을 하지 않는다", async () => {
    const f = setup();
    const lock: ConstructorParameters<typeof ManualPlanJournal>[2] = async () => {
      throw new ManualPlanRecoveryError("busy");
    };
    const journal = new ManualPlanJournal(id, f.storage, lock, f.send);
    await expect(journal.save(f.pending, f.current, vi.fn())).rejects.toMatchObject({
      reason: "busy",
    });
    expect(f.send).not.toHaveBeenCalled();
    expect(f.values.size).toBe(0);
  });
  it("원격 오류문과 reason 속성은 사용자 안내로 신뢰하지 않는다", () => {
    expect(
      manualPlanRecoveryMessage(Object.assign(Error("SECRET_FIELD"), { reason: "busy" })),
    ).toBe(manualPlanRecoveryMessage(Error("schema detail")));
    expect(manualPlanRecoveryMessage(new ManualPlanRecoveryError("storage"))).toContain("브라우저");
  });
});
