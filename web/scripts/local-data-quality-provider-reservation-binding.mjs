import { z } from "zod";
import {
  providerReservationBindingJsonSchema,
  providerReservationCoverageJsonSchema,
} from "./local-data-quality-provider-reservation-binding-schema.mjs";
import { inspectQualityLedgers } from "./local-data-quality-ledgers.mjs";
import {
  providerDigest as digest,
  validateProviderBudgetLedger,
} from "./local-data-quality-provider.mjs";

// Frozen v1 archive: do not import application builders, current configuration or a wall clock.
export const providerReservationArchiveLimits = {
  records: 20,
  recordBytes: 64 * 1024,
  coverageBytes: 8192,
  totalBytes: 256 * 1024 * 1024,
};
const recordSchema = z.fromJSONSchema(providerReservationBindingJsonSchema);
const versionedRecordSchema = z.fromJSONSchema({
  ...providerReservationBindingJsonSchema,
  properties: {
    ...providerReservationBindingJsonSchema.properties,
    recordVersion: { type: "number", const: 2 },
  },
});
const parseRecord = (raw, versioned) =>
  (versioned && raw?.recordVersion === 2 ? versionedRecordSchema : recordSchema).parse(raw);
const coverageSchema = z.fromJSONSchema(providerReservationCoverageJsonSchema);
const liveScope = "candidate-quality-provider-v2-live";
const same = (a, b) => digest(a) === digest(b);
const omit = (value, key) => Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const invalid = () => {
  throw new Error("PROVIDER_RESERVATION_ARCHIVE_INVALID");
};
const isProduction = (run) => run.schemaVersion === 2 && run.environment === "production";
const runIdentity = (run) => ({
  id: run.id,
  schemaVersion: run.schemaVersion,
  runDigest: run.runDigest,
});

/** Shape and indexed raw-row checks only; callers must follow with the complete archive audit. */
export function decodeProviderReservationBindingRows(rows) {
  return decodeRows(rows, false);
}
export function decodeVersionedProviderReservationBindingRows(rows) {
  return decodeRows(rows, true);
}
function decodeRows(rows, versioned) {
  try {
    if (!Array.isArray(rows) || rows.length > providerReservationArchiveLimits.records) invalid();
    let lastOrder = 0,
      usedBytes = 0;
    const records = rows.map((row) => {
      if (
        typeof row.body !== "string" ||
        Buffer.byteLength(row.body) > providerReservationArchiveLimits.recordBytes ||
        !Number.isSafeInteger(row.storage_order) ||
        row.storage_order <= lastOrder
      )
        invalid();
      lastOrder = row.storage_order;
      const value = parseRecord(JSON.parse(row.body), versioned);
      if (
        row.run_id !== value.runId ||
        row.nonce !== value.clientRequestId ||
        row.body_hash !== digest(value)
      )
        invalid();
      usedBytes += Buffer.byteLength(row.body);
      return value;
    });
    return { records, usedBytes };
  } catch {
    return invalid();
  }
}

