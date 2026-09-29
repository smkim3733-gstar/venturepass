import { z } from "zod";
import {
  providerTransmissionApprovalBindingJsonSchema,
  providerTransmissionApprovalCoverageJsonSchema,
} from "./local-data-quality-provider-transmission-binding-schema.mjs";
import { inspectProviderReservationArchive } from "./local-data-quality-provider-reservation-binding.mjs";
import {
  providerDigest as digest,
  validateProviderRunLedger,
} from "./local-data-quality-provider.mjs";
import {
  getProviderExecutionBudgetSnapshot,
  validateProviderExecutionManifest,
  providerExecutionOperationDigest,
} from "./local-data-quality-provider-execution.mjs";

// Frozen v1 historical reader. No application builder, current configuration, wall clock or IO.
export const providerTransmissionApprovalArchiveLimits = {
  records: 20,
  recordBytes: 128 * 1024,
  coverageBytes: 16 * 1024,
  totalBytes: 256 * 1024 * 1024,
};
const recordSchema = z.fromJSONSchema(providerTransmissionApprovalBindingJsonSchema);
const coverageSchema = z.fromJSONSchema(providerTransmissionApprovalCoverageJsonSchema);
const liveScope = "candidate-quality-provider-v2-live";
const same = (a, b) => digest(a) === digest(b);
const omit = (v, key) => Object.fromEntries(Object.entries(v).filter(([k]) => k !== key));
const bytes = (v) => Buffer.byteLength(JSON.stringify(v), "utf8");
const invalid = () => {
  throw new Error("PROVIDER_TRANSMISSION_APPROVAL_ARCHIVE_INVALID");
};
const production = (run) => run.schemaVersion === 2 && run.environment === "production";
const identity = (run) => ({
  id: run.id,
  schemaVersion: run.schemaVersion,
  runDigest: run.runDigest,
});
const reference = (p) => ({
  revision: p.revision,
  recordDigest: p.recordDigest,
  clientRequestId: p.clientRequestId,
  recordedAt: p.recordedAt,
});
const approvals = (events) =>
  events.filter(
    (e) => e.executionContractVersion === 1 && e.payload.kind === "transmission-approved",
  );

/** Indexed row/shape checks only. Complete archive inspection is still mandatory. */
export function decodeProviderTransmissionApprovalBindingRows(rows) {
  try {
    if (!Array.isArray(rows) || rows.length > providerTransmissionApprovalArchiveLimits.records)
      invalid();
    let lastOrder = 0,
      usedBytes = 0;
    const records = rows.map((row) => {
      if (
        typeof row.body !== "string" ||
        Buffer.byteLength(row.body) > providerTransmissionApprovalArchiveLimits.recordBytes ||
        !Number.isSafeInteger(row.storage_order) ||
        row.storage_order <= lastOrder
      )
        invalid();
      lastOrder = row.storage_order;
      const record = recordSchema.parse(JSON.parse(row.body));
      if (
        row.run_id !== record.runId ||
        row.nonce !== record.clientRequestId ||
        row.body_hash !== digest(record)
      )
        invalid();
      usedBytes += Buffer.byteLength(row.body);
      return record;
    });
    return { records, usedBytes };
  } catch {
    return invalid();
  }
}

