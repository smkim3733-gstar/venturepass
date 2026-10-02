/** Synthetic SQLite only. The read API cannot initialize budgets, journal records or transport. */
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { beforeAll, beforeEach, afterAll, afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("No customer or supplier access");
  }),
);
vi.mock("./studio-storage", () => ({ getStudioStore: forbidden, StudioStore: forbidden }));
import { PlanQualityStore } from "./studio-plan-quality-store";
import { finalizationStoreFixture } from "./studio-plan-quality-provider-finalization-store-test-helpers";
import { readFixedProviderConfiguration } from "./studio-plan-quality-provider-configuration-20260927-test-fixture";
import * as configuration from "./studio-plan-quality-provider-configuration";
import { providerPolicyAdoptionCommandSchema } from "./studio-plan-quality-provider-policy-adoption-command";
import { reservationStoreFixture } from "./studio-plan-quality-provider-reservation-store-test-helpers";
import { transmissionStoreFixture } from "./studio-plan-quality-provider-transmission-approval-store-test-helpers";
import { auditAdditionalValidationDatabase } from "./studio-operational-validation-history";
import { inspectCompletedProviderHistory } from "../../scripts/local-data-quality.mjs";
const file = (root: string) => join(root, "quality-evaluation", "quality.sqlite");
let seedRoot: string, seedBytes: Buffer, root: string, store: PlanQualityStore;
let selection: { runId: string; budgetRevision: number };
let original: NonNullable<ReturnType<PlanQualityStore["inspectCompletedProviderHistory"]>>;
function clean(dir: string) {
  const rel = relative(resolve(tmpdir()), resolve(dir));
  if (!rel.startsWith("venture-history-") || rel.includes("..")) throw Error("Unsafe cleanup");
  rmSync(dir, { recursive: true, force: true });
}
function clock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-09-27T03:34:00.000Z");
  vi.stubGlobal("fetch", forbidden);
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(
    readFixedProviderConfiguration,
  );
}
beforeAll(async () => {
  clock();
  seedRoot = mkdtempSync(join(tmpdir(), "venture-history-seed-"));
  const seed = new PlanQualityStore(seedRoot, { providerEnvironment: "synthetic-test" });
  try {
    seed.candidateRegistryRegister({
      expectedVersion: 0,
      clientRequestId: randomUUID(),
      sourceDigest: seed.candidateRegistryList().source.sourceDigest,
      acknowledgedCandidateStatus: true,
    });
    const f = await finalizationStoreFixture(seed);
    seed.providerRecordFinalization(f.identity);
    selection = {
      runId: f.identity.validation.dispatch.generation.dispatch.runId,
      budgetRevision: seed.providerBudgetGet("production").revision,
    };
    original = seed.inspectCompletedProviderHistory(selection)!;
    expect(original.databaseDigest).toBe(seed.inspectDatabase().digest);
  } finally {
    seed.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
  seedBytes = readFileSync(file(seedRoot));
}, 40000);
afterAll(() => {
  if (seedRoot) clean(seedRoot);
});
beforeEach(() => {
  clock();
  root = mkdtempSync(join(tmpdir(), "venture-history-read-"));
  mkdirSync(join(root, "quality-evaluation"));
  writeFileSync(file(root), seedBytes);
  store = new PlanQualityStore(root);
}, 30000); // A fixture reopen took 21.4s under local load; production time limits are unchanged.
afterEach(() => {
  store?.close();
  expect(forbidden).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (root) clean(root);
});
function append() {
  store.close();
  store = new PlanQualityStore(root, {
    providerPolicySelection: {
      version: "plan-observation-v2",
      configuration: readFixedProviderConfiguration()!,
    },
  });
  const registry = store.candidateRegistryGet(1),
    candidateId = registry.entries[0].candidateId;
  const { result, expectedPolicyHead } = store.providerPolicyReview(1, candidateId);
  if (result.status !== "review") throw Error(result.reason);
  store.providerPolicyAdopt(
    providerPolicyAdoptionCommandSchema.parse({
      commandVersion: 1,
      kind: "adopt-provider-policy",
      clientRequestId: randomUUID(),
      version: 1,
      versionDigest: registry.versionDigest,
      candidateId,
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
    result.review,
  );
  const r = reservationStoreFixture(store);
  const saved = store.providerReserve(r.command, r.review);
  const a = transmissionStoreFixture(store, saved.record);
  store.providerApproveTransmission(a.command, a.review);
  return saved.record.runId;
}
it("reproduces the complete original DB digest and completed checkpoint without changing bytes", () => {
  expect(store.inspectCompletedProviderHistory(selection)).toEqual(original);
  expect(original).toMatchObject({
    ledgerAudited: true,
    transmissionAllowed: false,
    checkpoint: { runRevision: 10, heldUnits: "0" },
  });
  expect(readFileSync(file(root))).toEqual(seedBytes);
});
it("keeps the historical digest and budget after a v2 policy, reservation and approval append", () => {
  append();
  const proof = store.inspectCompletedProviderHistory(selection)!;
  expect(proof.current.digest).not.toBe(original.current.digest);
  expect({ ...proof, current: original.current, currentBudget: original.currentBudget }).toEqual(
    original,
  );
  expect(store.providerBudgetGet("production").heldUnits).not.toBe("0");
  expect(store.providerBudgetGet("production").recognizedUnits).toBe(
    original.checkpoint.recognizedUnits,
  );
}, 20000);
it("reads expired history without current configuration or network", () => {
  append();
  vi.setSystemTime("2035-01-01T00:00:00.000Z");
  vi.mocked(configuration.getProviderConfigurationProposal).mockImplementation(forbidden);
  const before = readFileSync(file(root));
  expect(store.inspectCompletedProviderHistory(selection)?.databaseDigest).toBe(
    original.databaseDigest,
  );
  expect(readFileSync(file(root))).toEqual(before);
}, 20000);
it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid budget revision %s",
  (budgetRevision) => {
    expect(() => store.inspectCompletedProviderHistory({ ...selection, budgetRevision })).toThrow();
  },
);
it.each([-1, 1])(
  "does not silently round or advance the original completion budget (%s)",
  (offset) => {
    expect(() =>
      store.inspectCompletedProviderHistory({
        ...selection,
        budgetRevision: selection.budgetRevision + offset,
      }),
    ).toThrow();
  },
);
it("rejects a missing run and a v2 reservation pretending to be the first completed run", () => {
  expect(() =>
    store.inspectCompletedProviderHistory({ ...selection, runId: randomUUID() }),
  ).toThrow();
  const runId = append();
  expect(() =>
    store.inspectCompletedProviderHistory({
      runId,
      budgetRevision: store.providerBudgetGet("production").revision,
    }),
  ).toThrow();
}, 20000);
it("requires an owned transaction for the internal transaction mode", () => {
  const db = new DatabaseSync(file(root), { readOnly: true });
  try {
    expect(() => inspectCompletedProviderHistory(db, selection, { inTransaction: true })).toThrow(
      "QUALITY_TRANSACTION_REQUIRED",
    );
    expect(db.isTransaction).toBe(false);
    expect(inspectCompletedProviderHistory(db, selection)?.databaseDigest).toBe(
      original.databaseDigest,
    );
    expect(db.isTransaction).toBe(false);
  } finally {
    db.close();
  }
});

function evidence() {
  if (original.checkpoint.budgetHeadDigest === null) throw Error("Missing completed budget head");
  return {
    original: { instanceId: randomUUID(), recordCount: 14, headDigest: "a".repeat(64) },
    selection: original.selection,
    checkpoint: { ...original.checkpoint, budgetHeadDigest: original.checkpoint.budgetHeadDigest, runRevision: 10 as const, heldUnits: "0" as const },
    databaseDigest: original.databaseDigest,
  };
}
it("independently matches the file protocol's DB evidence while leaving file identity and authority unproven", () => {
  append();
  const result = auditAdditionalValidationDatabase(store, evidence());
  expect(result).toMatchObject({
    ledgerAudited: true,
    fileIdentityAudited: false,
    transmissionAllowed: false,
  });
  expect(result.currentBudget.capUnits).toBe("15000000");
  expect(result.currentBudget.heldUnits).not.toBe(result.checkpoint.heldUnits);
}, 20000);
it.each([
  "databaseDigest",
  "snapshotDigest",
  "budgetHeadDigest",
  "recognizedUnits",
  "runDigest",
  "approvalBindingDigest",
])("rejects a structurally valid forged %s in journal evidence", (field) => {
  const value = structuredClone(evidence());
  if (field === "databaseDigest") value.databaseDigest = "b".repeat(64);
  else if (field === "recognizedUnits") value.checkpoint.recognizedUnits = "1";
  else if (field === "runDigest" || field === "approvalBindingDigest")
    value.selection[field] = "b".repeat(64);
  else if (field === "snapshotDigest" || field === "budgetHeadDigest")
    value.checkpoint[field] = "b".repeat(64);
  expect(() => auditAdditionalValidationDatabase(store, value)).toThrow(
    "VALIDATION_HISTORY_MISMATCH",
  );
});
it("audits corruption in a later run before serving the intact original prefix and leaves no transaction open", () => {
  const id = append();
  const db = new DatabaseSync(file(root));
  try {
    db.function("quality_storage_contract", () => "quality-v9");
    // Deliberate damage in a disposable fixture only, never a runtime repair.
    const triggers = db
      .prepare(
        "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='quality_actual_events'",
      )
      .all();
    for (const { name } of triggers)
      db.exec('DROP TRIGGER "' + String(name).replaceAll('"', '""') + '"');
    db.prepare("UPDATE quality_actual_events SET body_hash=? WHERE run_id=? AND revision=1").run(
      "b".repeat(64),
      id,
    );
    for (const { sql } of triggers) db.exec(String(sql));
    const damaged = readFileSync(file(root));
    expect(() => inspectCompletedProviderHistory(db, selection)).toThrow();
    expect(db.isTransaction).toBe(false);
    expect(readFileSync(file(root))).toEqual(damaged);
    expect(() => store.inspectCompletedProviderHistory(selection)).toThrow();
  } finally {
    db.close();
  }
}, 20000);
