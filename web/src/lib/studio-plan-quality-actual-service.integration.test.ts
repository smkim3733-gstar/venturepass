import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { generateObservedPlan, getPlanExecutionContract } from "./studio-engine";
import type { EngineExecutionTransportRequest } from "./studio-engine-execution-types";
import { candidateRegistryModelInput } from "./studio-plan-quality-candidate-registry";
import { caseSchema } from "./studio-schema";
import { planQualityEvaluationDigest as digest } from "./studio-plan-quality-evaluation";
import { StudioError } from "./studio-http";
import {
  qualityActualPreparationSchema,
  qualityActualPreparationDigestInput,
  qualityActualRequestEvidenceDigestInput,
} from "./studio-plan-quality-actual-types";

const state = vi.hoisted(() => ({
  store: null as PlanQualityStore | null,
  opened: vi.fn(),
  environmentRead: vi.fn(),
  external: vi.fn(() => {
    throw new Error("External, provider or company IO forbidden");
  }),
}));
vi.mock("server-only", () => ({}));
vi.mock("./studio-plan-quality-store", async (original) => ({
  ...(await original<typeof import("./studio-plan-quality-store")>()),
  getPlanQualityStore: () => {
    state.opened();
    return state.store!;
  },
}));
vi.mock("./studio-storage", () => ({
  getStudioStore: state.external,
  StudioStore: state.external,
}));
vi.mock("openai", () => ({
  default: class {
    constructor() {
      state.external();
    }
  },
}));
import { POST as prepare } from "@/app/api/studio/quality/actual-preparation/route";

let directory: string, store: PlanQualityStore, savedEnvironment: NodeJS.ProcessEnv;
const base = "http://127.0.0.1:3000/api/studio/quality/actual-preparation";
const unregisteredInput = {
  version: 1,
  versionDigest: "0".repeat(64),
  candidateId: "validation-candidate-missing",
  model: null,
};
const request = (body: unknown, headers: Record<string, string> = {}, url = base) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

function registeredInput(model: string | null = "unverified-test-model") {
  const catalog = store.candidateRegistryList();
  const registry = catalog.versions.length
    ? store.candidateRegistryGet(1)
    : store.candidateRegistryRegister({
        expectedVersion: 0,
        clientRequestId: randomUUID(),
        sourceDigest: catalog.source.sourceDigest,
        acknowledgedCandidateStatus: true,
      }).snapshot;
  return {
    version: registry.version,
    versionDigest: registry.versionDigest,
    candidateId: registry.entries[0].candidateId,
    model,
  };
}

/** Inspect only this test's synthetic database, including receipt and historical body bytes. */
function persistedContents() {
  const db = new DatabaseSync(join(directory, "quality-evaluation", "quality.sqlite"), {
    readOnly: true,
  });
  try {
    const names = [
      "quality_runs",
      "quality_revisions",
      "quality_requests",
      "quality_candidate_versions",
      "quality_candidate_requests",
      "quality_execution_runs",
      "quality_execution_events",
      "quality_execution_requests",
    ];
    return {
      schema: db
        .prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name")
        .all(),
      rows: Object.fromEntries(
        names.map((name) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]),
      ),
    };
  } finally {
    db.close();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", state.external);
  savedEnvironment = process.env;
  directory = mkdtempSync(join(tmpdir(), "venturepass-actual-preparation-api-"));
  writeFileSync(join(directory, "studio.sqlite"), "SYNTHETIC COMPANY SENTINEL UNTOUCHED");
  store = new PlanQualityStore(directory);
  state.store = store;
  process.env = new Proxy(savedEnvironment, {
    get(target, name, receiver) {
      if (typeof name === "string" && /^(OPENAI|VENTURE_DATA_DIR)/.test(name)) {
        state.environmentRead(name);
        throw new Error("Credential/config access forbidden");
      }
      return Reflect.get(target, name, receiver);
    },
  });
});

afterEach(() => {
  process.env = savedEnvironment;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  try {
    expect(state.external).not.toHaveBeenCalled();
    expect(state.environmentRead).not.toHaveBeenCalled();
    expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe(
      "SYNTHETIC COMPANY SENTINEL UNTOUCHED",
    );
  } finally {
    store.close();
    const target = resolve(directory),
      rel = relative(resolve(tmpdir()), target);
    if (!rel.startsWith("venturepass-actual-preparation-api-") || rel.includes(".."))
      throw new Error("Unsafe cleanup");
    rmSync(target, { recursive: true, force: true });
  }
});

