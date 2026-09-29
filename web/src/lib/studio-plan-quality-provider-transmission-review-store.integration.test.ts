/** Isolated synthetic databases and consent fixtures only; no actual approval or transport. */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import {
  adoptReservationTestPolicy,
  reservationStoreFixture,
} from "./studio-plan-quality-provider-reservation-store-test-helpers";
import {
  providerTestConfigure,
  providerTestStartInput,
} from "./studio-plan-quality-provider-test-helpers";
import { readLedgerDatabaseInput } from "./studio-plan-quality-ledger-database";
import { readProviderReservationDatabaseRows } from "../../scripts/local-data-quality-provider-reservation-database.mjs";
import { inspectQualityDatabase } from "../../scripts/local-data-quality.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { prepareProviderTransmissionApproval } from "./studio-plan-quality-provider-transmission-plan";
import { transmissionCommandFor } from "./studio-plan-quality-provider-transmission-test-helpers";
import * as configuration from "./studio-plan-quality-provider-configuration";
import {
  providerConfigurationDigestInput,
  providerProposalSourceDigestInput,
} from "./studio-plan-quality-provider-review-types";
import { createProviderTransmissionReview } from "./studio-plan-quality-provider-transmission-review";
import {
  providerTransmissionReviewSchema,
  type ProviderTransmissionReview,
} from "./studio-plan-quality-provider-transmission-review-types";

vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("External IO forbidden");
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
const sentinel = "PRESERVE SYNTHETIC COMPANY DATABASE";
type Selection = { runId: string; runDigest: string };
beforeEach(() => {
  forbidden.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-transmission-review-"));
  writeFileSync(join(directory, "studio.sqlite"), sentinel);
  store = new PlanQualityStore(directory);
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
  if (!rel.startsWith("venture-transmission-review-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});
function reserve(index = 0): Selection {
  adoptReservationTestPolicy(store, index);
  const input = reservationStoreFixture(store, index);
  const { record } = store.providerReserve(input.command, input.review);
  return { runId: record.runId, runDigest: record.runDigest };
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
function inspect(selection: unknown) {
  const before = rows();
  try {
    return store.providerTransmissionReview(selection);
  } finally {
    expect(rows()).toBe(before);
  }
}
function review(selection: Selection) {
  const result = inspect(selection);
  if (result.status !== "review") throw new Error(result.reason);
  return providerTransmissionReviewSchema.parse(result.review);
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
// Native historical approval fixture. This helper is deliberately absent from application code.
function seedApproval(v: ProviderTransmissionReview) {
  const command = transmissionCommandFor(v);
  command.approval.approvedAt = actualTestNow;
  const reservation = readProviderReservationDatabaseRows(db);
  const result = prepareProviderTransmissionApproval({
    command,
    review: v,
    current: {
      selection: { runId: v.run.id, runDigest: v.run.runDigest },
      inspectedAt: actualTestNow,
      configuration: configuration.getProviderConfigurationProposal(),
      archive: {
        ledger: readLedgerDatabaseInput(db, (version) => store.candidateRegistryGet(version)),
        coverage: reservation.coverage,
        records: reservation.records,
      },
    },
    additionalUsedBytes: 0,
  });
  if (result.status !== "prepared") throw new Error(result.reason);
  const { event, receipt, binding } = result.plan.rows;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO quality_actual_events VALUES(?,?,?,?)").run(
      event.runId,
      event.revision,
      JSON.stringify(event),
      digest(event),
    );
    db.prepare("INSERT INTO quality_actual_requests VALUES(?,?,?)").run(
      receipt.clientRequestId,
      JSON.stringify(receipt),
      digest(receipt),
    );
    db.prepare("INSERT INTO quality_provider_transmission_bindings VALUES(?,?,?,?)").run(
      binding.runId,
      binding.clientRequestId,
      JSON.stringify(binding),
      digest(binding),
    );
    inspectQualityDatabase(db, { inTransaction: true });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

it("reads an audited production reservation in the default environment without granting writes", () => {
  const selected = reserve(),
    v = review(selected);
  expect(v.run).toMatchObject({
    id: selected.runId,
    runDigest: selected.runDigest,
    revision: 0,
    state: "reserved",
  });
  expect(v.assessment).toEqual({ state: "conditions-met", blockers: [] });
  expect(v.actions).toEqual({
    approvalWriteAllowed: false,
    dispatchAllowed: false,
    budgetWriteAllowed: false,
  });
  expect(v.accountAccess).toBe("not-checked");
  expect(v.reservation.heldUnits).toBe(v.budget.heldUnits);
  expect(() =>
    store.providerCancel(selected.runId, {
      clientRequestId: randomUUID(),
      expectedRevision: 0,
      reason: "test-cleanup",
    }),
  ).toThrowError(expect.objectContaining({ code: "PROVIDER_EXECUTION_DISABLED" }));
});
it("matches the portable contract exactly and preserves digests across repeated reads and reopen", () => {
  const selected = reserve(),
    first = review(selected);
  db.exec("BEGIN");
  try {
    inspectQualityDatabase(db, { inTransaction: true });
    const ledger = readLedgerDatabaseInput(db, (version) => store.candidateRegistryGet(version));
    const { coverage, records } = readProviderReservationDatabaseRows(db);
    const archive = { ledger, coverage, records };
    expect(first.archiveDigest).toBe(digest(archive));
    expect(
      createProviderTransmissionReview({
        selection: selected,
        inspectedAt: actualTestNow,
        configuration: configuration.getProviderConfigurationProposal(),
        archive,
      }),
    ).toEqual({ status: "review", review: first });
  } finally {
    db.exec("ROLLBACK");
  }
  expect(review(selected)).toEqual(first);
  store.close();
  store = new PlanQualityStore(directory);
  expect(review(selected)).toEqual(first);
});
it("uses the original financial basis when inspected later and never extends preparation expiry", () => {
  const selected = reserve(),
    first = review(selected);
  vi.setSystemTime(Date.parse(actualTestNow) + 60_000);
  const next = review(selected);
  expect(next.financialBasis).toEqual(first.financialBasis);
  expect(next.manifest).toEqual(first.manifest);
  expect(next.request).toEqual(first.request);
  expect(next.inspectedAt).not.toBe(first.inspectedAt);
  const deadline = store.providerGet(selected.runId).run.preparation.expiresAt;
  expect(Date.parse(next.expiresAt)).toBeLessThanOrEqual(Date.parse(deadline));
  vi.setSystemTime(deadline);
  expect(inspect(selected)).toMatchObject({
    status: "unavailable",
    reason: "reservation-expired",
    review: null,
  });
});
it("distinguishes an absent run, a stale digest, and invalid caller input", () => {
  const selected = reserve();
  expect(() => inspect({ ...selected, runId: randomUUID() })).toThrowError(
    expect.objectContaining({ code: "QUALITY_PROVIDER_RUN_NOT_FOUND", status: 404 }),
  );
  expect(inspect({ ...selected, runDigest: "a".repeat(64) })).toEqual({
    status: "unavailable",
    reason: "selection-invalid",
    review: null,
  });
});
it.each(["archive", "configuration", "inspectedAt", "approvalWriteAllowed", "ledger"])(
  "rejects caller-supplied %s before any SQL",
  (field) => {
    const query = vi.spyOn(DatabaseSync.prototype, "prepare");
    expect(() =>
      store.providerTransmissionReview({
        runId: randomUUID(),
        runDigest: "a".repeat(64),
        [field]: {},
      }),
    ).toThrowError(
      expect.objectContaining({
        status: 400,
        code: "QUALITY_PROVIDER_TRANSMISSION_SELECTION_INVALID",
      }),
    );
    expect(query).not.toHaveBeenCalled();
  },
);
it("reflects policy replacement but does not let another candidate replace this reservation's policy", () => {
  const selected = reserve(),
    first = review(selected);
  adoptReservationTestPolicy(store, 1);
  const other = review(selected);
  expect(other.policy.reservedReference).toEqual(first.policy.reservedReference);
  expect(other.assessment.state).toBe("conditions-met");
  expect(other.archiveDigest).not.toBe(first.archiveDigest);
  adoptReservationTestPolicy(store, 0);
  expect(review(selected).assessment.blockers).toEqual(["policy-superseded"]);
});
it("reads the latest production budget without counting existing reservations twice", () => {
  const larger = configuration.getProviderConfigurationProposal()!;
  larger.proposedBudget.capUnits = "30000000";
  larger.configurationDigest = digest(providerConfigurationDigestInput(larger));
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockReturnValue(larger);
  const selected = reserve(),
    first = review(selected);
  reserve(1);
  const next = review(selected);
  expect(next.budget.revision).toBe(first.budget.revision + 1);
  expect(BigInt(next.budget.availableUnits)).toBeLessThan(BigInt(first.budget.availableUnits));
  expect(next.reservation).toEqual(first.reservation);
  expect(next.assessment.state).toBe("conditions-met");
});
it("includes synthetic history but refuses to treat its run as an approved production reservation", () => {
  const selected = reserve(),
    first = review(selected);
  store.close();
  store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
  providerTestConfigure(store);
  const synthetic = store.providerStart(providerTestStartInput(store)).snapshot;
  const next = review(selected);
  expect(next.budget).toEqual(first.budget);
  expect(next.archiveDigest).not.toBe(first.archiveDigest);
  expect(inspect({ runId: synthetic.run.id, runDigest: synthetic.run.runDigest })).toMatchObject({
    status: "unavailable",
    reason: "production-reservation-required",
  });
});
it("uses the current execution state while preserving the historical reservation receipt", () => {
  const selected = reserve(),
    first = review(selected);
  const original = store.providerReservationLookup(first.reservation.clientRequestId);
  seedApproval(first);
  const next = review(selected);
  expect(next.run).toMatchObject({ revision: 1, state: "approved" });
  expect(next.facts.reservationIntact).toBe(true);
  expect(next.assessment.blockers).toEqual(["run-not-reserved"]);
  expect(store.providerReservationLookup(first.reservation.clientRequestId)).toEqual(original);
  expect(next.actions.dispatchAllowed).toBe(false);
});
it.each(["missing", "tampered", "changed", "expired"])(
  "rechecks %s server configuration on every read",
  (kind) => {
    const selected = reserve();
    review(selected);
    const changed = configuration.getProviderConfigurationProposal()!;
    if (kind === "expired") {
      const deadline = new Date(Date.parse(actualTestNow) + 30_000).toISOString();
      for (const source of changed.sources) {
        source.validUntil = deadline;
        source.recordDigest = digest(providerProposalSourceDigestInput(source));
      }
      for (const authority of [
        changed.context.authority,
        changed.pricing.authority,
        changed.retention,
        changed.usagePolicyTemplate.authority,
      ]) {
        authority.validUntil = deadline;
        authority.documentDigest = changed.sources.find(
          (source) => source.url === authority.sourceUrl,
        )!.recordDigest;
      }
      vi.setSystemTime(Date.parse(actualTestNow) + 60_000);
    } else changed.proposedBudget.capUnits = "30000000";
    if (kind !== "tampered")
      changed.configurationDigest = digest(providerConfigurationDigestInput(changed));
    vi.spyOn(configuration, "getProviderConfigurationProposal").mockReturnValue(
      kind === "missing" ? null : changed,
    );
    expect(inspect(selected)).toEqual({
      status: "unavailable",
      reason:
        kind === "expired"
          ? "configuration-expired"
          : kind === "changed"
            ? "configuration-changed"
            : "configuration-missing-or-invalid",
      review: null,
    });
  },
);
it("refuses a snapshot from the future instead of moving its inspection time forward", () => {
  const selected = reserve();
  vi.setSystemTime(Date.parse(actualTestNow) - 1);
  expect(inspect(selected)).toEqual({
    status: "unavailable",
    reason: "archive-after-inspection",
    review: null,
  });
});
it.each([
  "evaluation",
  "registration",
  "artifact",
  "binding-hash",
  "missing-binding",
  "coverage-hash",
  "missing-coverage",
  "receipt",
  "schema",
])("blocks whole-database %s damage with no write or partial review", (damage) => {
  const selected = reserve();
  if (damage === "evaluation") {
    store.create({
      clientRequestId: randomUUID(),
      title: "unrelated synthetic evaluation",
      manifestDigest: store.list().manifestDigest,
    });
    corruptFixture("quality_runs_no_update", () =>
      db.prepare("UPDATE quality_runs SET body_hash=?").run("a".repeat(64)),
    );
  } else if (damage === "registration") {
    corruptFixture("quality_candidate_requests_no_update", () =>
      db.prepare("UPDATE quality_candidate_requests SET body_hash=?").run("a".repeat(64)),
    );
  } else if (damage === "artifact") {
    corruptFixture("quality_actual_artifacts_no_update", () =>
      db.prepare("UPDATE quality_actual_artifacts SET payload=?").run(Buffer.from("{}")),
    );
  } else if (damage === "receipt") {
    const nonce = review(selected).reservation.clientRequestId;
    corruptFixture("quality_actual_requests_no_update", () =>
      db
        .prepare("UPDATE quality_actual_requests SET body_hash=? WHERE nonce=?")
        .run("a".repeat(64), nonce),
    );
  } else if (damage === "schema")
    db.exec("CREATE TABLE unexpected_transmission_fixture(value TEXT)");
  else {
    const table = damage.includes("binding")
      ? "quality_provider_reservation_bindings"
      : "quality_provider_reservation_coverage";
    const action = damage.startsWith("missing") ? "delete" : "update";
    corruptFixture(`${table}_no_${action}`, () => {
      if (action === "delete") db.prepare(`DELETE FROM ${table}`).run();
      else db.prepare(`UPDATE ${table} SET body_hash=?`).run("a".repeat(64));
    });
  }
  expect(() => inspect(selected)).toThrowError(expect.objectContaining({ status: 409 }));
});
it("pins all rows and configuration inside one read transaction while another writer attempts commit", () => {
  const selected = reserve(),
    first = review(selected);
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
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec("CREATE TABLE synthetic_writer_probe(value TEXT)");
        expect(() => db.exec("COMMIT")).toThrow(/locked/);
      } finally {
        db.exec("ROLLBACK");
      }
      return original();
    });
  expect(review(selected)).toEqual(first);
  expect(getter).toHaveBeenCalledOnce();
  expect(statements).toEqual(["BEGIN", "COMMIT"]);
  getter.mockRestore();
  adoptReservationTestPolicy(store);
  expect(review(selected).assessment.blockers).toEqual(["policy-superseded"]);
});
it("rolls back a failed read and releases locks for the next independent inspection", () => {
  const selected = reserve(),
    first = review(selected);
  const getter = vi
    .spyOn(configuration, "getProviderConfigurationProposal")
    .mockImplementationOnce(() => {
      throw new Error("Synthetic configuration failure");
    });
  expect(() => inspect(selected)).toThrow("Synthetic configuration failure");
  getter.mockRestore();
  db.exec("BEGIN EXCLUSIVE");
  db.exec("ROLLBACK");
  expect(review(selected)).toEqual(first);
});
