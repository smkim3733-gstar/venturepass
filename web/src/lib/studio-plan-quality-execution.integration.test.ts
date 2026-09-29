import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const external = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("External provider and company database forbidden");
  }),
);
vi.mock("openai", () => ({
  default: class {
    constructor() {
      external();
    }
  },
}));
vi.mock("./studio-storage", () => ({ getStudioStore: () => external() }));
import { generateObservedPlan, getPlanExecutionContract } from "./studio-engine";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { candidateRegistryModelInput } from "./studio-plan-quality-candidate-registry";
import { caseSchema, sectionDefinitions, type PlanContent } from "./studio-schema";
import { planQualityEvaluationDigest as digest } from "./studio-plan-quality-evaluation";
import { validateQualityExecutionLedger } from "./studio-plan-quality-execution";
import {
  qualityExecutionPreparationDigestInput,
  qualityExecutionSnapshotSchema,
  type QualityExecutionEventPayload,
  type QualityExecutionStart,
} from "./studio-plan-quality-execution-types";
import type {
  EngineExecutionRequest,
  EngineExecutionTransportRequest,
} from "./studio-engine-execution-types";

let directory: string, store: PlanQualityStore;
const contract = getPlanExecutionContract();
beforeEach(() => {
  external.mockClear();
  vi.stubGlobal("fetch", external);
  directory = mkdtempSync(join(tmpdir(), "venturepass-quality-execution-"));
  writeFileSync(join(directory, "studio.sqlite"), "DO NOT OPEN COMPANY DATABASE");
  store = new PlanQualityStore(directory);
  store.candidateRegistryRegister({
    expectedVersion: 0,
    clientRequestId: randomUUID(),
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  });
}, 15000);
afterEach(() => {
  expect(external).not.toHaveBeenCalled();
  expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe(
    "DO NOT OPEN COMPANY DATABASE",
  );
  store.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  const path = resolve(directory),
    rel = relative(resolve(tmpdir()), path);
  if (!rel.startsWith("venturepass-quality-execution-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(path, { recursive: true, force: true });
}, 15000);
function prepare(index = 0) {
  const registry = store.candidateRegistryGet(1);
  return store.executionPrepare(
    { version: 1, candidateId: registry.entries[index].candidateId },
    contract,
  );
}
function start(index = 0) {
  const input: QualityExecutionStart = {
    clientRequestId: randomUUID(),
    preparation: prepare(index),
    acknowledgedMockOnly: true,
  };
  return { input, ...store.executionStart(input, contract) };
}
function request(preparation = prepare(), sequence: 1 | 2 = 1): EngineExecutionRequest {
  return {
    phase: sequence === 1 ? "generation" : "review",
    sequence,
    mode: "mock",
    provider: "mock",
    configuredModel: preparation.model,
    contractDigest: preparation.engine.contractDigest,
    requestDigest: digest({ synthetic: true, sequence }),
    inputChars: 20,
    maxOutputTokens: 16000,
  };
}
function response(req: EngineExecutionRequest, status: string | null = "completed") {
  return {
    request: req,
    responseId: "mock-response",
    requestId: null,
    responseModel: "mock-returned-name",
    status,
    usage: null,
  };
}
function append(id: string, payload: QualityExecutionEventPayload) {
  return store.executionAppend(id, store.executionGet(id).revision, payload);
}
function context(index = 0) {
  const registry = store.candidateRegistryGet(1),
    entry = registry.entries[index];
  const input = candidateRegistryModelInput(entry);
  const company = caseSchema.parse({
    id: randomUUID(),
    profile: input.profile,
    sources: input.sources,
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: "preparing",
    revision: 0,
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
  });
  const plan: PlanContent = {
    title: "합성 실행 원고",
    summary: "모의 공급자가 반환하는 합성 원고입니다.",
    sections: sectionDefinitions.map((section) => ({
      ...section,
      content: "합성 자료의 현재 범위를 정리했습니다.",
      evidence: [
        {
          sourceId: input.sources[0].id,
          quote: input.sources[0].text.slice(0, 180),
          locator: "합성 원문",
        },
      ],
      needsConfirmation: false,
    })),
    actionItems: [],
    interviewQuestions: ["기술 개발 범위를 설명해 주세요."],
  };
  return { registry, entry, company, plan, candidate: input.candidate };
}
function transportResponse(output: unknown) {
  return {
    id: "mock-response",
    _request_id: "mock-request",
    model: "mock-response-model",
    status: "completed",
    usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }],
  };
}
async function complete() {
  const started = start(),
    { company, candidate, plan } = context();
  const id = started.snapshot.run.id;
  let guards = 0;
  const beforeRequest = () => {
    guards++;
  };
  // Extra application preflight checks are not dispatch observations.
  beforeRequest();
  beforeRequest();
  const transport = vi.fn(async (entry: EngineExecutionTransportRequest) => {
    const durable = store.executionGet(id);
    expect(durable.state).toBe("dispatch-recorded");
    expect(durable.dispatchCount).toBe(entry.request.sequence);
    expect(entry.request.requestDigest).toBe(digest(entry.body));
    expect(JSON.stringify(entry.body)).not.toMatch(/authoringNotes|challengeTags|materialDesign/);
    return transportResponse(
      entry.request.phase === "generation"
        ? plan
        : {
            findings: [
              {
                id: "synthetic-review",
                severity: "warning",
                category: "fact-vs-plan",
                message: "현재 상태를 확인해 주세요.",
                action: "원문을 다시 확인하세요.",
                sectionKey: "problem",
                sourceIds: [company.sources[0].id],
              },
            ],
          },
    );
  });
  const result = await generateObservedPlan(company, candidate, {
    mode: "mock",
    model: started.input.preparation.model,
    contractDigest: contract.contractDigest,
    transport,
    beforeRequest,
    hooks: {
      onDispatch: (value) => {
        append(id, { kind: "dispatch", request: value });
      },
      onResponse: (value) => {
        append(id, { kind: "response", response: value });
      },
      onValidated: (value) => {
        append(id, { kind: "validated", validated: value });
      },
    },
  });
  const snapshot = append(id, {
    kind: "finished",
    outcome: "completed",
    failureCode: null,
    result,
  });
  return { ...started, snapshot, result, transport, guards };
}