function inspectRecord(raw, ledger, state, versioned = false) {
  if (bytes(raw) > providerReservationArchiveLimits.recordBytes) invalid();
  const record = parseRecord(raw, versioned),
    c = record.command,
    r = record.approvedReview,
    review = r.policyReview;
  const run = state.provider.runs.find((row) => row.id === record.runId);
  if (!run || !isProduction(run)) invalid();
  if (
    record.recordVersion === 1
      ? run.archiveFormatVersion !== 2
      : run.archiveFormatVersion !== 3 ||
        run.preparation.contract.baseContract.engineVersion !== "plan-observation-v2"
  )
    invalid();
  const prep = run.preparation,
    f = prep.financialBasis;
  const inspected = Date.parse(review.inspectedAt),
    recorded = Date.parse(record.recordedAt),
    approved = Date.parse(c.approval.approvedAt),
    expires = Date.parse(review.expiresAt);
  const policies = state.policy.records.slice(0, c.expectedPolicyHead.revision);
  const policy = policies.findLast(
    (row) => row.command.version === c.version && row.command.candidateId === c.candidateId,
  );
  if (
    !policy ||
    policies.length !== c.expectedPolicyHead.revision ||
    c.expectedPolicyHead.headDigest !== policies.at(-1).recordDigest ||
    !same(c.expectedPolicyReference, {
      revision: policy.revision,
      recordDigest: policy.recordDigest,
      clientRequestId: policy.clientRequestId,
      recordedAt: policy.recordedAt,
    }) ||
    !same(c.expectedPolicyHead, r.policyHead) ||
    !same(c.expectedPolicyReference, r.policy.reference) ||
    r.policy.state !== "matched" ||
    !same(r.assessment, { state: "conditions-met", blockers: [] }) ||
    !same(r.runs, {
      globalCount: c.expectedGlobalRunCount,
      productionCount: c.expectedProductionRunCount,
      unsettledCandidateRunIds: [],
    }) ||
    record.recordDigest !== digest(omit(record, "recordDigest")) ||
    record.commandDigest !== digest(c) ||
    record.clientRequestId !== c.clientRequestId ||
    run.clientRequestId !== c.clientRequestId ||
    record.runDigest !== run.runDigest ||
    record.startInputDigest !== run.inputDigest ||
    record.recordedAt !== run.recordedAt ||
    c.approvedReviewDigest !== r.reviewDigest ||
    r.reviewDigest !== digest(omit(r, "reviewDigest")) ||
    review.reviewDigest !== digest(omit(review, "reviewDigest")) ||
    c.expectedLedgerDigest !== r.ledgerDigest ||
    c.version !== prep.scope.version ||
    c.versionDigest !== prep.scope.versionDigest ||
    c.candidateId !== prep.scope.candidateId ||
    c.expectedGlobalRunCount !== run.expectedGlobalRunCount ||
    c.expectedProductionRunCount !== run.expectedScopeRunCount ||
    !same(c.expectedBudgetHead, {
      revision: run.expectedBudgetRevision,
      headDigest: run.expectedBudgetDigest,
    }) ||
    prep.preparedAt !== review.inspectedAt ||
    prep.expiresAt !== review.expiresAt ||
    !same(run.approval, {
      provenance: "explicit-user",
      approvedPreparationDigest: prep.preparationDigest,
      approvedAt: c.approval.approvedAt,
      expiresAt: review.expiresAt,
      acknowledgedReservationOnly: true,
      acknowledgedFinancialBasisNotTokenFit: true,
      acknowledgedRetention: true,
      acknowledgedNoAutomaticRetry: true,
    }) ||
    !(inspected <= approved && approved <= recorded && recorded < expires)
  )
    invalid();

  const v = policy.reviewedProposal,
    p = v.proposal;
  const request = {
    scope: prep.scope,
    model: prep.model,
    contract: prep.contract,
    generation: prep.generation,
    reviewTemplate: prep.reviewTemplate,
  };
  // Only calculatedAt changes between adoption and reservation; all financial evidence and exact
  // request bytes remain the adopted scope. Usage policy binds the reservation's financial digest.
  if (
    !same(review.scope, v.scope) ||
    !same(request, p.requestReview) ||
    !same(omit(f, "calculatedAt"), omit(v.financialBasis, "calculatedAt")) ||
    !same(prep.retention, v.retention) ||
    !same(review.proposedBudget, p.proposedBudget) ||
    !same(review.bindings, {
      configurationDigest: p.configurationDigest,
      requestReviewDigest: digest(request),
      financialBasisDigest: digest(f),
      retentionDigest: digest(prep.retention),
      usagePolicyDigest: digest({ ...p.usagePolicy, financialBasisDigest: digest(f) }),
      model: prep.model,
    }) ||
    !same(review.reservation, {
      generationUnits: f.costs.generation.totalUnits,
      reviewUnits: f.costs.review.totalUnits,
      totalUnits: f.costs.totalUnits,
    }) ||
    expires !==
      Math.min(inspected + 15 * 60 * 1000, ...p.sources.map((s) => Date.parse(s.validUntil))) ||
    p.sources.some(
      (s) => Date.parse(s.reviewedAt) > inspected || Date.parse(s.validUntil) <= recorded,
    ) ||
    policies.some(
      (row) =>
        Date.parse(row.recordedAt) > inspected ||
        row.budgetTransition.after.revision > c.expectedBudgetHead.revision,
    ) ||
    state.policy.records
      .slice(policies.length)
      .some(
        (row) =>
          Date.parse(row.recordedAt) < recorded ||
          row.budgetTransition.before.revision < run.reservedBudgetRevision,
      )
  )
    invalid();

  const events = state.provider.budgetEvents.filter((row) => row.scopeId === liveScope);
  const prefix = events.slice(0, c.expectedBudgetHead.revision);
  const b = validateProviderBudgetLedger(prefix, liveScope);
  if (
    !same(review.budget, {
      scopeId: liveScope,
      revision: b.revision,
      headDigest: b.headDigest,
      currency: b.currency,
      unitScale: b.unitScale,
      capUnits: b.capUnits,
      heldUnits: b.heldUnits,
      recognizedUnits: b.recognizedUnits,
      availableUnits: b.availableUnits,
      deficitUnits: b.deficitUnits ?? "0",
      boundBreached: b.boundBreached ?? false,
    }) ||
    !same(c.expectedBudgetHead, { revision: b.revision, headDigest: b.headDigest }) ||
    b.boundBreached ||
    BigInt(b.availableUnits) < BigInt(f.costs.totalUnits) ||
    !same(review.assessment, {
      state: "budget-configured",
      basis: "existing-budget",
      availableBeforeReservationUnits: b.availableUnits,
      availableAfterReservationUnits: (
        BigInt(b.availableUnits) - BigInt(f.costs.totalUnits)
      ).toString(),
      shortfallUnits: "0",
    }) ||
    prefix.some((row) => Date.parse(row.recordedAt) > inspected)
  )
    invalid();
  const runIndex = ledger.runs.findIndex((row) => row.id === run.id);
  const previousRuns = ledger.runs.slice(0, runIndex);
  if (
    runIndex !== c.expectedGlobalRunCount ||
    previousRuns.filter(isProduction).length !== c.expectedProductionRunCount ||
    previousRuns.some((row) => Date.parse(row.recordedAt) > inspected) ||
    ledger.runs.slice(runIndex + 1).some((row) => Date.parse(row.recordedAt) < recorded)
  )
    invalid();
  // Native full-ledger validation above has already bound the start receipt, reserve event, exact
  // artifact, preparation, historical budget, and prior same-candidate settlement to this run.
  return record;
}

