import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import { caseSchema } from "./studio-schema";
import { supplementFixture } from "./studio-plan-supplement-test-helpers";
import { preparePlanSupplement } from "./studio-plan-supplement";
import {
  auditPlanSupplementExecutions,
  buildPlanSupplementExecutionApproval,
  replayPlanSupplementExecution,
  supplementDigest,
} from "./studio-plan-supplement-execution-state";
import {
  planSupplementExecutionCommandSchema,
  planSupplementCaptureSchema,
  type PlanSupplementExecutionCommand,
  type PlanSupplementCapture,
} from "./studio-plan-supplement-execution-types";
vi.mock("server-only", () => ({}));
let directory: string,
  store: StudioStore,
  f: ReturnType<typeof supplementFixture>,
  command: PlanSupplementExecutionCommand;
const model = vi.fn(() => "gpt-5.4");
const internalDb = () => (store as unknown as { db: DatabaseSync }).db;
const body = () =>
  (
    internalDb().prepare("SELECT body FROM studio_cases WHERE id=?").get(f.value.id) as {
      body: string;
    }
  ).body;
const begin = () => store.beginPlanSupplementExecution(f.value.id, command, model);
const response = (): PlanSupplementCapture => ({
  kind: "response",
  rawJson: JSON.stringify({ id: "response-synthetic", model: "synthetic", draft: f.draft }),
});
function editStored(alter: (value: typeof f.value) => void) {
  const value = JSON.parse(body()) as typeof f.value;
  alter(value);
  internalDb()
    .prepare("UPDATE studio_cases SET body=?,revision=? WHERE id=?")
    .run(JSON.stringify(value), value.revision, value.id);
}
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("OPENAI_MODEL", "");
  model.mockReset().mockReturnValue("gpt-5.4");
  directory = mkdtempSync(join(tmpdir(), "venture-supplement-owner-"));
  store = new StudioStore(directory);
  f = supplementFixture();
  const created = store.create(f.value.profile);
  f.value.id = created.id;
  internalDb()
    .prepare("UPDATE studio_cases SET body=?,revision=?,evidence_revision=? WHERE id=?")
    .run(JSON.stringify(f.value), f.value.revision, f.value.revision, f.value.id);
  command = planSupplementExecutionCommandSchema.parse({
    action: "propose-section",
    clientRequestId: randomUUID(),
    input: f.input,
    approval: buildPlanSupplementExecutionApproval(store.get(f.value.id), f.input, "gpt-5.4"),
    approved: true,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  vi.unstubAllEnvs();
  const boundary = relative(resolve(tmpdir()), resolve(directory));
  if (
    !boundary.startsWith("venture-supplement-owner-") ||
    boundary.includes("..") ||
    isAbsolute(boundary)
  )
    throw Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});