function inspectRecord(raw, archive, inspected) {
  if (bytes(raw) > providerTransmissionApprovalArchiveLimits.recordBytes) invalid();
  const record = recordSchema.parse(raw),
    c = record.command,
    r = record.approvedReview;
  const state = inspected.ledger;
  const run = state.provider.runs.find((v) => v.id === record.runId);
  const binding = inspected.records.find((v) => v.runId === record.runId);
  if (!run || !production(run) || !binding) invalid();
  const prep = run.preparation;
  const event = state.provider.events.find((v) => v.runId === run.id && v.revision === 1);
  const receipt = state.provider.receipts.find((v) => v.clientRequestId === record.clientRequestId);
  if (
    !event ||
    event.payload.kind !== "transmission-approved" ||
    !receipt ||
    receipt.kind !== "provider-approve"
  )
    invalid();
  const p = event.payload;
  const policies = state.policy.records.slice(0, c.expectedPolicyHead.revision);
  const policy = policies.findLast(
    (v) =>
      v.command.version === prep.scope.version && v.command.candidateId === prep.scope.candidateId,
  );
  if (!policy || policies.length !== c.expectedPolicyHead.revision) invalid();
  const policyRef = reference(policy);
  const budgetEvents = state.provider.budgetEvents.filter((v) => v.scopeId === liveScope);
  const prefix = budgetEvents.slice(0, c.expectedBudgetHead.revision);
  const b = getProviderExecutionBudgetSnapshot(prefix, liveScope);
  const held = b.reservations.find((v) => v.runId === run.id);
  const generation = held?.phases.find((v) => v.phase === "generation"),
    review = held?.phases.find((v) => v.phase === "review");
  if (!held || !generation || !review) invalid();
  const start = validateProviderRunLedger({
    run,
    events: [],
    artifacts: state.provider.artifacts.filter(
      (v) => v.runId === run.id && v.key === "generation-request",
    ),
    budgetEvents: budgetEvents.slice(0, run.reservedBudgetRevision),
    receipts: state.provider.receipts.filter(
      (v) => v.runId === run.id && v.kind === "provider-start",
    ),
    registry: archive.ledger.registries.find((v) => v.version === prep.scope.version),
  });
  validateProviderExecutionManifest(run, r.manifest);
  const inspectedAt = Date.parse(r.inspectedAt),
    approvedAt = Date.parse(c.approval.approvedAt),
    recordedAt = Date.parse(record.recordedAt),
    expiresAt = Date.parse(r.expiresAt);
  const proposal = policy.reviewedProposal.proposal;
  const request = {
    scope: prep.scope,
    model: prep.model,
    contract: prep.contract,
    generation: prep.generation,
    reviewTemplate: prep.reviewTemplate,
  };
  if (
    record.recordDigest !== digest(omit(record, "recordDigest")) ||
    record.commandDigest !== digest(c) ||
    record.clientRequestId !== c.clientRequestId ||
    record.runDigest !== run.runDigest ||
    c.runId !== run.id ||
    c.runDigest !== run.runDigest ||
    record.executionInputDigest !== receipt.inputDigest ||
    record.approvalEventDigest !== event.eventDigest ||
    record.recordedAt !== event.recordedAt ||
    record.recordedAt !== receipt.recordedAt ||
    receipt.runId !== run.id ||
    receipt.runRevision !== 1 ||
    receipt.operationDigest !== event.eventDigest ||
    c.approvedReviewDigest !== r.reviewDigest ||
    r.reviewDigest !== digest(omit(r, "reviewDigest")) ||
    c.expectedArchiveDigest !== r.archiveDigest ||
    c.expectedCoverageDigest !== r.coverageDigest ||
    r.coverageDigest !== inspected.coverage.coverageDigest ||
    c.expectedReservationBindingDigest !== binding.recordDigest ||
    c.expectedManifestDigest !== r.manifest.manifestDigest ||
    !same(c.expectedRun, { revision: 0, snapshotDigest: start.snapshotDigest }) ||
    !same(r.run, {
      id: run.id,
      runDigest: run.runDigest,
      preparationDigest: prep.preparationDigest,
      recordedAt: run.recordedAt,
      preparedAt: prep.preparedAt,
      preparationExpiresAt: prep.expiresAt,
      revision: 0,
      archiveFormatVersion: 2,
      state: "reserved",
      snapshotDigest: start.snapshotDigest,
    }) ||
    !same(c.expectedPolicyHead, {
      revision: policies.length,
      headDigest: policies.at(-1).recordDigest,
    }) ||
    !same(c.expectedPolicyReference, policyRef) ||
    !same(policyRef, binding.command.expectedPolicyReference) ||
    !same(r.policy, {
      head: c.expectedPolicyHead,
      currentReference: policyRef,
      reservedReference: policyRef,
    }) ||
    !same(c.expectedBudgetHead, { revision: b.revision, headDigest: b.headDigest }) ||
    !same(r.budget, {
      scopeId: liveScope,
      revision: b.revision,
      headDigest: b.headDigest,
      currency: b.currency,
      unitScale: b.unitScale,
      capUnits: b.capUnits,
      heldUnits: b.heldUnits,
      recognizedUnits: b.recognizedUnits,
      availableUnits: b.availableUnits,
      deficitUnits: b.deficitUnits,
      boundBreached: b.boundBreached,
    }) ||
    !same(r.reservation, {
      bindingDigest: binding.recordDigest,
      clientRequestId: binding.clientRequestId,
      approvedReviewDigest: binding.command.approvedReviewDigest,
      reservationDigest: run.reservationDigest,
      generationUnits: prep.financialBasis.costs.generation.totalUnits,
      reviewUnits: prep.financialBasis.costs.review.totalUnits,
      totalUnits: prep.financialBasis.costs.totalUnits,
      heldUnits: held.heldUnits,
      generationHeldUnits: generation.heldUnits,
      reviewHeldUnits: review.heldUnits,
      generationSettled: generation.settled,
      reviewSettled: review.settled,
    }) ||
    generation.settled ||
    review.settled ||
    generation.heldUnits !== prep.financialBasis.costs.generation.totalUnits ||
    review.heldUnits !== prep.financialBasis.costs.review.totalUnits ||
    b.boundBreached ||
    b.deficitUnits !== "0" ||
    b.currency !== prep.financialBasis.costs.currency ||
    b.unitScale !== prep.financialBasis.costs.unitScale ||
    !same(r.facts, {
      policyUnchanged: true,
      runUntouched: true,
      reservationIntact: true,
      budgetCompatible: true,
      budgetWithinBound: true,
    }) ||
    !same(r.assessment, { state: "conditions-met", blockers: [] }) ||
    !same(r.scope, binding.approvedReview.policyReview.scope) ||
    !same(r.request, request) ||
    !same(r.financialBasis, prep.financialBasis) ||
    !same(r.retention, prep.retention) ||
    r.configurationDigest !== proposal.configurationDigest ||
    r.configurationDigest !== binding.approvedReview.policyReview.bindings.configurationDigest ||
    digest(r.manifest.executionContract.usagePolicy) !==
      binding.approvedReview.policyReview.bindings.usagePolicyDigest ||
    c.approval.acknowledgedRetentionNoticeDigest !== digest(prep.retention) ||
    !same(p, {
      kind: "transmission-approved",
      manifest: r.manifest,
      provenance: "explicit-user",
      approvedAt: c.approval.approvedAt,
      expiresAt: r.expiresAt,
      acknowledgedExternalTransmission: true,
      acknowledgedGenerationAndDerivedReview: true,
      acknowledgedRetentionNoticeDigest: digest(prep.retention),
      acknowledgedFinancialReservationNotTokenFit: true,
      acknowledgedUnknownCostHoldAndNoRetry: true,
      budgetRevision: b.revision,
      budgetDigest: b.headDigest,
    }) ||
    receipt.inputDigest !==
      providerExecutionOperationDigest(run.id, {
        clientRequestId: c.clientRequestId,
        expectedRevision: 0,
        payload: p,
      }) ||
    !(
      Date.parse(run.recordedAt) <= inspectedAt &&
      inspectedAt <= approvedAt &&
      approvedAt <= recordedAt &&
      recordedAt < expiresAt
    ) ||
    expiresAt !==
      Math.min(
        inspectedAt + 15 * 60 * 1000,
        Date.parse(prep.expiresAt),
        ...proposal.sources.map((v) => Date.parse(v.validUntil)),
      ) ||
    proposal.sources.some(
      (v) => Date.parse(v.reviewedAt) > inspectedAt || Date.parse(v.validUntil) <= recordedAt,
    ) ||
    policies.some(
      (v) =>
        Date.parse(v.recordedAt) > inspectedAt || v.budgetTransition.after.revision > b.revision,
    ) ||
    prefix.some((v) => Date.parse(v.recordedAt) > inspectedAt) ||
    budgetEvents.slice(prefix.length).some((v) => Date.parse(v.recordedAt) < recordedAt) ||
    state.policy.records
      .slice(policies.length)
      .some(
        (v) =>
          Date.parse(v.recordedAt) < recordedAt || v.budgetTransition.before.revision < b.revision,
      )
  )
    invalid();
  // archiveDigest is the writer's historical full-snapshot CAS fingerprint, not reconstructable
  // from today's unrelated registries/nonces/rows and not a cryptographic provenance signature.
  return record;
}

