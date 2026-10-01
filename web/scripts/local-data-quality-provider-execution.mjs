import { z } from "zod";
import * as base from "./local-data-quality-provider-reservation-ledger.mjs";
import { actualArchiveSchemas } from "./local-data-quality-actual.mjs";
import {
  providerUsagePolicySchema,
  providerResponseMetadataSchema,
  providerUsageAssessmentSchema,
  captureProviderResponse,
  providerResponseMetadata,
  assessProviderUsage,
  validateProviderUsagePolicy,
} from "./local-data-quality-provider-usage.mjs";

const hash = z.string().regex(/^[a-f0-9]{64}$/),
  uuid = z.string().uuid(),
  date = z.string().datetime(),
  phase = z.enum(["generation", "review"]),
  units = z.string().regex(/^(0|[1-9]\d{0,79})$/),
  revision = z.number().int().min(1).max(1000);
const object = (shape) => z.object(shape).strict(),
  omit = (value, key) => Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
const digest = base.providerDigest,
  wire = base.providerWireDigest,
  rawDigest = base.providerRawDigest,
  bytes = (value) => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));
const same = (a, b) => digest(a) === digest(b),
  fail = () => {
    throw new Error("QUALITY_PROVIDER_EXECUTION_INVALID");
  };
export const providerExecutionLimits = Object.freeze({
  requestBytes: 2097152,
  responseBytes: 4194304,
  validatedBytes: 2097152,
  finalBytes: 4194304,
  totalArtifactBytes: 20971520,
});
export const providerExecutionContractSchema = object({
  version: z.literal(1),
  mode: z.enum(["synthetic-test", "provider"]),
  requestContractDigest: hash,
  usagePolicy: providerUsagePolicySchema,
  usagePolicyDigest: hash,
  responseSchemaVersion: z.literal(1),
  domainValidationVersion: z.literal(1),
  limits: object(
    Object.fromEntries(Object.entries(providerExecutionLimits).map(([k, v]) => [k, z.literal(v)])),
  ),
  maxCalls: z.literal(2),
  maxRetries: z.literal(0),
  contractDigest: hash,
});
export const providerTransmissionManifestSchema = object({
  schemaVersion: z.literal(1),
  runDigest: hash,
  preparationDigest: hash,
  executionContract: providerExecutionContractSchema,
  manifestDigest: hash,
});
// Passive v2 manifest only. The frozen approval/event schemas below remain v1.
export const versionedProviderExecutionContractSchema = providerExecutionContractSchema.extend({
  version: z.literal(2),
  engineVersion: z.literal("plan-observation-v2"),
  nativeRunFormat: z.literal(3),
});
export const versionedProviderTransmissionManifestSchema =
  providerTransmissionManifestSchema.extend({
    schemaVersion: z.literal(2),
    executionContract: versionedProviderExecutionContractSchema,
  });
