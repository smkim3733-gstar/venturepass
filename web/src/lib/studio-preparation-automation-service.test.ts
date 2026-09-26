import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { caseSchema, emptyProfile, stageValues } from "./studio-schema";
import { StudioError } from "./studio-http";
import { diagnosisInputFingerprint } from "./studio-diagnosis";
import { diagnosisCriteriaVersion } from "./studio-diagnosis-types";
import { preparationRunSchema } from "./studio-preparation-types";
import { withVentureInputCompanyLock } from "./venturein-input-lock";
import {
  beginPreparationAutomation,
  collectPreparationAutomationChanges,
  configurePreparationAutomation,
  finishPreparationAutomation,
  type PreparationAutomationCompany,
} from "./studio-preparation-automation";
import {
  currentPreparationAutomationSetting,
  type PreparationAutomationRequest,
  type PreparationAutomationSettingInput,
} from "./studio-preparation-automation-types";
import { createPreparationAutomationHandlers } from "./studio-preparation-automation-api";
import {
  preparationAutomationIsRunning,
  runPreparationAutomation,
  type PreparationAutomationRuntime,
  type PreparationAutomationStore,
} from "./studio-preparation-automation-service";

const at = "2026-09-25T12:00:00.000Z",
  meta = () => ({ id: randomUUID(), at });
