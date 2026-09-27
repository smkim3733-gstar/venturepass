import { createHash } from "node:crypto";
import { z } from "zod";
import { actualArchiveJsonSchemas } from "./local-data-quality-actual.mjs";
import * as frozen from "./local-data-quality-provider-reservation-ledger.mjs";
import * as execution from "./local-data-quality-provider-execution.mjs";
export * from "./local-data-quality-provider-execution.mjs";
export const providerReservationRunSchema = frozen.providerRunSchema;
export const providerReservationBudgetEventSchema = frozen.providerBudgetEventSchema;
export const providerReservationRunEventSchema = frozen.providerRunEventSchema;
export const providerReservationReceiptSchema = frozen.providerReceiptSchema;
export const providerReservationArtifactSchema = frozen.providerArtifactSchema;
export const validateProviderReservationRunLedger = frozen.validateProviderRunLedger;
export const validateProviderReservationBudgetLedger = frozen.validateProviderBudgetLedger;

const hash = z.string().regex(/^[a-f0-9]{64}$/),
  uuid = z.string().uuid(),
  date = z.string().datetime();
const units = z.string().regex(/^(0|[1-9]\d{0,79})$/),
  positive = z.number().int().positive().safe().max(1e9);
const environment = z.enum(["synthetic-test", "production"]),
  provenance = z.enum(["synthetic-test", "explicit-user"]);
const scope = z.enum([
  "candidate-quality-provider-v2-synthetic",
  "candidate-quality-provider-v2-live",
]);
const model = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/),
  json = z.json();
const object = (shape) => z.object(shape).strict();
const options = object({
  service_tier: z.literal("default"),
  truncation: z.literal("disabled"),
  background: z.literal(false),
  stream: z.literal(false),
});
const conditions = object({
  provider: z.literal("OpenAI"),
  endpoint: z.literal("https://api.openai.com/v1"),
  api: z.literal("responses"),
  modality: z.literal("text-only"),
  tools: z.literal("none"),
  tokenCountingEndpoint: z.literal("none"),
  serviceTier: z.literal("default"),
  processing: z.literal("standard"),
  destination: z.literal("global"),
  store: z.literal(false),
  truncation: z.literal("disabled"),
  previousResponse: z.literal("none"),
  conversation: z.literal("none"),
  compaction: z.literal("none"),
  background: z.literal(false),
  stream: z.literal(false),
  maxCalls: z.literal(2),
  retries: z.literal(0),
});
const https = z
  .string()
  .url()
  .refine((value) => {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && !u.port;
  });
