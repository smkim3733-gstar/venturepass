/** All writes below are synthetic protocol fixtures in isolated temporary databases. */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import * as candidateRegistry from "./studio-plan-quality-candidate-registry";
import { candidateRegistrySourceSchema } from "./studio-plan-quality-candidate-registry-types";
import { actualTestNow, actualTestPreparation } from "./studio-plan-quality-actual-test-helpers";
import * as configuration from "./studio-plan-quality-provider-configuration";
import {
  policyAdoptionFixture,
  seedPolicyTestBudget,
} from "./studio-plan-quality-provider-policy-adoption-test-helpers";
import {
  providerTestConfigure,
  providerTestStartInput,
} from "./studio-plan-quality-provider-test-helpers";
import { providerConfigurationDigestInput } from "./studio-plan-quality-provider-review-types";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { providerReservationReviewSchema } from "./studio-plan-quality-provider-reservation-review-types";

vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("External access forbidden");
  }),
);
vi.mock("openai", () => ({
  default: class {
    constructor() {
      forbidden();
    }
  },
}));
vi.mock("./studio-storage", () => ({ getStudioStore: forbidden, StudioStore: forbidden }));
let directory: string, store: PlanQualityStore, db: DatabaseSync;
const sentinel = "SYNTHETIC COMPANY BYTES MUST STAY CLOSED";
beforeEach(() => {
  forbidden.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-reservation-review-"));
  writeFileSync(join(directory, "studio.sqlite"), sentinel);
  store = new PlanQualityStore(directory, {
    actualEnvironment: "synthetic-test",
    providerEnvironment: "synthetic-test",
  });
  store.candidateRegistryRegister({
    expectedVersion: 0,
    clientRequestId: randomUUID(),
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  });
  db = new DatabaseSync(join(directory, "quality-evaluation", "quality.sqlite"));
  db.function("quality_storage_contract", () => "quality-v9");
}, 15000);
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe(sentinel);
  db.close();
  store.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  const rel = relative(resolve(tmpdir()), resolve(directory));
  if (!rel.startsWith("venture-reservation-review-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});
function selection(index = 0) {
  const registry = store.candidateRegistryGet(1);
  return {
    version: 1,
    versionDigest: registry.versionDigest,
    candidateId: registry.entries[index].candidateId,
  };
}
function rows() {
  return digest({
    schema: db.prepare("SELECT name,type,sql FROM sqlite_schema ORDER BY name").all(),
    tables: db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'quality_%' ORDER BY name",
      )
      .all()
      .map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]),
  });
}
function inspect(value: unknown = selection()) {
  const before = rows();
  try {
    return store.providerReservationReview(value);
  } finally {
    expect(rows()).toBe(before);
  }
}
function review(value: unknown = selection()) {
  const result = inspect(value);
  if (result.status !== "review") throw new Error(result.reason);
  return providerReservationReviewSchema.parse(result.review);
}
function adopt(index = 0) {
  const value = policyAdoptionFixture(store, index);
  return store.providerPolicyAdopt(value.command, value.review).record;
}
function corruptFixture(trigger: string, work: () => void) {
  const sql = db
    .prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?")
    .get(trigger)?.sql;
  if (typeof sql !== "string" || !/^quality_[a-z_]+_no_(update|delete)$/.test(trigger))
    throw new Error("Invalid fixture trigger");
  db.exec(`DROP TRIGGER ${trigger}`);
  try {
    work();
  } finally {
    db.exec(sql);
  }
}