const approval = object({
  kind: z.literal("transmission-approved"),
  manifest: providerTransmissionManifestSchema,
  provenance: z.enum(["explicit-user", "synthetic-test"]),
  approvedAt: date,
  expiresAt: date,
  acknowledgedExternalTransmission: z.literal(true),
  acknowledgedGenerationAndDerivedReview: z.literal(true),
  acknowledgedRetentionNoticeDigest: hash,
  acknowledgedFinancialReservationNotTokenFit: z.literal(true),
  acknowledgedUnknownCostHoldAndNoRetry: z.literal(true),
  budgetRevision: revision,
  budgetDigest: hash,
});
const prepared = object({
  kind: z.literal("request-prepared"),
  phase,
  requestDigest: hash,
  artifactSha256: hash,
  derivedFrom: object({
    generationEventDigest: hash,
    artifactSha256: hash,
    outputDigest: hash,
  }).nullable(),
  budgetRevision: revision,
  budgetDigest: hash,
});
const dispatch = object({
  kind: z.literal("dispatch-intent"),
  phase,
  requestDigest: hash,
  artifactSha256: hash,
  preparedEventDigest: hash,
  approvalEventDigest: hash,
  budgetRevision: revision,
  budgetDigest: hash,
});
const response = object({
  kind: z.literal("response-received"),
  phase,
  requestDigest: hash,
  dispatchEventDigest: hash,
  artifactSha256: hash,
  metadata: providerResponseMetadataSchema,
  usageAssessment: providerUsageAssessmentSchema,
  usageBudgetEventDigest: hash.nullable(),
});
const validated = object({
  kind: z.literal("domain-validated"),
  phase,
  requestDigest: hash,
  responseEventDigest: hash,
  artifactSha256: hash,
  outputDigest: hash,
});
const finish = object({
  kind: z.literal("execution-stopped"),
  outcome: z.enum([
    "completed",
    "before-dispatch",
    "result-unobserved",
    "needs-cost-review",
    "output-invalid",
    "bound-breached",
  ]),
  failureCode: z
    .enum(["INTERRUPTED", "STORAGE_FAILED", "OUTPUT_INVALID", "COST_UNSETTLED", "BOUND_BREACHED"])
    .nullable(),
  finalArtifactSha256: hash.nullable(),
  releasedBudgetEventDigests: z.array(hash).max(2),
});
export const providerExecutionPayloadSchema = z.discriminatedUnion("kind", [
  approval,
  prepared,
  dispatch,
  response,
  validated,
  finish,
]);
export const providerExecutionEventSchema = object({
  schemaVersion: z.literal(2),
  executionContractVersion: z.literal(1),
  runId: uuid,
  revision: z.number().int().min(1).max(32),
  budgetRevision: revision,
  previousEventDigest: hash.nullable(),
  recordedAt: date,
  payload: providerExecutionPayloadSchema,
  eventDigest: hash,
});
// Native v2 approval only. Prepared/dispatch/response events remain unsupported in this format.
export const versionedProviderTransmissionApprovalSchema = approval.extend({
  manifest: versionedProviderTransmissionManifestSchema,
});
export const versionedProviderApprovalEventSchema = providerExecutionEventSchema.extend({
  executionContractVersion: z.literal(2),
  revision: z.literal(1),
  previousEventDigest: z.null(),
  payload: versionedProviderTransmissionApprovalSchema,
});
const recognize = object({
  kind: z.literal("recognize-usage"),
  runId: uuid,
  phase,
  reservationDigest: hash,
  dispatchEventDigest: hash,
  responseArtifactSha256: hash,
  usageAssessmentDigest: hash,
  recognizedUnits: units,
  consumedHeldUnits: units,
  releasedHeldUnits: units,
  boundExcessUnits: units,
  violations: z.array(z.string().min(1).max(200)).max(20),
});
const release = object({
  kind: z.literal("release-phase"),
  runId: uuid,
  phase,
  reservationDigest: hash,
  releasedUnits: units,
  reason: z.literal("not-dispatched"),
});
export const providerExecutionBudgetEventSchema = base.providerBudgetEventSchema.extend({
  payload: z.discriminatedUnion("kind", [recognize, release]),
});
export const providerExecutionReceiptSchema = base.providerReceiptSchema.extend({
  kind: z.enum([
    "provider-approve",
    "provider-prepared",
    "provider-dispatch",
    "provider-response",
    "provider-validated",
    "provider-finish",
  ]),
  runId: uuid,
  runRevision: z.number().int().min(1).max(32),
});
export const providerExecutionArtifactSchema = base.providerArtifactSchema
  .extend({
    key: z.enum([
      "generation-request",
      "generation-response",
      "generation-validated",
      "review-request",
      "review-response",
      "review-validated",
      "final-result",
    ]),
  })
  .superRefine((v, c) => {
    const limit = artifactLimit(v.key);
    if (v.sizeBytes > limit || bytes(v.body) !== v.sizeBytes || rawDigest(v.body) !== v.sha256)
      c.addIssue({ code: "custom", message: "Invalid provider artifact" });
  });
const commandPayload = z.discriminatedUnion("kind", [
  approval,
  prepared,
  dispatch,
  response.omit({ usageAssessment: true, usageBudgetEventDigest: true }),
  validated,
  finish.omit({ releasedBudgetEventDigests: true }),
]);
export const providerExecutionCommandSchema = object({
  clientRequestId: uuid,
  expectedRevision: z.number().int().min(0).max(31),
  payload: commandPayload,
  artifact: providerExecutionArtifactSchema.optional(),
});
export const versionedProviderApprovalCommandSchema = providerExecutionCommandSchema
  .omit({ artifact: true })
  .extend({
    expectedRevision: z.literal(0),
    payload: versionedProviderTransmissionApprovalSchema,
  });
export const createVersionedProviderApprovalEvent = (v) =>
  versionedProviderApprovalEventSchema.parse({ ...v, eventDigest: digest(v) });
export const createProviderExecutionEvent = (v) =>
  providerExecutionEventSchema.parse({ ...v, eventDigest: digest(v) });
export const createProviderExecutionBudgetEvent = (v) =>
  providerExecutionBudgetEventSchema.parse({ ...v, eventDigest: digest(v) });
export const createProviderExecutionReceipt = (v) => providerExecutionReceiptSchema.parse(v);
export const createProviderExecutionArtifact = ({ runId, key, body }) =>
  providerExecutionArtifactSchema.parse({
    runId,
    key,
    body,
    sha256: rawDigest(body),
    sizeBytes: bytes(body),
  });