const authority = object({
  sourceUrl: https,
  documentDigest: hash,
  retrievedAt: date,
  reviewedAt: date,
  validUntil: date,
  freshnessPolicy: z.string().trim().min(1).max(2000),
  reviewerId: z.string().trim().min(1).max(200),
  excerpt: z.string().trim().min(1).max(10000),
});
const evidence = {
  provenance: z.enum(["official-reviewed", "synthetic-test"]),
  model,
  conditions,
  authority,
};
const rate = object({ units: z.string().regex(/^(0|[1-9]\d{0,39})$/), perTokens: positive });
const na = object({
  applicability: z.literal("not-applicable"),
  explanation: z.string().trim().min(1).max(2000),
});
const band = object({
  uncachedInput: rate,
  cacheReadInput: z.union([rate, na]),
  cacheWriteInput: z.union([rate, na]),
  outputIncludingReasoning: rate,
});
const context = object({
  ...evidence,
  contextWindowTokens: positive,
  contextCoverage: z.literal("input-plus-output-including-reasoning"),
  maxOutputTokens: positive,
});
const pricing = object({
  ...evidence,
  currency: z.string().regex(/^[A-Z]{3}$/),
  unitScale: z.number().int().min(0).max(12),
  rateMeaning: z.literal("all-in-replacement-rates-not-additive-surcharges"),
  shortContext: band,
  longContext: z.union([band, na]),
  additionalCharges: object({
    applicability: z.literal("none-under-stated-conditions"),
    explanation: z.string().trim().min(1).max(2000),
  }),
});
const phaseCost = object({
  inputTokensReserved: positive,
  outputTokensReserved: z.literal(16000),
  inputUnits: units,
  outputUnits: units,
  totalUnits: units,
});
const selectedRate = object({ rate, selectedFrom: z.string().min(1).max(100) });
const financial = object({
  schemaVersion: z.literal(2),
  kind: z.literal("provider-context-financial-reservation-basis"),
  status: z.literal("calculated-for-stated-conditions"),
  evidenceMode: z.enum(["official-reviewed", "synthetic-test"]),
  model,
  calculatedAt: date,
  conditions,
  evidence: object({ context, pricing }),
  basis: z.literal("full-context-input-plus-separate-output-reservation"),
  maxCalls: z.literal(2),
  retries: z.literal(0),
  costs: object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    unitScale: z.number().int().min(0).max(12),
    maximumInputRate: selectedRate,
    maximumOutputRate: selectedRate,
    generation: phaseCost,
    review: phaseCost,
    totalUnits: units,
    rounding: z.literal("ceil-each-rate-per-request"),
  }),
  blockers: z.array(json).length(0),
  authority: object(
    Object.fromEntries(
      [
        "sourceAuthenticityIndependentlyVerified",
        "providerFailureChargeBoundVerified",
        "actualTokenCountMeasured",
        "contextFitVerified",
        "accountAccessVerified",
        "userApprovalRecorded",
        "operatingBudgetConfigured",
        "executionReady",
        "dispatchAllowed",
        "compatibleWithLegacyPreparation",
      ].map((key) => [key, z.literal(false)]),
    ),
  ),
  unobservedCostPolicy: z.literal("retain-reservation-no-automatic-retry"),
  limitations: z.array(z.string().min(1).max(2000)).min(1).max(20),
});
const format = object({
  type: z.literal("json_schema"),
  name: z.string().min(1),
  strict: z.literal(true),
  schema: z.record(z.string(), json),
});
const system = object({ role: z.literal("system"), content: z.string().min(1).max(240000) });
const body = object({
  model,
  store: z.literal(false),
  max_output_tokens: z.literal(16000),
  input: z.tuple([
    system,
    object({ role: z.literal("user"), content: z.string().min(1).max(240000) }),
  ]),
  text: object({ format }),
  ...options.shape,
});
const baseContract = z.fromJSONSchema(
  actualArchiveJsonSchemas.actualLedgerRunSchema.properties.preparation.properties.engine,
);
const contract = object({
  schemaVersion: z.literal(2),
  engineVersion: z.literal("plan-provider-reservation-v2"),
  baseContract,
  requestOptions: options,
  omittedFields: z.tuple([
    z.literal("previous_response_id"),
    z.literal("conversation"),
    z.literal("tools"),
    z.literal("context_management"),
  ]),
  maxCalls: z.literal(2),
  maxRetries: z.literal(0),
  maxOutputTokens: z.literal(16000),
  contractDigest: hash,
});
const retention = object({
  policyVersion: z.string().min(1).max(100),
  notice: z.string().min(1).max(10000),
  sourceUrl: https,
  documentDigest: hash,
  reviewedAt: date,
  validUntil: date,
});
const requestTemplate = object({
  schemaVersion: z.literal(2),
  phase: z.literal("review"),
  complete: z.literal(false),
  model,
  store: z.literal(false),
  max_output_tokens: z.literal(16000),
  systemMessage: system,
  format,
  fixedUserContext: z.record(z.string(), json),
  draftSlot: object({
    jsonPath: z.literal("$.draft"),
    rule: z.literal("this-run-validated-generation-only"),
    requiresValidatedEventBinding: z.literal(true),
  }),
  contractDigest: hash,
  requestOptions: options,
  templateDigest: hash,
});
export const providerPreparationSchema = object({
  schemaVersion: z.literal(2),
  kind: z.literal("provider-execution-preparation"),
  environment,
  preparedAt: date,
  expiresAt: date,
  scope: object({
    version: z.number().int().min(1).max(20),
    versionDigest: hash,
    candidateId: z
      .string()
      .regex(/^validation-candidate-[a-z0-9-]+$/)
      .max(120),
    sourceDigest: hash,
    candidateDigest: hash,
    modelInputDigest: hash,
  }),
  model,
  contract,
  generation: object({
    body,
    requestDigest: hash,
    sha256: hash,
    inputChars: z.number().int().positive().max(240000),
  }),
  reviewTemplate: requestTemplate,
  financialBasis: financial,
  financialBasisDigest: hash,
  budget: object({
    scopeId: scope,
    revision: z.number().int().min(1).max(1000),
    headDigest: hash,
    currency: z.string().regex(/^[A-Z]{3}$/),
    unitScale: z.number().int().min(0).max(12),
    capUnits: units,
    heldUnits: units,
    recognizedUnits: units,
  }),
  retention,
  retentionDigest: hash,
  permissions: object({
    dispatchAllowed: z.literal(false),
    tokenFitVerified: z.literal(false),
    accountAccessVerified: z.literal(false),
  }),
  preparationDigest: hash,
});
export const providerApprovalSchema = object({
  provenance,
  approvedPreparationDigest: hash,
  approvedAt: date,
  expiresAt: date,
  acknowledgedReservationOnly: z.literal(true),
  acknowledgedFinancialBasisNotTokenFit: z.literal(true),
  acknowledgedRetention: z.literal(true),
  acknowledgedNoAutomaticRetry: z.literal(true),
});
export const providerStartSchema = object({
  clientRequestId: uuid,
  expectedBudgetRevision: z.number().int().min(1).max(1000),
  expectedBudgetDigest: hash,
  expectedScopeRunCount: z.number().int().min(0).max(19),
  expectedGlobalRunCount: z.number().int().min(0).max(19),
  preparation: providerPreparationSchema,
  approval: providerApprovalSchema,
});
export const providerPolicySchema = object({
  environment,
  provenance,
  currency: z.string().regex(/^[A-Z]{3}$/),
  unitScale: z.number().int().min(0).max(12),
  capUnits: units,
});
const budgetPayload = z.discriminatedUnion("kind", [
  object({ kind: z.literal("configure"), capUnits: units }),
  object({
    kind: z.literal("reserve-run"),
    runId: uuid,
    preparationDigest: hash,
    generationUnits: units,
    reviewUnits: units,
  }),
  object({
    kind: z.literal("release-run"),
    runId: uuid,
    reservationDigest: hash,
    generationUnits: units,
    reviewUnits: units,
    reason: z.literal("cancelled-before-dispatch"),
  }),
]);
const reservationBudgetEventSchema = object({
  schemaVersion: z.literal(2),
  scopeId: scope,
  environment,
  provenance,
  revision: z.number().int().min(1).max(1000),
  previousDigest: hash.nullable(),
  eventId: uuid,
  recordedAt: date,
  currency: z.string().regex(/^[A-Z]{3}$/),
  unitScale: z.number().int().min(0).max(12),
  payload: budgetPayload,
  eventDigest: hash,
});
export const providerRunSchema = object({
  schemaVersion: z.literal(2),
  archiveFormatVersion: z.literal(2),
  id: uuid,
  clientRequestId: uuid,
  inputDigest: hash,
  recordedAt: date,
  environment,
  executionKind: z.enum(["provider-contract-simulation", "provider-ai-execution"]),
  observedTransport: z.literal("none"),
  actualAiCalls: z.literal(0),
  preparation: providerPreparationSchema,
  approval: providerApprovalSchema,
  expectedBudgetRevision: z.number().int().min(1).max(1000),
  expectedBudgetDigest: hash,
  expectedScopeRunCount: z.number().int().min(0).max(19),
  expectedGlobalRunCount: z.number().int().min(0).max(19),
  reservedBudgetRevision: z.number().int().min(2).max(1000),
  reservationDigest: hash,
  storageReservationBytes: z.literal(33554432),
  reservedSlots: object({
    events: z.literal(32),
    budgetEvents: z.literal(16),
    receipts: z.literal(64),
  }),
  runDigest: hash,
});
const reason = z.enum(["user-cancelled", "test-cleanup", "scope-expired"]);
const reservationRunEventSchema = object({
  schemaVersion: z.literal(2),
  runId: uuid,
  revision: z.literal(1),
  budgetRevision: z.number().int().min(1).max(1000),
  previousEventDigest: z.null(),
  recordedAt: date,
  payload: object({
    kind: z.literal("cancelled-before-dispatch"),
    reason,
    releaseBudgetEventDigest: hash,
  }),
  eventDigest: hash,
});
const reservationReceiptSchema = object({
  schemaVersion: z.literal(2),
  scopeId: scope,
  kind: z.enum(["provider-budget-configure", "provider-start", "provider-cancel"]),
  clientRequestId: uuid,
  inputDigest: hash,
  runId: uuid.nullable(),
  runRevision: z.union([z.literal(0), z.literal(1), z.null()]),
  budgetRevision: z.number().int().min(1).max(1000),
  operationDigest: hash,
  recordedAt: date,
});
const reservationArtifactSchema = object({
  runId: uuid,
  key: z.literal("generation-request"),
  body: z.string(),
  sha256: hash,
  sizeBytes: z
    .number()
    .int()
    .nonnegative()
    .max(8 * 1024 * 1024),
});
export const providerCancelSchema = object({
  clientRequestId: uuid,
  expectedRevision: z.literal(0),
  reason,
});
export const providerBudgetEventSchema = z.union([
  reservationBudgetEventSchema,
  execution.providerExecutionBudgetEventSchema,
]);
export const providerRunEventSchema = z.union([
  reservationRunEventSchema,
  execution.providerExecutionEventSchema,
]);
export const providerReceiptSchema = z.union([
  reservationReceiptSchema,
  execution.providerExecutionReceiptSchema,
]);
export const providerArtifactSchema = z.union([
  reservationArtifactSchema,
  execution.providerExecutionArtifactSchema,
]);