describe("quality execution durable start and exact scope", () => {
  it("pins registered inputs, engine contract, explicit mock cost and no invented actual budget", () => {
    const prepared = prepare();
    expect(prepared).toMatchObject({
      mode: "mock",
      provider: "mock",
      destination: "local-mock-transport",
      humanAnswerKey: null,
      independentHoldoutConfirmed: false,
      performanceEvaluation: "not-performed",
      cost: {
        actualCharge: 0,
        currency: null,
        priceEvidence: null,
        actualAiAllowed: false,
        actualAiBudget: null,
        inputTokenEstimate: null,
      },
    });
    expect(prepared.planDigest).toBe(digest(qualityExecutionPreparationDigestInput(prepared)));
    expect(JSON.stringify(prepared)).not.toMatch(/authoringNotes|challengeTags/);
    expect(store.executionList().executions).toEqual([]);
  });
  it("persists start and receipt before dispatch, replays without new calls after restart", () => {
    const saved = start();
    expect(saved.snapshot.state).toBe("authorized");
    expect(store.executionLookup(saved.input.clientRequestId)).toMatchObject({
      state: "committed",
      receipt: { executionId: saved.snapshot.run.id },
    });
    store.close();
    store = new PlanQualityStore(directory);
    expect(store.executionStart(saved.input, contract)).toEqual({
      snapshot: saved.snapshot,
      replayed: true,
    });
    expect(store.executionGet(saved.snapshot.run.id).dispatchCount).toBe(0);
  });
  it("CAS serializes two preparations and same nonce cannot change scope", () => {
    const first = {
      clientRequestId: randomUUID(),
      preparation: prepare(),
      acknowledgedMockOnly: true as const,
    };
    const second = {
      clientRequestId: randomUUID(),
      preparation: prepare(1),
      acknowledgedMockOnly: true as const,
    };
    store.executionStart(first, contract);
    const other = new PlanQualityStore(directory);
    try {
      expect(() => other.executionStart(second, contract)).toThrowError(
        expect.objectContaining({ code: "QUALITY_EXECUTION_VERSION_CONFLICT" }),
      );
    } finally {
      other.close();
    }
    expect(() =>
      store.executionStart({ ...first, preparation: prepare(1) }, contract),
    ).toThrowError(expect.objectContaining({ code: "QUALITY_EXECUTION_NONCE_CONFLICT" }));
    expect(store.executionLookup(second.clientRequestId)).toEqual({ state: "not-observed" });
  });
  it.each(["candidate", "engine", "digest", "actual"])(
    "refuses unapproved %s before recording a start",
    (change) => {
      const input: QualityExecutionStart = {
        clientRequestId: randomUUID(),
        preparation: prepare(),
        acknowledgedMockOnly: true,
      };
      if (change === "candidate")
        input.preparation.candidateId = store.candidateRegistryGet(1).entries[1].candidateId;
      if (change === "engine") input.preparation.engine.phases[0].systemDigest = "f".repeat(64);
      if (change === "digest") input.preparation.modelInputDigest = "f".repeat(64);
      if (change === "actual")
        (input.preparation as unknown as { mode: string }).mode = "actual-ai";
      expect(() => store.executionStart(input, contract)).toThrow();
      expect(store.executionList().executions).toHaveLength(0);
    },
  );
  it("separates all three nonce namespaces in both directions", () => {
    const registryNonce = store.candidateRegistryGet(1).clientRequestId;
    expect(() =>
      store.executionStart(
        { clientRequestId: registryNonce, preparation: prepare(), acknowledgedMockOnly: true },
        contract,
      ),
    ).toThrow();
    const saved = start();
    expect(() =>
      store.create({
        clientRequestId: saved.input.clientRequestId,
        title: "합성 평가",
        manifestDigest: store.list().manifestDigest,
      }),
    ).toThrow();
    expect(() =>
      store.candidateRegistryRegister({
        expectedVersion: 1,
        clientRequestId: saved.input.clientRequestId,
        sourceDigest: store.candidateRegistryList().source.sourceDigest,
        acknowledgedCandidateStatus: true,
      }),
    ).toThrow();
    const prior = store.create({
      clientRequestId: randomUUID(),
      title: "합성 평가",
      manifestDigest: store.list().manifestDigest,
    });
    expect(() =>
      store.executionStart(
        {
          clientRequestId: prior.run.clientRequestId,
          preparation: prepare(1),
          acknowledgedMockOnly: true,
        },
        contract,
      ),
    ).toThrow();
  });
});