function artifactLimit(key) {
  return key.endsWith("-request")
    ? providerExecutionLimits.requestBytes
    : key.endsWith("-response")
      ? providerExecutionLimits.responseBytes
      : key.endsWith("-validated")
        ? providerExecutionLimits.validatedBytes
        : providerExecutionLimits.finalBytes;
}
export function providerExecutionOperationDigest(runId, input) {
  return executionOperationDigest(runId, input, false);
}
export function versionedProviderApprovalOperationDigest(runId, input) {
  return executionOperationDigest(runId, input, true);
}
function executionOperationDigest(runId, input, versioned) {
  const v = (
    versioned ? versionedProviderApprovalCommandSchema : providerExecutionCommandSchema
  ).parse(input);
  const existingGeneration =
    v.payload.kind === "request-prepared" && v.payload.phase === "generation";
  return digest({
    kind: "provider-execution-operation",
    runId,
    ...(versioned ? { executionContractVersion: 2 } : {}),
    clientRequestId: v.clientRequestId,
    expectedRevision: v.expectedRevision,
    payload: v.payload,
    artifact: v.artifact && !existingGeneration ? omit(v.artifact, "body") : null,
  });
}
export function createProviderTransmissionManifest(run, usagePolicy) {
  return createTransmissionManifest(run, usagePolicy, false);
}
export function createVersionedProviderTransmissionManifest(run, usagePolicy) {
  return createTransmissionManifest(run, usagePolicy, true);
}
function createTransmissionManifest(run, usagePolicy, versioned) {
  const policy = providerUsagePolicySchema.parse(usagePolicy),
    contract = {
      version: versioned ? 2 : 1,
      ...(versioned ? { engineVersion: "plan-observation-v2", nativeRunFormat: 3 } : {}),
      mode: run.environment === "synthetic-test" ? "synthetic-test" : "provider",
      requestContractDigest: run.preparation.contract.contractDigest,
      usagePolicy: policy,
      usagePolicyDigest: digest(policy),
      responseSchemaVersion: 1,
      domainValidationVersion: 1,
      limits: { ...providerExecutionLimits },
      maxCalls: 2,
      maxRetries: 0,
    };
  const v = {
    schemaVersion: versioned ? 2 : 1,
    runDigest: run.runDigest,
    preparationDigest: run.preparation.preparationDigest,
    executionContract: { ...contract, contractDigest: digest(contract) },
  };
  const schema = versioned
    ? versionedProviderTransmissionManifestSchema
    : providerTransmissionManifestSchema;
  const manifest = schema.parse({ ...v, manifestDigest: digest(v) });
  return validateExecutionManifest(run, manifest, versioned);
}
export function validateProviderExecutionManifest(run, value) {
  return validateExecutionManifest(run, value, false);
}
export function validateVersionedProviderExecutionManifest(run, value) {
  return validateExecutionManifest(run, value, true);
}
function validateExecutionManifest(run, value, versioned) {
  if (
    run.archiveFormatVersion !== (versioned ? 3 : 2) ||
    run.preparation.contract.baseContract.engineVersion !==
      (versioned ? "plan-observation-v2" : "plan-observation-v1")
  )
    fail();
  const schema = versioned
    ? versionedProviderTransmissionManifestSchema
    : providerTransmissionManifestSchema;
  const v = schema.parse(value),
    c = v.executionContract,
    p = run.preparation,
    u = c.usagePolicy;
  validateProviderUsagePolicy(u, p.financialBasis);
  if (
    v.runDigest !== run.runDigest ||
    v.preparationDigest !== p.preparationDigest ||
    v.manifestDigest !== digest(omit(v, "manifestDigest")) ||
    c.contractDigest !== digest(omit(c, "contractDigest")) ||
    c.requestContractDigest !== p.contract.contractDigest ||
    c.mode !== (run.environment === "synthetic-test" ? "synthetic-test" : "provider") ||
    c.usagePolicyDigest !== digest(u) ||
    u.financialBasisDigest !== p.financialBasisDigest ||
    u.configuredModel !== p.model ||
    u.provenance !== (run.environment === "synthetic-test" ? "synthetic-test" : "official-reviewed")
  )
    fail();
  return v;
}
export function deriveProviderExecutionReviewRequest(run, output) {
  const v = actualArchiveSchemas.actualLedgerValidatedArtifactSchema.parse(output),
    t = run.preparation.reviewTemplate;
  if (v.kind !== "plan") fail();
  return {
    model: t.model,
    store: false,
    max_output_tokens: t.max_output_tokens,
    input: [
      t.systemMessage,
      { role: "user", content: JSON.stringify({ ...t.fixedUserContext, draft: v.content }) },
    ],
    text: { format: t.format },
    ...t.requestOptions,
  };
}
export function getProviderExecutionBudgetSnapshot(values, scopeId) {
  const events = values.map((v) =>
      z.union([base.providerBudgetEventSchema, providerExecutionBudgetEventSchema]).parse(v),
    ),
    env =
      scopeId === base.providerBudgetScope("synthetic-test")
        ? "synthetic-test"
        : scopeId === base.providerBudgetScope("production")
          ? "production"
          : fail();
  let cap = 0n,
    currency = null,
    unitScale = null,
    head = null,
    recognized = 0n,
    bound = false;
  const reservations = [],
    ids = new Set();
  for (const [index, e] of events.entries()) {
    if (
      e.scopeId !== scopeId ||
      e.environment !== env ||
      e.provenance !== (env === "synthetic-test" ? "synthetic-test" : "explicit-user") ||
      e.revision !== index + 1 ||
      e.previousDigest !== head ||
      e.eventDigest !== digest(omit(e, "eventDigest")) ||
      ids.has(e.eventId) ||
      bytes(e) > 32768
    )
      fail();
    ids.add(e.eventId);
    head = e.eventDigest;
    const p = e.payload;
    if (index === 0) {
      if (p.kind !== "configure") fail();
      cap = BigInt(p.capUnits);
      currency = e.currency;
      unitScale = e.unitScale;
      continue;
    }
    if (e.currency !== currency || e.unitScale !== unitScale || p.kind === "configure") fail();
    if (p.kind === "reserve-run") {
      if (bound || reservations.some((v) => v.runId === p.runId)) fail();
      const held = reservations.reduce((n, v) => n + BigInt(v.heldUnits), 0n);
      if (held + recognized + BigInt(p.generationUnits) + BigInt(p.reviewUnits) > cap) fail();
      reservations.push({
        runId: p.runId,
        reservationDigest: e.eventDigest,
        generationUnits: p.generationUnits,
        reviewUnits: p.reviewUnits,
        heldUnits: (BigInt(p.generationUnits) + BigInt(p.reviewUnits)).toString(),
        released: false,
        phases: ["generation", "review"].map((phase) => ({
          phase,
          reservedUnits: p[`${phase}Units`],
          heldUnits: p[`${phase}Units`],
          recognizedUnits: "0",
          releasedUnits: "0",
          settled: false,
        })),
      });
      continue;
    }
    const r = reservations.find((v) => v.runId === p.runId);
    if (!r || r.reservationDigest !== p.reservationDigest) fail();
    if (p.kind === "release-run") {
      if (
        r.released ||
        r.phases.some((v) => v.settled) ||
        r.generationUnits !== p.generationUnits ||
        r.reviewUnits !== p.reviewUnits
      )
        fail();
      for (const s of r.phases) {
        s.releasedUnits = s.heldUnits;
        s.heldUnits = "0";
        s.settled = true;
      }
    } else {
      const s = r.phases.find((v) => v.phase === p.phase);
      if (!s || s.settled) fail();
      const held = BigInt(s.heldUnits);
      if (p.kind === "release-phase") {
        if (p.releasedUnits !== s.heldUnits) fail();
        s.releasedUnits = s.heldUnits;
        s.heldUnits = "0";
        s.settled = true;
      } else {
        const cost = BigInt(p.recognizedUnits),
          consumed = cost < held ? cost : held,
          excess = cost > held ? cost - held : 0n;
        if (
          p.consumedHeldUnits !== consumed.toString() ||
          p.releasedHeldUnits !== (held - consumed).toString() ||
          p.boundExcessUnits !== excess.toString()
        )
          fail();
        s.recognizedUnits = cost.toString();
        s.releasedUnits = p.releasedHeldUnits;
        s.heldUnits = "0";
        s.settled = true;
        recognized += cost;
        if (excess > 0n || p.violations.length) bound = true;
      }
    }
    r.heldUnits = r.phases.reduce((n, s) => n + BigInt(s.heldUnits), 0n).toString();
    r.released = r.phases.every((s) => s.settled);
  }
  const held = reservations.reduce((n, v) => n + BigInt(v.heldUnits), 0n),
    exposure = held + recognized,
    deficit = exposure > cap ? exposure - cap : 0n;
  return {
    scopeId,
    environment: env,
    revision: events.length,
    headDigest: head,
    currency,
    unitScale,
    capUnits: cap.toString(),
    heldUnits: held.toString(),
    recognizedUnits: recognized.toString(),
    availableUnits: (cap > exposure ? cap - exposure : 0n).toString(),
    deficitUnits: deficit.toString(),
    boundBreached: bound || deficit > 0n,
    reservations,
  };
}
export function providerUsageRecognitionPayload(
  run,
  phase,
  dispatchEventDigest,
  artifactSha256,
  assessment,
) {
  if (assessment.status !== "known" || assessment.units === null) return null;
  const held = BigInt(run.preparation.financialBasis.costs[phase].totalUnits),
    cost = BigInt(assessment.units),
    consumed = cost < held ? cost : held;
  return recognize.parse({
    kind: "recognize-usage",
    runId: run.id,
    phase,
    reservationDigest: run.reservationDigest,
    dispatchEventDigest,
    responseArtifactSha256: artifactSha256,
    usageAssessmentDigest: digest(assessment),
    recognizedUnits: cost.toString(),
    consumedHeldUnits: consumed.toString(),
    releasedHeldUnits: (held - consumed).toString(),
    boundExcessUnits: (cost > held ? cost - held : 0n).toString(),
    violations: assessment.violations,
  });
}
function outputJson(raw) {
  if (raw.status !== "completed" || !Array.isArray(raw.output)) fail();
  const texts = [];
  for (const message of raw.output)
    if (message?.type === "message" && Array.isArray(message.content))
      for (const p of message.content) {
        if (p?.type === "refusal") fail();
        if (p?.type === "output_text" && typeof p.text === "string") texts.push(p.text);
      }
  if (texts.length !== 1) fail();
  return JSON.parse(texts[0]);
}
export function validateProviderExecutionOutput(phase, value, raw, run, registry, generation) {
  const output = actualArchiveSchemas.actualLedgerValidatedArtifactSchema.parse(value),
    original = outputJson(raw),
    entry = registry.entries.find((v) => v.candidateId === run.preparation.scope.candidateId);
  if (!entry) fail();
  if (phase === "generation") {
    if (output.kind !== "plan") fail();
    const plan = output.content,
      defs = JSON.parse(run.preparation.generation.body.input[1].content).sectionDefinitions;
    if (
      plan.sections.length !== defs.length ||
      original.sections?.length !== plan.sections.length ||
      !same(omit(plan, "sections"), omit(original, "sections"))
    )
      fail();
    for (const [i, s] of plan.sections.entries()) {
      const source = original.sections[i];
      if (
        s.key !== defs[i].key ||
        s.title !== defs[i].title ||
        !same(
          omit(omit(s, "title"), "needsConfirmation"),
          omit(omit(source, "title"), "needsConfirmation"),
        ) ||
        (source.needsConfirmation && !s.needsConfirmation) ||
        (!s.evidence.length && !s.needsConfirmation)
      )
        fail();
      for (const ref of s.evidence) {
        const texts =
          ref.sourceId === "profile"
            ? Object.values(entry.input.profile).filter((v) => typeof v === "string")
            : entry.input.sources
                .filter((v) => v.id === ref.sourceId && v.extraction !== "pending")
                .map((v) => v.text);
        if (!ref.quote.trim() || !ref.locator.trim() || !texts.some((v) => v.includes(ref.quote)))
          fail();
      }
    }
  } else {
    if (output.kind !== "review" || !same(original, { findings: output.findings }) || !generation)
      fail();
    const ids = new Set([
        "profile",
        ...entry.input.sources.filter((v) => v.extraction !== "pending").map((v) => v.id),
      ]),
      keys = new Set(generation.content.sections.map((v) => v.key));
    if (
      output.findings.some(
        (v) =>
          v.sourceIds.some((id) => !ids.has(id)) ||
          (v.sectionKey !== null && !keys.has(v.sectionKey)),
      )
    )
      fail();
  }
  return output;
}