const omit = (value, key) => Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
const canonical = (value, wire = false) =>
  Array.isArray(value)
    ? value.map((v) => canonical(v, wire))
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (wire ? a.localeCompare(b) : a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => [k, canonical(v, wire)]),
        )
      : value;
export const providerRawDigest = (value) => createHash("sha256").update(value).digest("hex");
export const providerDigest = (value) => providerRawDigest(JSON.stringify(canonical(value)));
export const providerWireDigest = (value) =>
  providerRawDigest(JSON.stringify(canonical(value, true)));
const same = (a, b) => providerDigest(a) === providerDigest(b),
  bytes = (value) =>
    Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
const fail = () => {
  throw new Error("Provider ledger validation failed");
};
export const providerBudgetScope = (env) => {
  if (!["synthetic-test", "production"].includes(env)) fail();
  return env === "synthetic-test"
    ? "candidate-quality-provider-v2-synthetic"
    : "candidate-quality-provider-v2-live";
};
const envForScope = (value) => {
  scope.parse(value);
  return value.endsWith("-synthetic") ? "synthetic-test" : "production";
};
const sourceForEnv = (env) => (env === "synthetic-test" ? "synthetic-test" : "explicit-user");
export const providerStartDigestInput = (input) => ({
  kind: "provider-start",
  clientRequestId: input.clientRequestId,
  expectedBudgetRevision: input.expectedBudgetRevision,
  expectedBudgetDigest: input.expectedBudgetDigest,
  expectedScopeRunCount: input.expectedScopeRunCount,
  expectedGlobalRunCount: input.expectedGlobalRunCount,
  approvedPreparationDigest: input.preparation.preparationDigest,
  approval: input.approval,
});
export const providerCancelDigestInput = (runId, input) => ({
  kind: "provider-cancel",
  runId,
  ...input,
});
export const providerPolicyDigestInput = (input) => ({
  kind: "provider-budget-configure",
  ...input,
});
function validateFinance(value) {
  const f = financial.parse(value),
    c = f.evidence.context,
    p = f.evidence.pricing;
  const expected = f.evidenceMode;
  for (const e of [c, p]) {
    if (e.provenance !== expected || e.model !== f.model || !same(e.conditions, f.conditions))
      fail();
    const a = e.authority,
      n = Date.parse(f.calculatedAt);
    if (
      Date.parse(a.retrievedAt) > Date.parse(a.reviewedAt) ||
      Date.parse(a.reviewedAt) > n ||
      Date.parse(a.validUntil) <= n
    )
      fail();
    if (
      expected === "official-reviewed" &&
      !["openai.com", "www.openai.com", "developers.openai.com", "platform.openai.com"].includes(
        new URL(a.sourceUrl).hostname,
      )
    )
      fail();
  }
  if (c.contextWindowTokens < c.maxOutputTokens || c.maxOutputTokens < 16000) fail();
  const inputs = [],
    outputs = [];
  for (const name of ["shortContext", "longContext"]) {
    const b = p[name];
    if (b.applicability) continue;
    for (const channel of ["uncachedInput", "cacheReadInput", "cacheWriteInput"])
      if (!b[channel].applicability)
        inputs.push({ rate: b[channel], selectedFrom: `${name}.${channel}` });
    outputs.push({
      rate: b.outputIncludingReasoning,
      selectedFrom: `${name}.outputIncludingReasoning`,
    });
  }
  const highest = (values) =>
    values.reduce((a, b) =>
      BigInt(b.rate.units) * BigInt(a.rate.perTokens) >
      BigInt(a.rate.units) * BigInt(b.rate.perTokens)
        ? b
        : a,
    );
  const ir = highest(inputs),
    or = highest(outputs),
    ceil = (n, r) => (BigInt(n) * BigInt(r.units) + BigInt(r.perTokens) - 1n) / BigInt(r.perTokens);
  const i = ceil(c.contextWindowTokens, ir.rate),
    o = ceil(16000, or.rate),
    phase = {
      inputTokensReserved: c.contextWindowTokens,
      outputTokensReserved: 16000,
      inputUnits: i.toString(),
      outputUnits: o.toString(),
      totalUnits: (i + o).toString(),
    };
  if (
    !same(f.costs, {
      currency: p.currency,
      unitScale: p.unitScale,
      maximumInputRate: ir,
      maximumOutputRate: or,
      generation: phase,
      review: phase,
      totalUnits: ((i + o) * 2n).toString(),
      rounding: "ceil-each-rate-per-request",
    })
  )
    fail();
  return f;
}
export function validateProviderPreparation(value, registry) {
  const p = providerPreparationSchema.parse(value),
    f = validateFinance(p.financialBasis),
    s = p.scope;
  if (
    p.preparationDigest !== providerDigest(omit(p, "preparationDigest")) ||
    p.financialBasisDigest !== providerDigest(f) ||
    p.retentionDigest !== providerDigest(p.retention) ||
    p.budget.scopeId !== providerBudgetScope(p.environment) ||
    f.model !== p.model ||
    f.evidenceMode !==
      (p.environment === "synthetic-test" ? "synthetic-test" : "official-reviewed") ||
    f.calculatedAt !== p.preparedAt ||
    p.budget.currency !== f.costs.currency ||
    p.budget.unitScale !== f.costs.unitScale ||
    BigInt(p.budget.heldUnits) + BigInt(p.budget.recognizedUnits) + BigInt(f.costs.totalUnits) >
      BigInt(p.budget.capUnits)
  )
    fail();
  const time = Date.parse(p.preparedAt),
    expires = Date.parse(p.expiresAt);
  if (
    !(time < expires) ||
    expires > Date.parse(f.evidence.context.authority.validUntil) ||
    expires > Date.parse(f.evidence.pricing.authority.validUntil) ||
    Date.parse(p.retention.reviewedAt) > time ||
    expires > Date.parse(p.retention.validUntil)
  )
    fail();
  const entry = registry.entries.filter((v) => v.candidateId === s.candidateId),
    manifest = registry.manifest.filter((v) => v.candidateId === s.candidateId);
  if (
    registry.version !== s.version ||
    registry.versionDigest !== s.versionDigest ||
    entry.length !== 1 ||
    manifest.length !== 1
  )
    fail();
  const e = entry[0],
    m = manifest[0];
  if (
    s.sourceDigest !== m.sourceDigest ||
    s.candidateDigest !== m.candidateDigest ||
    s.modelInputDigest !== m.modelInputDigest ||
    s.sourceDigest !== providerDigest({ profile: e.input.profile, sources: e.input.sources }) ||
    s.candidateDigest !== providerDigest(e.input.candidate) ||
    s.modelInputDigest !== providerDigest(e.input)
  )
    fail();
  const ct = p.contract,
    base = ct.baseContract,
    g = p.generation,
    t = p.reviewTemplate;
  if (
    ct.contractDigest !== providerWireDigest(omit(ct, "contractDigest")) ||
    base.contractDigest !== providerWireDigest(omit(base, "contractDigest")) ||
    base.phases[0].phase !== "generation" ||
    base.phases[0].name !== "business_plan" ||
    base.phases[1].phase !== "review" ||
    base.phases[1].name !== "business_plan_review" ||
    base.phases[0].systemDigest !== base.phases[1].systemDigest ||
    g.requestDigest !== providerWireDigest(g.body) ||
    g.sha256 !== providerRawDigest(JSON.stringify(g.body)) ||
    g.inputChars !== g.body.input.reduce((n, v) => n + v.content.length, 0) ||
    g.body.model !== p.model ||
    t.model !== p.model ||
    t.contractDigest !== ct.contractDigest ||
    t.templateDigest !== providerWireDigest(omit(t, "templateDigest")) ||
    !same(t.requestOptions, ct.requestOptions)
  )
    fail();
  for (const [phase, systemMessage, fmt] of [
    ["generation", g.body.input[0], g.body.text.format],
    ["review", t.systemMessage, t.format],
  ]) {
    const d = base.phases.find((v) => v.phase === phase);
    if (!d || fmt.name !== d.name || providerWireDigest(fmt) !== d.schemaDigest) fail();
    const marker = systemMessage.content.lastIndexOf("\n\n");
    if (
      marker < 0 ||
      providerWireDigest(systemMessage.content.slice(0, marker)) !== d.systemDigest ||
      providerWireDigest(systemMessage.content.slice(marker + 2)) !== d.instructionDigest
    )
      fail();
  }
  const generation = JSON.parse(g.body.input[1].content),
    fixed = t.fixedUserContext,
    profile = omit(e.input.profile, "businessNumber"),
    sources = e.input.sources.filter((v) => v.extraction !== "pending");
  if (
    !same(generation.profile, profile) ||
    !same(fixed.profile, profile) ||
    generation.unextractedSourceCount !== e.input.sources.length - sources.length ||
    !same(omit(generation, "sectionDefinitions"), {
      ...fixed,
      selectedCandidate: generation.selectedCandidate,
    }) ||
    !same(fixed.selectedCandidate, e.input.candidate) ||
    generation.selectedCandidate.classification !==
      (e.input.candidate.classification ?? "unknown") ||
    !same(
      omit(generation.selectedCandidate, "classification"),
      omit(e.input.candidate, "classification"),
    )
  )
    fail();
  const kinds = {
    consultation: "상담·녹취",
    patent: "특허·지식재산",
    technology: "기술·제품",
    finance: "재무·자금",
    market: "시장·고객",
    team: "인력·협업",
    other: "기타 서류",
  };
  // Frozen v2 labels and section order; archival reads do not import today's engine.
  const sections = [
    { key: "problem", title: "개발 필요성과 고객의 문제" },
    { key: "solution", title: "신청기술의 구성과 해결방법" },
    { key: "differentiation", title: "기술 차별성과 경쟁 비교" },
    { key: "development", title: "개발 경과와 향후 3년 계획" },
    { key: "team", title: "대표·기술인력과 연구개발 역량" },
    { key: "ip", title: "지식재산권과 기술 활용" },
    { key: "market", title: "목표시장·고객과 경쟁환경" },
    { key: "commercialization", title: "사업화·시장진입·협업 전략" },
    { key: "funding", title: "자금 조달·운용과 실행계획" },
    { key: "performance", title: "사업성과와 지속적인 혁신" },
  ];
  for (const list of [generation.sources, fixed.sources]) {
    if (!Array.isArray(list) || list.length !== sources.length) fail();
    for (const [index, item] of list.entries()) {
      const src = sources[index];
      if (
        !same(omit(item, "kind"), {
          sourceId: src.id,
          name: src.name,
          text: src.text,
          warnings: src.warnings,
        }) ||
        item.kind !== kinds[src.kind]
      )
        fail();
    }
  }
  if (
    Object.keys(generation).sort().join() !==
      [
        "profile",
        "preparationContext",
        "unextractedSourceCount",
        "sources",
        "selectedCandidate",
        "sectionDefinitions",
      ]
        .sort()
        .join() ||
    Object.keys(fixed).sort().join() !==
      ["profile", "preparationContext", "unextractedSourceCount", "sources", "selectedCandidate"]
        .sort()
        .join() ||
    typeof fixed.preparationContext !== "string" ||
    !same(generation.sectionDefinitions, sections)
  )
    fail();
  return p;
}
export const createProviderBudgetEvent = (input) =>
  providerBudgetEventSchema.parse({ ...input, eventDigest: providerDigest(input) });
