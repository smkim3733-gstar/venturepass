import { z } from "zod";
import {
  providerReviewViewSchema,
  providerReviewDigestInput,
  providerReviewDownloadName,
  providerProposalConfigurationDigestInput,
  providerProposalSourceDigestInput,
  providerLedgerNotice,
  providerLedgerArtifactKeySchema,
  providerLedgerDownloadName,
  providerLedgerArtifactName,
  type ProviderReviewView,
  type ProviderReviewProposalView,
  type ProviderLedgerOverview,
  type ProviderLedgerArtifactKey,
} from "@/lib/studio-plan-quality-provider-review-types";
import { createProviderContextReservation } from "@/lib/studio-plan-quality-provider-reservation";
import { sectionDefinitions, sourceKindLabels } from "@/lib/studio-schema";
import { trackContext } from "@/lib/studio-preparation-context";
import type { CandidateRegistrySnapshot } from "@/lib/studio-plan-quality-candidate-registry-types";
import type {
  ProviderSnapshot,
  ProviderReceipt,
  ProviderBudgetSnapshot,
} from "@/lib/studio-plan-quality-provider-types";
import {
  candidateRegistryCanonical as canonical,
  candidateRegistryDigest as digest,
  candidateRegistrySnapshot,
} from "./quality-candidate-registry-ui";

export const qualityProviderReviewInspectUrl = "/api/studio/quality/provider-review/inspect";
export const qualityProviderLedgerBase = "/api/studio/quality/provider-ledger";
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const integer = z.number().int().nonnegative().safe();
const units = z.string().regex(/^(0|[1-9]\d{0,79})$/);
const object = z.record(z.string(), z.unknown());
const scope = z.enum([
  "candidate-quality-provider-v2-synthetic",
  "candidate-quality-provider-v2-live",
]);
const environment = z.enum(["synthetic-test", "production"]);
const artifactRef = z
  .object({
    runId: uuid,
    key: providerLedgerArtifactKeySchema,
    sha256: sha,
    sizeBytes: integer.max(4194304),
  })
  .strict();
const storage = z
  .object({
    usedBytes: integer.max(33554432),
    heldBytes: integer.max(33554432),
    remainingEventSlots: integer.max(32),
    remainingBudgetEventSlots: integer.max(16),
    remainingReceiptSlots: integer.max(64),
  })
  .strict();
const eventSchema = z
  .object({
    schemaVersion: z.literal(2),
    executionContractVersion: z.literal(1).optional(),
    runId: uuid,
    revision: integer.min(1).max(32),
    budgetRevision: integer.min(1),
    previousEventDigest: sha.nullable(),
    recordedAt: z.string().datetime(),
    payload: object,
    eventDigest: sha,
  })
  .strict();
