import { z } from "zod";
import { versionedProviderPolicyArchiveJsonSchema } from "./local-data-quality-provider-policy-versioned-schema.mjs";
import { providerPolicyArchiveJsonSchema } from "./local-data-quality-provider-policy-schema.mjs";
import {
  providerDigest as digest,
  providerRawDigest as rawDigest,
  providerBudgetEventSchema,
  createProviderBudgetEvent,
  validateProviderBudgetLedger,
  validateProviderFinancialBasis,
  validateProviderRequestEvidence,
  validateVersionedProviderRequestEvidence,
  inspectProviderLedger,
  inspectVersionedProviderLedger,
} from "./local-data-quality-provider.mjs";
import { validateProviderUsagePolicy } from "./local-data-quality-provider-usage.mjs";

// Frozen archive v1: never import today's prompts, server configuration, credentials or clock.
export const providerPolicyArchiveLimits = { records: 100, recordBytes: 2 * 1024 * 1024 };
const recordSchema = z.fromJSONSchema(providerPolicyArchiveJsonSchema);
const versionedRecordSchema = z.union([
  recordSchema,
  z.fromJSONSchema(versionedProviderPolicyArchiveJsonSchema),
]);
const parseRecord = (raw, versioned) =>
  (versioned ? versionedRecordSchema : recordSchema).parse(raw);
const liveScope = "candidate-quality-provider-v2-live";
const same = (a, b) => digest(a) === digest(b);
const omit = (value, key) => Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const invalid = () => {
  throw new Error("PROVIDER_POLICY_ARCHIVE_INVALID");
};
const official = (value) => {
  const u = new URL(value);
  return (
    u.protocol === "https:" &&
    !u.username &&
    !u.password &&
    !u.port &&
    ["openai.com", "www.openai.com", "developers.openai.com", "platform.openai.com"].includes(
      u.hostname,
    )
  );
};
const headValid = (head) => (head.revision === 0) === (head.headDigest === null);
const sameHead = (a, b) => a.revision === b.revision && a.headDigest === b.headDigest;