/** Shared by the ledger audit and read-only finalization previews. No terminal event is created. */
export function validateProviderExecutionFinalResult(value, contractDigest, generation, review) {
  const final = actualArchiveSchemas.actualLedgerFinalArtifactSchema.parse(value);
  if (generation?.kind !== "plan" || review?.kind !== "review") fail();
  const initial = generation.content;
  if (
    final.contractDigest !== contractDigest ||
    !same(final.semanticReview, review.findings) ||
    final.content.title !== initial.title ||
    final.content.summary !== initial.summary ||
    final.content.sections.length !== initial.sections.length ||
    final.content.sections.some(
      (v, index) =>
        !same(omit(v, "needsConfirmation"), omit(initial.sections[index], "needsConfirmation")) ||
        (initial.sections[index].needsConfirmation && !v.needsConfirmation),
    ) ||
    !final.semanticReview.every((v) => final.review.some((r) => same(r, v)))
  )
    fail();
  return final;
}

/** Start binding is checked by the public facade; no current engine, price or clock is read. */
export function validateProviderExecutionLedger(input) {
  return validateExecutionLedger(input, false);
}
/** Passive native approval audit. The caller first validates the original reservation ledger.
 * This does not audit the upper policy/transmission binding or grant dispatch authority. */
export function validateVersionedProviderApprovalLedger(input) {
  return validateExecutionLedger(input, true);
}
function validateExecutionLedger(
  {
    run,
    events: rawEvents,
    artifacts: rawArtifacts,
    budgetEvents,
    receipts: rawReceipts,
    registry,
    startSnapshot,
  },
  versioned,
) {
  if (versioned && (run.archiveFormatVersion !== 3 || startSnapshot.archiveFormatVersion !== 4))
    fail();
  const eventSchema = versioned
    ? versionedProviderApprovalEventSchema
    : providerExecutionEventSchema;
  const events = rawEvents.map((v) => eventSchema.parse(v)),
    artifacts = rawArtifacts.map((v) => providerExecutionArtifactSchema.parse(v)),
    receipts = rawReceipts;
  if (
    !events.length ||
    events.length > 32 ||
    artifacts.length > 7 ||
    new Set(artifacts.map((v) => v.key)).size !== artifacts.length ||
    receipts.length !== events.length + 1
  )
    fail();
  const byKey = new Map(artifacts.map((v) => [v.key, v])),
    used = new Set(["generation-request"]),
    linked = new Set([run.reservationDigest]),
    preparedBy = {},
    dispatched = {},
    responded = {},
    validatedBy = {},
    outputs = {},
    rawResponses = {};
  let approvalEvent = null,
    stopped = null,
    state = "approved",
    head = run.reservedBudgetRevision;
  const artifact = (key, sha) => {
    const a = byKey.get(key);
    if (!a || a.runId !== run.id || a.sha256 !== sha) fail();
    used.add(key);
    return a;
  };
  const receiptFor = (event) => {
    const found = receipts.filter((v) => v.runRevision === event.revision);
    if (found.length !== 1) fail();
    const r = providerExecutionReceiptSchema.parse(found[0]),
      p = event.payload;
    const expectedKind = {
      "transmission-approved": "provider-approve",
      "request-prepared": "provider-prepared",
      "dispatch-intent": "provider-dispatch",
      "response-received": "provider-response",
      "domain-validated": "provider-validated",
      "execution-stopped": "provider-finish",
    }[p.kind];
    const payload =
      p.kind === "response-received"
        ? omit(omit(p, "usageAssessment"), "usageBudgetEventDigest")
        : p.kind === "execution-stopped"
          ? omit(p, "releasedBudgetEventDigests")
          : p;
    const key =
      p.kind === "request-prepared"
        ? `${p.phase}-request`
        : p.kind === "response-received"
          ? `${p.phase}-response`
          : p.kind === "domain-validated"
            ? `${p.phase}-validated`
            : p.kind === "execution-stopped" && p.finalArtifactSha256
              ? "final-result"
              : null;
    const command = {
      clientRequestId: r.clientRequestId,
      expectedRevision: event.revision - 1,
      payload,
      ...(key ? { artifact: byKey.get(key) } : {}),
    };
    if (
      r.kind !== expectedKind ||
      r.runId !== run.id ||
      r.scopeId !== run.preparation.budget.scopeId ||
      r.budgetRevision !== event.budgetRevision ||
      r.recordedAt !== event.recordedAt ||
      r.operationDigest !== event.eventDigest ||
      r.inputDigest !== executionOperationDigest(run.id, command, versioned)
    )
      fail();
    return r;
  };
  for (const [i, e] of events.entries()) {
    const p = e.payload;
    if (
      e.runId !== run.id ||
      e.revision !== i + 1 ||
      e.previousEventDigest !== (i ? events[i - 1].eventDigest : null) ||
      e.eventDigest !== digest(omit(e, "eventDigest")) ||
      e.budgetRevision < head ||
      e.budgetRevision > budgetEvents.length ||
      bytes(e) > 32768
    )
      fail();
    const r = receiptFor(e);
    head = e.budgetRevision;
    const currentBudget = getProviderExecutionBudgetSnapshot(
      budgetEvents.slice(0, head),
      run.preparation.budget.scopeId,
    );
    const currentReservation = currentBudget.reservations.find((v) => v.runId === run.id);
    if (!currentReservation) fail();
    const untouchedPhase = (phase) => {
      const value = currentReservation.phases.find((v) => v.phase === phase);
      return !!value && !value.settled && value.heldUnits === value.reservedUnits;
    };
    if (p.kind === "transmission-approved") {
      if (i !== 0 || approvalEvent || stopped) fail();
      validateExecutionManifest(run, p.manifest, versioned);
      const policy = p.manifest.executionContract.usagePolicy;
      if (
        p.provenance !==
          (run.environment === "synthetic-test" ? "synthetic-test" : "explicit-user") ||
        p.acknowledgedRetentionNoticeDigest !== run.preparation.retentionDigest ||
        Date.parse(p.approvedAt) < Date.parse(run.recordedAt) ||
        Date.parse(e.recordedAt) < Date.parse(p.approvedAt) ||
        Date.parse(e.recordedAt) >= Date.parse(p.expiresAt) ||
        Date.parse(p.expiresAt) > Date.parse(run.preparation.expiresAt) ||
        Date.parse(policy.authority.reviewedAt) > Date.parse(p.approvedAt) ||
        Date.parse(p.expiresAt) > Date.parse(policy.authority.validUntil) ||
        p.budgetRevision !== head ||
        p.budgetDigest !== currentBudget.headDigest ||
        currentBudget.boundBreached ||
        !untouchedPhase("generation") ||
        !untouchedPhase("review")
      )
        fail();
      approvalEvent = e;
      continue;
    }
    if (!approvalEvent) fail();
    const c = approvalEvent.payload.manifest.executionContract;
    const late = stopped?.payload.outcome === "result-unobserved" && p.kind === "response-received";
    if (stopped && !late) fail();
    if (p.kind === "request-prepared") {
      if (
        preparedBy[p.phase] ||
        dispatched[p.phase] ||
        responded[p.phase] ||
        currentBudget.boundBreached ||
        !untouchedPhase(p.phase) ||
        Date.parse(e.recordedAt) >= Date.parse(approvalEvent.payload.expiresAt) ||
        p.budgetRevision !== head ||
        p.budgetDigest !== currentBudget.headDigest
      )
        fail();
      let expected;
      if (p.phase === "generation") {
        if (i !== 1 || p.derivedFrom !== null) fail();
        expected = run.preparation.generation.body;
      } else {
        if (
          !validatedBy.generation ||
          !responded.generation?.payload.usageBudgetEventDigest ||
          !same(p.derivedFrom, {
            generationEventDigest: validatedBy.generation.eventDigest,
            artifactSha256: validatedBy.generation.payload.artifactSha256,
            outputDigest: validatedBy.generation.payload.outputDigest,
          })
        )
          fail();
        expected = deriveProviderExecutionReviewRequest(run, outputs.generation);
      }
      const a = artifact(`${p.phase}-request`, p.artifactSha256);
      if (a.body !== JSON.stringify(expected) || p.requestDigest !== wire(expected)) fail();
      preparedBy[p.phase] = e;
      state = "prepared";
    } else if (p.kind === "dispatch-intent") {
      const prev = events[i - 1];
      if (
        prev?.payload.kind !== "request-prepared" ||
        prev !== preparedBy[p.phase] ||
        dispatched[p.phase] ||
        currentBudget.boundBreached ||
        !untouchedPhase(p.phase) ||
        Date.parse(e.recordedAt) >= Date.parse(approvalEvent.payload.expiresAt) ||
        p.approvalEventDigest !== approvalEvent.eventDigest ||
        p.preparedEventDigest !== prev.eventDigest ||
        p.artifactSha256 !== prev.payload.artifactSha256 ||
        p.requestDigest !== prev.payload.requestDigest ||
        p.budgetRevision !== head ||
        p.budgetDigest !== currentBudget.headDigest
      )
        fail();
      dispatched[p.phase] = e;
      state = "dispatching";
    } else if (p.kind === "response-received") {
      const d = dispatched[p.phase];
      if (
        !d ||
        responded[p.phase] ||
        p.dispatchEventDigest !== d.eventDigest ||
        p.requestDigest !== d.payload.requestDigest ||
        (!late && events[i - 1] !== d)
      )
        fail();
      const a = artifact(`${p.phase}-response`, p.artifactSha256),
        envelope = object({
          captureKind: z.literal("sdk-response-json-v2"),
          response: z.record(z.string(), z.json()),
        }).parse(JSON.parse(a.body));
      const raw = captureProviderResponse(envelope.response);
      if (!same(raw, envelope.response)) fail();
      const meta = providerResponseMetadata(raw, {
          configuredModel: run.preparation.model,
          requestedTier: "default",
        }),
        assessment = assessProviderUsage({
          response: raw,
          policy: c.usagePolicy,
          financialBasis: run.preparation.financialBasis,
          phase: p.phase,
        });
      if (!same(meta, p.metadata) || !same(assessment, p.usageAssessment)) fail();
      const recognition = providerUsageRecognitionPayload(
        run,
        p.phase,
        d.eventDigest,
        a.sha256,
        assessment,
      );
      if (recognition) {
        const b = budgetEvents.find((v) => v.eventDigest === p.usageBudgetEventDigest);
        if (
          !b ||
          !same(b.payload, recognition) ||
          b.revision !== head ||
          b.recordedAt !== e.recordedAt ||
          b.eventId !== r.clientRequestId
        )
          fail();
        linked.add(b.eventDigest);
      } else if (p.usageBudgetEventDigest !== null) fail();
      rawResponses[p.phase] = raw;
      responded[p.phase] = e;
      if (!late) state = "response-recorded";
    } else if (p.kind === "domain-validated") {
      const prior = responded[p.phase];
      if (
        !prior ||
        validatedBy[p.phase] ||
        events[i - 1] !== prior ||
        p.responseEventDigest !== prior.eventDigest ||
        p.requestDigest !== prior.payload.requestDigest ||
        !prior.payload.usageBudgetEventDigest ||
        currentBudget.boundBreached
      )
        fail();
      const a = artifact(`${p.phase}-validated`, p.artifactSha256),
        output = validateProviderExecutionOutput(
          p.phase,
          JSON.parse(a.body),
          rawResponses[p.phase],
          run,
          registry,
          outputs.generation,
        );
      if (p.outputDigest !== digest(output)) fail();
      outputs[p.phase] = output;
      validatedBy[p.phase] = e;
      state = "validated";
    } else {
      if (stopped) fail();
      const releaseKeys = new Set();
      let releasedAtRevision = 0;
      for (const h of p.releasedBudgetEventDigests) {
        const b = budgetEvents.find((v) => v.eventDigest === h);
        if (
          !b ||
          b.payload.kind !== "release-phase" ||
          b.payload.runId !== run.id ||
          dispatched[b.payload.phase] ||
          linked.has(h) ||
          releaseKeys.has(b.payload.phase) ||
          b.revision > head ||
          b.recordedAt !== e.recordedAt
        )
          fail();
        linked.add(h);
        releaseKeys.add(b.payload.phase);
        releasedAtRevision = Math.max(releasedAtRevision, b.revision);
      }
      if (releasedAtRevision && releasedAtRevision !== head) fail();
      const own = currentBudget.reservations.find((v) => v.runId === run.id);
      if (!own) fail();
      for (const s of own.phases) if (!dispatched[s.phase] && !s.settled) fail();
      if (p.outcome === "completed") {
        if (
          !validatedBy.review ||
          !validatedBy.generation ||
          !p.finalArtifactSha256 ||
          p.failureCode !== null ||
          currentBudget.boundBreached ||
          own.phases.some((v) => !v.settled)
        )
          fail();
        validateProviderExecutionFinalResult(
          JSON.parse(artifact("final-result", p.finalArtifactSha256).body),
          c.contractDigest,
          outputs.generation,
          outputs.review,
        );
      } else {
        if (p.failureCode === null || p.finalArtifactSha256 !== null) fail();
        if (p.outcome === "before-dispatch" && Object.keys(dispatched).length) fail();
        if (
          p.outcome === "result-unobserved" &&
          !Object.keys(dispatched).some((v) => !responded[v])
        )
          fail();
        if (
          p.outcome === "needs-cost-review" &&
          !Object.values(responded).some((v) => v.payload.usageBudgetEventDigest === null)
        )
          fail();
        if (p.outcome === "bound-breached" && !currentBudget.boundBreached) fail();
        if (
          p.outcome === "output-invalid" &&
          (!Object.keys(responded).length || Object.keys(dispatched).some((v) => !responded[v]))
        )
          fail();
      }
      stopped = e;
      state = p.outcome;
    }
  }
  if (
    artifacts.some((v) => !used.has(v.key)) ||
    new Set(receipts.map((v) => v.clientRequestId)).size !== receipts.length
  )
    fail();
  const own = budgetEvents.filter((v) => v.payload.runId === run.id);
  if (own.length > 16 || own.some((v) => !linked.has(v.eventDigest))) fail();
  const budget = getProviderExecutionBudgetSnapshot(
      budgetEvents.slice(0, head),
      run.preparation.budget.scopeId,
    ),
    reservation = budget.reservations.find((v) => v.runId === run.id),
    unsettled = reservation.phases.some((v) => !v.settled),
    terminal = !!stopped;
  const usedBytes =
    bytes(run) +
    events.reduce((n, v) => n + bytes(v), 0) +
    artifacts.reduce((n, v) => n + v.sizeBytes, 0) +
    own.reduce((n, v) => n + bytes(v), 0) +
    receipts.reduce((n, v) => n + bytes(v), 0);
  if (
    usedBytes > 33554432 ||
    artifacts.reduce((n, v) => n + v.sizeBytes, 0) > providerExecutionLimits.totalArtifactBytes
  )
    fail();
  const hold = !(terminal && !unsettled),
    dispatchIntentCount = Object.keys(dispatched).length,
    responseCount = Object.keys(responded).length;
  const snapshot = {
    schemaVersion: 2,
    archiveFormatVersion: versioned ? 5 : 3,
    run,
    revision: events.length,
    events,
    artifacts: artifacts
      .map((v) => omit(v, "body"))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    budgetEvents: budgetEvents.slice(0, head),
    state,
    actualAiCalls: run.environment === "synthetic-test" ? 0 : null,
    dispatchAllowed: false,
    canResume: false,
    terminal,
    unsettled,
    eligibleForNewCandidateRun: terminal && !unsettled,
    dispatchIntentCount,
    responseCount,
    unobservedDispatchCount: dispatchIntentCount - responseCount,
    storage: {
      usedBytes,
      heldBytes: hold ? 33554432 - usedBytes : 0,
      remainingEventSlots: hold ? 32 - events.length : 0,
      remainingBudgetEventSlots: hold ? 16 - own.length : 0,
      remainingReceiptSlots: hold ? 64 - receipts.length : 0,
    },
  };
  void startSnapshot;
  return { ...snapshot, snapshotDigest: digest(snapshot) };
}
