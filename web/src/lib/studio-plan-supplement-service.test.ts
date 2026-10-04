import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import OpenAI from "openai";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import { supplementFixture } from "./studio-plan-supplement-test-helpers";
import { buildPlanSupplementExecutionApproval } from "./studio-plan-supplement-execution-state";
import { getPlanSupplementService, PlanSupplementService } from "./studio-plan-supplement-service";
import { studioGenerationJobs } from "./studio-generation-lock";
import type { PlanSupplementExecutionCommand } from "./studio-plan-supplement-execution-types";
vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ store: null as StudioStore | null }));
vi.mock("@/lib/studio-storage", async (original) => ({
  ...(await original<typeof import("./studio-storage")>()),
  getStudioStore: () => state.store!,
}));
import { GET, POST } from "@/app/api/studio/cases/[caseId]/plan-supplements/execution/route";
let directory: string,
  f: ReturnType<typeof supplementFixture>,
  command: PlanSupplementExecutionCommand,
  service: PlanSupplementService;
let network: ReturnType<typeof vi.fn<typeof fetch>>;
const db = () => (state.store as unknown as { db: DatabaseSync }).db;
const body = () =>
  (db().prepare("SELECT body FROM studio_cases WHERE id=?").get(f.value.id) as { body: string })
    .body;
function sdkObject(draft: unknown = f.draft) {
  return {
    id: "resp_synthetic_supplement",
    object: "response",
    created_at: 1,
    model: "synthetic-model-snapshot",
    status: "completed",
    output: [
      {
        type: "message",
        id: "msg_synthetic",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: JSON.stringify(draft), annotations: [] }],
      },
    ],
    usage: { input_tokens: 11, output_tokens: 12, total_tokens: 23 },
  };
}
const response = (value: unknown = sdkObject()) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", "x-request-id": "synthetic-request" },
  });