export const createProviderRunEvent = (input) =>
  providerRunEventSchema.parse({ ...input, eventDigest: providerDigest(input) });
export const createProviderReceipt = (input) => providerReceiptSchema.parse(input);
export const createProviderArtifact = ({ runId, body }) =>
  providerArtifactSchema.parse({
    runId,
    key: "generation-request",
    body,
    sha256: providerRawDigest(body),
    sizeBytes: bytes(body),
  });
export function createProviderRun({ input, id, recordedAt, reservation }) {
  const p = input.preparation,
    value = {
      schemaVersion: 2,
      archiveFormatVersion: 2,
      id,
      clientRequestId: input.clientRequestId,
      inputDigest: providerDigest(providerStartDigestInput(input)),
      recordedAt,
      environment: p.environment,
      executionKind:
        p.environment === "synthetic-test"
          ? "provider-contract-simulation"
          : "provider-ai-execution",
      observedTransport: "none",
      actualAiCalls: 0,
      preparation: p,
      approval: input.approval,
      expectedBudgetRevision: input.expectedBudgetRevision,
      expectedBudgetDigest: input.expectedBudgetDigest,
      expectedScopeRunCount: input.expectedScopeRunCount,
      expectedGlobalRunCount: input.expectedGlobalRunCount,
      reservedBudgetRevision: reservation.revision,
      reservationDigest: reservation.eventDigest,
      storageReservationBytes: 33554432,
      reservedSlots: { events: 32, budgetEvents: 16, receipts: 64 },
    };
  return providerRunSchema.parse({ ...value, runDigest: providerDigest(value) });
}
export function validateProviderBudgetLedger(values, scopeId) {
  if (values.some((v) => ["recognize-usage", "release-phase"].includes(v.payload?.kind)))
    return execution.getProviderExecutionBudgetSnapshot(values, scopeId);
  const env = envForScope(scopeId),
    events = values.map((v) => providerBudgetEventSchema.parse(v));
  if (events.length > 1000) fail();
  let cap = 0n,
    currency = null,
    unitScale = null,
    head = null;
  const reservations = [],
    ids = new Set();
  for (const [index, e] of events.entries()) {
    if (
      e.scopeId !== scopeId ||
      e.environment !== env ||
      e.provenance !== sourceForEnv(env) ||
      e.revision !== index + 1 ||
      e.previousDigest !== head ||
      e.eventDigest !== providerDigest(omit(e, "eventDigest")) ||
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
      if (reservations.some((v) => v.runId === p.runId)) fail();
      const held = reservations.reduce((n, v) => n + BigInt(v.heldUnits), 0n),
        amount = BigInt(p.generationUnits) + BigInt(p.reviewUnits);
      if (held + amount > cap) fail();
      reservations.push({
        runId: p.runId,
        reservationDigest: e.eventDigest,
        generationUnits: p.generationUnits,
        reviewUnits: p.reviewUnits,
        heldUnits: amount.toString(),
        released: false,
      });
    } else {
      const r = reservations.find((v) => v.runId === p.runId);
      if (
        !r ||
        r.released ||
        r.reservationDigest !== p.reservationDigest ||
        r.generationUnits !== p.generationUnits ||
        r.reviewUnits !== p.reviewUnits
      )
        fail();
      r.heldUnits = "0";
      r.released = true;
    }
  }
  const held = reservations.reduce((n, v) => n + BigInt(v.heldUnits), 0n);
  return {
    scopeId,
    environment: env,
    revision: events.length,
    headDigest: head,
    currency,
    unitScale,
    capUnits: cap.toString(),
    heldUnits: held.toString(),
    recognizedUnits: "0",
    availableUnits: (cap - held).toString(),
    reservations,
  };
}
export function validateProviderRunLedger({
  run: raw,
  events: rawEvents,
  artifacts: rawArtifacts,
  budgetEvents,
  receipts: rawReceipts,
  registry,
}) {
  if (rawEvents.some((v) => v.executionContractVersion === 1)) {
    const startSnapshot = validateProviderRunLedger({
      run: raw,
      events: [],
      artifacts: rawArtifacts.filter((v) => v.key === "generation-request"),
      budgetEvents: budgetEvents.slice(0, raw.reservedBudgetRevision),
      receipts: rawReceipts.filter((v) => v.kind === "provider-start"),
      registry,
    });
    return execution.validateProviderExecutionLedger({
      run: raw,
      events: rawEvents,
      artifacts: rawArtifacts,
      budgetEvents,
      receipts: rawReceipts,
      registry,
      startSnapshot,
    });
  }
  const run = providerRunSchema.parse(raw),
    events = rawEvents.map((v) => providerRunEventSchema.parse(v)),
    artifacts = rawArtifacts.map((v) => providerArtifactSchema.parse(v)),
    receipts = rawReceipts.map((v) => providerReceiptSchema.parse(v));
  const p = validateProviderPreparation(run.preparation, registry),
    scopeId = providerBudgetScope(run.environment),
    budget = validateProviderBudgetLedger(budgetEvents, scopeId);
  if (
    run.runDigest !== providerDigest(omit(run, "runDigest")) ||
    run.environment !== p.environment ||
    run.executionKind !==
      (run.environment === "synthetic-test"
        ? "provider-contract-simulation"
        : "provider-ai-execution") ||
    run.approval.provenance !== sourceForEnv(run.environment) ||
    run.approval.approvedPreparationDigest !== p.preparationDigest ||
    Date.parse(run.approval.approvedAt) < Date.parse(p.preparedAt) ||
    Date.parse(run.recordedAt) < Date.parse(run.approval.approvedAt) ||
    Date.parse(run.recordedAt) >= Date.parse(run.approval.expiresAt) ||
    Date.parse(run.approval.expiresAt) > Date.parse(p.expiresAt) ||
    run.expectedGlobalRunCount < run.expectedScopeRunCount ||
    bytes(run) > 2 * 1024 * 1024 ||
    events.length > 1 ||
    artifacts.length !== 1
  )
    fail();
  const start = {
    clientRequestId: run.clientRequestId,
    expectedBudgetRevision: run.expectedBudgetRevision,
    expectedBudgetDigest: run.expectedBudgetDigest,
    expectedScopeRunCount: run.expectedScopeRunCount,
    expectedGlobalRunCount: run.expectedGlobalRunCount,
    preparation: p,
    approval: run.approval,
  };
  if (run.inputDigest !== providerDigest(providerStartDigestInput(start))) fail();
  const reserve = budgetEvents.find((v) => v.eventDigest === run.reservationDigest),
    prior = validateProviderBudgetLedger(
      budgetEvents.slice(0, run.expectedBudgetRevision),
      scopeId,
    );
  if (
    !reserve ||
    reserve.payload.kind !== "reserve-run" ||
    reserve.payload.runId !== run.id ||
    reserve.revision !== run.reservedBudgetRevision ||
    reserve.revision !== run.expectedBudgetRevision + 1 ||
    reserve.eventId !== run.clientRequestId ||
    reserve.recordedAt !== run.recordedAt ||
    reserve.payload.preparationDigest !== p.preparationDigest ||
    reserve.payload.generationUnits !== p.financialBasis.costs.generation.totalUnits ||
    reserve.payload.reviewUnits !== p.financialBasis.costs.review.totalUnits ||
    prior.headDigest !== run.expectedBudgetDigest ||
    p.budget.revision !== prior.revision ||
    p.budget.headDigest !== prior.headDigest ||
    p.budget.capUnits !== prior.capUnits ||
    p.budget.heldUnits !== prior.heldUnits ||
    p.budget.recognizedUnits !== prior.recognizedUnits ||
    p.budget.currency !== prior.currency ||
    p.budget.unitScale !== prior.unitScale
  )
    fail();
  const a = artifacts[0];
  if (
    a.runId !== run.id ||
    a.body !== JSON.stringify(p.generation.body) ||
    a.sha256 !== providerRawDigest(a.body) ||
    a.sizeBytes !== bytes(a.body)
  )
    fail();
  const startReceipt = receipts.find((v) => v.kind === "provider-start");
  if (
    !startReceipt ||
    startReceipt.scopeId !== scopeId ||
    startReceipt.runId !== run.id ||
    startReceipt.runRevision !== 0 ||
    startReceipt.clientRequestId !== run.clientRequestId ||
    startReceipt.inputDigest !== run.inputDigest ||
    startReceipt.operationDigest !== run.runDigest ||
    startReceipt.recordedAt !== run.recordedAt ||
    startReceipt.budgetRevision !== reserve.revision
  )
    fail();
  let head = reserve.revision;
  const linked = new Set([reserve.eventDigest]);
  if (events.length) {
    const e = events[0],
      release = budgetEvents.find((v) => v.eventDigest === e.payload.releaseBudgetEventDigest),
      r = receipts.find((v) => v.kind === "provider-cancel");
    if (
      e.runId !== run.id ||
      e.eventDigest !== providerDigest(omit(e, "eventDigest")) ||
      !release ||
      release.payload.kind !== "release-run" ||
      release.payload.runId !== run.id ||
      release.payload.reservationDigest !== run.reservationDigest ||
      e.budgetRevision !== release.revision ||
      e.budgetRevision <= reserve.revision ||
      release.recordedAt !== e.recordedAt ||
      !r ||
      release.eventId !== r.clientRequestId ||
      r.scopeId !== scopeId ||
      r.runId !== run.id ||
      r.runRevision !== 1 ||
      r.budgetRevision !== e.budgetRevision ||
      r.operationDigest !== e.eventDigest ||
      r.recordedAt !== e.recordedAt ||
      r.inputDigest !==
        providerDigest(
          providerCancelDigestInput(run.id, {
            clientRequestId: r.clientRequestId,
            expectedRevision: 0,
            reason: e.payload.reason,
          }),
        )
    )
      fail();
    head = e.budgetRevision;
    linked.add(release.eventDigest);
  }
  const ownBudget = budgetEvents.filter((v) => v.payload.runId === run.id);
  if (
    ownBudget.some((v) => !linked.has(v.eventDigest)) ||
    receipts.length !== events.length + 1 ||
    new Set(receipts.map((v) => v.clientRequestId)).size !== receipts.length
  )
    fail();
  const usedBytes =
    bytes(run) +
    events.reduce((n, v) => n + bytes(v), 0) +
    artifacts.reduce((n, v) => n + v.sizeBytes, 0) +
    ownBudget.reduce((n, v) => n + bytes(v), 0) +
    receipts.reduce((n, v) => n + bytes(v), 0);
  if (usedBytes > 33554432) fail();
  void budget;
  const snapshot = {
    schemaVersion: 2,
    archiveFormatVersion: 2,
    run,
    revision: events.length,
    events,
    artifacts: artifacts.map((v) => omit(v, "body")),
    budgetEvents: budgetEvents.slice(0, head),
    state: events.length ? "cancelled-before-dispatch" : "reserved",
    actualAiCalls: 0,
    dispatchAllowed: false,
    canResume: false,
    storage: {
      usedBytes,
      heldBytes: events.length ? 0 : 33554432 - usedBytes,
      remainingEventSlots: events.length ? 0 : 32,
      remainingBudgetEventSlots: events.length ? 0 : 16 - ownBudget.length,
      remainingReceiptSlots: events.length ? 0 : 64 - receipts.length,
    },
  };
  return { ...snapshot, snapshotDigest: providerDigest(snapshot) };
}
export function inspectProviderLedger({
  runs: rawRuns,
  events,
  artifacts,
  budgetEvents,
  receipts: rawReceipts,
  registries,
  otherNonces = [],
}) {
  const runs = rawRuns.map((v) => providerRunSchema.parse(v)),
    receipts = rawReceipts.map((v) => providerReceiptSchema.parse(v));
  if (
    runs.length > 20 ||
    events.length > 640 ||
    artifacts.length > 140 ||
    budgetEvents.length > 1000 ||
    receipts.length > 1000
  )
    fail();
  const ids = new Set(runs.map((v) => v.id));
  if (
    ids.size !== runs.length ||
    new Set([...otherNonces, ...receipts.map((v) => v.clientRequestId)]).size !==
      otherNonces.length + receipts.length
  )
    fail();
  const budgets = [],
    snapshots = [];
  for (const env of ["synthetic-test", "production"]) {
    const scopeId = providerBudgetScope(env),
      scoped = budgetEvents.filter((v) => v.scopeId === scopeId),
      budget = validateProviderBudgetLedger(scoped, scopeId);
    budgets.push(budget);
    const ordered = runs
      .filter((v) => v.environment === env)
      .sort((a, b) => a.expectedScopeRunCount - b.expectedScopeRunCount);
    for (const [index, run] of ordered.entries()) {
      if (
        run.expectedScopeRunCount !== index ||
        (index && run.reservedBudgetRevision <= ordered[index - 1].reservedBudgetRevision)
      )
        fail();
      for (const previous of ordered.slice(0, index)) {
        if (previous.preparation.scope.candidateId !== run.preparation.scope.candidateId) continue;
        const priorSnapshot = snapshots.find((v) => v.run.id === previous.id);
        if (
          !priorSnapshot ||
          !(
            priorSnapshot.state === "cancelled-before-dispatch" ||
            priorSnapshot.eligibleForNewCandidateRun === true
          )
        )
          fail();
        const lastReceipt = receipts
          .filter((v) => v.runId === previous.id)
          .sort((a, b) => b.runRevision - a.runRevision)[0];
        if (!lastReceipt || lastReceipt.budgetRevision >= run.reservedBudgetRevision) fail();
      }
      const registry = registries.filter((v) => v.version === run.preparation.scope.version);
      if (registry.length !== 1) fail();
      snapshots.push(
        validateProviderRunLedger({
          run,
          events: events.filter((v) => v.runId === run.id),
          artifacts: artifacts.filter((v) => v.runId === run.id),
          budgetEvents: scoped,
          receipts: receipts.filter((v) => v.runId === run.id),
          registry: registry[0],
        }),
      );
    }
    const policies = receipts.filter((v) => v.runId === null && v.scopeId === scopeId);
    if (scoped.length) {
      const e = scoped[0],
        r = policies[0];
      if (
        policies.length !== 1 ||
        r.kind !== "provider-budget-configure" ||
        r.runRevision !== null ||
        r.budgetRevision !== 1 ||
        r.clientRequestId !== e.eventId ||
        r.operationDigest !== e.eventDigest ||
        r.recordedAt !== e.recordedAt ||
        r.inputDigest !==
          providerDigest(
            providerPolicyDigestInput({
              clientRequestId: r.clientRequestId,
              expectedRevision: 0,
              policy: {
                environment: env,
                provenance: e.provenance,
                currency: e.currency,
                unitScale: e.unitScale,
                capUnits: e.payload.capUnits,
              },
            }),
          )
      )
        fail();
    } else if (policies.length) fail();
  }
  for (const row of [...events, ...artifacts]) if (!ids.has(row.runId)) fail();
  for (const r of receipts) if (r.runId !== null && !ids.has(r.runId)) fail();
  for (const e of budgetEvents) {
    const owner = e.payload.runId && runs.find((v) => v.id === e.payload.runId);
    if (
      ![providerBudgetScope("synthetic-test"), providerBudgetScope("production")].includes(
        e.scopeId,
      ) ||
      (e.payload.runId &&
        (!owner ||
          e.scopeId !== providerBudgetScope(owner.environment) ||
          e.environment !== owner.environment))
    )
      fail();
  }
  const reservedBytes = snapshots.reduce((n, v) => n + v.storage.heldBytes, 0),
    reservedBudgetEventSlots = snapshots.reduce(
      (n, v) => n + v.storage.remainingBudgetEventSlots,
      0,
    ),
    reservedReceiptSlots = snapshots.reduce((n, v) => n + v.storage.remainingReceiptSlots, 0);
  const usedBytes =
    [...runs, ...events, ...budgetEvents, ...receipts].reduce((n, v) => n + bytes(v), 0) +
    artifacts.reduce((n, v) => n + v.sizeBytes, 0);
  if (
    usedBytes + reservedBytes > 256 * 1024 * 1024 ||
    budgetEvents.length + reservedBudgetEventSlots > 1000 ||
    receipts.length + reservedReceiptSlots > 1000
  )
    fail();
  return {
    budgets,
    snapshots,
    reservedBytes,
    reservedBudgetEventSlots,
    reservedReceiptSlots,
    usedBytes,
  };
}