function fixture() {
  const company: PreparationAutomationCompany = caseSchema.parse({
    id: randomUUID(),
    profile: { ...emptyProfile(), companyName: "가상 기업", technologySummary: "가상 기술" },
    sources: [],
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: stageValues[0],
    revision: 0,
    createdAt: at,
    updatedAt: at,
  });
  const get = () => structuredClone(company);
  const setting = (enabled: boolean): PreparationAutomationSettingInput => ({
    action: "set-preparation-automation",
    revision: company.revision,
    clientRequestId: randomUUID(),
    expectedSettingVersion:
      currentPreparationAutomationSetting(company.preparationAutomation)?.version ?? 0,
    enabled,
  });
  const store: PreparationAutomationStore = {
    get: vi.fn((id) => {
      if (id !== company.id) throw new StudioError("없음", 404, "NOT_FOUND");
      return get();
    }),
    setPreparationAutomation: vi.fn((id, input) => {
      if (id !== company.id) throw new Error("wrong case");
      const result = configurePreparationAutomation(company, input, meta());
      company.preparationAutomation = result.state;
      if (result.changed) company.revision++;
      return get();
    }),
    beginPreparationAutomation: vi.fn((id, input) => {
      if (id !== company.id) throw new Error("wrong case");
      const result = beginPreparationAutomation(company, input, meta());
      company.preparationAutomation = result.state;
      if (!result.replayed) company.revision++;
      return {
        company: get(),
        batch: structuredClone(result.batch),
        command: result.command,
        replayed: result.replayed,
      };
    }),
    finishPreparationAutomation: vi.fn((id, revision, batchId, runId) => {
      if (id !== company.id || revision !== company.revision)
        throw new StudioError("CAS", 409, "STALE_REVISION");
      const result = finishPreparationAutomation(company, batchId, runId, at);
      company.preparationAutomation = result.state;
      company.revision++;
      return { company: get(), batch: structuredClone(result.batch) };
    }),
  };
  store.setPreparationAutomation(company.id, setting(true));
  const before = get();
  company.profile.customers = "자료 변경";
  company.revision++;
  company.preparationAutomation = collectPreparationAutomationChanges(before, company, at);
  const runtime: PreparationAutomationRuntime = {
    preparationIsRunning: vi.fn(() => false),
    runPreparation: vi.fn(async (id, input) => {
      if (id !== company.id || input.revision !== company.revision)
        throw new StudioError("CAS", 409, "STALE_REVISION");
      const run = preparationRunSchema.parse({
        id: randomUUID(),
        mode: "assisted",
        inputFingerprint: diagnosisInputFingerprint(company),
        criteriaVersion: diagnosisCriteriaVersion,
        sourceRevision: company.revision,
        createdAt: at,
        updatedAt: at,
        status: "awaiting_choice",
        phase: "choice",
        stale: false,
        code: null,
        diagnosisId: null,
        analysisDigest: null,
        candidates: [],
        selectedCandidateId: null,
        selectedCandidateDigest: null,
        planId: null,
        planDigest: null,
        steps: [],
        requests: [{ clientRequestId: input.clientRequestId, digest: "a".repeat(64) }],
      });
      company.preparationRuns.push(run);
      company.revision++;
      return { company: get(), run: structuredClone(run) };
    }),
  };
  const handlers = createPreparationAutomationHandlers(() => store, runtime);
  const request = (): PreparationAutomationRequest => ({
    action: "run-pending",
    revision: company.revision,
    clientRequestId: randomUUID(),
    expectedSettingVersion: 1,
  });
  const context = () => ({ params: Promise.resolve({ caseId: company.id }) });
  const post = (
    input: unknown = request(),
    options: { query?: string; headers?: Record<string, string>; id?: string } = {},
  ) => {
    const id = options.id ?? company.id;
    return handlers.POST(
      new Request(
        `http://localhost:3000/api/studio/cases/${id}/preparation-automation${options.query ?? ""}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...options.headers },
          body: typeof input === "string" ? input : JSON.stringify(input),
        },
      ),
      { params: Promise.resolve({ caseId: id }) },
    );
  };
  return {
    store,
    runtime,
    handlers,
    get,
    request,
    context,
    post,
    setting,
    change: (alter: (value: PreparationAutomationCompany) => void) => {
      alter(company);
    },
    disable: () => store.setPreparationAutomation(company.id, setting(false)),
  };
}

describe("자동준비 연결 서비스·API factory", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  it("durable batch→기존 assisted 준비→완료 checkpoint 순서와 단회 nonce를 보존한다", async () => {
    const env = fixture(),
      order: string[] = [],
      oldFinish = env.store.finishPreparationAutomation,
      oldRun = env.runtime.runPreparation;
    const originalBegin = vi.mocked(env.store.beginPreparationAutomation).getMockImplementation()!;
    env.store.beginPreparationAutomation = vi.fn((...args: Parameters<typeof originalBegin>) => {
      order.push("durable");
      return originalBegin(...args);
    });
    env.runtime.runPreparation = vi.fn(async (...args: Parameters<typeof oldRun>) => {
      order.push("assisted");
      return oldRun(...args);
    });
    env.store.finishPreparationAutomation = vi.fn((...args: Parameters<typeof oldFinish>) => {
      order.push("finish");
      return oldFinish(...args);
    });
    const input = env.request(),
      first = await env.post(input);
    expect(first.status).toBe(200);
    expect(order).toEqual(["durable", "assisted", "finish"]);
    const result = await first.json();
    expect(result.batch.status).toBe("awaiting_choice");
    expect(result.company.plans).toEqual([]);
    expect(result.company.selectedCandidateId).toBeNull();
    const revision = env.get().revision;
    expect((await env.post(input)).status).toBe(200);
    expect(env.runtime.runPreparation).toHaveBeenCalledTimes(1);
    expect(env.get().revision).toBe(revision);
    expect(preparationAutomationIsRunning(env.get().id)).toBe(false);
  });
  it("GET는 저장 상태와 active만 읽고 DB/engine 동작이 없다", async () => {
    const env = fixture(),
      before = env.get(),
      result = await env.handlers.GET(
        new Request(`http://localhost:3000/api/studio/cases/${before.id}/preparation-automation`),
        env.context(),
      );
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ company: before, active: false });
    expect(result.headers.get("cache-control")).toContain("no-store");
    expect(env.get()).toEqual(before);
    expect(env.runtime.runPreparation).not.toHaveBeenCalled();
  });
  it("기존 수동 준비 worker가 실행 중이면 새 batch를 저장하지 않는다", async () => {
    const env = fixture();
    vi.mocked(env.runtime.preparationIsRunning).mockReturnValue(true);
    const before = env.get(),
      response = await env.post();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "AUTOMATION_BUSY", accepted: false });
    expect(env.get()).toEqual(before);
    expect(env.store.beginPreparationAutomation).not.toHaveBeenCalled();
  });
  it("공식 입력 잠금은 batch 시작도 거부한다", async () => {
    const env = fixture();
    await withVentureInputCompanyLock(env.get().id, async () => {
      const response = await env.post();
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "INPUT_IN_PROGRESS", accepted: false });
    });
    expect(env.runtime.runPreparation).not.toHaveBeenCalled();
  });
  it("durable 저장 뒤 off/회사변경은 첫 준비 실행 전에 정지한다", async () => {
    const env = fixture(),
      original = vi.mocked(env.store.beginPreparationAutomation).getMockImplementation()!;
    vi.mocked(env.store.beginPreparationAutomation).mockImplementation((...args) => {
      const result = original(...args);
      env.disable();
      return result;
    });
    const response = await env.post();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "AUTOMATION_STALE", accepted: true });
    expect(env.runtime.runPreparation).not.toHaveBeenCalled();
    expect(preparationAutomationIsRunning(env.get().id)).toBe(false);
  });
  it("같은 회사 동시 호출은 배치/준비 중복 실행 없이 active를 보여준다", async () => {
    const env = fixture(),
      original = vi.mocked(env.runtime.runPreparation).getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(env.runtime.runPreparation).mockImplementation(async (...args) => {
      await gate;
      return original(...args);
    });
    const input = env.request(),
      first = env.post(input);
    await vi.waitFor(() => expect(env.runtime.runPreparation).toHaveBeenCalledTimes(1));
    const concurrent = await env.post(input);
    expect(concurrent.status).toBe(409);
    expect(await concurrent.json()).toMatchObject({ code: "AUTOMATION_BUSY", accepted: true });
    const status = await env.handlers.GET(
      new Request(`http://localhost:3000/api/studio/cases/${env.get().id}/preparation-automation`),
      env.context(),
    );
    expect(await status.json()).toMatchObject({ active: true });
    release();
    expect((await first).status).toBe(200);
    expect(env.runtime.runPreparation).toHaveBeenCalledTimes(1);
  });
  it("기존 준비의 예외는 원문을 숨기고 durable 이력과 같은 nonce를 남긴다", async () => {
    const env = fixture(),
      input = env.request();
    vi.mocked(env.runtime.runPreparation).mockRejectedValue(new Error("PRIVATE_body_key_path"));
    const response = await env.post(input),
      output = await response.text();
    expect(response.status).toBe(500);
    expect(output).not.toContain("PRIVATE_");
    expect(JSON.parse(output)).toMatchObject({ code: "AUTOMATION_FAILED", accepted: true });
    expect(env.get().preparationAutomation?.batches[0].status).toBe("running");
    expect((await env.post(input)).status).toBe(200);
    expect(env.runtime.runPreparation).toHaveBeenCalledTimes(1);
    expect(preparationAutomationIsRunning(env.get().id)).toBe(false);
  });
  it("commit 뒤 응답유실도 accepted를 조회로 복원하며 replay에서 engine을 실행하지 않는다", async () => {
    const env = fixture(),
      original = vi.mocked(env.store.beginPreparationAutomation).getMockImplementation()!,
      input = env.request();
    vi.mocked(env.store.beginPreparationAutomation).mockImplementationOnce((...args) => {
      original(...args);
      throw new Error("PRIVATE_lost_reply");
    });
    const response = await env.post(input);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ accepted: true });
    expect((await env.post(input)).status).toBe(200);
    expect(env.runtime.runPreparation).not.toHaveBeenCalled();
  });
  it("결과 회사/요청 nonce가 다르면 완료로 저장하지 않는다", async () => {
    const env = fixture(),
      original = vi.mocked(env.runtime.runPreparation).getMockImplementation()!;
    vi.mocked(env.runtime.runPreparation).mockImplementation(async (...args) => {
      const result = await original(...args);
      result.run.requests = [{ clientRequestId: randomUUID(), digest: "a".repeat(64) }];
      return result;
    });
    const response = await env.post();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "AUTOMATION_RECORD_INVALID",
      accepted: true,
    });
    expect(env.store.finishPreparationAutomation).not.toHaveBeenCalled();
  });
  it("완료 저장 전 새 회사 revision이면 이전 결과로 덮거나 자동 재시도하지 않는다", async () => {
    const env = fixture(),
      original = vi.mocked(env.runtime.runPreparation).getMockImplementation()!;
    vi.mocked(env.runtime.runPreparation).mockImplementation(async (...args) => {
      const result = await original(...args);
      env.change((company) => {
        company.revision++;
        company.profile.team = "후속 수정";
      });
      return result;
    });
    const response = await env.post();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "STALE_REVISION", accepted: true });
    expect(env.get().profile.team).toBe("후속 수정");
    expect(env.runtime.runPreparation).toHaveBeenCalledTimes(1);
  });
  it("요청 거절 후 조회도 실패하면 미접수라고 단정하지 않는다", async () => {
    const env = fixture();
    vi.mocked(env.store.beginPreparationAutomation).mockImplementation(() => {
      throw new Error("PRIVATE_error");
    });
    vi.mocked(env.store.get).mockImplementation(() => {
      throw new Error("PRIVATE_read");
    });
    const response = await env.post();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ accepted: true });
    expect(env.runtime.runPreparation).not.toHaveBeenCalled();
  });
  it.each([
    { mode: "ai" },
    { approved: true },
    { automaticSubmit: true },
    { text: "PRIVATE_body" },
  ])("strict API는 범위 밖 입력을 거부한다 %j", async (extra) => {
    const env = fixture(),
      before = env.get();
    expect((await env.post({ ...env.request(), ...extra })).status).toBe(400);
    expect(env.get()).toEqual(before);
    expect(env.runtime.runPreparation).not.toHaveBeenCalled();
  });
  it("query/외부Origin/잘못된ID/MIME/8KiB 초과를 상태 변경 전에 거부한다", async () => {
    const env = fixture(),
      input = env.request(),
      before = env.get();
    expect((await env.post(input, { query: "?force=1" })).status).toBe(400);
    expect((await env.post(input, { headers: { origin: "https://example.invalid" } })).status).toBe(
      403,
    );
    expect((await env.post(input, { headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect((await env.post(input, { id: "bad" })).status).toBe(400);
    expect((await env.post(`${JSON.stringify(input)}${" ".repeat(8192)}`)).status).toBe(413);
    expect(env.get()).toEqual(before);
    expect(env.runtime.runPreparation).not.toHaveBeenCalled();
  });
  it("서비스도 직접 호출한 unknown action을 저장 전에 거부한다", async () => {
    const env = fixture();
    await expect(
      runPreparationAutomation(env.store, env.runtime, env.get().id, {
        ...env.request(),
        action: "force-ai",
      } as unknown as PreparationAutomationRequest),
    ).rejects.toThrow();
    expect(env.store.beginPreparationAutomation).not.toHaveBeenCalled();
  });
});
