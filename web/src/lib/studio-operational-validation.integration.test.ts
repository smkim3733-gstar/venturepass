import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("Customer access forbidden");
  }),
);
vi.mock("./studio-storage", () => ({ getStudioStore: forbidden, StudioStore: forbidden }));
import { auditAdditionalValidationJournal } from "./studio-operational-validation-cross-audit";
import { auditAdditionalValidationDatabase } from "./studio-operational-validation-history";
import { OperationalValidationSession } from "./studio-operational-validation-session";
import { OperationalValidationPreparation } from "./studio-operational-validation-preparation";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { ProviderGenerationDispatchStore } from "./studio-plan-quality-provider-dispatch-store";
import { actualTestPlan, actualTestRegistry } from "./studio-plan-quality-actual-test-helpers";
import { inspectProviderProductionServer } from "./studio-plan-quality-provider-production-server";
import {
  acquireValidationJournal,
  acquireAdditionalValidationJournal,
  inspectValidationJournal,
  type ValidationProfile,
} from "../../scripts/operational-validation-journal.mjs";

let root: string, profile: ValidationProfile;
let sessions: OperationalValidationSession[];
const network = vi.fn<typeof fetch>();
const key = "sk-synthetic-operational-test-key-only";
const timeout = 120000; // Multiple reopen/rollback/full-archive audits in a single Windows scenario.
function session() {
  const s = new OperationalValidationSession(profile);
  sessions.push(s);
  return s;
}
function response(value: unknown) {
  return Response.json({
    id: "synthetic-operational-response",
    model: "gpt-5.4-2026-03-05",
    service_tier: "default",
    status: "completed",
    usage: {
      input_tokens: 20,
      output_tokens: 10,
      total_tokens: 30,
      input_tokens_details: { cached_tokens: 5 },
      output_tokens_details: { reasoning_tokens: 2 },
    },
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }],
  });
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-09-28T18:01:37.000Z");
  root = mkdtempSync(join(tmpdir(), "venture-operational-core-"));
  profile = {
    approvalId: "venturepass-operational-validation-20260928",
    directory: join(root, "data"),
    controlDirectory: join(root, "control"),
    currency: "USD",
    unitScale: 6,
    capUnits: "15000000",
  };
  sessions = [];
  vi.stubEnv("VENTURE_DATA_DIR", profile.directory);
  vi.stubEnv("OPENAI_API_KEY", key);
  network.mockReset();
  vi.stubGlobal("fetch", network);
  network.mockImplementation(async () => {
    if (network.mock.calls.length > 2) throw Error("Extra dispatch forbidden");
    return response(
      network.mock.calls.length === 1 ? actualTestPlan(actualTestRegistry()) : { findings: [] },
    );
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of sessions) {
    if (!s.close()) {
      s.recover();
      expect(s.close()).toBe(true);
    }
  }
  expect(forbidden).not.toHaveBeenCalled();
  expect(inspectProviderProductionServer().retainedCaptures).toBe(0);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (!rel.startsWith("venture-operational-core-") || rel.includes(".."))
    throw Error("Unsafe cleanup");
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

it(
  "composes real core approval writers without test store options, resumes original identities, and never dispatches during prepare",
  () => {
    const first = session();
    const selection = first.prepare(),
      before = first.inspect();
    expect(before.budget).toMatchObject({
      capUnits: "15000000",
      heldUnits: "11220000",
      recognizedUnits: "0",
    });
    expect(before.status?.lastAuditedRevision).toBe(1);
    first.close();
    const resumed = session();
    const writes = vi.spyOn(PlanQualityStore.prototype, "providerReserve");
    expect(resumed.prepare()).toEqual(selection);
    expect(writes).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    expect(JSON.stringify(resumed.inspect())).not.toContain(key);
  },
  timeout,
);

it(
  "timestamps each approval after its review even while the wall clock advances during core inspection",
  () => {
    const policy = PlanQualityStore.prototype.providerPolicyReviewContext;
    const reservation = PlanQualityStore.prototype.providerReservationReview;
    const transmission = PlanQualityStore.prototype.providerTransmissionReview;
    const advance = () => vi.setSystemTime(Date.now() + 1000);
    vi.spyOn(PlanQualityStore.prototype, "providerPolicyReviewContext").mockImplementation(function (
      this: PlanQualityStore,
      ...args
    ) {
      advance();
      return policy.apply(this, args);
    });
    vi.spyOn(PlanQualityStore.prototype, "providerReservationReview").mockImplementation(function (
      this: PlanQualityStore,
      ...args
    ) {
      advance();
      return reservation.apply(this, args);
    });
    vi.spyOn(PlanQualityStore.prototype, "providerTransmissionReview").mockImplementation(function (
      this: PlanQualityStore,
      ...args
    ) {
      advance();
      return transmission.apply(this, args);
    });
    const prepared = session();
    prepared.prepare();
    expect(prepared.inspect().status?.lastAuditedRevision).toBe(1);
    expect(network).not.toHaveBeenCalled();
  },
  timeout,
);

it(
  "recovers a real reservation COMMIT whose response was lost without another reservation or budget initialization",
  () => {
    const first = session();
    const original = PlanQualityStore.prototype.providerReserve;
    const fault = vi
      .spyOn(PlanQualityStore.prototype, "providerReserve")
      .mockImplementation(function (this: PlanQualityStore, ...args) {
        original.apply(this, args);
        throw Error("Lost post-COMMIT reply");
      });
    expect(() => first.prepare()).toThrow("Lost post-COMMIT reply");
    first.close();
    fault.mockRestore();
    expect(inspectValidationJournal(profile).pendingStage).toBe("reserve");
    const resumed = session(),
      writes = vi.spyOn(PlanQualityStore.prototype, "providerReserve");
    resumed.prepare();
    expect(writes).not.toHaveBeenCalled();
    expect(resumed.inspect().budget.heldUnits).toBe("11220000");
    expect(network).not.toHaveBeenCalled();
  },
  timeout,
);

it(
  "executes exactly one generation plus one review and rejects replay after restart or restoration of the approved DB",
  async () => {
    let first = session();
    first.prepare();
    first.close();
    const dbFile = join(profile.directory, "quality-evaluation", "quality.sqlite"),
      approved = readFileSync(dbFile);
    first = session();
    first.prepare();
    expect(await first.execute()).toMatchObject({ executionCompleted: true });
    expect(network).toHaveBeenCalledTimes(2);
    // Each rate component rounds upward: (38 uncached + 2 cached + 150 output) * 2 calls.
    expect(first.inspect().budget).toMatchObject({ heldUnits: "0", recognizedUnits: "380" });
    await expect(first.execute()).rejects.toThrow("VALIDATION_EXECUTION_UNAVAILABLE");
    first.close();
    const resumed = session();
    resumed.prepare();
    await expect(resumed.execute()).rejects.toThrow("VALIDATION_EXECUTION_UNAVAILABLE");
    resumed.close();
    // Preserve the DB file identity but restore an older valid archive: the external checkpoint detects it.
    writeFileSync(dbFile, approved);
    const restored = session();
    expect(() => restored.prepare()).toThrow("VALIDATION_EXECUTION_UNAVAILABLE");
    expect(network).toHaveBeenCalledTimes(2);
  },
  timeout,
);

it.each(["generation", "review"] as const)(
  "keeps %s capture and lease alive, recovers without resend, and continues only the missing review",
  async (phase) => {
    const s = session();
    s.prepare();
    const fault = vi
      .spyOn(
        ProviderGenerationDispatchStore.prototype,
        phase === "generation" ? "recordResponse" : "recordReviewResponse",
      )
      .mockImplementation(() => {
        throw Error("Synthetic disk interruption");
      });
    expect((await s.execute()).status).toBe("capture-recovery-required");
    const calls = phase === "generation" ? 1 : 2;
    expect(s.close()).toBe(false);
    expect(inspectValidationJournal(profile).reason).toBe("BUSY");
    expect(() => acquireValidationJournal(profile)).toThrow("BUSY");
    expect(s.recover().status).toBe("capture-recovery-required");
    expect(network).toHaveBeenCalledTimes(calls);
    fault.mockRestore();
    const recovered = s.recover();
    expect(recovered.lastAuditedRevision).toBe(phase === "generation" ? 5 : 10);
    expect(network).toHaveBeenCalledTimes(calls);
    if (phase === "generation") expect((await s.continueReview()).executionCompleted).toBe(true);
    await expect(s.continueReview()).rejects.toThrow("VALIDATION_EXECUTION_UNAVAILABLE");
    expect(network).toHaveBeenCalledTimes(2);
    expect(s.close()).toBe(true);
    const journal = acquireAdditionalValidationJournal(profile);
    const store = new PlanQualityStore(profile.directory);
    try {
      expect(auditAdditionalValidationJournal(store, journal).originalCommandsAudited).toBe(true);
      if (phase === "generation") {
        const view = journal.readAuditView();
        (view.steps.execute.receipt as { recognizedUnits: string }).recognizedUnits = "999";
        expect(() => auditAdditionalValidationJournal(store, { readAuditView: () => view })).toThrow();
      }
    } finally { store.close(); journal.close(); }
  },
  timeout,
);

it(
  "unknown delivery retains cost and the durable attempt prevents any new dispatch",
  async () => {
    network.mockRejectedValue(Error("Synthetic lost provider reply"));
    const s = session();
    s.prepare();
    const view = await s.execute();
    expect(view.executionCompleted).toBe(false);
    expect(network).toHaveBeenCalledTimes(1);
    expect(BigInt(s.inspect().budget.heldUnits)).toBeGreaterThan(BigInt(0));
    s.close();
    const reopened = session();
    reopened.prepare();
    await expect(reopened.execute()).rejects.toThrow("VALIDATION_EXECUTION_UNAVAILABLE");
    await expect(reopened.continueReview()).rejects.toThrow("VALIDATION_EXECUTION_UNAVAILABLE");
    expect(network).toHaveBeenCalledTimes(1);
  },
  timeout,
);

it(
  "blocks DB history outside the journal before issuing another approval",
  () => {
    const s = session();
    s.prepare();
    s.close();
    const journal = acquireValidationJournal(profile),
      store = new PlanQualityStore(profile.directory);
    try {
      const original = store.providerPolicyHead.bind(store);
      vi.spyOn(store, "providerPolicyHead").mockImplementation(() => ({
        ...original(),
        revision: 2,
      }));
      const writes = vi.spyOn(store, "providerApproveTransmission");
      expect(() => new OperationalValidationPreparation(store, journal).prepare()).toThrow(
        "VALIDATION_HISTORY_MISMATCH",
      );
      expect(writes).not.toHaveBeenCalled();
    } finally {
      store.close();
      journal.close();
    }
  },
  timeout,
);

it("refuses closing or replacing the lease while the original SDK request is in flight", async () => {
  const s = session(); s.prepare();
  let release!: (value: Response) => void, observed!: () => void;
  const started = new Promise<void>((done) => { observed = done; });
  network.mockImplementationOnce(() => new Promise<Response>((done) => { release = done; observed(); }));
  const pending = s.execute();
  await started;
  try {
    expect(s.close()).toBe(false);
    expect(() => acquireValidationJournal(profile)).toThrow("BUSY");
    await expect(s.execute()).rejects.toThrow("VALIDATION_EXECUTION_UNAVAILABLE");
  } finally { release(response(actualTestPlan(actualTestRegistry()))); }
  expect((await pending).executionCompleted).toBe(true);
  expect(network).toHaveBeenCalledTimes(2);
  expect(s.close()).toBe(true);
}, timeout);


it("appends an additional file approval only after the original core completes, preserving the DB and blocking the old runner", async () => {
  const first = session();
  const selection = first.prepare();
  expect(await first.execute()).toMatchObject({ executionCompleted: true });
  const core = first.inspect();
  expect(core.budget).toMatchObject({ capUnits: "15000000", recognizedUnits: "380", heldUnits: "0" });
  expect(core.status?.lastAuditedRevision).toBe(10);
  first.close();
  const dbFile = join(profile.directory, "quality-evaluation", "quality.sqlite");
  const before = readFileSync(dbFile), store = new PlanQualityStore(profile.directory);
  const audited = store.inspectDatabase();
  const journal = acquireAdditionalValidationJournal(profile);
  try {
    const checkpoint = journal.readStep("execute").receipt as {
      runRevision: 10; snapshotDigest: string; budgetRevision: number; budgetHeadDigest: string;
      recognizedUnits: string; heldUnits: "0";
    };
    expect(checkpoint.recognizedUnits).toBe(core.budget?.recognizedUnits);
    expect(checkpoint.heldUnits).toBe(core.budget?.heldUnits);
    const evidence = { original: journal.readOriginalAnchor(), selection, checkpoint, databaseDigest: audited.digest };
    expect(auditAdditionalValidationDatabase(store, evidence)).toMatchObject({ ledgerAudited: true, fileIdentityAudited: false, transmissionAllowed: false });
    journal.appendAdditionalApproval(evidence);
    expect(journal.readAdditionalState()).toMatchObject({
      completedStages: 0, ledgerAudited: false, transmissionAllowed: false,
      approval: { checkpoint: { recognizedUnits: "380", heldUnits: "0" } },
    });
    expect(journal.appendAdditionalApproval(evidence)).toEqual(journal.readAdditionalState()?.approval);
  } finally { journal.close(); store.close(); }
  expect(readFileSync(dbFile)).toEqual(before);
  expect(() => session()).toThrow("VALIDATION_EXECUTION_UNAVAILABLE");
  expect(network).toHaveBeenCalledTimes(2);
  // Independent DB evidence is checked; no additional writer or second runtime is started.
}, timeout);