/** Bounded immutable SQL rows, shared by the app and backup reader. No schema migration or writes. */
export function decodeProviderPolicyRows(rows) {
  return decodeRows(rows, false);
}
export function decodeVersionedProviderPolicyRows(rows) {
  return decodeRows(rows, true);
}
function decodeRows(rows, versioned) {
  try {
    if (!Array.isArray(rows) || rows.length > providerPolicyArchiveLimits.records) invalid();
    let previousOrder = 0,
      usedBytes = 0;
    const records = rows.map((row) => {
      if (
        typeof row.body !== "string" ||
        Buffer.byteLength(row.body) > providerPolicyArchiveLimits.recordBytes ||
        !Number.isSafeInteger(row.storage_order) ||
        row.storage_order <= previousOrder
      )
        invalid();
      previousOrder = row.storage_order;
      const record = parseRecord(JSON.parse(row.body), versioned);
      if (
        row.body_hash !== digest(record) ||
        row.scope_id !== record.scopeId ||
        row.revision !== record.revision ||
        row.nonce !== record.clientRequestId
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

function inspectProof(raw, versioned = false) {
  if (bytes(raw) > providerPolicyArchiveLimits.recordBytes) invalid();
  const r = parseRecord(raw, versioned),
    c = r.command,
    v = r.reviewedProposal,
    p = v.proposal,
    review = r.approvedReview,
    b = review.budget;
  const initialize = c.budgetAction === "initialize-proposed-budget";
  const inspected = Date.parse(review.inspectedAt),
    recorded = Date.parse(r.recordedAt),
    approved = Date.parse(c.approval.approvedAt),
    expires = Date.parse(review.expiresAt);
  if (
    !headValid(c.expectedPolicyHead) ||
    !headValid(b) ||
    !headValid(r.budgetTransition.before) ||
    !headValid(r.budgetTransition.after) ||
    initialize !== (c.initialBudgetRequestId !== null) ||
    c.initialBudgetRequestId === c.clientRequestId ||
    initialize !== (b.revision === 0) ||
    r.clientRequestId !== c.clientRequestId ||
    r.requestDigest !== digest(c) ||
    r.recordDigest !== digest(omit(r, "recordDigest")) ||
    r.revision !== c.expectedPolicyHead.revision + 1 ||
    r.previousDigest !== c.expectedPolicyHead.headDigest ||
    c.approvedReviewDigest !== review.reviewDigest ||
    review.reviewDigest !== digest(omit(review, "reviewDigest")) ||
    v.viewDigest !== digest(omit(v, "viewDigest")) ||
    !same(v.scope, review.scope) ||
    v.inspectedAt !== review.inspectedAt ||
    c.version !== review.scope.version ||
    c.versionDigest !== review.scope.versionDigest ||
    c.candidateId !== review.scope.candidateId ||
    !(inspected <= approved && approved <= recorded && recorded < expires) ||
    expires !==
      Math.min(inspected + 15 * 60 * 1000, ...p.sources.map((s) => Date.parse(s.validUntil))) ||
    r.budgetTransition.kind !== c.budgetAction ||
    r.budgetTransition.initializationRequestId !== c.initialBudgetRequestId ||
    !sameHead(r.budgetTransition.before, b)
  )
    invalid();

  const f = validateProviderFinancialBasis(v.financialBasis);
  if (
    f.model !== v.model ||
    f.evidenceMode !== "official-reviewed" ||
    f.calculatedAt !== v.inspectedAt ||
    !same(p.requestReview.scope, {
      version: v.scope.version,
      versionDigest: v.scope.versionDigest,
      candidateId: v.scope.candidateId,
      sourceDigest: v.scope.sourceDigest,
      candidateDigest: v.scope.candidateDigest,
      modelInputDigest: v.scope.modelInputDigest,
    }) ||
    p.requestReview.model !== v.model ||
    !same(review.bindings, {
      configurationDigest: p.configurationDigest,
      requestReviewDigest: digest(p.requestReview),
      financialBasisDigest: digest(f),
      retentionDigest: digest(v.retention),
      usagePolicyDigest: digest(p.usagePolicy),
      model: v.model,
    }) ||
    !same(review.proposedBudget, p.proposedBudget) ||
    !same(review.reservation, {
      generationUnits: f.costs.generation.totalUnits,
      reviewUnits: f.costs.review.totalUnits,
      totalUnits: f.costs.totalUnits,
    }) ||
    p.proposedBudget.currency !== f.costs.currency ||
    p.proposedBudget.unitScale !== f.costs.unitScale ||
    BigInt(p.proposedBudget.capUnits) < BigInt(f.costs.totalUnits)
  )
    invalid();
  validateProviderUsagePolicy(p.usagePolicy, f);
  if (
    p.usagePolicy.provenance !== "official-reviewed" ||
    new Set(p.sources.map((s) => s.id)).size !== p.sources.length
  )
    invalid();
  for (const s of p.sources) {
    if (
      !official(s.url) ||
      s.excerptSha256 !== rawDigest(s.excerpt) ||
      s.recordDigest !== digest(omit(s, "recordDigest")) ||
      (s.digestKind === "body" && s.bodySha256 === null) ||
      Date.parse(s.retrievedAt) > Date.parse(s.reviewedAt) ||
      Date.parse(s.reviewedAt) > inspected ||
      inspected >= Date.parse(s.validUntil)
    )
      invalid();
  }
  for (const a of [
    f.evidence.context.authority,
    f.evidence.pricing.authority,
    v.retention,
    p.usagePolicy.authority,
  ]) {
    if (
      !p.sources.some(
        (s) =>
          s.url === a.sourceUrl &&
          (s.digestKind === "body" ? s.bodySha256 : s.recordDigest) === a.documentDigest &&
          s.reviewedAt === a.reviewedAt &&
          s.validUntil === a.validUntil &&
          (a.retrievedAt === undefined || a.retrievedAt === s.retrievedAt) &&
          (a.excerpt === undefined || a.excerpt === s.excerpt),
      )
    )
      invalid();
  }
  if (
    p.configurationDigest !==
    digest({
      schemaVersion: 1,
      kind: "provider-configuration-proposal",
      adoption: p.adoption,
      model: v.model,
      conditions: f.conditions,
      outputReservationTokens: 16000,
      context: f.evidence.context,
      pricing: f.evidence.pricing,
      retention: v.retention,
      usagePolicyTemplate: omit(p.usagePolicy, "financialBasisDigest"),
      proposedBudget: p.proposedBudget,
      sources: p.sources,
    })
  )
    invalid();
  const blockers = [
    ["CONFIGURATION_NOT_ADOPTED", "모델·근거는 검토 제안이며 운영 설정으로 채택되지 않았습니다."],
    ["BUDGET_NOT_CONFIGURED", "운영 통화·예산·한 건의 예약 한도가 설정되지 않았습니다."],
    ["ACCOUNT_ACCESS_NOT_CHECKED", "운영 인증 연결과 모델 사용 권한을 확인하지 않았습니다."],
    ["PRODUCTION_EXECUTION_DISABLED", "실제 AI 전송은 연결되지 않았습니다."],
  ];
  if (
    !same(
      v.blockers,
      blockers.map(([code, message]) => ({ code, message })),
    )
  )
    invalid();
  if (
    b.revision > 0 &&
    (b.currency !== p.proposedBudget.currency || b.unitScale !== p.proposedBudget.unitScale)
  )
    invalid();
  const available = BigInt(b.revision ? b.availableUnits : p.proposedBudget.capUnits),
    requested = BigInt(f.costs.totalUnits);
  if (
    !same(review.assessment, {
      state: !b.revision
        ? "budget-not-configured"
        : b.boundBreached
          ? "budget-bound-breached"
          : available < requested
            ? "budget-insufficient"
            : "budget-configured",
      basis: b.revision ? "existing-budget" : "unapproved-proposal",
      availableBeforeReservationUnits: available.toString(),
      availableAfterReservationUnits: (available > requested
        ? available - requested
        : 0n
      ).toString(),
      shortfallUnits: (requested > available ? requested - available : 0n).toString(),
    })
  )
    invalid();
  return r;
}

function inspectRecord(raw, registry, budgetEvents, versioned = false) {
  const r = inspectProof(raw, versioned),
    v = r.reviewedProposal,
    b = r.approvedReview.budget;
  // Registries must also pass the parent store/backup's complete registration and receipt inspection.
  const manifest = registry.manifest.filter((m) => m.candidateId === v.scope.candidateId);
  if (
    manifest.length !== 1 ||
    registry.setId !== v.scope.setId ||
    registry.sourceDigest !== v.scope.registrySourceDigest ||
    registry.manifestDigest !== v.scope.manifestDigest ||
    manifest[0].label !== v.scope.label ||
    Date.parse(registry.registeredAt) > Date.parse(v.inspectedAt)
  )
    invalid();
  (r.recordVersion === 2
    ? validateVersionedProviderRequestEvidence
    : validateProviderRequestEvidence)(v.proposal.requestReview, registry);
  const events = z.array(providerBudgetEventSchema).max(1000).parse(budgetEvents);
  if (events.some((e) => e.scopeId !== liveScope)) invalid();
  validateProviderBudgetLedger(events, liveScope);
  const prefix = events.slice(0, b.revision),
    snapshot = validateProviderBudgetLedger(prefix, liveScope);
  if (
    !same(b, {
      scopeId: liveScope,
      revision: snapshot.revision,
      headDigest: snapshot.headDigest,
      currency: snapshot.currency,
      unitScale: snapshot.unitScale,
      capUnits: snapshot.capUnits,
      heldUnits: snapshot.heldUnits,
      recognizedUnits: snapshot.recognizedUnits,
      availableUnits: snapshot.availableUnits,
      deficitUnits: snapshot.deficitUnits ?? "0",
      boundBreached: snapshot.boundBreached ?? false,
    }) ||
    prefix.some((e) => Date.parse(e.recordedAt) > Date.parse(v.inspectedAt))
  )
    invalid();
  if (r.command.budgetAction === "initialize-proposed-budget") {
    const expected = createProviderBudgetEvent({
      schemaVersion: 2,
      scopeId: liveScope,
      environment: "production",
      provenance: "explicit-user",
      revision: 1,
      previousDigest: null,
      eventId: r.command.initialBudgetRequestId,
      recordedAt: r.recordedAt,
      currency: v.proposal.proposedBudget.currency,
      unitScale: v.proposal.proposedBudget.unitScale,
      payload: { kind: "configure", capUnits: v.proposal.proposedBudget.capUnits },
    });
    if (
      !same(events[0], expected) ||
      r.budgetTransition.after.revision !== 1 ||
      r.budgetTransition.after.headDigest !== expected.eventDigest
    )
      invalid();
  } else if (!sameHead(r.budgetTransition.after, b)) invalid();
  // Later events can share the same clock tick, but cannot predate an adoption that omitted them.
  if (
    events
      .slice(r.budgetTransition.after.revision)
      .some((e) => Date.parse(e.recordedAt) < Date.parse(r.recordedAt))
  )
    invalid();
  return r;
}

/** Frozen record proof, with registered candidate and production budget references. No authority grant. */
export function validateProviderPolicyAdoptionRecord(raw, registry, budgetEvents) {
  return validateRecord(raw, registry, budgetEvents, false);
}
export function validateVersionedProviderPolicyAdoptionRecord(raw, registry, budgetEvents) {
  return validateRecord(raw, registry, budgetEvents, true);
}
function validateRecord(raw, registry, budgetEvents, versioned) {
  try {
    return inspectRecord(raw, registry, budgetEvents, versioned);
  } catch {
    return invalid();
  }
}

/**
 * Full policy chain plus provider runs/receipts/artifacts. Parent must validate registries, legacy
 * ledgers and their shared capacity too; include every other operation nonce in otherNonces.
 * Records must be in immutable insertion order. A digest is integrity evidence, not a signature.
 */
export function inspectProviderPolicyLedger(input) {
  return inspectLedger(input, false);
}
export function inspectVersionedProviderPolicyLedger(input) {
  return inspectLedger(input, true);
}
function inspectLedger(
  { records: raw, registries, provider, otherNonces = /** @type {string[]} */ ([]) },
  versioned,
) {
  try {
    if (
      !Array.isArray(raw) ||
      raw.length > providerPolicyArchiveLimits.records ||
      !Array.isArray(registries) ||
      registries.length > 20
    )
      invalid();
    const other = z.array(z.string().uuid()).max(10000).parse(otherNonces);
    if (new Set(other).size !== other.length) invalid();
    const records = raw.map((item) => inspectProof(item, versioned)),
      nonces = records.map((r) => r.clientRequestId);
    const ledger = (versioned ? inspectVersionedProviderLedger : inspectProviderLedger)({
      ...provider,
      registries,
      otherNonces: [...other, ...nonces],
    });
    const budgets = provider.budgetEvents.filter((e) => e.scopeId === liveScope);
    let previous = null;
    for (const [index, r] of records.entries()) {
      const candidates = registries.filter((v) => v.version === r.command.version);
      if (
        candidates.length !== 1 ||
        r.revision !== index + 1 ||
        r.previousDigest !== (previous?.recordDigest ?? null) ||
        (previous &&
          (Date.parse(r.recordedAt) < Date.parse(previous.recordedAt) ||
            r.budgetTransition.before.revision < previous.budgetTransition.after.revision))
      )
        invalid();
      inspectRecord(r, candidates[0], budgets, versioned);
      previous = r;
    }
    const usedBytes = records.reduce((n, r) => n + bytes(r), 0);
    if (usedBytes + ledger.usedBytes + ledger.reservedBytes > 256 * 1024 * 1024) invalid();
    return {
      revision: records.length,
      headDigest: previous?.recordDigest ?? null,
      records,
      nonces,
      usedBytes,
      provider: ledger,
    };
  } catch {
    return invalid();
  }
}