const budgetEventSchema = z
  .object({
    schemaVersion: z.literal(2),
    scopeId: scope,
    environment,
    provenance: z.enum(["synthetic-test", "explicit-user"]),
    revision: integer.min(1),
    previousDigest: sha.nullable(),
    eventId: uuid,
    recordedAt: z.string().datetime(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    unitScale: integer.max(12),
    payload: object,
    eventDigest: sha,
  })
  .strict();
const snapshotSchema = z
  .object({
    schemaVersion: z.literal(2),
    archiveFormatVersion: z.union([z.literal(2), z.literal(3)]),
    run: object,
    revision: integer.max(32),
    events: z.array(eventSchema).max(32),
    artifacts: z.array(artifactRef).min(1).max(7),
    budgetEvents: z.array(budgetEventSchema).min(2).max(1024),
    state: z.string(),
    actualAiCalls: z.union([z.literal(0), z.null()]),
    dispatchAllowed: z.literal(false),
    canResume: z.literal(false),
    terminal: z.boolean().optional(),
    unsettled: z.boolean().optional(),
    eligibleForNewCandidateRun: z.boolean().optional(),
    dispatchIntentCount: integer.max(2).optional(),
    responseCount: integer.max(2).optional(),
    unobservedDispatchCount: integer.max(2).optional(),
    storage,
    snapshotDigest: sha,
  })
  .strict();
const receiptSchema = z
  .object({
    schemaVersion: z.literal(2),
    scopeId: scope,
    kind: z.enum([
      "provider-budget-configure",
      "provider-start",
      "provider-cancel",
      "provider-approve",
      "provider-prepared",
      "provider-dispatch",
      "provider-response",
      "provider-validated",
      "provider-finish",
    ]),
    clientRequestId: uuid,
    inputDigest: sha,
    runId: uuid.nullable(),
    runRevision: integer.max(32).nullable(),
    budgetRevision: integer.min(1),
    operationDigest: sha,
    recordedAt: z.string().datetime(),
  })
  .strict();
const budgetSchema = z
  .object({
    scopeId: scope,
    environment,
    revision: integer,
    headDigest: sha.nullable(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable(),
    unitScale: integer.max(12).nullable(),
    capUnits: units,
    heldUnits: units,
    recognizedUnits: units,
    availableUnits: units,
    deficitUnits: units.optional(),
    boundBreached: z.boolean().optional(),
    reservations: z
      .array(
        z
          .object({
            runId: uuid,
            reservationDigest: sha,
            generationUnits: units,
            reviewUnits: units,
            heldUnits: units,
            released: z.boolean(),
            phases: z
              .array(
                z
                  .object({
                    phase: z.enum(["generation", "review"]),
                    reservedUnits: units,
                    heldUnits: units,
                    recognizedUnits: units,
                    releasedUnits: units,
                    settled: z.boolean(),
                  })
                  .strict(),
              )
              .length(2)
              .optional(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
const omit = <T extends object>(value: T, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const scopeFor = (env: string) =>
  env === "synthetic-test"
    ? "candidate-quality-provider-v2-synthetic"
    : "candidate-quality-provider-v2-live";
function requireMatch(condition: unknown): asserts condition {
  if (!condition)
    throw new Error("선택한 후보·원장·원문의 연결을 확인하지 못했습니다. 다시 조회해 주세요.");
}
const bytes = (text: string) => new TextEncoder().encode(text);
async function rawSha(text: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(text))), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
function wireValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(wireValue);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, wireValue(v)]),
    );
  return value;
}
const wireDigest = (value: unknown) => rawSha(JSON.stringify(wireValue(value)));
function boundedJson(text: string, max: number) {
  requireMatch(typeof text === "string" && bytes(text).length <= max);
  return JSON.parse(text) as unknown;
}
async function hashField(value: object, field: string) {
  requireMatch((await digest(omit(value, field))) === (value as Record<string, unknown>)[field]);
}

async function selected(registry: CandidateRegistrySnapshot, candidateId: string) {
  const checked = await candidateRegistrySnapshot(registry, registry);
  const entry = checked.manifest.find((v) => v.candidateId === candidateId);
  requireMatch(entry);
  return entry;
}

/** Proposal binding only; this does not authenticate sources or authorize provider execution. */
async function checkProposal(
  value: ProviderReviewProposalView,
  registry: CandidateRegistrySnapshot,
) {
  const { proposal, financialBasis: basis } = value;
  const request = proposal.requestReview;
  const now = Date.parse(value.inspectedAt);
  requireMatch(
    request.model === value.model &&
      basis.model === value.model &&
      basis.calculatedAt === value.inspectedAt &&
      same(request.scope, {
        version: value.scope.version,
        versionDigest: value.scope.versionDigest,
        candidateId: value.scope.candidateId,
        sourceDigest: value.scope.sourceDigest,
        candidateDigest: value.scope.candidateDigest,
        modelInputDigest: value.scope.modelInputDigest,
      }),
  );
  const recalculated = createProviderContextReservation({
    evidenceMode: "official-reviewed",
    model: value.model,
    calculatedAt: value.inspectedAt,
    outputReservationTokens: 16000,
    conditions: basis.conditions,
    context: basis.evidence.context,
    pricing: basis.evidence.pricing,
  });
  requireMatch(same(recalculated, basis));
  requireMatch(
    (await digest(providerProposalConfigurationDigestInput(value))) ===
      proposal.configurationDigest &&
      (await digest(basis)) === proposal.usagePolicy.financialBasisDigest &&
      proposal.usagePolicy.configuredModel === value.model &&
      new Set(proposal.usagePolicy.responseModels).size ===
        proposal.usagePolicy.responseModels.length &&
      proposal.proposedBudget.currency === basis.costs.currency &&
      proposal.proposedBudget.unitScale === basis.costs.unitScale &&
      BigInt(proposal.proposedBudget.capUnits) > BigInt(0) &&
      BigInt(proposal.proposedBudget.capUnits) >= BigInt(basis.costs.totalUnits),
  );
  requireMatch(
    new Set(proposal.sources.map((source) => source.id)).size === proposal.sources.length,
  );
  for (const source of proposal.sources) {
    requireMatch(
      (await rawSha(source.excerpt)) === source.excerptSha256 &&
        (await digest(providerProposalSourceDigestInput(source))) === source.recordDigest &&
        (source.bodySha256 !== null || source.digestKind === "curated-record") &&
        Date.parse(source.retrievedAt) <= Date.parse(source.reviewedAt) &&
        Date.parse(source.reviewedAt) <= now &&
        now < Date.parse(source.validUntil),
    );
  }
  for (const authority of [
    basis.evidence.context.authority,
    basis.evidence.pricing.authority,
    value.retention,
    proposal.usagePolicy.authority,
  ])
    requireMatch(
      proposal.sources.some(
        (source) =>
          source.url === authority.sourceUrl &&
          (source.digestKind === "body" ? source.bodySha256 : source.recordDigest) ===
            authority.documentDigest &&
          source.reviewedAt === authority.reviewedAt &&
          source.validUntil === authority.validUntil &&
          (!("retrievedAt" in authority) || authority.retrievedAt === source.retrievedAt) &&
          (!("excerpt" in authority) || authority.excerpt === source.excerpt),
      ),
    );
  const { contract, generation, reviewTemplate: template } = request;
  requireMatch(
    (await wireDigest(omit(contract, "contractDigest"))) === contract.contractDigest &&
      (await wireDigest(omit(contract.baseContract, "contractDigest"))) ===
        contract.baseContract.contractDigest &&
      (await wireDigest(omit(template, "templateDigest"))) === template.templateDigest &&
      template.contractDigest === contract.contractDigest &&
      (await wireDigest(generation.body)) === generation.requestDigest &&
      (await rawSha(JSON.stringify(generation.body))) === generation.sha256 &&
      generation.body.model === value.model &&
      template.model === value.model &&
      generation.inputChars ===
        generation.body.input.reduce((count, message) => count + message.content.length, 0) &&
      generation.inputChars <= contract.baseContract.maxInputChars &&
      same(template.requestOptions, contract.requestOptions),
  );
  for (const [key, option] of Object.entries(contract.requestOptions))
    requireMatch(generation.body[key as keyof typeof contract.requestOptions] === option);
  for (const [index, content, format] of [
    [0, generation.body.input[0].content, generation.body.text.format],
    [1, template.systemMessage.content, template.format],
  ] as const) {
    const phase = contract.baseContract.phases[index];
    const split = content.lastIndexOf("\n\n");
    requireMatch(
      split > 0 &&
        format.name === phase.name &&
        (await wireDigest(content.slice(0, split))) === phase.systemDigest &&
        (await wireDigest(content.slice(split + 2))) === phase.instructionDigest &&
        (await wireDigest(format)) === phase.schemaDigest,
    );
  }
  const original = registry.entries.find(
    (entry) => entry.candidateId === value.scope.candidateId,
  )!.input;
  const sources = original.sources
    .filter((source) => source.extraction !== "pending")
    .map((source) => ({
      sourceId: source.id,
      name: source.name,
      kind: sourceKindLabels[source.kind],
      text: source.text,
      warnings: source.warnings,
    }));
  const common = {
    profile: omit(original.profile, "businessNumber"),
    preparationContext: trackContext({ profile: original.profile }),
    unextractedSourceCount: original.sources.length - sources.length,
    sources,
  };
  requireMatch(
    same(boundedJson(generation.body.input[1].content, 2 * 1024 * 1024), {
      ...common,
      selectedCandidate: {
        ...original.candidate,
        classification: original.candidate.classification ?? "unknown",
      },
      sectionDefinitions,
    }) && same(template.fixedUserContext, { ...common, selectedCandidate: original.candidate }),
  );
}
export async function qualityProviderReview(
  raw: unknown,
  registry: CandidateRegistrySnapshot,
  candidateId: string,
): Promise<ProviderReviewView> {
  const value = providerReviewViewSchema.parse(raw),
    entry = await selected(registry, candidateId);
  requireMatch(
    same(value.scope, {
      version: registry.version,
      versionDigest: registry.versionDigest,
      candidateId,
      setId: registry.setId,
      registrySourceDigest: registry.sourceDigest,
      manifestDigest: registry.manifestDigest,
      label: entry.label,
      sourceDigest: entry.sourceDigest,
      candidateDigest: entry.candidateDigest,
      modelInputDigest: entry.modelInputDigest,
    }),
  );
  requireMatch((await digest(providerReviewDigestInput(value))) === value.viewDigest);
  if (value.state === "proposal-only") await checkProposal(value, registry);
  return value;
}
export async function qualityProviderReviewArchive(
  raw: unknown,
  registry: CandidateRegistrySnapshot,
  candidateId: string,
) {
  const value = await qualityProviderReview(raw, registry, candidateId);
  return {
    text: JSON.stringify(value, null, 2) + "\n",
    filename: providerReviewDownloadName(value),
  };
}

/** Display/download binding only. Authoritative financial/domain validation remains on the server. */
async function checkSnapshot(raw: unknown): Promise<ProviderSnapshot> {
  const parsed = snapshotSchema.parse(structuredClone(raw)),
    s = parsed as unknown as ProviderSnapshot,
    r = s.run,
    p = r.preparation;
  uuid.parse(r.id);
  uuid.parse(r.clientRequestId);
  environment.parse(r.environment);
  requireMatch(
    r.schemaVersion === 2 &&
      r.archiveFormatVersion === 2 &&
      r.actualAiCalls === 0 &&
      r.observedTransport === "none" &&
      r.storageReservationBytes === 33554432 &&
      same(r.reservedSlots, { events: 32, budgetEvents: 16, receipts: 64 }),
  );
  requireMatch(
    r.executionKind ===
      (r.environment === "synthetic-test"
        ? "provider-contract-simulation"
        : "provider-ai-execution") &&
      p.environment === r.environment &&
      p.budget.scopeId === scopeFor(r.environment),
  );
  requireMatch(
    r.approval.provenance ===
      (r.environment === "synthetic-test" ? "synthetic-test" : "explicit-user") &&
      r.approval.approvedPreparationDigest === p.preparationDigest,
  );
  requireMatch(
    s.actualAiCalls ===
      (s.archiveFormatVersion === 2 || r.environment === "synthetic-test" ? 0 : null),
  );
  requireMatch(
    p.schemaVersion === 2 &&
      p.kind === "provider-execution-preparation" &&
      same(p.permissions, {
        dispatchAllowed: false,
        tokenFitVerified: false,
        accountAccessVerified: false,
      }),
  );
  await Promise.all([
    hashField(s, "snapshotDigest"),
    hashField(r, "runDigest"),
    hashField(p, "preparationDigest"),
  ]);
  requireMatch(
    (await wireDigest(omit(p.contract, "contractDigest"))) === p.contract.contractDigest &&
      (await wireDigest(omit(p.contract.baseContract, "contractDigest"))) ===
        p.contract.baseContract.contractDigest &&
      (await wireDigest(omit(p.reviewTemplate, "templateDigest"))) ===
        p.reviewTemplate.templateDigest,
  );
  requireMatch(
    (await digest(p.financialBasis)) === p.financialBasisDigest &&
      (await digest(p.retention)) === p.retentionDigest,
  );
  requireMatch(
    (await rawSha(JSON.stringify(p.generation.body))) === p.generation.sha256 &&
      (await wireDigest(p.generation.body)) === p.generation.requestDigest,
  );
  requireMatch(
    (await digest({
      kind: "provider-start",
      clientRequestId: r.clientRequestId,
      expectedBudgetRevision: r.expectedBudgetRevision,
      expectedBudgetDigest: r.expectedBudgetDigest,
      expectedScopeRunCount: r.expectedScopeRunCount,
      expectedGlobalRunCount: r.expectedGlobalRunCount,
      approvedPreparationDigest: p.preparationDigest,
      approval: r.approval,
    })) === r.inputDigest,
  );
  requireMatch(
    s.events.length === s.revision &&
      new Set(s.artifacts.map((a) => a.key)).size === s.artifacts.length &&
      s.artifacts.every((a) => a.runId === r.id),
  );
  const allowed = new Map<string, string>([["generation-request", p.generation.sha256]]);
  let state = "reserved",
    stopped = false,
    stopRevision = 0,
    previousBudget = r.reservedBudgetRevision;
  const prepared = new Map<string, ProviderSnapshot["events"][number]>(),
    dispatch = new Map<string, ProviderSnapshot["events"][number]>(),
    response = new Map<string, ProviderSnapshot["events"][number]>(),
    validated = new Map<string, ProviderSnapshot["events"][number]>();
  let approvalDigest: string | null = null;
  for (const [i, e] of s.budgetEvents.entries()) {
    requireMatch(
      e.revision === i + 1 &&
        e.previousDigest === (i ? s.budgetEvents[i - 1].eventDigest : null) &&
        e.scopeId === p.budget.scopeId &&
        e.environment === r.environment &&
        e.provenance === r.approval.provenance &&
        e.currency === p.budget.currency &&
        e.unitScale === p.budget.unitScale,
    );
    await hashField(e, "eventDigest");
  }
  const reserve = s.budgetEvents[r.reservedBudgetRevision - 1];
  requireMatch(
    reserve?.eventDigest === r.reservationDigest &&
      reserve.payload.kind === "reserve-run" &&
      reserve.payload.runId === r.id &&
      reserve.payload.preparationDigest === p.preparationDigest &&
      r.reservedBudgetRevision === r.expectedBudgetRevision + 1 &&
      s.budgetEvents[r.expectedBudgetRevision - 1]?.eventDigest === r.expectedBudgetDigest,
  );
  for (const [i, e] of s.events.entries()) {
    requireMatch(
      e.runId === r.id &&
        e.revision === i + 1 &&
        e.previousEventDigest === (i ? s.events[i - 1].eventDigest : null) &&
        e.budgetRevision >= previousBudget &&
        e.budgetRevision <= s.budgetEvents.length,
    );
    previousBudget = e.budgetRevision;
    await hashField(e, "eventDigest");
    const q = e.payload;
    if (q.kind === "cancelled-before-dispatch") {
      requireMatch(s.archiveFormatVersion === 2 && i === 0 && s.revision === 1);
      state = q.kind;
      stopped = true;
      requireMatch(
        s.budgetEvents[e.budgetRevision - 1]?.eventDigest === q.releaseBudgetEventDigest,
      );
      continue;
    }
    requireMatch(
      s.archiveFormatVersion === 3 &&
        "executionContractVersion" in e &&
        e.executionContractVersion === 1,
    );
    if (q.kind === "transmission-approved") {
      requireMatch(
        i === 0 &&
          q.manifest.runDigest === r.runDigest &&
          q.manifest.preparationDigest === p.preparationDigest &&
          q.provenance === r.approval.provenance,
      );
      await hashField(q.manifest, "manifestDigest");
      await hashField(q.manifest.executionContract, "contractDigest");
      requireMatch(
        (await digest(q.manifest.executionContract.usagePolicy)) ===
          q.manifest.executionContract.usagePolicyDigest &&
          q.manifest.executionContract.requestContractDigest === p.contract.contractDigest &&
          q.manifest.executionContract.mode ===
            (r.environment === "synthetic-test" ? "synthetic-test" : "provider"),
      );
      approvalDigest = e.eventDigest;
      state = "approved";
    } else if (q.kind === "request-prepared") {
      requireMatch(!stopped && approvalDigest && !prepared.has(q.phase));
      if (q.phase === "review") {
        const g = validated.get("generation");
        requireMatch(
          g &&
            q.derivedFrom &&
            q.derivedFrom.generationEventDigest === g.eventDigest &&
            "outputDigest" in g.payload &&
            q.derivedFrom.outputDigest === g.payload.outputDigest &&
            q.derivedFrom.artifactSha256 === g.payload.artifactSha256,
        );
      } else
        requireMatch(
          q.phase === "generation" &&
            q.derivedFrom === null &&
            q.requestDigest === p.generation.requestDigest &&
            q.artifactSha256 === p.generation.sha256,
        );
      prepared.set(q.phase, e);
      allowed.set(`${q.phase}-request`, q.artifactSha256);
      state = "prepared";
    } else if (q.kind === "dispatch-intent") {
      const prior = prepared.get(q.phase);
      requireMatch(
        !stopped &&
          !dispatch.has(q.phase) &&
          prior &&
          prior.eventDigest === q.preparedEventDigest &&
          "requestDigest" in prior.payload &&
          prior.payload.requestDigest === q.requestDigest &&
          q.approvalEventDigest === approvalDigest &&
          "artifactSha256" in prior.payload &&
          q.artifactSha256 === prior.payload.artifactSha256,
      );
      dispatch.set(q.phase, e);
      state = "dispatching";
    } else if (q.kind === "response-received") {
      const prior = dispatch.get(q.phase);
      requireMatch(
        !response.has(q.phase) &&
          prior &&
          prior.eventDigest === q.dispatchEventDigest &&
          "requestDigest" in prior.payload &&
          prior.payload.requestDigest === q.requestDigest &&
          (!stopped || state === "result-unobserved"),
      );
      requireMatch(
        q.usageAssessment.status === "known"
          ? q.usageAssessment.units !== null && q.usageBudgetEventDigest !== null
          : q.usageAssessment.status === "unknown" &&
              q.usageAssessment.units === null &&
              q.usageBudgetEventDigest === null,
      );
      if (q.usageBudgetEventDigest) {
        const b = s.budgetEvents[e.budgetRevision - 1];
        requireMatch(
          b?.eventDigest === q.usageBudgetEventDigest &&
            b.payload.kind === "recognize-usage" &&
            b.payload.runId === r.id &&
            b.payload.phase === q.phase &&
            b.payload.dispatchEventDigest === prior.eventDigest &&
            b.payload.responseArtifactSha256 === q.artifactSha256 &&
            b.payload.recognizedUnits === q.usageAssessment.units &&
            b.payload.usageAssessmentDigest === (await digest(q.usageAssessment)),
        );
      }
      response.set(q.phase, e);
      allowed.set(`${q.phase}-response`, q.artifactSha256);
      if (!stopped) state = "response-recorded";
    } else if (q.kind === "domain-validated") {
      const prior = response.get(q.phase);
      requireMatch(
        !stopped &&
          !validated.has(q.phase) &&
          prior &&
          prior.eventDigest === q.responseEventDigest &&
          "requestDigest" in prior.payload &&
          prior.payload.requestDigest === q.requestDigest,
      );
      validated.set(q.phase, e);
      allowed.set(`${q.phase}-validated`, q.artifactSha256);
      state = "validated";
    } else if (q.kind === "execution-stopped") {
      requireMatch(!stopped);
      stopped = true;
      stopRevision = e.revision;
      state = q.outcome;
      if (q.outcome === "completed")
        requireMatch(validated.size === 2 && q.finalArtifactSha256 && q.failureCode === null);
      else requireMatch(q.finalArtifactSha256 === null);
      if (q.finalArtifactSha256) allowed.set("final-result", q.finalArtifactSha256);
      for (const d of q.releasedBudgetEventDigests)
        requireMatch(
          s.budgetEvents
            .slice(0, e.budgetRevision)
            .some(
              (b) =>
                b.eventDigest === d &&
                b.payload.kind === "release-phase" &&
                b.payload.runId === r.id,
            ),
        );
    } else requireMatch(false);
    if ("budgetDigest" in q)
      requireMatch(
        q.budgetRevision === e.budgetRevision &&
          s.budgetEvents[e.budgetRevision - 1]?.eventDigest === q.budgetDigest,
      );
  }
  requireMatch(
    s.state === state &&
      s.budgetEvents.length === previousBudget &&
      s.artifacts.length === allowed.size &&
      s.artifacts.every((a) => allowed.get(a.key) === a.sha256),
  );
  requireMatch(
    s.artifacts.reduce((n, a) => n + a.sizeBytes, 0) <= 20971520 &&
      s.storage.usedBytes + s.storage.heldBytes <= 33554432,
  );
  if (s.archiveFormatVersion === 2)
    requireMatch(
      s.revision <= 1 && !["terminal", "unsettled", "dispatchIntentCount"].some((k) => k in s),
    );
  else {
    requireMatch(
      s.revision >= 1 &&
        s.terminal === stopped &&
        s.dispatchIntentCount === dispatch.size &&
        s.responseCount === response.size &&
        s.unobservedDispatchCount === dispatch.size - response.size &&
        s.eligibleForNewCandidateRun === (stopped && !s.unsettled),
    );
    const own = costState(s);
    requireMatch(s.unsettled === own.unsettled && (!stopRevision || stopRevision <= s.revision));
  }
  return s;
}
export async function qualityProviderSnapshot(
  raw: unknown,
  registry: CandidateRegistrySnapshot,
  expected: { id: string; candidateId: string; revision?: number; snapshotDigest?: string },
) {
  const s = await checkSnapshot(raw),
    entry = await selected(registry, expected.candidateId),
    scope = s.run.preparation.scope;
  requireMatch(
    s.run.id === expected.id &&
      (expected.revision === undefined || s.revision === expected.revision) &&
      (expected.snapshotDigest === undefined || s.snapshotDigest === expected.snapshotDigest),
  );
  requireMatch(
    same(scope, {
      version: registry.version,
      versionDigest: registry.versionDigest,
      candidateId: expected.candidateId,
      sourceDigest: entry.sourceDigest,
      candidateDigest: entry.candidateDigest,
      modelInputDigest: entry.modelInputDigest,
    }),
  );
  const original = registry.entries.find((v) => v.candidateId === expected.candidateId)!.input;
  const input = object.parse(JSON.parse(s.run.preparation.generation.body.input[1].content)),
    fixed = s.run.preparation.reviewTemplate.fixedUserContext;
  requireMatch(
    same(input.profile, omit(original.profile, "businessNumber")) &&
      same(fixed.profile, input.profile) &&
      same(fixed.selectedCandidate, original.candidate) &&
      same(input.selectedCandidate, {
        ...original.candidate,
        classification: original.candidate.classification ?? "unknown",
      }),
  );
  const kinds = {
    consultation: "상담·녹취",
    patent: "특허·지식재산",
    technology: "기술·제품",
    finance: "재무·자금",
    market: "시장·고객",
    team: "인력·협업",
    other: "기타 서류",
  };
  const sources = original.sources
    .filter((v) => v.extraction !== "pending")
    .map((v) => ({
      sourceId: v.id,
      name: v.name,
      kind: kinds[v.kind],
      text: v.text,
      warnings: v.warnings,
    }));
  requireMatch(
    same(input.sources, sources) &&
      same(fixed.sources, sources) &&
      input.unextractedSourceCount === original.sources.length - sources.length &&
      fixed.unextractedSourceCount === input.unextractedSourceCount,
  );
  return s;
}

function costState(s: ProviderSnapshot) {
  const reserve = s.budgetEvents.find((b) => b.eventDigest === s.run.reservationDigest);
  requireMatch(reserve?.payload.kind === "reserve-run");
  const phase = new Map([
    ["generation", { held: BigInt(units.parse(reserve.payload.generationUnits)), settled: false }],
    ["review", { held: BigInt(units.parse(reserve.payload.reviewUnits)), settled: false }],
  ]);
  let recognized = BigInt(0);
  for (const e of s.budgetEvents) {
    const p = e.payload;
    if (!("runId" in p) || p.runId !== s.run.id) continue;
    if (p.kind === "release-run")
      for (const v of phase.values()) {
        v.held = BigInt(0);
        v.settled = true;
      }
    if (p.kind === "recognize-usage" || p.kind === "release-phase") {
      const v = phase.get(p.phase);
      requireMatch(v && !v.settled);
      if (p.kind === "recognize-usage") recognized += BigInt(units.parse(p.recognizedUnits));
      v.held = BigInt(0);
      v.settled = true;
    }
  }
  return {
    held: [...phase.values()].reduce((n, v) => n + v.held, BigInt(0)),
    recognized,
    unsettled: [...phase.values()].some((v) => !v.settled),
  };
}
function checkBudget(
  raw: unknown,
  env: "production" | "synthetic-test",
): ProviderBudgetSnapshot | null {
  if (raw === null) return null;
  const b = budgetSchema.parse(raw);
  requireMatch(b.environment === env && b.scopeId === scopeFor(env));
  const remaining = BigInt(b.capUnits) - BigInt(b.heldUnits) - BigInt(b.recognizedUnits);
  requireMatch(
    b.availableUnits === (remaining > BigInt(0) ? remaining : BigInt(0)).toString() &&
      (b.deficitUnits === undefined ||
        b.deficitUnits === (remaining < BigInt(0) ? -remaining : BigInt(0)).toString()) &&
      new Set(b.reservations.map((r) => r.runId)).size === b.reservations.length,
  );
  requireMatch(
    b.reservations.reduce((n, r) => n + BigInt(r.heldUnits), BigInt(0)) === BigInt(b.heldUnits),
  );
  return b as ProviderBudgetSnapshot;
}
export async function qualityProviderOverview(
  raw: unknown,
  registry: CandidateRegistrySnapshot,
  candidateId: string,
): Promise<ProviderLedgerOverview> {
  const value = z
    .object({
      schemaVersion: z.literal(2),
      kind: z.literal("provider-ledger-overview"),
      notice: z.literal(providerLedgerNotice),
      actualExecutionEnabled: z.literal(false),
      budgets: z.object({ production: z.unknown(), synthetic: z.unknown() }).strict(),
      executions: z.array(z.unknown()).max(20),
    })
    .strict()
    .parse(raw);
  await selected(registry, candidateId);
  const executions = await Promise.all(value.executions.map(checkSnapshot));
  requireMatch(
    new Set(executions.map((s) => s.run.id)).size === executions.length &&
      new Set(executions.map((s) => s.run.clientRequestId)).size === executions.length,
  );
  const budgets = {
    production: checkBudget(value.budgets.production, "production"),
    synthetic: checkBudget(value.budgets.synthetic, "synthetic-test"),
  };
  for (const s of executions) {
    const b = s.run.environment === "production" ? budgets.production : budgets.synthetic;
    requireMatch(b && b.revision >= s.budgetEvents.length);
    if (b.revision === s.budgetEvents.length)
      requireMatch(b.headDigest === s.budgetEvents.at(-1)?.eventDigest);
    const r = b.reservations.find((r) => r.runId === s.run.id);
    const c = costState(s);
    requireMatch(
      r?.reservationDigest === s.run.reservationDigest && r.heldUnits === c.held.toString(),
    );
  }
  const filtered = executions.filter(
    (s) =>
      s.run.preparation.scope.version === registry.version &&
      s.run.preparation.scope.versionDigest === registry.versionDigest &&
      s.run.preparation.scope.candidateId === candidateId,
  );
  for (const s of filtered)
    await qualityProviderSnapshot(s, registry, { id: s.run.id, candidateId });
  return { ...value, budgets, executions: filtered };
}

async function checkReceipt(raw: unknown, s: ProviderSnapshot): Promise<ProviderReceipt> {
  const r = receiptSchema.parse(raw);
  requireMatch(
    r.runId === s.run.id &&
      r.scopeId === s.run.preparation.budget.scopeId &&
      r.runRevision !== null &&
      r.runRevision <= s.revision,
  );
  if (r.runRevision === 0)
    requireMatch(
      r.kind === "provider-start" &&
        r.clientRequestId === s.run.clientRequestId &&
        r.inputDigest === s.run.inputDigest &&
        r.operationDigest === s.run.runDigest &&
        r.budgetRevision === s.run.reservedBudgetRevision &&
        r.recordedAt === s.run.recordedAt,
    );
  else {
    const e = s.events[r.runRevision - 1],
      p = e.payload;
    requireMatch(
      r.operationDigest === e.eventDigest &&
        r.budgetRevision === e.budgetRevision &&
        r.recordedAt === e.recordedAt,
    );
    if (p.kind === "cancelled-before-dispatch")
      requireMatch(
        r.kind === "provider-cancel" &&
          r.inputDigest ===
            (await digest({
              kind: "provider-cancel",
              runId: s.run.id,
              clientRequestId: r.clientRequestId,
              expectedRevision: 0,
              reason: p.reason,
            })),
      );
    else {
      const names = {
        "transmission-approved": "provider-approve",
        "request-prepared": "provider-prepared",
        "dispatch-intent": "provider-dispatch",
        "response-received": "provider-response",
        "domain-validated": "provider-validated",
        "execution-stopped": "provider-finish",
      };
      requireMatch(r.kind === names[p.kind]);
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
      const artifact =
        p.kind === "request-prepared" && p.phase === "generation"
          ? null
          : key
            ? s.artifacts.find((a) => a.key === key)
            : null;
      requireMatch(
        r.inputDigest ===
          (await digest({
            kind: "provider-execution-operation",
            runId: s.run.id,
            clientRequestId: r.clientRequestId,
            expectedRevision: e.revision - 1,
            payload,
            artifact,
          })),
      );
    }
  }
  return r as ProviderReceipt;
}
export async function qualityProviderLookup(
  raw: unknown,
  expected: {
    clientRequestId: string;
    inputDigest: string;
    runId: string;
    kind: ProviderReceipt["kind"];
  },
  snapshot?: ProviderSnapshot,
) {
  const v = z
    .union([
      z.object({ state: z.literal("not-observed") }).strict(),
      z.object({ state: z.literal("committed"), receipt: receiptSchema }).strict(),
    ])
    .parse(raw);
  if (v.state === "committed") {
    const r = v.receipt;
    requireMatch(
      r.clientRequestId === expected.clientRequestId &&
        r.inputDigest === expected.inputDigest &&
        r.runId === expected.runId &&
        r.kind === expected.kind &&
        snapshot,
    );
    await checkSnapshot(snapshot);
    await checkReceipt(r, snapshot);
  }
  return v;
}
export async function qualityProviderArtifact(
  text: string,
  snapshot: ProviderSnapshot,
  key: ProviderLedgerArtifactKey,
  headerSha?: string,
) {
  const s = await checkSnapshot(snapshot);
  providerLedgerArtifactKeySchema.parse(key);
  const a = s.artifacts.find((a) => a.key === key);
  requireMatch(
    a &&
      (headerSha === undefined || headerSha === a.sha256) &&
      bytes(text).length === a.sizeBytes &&
      (await rawSha(text)) === a.sha256,
  );
  boundedJson(text, 4194304);
  return { text, filename: providerLedgerArtifactName(s.run.id, s.revision, key) };
}
export async function qualityProviderArchive(
  text: string,
  snapshot: ProviderSnapshot,
  headerSha?: string,
) {
  const s = await checkSnapshot(snapshot);
  requireMatch(headerSha === undefined || sha.parse(headerSha) === (await rawSha(text)));
  const a = z
    .object({
      schemaVersion: z.literal(2),
      archiveFormatVersion: z.union([z.literal(2), z.literal(3)]),
      kind: z.enum(["provider-reservation-archive", "provider-execution-archive"]),
      run: object,
      events: z.array(eventSchema).max(32),
      budgetEvents: z.array(budgetEventSchema).max(1024),
      receipts: z.array(receiptSchema).max(33),
      artifacts: z
        .array(
          artifactRef
            .extend({ encoding: z.literal("base64"), payload: z.string().max(5592410) })
            .strict(),
        )
        .max(7),
    })
    .strict()
    .parse(boundedJson(text, 48 * 1024 * 1024));
  requireMatch(
    a.archiveFormatVersion === s.archiveFormatVersion &&
      a.kind ===
        (s.archiveFormatVersion === 2
          ? "provider-reservation-archive"
          : "provider-execution-archive") &&
      same(a.run, s.run) &&
      same(a.events, s.events) &&
      same(a.budgetEvents, s.budgetEvents) &&
      a.receipts.length === s.revision + 1 &&
      a.artifacts.length === s.artifacts.length,
  );
  requireMatch(
    new Set(a.receipts.map((r) => r.clientRequestId)).size === a.receipts.length &&
      new Set(a.artifacts.map((r) => r.key)).size === a.artifacts.length,
  );
  for (const [i, r] of a.receipts.entries()) {
    requireMatch(r.runRevision === i);
    await checkReceipt(r, s);
  }
  for (const item of a.artifacts) {
    const ref = s.artifacts.find((v) => v.key === item.key);
    requireMatch(ref && same(ref, omit(omit(item, "encoding"), "payload")));
    requireMatch(
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.payload),
    );
    const binary = atob(item.payload),
      raw = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    requireMatch(btoa(binary) === item.payload);
    const body = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    await qualityProviderArtifact(body, s, item.key);
  }
  return { text, filename: providerLedgerDownloadName(s.run.id, s.revision) };
}
export function qualityProviderStateSummary(s: ProviderSnapshot): {
  label: string;
  detail: string;
  costLabel: string;
} {
  const prefix = s.run.environment === "synthetic-test" ? "합성 연결시험 · " : "보관 기록 · ";
  const stop = s.events.find((e) => e.payload.kind === "execution-stopped"),
    late =
      stop &&
      s.events.some((e) => e.revision > stop.revision && e.payload.kind === "response-received");
  const names: Record<string, string> = {
    reserved: "예약 기록",
    "cancelled-before-dispatch": "전송 전 취소",
    approved: "전송 승인 기록",
    prepared: "요청 준비 기록",
    dispatching: "전송 의도 기록 · 응답 미확인",
    "response-recorded": "응답 보관",
    validated: "원고 검증 기록",
    completed: "완료 기록",
    "before-dispatch": "전송 전 중단",
    "result-unobserved": "응답 미확인 · 중단",
    "needs-cost-review": "비용 확인 필요 · 중단",
    "output-invalid": "응답 보관 · 원고 검증 실패",
    "bound-breached": "예약 상한 초과 · 중단",
  };
  const interrupted =
    stop?.payload.kind === "execution-stopped" &&
    stop.payload.outcome === "output-invalid" &&
    stop.payload.failureCode === "INTERRUPTED";
  const cost = costState(s),
    currency = s.run.preparation.budget.currency,
    scale = s.run.preparation.budget.unitScale;
  const label = late
    ? cost.unsettled
      ? "늦은 응답 보관 · 비용 확인 필요"
      : "늦은 응답 보관 · 비용 확인"
    : interrupted
      ? "응답 보관 · 원고 검증 중단"
      : (names[s.state] ?? "보관 상태 확인 필요");
  return {
    label: prefix + label,
    detail: late
      ? "중단 뒤 응답을 보관했습니다. 실행을 재개하거나 완료로 바꾸지 않습니다."
      : interrupted
        ? "응답 이후 검증을 중단한 기록입니다. 원고 내용이 잘못됐다는 뜻은 아닙니다."
        : "읽기 전용 기록입니다. 전송 의도는 공급자 수신·호출·청구의 증거가 아닙니다.",
    costLabel: `${s.run.environment === "synthetic-test" ? "합성 단위 · " : ""}확인된 사용량 비용 ${cost.recognized} · 미정산 예약 ${cost.held} (${currency}, 10^-${scale} 단위)${cost.unsettled ? " · 비용 확정 전" : ""}`,
  };
}