/** Complete native-ledger audit plus one binding. Does not establish coverage of the other runs. */
export function validateProviderReservationBinding(raw, ledger) {
  return validateBinding(raw, ledger, false);
}
export function validateVersionedProviderReservationBinding(raw, ledger) {
  return validateBinding(raw, ledger, true);
}
function validateBinding(raw, ledger, versioned) {
  try {
    return inspectRecord(raw, ledger, inspectQualityLedgers(ledger), versioned);
  } catch {
    return invalid();
  }
}

/** Migration-only pure constructor. A store must never call this again on a current-schema database. */
export function createProviderReservationMigrationCoverage(ledger) {
  try {
    inspectQualityLedgers(ledger);
    // Format3 did not exist at the immutable migration boundary.
    if (ledger.runs.some((run) => run.schemaVersion === 2 && run.archiveFormatVersion !== 2))
      invalid();
    const body = {
      coverageVersion: 1,
      kind: "provider-reservation-binding-coverage",
      cutoverGlobalRunCount: ledger.runs.length,
      cutoverRunPrefixDigest: digest(ledger.runs.map(runIdentity)),
      legacyProductionRuns: ledger.runs
        .filter(isProduction)
        .map((run) => ({ runId: run.id, runDigest: run.runDigest })),
    };
    return coverageSchema.parse({ ...body, coverageDigest: digest(body) });
  } catch {
    return invalid();
  }
}

/** All bindings and the immutable migration boundary, in native insertion order. Pure inspection;
 * parent storage/backup readers must also audit schema, raw bytes and registration/evaluation rows. */
export function inspectProviderReservationArchive(input) {
  return inspectArchive(input, false);
}
export function inspectVersionedProviderReservationArchive(input) {
  return inspectArchive(input, true);
}
function inspectArchive({ ledger, coverage: rawCoverage, records: rawRecords }, versioned) {
  try {
    const state = inspectQualityLedgers(ledger);
    if (
      !Array.isArray(rawRecords) ||
      rawRecords.length > providerReservationArchiveLimits.records ||
      bytes(rawCoverage) > providerReservationArchiveLimits.coverageBytes
    )
      invalid();
    const coverage = coverageSchema.parse(rawCoverage),
      count = coverage.cutoverGlobalRunCount;
    const prefix = ledger.runs.slice(0, count);
    if (
      count > ledger.runs.length ||
      prefix.some((run) => run.schemaVersion === 2 && run.archiveFormatVersion !== 2) ||
      coverage.coverageDigest !== digest(omit(coverage, "coverageDigest")) ||
      coverage.cutoverRunPrefixDigest !== digest(prefix.map(runIdentity)) ||
      !same(
        coverage.legacyProductionRuns,
        prefix.filter(isProduction).map((run) => ({ runId: run.id, runDigest: run.runDigest })),
      )
    )
      invalid();
    const expected = ledger.runs.slice(count).filter(isProduction);
    if (expected.length !== rawRecords.length) invalid();
    const records = rawRecords.map((raw, index) => {
      const record = inspectRecord(raw, ledger, state, versioned);
      if (record.runId !== expected[index].id) invalid();
      return record;
    });
    const usedBytes = bytes(coverage) + records.reduce((sum, record) => sum + bytes(record), 0);
    if (
      state.usedBytes + state.reservedBytes + usedBytes >
      providerReservationArchiveLimits.totalBytes
    )
      invalid();
    return { records, coverage, usedBytes, ledger: state };
  } catch {
    return invalid();
  }
}