/** Complete v8 audit + one binding, NOT coverage of all transmission approvals. */
export function validateProviderTransmissionApprovalBinding(raw, archive) {
  try {
    return inspectRecord(raw, archive, inspectProviderReservationArchive(archive));
  } catch {
    return invalid();
  }
}

function approvalIdentity(event, state) {
  const receipt = state.provider.receipts.find(
    (v) => v.runId === event.runId && v.kind === "provider-approve",
  );
  if (!receipt) invalid();
  return {
    runId: event.runId,
    approvalEventDigest: event.eventDigest,
    clientRequestId: receipt.clientRequestId,
    executionInputDigest: receipt.inputDigest,
  };
}
function eventBoundary(runs, state, counts) {
  const prefixes = [],
    legacy = [];
  for (const [index, run] of runs.filter((v) => v.schemaVersion === 2).entries()) {
    const events = state.provider.events.filter((v) => v.runId === run.id);
    const count = counts ? counts[index]?.eventCount : events.length;
    if (!Number.isSafeInteger(count) || count < 0 || count > events.length) invalid();
    const prefix = events.slice(0, count);
    prefixes.push({
      runId: run.id,
      runDigest: run.runDigest,
      eventCount: count,
      eventPrefixDigest: digest(prefix),
    });
    if (production(run)) legacy.push(...approvals(prefix).map((e) => approvalIdentity(e, state)));
  }
  return { prefixes, legacy };
}