describe("단일 항목 수정안의 별도 동의·저장 소유권 (SDK 연결 전)", () => {
  it("동의안 준비는 키·DB 쓰기 없이 정확한 대상 본문과 선택 자료에 결합한다", () => {
    const old = body();
    const approval = buildPlanSupplementExecutionApproval(
      store.get(f.value.id),
      f.input,
      "gpt-5.4",
    );
    expect(approval).toEqual(command.approval);
    expect(body()).toBe(old);
    const payload = preparePlanSupplement(store.get(f.value.id), f.input).payload;
    expect(payload).toContain("직접 고친 개발 내용");
    expect(payload).not.toMatch(/PRIVATE_|MANUAL_OTHER_|EXCLUDED_/);
    expect(caseSchema.parse(JSON.parse(old))).not.toHaveProperty("planSupplementExecutions");
  });
  it("새 COMMIT만 owner를 받고 원고·자료·과거 기록을 보존한다", () => {
    const before = store.get(f.value.id);
    const result = begin();
    expect(result.owner).not.toBeNull();
    expect(result.record.reservationRevision).toBe(before.revision + 1);
    expect(result.company.plans).toEqual(before.plans);
    expect(result.company.sources).toEqual(before.sources);
    const { planSupplementExecutions, revision, updatedAt, ...rest } = result.company;
    const { revision: oldRevision, updatedAt: oldUpdatedAt, ...oldRest } = before;
    void oldRevision;
    void oldUpdatedAt;
    expect(rest).toEqual(oldRest);
    expect(planSupplementExecutions).toHaveLength(1);
    expect(revision).toBe(6);
    expect(updatedAt).toBeTruthy();
  });
  it("같은 nonce는 현재 model/키/CAS보다 먼저 조회하며 실행 주체를 주지 않는다", () => {
    const first = begin();
    model.mockImplementation(() => {
      throw Error("must not read configuration");
    });
    const old = body();
    const again = begin();
    expect(again.owner).toBeNull();
    expect(again.record).toEqual(first.record);
    expect(body()).toBe(old);
    store.close();
    store = new StudioStore(directory);
    expect(begin().owner).toBeNull();
    expect(body()).toBe(old);
  });
  it("같은 nonce의 바뀐 명령은 현재 구성 조회 전에 거절한다", () => {
    begin();
    model.mockImplementation(() => {
      throw Error("configuration");
    });
    command.approval.model = "other-model";
    expect(begin).toThrow(expect.objectContaining({ code: "SUPPLEMENT_REQUEST_CONFLICT" }));
  });
  it.each([
    "purpose",
    "callLimit",
    "automaticRetryLimit",
    "targetBodyIncluded",
    "approved",
    "extra",
  ])("다른 목적/동의 필드 %s를 거절한다", (field) => {
    const raw = structuredClone(command) as unknown as Record<string, unknown>;
    if (field === "approved") raw.approved = false;
    else if (field === "extra") raw.runAi = true;
    else
      (raw.approval as Record<string, unknown>)[field] =
        field === "purpose" ? "analysis-plan-review" : field === "targetBodyIncluded" ? false : 2;
    expect(() => planSupplementExecutionCommandSchema.parse(raw)).toThrow();
    expect(store.get(f.value.id).planSupplementExecutions).toBeUndefined();
  });
  it("기준 원고 또는 모델이 다른 동의는 기록하지 않는다", () => {
    const old = body();
    command.approval.binding.basePlanSha256 = "0".repeat(64);
    expect(begin).toThrow(expect.objectContaining({ code: "SUPPLEMENT_APPROVAL_CHANGED" }));
    expect(body()).toBe(old);
    command.approval = buildPlanSupplementExecutionApproval(
      store.get(f.value.id),
      f.input,
      "other-model",
    );
    expect(begin).toThrow(expect.objectContaining({ code: "SUPPLEMENT_APPROVAL_CHANGED" }));
    expect(body()).toBe(old);
  });
  it("caller·반환값 변경은 내부 owner의 원래 명령을 바꾸지 않는다", () => {
    const started = begin(),
      original = structuredClone(command);
    command.input.sectionKey = "team";
    started.company.planSupplementExecutions![0].command.approval.model = "tampered";
    started.record.command.input.sectionKey = "team";
    const seen = vi.fn();
    started.owner!.withCurrentWriter(seen);
    expect(seen).toHaveBeenCalledOnce();
    expect(JSON.parse(seen.mock.calls[0][0]).section.key).toBe("development");
    started.owner!.retain(response());
    const saved = started.owner!.persist();
    expect(saved.record.command).toEqual(original);
  });
  it("writer 잠금 안에서 정확한 payload를 한 번만 전달하고 진행 중 새 nonce를 거절한다", () => {
    const started = begin();
    const other = new StudioStore(directory);
    const competing = (other as unknown as { db: DatabaseSync }).db;
    competing.exec("PRAGMA busy_timeout = 1");
    try {
      started.owner!.withCurrentWriter((payload) => {
        expect(internalDb().isTransaction).toBe(true);
        expect(() => competing.exec("BEGIN IMMEDIATE")).toThrow();
        expect(payload).toBe(preparePlanSupplement(f.value, f.input).payload);
      });
      expect(() => started.owner!.withCurrentWriter(() => {})).toThrow(
        expect.objectContaining({ code: "SUPPLEMENT_OWNER_USED" }),
      );
      expect(() =>
        other.beginPlanSupplementExecution(
          f.value.id,
          {
            ...command,
            clientRequestId: randomUUID(),
            input: { ...command.input, revision: started.company.revision },
          },
          model,
        ),
      ).toThrow(expect.objectContaining({ code: "SUPPLEMENT_UNRESOLVED_REQUEST" }));
    } finally {
      other.close();
    }
  });
  it.each(["revision", "model", "body"])("전송 직전 %s 변경 시 callback 0회", (field) => {
    const started = begin(),
      network = vi.fn();
    if (field === "model") model.mockReturnValue("new-model");
    else
      editStored((value) => {
        if (field === "revision") value.revision++;
        else value.plans[0].content.sections[3].content = "CHANGED";
      });
    expect(() => started.owner!.withCurrentWriter(network)).toThrow();
    expect(network).not.toHaveBeenCalled();
    started.owner!.retain({ kind: "not-sent" });
    expect(started.owner!.persist().record.capture).toEqual({ kind: "not-sent" });
  });
  it("응답 보관은 원고 채택이 아니며 재시작 조회는 새 owner 없이 원래 bytes를 반환한다", () => {
    const oldPlans = store.get(f.value.id).plans;
    const started = begin();
    started.owner!.withCurrentWriter(() => {});
    const raw = response();
    started.owner!.retain(raw);
    const finished = started.owner!.persist();
    expect(finished.company.plans).toEqual(oldPlans);
    expect(finished.record.capture).toEqual(raw);
    expect(finished.record.finishedRevision).toBe(7);
    expect(started.owner!.close()).toBe(true);
    expect(() => started.owner!.persist()).toThrow();
    store.close();
    store = new StudioStore(directory);
    model.mockImplementation(() => {
      throw Error("no new config");
    });
    const again = begin();
    expect(again.owner).toBeNull();
    expect(again.record).toEqual(finished.record);
  });
  it("응답 저장 전 실패는 capture/owner를 남기고 원래 bytes만 한 번 저장한다", () => {
    const started = begin();
    started.owner!.withCurrentWriter(() => {});
    const capture = response();
    started.owner!.retain(capture);
    if (capture.kind === "response") capture.rawJson = "{}";
    const exec = internalDb().exec.bind(internalDb());
    let fail = true;
    const spy = vi.spyOn(internalDb(), "exec").mockImplementation((sql) => {
      if (sql === "BEGIN IMMEDIATE" && fail) {
        fail = false;
        throw Error("synthetic storage failure");
      }
      return exec(sql);
    });
    expect(() => started.owner!.persist()).toThrow();
    expect(started.owner!.close()).toBe(false);
    expect(started.owner!.status()).toMatchObject({ retained: true, persisted: false });
    spy.mockRestore();
    const finished = started.owner!.persist();
    expect(finished.record.capture).toEqual(response());
    const before = body();
    expect(started.owner!.persist().record).toEqual(finished.record);
    expect(body()).toBe(before);
    expect(() => started.owner!.retain({ kind: "response", rawJson: "{}" })).toThrow(
      expect.objectContaining({ code: "SUPPLEMENT_CAPTURE_CHANGED" }),
    );
  });
  it("저장 COMMIT 후 응답 유실도 capture를 유지하고 동일 기록을 읽어 복구한다", () => {
    const started = begin();
    started.owner!.withCurrentWriter(() => {});
    started.owner!.retain(response());
    const update = (store as unknown as { update: (...args: unknown[]) => unknown }).update.bind(
      store,
    );
    const spy = vi
      .spyOn(store as unknown as { update: (...args: unknown[]) => unknown }, "update")
      .mockImplementationOnce((...args) => {
        update(...args);
        throw Error("ack lost");
      });
    expect(() => started.owner!.persist()).toThrow();
    expect(started.owner!.close()).toBe(false);
    spy.mockRestore();
    const before = body();
    const finished = started.owner!.persist();
    expect(finished.record.capture).toEqual(response());
    expect(body()).toBe(before);
  });
  it("예약 COMMIT 뒤 응답 유실은 재조회에 실행 소유권을 발급하지 않는다", () => {
    const update = (store as unknown as { update: (...args: unknown[]) => unknown }).update.bind(
      store,
    );
    const spy = vi
      .spyOn(store as unknown as { update: (...args: unknown[]) => unknown }, "update")
      .mockImplementationOnce((...args) => {
        update(...args);
        throw Error("ack lost");
      });
    expect(begin).toThrow();
    spy.mockRestore();
    model.mockImplementation(() => {
      throw Error("config");
    });
    expect(begin().owner).toBeNull();
  });
  it("시작 뒤 읽기 COMMIT 실패가 관측 응답을 지우지 않는다", () => {
    const started = begin();
    const exec = internalDb().exec.bind(internalDb());
    const spy = vi.spyOn(internalDb(), "exec").mockImplementation((sql) => {
      if (sql === "COMMIT") throw Error("read commit failed");
      return exec(sql);
    });
    const callback = vi.fn();
    expect(() => started.owner!.withCurrentWriter(callback)).toThrow();
    expect(callback).toHaveBeenCalledOnce();
    expect(started.owner!.status().entered).toBe(true);
    spy.mockRestore();
    started.owner!.retain(response());
    expect(started.owner!.persist().record.capture).toEqual(response());
  });
  it("결과 미관측은 새 nonce 재시도를 막고 실제 미전송과 구별한다", () => {
    const started = begin();
    expect(() => started.owner!.retain(response())).toThrow();
    started.owner!.withCurrentWriter(() => {});
    expect(() => started.owner!.retain({ kind: "not-sent" })).toThrow();
    started.owner!.retain({ kind: "unobserved" });
    const finished = started.owner!.persist();
    expect(() =>
      store.beginPlanSupplementExecution(
        f.value.id,
        {
          ...command,
          clientRequestId: randomUUID(),
          input: { ...command.input, revision: finished.company.revision },
        },
        model,
      ),
    ).toThrow(expect.objectContaining({ code: "SUPPLEMENT_UNRESOLVED_REQUEST" }));
    expect(begin().owner).toBeNull();
  });
  it("늦은 응답은 변경된 원고를 덮지 않고 원래 승인에 결합한 보관 기록만 추가한다", () => {
    const started = begin();
    started.owner!.withCurrentWriter(() => {});
    const latest = store.get(f.value.id),
      content = structuredClone(latest.plans[0].content);
    content.sections[0].content = "새 수동 편집";
    const manual = store.mutate(
      latest.id,
      { action: "save-plan", revision: latest.revision, planId: latest.plans[0].id, content },
      () => [],
    );
    started.owner!.retain(response());
    const finished = started.owner!.persist();
    expect(finished.company.plans).toEqual(manual.plans);
    expect(finished.record.command).toEqual(command);
    expect(finished.record.finishedRevision).toBe(manual.revision + 1);
  });
  it("원래 예약이 DB에서 사라지면 남은 owner로 새 기록을 만들지 않는다", () => {
    const before = body(),
      started = begin();
    started.owner!.withCurrentWriter(() => {});
    started.owner!.retain(response());
    internalDb()
      .prepare("UPDATE studio_cases SET body=?,revision=? WHERE id=?")
      .run(before, f.value.revision, f.value.id);
    expect(() => started.owner!.persist()).toThrow(
      expect.objectContaining({ code: "SUPPLEMENT_OWNER_CHANGED" }),
    );
    expect(started.owner!.close()).toBe(false);
    expect(body()).toBe(before);
  });
  it.each(["command", "capture", "duplicate", "case"])(
    "%s 기록 손상은 nonce 조회 전에 거절한다",
    (field) => {
      const started = begin();
      started.owner!.withCurrentWriter(() => {});
      started.owner!.retain(response());
      started.owner!.persist();
      const value = store.get(f.value.id),
        run = value.planSupplementExecutions![0];
      if (field === "command") run.command.input.sectionKey = "team";
      if (field === "capture") run.capture = { kind: "response", rawJson: "{}" };
      if (field === "duplicate") value.planSupplementExecutions!.push(structuredClone(run));
      if (field === "case") {
        run.command.approval.binding.answer.caseId = randomUUID();
        run.commandSha256 = supplementDigest(run.command);
      }
      expect(() => replayPlanSupplementExecution(value, command)).toThrow(
        expect.objectContaining({ code: "SUPPLEMENT_HISTORY_INVALID" }),
      );
    },
  );
  it("원래 이력 없는 회사는 감사로 빈 승인 필드를 만들지 않는다", () => {
    const value = store.get(f.value.id),
      old = JSON.stringify(value);
    auditPlanSupplementExecutions(value);
    expect(JSON.stringify(value)).toBe(old);
  });
  it("capture는 임의 새 필드·배열·손상 JSON·UTF8 1MiB 초과를 거절한다", () => {
    for (const value of [
      { kind: "response", rawJson: "[]" },
      { kind: "response", rawJson: "{" },
      { kind: "response", rawJson: JSON.stringify({ text: "가".repeat(400000) }) },
      { kind: "unobserved", retry: true },
    ])
      expect(() => planSupplementCaptureSchema.parse(value)).toThrow();
  });
  it("예약 COMMIT 전 실패는 행과 DDL을 바꾸지 않고 다음 새 COMMIT만 owner를 받는다", () => {
    const old = body(),
      ddl = internalDb().prepare("SELECT sql FROM sqlite_master ORDER BY name").all();
    const exec = internalDb().exec.bind(internalDb());
    const spy = vi.spyOn(internalDb(), "exec").mockImplementation((sql) => {
      if (sql === "COMMIT") throw Error("commit rollback");
      return exec(sql);
    });
    expect(begin).toThrow();
    spy.mockRestore();
    expect(body()).toBe(old);
    expect(begin().owner).not.toBeNull();
    expect(internalDb().prepare("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(ddl);
  });
  it("끝나지 않은 이전 요청 뒤 붙인 기록은 새로운 nonce 조회로 우회하지 못한다", () => {
    begin();
    const value = store.get(f.value.id),
      next = structuredClone(value.planSupplementExecutions![0]);
    next.id = randomUUID();
    next.command.clientRequestId = randomUUID();
    next.commandSha256 = supplementDigest(next.command);
    value.planSupplementExecutions!.push(next);
    expect(() =>
      replayPlanSupplementExecution(value, { ...command, clientRequestId: randomUUID() }),
    ).toThrow(expect.objectContaining({ code: "SUPPLEMENT_HISTORY_INVALID" }));
  });
  it("미전송 종료 뒤 새 revision의 명시 동의는 별도 기록이며 이전 이력 bytes를 보존한다", () => {
    const first = begin();
    first.owner!.retain({ kind: "not-sent" });
    const saved = first.owner!.persist();
    const old = JSON.stringify(saved.record),
      input = { ...f.input, revision: saved.company.revision };
    const next = {
      ...command,
      clientRequestId: randomUUID(),
      input,
      approval: buildPlanSupplementExecutionApproval(saved.company, input, "gpt-5.4"),
    };
    const second = store.beginPlanSupplementExecution(f.value.id, next, model);
    expect(second.owner).not.toBeNull();
    expect(JSON.stringify(second.company.planSupplementExecutions![0])).toBe(old);
    expect(second.company.plans).toEqual(saved.company.plans);
  });
  it("한도가 찬 이력에서도 원래 nonce를 조회하고 새 요청만 거절한다", () => {
    for (let i = 0; i < 30; i++) {
      const current = store.get(f.value.id),
        input = { ...f.input, revision: current.revision };
      command = {
        ...command,
        clientRequestId: randomUUID(),
        input,
        approval: buildPlanSupplementExecutionApproval(current, input, "gpt-5.4"),
      };
      const started = begin();
      started.owner!.retain({ kind: "not-sent" });
      started.owner!.persist();
      started.owner!.close();
    }
    const current = store.get(f.value.id);
    expect(begin().owner).toBeNull();
    expect(() =>
      store.beginPlanSupplementExecution(
        f.value.id,
        {
          ...command,
          clientRequestId: randomUUID(),
          input: { ...command.input, revision: current.revision },
        },
        model,
      ),
    ).toThrow(expect.objectContaining({ code: "SUPPLEMENT_HISTORY_LIMIT" }));
  });
});