describe("quality execution event order and mock provider observation", () => {
  it("runs the real generate/review path twice, retains original and final post-review output", async () => {
    const result = await complete();
    expect(result.transport).toHaveBeenCalledTimes(2);
    expect(result.guards).toBeGreaterThan(2);
    expect(result.snapshot).toMatchObject({
      state: "completed",
      revision: 7,
      dispatchCount: 2,
      responseCount: 2,
      validatedCount: 2,
      actualAiCalls: 0,
      canResume: false,
    });
    expect(result.snapshot.output.plan).toEqual(result.result.content);
    expect(result.snapshot.output.review).toEqual(result.result.review);
    const generation = result.snapshot.events[2].payload;
    expect(generation.kind).toBe("validated");
    if (generation.kind !== "validated" || generation.validated.output.kind !== "plan")
      throw new Error("missing generated plan");
    expect(generation.validated.output.content.actionItems).toEqual([]);
    expect(result.snapshot.output.plan!.actionItems.length).toBeGreaterThan(0);
    expect(qualityExecutionSnapshotSchema.parse(result.snapshot)).toEqual(result.snapshot);
  });
  it("refuses another dispatch without durable response and validation", () => {
    const saved = start(),
      first = request(saved.input.preparation),
      second = request(saved.input.preparation, 2);
    append(saved.snapshot.run.id, { kind: "dispatch", request: first });
    expect(() => append(saved.snapshot.run.id, { kind: "dispatch", request: second })).toThrow();
    append(saved.snapshot.run.id, { kind: "response", response: response(first) });
    expect(() => append(saved.snapshot.run.id, { kind: "dispatch", request: second })).toThrow();
    expect(store.executionGet(saved.snapshot.run.id).dispatchCount).toBe(1);
  });
  it("unknown dispatch survives restart and blocks same candidate under another nonce", () => {
    const saved = start(),
      id = saved.snapshot.run.id;
    append(id, { kind: "dispatch", request: request(saved.input.preparation) });
    append(id, { kind: "finished", outcome: "unknown", failureCode: "INTERRUPTED", result: null });
    store.close();
    store = new PlanQualityStore(directory);
    expect(() =>
      store.executionStart(
        { clientRequestId: randomUUID(), preparation: prepare(), acknowledgedMockOnly: true },
        contract,
      ),
    ).toThrowError(expect.objectContaining({ code: "QUALITY_EXECUTION_UNSETTLED" }));
    expect(store.executionStart(saved.input, contract).replayed).toBe(true);
    expect(start(1).snapshot.state).toBe("authorized");
    expect(() =>
      append(id, { kind: "response", response: response(request(saved.input.preparation)) }),
    ).toThrow();
  });
  it.each(["wrong-request", "actual", "model", "scope"])(
    "rejects %s event without consuming the next revision",
    (change) => {
      const saved = start(),
        id = saved.snapshot.run.id,
        req = request(saved.input.preparation);
      if (change === "wrong-request") {
        append(id, { kind: "dispatch", request: req });
        expect(() =>
          append(id, {
            kind: "response",
            response: response({ ...req, requestDigest: "f".repeat(64) }),
          }),
        ).toThrow();
        expect(store.executionGet(id).revision).toBe(1);
      } else {
        if (change === "actual") {
          req.mode = "actual-ai";
          req.provider = "OpenAI";
        }
        if (change === "model") req.configuredModel = "another-model";
        if (change === "scope") req.contractDigest = "f".repeat(64);
        expect(() => append(id, { kind: "dispatch", request: req })).toThrow();
        expect(store.executionGet(id).revision).toBe(0);
      }
    },
  );
  it("persists failed response metadata but does not permit validated output", () => {
    const saved = start(),
      id = saved.snapshot.run.id,
      req = request(saved.input.preparation);
    append(id, { kind: "dispatch", request: req });
    append(id, { kind: "response", response: response(req, "failed") });
    const output = { kind: "plan" as const, content: context().plan };
    expect(() =>
      append(id, {
        kind: "validated",
        validated: { request: req, output, outputDigest: digest(output) },
      }),
    ).toThrow();
    expect(
      append(id, {
        kind: "finished",
        outcome: "failed",
        failureCode: "OUTPUT_INVALID",
        result: null,
      }).responseCount,
    ).toBe(1);
  });
  it("pre-dispatch persistence failure invokes no provider and leaves authorization recoverable", async () => {
    const saved = start(),
      ctx = context(),
      transport = vi.fn();
    const writeFailure = vi
      .spyOn(store as unknown as { budget: (bytes: number) => void }, "budget")
      .mockImplementation(() => {
        throw new Error("disk full");
      });
    await expect(
      generateObservedPlan(ctx.company, ctx.candidate, {
        mode: "mock",
        model: saved.input.preparation.model,
        contractDigest: contract.contractDigest,
        transport,
        hooks: {
          onDispatch: (value) => {
            append(saved.snapshot.run.id, { kind: "dispatch", request: value });
          },
          onResponse: () => undefined,
          onValidated: () => undefined,
        },
      }),
    ).rejects.toThrow("disk full");
    writeFailure.mockRestore();
    expect(transport).not.toHaveBeenCalled();
    expect(store.executionGet(saved.snapshot.run.id).state).toBe("authorized");
  });
  it("response persistence failure prohibits the second provider call and keeps first dispatch unknown", async () => {
    const saved = start(),
      ctx = context(),
      transport = vi.fn(async () => transportResponse(ctx.plan));
    await expect(
      generateObservedPlan(ctx.company, ctx.candidate, {
        mode: "mock",
        model: saved.input.preparation.model,
        contractDigest: contract.contractDigest,
        transport,
        hooks: {
          onDispatch: (value) => {
            append(saved.snapshot.run.id, { kind: "dispatch", request: value });
          },
          onResponse: () => {
            throw new Error("response write failed");
          },
          onValidated: () => undefined,
        },
      }),
    ).rejects.toThrow("response write failed");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(store.executionGet(saved.snapshot.run.id)).toMatchObject({
      state: "dispatch-recorded",
      responseCount: 0,
      validatedCount: 0,
    });
  });
});