const run = () => service.run(f.value.id, command);
const result = () => service.status(f.value.id).executions[0];
function post(input: unknown, suffix = "", headers: Record<string, string> = {}) {
  return POST(
    new Request(
      `http://localhost:3000/api/studio/cases/${f.value.id}/plan-supplements/execution${suffix}`,
      {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
          ...headers,
        },
        body: typeof input === "string" ? input : JSON.stringify(input),
      },
    ),
    { params: Promise.resolve({ caseId: f.value.id }) },
  );
}
function get(suffix = "") {
  return GET(
    new Request(
      `http://localhost:3000/api/studio/cases/${f.value.id}/plan-supplements/execution${suffix}`,
    ),
    { params: Promise.resolve({ caseId: f.value.id }) },
  );
}
function cold() {
  state.store!.close();
  state.store = new StudioStore(directory);
  service = getPlanSupplementService(state.store);
}
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "synthetic-supplement-sdk-only");
  vi.stubEnv("OPENAI_MODEL", "synthetic-model");
  vi.stubEnv("OPENAI_BASE_URL", "https://forbidden.invalid");
  vi.stubEnv("OPENAI_ORG_ID", "should-not-be-sent");
  vi.stubEnv("OPENAI_PROJECT_ID", "should-not-be-sent");
  network = vi.fn<typeof fetch>(async () => response());
  vi.stubGlobal("fetch", network);
  directory = mkdtempSync(join(tmpdir(), "venture-supplement-sdk-"));
  state.store = new StudioStore(directory);
  f = supplementFixture();
  const created = state.store.create(f.value.profile);
  f.value.id = created.id;
  db()
    .prepare("UPDATE studio_cases SET body=?,revision=?,evidence_revision=? WHERE id=?")
    .run(JSON.stringify(f.value), f.value.revision, f.value.revision, f.value.id);
  command = {
    action: "propose-section",
    clientRequestId: randomUUID(),
    input: f.input,
    approval: buildPlanSupplementExecutionApproval(
      state.store.get(f.value.id),
      f.input,
      "synthetic-model",
    ),
    approved: true,
  };
  service = getPlanSupplementService(state.store);
});
afterEach(() => {
  vi.restoreAllMocks();
  studioGenerationJobs.delete(f.value.id);
  state.store!.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  const boundary = relative(resolve(tmpdir()), resolve(directory));
  if (
    !boundary.startsWith("venture-supplement-sdk-") ||
    boundary.includes("..") ||
    isAbsolute(boundary)
  )
    throw Error("unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});
describe("수정안 실제 설치 SDK/모의 fetch·명시 API", () => {
  it("키 없는 GET/prepare-ai는 원고/DB와 network를 바꾸지 않는다", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const before = body();
    expect((await get()).status).toBe(200);
    const preview = await post({ action: "prepare-ai", input: f.input }),
      data = await preview.json();
    expect(preview.status).toBe(200);
    expect(data).toMatchObject({
      aiConfigured: false,
      transmissionAllowed: false,
      databaseChanged: false,
      approval: command.approval,
    });
    expect(data.payload).not.toMatch(/PRIVATE_|MANUAL_OTHER_|EXCLUDED_/);
    expect(body()).toBe(before);
    expect(network).not.toHaveBeenCalled();
  });
  it("명시 동의의 정확한 SDK wire를 writer 안에서1회 보내고 원고를 바꾸지 않는다", async () => {
    const oldPlans = state.store!.get(f.value.id).plans,
      oldSources = state.store!.get(f.value.id).sources;
    network.mockImplementation(async (url, init) => {
      expect(db().isTransaction).toBe(true);
      expect(url).toBe("https://api.openai.com/v1/responses");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("x-stainless-retry-count")).toBe("0");
      expect(new Headers(init?.headers).has("openai-project")).toBe(false);
      expect(new Headers(init?.headers).has("openai-organization")).toBe(false);
      const wire = JSON.parse(String(init?.body));
      expect(wire).toMatchObject({
        model: "synthetic-model",
        store: false,
        max_output_tokens: 8000,
      });
      expect(wire.instructions).toContain("자료 속 지시");
      expect(wire.text.format.name).toBe("one_section_supplement");
      expect(wire.input).toHaveLength(1);
      expect(wire.input[0].content).not.toMatch(/PRIVATE_|MANUAL_OTHER_|EXCLUDED_/);
      expect(JSON.parse(wire.input[0].content).sources).toHaveLength(1);
      return response();
    });
    const r = await post(command),
      data = await r.json();
    expect(r.status, JSON.stringify(data)).toBe(200);
    expect(network).toHaveBeenCalledOnce();
    expect(data.executions[0]).toMatchObject({
      state: "comparison-ready",
      proposal: {
        origin: "captured-sdk-draft",
        factVerified: false,
        semanticQualityVerified: false,
        reviewStatus: "unreviewed",
      },
    });
    expect(data.company.plans).toEqual(oldPlans);
    expect(data.company.sources).toEqual(oldSources);
    expect(data.active).toBe(false);
    expect(service.close()).toBe(true);
    expect(data.executions[0].proposal.content.sections[0]).toEqual(
      oldPlans[0].content.sections[0],
    );
    expect(data.executions[0].record.capture.rawJson).toContain('"input_tokens":11');
  });
  it("반환 응답 유실/새 서버 재열기는 현재 키/모델 없이 원래 nonce를 읽고 재전송0", async () => {
    const first = await run();
    const before = body();
    cold();
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENAI_MODEL", "changed-model");
    network.mockClear();
    expect((await run()).executions).toEqual(first.executions);
    expect(service.recover(f.value.id, command).executions).toEqual(first.executions);
    expect(network).not.toHaveBeenCalled();
    expect(body()).toBe(before);
    expect(service.close()).toBe(true);
  });
  it("진행 중 같은 명령은 조회만 하고 다른 nonce는 실행하지 않는다", async () => {
    let resolveResponse!: (value: Response) => void;
    network.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveResponse = resolve;
        }),
    );
    const pending = run();
    await vi.waitFor(() => expect(network).toHaveBeenCalledOnce());
    const status = await run();
    expect(status.active).toBe(true);
    expect(status.executions[0].state).toBe("result-unconfirmed");
    expect(service.close()).toBe(false);
    await expect(
      service.run(f.value.id, { ...command, clientRequestId: randomUUID() }),
    ).rejects.toMatchObject({ code: "SUPPLEMENT_BUSY" });
    expect(service.recover(f.value.id, command).active).toBe(true);
    resolveResponse(response());
    await pending;
    expect(network).toHaveBeenCalledOnce();
  });
  it.each(["key", "model", "revision"])(
    "SDK 준비 뒤 %s 변경은 fetch 전에 멈춘다",
    async (field) => {
      const pending = run();
      if (field === "key") vi.stubEnv("OPENAI_API_KEY", "changed-synthetic-key");
      if (field === "model") vi.stubEnv("OPENAI_MODEL", "changed-model");
      if (field === "revision") {
        const current = state.store!.get(f.value.id);
        state.store!.mutate(
          current.id,
          {
            action: "profile",
            revision: current.revision,
            profile: { ...current.profile, industry: "synthetic changed" },
          },
          () => [],
        );
      }
      const saved = await pending;
      expect(network).not.toHaveBeenCalled();
      expect(saved.executions[0].record.capture).toEqual({ kind: "not-sent" });
    },
  );
  it("SDK의 변조 wire는 외부로 전달하지 않는다", async () => {
    const original = OpenAI.prototype.fetchWithTimeout;
    vi.spyOn(OpenAI.prototype, "fetchWithTimeout").mockImplementation(function (
      this: OpenAI,
      url,
      init,
      ms,
      signal,
    ) {
      return original.call(this, url, { ...init, body: '{"tampered":true}' }, ms, signal);
    });
    const status = await run();
    expect(network).not.toHaveBeenCalled();
    expect(status.executions[0].state).toBe("not-sent");
  });
  it("SDK 재진입은 두 번째 전송/owner 획득 없이 끝난다", async () => {
    const original = OpenAI.prototype.fetchWithTimeout;
    vi.spyOn(OpenAI.prototype, "fetchWithTimeout").mockImplementation(async function (
      this: OpenAI,
      url,
      init,
      ms,
      signal,
    ) {
      const response = await original.call(this, url, init, ms, signal);
      await expect(original.call(this, url, init, ms, signal)).rejects.toThrow();
      return response;
    });
    await run();
    expect(network).toHaveBeenCalledOnce();
    expect(result().state).toBe("comparison-ready");
  });
  it.each(["throw", "429", "invalid-json"])(
    "%s 뒤 재시도0·미관측 이력과 원문 비노출",
    async (failure) => {
      network.mockImplementation(async () => {
        if (failure === "throw") throw Error("SECRET_KEY_PRIVATE_TEXT");
        if (failure === "429")
          return new Response('{"error":{"message":"SECRET_KEY_PRIVATE_TEXT"}}', {
            status: 429,
            headers: { "content-type": "application/json" },
          });
        return new Response("SECRET_KEY_PRIVATE_TEXT", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      const status = await run();
      expect(network).toHaveBeenCalledOnce();
      expect(status.executions[0].state).toBe("unobserved");
      expect(JSON.stringify(status)).not.toContain("SECRET_KEY_PRIVATE_TEXT");
      await run();
      expect(network).toHaveBeenCalledOnce();
      const current = status.company,
        input = { ...f.input, revision: current.revision },
        next = {
          ...command,
          input,
          clientRequestId: randomUUID(),
          approval: buildPlanSupplementExecutionApproval(current, input, "synthetic-model"),
        };
      await expect(service.run(f.value.id, next)).rejects.toMatchObject({
        code: "SUPPLEMENT_UNRESOLVED_REQUEST",
        accepted: false,
      });
      expect(network).toHaveBeenCalledOnce();
    },
  );
  it.each(["refusal", "incomplete", "wrong-quote", "outside-source", "oversize"])(
    "%s 응답은 채택/정상 비교로 만들지 않는다",
    async (kind) => {
      const obj = sdkObject();
      if (kind === "incomplete") obj.status = "incomplete";
      if (kind === "refusal")
        obj.output[0].content = [{ type: "refusal", text: "no", annotations: [] }];
      if (kind === "wrong-quote")
        obj.output[0].content[0].text = JSON.stringify({
          ...f.draft,
          addedEvidence: [{ ...f.draft.addedEvidence[0], quote: "없는 내용" }],
        });
      if (kind === "outside-source")
        obj.output[0].content[0].text = JSON.stringify({
          ...f.draft,
          addedEvidence: [{ ...f.draft.addedEvidence[0], sourceId: f.value.sources[1].id }],
        });
      if (kind === "oversize") obj.output[0].content[0].text = "가".repeat(400000);
      network.mockResolvedValue(response(obj));
      const old = state.store!.get(f.value.id).plans;
      const status = await run();
      expect(status.executions[0].state).toBe(
        kind === "oversize" ? "unobserved" : "captured-response-unusable",
      );
      expect(status.executions[0].proposal).toBeNull();
      expect(status.company.plans).toEqual(old);
      expect(network).toHaveBeenCalledOnce();
    },
  );
  it("응답 저장 실패는 owner/capture를 유지하며 키 변경 후 recover로 저장만 수행한다", async () => {
    const exec = db().exec.bind(db());
    let failed = false;
    network.mockImplementation(async () => {
      vi.spyOn(db(), "exec").mockImplementation((sql) => {
        if (sql === "BEGIN IMMEDIATE" && !failed) {
          failed = true;
          throw Error("storage unavailable");
        }
        return exec(sql);
      });
      return response();
    });
    await expect(run()).rejects.toMatchObject({ accepted: true });
    expect(service.close()).toBe(false);
    expect(service.status(f.value.id)).toMatchObject({ active: false, retainedCapture: true });
    expect((await run()).retainedCapture).toBe(true);
    expect(network).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENAI_MODEL", "changed");
    const status = service.recover(f.value.id, command);
    expect(status.executions[0].state).toBe("comparison-ready");
    expect(status.retainedCapture).toBe(false);
    expect(network).toHaveBeenCalledOnce();
    expect(service.close()).toBe(true);
  });
  it("응답 COMMIT 후 ack 유실은 동일 capture 저장 재조회만 한다", async () => {
    const update = (
      state.store as unknown as { update: (...args: unknown[]) => unknown }
    ).update.bind(state.store);
    network.mockImplementation(async () => {
      vi.spyOn(
        state.store as unknown as { update: (...args: unknown[]) => unknown },
        "update",
      ).mockImplementationOnce((...args) => {
        update(...args);
        throw Error("ack lost");
      });
      return response();
    });
    await expect(run()).rejects.toMatchObject({ accepted: true });
    vi.restoreAllMocks();
    const before = body();
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(service.recover(f.value.id, command).executions[0].state).toBe("comparison-ready");
    expect(body()).toBe(before);
    expect(network).toHaveBeenCalledOnce();
  });
  it("최종 writer의 read COMMIT 실패 뒤에도 응답을 보존한다", async () => {
    const exec = db().exec.bind(db());
    let fail = true;
    network.mockImplementation(async () => {
      vi.spyOn(db(), "exec").mockImplementation((sql) => {
        if (sql === "COMMIT" && fail) {
          fail = false;
          throw Error("read commit lost");
        }
        return exec(sql);
      });
      return response();
    });
    const saved = await run();
    expect(saved.executions[0].state).toBe("comparison-ready");
    expect(network).toHaveBeenCalledOnce();
  });
  it("전송 후 수동 원고가 바뀌면 늦은 응답은 보관만 하고 비교를 새 기준에 옮기지 않는다", async () => {
    let resolveResponse!: (value: Response) => void;
    network.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveResponse = resolve;
        }),
    );
    const pending = run();
    await vi.waitFor(() => expect(network).toHaveBeenCalledOnce());
    const c = state.store!.get(f.value.id),
      content = structuredClone(c.plans[0].content);
    content.sections[0].content = "LATEST_MANUAL";
    const manual = state.store!.mutate(
      c.id,
      { action: "save-plan", revision: c.revision, planId: c.plans[0].id, content },
      () => [],
    );
    resolveResponse(response());
    const saved = await pending;
    expect(saved.company.plans).toEqual(manual.plans);
    expect(saved.executions[0].state).toBe("context-changed");
    expect(saved.executions[0].record.capture?.kind).toBe("response");
  });
  it("원래 예약이 사라진 DB는 capture를 새 요청으로 만들지 않는다", async () => {
    const before = body();
    network.mockImplementation(async () => {
      db()
        .prepare("UPDATE studio_cases SET body=?,revision=? WHERE id=?")
        .run(before, f.value.revision, f.value.id);
      return response();
    });
    await expect(run()).rejects.toMatchObject({ code: "SUPPLEMENT_OWNER_CHANGED", accepted: true });
    expect(service.close()).toBe(false);
    expect(() => service.recover(f.value.id, command)).toThrow();
    await expect(run()).rejects.toMatchObject({ code: "SUPPLEMENT_BUSY", accepted: true });
    expect(network).toHaveBeenCalledOnce();
    expect(body()).toBe(before);
  });
  it("API 입력 추가 필드/외부 Origin/query/용량/동의 false를 거절한다", async () => {
    const before = body();
    for (const [input, suffix, headers, expected] of [
      [{ ...command, fetch: "override" }, "", {}, 400],
      [{ ...command, approved: false }, "", {}, 400],
      [command, "?retry=true", {}, 400],
      [command, "", { origin: "https://outside.invalid" }, 403],
      [command, "", { "content-type": "text/plain" }, 415],
      [" ".repeat(128 * 1024 + 1), "", {}, 413],
      [{ action: "recover", command, retry: true }, "", {}, 400],
    ] as const)
      expect((await post(input, suffix, headers)).status).toBe(expected);
    expect((await get("?nonce=other")).status).toBe(400);
    expect(body()).toBe(before);
    expect(network).not.toHaveBeenCalled();
  });
  it("기존 실행 nonce의 변경 동의는 현재 키 없이도 충돌로 거절한다", async () => {
    await run();
    vi.stubEnv("OPENAI_API_KEY", "");
    const changed = { ...command, approval: { ...command.approval, model: "changed" } };
    expect((await post(changed)).status).toBe(409);
    expect((await post({ action: "recover", command: changed })).status).toBe(409);
    expect(network).toHaveBeenCalledOnce();
  });
  it("다른 store의 cold service가 보관 중 owner를 탈취하지 않는다", async () => {
    let resolveResponse!: (value: Response) => void;
    network.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveResponse = resolve;
        }),
    );
    const pending = run();
    await vi.waitFor(() => expect(network).toHaveBeenCalledOnce());
    const otherStore = new StudioStore(directory),
      coldService = new PlanSupplementService(otherStore, {
        configuration: () => {
          throw Error("no config");
        },
        network: vi.fn(() => {
          throw Error("no network");
        }),
      });
    try {
      expect((await coldService.run(f.value.id, command)).executions[0].state).toBe(
        "result-unconfirmed",
      );
      expect(coldService.recover(f.value.id, command).executions[0].state).toBe(
        "result-unconfirmed",
      );
    } finally {
      otherStore.close();
    }
    resolveResponse(response());
    await pending;
    expect(network).toHaveBeenCalledOnce();
  });
  it("종료한 service는 기존 요청 조회만 허용하고 새 요청을 보내지 않는다", async () => {
    await run();
    expect(service.close()).toBe(true);
    expect((await run()).executions[0].state).toBe("comparison-ready");
    const current = state.store!.get(f.value.id),
      input = { ...f.input, revision: current.revision };
    await expect(
      service.run(f.value.id, {
        ...command,
        clientRequestId: randomUUID(),
        input,
        approval: buildPlanSupplementExecutionApproval(current, input, "synthetic-model"),
      }),
    ).rejects.toMatchObject({ code: "SUPPLEMENT_SERVICE_CLOSED", accepted: false });
    expect(network).toHaveBeenCalledOnce();
  });
  it("완료 뒤 다른 service의 cold 조회는 configuration과 network를 전혀 읽지 않는다", async () => {
    const saved = await run(),
      before = body();
    const coldService = new PlanSupplementService(state.store!, {
      configuration: () => {
        throw Error("forbidden configuration");
      },
      network: vi.fn(() => {
        throw Error("forbidden network");
      }),
    });
    expect((await coldService.run(f.value.id, command)).executions).toEqual(saved.executions);
    expect(coldService.recover(f.value.id, command).executions).toEqual(saved.executions);
    expect(body()).toBe(before);
  });
  it("예약 COMMIT 후 ack 유실은 API accepted:true로 남고 재전송하지 않는다", async () => {
    const update = (
      state.store as unknown as { update: (...args: unknown[]) => unknown }
    ).update.bind(state.store);
    const spy = vi
      .spyOn(state.store as unknown as { update: (...args: unknown[]) => unknown }, "update")
      .mockImplementationOnce((...args) => {
        update(...args);
        throw Error("reservation ack lost");
      });
    const failed = await post(command);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ accepted: true });
    spy.mockRestore();
    vi.stubEnv("OPENAI_API_KEY", "");
    const replay = await post(command);
    expect(replay.status).toBe(200);
    expect((await replay.json()).executions[0].state).toBe("result-unconfirmed");
    expect(network).not.toHaveBeenCalled();
  });
});
