import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import { type StudioCase } from "./studio-schema";
import { supplementFixture } from "./studio-plan-supplement-test-helpers";
import {
  buildPlanSupplementExecutionApproval,
  supplementDigest,
} from "./studio-plan-supplement-execution-state";
import {
  auditPlanSupplementAdoptions,
  inspectPlanSupplementAdoption,
  preparePlanSupplementAdoption,
  replayPlanSupplementAdoption,
} from "./studio-plan-supplement-adoption";
import {
  planSupplementAdoptionCommandSchema,
  type PlanSupplementAdoptionCommand,
} from "./studio-plan-supplement-adoption-types";
vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ store: null as StudioStore | null, sdk: vi.fn() }));
vi.mock("./studio-storage", async (original) => ({
  ...(await original<typeof import("./studio-storage")>()),
  getStudioStore: () => state.store!,
}));
vi.mock("openai", () => ({
  default: class {
    constructor() {
      state.sdk();
      throw Error("SDK forbidden");
    }
  },
}));
import { POST, GET } from "@/app/api/studio/cases/[caseId]/plan-supplements/adoption/route";
let directory: string,
  f: ReturnType<typeof supplementFixture>,
  runId: string,
  command: PlanSupplementAdoptionCommand;
const read = () => state.store!.get(f.value.id);
function db() {
  return (state.store as unknown as { db: DatabaseSync }).db;
}
function body() {
  return String(db().prepare("SELECT body FROM studio_cases WHERE id = ?").get(f.value.id)!.body);
}
function edit(fn: (value: StudioCase) => void) {
  const value = JSON.parse(body()) as StudioCase;
  fn(value);
  db()
    .prepare("UPDATE studio_cases SET revision = ?, body = ? WHERE id = ?")
    .run(value.revision, JSON.stringify(value), value.id);
}
function request(value: unknown, suffix = "", headers: Record<string, string> = {}) {
  return new Request(
    `http://localhost:3000/api/studio/cases/${f.value.id}/plan-supplements/adoption${suffix}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(value),
    },
  );
}
const context = () => ({ params: Promise.resolve({ caseId: f.value.id }) });
const post = (value: unknown) => POST(request(value), context());
function adopt(value = command) {
  return state.store!.adoptPlanSupplement(f.value.id, value, () => []);
}
function manual() {
  const value = read();
  return state.store!.mutate(
    value.id,
    {
      action: "save-plan",
      revision: value.revision,
      planId: value.plans.at(-1)!.id,
      content: { ...value.plans.at(-1)!.content, summary: "나중에 직접 수정한 요약" },
    },
    () => [],
  );
}
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("OPENAI_MODEL", "");
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw Error("network forbidden");
    }),
  );
  directory = mkdtempSync(join(tmpdir(), "venture-supplement-adoption-"));
  state.store = new StudioStore(directory);
  f = supplementFixture();
  const created = state.store.create(f.value.profile);
  f.value.id = created.id;
  db()
    .prepare("UPDATE studio_cases SET revision = ?, body = ? WHERE id = ?")
    .run(f.value.revision, JSON.stringify(f.value), f.value.id);
  const before = read();
  const start = state.store.beginPlanSupplementExecution(
    before.id,
    {
      action: "propose-section",
      clientRequestId: randomUUID(),
      input: f.input,
      approval: buildPlanSupplementExecutionApproval(before, f.input, "fixture-model"),
      approved: true,
    },
    () => "fixture-model",
  );
  runId = start.record.id;
  start.owner!.withCurrentWriter(() => undefined);
  start.owner!.retain({
    kind: "response",
    rawJson: JSON.stringify({
      id: "fixture-response",
      model: "fixture-model-snapshot",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: JSON.stringify(f.draft) }],
        },
      ],
    }),
  });
  start.owner!.persist();
  expect(start.owner!.close()).toBe(true);
  const value = read(),
    prepared = preparePlanSupplementAdoption(value, value.revision, runId);
  command = planSupplementAdoptionCommandSchema.parse({
    ...prepared.selection,
    action: "adopt-section-supplement",
    clientRequestId: randomUUID(),
    confirmed: true,
  });
});
afterEach(() => {
  expect(state.sdk).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  state.store?.close();
  state.store = null;
  const part = relative(resolve(tmpdir()), resolve(directory));
  if (
    !part ||
    part.startsWith("..") ||
    isAbsolute(part) ||
    !part.startsWith("venture-supplement-adoption-")
  )
    throw Error("unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});
describe("보관 수정안의 명시 새 버전 채택/원래 요청 복구", () => {
  it("키 없는 준비/미접수 조회는 쓰지 않으며 단일 채택이 한 항목만 manual 새 버전과 영수증에 저장한다", async () => {
    const before = body(),
      old = read();
    const preview = await post({
      action: "prepare-adoption",
      revision: old.revision,
      executionId: runId,
    });
    expect(preview.status).toBe(200);
    const prepared = await preview.json();
    expect(prepared).toMatchObject({ transmissionAllowed: false, databaseChanged: false });
    expect((await (await post({ action: "inspect-adoption", command })).json()).receipt).toBeNull();
    expect(body()).toBe(before);
    const response = await post(command);
    expect(response.status).toBe(200);
    const result = await response.json();
    const plan = result.company.plans.at(-1);
    expect(result.replayed).toBe(false);
    expect(result.receipt.command).toEqual(command);
    expect(plan).toMatchObject({
      mode: "manual",
      version: 3,
      confirmedAt: null,
      sourceRevision: old.plans[0].sourceRevision,
      content: prepared.proposal.content,
    });
    const raw = JSON.parse(body());
    expect(raw.plans.slice(0, -1)).toEqual(JSON.parse(before).plans);
    expect(raw.sources).toEqual(JSON.parse(before).sources);
    expect(raw.planSupplementExecutions).toEqual(JSON.parse(before).planSupplementExecutions);
    expect(
      plan.content.sections.find((s: { key: string }) => s.key === "development").needsConfirmation,
    ).toBe(true);
    expect(result.receipt.savedRevision).toBe(old.revision + 1);
    expect(read().revision).toBe(old.revision + 1);
    expect(
      (
        await GET(
          new Request(`http://localhost:3000/api/studio/cases/${old.id}/plan-supplements/adoption`),
          context(),
        )
      ).status,
    ).toBe(200);
  });
  it("같은 명령 재조회/재열기는 현재 CAS·검토 callback보다 먼저 원래 영수증만 반환한다", () => {
    const first = adopt();
    manual();
    const before = body();
    state.store!.close();
    state.store = new StudioStore(directory);
    const reviewer = vi.fn(() => {
      throw Error("no new review");
    });
    const again = state.store.adoptPlanSupplement(f.value.id, command, reviewer);
    expect(again.replayed).toBe(true);
    expect(again.receipt).toEqual(first.receipt);
    expect(body()).toBe(before);
    expect(reviewer).not.toHaveBeenCalled();
    again.receipt.command.proposalSha256 = "0".repeat(64);
    again.company.plans[0].content.summary = "caller mutation";
    expect(body()).toBe(before);
  });
  it("자료 수정/삭제와 후속 원고 뒤에도 과거 영수증 조회는 새 자료로 비교안을 만들지 않는다", () => {
    const first = adopt();
    const value = read();
    state.store!.mutate(
      value.id,
      { action: "delete-source", revision: value.revision, sourceId: value.sources[0].id },
      () => [],
    );
    const before = body();
    expect(adopt().receipt).toEqual(first.receipt);
    expect(body()).toBe(before);
  });
  it.each([
    "caseId",
    "executionId",
    "executionCommandSha256",
    "captureSha256",
    "proposalSha256",
    "comparisonSha256",
  ])("%s가 바뀐 채택은 원고에 쓰지 않는다", (field) => {
    const before = body();
    const bad = { ...command, [field]: field.endsWith("Id") ? randomUUID() : "0".repeat(64) };
    expect(() => adopt(bad)).toThrow();
    expect(body()).toBe(before);
  });
  it("동일 nonce의 다른 명령은 stale revision이어도 원래 요청 충돌이다", () => {
    adopt();
    const before = body();
    expect(() => adopt({ ...command, revision: 0 })).toThrow(
      expect.objectContaining({ code: "SUPPLEMENT_ADOPTION_REQUEST_CONFLICT" }),
    );
    expect(body()).toBe(before);
  });
  it("새 nonce로 같은 실행을 두 번 채택하지 않는다", () => {
    adopt();
    const before = body();
    expect(() =>
      adopt({ ...command, clientRequestId: randomUUID(), revision: read().revision }),
    ).toThrow(expect.objectContaining({ code: "SUPPLEMENT_ALREADY_ADOPTED" }));
    expect(body()).toBe(before);
  });
  it("실행용 nonce를 채택 nonce로 재사용하지 않는다", () => {
    const before = body();
    expect(() =>
      adopt({
        ...command,
        clientRequestId: read().planSupplementExecutions![0].command.clientRequestId,
      }),
    ).toThrow();
    expect(body()).toBe(before);
  });
  it.each([
    "manual",
    "source",
    "base-body-same-revision",
    "source-body-same-revision",
    "question-same-revision",
  ])("%s 변경 후 이전 비교안을 자동 이동하지 않는다", (kind) => {
    if (kind === "manual") manual();
    else if (kind === "source") {
      const v = read();
      state.store!.mutate(
        v.id,
        {
          action: "source",
          revision: v.revision,
          source: { ...v.sources[0], text: "변경", updatedAt: "later" },
        },
        () => [],
      );
    } else
      edit((v) => {
        if (kind === "base-body-same-revision") v.plans[0].content.sections[0].content = "변경";
        else if (kind === "source-body-same-revision") v.sources[0].text = "변경";
        else v.plans[0].content.interviewQuestions[0] = "변경";
      });
    const before = body();
    expect(() => adopt()).toThrow();
    expect(body()).toBe(before);
  });
  it("새 원고와 영수증은 writer 잠금 안에서 함께 저장된다", () => {
    const other = new DatabaseSync(join(directory, "studio.sqlite"));
    other.exec("PRAGMA busy_timeout=0");
    try {
      state.store!.adoptPlanSupplement(f.value.id, command, () => {
        expect(db().isTransaction).toBe(true);
        expect(() => other.exec("BEGIN IMMEDIATE")).toThrow();
        return [];
      });
    } finally {
      other.close();
    }
    expect(read().plans).toHaveLength(2);
    expect(read().planSupplementAdoptions).toHaveLength(1);
  });
  it("COMMIT 전 실패는 원고·영수증 모두 rollback하고 같은 명령만 새 COMMIT한다", () => {
    const before = body(),
      exec = db().exec.bind(db());
    const spy = vi.spyOn(db(), "exec").mockImplementation((sql) => {
      if (sql === "COMMIT") throw Error("before commit");
      return exec(sql);
    });
    expect(() => adopt()).toThrow();
    spy.mockRestore();
    expect(body()).toBe(before);
    expect(adopt().replayed).toBe(false);
    expect(read().plans).toHaveLength(2);
  });
  it("COMMIT 후 응답 유실은 재열기·명시 조회로 원래 새 버전을 복구하고 중복 저장0", async () => {
    const internal = state.store as unknown as { update: (...args: unknown[]) => unknown };
    const original = internal.update.bind(internal);
    const spy = vi.spyOn(internal, "update").mockImplementationOnce((...args) => {
      original(...args);
      throw Error("ack lost");
    });
    expect(() => adopt()).toThrow();
    spy.mockRestore();
    const before = body();
    state.store!.close();
    state.store = new StudioStore(directory);
    const inspected = await (await post({ action: "inspect-adoption", command })).json();
    expect(inspected.receipt.planVersion).toBe(3);
    expect(body()).toBe(before);
    expect(adopt().receipt).toEqual(inspected.receipt);
    expect(body()).toBe(before);
  });
  it.each(["receipt", "plan-missing", "plan-content", "base-content", "capture", "order"])(
    "%s 손상은 과거 nonce 조회보다 먼저 거절한다",
    (kind) => {
      adopt();
      edit((v) => {
        if (kind === "receipt") v.planSupplementAdoptions![0].commandSha256 = "0".repeat(64);
        else if (kind === "plan-missing") v.plans.pop();
        else if (kind === "plan-content") v.plans.at(-1)!.content.summary = "tampered";
        else if (kind === "base-content") v.plans[0].content.summary = "tampered";
        else if (kind === "capture") v.planSupplementExecutions![0].captureSha256 = "0".repeat(64);
        else v.planSupplementAdoptions!.push(structuredClone(v.planSupplementAdoptions![0]));
      });
      const before = body();
      expect(() => adopt()).toThrow();
      expect(() => replayPlanSupplementAdoption(read(), command)).toThrow();
      expect(body()).toBe(before);
    },
  );
  it("후속 검토/확인 메타데이터는 원고 신원을 바꾸지 않아 원래 영수증을 유지한다", () => {
    const receipt = adopt().receipt;
    edit((v) => {
      v.plans.at(-1)!.review = [];
      v.plans.at(-1)!.confirmedAt = "2026-10-05T02:00:00.000Z";
    });
    expect(adopt().receipt).toEqual(receipt);
  });
  it("100개 원고 한도는 새 영수증 없이 거절한다", () => {
    edit((v) => {
      const base = v.plans[0];
      v.plans = [
        ...Array.from({ length: 99 }, (_, i) => ({
          ...structuredClone(base),
          id: randomUUID(),
          version: -i,
        })),
        base,
      ];
    });
    const before = body();
    expect(() => adopt()).toThrow(expect.objectContaining({ code: "SUPPLEMENT_ADOPTION_LIMIT" }));
    expect(body()).toBe(before);
  });
  it.each([
    "extra-content",
    "supplied-draft",
    "unconfirmed",
    "mime",
    "origin",
    "query",
    "too-large",
  ])("API %s는 저장·SDK 없이 거절한다", async (kind) => {
    const before = body();
    let value: unknown = command,
      suffix = "",
      headers: Record<string, string> = {};
    if (kind === "extra-content") value = { ...command, content: f.compare().content };
    if (kind === "supplied-draft") value = { action: "adopt-section-supplement", draft: f.draft };
    if (kind === "unconfirmed") value = { ...command, confirmed: false };
    if (kind === "mime") headers = { "content-type": "text/plain" };
    if (kind === "origin") headers = { origin: "https://outside.invalid" };
    if (kind === "query") suffix = "?x=1";
    if (kind === "too-large") value = { ...command, pad: "x".repeat(8193) };
    expect((await POST(request(value, suffix, headers), context())).status).toBeGreaterThanOrEqual(
      400,
    );
    expect(body()).toBe(before);
  });
  it("과거 회사는 새 빈 채택 이력을 읽기로 만들지 않고 DDL을 바꾸지 않는다", () => {
    const before = body(),
      schema = db().prepare("SELECT sql FROM sqlite_master ORDER BY name").all();
    expect(read().planSupplementAdoptions).toBeUndefined();
    auditPlanSupplementAdoptions(read());
    expect(body()).toBe(before);
    adopt();
    expect(db().prepare("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
  });
  it("연속 두 수정안 채택은 각 원래 버전을 유지하고 이전 nonce도 복구한다", () => {
    const first = adopt(),
      value = read(),
      base = value.plans.at(-1)!;
    const input = {
      ...f.input,
      revision: value.revision,
      target: { ...f.input.target, planId: base.id, planVersion: base.version },
      baseContentSha256: supplementDigest(base.content),
    };
    const start = state.store!.beginPlanSupplementExecution(
      value.id,
      {
        action: "propose-section",
        clientRequestId: randomUUID(),
        input,
        approval: buildPlanSupplementExecutionApproval(value, input, "fixture-model"),
        approved: true,
      },
      () => "fixture-model",
    );
    start.owner!.withCurrentWriter(() => undefined);
    start.owner!.retain({
      kind: "response",
      rawJson: JSON.stringify({
        id: "second-response",
        model: "fixture-model",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  ...f.draft,
                  content: f.draft.content + " 추가 시험은 아직 계획입니다.",
                }),
              },
            ],
          },
        ],
      }),
    });
    start.owner!.persist();
    start.owner!.close();
    const current = read(),
      prepared = preparePlanSupplementAdoption(current, current.revision, start.record.id);
    const secondCommand = planSupplementAdoptionCommandSchema.parse({
      ...prepared.selection,
      action: "adopt-section-supplement",
      clientRequestId: randomUUID(),
      confirmed: true,
    });
    const second = adopt(secondCommand);
    expect(second.receipt.planVersion).toBe(4);
    expect(second.company.plans.slice(0, 2).map((p) => p.content)).toEqual(
      first.company.plans.map((p) => p.content),
    );
    const before = body();
    expect(adopt().receipt).toEqual(first.receipt);
    expect(adopt(secondCommand).receipt).toEqual(second.receipt);
    expect(body()).toBe(before);
    auditPlanSupplementAdoptions(read());
  });
  it.each(["unobserved", "not-sent", "refusal", "outside-citation"])(
    "%s 보관 응답은 새 원고로 채택할 수 없다",
    (kind) => {
      edit((v) => {
        const run = v.planSupplementExecutions![0];
        if (kind === "unobserved" || kind === "not-sent") run.capture = { kind };
        else if (kind === "refusal")
          run.capture = {
            kind: "response",
            rawJson: JSON.stringify({
              id: "refusal",
              model: "fixture-model",
              status: "completed",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "refusal", refusal: "no" }],
                },
              ],
            }),
          };
        else {
          const response = JSON.parse((run.capture as { rawJson: string }).rawJson);
          const draft = structuredClone(f.draft);
          draft.addedEvidence[0].sourceId = v.sources[1].id;
          response.output[0].content[0].text = JSON.stringify(draft);
          run.capture = { kind: "response", rawJson: JSON.stringify(response) };
        }
        run.captureSha256 = supplementDigest(run.capture);
      });
      const before = body();
      expect(() => adopt()).toThrow(
        expect.objectContaining({ code: "SUPPLEMENT_COMPARISON_UNAVAILABLE" }),
      );
      expect(body()).toBe(before);
    },
  );
  it("후속 영수증 손상은 첫 명령의 과거 조회에서도 거절한다", () => {
    adopt();
    edit((v) => {
      const next = structuredClone(v.planSupplementAdoptions![0]);
      next.id = randomUUID();
      next.command.clientRequestId = randomUUID();
      v.planSupplementAdoptions!.push(next);
    });
    const before = body();
    expect(() => adopt()).toThrow(
      expect.objectContaining({ code: "SUPPLEMENT_ADOPTION_HISTORY_INVALID" }),
    );
    expect(body()).toBe(before);
  });
});