describe("quality execution immutable archives and storage boundary", () => {
  it("preserves early download bytes after later completion and new nonce replay", async () => {
    const saved = await complete(),
      id = saved.snapshot.run.id;
    const early = store.executionDownload(id, 0).body,
      completeBody = store.executionDownload(id, 7).body;
    store.executionStart(saved.input, contract);
    store.close();
    store = new PlanQualityStore(directory);
    expect(store.executionDownload(id, 0).body).toBe(early);
    expect(store.executionDownload(id, 7).body).toBe(completeBody);
    expect(JSON.parse(early).output.plan).toBeNull();
  });
  it("rejects changed final content even when hashes are resealed", async () => {
    const saved = await complete(),
      registry = store.candidateRegistryGet(1);
    const events = structuredClone(saved.snapshot.events),
      final = events.at(-1)!;
    if (final.payload.kind !== "finished" || !final.payload.result)
      throw new Error("missing final result");
    final.payload.result.content.sections[0].content = "원문과 다른 본문";
    const { eventDigest: _ignored, ...payload } = final;
    void _ignored;
    final.eventDigest = digest(payload);
    expect(() => validateQualityExecutionLedger(saved.snapshot.run, events, registry)).toThrow();
  });
  it("database rows cannot be updated or removed and unknown event rows fail integrity", () => {
    const saved = start(),
      db = new DatabaseSync(join(directory, "quality-evaluation", "quality.sqlite"));
    try {
      expect(() =>
        db
          .prepare("UPDATE quality_execution_runs SET body=? WHERE id=?")
          .run("{}", saved.snapshot.run.id),
      ).toThrow();
      expect(() =>
        db
          .prepare("DELETE FROM quality_execution_requests WHERE nonce=?")
          .run(saved.input.clientRequestId),
      ).toThrow();
      const trigger = db
        .prepare("SELECT sql FROM sqlite_schema WHERE name='quality_execution_runs_no_update'")
        .get()!.sql as string;
      db.exec("DROP TRIGGER quality_execution_runs_no_update");
      db.prepare("UPDATE quality_execution_runs SET body=? WHERE id=?").run(
        "{}",
        saved.snapshot.run.id,
      );
      // v8 audits the entire schema before legacy reads. Restore the fixture's gate
      // to exercise the original execution-body error contract independently.
      expect(() => store.executionGet(saved.snapshot.run.id)).toThrow();
      db.exec(trigger);
      expect(() => store.executionGet(saved.snapshot.run.id)).toThrowError(
        expect.objectContaining({ code: "QUALITY_STORAGE_CORRUPT" }),
      );
    } finally {
      db.close();
    }
  });
});