/** Migration-only. Never regenerate missing coverage on a current-schema database. */
export function createProviderTransmissionApprovalMigrationCoverage(archive) {
  try {
    const inspected = inspectProviderReservationArchive(archive);
    const boundary = eventBoundary(archive.ledger.runs, inspected.ledger);
    const body = {
      coverageVersion: 1,
      kind: "provider-transmission-approval-coverage",
      cutoverGlobalRunCount: archive.ledger.runs.length,
      cutoverRunPrefixDigest: digest(archive.ledger.runs.map(identity)),
      cutoverProviderEvents: boundary.prefixes,
      legacyProductionApprovals: boundary.legacy,
    };
    const value = coverageSchema.parse({ ...body, coverageDigest: digest(body) });
    if (bytes(value) > providerTransmissionApprovalArchiveLimits.coverageBytes) invalid();
    return value;
  } catch {
    return invalid();
  }
}

/** All production first approvals need either an exact cutover event identity or one binding.
 * Binding rows may be committed in a different order than run creation. Parent readers must also
 * audit schema/raw bytes and atomically persist coverage; hashes alone do not authenticate it. */
export function inspectProviderTransmissionApprovalArchive({
  archive,
  coverage: rawCoverage,
  records: rawRecords,
}) {
  try {
    const inspected = inspectProviderReservationArchive(archive),
      state = inspected.ledger;
    if (
      !Array.isArray(rawRecords) ||
      rawRecords.length > providerTransmissionApprovalArchiveLimits.records ||
      bytes(rawCoverage) > providerTransmissionApprovalArchiveLimits.coverageBytes
    )
      invalid();
    const coverage = coverageSchema.parse(rawCoverage),
      count = coverage.cutoverGlobalRunCount;
    const prefix = archive.ledger.runs.slice(0, count),
      boundary = eventBoundary(prefix, state, coverage.cutoverProviderEvents);
    if (
      count > archive.ledger.runs.length ||
      coverage.coverageDigest !== digest(omit(coverage, "coverageDigest")) ||
      coverage.cutoverRunPrefixDigest !== digest(prefix.map(identity)) ||
      !same(coverage.cutoverProviderEvents, boundary.prefixes) ||
      !same(coverage.legacyProductionApprovals, boundary.legacy)
    )
      invalid();
    const legacy = new Set(boundary.legacy.map((v) => v.approvalEventDigest));
    const required = new Map(
      state.provider.runs.filter(production).flatMap((run) =>
        approvals(state.provider.events.filter((v) => v.runId === run.id))
          .filter((e) => !legacy.has(e.eventDigest))
          .map((e) => [run.id, e.eventDigest]),
      ),
    );
    if (rawRecords.length !== required.size) invalid();
    const records = rawRecords.map((raw) => {
      const record = inspectRecord(raw, archive, inspected);
      if (required.get(record.runId) !== record.approvalEventDigest) invalid();
      required.delete(record.runId);
      return record;
    });
    if (required.size) invalid();
    const usedBytes = bytes(coverage) + records.reduce((n, r) => n + bytes(r), 0);
    if (
      state.usedBytes + state.reservedBytes + inspected.usedBytes + usedBytes >
      providerTransmissionApprovalArchiveLimits.totalBytes
    )
      invalid();
    return { records, coverage, usedBytes, reservationArchive: inspected };
  } catch {
    return invalid();
  }
}
