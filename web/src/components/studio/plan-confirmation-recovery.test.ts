import { describe, expect, it, vi } from "vitest";
import { confirmationCompany } from "../../../scripts/fixtures/guided-plan-confirmation";
import {
  PlanConfirmationJournal,
  PlanConfirmationRecoveryError,
  planConfirmationRecoveryKey,
  planConfirmationRecoveryMessage,
  type PlanConfirmationReceipt,
} from "./plan-confirmation-recovery";
type Transport = ConstructorParameters<typeof PlanConfirmationJournal>[3];
function setup() {
  const company = confirmationCompany(),
    planId = company.plans[1].id;
  const request = { company, planId },
    next = structuredClone(company);
  next.revision++;
  next.plans[1].confirmedAt = "2026-10-10T01:00:00.000Z";
  const values = new Map<string, string>();
  const storage = {
    getItem: vi.fn((k: string) => values.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => {
      values.set(k, v);
    }),
    removeItem: vi.fn((k: string) => {
      values.delete(k);
    }),
  };
  const lock: ConstructorParameters<typeof PlanConfirmationJournal>[2] = async (_name, task) =>
    task();
  const send = vi.fn<Transport>(async () => next);
  const create = (t: Transport = send) => new PlanConfirmationJournal(company.id, storage, lock, t);
  return {
    company,
    request,
    next,
    values,
    storage,
    send,
    create,
    key: planConfirmationRecoveryKey(company.id),
    current: () => company,
  };
}
async function unknown() {
  const f = setup();
  f.send.mockRejectedValueOnce(Error("internal"));
  let record: PlanConfirmationReceipt | undefined;
  await expect(
    f.create().save(f.request, f.current, (r) => {
      record = r;
    }),
  ).rejects.toThrow();
  expect(f.send).toHaveBeenCalledTimes(1);
  return { ...f, record: record! };
}
describe("검토 완료의 최소 식별 재진입 복구", () => {
  it("전송 전 본문 없는 식별만 기록하고 정확한 결과에서 해제한다", async () => {
    const f = setup();
    const before = JSON.stringify(f.company);
    await expect(
      f.create().save(f.request, f.current, (r) => {
        expect(JSON.parse(f.values.get(f.key)!)).toEqual(r);
        expect(Object.keys(r).sort()).toEqual(
          ["format", "caseId", "planId", "revision", "version", "digest"].sort(),
        );
        for (const text of [
          f.company.plans[1].content.title,
          f.company.plans[1].content.summary,
          f.company.plans[1].content.sections[0].content,
          f.company.profile.companyName,
        ])
          expect(f.values.get(f.key)).not.toContain(text);
      }),
    ).resolves.toEqual(f.next);
    expect(f.send).toHaveBeenCalledExactlyOnceWith({
      action: "confirm-plan",
      planId: f.request.planId,
      revision: f.company.revision,
    });
    expect(f.values.size).toBe(0);
    expect(JSON.stringify(f.company)).toBe(before);
  });
  it("재생성한 journal이 원래 식별을 읽고 명시 GET만 사용한다", async () => {
    const f = await unknown(),
      send = vi.fn<Transport>(async () => f.next),
      journal = f.create(send);
    expect(await journal.read()).toEqual(f.record);
    await expect(journal.recover(f.record, f.current)).resolves.toEqual(f.next);
    expect(send).toHaveBeenCalledExactlyOnceWith();
    expect(f.values.size).toBe(0);
  });
  it.each([
    "company",
    "revision",
    "title",
    "body",
    "source",
    "analysis",
    "history",
    "confirmed",
    "review",
    "version",
    "duplicate",
  ])("재진입 뒤 %s 불일치는 기록을 유지한다", async (kind) => {
    const f = await unknown(),
      next = structuredClone(f.next);
    switch (kind) {
      case "company":
        next.id = "99999999-9999-4999-8999-999999999999";
        break;
      case "revision":
        next.revision = f.company.revision;
        break;
      case "title":
        next.plans[1].content.title += "changed";
        break;
      case "body":
        next.plans[1].content.sections[0].content += "changed";
        break;
      case "source":
        next.profile.technologySummary += "changed";
        break;
      case "analysis":
        next.analysis!.summary += "changed";
        break;
      case "history":
        next.plans[0].content.summary += "changed";
        break;
      case "confirmed":
        next.plans[1].confirmedAt = null;
        break;
      case "review":
        next.plans[1].content.sections[0].needsConfirmation = true;
        break;
      case "version":
        next.plans[1].version++;
        break;
      case "duplicate":
        next.plans.push(structuredClone(next.plans[1]));
        break;
    }
    await expect(f.create(async () => next).recover(f.record, f.current)).rejects.toThrow();
    expect(await f.create().read()).toEqual(f.record);
  });
  it("원래 허용된 검토 경고 갱신은 정확한 본문이면 수락한다", async () => {
    const f = await unknown();
    f.next.plans[1].review = [
      {
        id: "warning",
        severity: "warning",
        category: "quality",
        message: "경고",
        action: "검토",
        sectionKey: null,
        sourceIds: [],
      },
    ];
    await expect(f.create().recover(f.record, f.current)).resolves.toEqual(f.next);
  });
  it.each(["write", "readback"])("%s 실패는 전송 전에 차단한다", async (kind) => {
    const f = setup();
    if (kind === "write")
      f.storage.setItem.mockImplementation(() => {
        throw Error("quota");
      });
    else f.storage.getItem.mockImplementation(() => null);
    await expect(f.create().save(f.request, f.current, () => {})).rejects.toThrow();
    expect(f.send).not.toHaveBeenCalled();
  });
  it("읽기 실패를 저장소 오류로 분류한다", async () => {
    const f = setup();
    f.storage.getItem.mockImplementation(() => {
      throw Error("storage detail");
    });
    await expect(f.create().read()).rejects.toMatchObject({ reason: "storage" });
    expect(f.send).not.toHaveBeenCalled();
  });
  it("삭제 실패는 정확한 응답에도 미확정을 유지한다", async () => {
    const f = await unknown();
    f.storage.removeItem.mockImplementation(() => {
      throw Error("delete");
    });
    await expect(f.create().recover(f.record, f.current)).rejects.toMatchObject({
      reason: "storage",
    });
    expect(await f.create().read()).toEqual(f.record);
  });
  it.each(["foreign", "extra", "invalid", "oversize"])(
    "%s 기록을 복구 대상으로 읽지 않는다",
    async (kind) => {
      const f = await unknown();
      f.values.set(
        f.key,
        kind === "invalid"
          ? "{"
          : kind === "oversize"
            ? "x".repeat(1025)
            : JSON.stringify(
                kind === "foreign"
                  ? { ...f.record, caseId: "99999999-9999-4999-8999-999999999999" }
                  : { ...f.record, body: "unexpected" },
              ),
      );
      await expect(f.create().read()).rejects.toThrow();
      expect(f.send).toHaveBeenCalledTimes(1);
    },
  );
  it("새 경쟁 기록이 있으면 GET 전 거절하고 제거하지 않는다", async () => {
    const f = await unknown(),
      newRecord = { ...f.record, digest: "f".repeat(64) };
    f.values.set(f.key, JSON.stringify(newRecord));
    const send = vi.fn<Transport>(async () => f.next);
    await expect(f.create(send).recover(f.record, f.current)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(await f.create().read()).toEqual(newRecord);
  });
  it("조회 중 변경된 기록은 정확한 응답으로도 제거하지 않는다", async () => {
    const f = await unknown(),
      newRecord = { ...f.record, digest: "f".repeat(64) };
    await expect(
      f
        .create(async () => {
          f.values.set(f.key, JSON.stringify(newRecord));
          return f.next;
        })
        .recover(f.record, f.current),
    ).rejects.toThrow();
    expect(await f.create().read()).toEqual(newRecord);
  });
  it("기록 부재만으로 성공하지 않고 남은 탭의 정확한 GET만 수락한다", async () => {
    const f = await unknown();
    f.values.clear();
    await expect(f.create(async () => f.company).recover(f.record, f.current)).rejects.toThrow();
    await expect(f.create().recover(f.record, f.current)).resolves.toEqual(f.next);
    expect(f.storage.setItem).toHaveBeenCalledTimes(1);
  });
  it("새 저장은 기존 미확인 식별을 덮어쓰지 않는다", async () => {
    const f = await unknown();
    await expect(f.create().save(f.request, f.current, () => {})).rejects.toThrow();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(await f.create().read()).toEqual(f.record);
  });
  it.each(["company", "newer"])(
    "현재 화면 %s가 바뀌면 원래 기록을 해제하지 않는다",
    async (kind) => {
      const f = await unknown();
      const current = () =>
        kind === "company"
          ? { ...f.company, id: "99999999-9999-4999-8999-999999999999" }
          : { ...f.company, revision: f.next.revision + 1 };
      await expect(f.create().recover(f.record, current)).rejects.toThrow();
      expect(await f.create().read()).toEqual(f.record);
    },
  );
  it("다른 창 잠금 실패는 새 전송을 하지 않는다", async () => {
    const f = setup(),
      lock: ConstructorParameters<typeof PlanConfirmationJournal>[2] = async () => {
        throw new PlanConfirmationRecoveryError("busy");
      };
    const j = new PlanConfirmationJournal(f.company.id, f.storage, lock, f.send);
    await expect(j.save(f.request, f.current, () => {})).rejects.toMatchObject({ reason: "busy" });
    expect(f.send).not.toHaveBeenCalled();
  });
  it("원격 오류의 reason이나 형식 세부사항을 업무 안내로 사용하지 않는다", () => {
    expect(planConfirmationRecoveryMessage({ reason: "storage", message: "SECRET" })).not.toContain(
      "SECRET",
    );
    expect(planConfirmationRecoveryMessage(new PlanConfirmationRecoveryError("storage"))).toContain(
      "브라우저",
    );
  });
});
