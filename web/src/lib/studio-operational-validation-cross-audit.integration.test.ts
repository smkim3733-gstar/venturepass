import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { beforeAll, afterAll, afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("No current configuration/customer/transport access");
  }),
);
vi.mock("./studio-storage", () => ({ getStudioStore: forbidden, StudioStore: forbidden }));
import {
  installVersionedProviderProductionServer,
  executeProviderProductionSelection,
  retireProviderProductionServer,
} from "./studio-plan-quality-provider-production-server";
import { OperationalValidationSession } from "./studio-operational-validation-session";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestPlan, actualTestRegistry } from "./studio-plan-quality-actual-test-helpers";
import * as configuration from "./studio-plan-quality-provider-configuration";
import { providerPolicyAdoptionCommandSchema } from "./studio-plan-quality-provider-policy-adoption-command";
import { reservationStoreFixture } from "./studio-plan-quality-provider-reservation-store-test-helpers";
import { transmissionStoreFixture } from "./studio-plan-quality-provider-transmission-approval-store-test-helpers";
import { auditAdditionalValidationJournal } from "./studio-operational-validation-cross-audit";
import {
  acquireAdditionalValidationJournal,
  type AdditionalValidationJournal,
  type ValidationProfile,
  type ValidationJournalAuditView,
} from "../../scripts/operational-validation-journal.mjs";
let root: string,
  profile: ValidationProfile,
  store: PlanQualityStore,
  journal: AdditionalValidationJournal;
