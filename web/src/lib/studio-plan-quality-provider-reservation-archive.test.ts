import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import {
  providerReservationBindingSchema,
  providerReservationCoverageSchema,
  type ProviderReservationBinding,
} from "./studio-plan-quality-provider-reservation-archive-types";
import {
  providerReservationBindingJsonSchema,
  providerReservationCoverageJsonSchema,
} from "../../scripts/local-data-quality-provider-reservation-binding-schema.mjs";
import {
  createProviderReservationMigrationCoverage,
  decodeProviderReservationBindingRows,
  inspectProviderReservationArchive,
  validateProviderReservationBinding,
} from "../../scripts/local-data-quality-provider-reservation-binding.mjs";
import {
  registry,
  config,
  adopt,
  fixture,
  prepared,
  withRows,
  cancel,
  refresh,
  recordedAt,
} from "./studio-plan-quality-provider-reservation-test-helpers";

const omit = (value: object, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
function reseal(record: ProviderReservationBinding) {
  record.approvedReview.policyReview.reviewDigest = digest(
    omit(record.approvedReview.policyReview, "reviewDigest"),
  );
  record.approvedReview.reviewDigest = digest(omit(record.approvedReview, "reviewDigest"));
  record.command.approvedReviewDigest = record.approvedReview.reviewDigest;
  record.commandDigest = digest(record.command);
  record.recordDigest = digest(omit(record, "recordDigest"));
}
function archiveFixture() {
  const input = fixture();
  const coverage = createProviderReservationMigrationCoverage(input.current.ledger);
  input.additionalUsedBytes = Buffer.byteLength(JSON.stringify(coverage));
  const plan = prepared(input);
  withRows(input, plan);
  return { input, plan, ledger: input.current.ledger, coverage, records: [plan.rows.binding] };
}
function secondFixture() {
  const f = archiveFixture();
  cancel(f.input, f.plan);
  f.input.runId = randomUUID();
  refresh(f.input);
  f.input.additionalUsedBytes += f.plan.capacity.bindingBytes;
  const second = prepared(f.input);
  withRows(f.input, second);
  f.records.push(second.rows.binding);
  return f;
}
let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(() => {
    throw new Error("No external calls in archive validation");
  });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("freezes binding and migration coverage shapes independently of future application code", () => {
  expect(providerReservationBindingJsonSchema).toEqual(
    z.toJSONSchema(providerReservationBindingSchema, { reused: "ref" }),
  );
  expect(providerReservationCoverageJsonSchema).toEqual(
    z.toJSONSchema(providerReservationCoverageSchema, { reused: "ref" }),
  );
});
it("validates native policy/budget/request bindings and accounts for coverage bytes without mutating anything", () => {
  const f = archiveFixture(),
    before = structuredClone(f);
  const result = inspectProviderReservationArchive(f);
  expect(f).toEqual(before);
  expect(result.records).toEqual(f.records);
  expect(result.ledger.provider.snapshots[0]).toMatchObject({
    state: "reserved",
    dispatchAllowed: false,
    actualAiCalls: 0,
  });
  expect(result.usedBytes).toBe(
    Buffer.byteLength(JSON.stringify(f.coverage)) + Buffer.byteLength(JSON.stringify(f.records[0])),
  );
  expect(result.records[0].recordDigest).toBe(digest(omit(f.records[0], "recordDigest")));
});
it("keeps historical bindings readable after expiry and subsequent cancellation", () => {
  const f = archiveFixture();
  cancel(f.input, f.plan);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2040-01-01T00:00:00.000Z"));
  expect(inspectProviderReservationArchive(f).records).toEqual(f.records);
  expect(validateProviderReservationBinding(f.records[0], f.ledger)).toEqual(f.records[0]);
});
it("runs in a cold native Node process without importing current TS builders or fetching evidence", () => {
  const f = archiveFixture();
  const url = pathToFileURL(
    resolve("scripts/local-data-quality-provider-reservation-binding.mjs"),
  ).href;
  const script = `import { readFileSync } from 'node:fs';
    import { inspectProviderReservationArchive } from ${JSON.stringify(url)};
    globalThis.fetch = () => { throw new Error('Network forbidden'); };
    Date.now = () => { throw new Error('Current clock forbidden'); };
    const value = inspectProviderReservationArchive(JSON.parse(readFileSync(0, 'utf8')));
    process.stdout.write(value.records[0].recordDigest);`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    input: JSON.stringify({ ledger: f.ledger, records: f.records, coverage: f.coverage }),
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, OPENAI_API_KEY: "synthetic-unused" },
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(f.records[0].recordDigest);
});
it.each([
  "run-id",
  "run-digest",
  "native-input",
  "nonce",
  "recorded-time",
  "approval-time",
  "candidate",
  "version",
  "budget-head",
  "global-count",
  "scope-count",
  "financial-digest",
  "usage-digest",
  "retention-digest",
  "request-digest",
  "configuration-digest",
  "available-budget",
  "reservation-units",
  "scope-label",
  "expiry",
])("rejects a rehashed inconsistent %s", (change) => {
  const f = archiveFixture(),
    r = f.records[0],
    c = r.command,
    p = r.approvedReview.policyReview;
  if (change === "run-id") r.runId = randomUUID();
  if (change === "run-digest") r.runDigest = "a".repeat(64);
  if (change === "native-input") r.startInputDigest = "a".repeat(64);
  if (change === "nonce") {
    c.clientRequestId = randomUUID();
    r.clientRequestId = c.clientRequestId;
  }
  if (change === "recorded-time") r.recordedAt = "2026-09-27T03:33:00.000Z";
  if (change === "approval-time") c.approval.approvedAt = "2026-09-27T03:00:00.000Z";
  if (change === "candidate") c.candidateId = registry.entries[1].candidateId;
  if (change === "version") c.version = 2;
  if (change === "budget-head") {
    c.expectedBudgetHead.revision++;
    p.budget.revision++;
  }
  if (change === "global-count") {
    c.expectedGlobalRunCount++;
    r.approvedReview.runs.globalCount++;
  }
  if (change === "scope-count") {
    c.expectedGlobalRunCount++;
    c.expectedProductionRunCount++;
    r.approvedReview.runs.globalCount++;
    r.approvedReview.runs.productionCount++;
  }
  if (change === "financial-digest") p.bindings.financialBasisDigest = "a".repeat(64);
  if (change === "usage-digest") p.bindings.usagePolicyDigest = "a".repeat(64);
  if (change === "retention-digest") p.bindings.retentionDigest = "a".repeat(64);
  if (change === "request-digest") p.bindings.requestReviewDigest = "a".repeat(64);
  if (change === "configuration-digest") p.bindings.configurationDigest = "a".repeat(64);
  if (change === "available-budget") p.budget.availableUnits = "999999999";
  if (change === "reservation-units") p.reservation.totalUnits = "1";
  if (change === "scope-label") p.scope.label = "변경한 후보";
  if (change === "expiry") p.expiresAt = "2026-09-27T03:44:00.000Z";
  reseal(r);
  expect(() => inspectProviderReservationArchive(f)).toThrow(
    "PROVIDER_RESERVATION_ARCHIVE_INVALID",
  );
});
it.each(["grant", "acknowledgement", "review-grant", "blocked", "unknown-field", "digest"])(
  "rejects invalid %s shape or proof",
  (change) => {
    const f = archiveFixture(),
      r = JSON.parse(JSON.stringify(f.records[0]));
    if (change === "grant") r.dispatchAllowed = true;
    if (change === "acknowledgement") r.command.approval.acknowledgedCandidate = false;
    if (change === "review-grant") r.approvedReview.actions.reservationAllowed = true;
    if (change === "blocked")
      r.approvedReview.assessment = { state: "blocked", blockers: ["policy-changed"] };
    if (change === "unknown-field") r.approvedReview.nextActionAllowed = true;
    reseal(r);
    if (change === "digest") r.recordDigest = "a".repeat(64);
    expect(() => validateProviderReservationBinding(r, f.ledger)).toThrow(
      "PROVIDER_RESERVATION_ARCHIVE_INVALID",
    );
  },
);
it("rejects fallback to an older matching adoption within the recorded policy head", () => {
  const input = fixture();
  adopt(input.current.ledger);
  refresh(input);
  const plan = prepared(input);
  withRows(input, plan);
  const first = input.current.ledger.policies![0] as {
    revision: number;
    recordDigest: string;
    clientRequestId: string;
    recordedAt: string;
  };
  const r = plan.rows.binding;
  r.command.expectedPolicyReference = {
    revision: first.revision,
    recordDigest: first.recordDigest,
    clientRequestId: first.clientRequestId,
    recordedAt: first.recordedAt,
  };
  r.approvedReview.policy = { state: "matched", reference: r.command.expectedPolicyReference };
  reseal(r);
  expect(() => validateProviderReservationBinding(r, input.current.ledger)).toThrow(
    "PROVIDER_RESERVATION_ARCHIVE_INVALID",
  );
});
it("uses budget ordering to reject an omitted policy even when adoption and reservation have equal timestamps", () => {
  const input = fixture();
  adopt(input.current.ledger, 1, config(), recordedAt);
  refresh(input);
  const plan = prepared(input);
  withRows(input, plan);
  const r = plan.rows.binding;
  r.command.expectedPolicyHead = {
    revision: 1,
    headDigest: r.command.expectedPolicyReference.recordDigest,
  };
  r.approvedReview.policyHead = r.command.expectedPolicyHead;
  reseal(r);
  expect(() => validateProviderReservationBinding(r, input.current.ledger)).toThrow(
    "PROVIDER_RESERVATION_ARCHIVE_INVALID",
  );
});
it("preserves an older binding after a later same-timestamp adoption that observes its reservation", () => {
  const f = archiveFixture();
  adopt(f.ledger, 0, config(), recordedAt);
  expect(inspectProviderReservationArchive(f).records).toEqual(f.records);
});
it("supports an explicit legacy production prefix followed by a required new binding", () => {
  const f = archiveFixture();
  const coverage = createProviderReservationMigrationCoverage(f.ledger);
  expect(coverage.legacyProductionRuns).toEqual([
    { runId: f.plan.rows.run.id, runDigest: f.plan.rows.run.runDigest },
  ]);
  expect(
    inspectProviderReservationArchive({ ledger: f.ledger, coverage, records: [] }).records,
  ).toEqual([]);
  cancel(f.input, f.plan);
  f.input.runId = randomUUID();
  refresh(f.input);
  const next = prepared(f.input);
  withRows(f.input, next);
  expect(
    inspectProviderReservationArchive({ ledger: f.ledger, coverage, records: [next.rows.binding] })
      .records,
  ).toHaveLength(1);
  expect(() =>
    inspectProviderReservationArchive({ ledger: f.ledger, coverage, records: [] }),
  ).toThrow("PROVIDER_RESERVATION_ARCHIVE_INVALID");
});
it.each(["missing", "duplicate", "orphan", "reordered"])(
  "rejects %s bindings with intact native records",
  (change) => {
    const f = secondFixture();
    if (change === "missing") f.records.pop();
    if (change === "duplicate") f.records[1] = structuredClone(f.records[0]);
    if (change === "orphan") {
      f.records[1].runId = randomUUID();
      reseal(f.records[1]);
    }
    if (change === "reordered") f.records.reverse();
    expect(() => inspectProviderReservationArchive(f)).toThrow(
      "PROVIDER_RESERVATION_ARCHIVE_INVALID",
    );
  },
);
it.each([
  "missing",
  "head",
  "prefix",
  "legacy-addition",
  "legacy-deletion",
  "legacy-digest",
  "extra",
])("rejects altered migration %s", (change) => {
  const f = archiveFixture(),
    coverage = JSON.parse(JSON.stringify(createProviderReservationMigrationCoverage(f.ledger)));
  if (change === "head") coverage.cutoverGlobalRunCount = 2;
  if (change === "prefix") coverage.cutoverRunPrefixDigest = "a".repeat(64);
  if (change === "legacy-addition")
    coverage.legacyProductionRuns.push({ runId: randomUUID(), runDigest: "a".repeat(64) });
  if (change === "legacy-deletion") coverage.legacyProductionRuns = [];
  if (change === "legacy-digest") coverage.legacyProductionRuns[0].runDigest = "a".repeat(64);
  if (change === "extra") coverage.allowUnbound = true;
  coverage.coverageDigest = digest(omit(coverage, "coverageDigest"));
  expect(() =>
    inspectProviderReservationArchive({
      ledger: f.ledger,
      coverage: change === "missing" ? undefined : coverage,
      records: [],
    }),
  ).toThrow("PROVIDER_RESERVATION_ARCHIVE_INVALID");
});
it("does not allow a legacy record to also claim a new binding", () => {
  const f = archiveFixture();
  f.coverage = createProviderReservationMigrationCoverage(f.ledger);
  expect(() => inspectProviderReservationArchive(f)).toThrow(
    "PROVIDER_RESERVATION_ARCHIVE_INVALID",
  );
});
it("still detects unrelated native corruption when the binding itself is intact", () => {
  const f = archiveFixture();
  f.ledger.receipts[0] = {};
  expect(() => inspectProviderReservationArchive(f)).toThrow(
    "PROVIDER_RESERVATION_ARCHIVE_INVALID",
  );
});
it("decodes immutable raw rows and includes their original whitespace in storage accounting", () => {
  const f = archiveFixture(),
    r = f.records[0],
    body = JSON.stringify(r, null, 2);
  const result = decodeProviderReservationBindingRows([
    { storage_order: 3, run_id: r.runId, nonce: r.clientRequestId, body, body_hash: digest(r) },
  ]);
  expect(result.records).toEqual([r]);
  expect(result.usedBytes).toBe(Buffer.byteLength(body));
});
it.each(["run", "nonce", "hash", "order", "order-repeated", "oversize", "malformed"])(
  "rejects raw row %s corruption",
  (change) => {
    const f = archiveFixture(),
      r = f.records[0];
    const row = {
      storage_order: 1,
      run_id: r.runId,
      nonce: r.clientRequestId,
      body: JSON.stringify(r),
      body_hash: digest(r),
    };
    if (change === "run") row.run_id = randomUUID();
    if (change === "nonce") row.nonce = randomUUID();
    if (change === "hash") row.body_hash = "a".repeat(64);
    if (change === "order") row.storage_order = 0;
    if (change === "oversize") row.body += " ".repeat(65536);
    if (change === "malformed") row.body = "{";
    expect(() =>
      decodeProviderReservationBindingRows(change === "order-repeated" ? [row, row] : [row]),
    ).toThrow("PROVIDER_RESERVATION_ARCHIVE_INVALID");
  },
);