it("includes the selected unreferenced registry in an empty ledger and leaves every row unchanged", () => {
  const result = review();
  expect(result.policy).toEqual({ state: "not-adopted", reference: null });
  expect(result.policyHead).toEqual({ revision: 0, headDigest: null });
  expect(result.assessment.blockers).toEqual(["policy-not-adopted", "budget-not-configured"]);
  expect(result.runs.globalCount).toBe(0);
});
it("reads committed policy and current budget after reopen in the default read-only environment", () => {
  const selected = selection(),
    first = adopt();
  adopt(1);
  store.close();
  store = new PlanQualityStore(directory);
  vi.setSystemTime("2026-09-27T03:30:00.000Z");
  const result = review(selected);
  expect(result.policy).toMatchObject({
    state: "matched",
    reference: { revision: 1, recordDigest: first.recordDigest },
  });
  expect(result.policyHead.revision).toBe(2);
  expect(result.policyReview.budget).toMatchObject({
    revision: 1,
    capUnits: "15000000",
    availableUnits: "15000000",
  });
  expect(result.assessment).toEqual({ state: "conditions-met", blockers: [] });
  expect(result.actions).toEqual({
    reservationAllowed: false,
    dispatchAllowed: false,
    budgetWriteAllowed: false,
  });
  expect(() =>
    store.providerBudgetConfigure({
      clientRequestId: randomUUID(),
      expectedRevision: 1,
      policy: {
        environment: "production",
        provenance: "explicit-user",
        currency: "USD",
        unitScale: 6,
        capUnits: "20000000",
      },
    }),
  ).toThrowError(expect.objectContaining({ code: "PROVIDER_EXECUTION_DISABLED" }));
});
it("does not use another candidate's committed policy", () => {
  adopt(1);
  expect(review().assessment.blockers).toEqual(["policy-not-adopted"]);
});
it("loads a newly selected registry version even when all existing policy references use another version", () => {
  adopt();
  const previousSource = store.candidateRegistryList().source;
  const entries = structuredClone(previousSource.entries);
  entries[0].reviewerMetadata.authoringNotes.push("합성 예약 검토용 후속 작성 메모");
  const manifest = candidateRegistry.candidateRegistryManifest(entries);
  const source = candidateRegistrySourceSchema.parse({
    ...previousSource,
    entries,
    manifest,
    sourceDigest: candidateRegistry.candidateRegistrySourceDigest(entries),
    manifestDigest: digest(manifest),
  });
  vi.spyOn(candidateRegistry, "createCandidateRegistrySource").mockReturnValue(source);
  store.candidateRegistryRegister({
    expectedVersion: 1,
    clientRequestId: randomUUID(),
    sourceDigest: source.sourceDigest,
    acknowledgedCandidateStatus: true,
  });
  const registry = store.candidateRegistryGet(2);
  const result = review({
    version: 2,
    versionDigest: registry.versionDigest,
    candidateId: registry.entries[0].candidateId,
  });
  expect(result.policy.state).toBe("not-adopted");
  expect(result.policyHead.revision).toBe(1);
  expect(result.policyReview.budget.revision).toBe(1);
});
it("preserves existing insufficient production budget and independent synthetic holds", () => {
  seedPolicyTestBudget(db, "1000000");
  providerTestConfigure(store);
  const run = store.providerStart(providerTestStartInput(store));
  adopt();
  const archive = store.providerDownload(run.snapshot.run.id, 0).body;
  const result = review();
  expect(result.assessment.blockers).toEqual(["budget-insufficient"]);
  expect(result.policyReview.budget).toMatchObject({
    capUnits: "1000000",
    heldUnits: "0",
    recognizedUnits: "0",
    availableUnits: "1000000",
  });
  expect(result.runs).toEqual({ globalCount: 1, productionCount: 0, unsettledCandidateRunIds: [] });
  expect(store.providerBudgetGet().heldUnits).toBe("4");
  expect(store.providerDownload(run.snapshot.run.id, 0).body).toBe(archive);
});
it("preserves insertion order when legacy and provider records are interleaved", () => {
  store.actualBudgetConfigure({
    clientRequestId: randomUUID(),
    expectedRevision: 0,
    policy: { provenance: "synthetic-test", currency: "TST", unitScale: 6, capUnits: "100" },
  });
  const legacyStart = (index: number) => {
    const budget = store.actualBudgetGet();
    const preparation = actualTestPreparation(store.candidateRegistryGet(1), {
      candidateIndex: index,
      ledgerDigest: budget.headDigest!,
      capUnits: budget.capUnits,
      heldUnits: budget.heldUnits,
    });
    store.actualStart({
      clientRequestId: randomUUID(),
      expectedBudgetRevision: budget.revision,
      expectedBudgetDigest: budget.headDigest!,
      expectedActualRunCount: store.actualList().executions.length,
      preparation,
      approval: {
        provenance: "synthetic-test",
        approvedPreparationDigest: preparation.preparationDigest,
        acknowledgedSyntheticOnly: true,
        approvedAt: actualTestNow,
      },
    });
  };
  legacyStart(0);
  providerTestConfigure(store);
  store.providerStart(providerTestStartInput(store));
  legacyStart(1);
  adopt();
  const result = review();
  expect(result.runs).toEqual({ globalCount: 3, productionCount: 0, unsettledCandidateRunIds: [] });
  expect(result.assessment.blockers).toEqual([]);
  expect(review().ledgerDigest).toBe(result.ledgerDigest);
});
it("returns the same ledger digest across reconnects and deterministic repeated reads", () => {
  adopt();
  providerTestConfigure(store);
  store.providerStart(providerTestStartInput(store));
  const selected = selection(),
    first = review(selected);
  expect(review(selected)).toEqual(first);
  store.close();
  store = new PlanQualityStore(directory);
  expect(review(selected)).toEqual(first);
});
it("rechecks server configuration and never falls back to a superseded policy", () => {
  adopt();
  const original = configuration.getProviderConfigurationProposal;
  const changed = original();
  if (!changed) throw new Error("fixture");
  changed.proposedBudget.capUnits = "16000000";
  changed.configurationDigest = digest(providerConfigurationDigestInput(changed));
  const getter = vi
    .spyOn(configuration, "getProviderConfigurationProposal")
    .mockReturnValue(changed);
  expect(review().assessment.blockers).toEqual(["policy-changed"]);
  adopt();
  getter.mockRestore();
  expect(review().policy).toMatchObject({ state: "changed", reference: { revision: 2 } });
});
it.each(["missing", "expired"])(
  "returns %s configuration without writes or using archived authority as current",
  (kind) => {
    adopt();
    const selected = selection();
    if (kind === "missing")
      vi.spyOn(configuration, "getProviderConfigurationProposal").mockReturnValue(null);
    else vi.setSystemTime("2030-01-01T00:00:00.000Z");
    expect(inspect(selected)).toMatchObject({
      status: "unavailable",
      reason: kind === "missing" ? "configuration-missing-or-invalid" : "configuration-expired",
      review: null,
    });
  },
);
it.each(["configuration", "ledger", "policy", "unknown"])(
  "rejects caller-supplied %s before querying the store",
  (field) => {
    const value = { ...selection(), [field]: {} };
    const query = vi.spyOn(DatabaseSync.prototype, "prepare");
    expect(() => store.providerReservationReview(value)).toThrowError(
      expect.objectContaining({
        code: "QUALITY_PROVIDER_RESERVATION_SELECTION_INVALID",
        status: 400,
      }),
    );
    expect(query).not.toHaveBeenCalled();
  },
);
it("distinguishes an absent selected version from a corrupt database", () => {
  expect(() => inspect({ ...selection(), version: 2 })).toThrowError(
    expect.objectContaining({ code: "QUALITY_PROVIDER_CANDIDATE_NOT_FOUND", status: 404 }),
  );
  expect(inspect({ ...selection(), versionDigest: "a".repeat(64) })).toMatchObject({
    status: "unavailable",
    reason: "selection-invalid",
  });
});
it.each(["evaluation", "registration", "budget-receipt", "artifact", "schema"])(
  "fails closed on %s damage even with a valid selected policy and budget",
  (corruption) => {
    const selected = selection();
    adopt();
    if (corruption === "evaluation") {
      store.create({
        clientRequestId: randomUUID(),
        title: "synthetic unrelated evaluation",
        manifestDigest: store.list().manifestDigest,
      });
      corruptFixture("quality_runs_no_update", () =>
        db.prepare("UPDATE quality_runs SET body_hash=?").run("a".repeat(64)),
      );
    } else if (corruption === "registration") {
      corruptFixture("quality_candidate_requests_no_update", () =>
        db.prepare("UPDATE quality_candidate_requests SET body_hash=?").run("a".repeat(64)),
      );
    } else if (corruption === "budget-receipt") {
      corruptFixture("quality_actual_requests_no_delete", () =>
        db.prepare("DELETE FROM quality_actual_requests").run(),
      );
    } else if (corruption === "artifact") {
      providerTestConfigure(store);
      store.providerStart(providerTestStartInput(store));
      corruptFixture("quality_actual_artifacts_no_update", () =>
        db.prepare("UPDATE quality_actual_artifacts SET payload=?").run(Buffer.from("{}")),
      );
    } else db.exec("CREATE TABLE unexpected_reservation_fixture(value TEXT)");
    expect(() => inspect(selected)).toThrow();
  },
);
it("keeps candidate, ledger, server configuration and result inside one read transaction", () => {
  const selected = selection();
  const nativeExec = DatabaseSync.prototype.exec,
    statements: string[] = [];
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    if (this !== db) statements.push(sql);
    return nativeExec.call(this, sql);
  });
  const original = configuration.getProviderConfigurationProposal;
  const getter = vi
    .spyOn(configuration, "getProviderConfigurationProposal")
    .mockImplementation(() => {
      db.exec("PRAGMA busy_timeout=1");
      // A reader allows a reserved write lock but prevents COMMIT in the existing DELETE journal mode.
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec("CREATE TABLE synthetic_writer_probe(value TEXT)");
        expect(() => db.exec("COMMIT")).toThrow(/locked/);
      } finally {
        db.exec("ROLLBACK");
      }
      return original();
    });
  const first = review(selected);
  expect(first.policyReview.budget.revision).toBe(0);
  expect(getter).toHaveBeenCalledOnce();
  expect(statements).toEqual(["BEGIN", "COMMIT"]);
  getter.mockRestore();
  seedPolicyTestBudget(db, "20000000");
  expect(review(selected).policyReview.budget).toMatchObject({ revision: 1, capUnits: "20000000" });
});
it("rolls back a failed read and allows the next independent inspection", () => {
  const selected = selection();
  const getter = vi
    .spyOn(configuration, "getProviderConfigurationProposal")
    .mockImplementationOnce(() => {
      throw new Error("Synthetic configuration failure");
    });
  expect(() => inspect(selected)).toThrow("Synthetic configuration failure");
  getter.mockRestore();
  db.exec("BEGIN EXCLUSIVE");
  db.exec("ROLLBACK");
  expect(review(selected).policy.state).toBe("not-adopted");
});