describe("read-only actual AI preparation API", () => {
  it("returns exact pinned generation JSON but blocks unknown model execution without evidence or approval", async () => {
    const input = registeredInput();
    const response = await prepare(request(input));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const result = qualityActualPreparationSchema.parse(await response.json());
    expect(result).toMatchObject({
      environment: "production",
      model: input.model,
      readiness: "blocked",
      costs: null,
      evidence: { price: null, tokens: null, budget: null },
      executionAllowed: false,
      approvalRecorded: false,
      reservationRecorded: false,
      humanAnswerKey: null,
      independentHoldoutConfirmed: false,
      performanceEvaluation: "not-performed",
      scope: {
        version: input.version,
        versionDigest: input.versionDigest,
        candidateId: input.candidateId,
      },
    });
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining([
        "PRICE_NOT_CONFIGURED",
        "TOKEN_BOUND_NOT_CONFIGURED",
        "BUDGET_NOT_CONFIGURED",
      ]),
    );
    expect(result.executionBlocks).toHaveLength(2);
    expect(result.engine).toEqual(getPlanExecutionContract());
    expect(result.preparationDigest).toBe(digest(qualityActualPreparationDigestInput(result)));
    const evidence = result.requestEvidence!;
    expect(evidence).not.toBeNull();
    expect(evidence.evidenceDigest).toBe(digest(qualityActualRequestEvidenceDigestInput(evidence)));
    expect(evidence.generation.requestDigest).toBe(digest(evidence.generation.body));
    expect(evidence.generation.body).toMatchObject({
      model: input.model,
      store: false,
      max_output_tokens: 16000,
      text: { format: { type: "json_schema", name: "business_plan", strict: true } },
    });
    expect(evidence.reviewTemplate).toMatchObject({
      complete: false,
      phase: "review",
      model: input.model,
      draftSlot: {
        rule: "this-run-validated-generation-only",
        requiresValidatedEventBinding: true,
      },
    });
    expect(evidence.reviewTemplate.fixedUserContext).not.toHaveProperty("draft");
    const registry = store.candidateRegistryGet(input.version);
    const selected = candidateRegistryModelInput(registry.entries[0]);
    const company = caseSchema.parse({
      id: randomUUID(),
      profile: selected.profile,
      sources: selected.sources,
      analysis: null,
      selectedCandidateId: selected.candidate.id,
      plans: [],
      tasks: [],
      stage: "preparing",
      revision: 0,
      createdAt: result.preparedAt,
      updatedAt: result.preparedAt,
    });
    // Stop the mock transport before any response. Compare against the actual engine path's SDK body.
    const transport = vi.fn(async (_request: EngineExecutionTransportRequest) => {
      void _request;
      throw new Error("Synthetic transport stops after body inspection");
    });
    await expect(
      generateObservedPlan(company, selected.candidate, {
        mode: "mock",
        model: input.model!,
        contractDigest: result.engine.contractDigest,
        transport,
        hooks: { onDispatch: () => {}, onResponse: () => {}, onValidated: () => {} },
      }),
    ).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0].body).toEqual(evidence.generation.body);
    expect(transport.mock.calls[0][0].request.requestDigest).toBe(
      evidence.generation.requestDigest,
    );
    expect(store.executionList().executions).toEqual([]);
  });

  it("keeps missing model and costs unknown instead of selecting an environment default or claiming zero charge", async () => {
    const response = await prepare(request(registeredInput(null)));
    expect(response.status).toBe(200);
    const result = qualityActualPreparationSchema.parse(await response.json());
    expect(result.model).toBeNull();
    expect(result.requestEvidence).toBeNull();
    expect(result.costs).toBeNull();
    expect(result.readiness).toBe("blocked");
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining([
        "MODEL_NOT_SELECTED",
        "PRICE_NOT_CONFIGURED",
        "TOKEN_BOUND_NOT_CONFIGURED",
        "BUDGET_NOT_CONFIGURED",
      ]),
    );
  });

  it("preserves candidate archives, existing 50-case records, mock events and receipts across repeated inspections", async () => {
    const input = registeredInput();
    const registryBytes = store.candidateRegistryDownload(1).body;
    const old = store.create({
      title: "합성 보존 시험",
      clientRequestId: randomUUID(),
      manifestDigest: store.list().manifestDigest,
    }).run;
    const oldBytes = store.download(old.id, 0).body;
    const initial = store.executionStart(
      {
        clientRequestId: randomUUID(),
        acknowledgedMockOnly: true,
        preparation: store.executionPrepare(
          { version: 1, candidateId: input.candidateId },
          getPlanExecutionContract(),
        ),
      },
      getPlanExecutionContract(),
    ).snapshot;
    const finished = store.executionAppend(initial.run.id, 0, {
      kind: "finished",
      outcome: "failed",
      failureCode: "ENGINE_FAILED",
      result: null,
    });
    const originalExecution = store.executionDownload(initial.run.id, 0).body;
    const finalExecution = store.executionDownload(initial.run.id, finished.revision).body;
    const before = persistedContents();
    for (const model of [input.model, null, "another-unverified-model"])
      expect((await prepare(request({ ...input, model }))).status).toBe(200);
    expect(persistedContents()).toEqual(before);
    expect(store.candidateRegistryDownload(1).body).toBe(registryBytes);
    expect(store.download(old.id, 0).body).toBe(oldBytes);
    expect(store.executionDownload(initial.run.id, 0).body).toBe(originalExecution);
    expect(store.executionDownload(initial.run.id, finished.revision).body).toBe(finalExecution);
  });

  it.each(["external host", "external origin", "cross-site", "external URL", "forwarded host"])(
    "rejects %s before opening storage",
    async (kind) => {
      const headers: Record<string, string> =
        kind === "external host"
          ? { host: "evil.example" }
          : kind === "external origin"
            ? { origin: "https://evil.example" }
            : kind === "cross-site"
              ? { "sec-fetch-site": "cross-site" }
              : kind === "forwarded host"
                ? { "x-forwarded-host": "evil.example" }
                : {};
      const response = await prepare(
        request(
          unregisteredInput,
          headers,
          kind === "external URL"
            ? "https://evil.example/api/studio/quality/actual-preparation"
            : base,
        ),
      );
      expect(response.status).toBe(403);
      expect(state.opened).not.toHaveBeenCalled();
    },
  );

  it.each([
    { price: null },
    { tokens: null },
    { budget: null },
    { environment: "synthetic-test" },
    { executionAllowed: true },
    { approval: true },
    { clientRequestId: "client-nonce" },
    { company: { name: "SYNTHETIC UNREGISTERED INPUT" } },
    { sources: [] },
    { provider: "custom" },
    { endpoint: "https://evil.example" },
  ])("rejects client-supplied evidence, consent or data %j", async (extra) => {
    const response = await prepare(request({ ...unregisteredInput, ...extra }));
    expect(response.status).toBe(400);
    expect(state.opened).not.toHaveBeenCalled();
  });

  it("rejects missing, malformed and out-of-range scope or model fields before storage", async () => {
    const invalid = [
      { version: 0 },
      { version: 21 },
      { version: 1.5 },
      { version: "1" },
      { versionDigest: "A".repeat(64) },
      { versionDigest: "0".repeat(63) },
      { candidateId: "../validation-candidate-other" },
      { candidateId: "validation-candidate-" },
      { model: "" },
      { model: " unverified-model" },
      { model: "unverified-model " },
      { model: "model/remote" },
      { model: "모델" },
      { model: "x".repeat(201) },
      { model: 123 },
    ];
    for (const override of invalid)
      expect((await prepare(request({ ...unregisteredInput, ...override }))).status).toBe(400);
    for (const field of Object.keys(unregisteredInput)) {
      const body: Record<string, unknown> = { ...unregisteredInput };
      delete body[field];
      expect((await prepare(request(body))).status).toBe(400);
    }
    expect(state.opened).not.toHaveBeenCalled();
  });

  it("enforces bounded JSON bytes even without or with an understated Content-Length", async () => {
    const oversized = { ...unregisteredInput, padding: "한".repeat(1500) };
    expect(JSON.stringify(oversized).length).toBeLessThan(4096);
    const headerCases: Record<string, string>[] = [
      {},
      { "content-length": "1" },
      { "content-length": "4097" },
    ];
    for (const headers of headerCases)
      expect((await prepare(request(oversized, headers))).status).toBe(413);
    expect(state.opened).not.toHaveBeenCalled();
  });

  it("rejects query, wrong media type, malformed UTF8 and JSON before storage", async () => {
    const invalidRequests = [
      [request(unregisteredInput, {}, base + "?model=other"), 400],
      [request(unregisteredInput, { "content-type": "text/plain" }), 415],
      [request(unregisteredInput, { "content-type": "application/jsonx" }), 415],
      [
        new Request(base, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: new Uint8Array([255]),
        }),
        400,
      ],
      [
        new Request(base, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        }),
        400,
      ],
    ] as const;
    for (const [req, status] of invalidRequests) expect((await prepare(req)).status).toBe(status);
    expect(state.opened).not.toHaveBeenCalled();
  });

  it("fails closed for unregistered version, foreign candidate and mismatched pinned version digest", async () => {
    expect((await prepare(request(unregisteredInput))).status).toBe(404);
    const input = registeredInput();
    expect(
      (await prepare(request({ ...input, candidateId: "validation-candidate-foreign" }))).status,
    ).toBe(404);
    const response = await prepare(request({ ...input, versionDigest: "0".repeat(64) }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "ACTUAL_PREPARATION_SCOPE_CHANGED" });
    expect((await prepare(request({ ...input, version: 2 }))).status).toBe(404);
    expect(store.executionList().executions).toEqual([]);
  });

  it("does not return a partial preview or leak storage details when registry verification fails", async () => {
    const input = registeredInput();
    const read = vi.spyOn(store, "candidateRegistryGet");
    read.mockImplementationOnce(() => {
      throw new Error("PRIVATE SYNTHETIC STORAGE DETAILS");
    });
    const response = await prepare(request(input));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.code).toBe("ACTUAL_PREPARATION_UNAVAILABLE");
    expect(body).not.toHaveProperty("requestEvidence");
    expect(JSON.stringify(body)).not.toContain("PRIVATE");
    read.mockImplementationOnce(() => {
      throw new StudioError("합성 기록 확인 필요", 409, "QUALITY_STORAGE_CORRUPT");
    });
    expect((await prepare(request(input))).status).toBe(409);
  });
});