describe("원래 채택 명령의 읽기 종료 근거", () => {
  it("같은 revision의 영수증 부재는 미확인이며 실행·쓰기·새 권한을 만들지 않는다", async () => {
    const before = body();
    const response = await post({ action: "inspect-adoption", command });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: "unconfirmed",
      canClose: false,
      command,
      revision: command.revision,
      receipt: null,
      databaseChanged: false,
      transmissionAllowed: false,
    });
    expect(body()).toBe(before);
  });
  it.each(["manual", "source"])(
    "늦은 %s 변경의 CAS 거절 뒤 원래 요청만 종료 가능하며 재열어도 읽기뿐이다",
    async (kind) => {
      if (kind === "manual") manual();
      else {
        const c = read();
        state.store!.mutate(
          c.id,
          { action: "delete-source", revision: c.revision, sourceId: c.sources[0].id },
          () => [],
        );
      }
      expect(() => adopt()).toThrow();
      const before = body();
      state.store!.close();
      state.store = new StudioStore(directory);
      const response = await post({ action: "inspect-adoption", command });
      expect(response.status).toBe(200);
      const value = await response.json();
      expect(value).toMatchObject({
        state: "not-adopted-stale",
        canClose: true,
        command,
        receipt: null,
      });
      expect(value.revision).toBeGreaterThan(command.revision);
      expect(value.commandSha256).toBe(supplementDigest(command));
      expect(body()).toBe(before);
      value.command.proposalSha256 = "0".repeat(64);
      expect(body()).toBe(before);
    },
  );
  it("동일 nonce의 기존 영수증은 현재 revision보다 먼저 복구하고 변경 명령은 거절한다", async () => {
    const first = adopt();
    manual();
    const before = body();
    const value = await (await post({ action: "inspect-adoption", command })).json();
    expect(value).toMatchObject({ state: "adopted", canClose: false, receipt: first.receipt });
    expect(
      (
        await post({
          action: "inspect-adoption",
          command: { ...command, proposalSha256: "0".repeat(64) },
        })
      ).status,
    ).not.toBe(200);
    expect(body()).toBe(before);
  });
  it("다른 nonce로 이미 저장한 버전을 미채택으로 오인하지 않고 정확한 이전 명령만 구분한다", () => {
    const other = { ...command, clientRequestId: randomUUID() };
    const first = adopt(other);
    const before = body();
    expect(inspectPlanSupplementAdoption(read(), command)).toMatchObject({
      state: "not-adopted-stale",
      receipt: null,
    });
    expect(inspectPlanSupplementAdoption(read(), other)).toMatchObject({
      state: "adopted",
      receipt: first.receipt,
    });
    expect(body()).toBe(before);
  });
  it.each([
    "missing-run",
    "missing-base",
    "base-content",
    "execution-hash",
    "capture-hash",
    "request-revision",
    "execution-nonce",
    "earlier-revision",
  ])("원래 신원 또는 단조 revision 근거가 없는 %s는 종료 권한이 아니다", (kind) => {
    manual();
    const c = read(),
      cmd = structuredClone(command);
    if (kind === "missing-run") delete c.planSupplementExecutions;
    if (kind === "missing-base") c.plans = c.plans.slice(1);
    if (kind === "base-content") c.plans[0].content.summary += "changed";
    if (kind === "execution-hash") cmd.executionCommandSha256 = "0".repeat(64);
    if (kind === "capture-hash") cmd.captureSha256 = "0".repeat(64);
    if (kind === "request-revision") cmd.revision++;
    if (kind === "execution-nonce")
      cmd.clientRequestId = c.planSupplementExecutions![0].command.clientRequestId;
    if (kind === "earlier-revision") c.revision = command.revision - 1;
    let canClose = false;
    try {
      canClose = inspectPlanSupplementAdoption(c, cmd).canClose;
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
    expect(canClose).toBe(false);
  });
  it("현재 nonce가 없어도 보관 이력 손상이 있으면 미채택을 추정하지 않는다", async () => {
    adopt({ ...command, clientRequestId: randomUUID() });
    edit((c) => {
      c.planSupplementAdoptions![0].planIdentitySha256 = "0".repeat(64);
    });
    const before = body();
    expect((await post({ action: "inspect-adoption", command })).status).not.toBe(200);
    expect(body()).toBe(before);
  });
});

it("저장 원고와 일치하는 응답의 영수증 소실은 미채택으로 추정하지 않는다", async () => {
  adopt();
  edit((c) => {
    delete c.planSupplementAdoptions;
  });
  const before = body();
  const response = await post({ action: "inspect-adoption", command });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    state: "unconfirmed",
    canClose: false,
    receipt: null,
  });
  expect(body()).toBe(before);
});
it("수동 저장이 같은 수정안과 일치해도 영수증 없이 미채택으로 확정하지 않는다", () => {
  const c = read(),
    prepared = preparePlanSupplementAdoption(c, c.revision, runId);
  state.store!.mutate(
    c.id,
    {
      action: "save-plan",
      revision: c.revision,
      planId: c.plans.at(-1)!.id,
      content: prepared.proposal.content,
    },
    () => [],
  );
  expect(inspectPlanSupplementAdoption(read(), command)).toMatchObject({
    state: "unconfirmed",
    canClose: false,
  });
});