let view: ValidationJournalAuditView;
let fixed: NonNullable<ReturnType<typeof configuration.getProviderConfigurationProposal>>;
let firstProof: ReturnType<PlanQualityStore["inspectOperationalValidationHistory"]>;
const dbfile = () => join(profile.directory, "quality-evaluation", "quality.sqlite");
function response(value: unknown) {
  return Response.json({
    id: "synthetic-cross-audit",
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
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-09-28T18:01:37.000Z");
  root = mkdtempSync(join(tmpdir(), "venture-cross-audit-"));
  profile = {
    approvalId: "venturepass-operational-validation-20260928",
    directory: join(root, "data"),
    controlDirectory: join(root, "control"),
    currency: "USD",
    unitScale: 6,
    capUnits: "15000000",
  };
  vi.stubEnv("VENTURE_DATA_DIR", profile.directory);
  vi.stubEnv("OPENAI_API_KEY", "sk-synthetic-cross-audit-only");
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (++calls > 2) throw Error("Extra dispatch");
      return response(calls === 1 ? actualTestPlan(actualTestRegistry()) : { findings: [] });
    }),
  );
  const session = new OperationalValidationSession(profile);
  try {
    session.prepare();
    expect((await session.execute()).executionCompleted).toBe(true);
  } finally {
    expect(session.close()).toBe(true);
  }
  expect(calls).toBe(2);
  fixed = configuration.getProviderConfigurationProposal()!;
  store = new PlanQualityStore(profile.directory);
  journal = acquireAdditionalValidationJournal(profile);
  view = journal.readAuditView();
  firstProof = store.inspectOperationalValidationHistory({
    runId: (view.steps.execute.command as { selection: { runId: string } }).selection.runId,
    budgetRevision: (view.steps.execute.receipt as { budgetRevision: number }).budgetRevision,
  });
  vi.stubGlobal("fetch", forbidden);
  vi.stubEnv("OPENAI_API_KEY", "");
}, 60000);
afterEach(() => {
  vi.restoreAllMocks();
  expect(forbidden).not.toHaveBeenCalled();
});
afterAll(() => {
  store?.close();
  journal?.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (root) {
    const rel = relative(resolve(tmpdir()), resolve(root));
    if (!rel.startsWith("venture-cross-audit-") || rel.includes(".."))
      throw Error("Unsafe cleanup");
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
function changed(change: (value: ValidationJournalAuditView) => void) {
  const value = structuredClone(view);
  change(value);
  return { readAuditView: () => value };
}
it("cross-audits all original commands with one DB snapshot without changing DB/journal bytes", () => {
  const bytes = readFileSync(dbfile()),
    before = journal.readAuditView();
  const read = vi.spyOn(store, "inspectOperationalValidationHistory");
  const result = auditAdditionalValidationJournal(store, journal);
  expect(read).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({
    ledgerAudited: true,
    fileIdentityAudited: true,
    originalCommandsAudited: true,
    additionalCommandsAudited: true,
    transmissionAllowed: false,
    recoverable: [],
  });
  expect(result.evidence.databaseDigest).toBe(firstProof.databaseDigest);
  expect(result.evidence.checkpoint).toEqual(firstProof.checkpoint);
  expect(readFileSync(dbfile())).toEqual(bytes);
  expect(journal.readAuditView()).toEqual(before);
});
it("reads after expiry without a current source/configuration, key or network", () => {
  vi.setSystemTime("2035-01-01T00:00:00.000Z");
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(forbidden);
  expect(auditAdditionalValidationJournal(store, journal).transmissionAllowed).toBe(false);
  vi.setSystemTime("2026-09-28T18:01:37.000Z");
});
it.each(["register", "policy", "reserve", "approve-transmission", "execute"] as const)(
  "rejects changed original %s acknowledgement",
  (stage) => {
    expect(() =>
      auditAdditionalValidationJournal(
        store,
        changed((v) => {
          v.steps[stage].receipt = { recordDigest: "a".repeat(64) };
        }),
      ),
    ).toThrow();
  },
);
it.each(["register", "policy", "reserve", "approve-transmission"] as const)(
  "rejects a changed original %s nonce despite valid DB history",
  (stage) => {
    expect(() =>
      auditAdditionalValidationJournal(
        store,
        changed((v) => {
          (
            v.steps[stage].command as { command: { clientRequestId: string } }
          ).command.clientRequestId = randomUUID();
        }),
      ),
    ).toThrow();
  },
);
it("rejects original selection substitution and unknown token evidence", () => {
  for (const mutate of [
    (v: ValidationJournalAuditView) => {
      (v.steps.execute.command as { selection: { runId: string } }).selection.runId = randomUUID();
    },
    (v: ValidationJournalAuditView) => {
      Object.assign(v.steps.execute.command!, { tokenEvidence: { verified: true } });
    },
  ])
    expect(() => auditAdditionalValidationJournal(store, changed(mutate))).toThrow();
});
it("does not accept a false continuation copied from a completed execute checkpoint", () => {
  expect(() =>
    auditAdditionalValidationJournal(
      store,
      changed((v) => {
        v.steps["continue-review"] = structuredClone(v.steps.execute);
      }),
    ),
  ).toThrow();
});
it("rejects file changes across the single audited DB read", () => {
  const next = structuredClone(view);
  next.original.headDigest = "a".repeat(64);
  const readAuditView = vi.fn().mockReturnValueOnce(view).mockReturnValueOnce(next);
  expect(() => auditAdditionalValidationJournal(store, { readAuditView })).toThrow(
    "VALIDATION_HISTORY_MISMATCH",
  );
  expect(readAuditView).toHaveBeenCalledTimes(2);
});
it("does not trust a valid completed DB when the original file completion is missing", () => {
  expect(() =>
    auditAdditionalValidationJournal(
      store,
      changed((v) => {
        v.steps.execute.receipt = null;
      }),
    ),
  ).toThrow();
});
it("reconciles v2 policy/reservation/approval file loss by original nonce, rejects file ack + DB loss and unrecorded extra rows", async () => {
  const originalBytes = readFileSync(join(profile.controlDirectory, "00.json"));
  const evidence = auditAdditionalValidationJournal(store, journal).evidence;
  journal.appendAdditionalApproval(evidence);
  expect(auditAdditionalValidationJournal(store, journal).recoverable).toEqual([]);
  store.close();
  store = new PlanQualityStore(profile.directory, {
    providerPolicySelection: { version: "plan-observation-v2", configuration: fixed },
  });
  const registry = store.candidateRegistryGet(1);
  const { result, expectedPolicyHead } = store.providerPolicyReview(
    1,
    registry.entries[0].candidateId,
  );
  if (result.status !== "review") throw Error(result.reason);
  const policy = {
    review: result.review,
    command: providerPolicyAdoptionCommandSchema.parse({
      commandVersion: 1,
      kind: "adopt-provider-policy",
      clientRequestId: randomUUID(),
      version: 1,
      versionDigest: registry.versionDigest,
      candidateId: registry.entries[0].candidateId,
      expectedPolicyHead,
      approvedReviewDigest: result.review.reviewDigest,
      budgetAction: "keep-existing-budget",
      initialBudgetRequestId: null,
      approval: {
        noticeVersion: 1,
        acknowledgedPolicy: true,
        acknowledgedBudgetAction: true,
        reservationAndTransmission: "separate-approval-required",
        approvedAt: new Date().toISOString(),
      },
    }),
  };
  journal.prepareAdditional("policy", policy);
  expect(auditAdditionalValidationJournal(store, journal).recoverable).toEqual([]);
  const savedPolicy = store.providerPolicyAdopt(policy.command, policy.review).record;
  const noCommand = structuredClone(journal.readAuditView());
  noCommand.additional!.steps.policy = { command: null, receipt: null };
  expect(() =>
    auditAdditionalValidationJournal(store, { readAuditView: () => noCommand }),
  ).toThrow();
  expect(auditAdditionalValidationJournal(store, journal).recoverable).toEqual([
    { stage: "policy", record: savedPolicy },
  ]);
  // Read-only reconciliation never acknowledges implicitly.
  expect(journal.readAdditionalState()!.steps.policy.receipt).toBeNull();
  journal.acknowledgeAdditional("policy", { recordDigest: savedDigest(savedPolicy) });
  expect(() =>
    auditAdditionalValidationJournal(
      { inspectOperationalValidationHistory: () => firstProof },
      journal,
    ),
  ).toThrow();
  const r = reservationStoreFixture(store);
  journal.prepareAdditional("reserve", r);
  const savedReservation = store.providerReserve(r.command, r.review).record;
  expect(auditAdditionalValidationJournal(store, journal).recoverable).toEqual([
    { stage: "reserve", record: savedReservation },
  ]);
  journal.acknowledgeAdditional("reserve", { recordDigest: savedDigest(savedReservation) });
  const a = transmissionStoreFixture(store, savedReservation);
  journal.prepareAdditional("approve-transmission", a);
  const savedApproval = store.providerApproveTransmission(a.command, a.review).record;
  expect(auditAdditionalValidationJournal(store, journal).recoverable).toEqual([
    { stage: "approve-transmission", record: savedApproval },
  ]);
  journal.acknowledgeAdditional("approve-transmission", {
    recordDigest: savedDigest(savedApproval),
  });
  const done = auditAdditionalValidationJournal(store, journal);
  expect(done.evidence).toEqual(evidence);
  expect(done.recoverable).toEqual([]);
  expect(done.currentBudget).toMatchObject({ capUnits: "15000000", recognizedUnits: "380" });
  expect(done.transmissionAllowed).toBe(false);
  expect(readFileSync(join(profile.controlDirectory, "00.json"))).toEqual(originalBytes);
  const ack = structuredClone(journal.readAuditView());
  (ack.additional!.steps["approve-transmission"].receipt as { recordDigest: string }).recordDigest =
    "a".repeat(64);
  expect(() => auditAdditionalValidationJournal(store, { readAuditView: () => ack })).toThrow();
  const selection = {
    runId: savedApproval.runId,
    runDigest: savedApproval.runDigest,
    approvalBindingDigest: savedApproval.recordDigest,
  };
  journal.prepareAdditional("execute", { selection, automaticRetryAllowed: false });
  let calls = 0;
  vi.stubEnv("OPENAI_API_KEY", "sk-synthetic-cross-audit-only");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (++calls > 2) throw Error("Extra dispatch");
      return response(calls === 1 ? actualTestPlan(actualTestRegistry()) : { findings: [] });
    }),
  );
  installVersionedProviderProductionServer("plan-observation-v2");
  try {
    expect((await executeProviderProductionSelection(selection)).executionCompleted).toBe(true);
  } finally {
    expect(retireProviderProductionServer().retainedCaptures).toBe(0);
  }
  vi.stubGlobal("fetch", forbidden);
  vi.stubEnv("OPENAI_API_KEY", "");
  expect(calls).toBe(2);
  const completed = store.inspectOperationalValidationHistory({
    runId: evidence.selection.runId,
    budgetRevision: evidence.checkpoint.budgetRevision,
  });
  const snapshot = completed.material!.provider.snapshots.find(
    (row: { run: { id: string } }) => row.run.id === selection.runId,
  )!;
  const budget = completed.currentBudget!;
  journal.acknowledgeAdditional("execute", {
    runRevision: snapshot.revision,
    snapshotDigest: snapshot.snapshotDigest,
    budgetRevision: budget.revision,
    budgetHeadDigest: budget.headDigest,
    recognizedUnits: budget.recognizedUnits,
    heldUnits: budget.heldUnits,
  });
  const final = auditAdditionalValidationJournal(store, journal);
  expect(final.evidence).toEqual(evidence);
  expect(final.currentBudget).toMatchObject({
    capUnits: "15000000",
    recognizedUnits: "760",
    heldUnits: "0",
  });
  const unrecorded = structuredClone(journal.readAuditView());
  unrecorded.additional!.steps.execute = { command: null, receipt: null };
  expect(() =>
    auditAdditionalValidationJournal(store, { readAuditView: () => unrecorded }),
  ).toThrow();
  const altered = structuredClone(journal.readAuditView());
  (altered.additional!.steps.execute.receipt as { recognizedUnits: string }).recognizedUnits = "0";
  expect(() => auditAdditionalValidationJournal(store, { readAuditView: () => altered })).toThrow();
  vi.setSystemTime("2035-01-01T00:00:00Z");
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(forbidden);
  expect(auditAdditionalValidationJournal(store, journal)).toEqual(final);
}, 60000);
import { providerDigest as savedDigest } from "../../scripts/local-data-quality-provider.mjs";
