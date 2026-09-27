import {
  qualityActualPreparationSchema,
  qualityActualPreparationDigestInput,
  qualityActualRequestEvidenceDigestInput,
  qualityActualBlockerMessages,
  qualityActualDownloadName,
  type QualityActualPreparation,
} from "@/lib/studio-plan-quality-actual-types";
import type { CandidateRegistrySnapshot } from "@/lib/studio-plan-quality-candidate-registry-types";
import { sourceKindLabels, sectionDefinitions } from "@/lib/studio-schema";
import { getCandidateClassification } from "@/lib/studio-candidate-classification";
import { trackContext } from "@/lib/studio-preparation-context";
import {
  candidateRegistryCanonical as canonical,
  candidateRegistryDigest as digest,
  candidateRegistrySnapshot,
} from "./quality-candidate-registry-ui";

export const qualityActualPreparationUrl = "/api/studio/quality/actual-preparation";
export const qualityActualModelPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function fail(): never {
  throw new Error("선택한 등록본·후보·모델과 준비 조회 결과의 연결을 확인하지 못했습니다.");
}
// Engine v1 uses localeCompare; registry/evaluation use lexical sorting. Preserve both contracts.
async function engineDigest(value: unknown) {
  const ordered = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(ordered)
      : item !== null && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, entry]) => [key, ordered(entry)]),
          )
        : item;
  const bytes = new TextEncoder().encode(JSON.stringify(ordered(value)));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
}
export function qualityActualSelectionMatches(
  value: QualityActualPreparation,
  registry: CandidateRegistrySnapshot | null,
  candidateId: string,
  model: string | null,
) {
  return (
    !!registry &&
    value.scope.version === registry.version &&
    value.scope.versionDigest === registry.versionDigest &&
    value.scope.candidateId === candidateId &&
    value.model === model
  );
}
/** Production inspection accepts no client-provided price, tokens, budget, approval or execution. */
export async function qualityActualPreparation(
  raw: unknown,
  registry: CandidateRegistrySnapshot,
  candidateId: string,
  model: string | null,
): Promise<QualityActualPreparation> {
  const value = qualityActualPreparationSchema.parse(raw);
  await candidateRegistrySnapshot(registry, registry);
  const manifest = registry.manifest.find((entry) => entry.candidateId === candidateId);
  const entry = registry.entries.find((entry) => entry.candidateId === candidateId);
  const { contractDigest, ...contract } = value.engine;
  const expectedCodes = [
    ...(model === null ? ["MODEL_NOT_SELECTED" as const] : []),
    "PRICE_NOT_CONFIGURED",
    "TOKEN_BOUND_NOT_CONFIGURED",
    "BUDGET_NOT_CONFIGURED",
  ] as const;
  if (
    !manifest ||
    !entry ||
    !qualityActualSelectionMatches(value, registry, candidateId, model) ||
    value.scope.setId !== registry.setId ||
    value.scope.label !== manifest.label ||
    value.scope.registrySourceDigest !== registry.sourceDigest ||
    value.scope.manifestDigest !== registry.manifestDigest ||
    value.scope.sourceDigest !== manifest.sourceDigest ||
    value.scope.candidateDigest !== manifest.candidateDigest ||
    value.scope.modelInputDigest !== manifest.modelInputDigest ||
    value.environment !== "production" ||
    value.readiness !== "blocked" ||
    value.costs !== null ||
    !same(value.evidence, { price: null, tokens: null, budget: null }) ||
    !same(
      value.blockers,
      expectedCodes.map((code) => ({ code, message: qualityActualBlockerMessages[code] })),
    ) ||
    (await engineDigest(contract)) !== contractDigest ||
    (await digest(qualityActualPreparationDigestInput(value))) !== value.preparationDigest
  )
    fail();
  const evidence = value.requestEvidence;
  if (model === null) {
    if (evidence !== null) fail();
    return value;
  }
  if (!evidence) return fail();
  const { generation, reviewTemplate } = evidence;
  const { templateDigest, ...template } = reviewTemplate;
  if (
    generation.body.model !== model ||
    reviewTemplate.model !== model ||
    generation.contractDigest !== contractDigest ||
    reviewTemplate.contractDigest !== contractDigest ||
    generation.inputChars !==
      generation.body.input.reduce((sum, msg) => sum + msg.content.length, 0) ||
    (await engineDigest(generation.body)) !== generation.requestDigest ||
    (await engineDigest(template)) !== templateDigest ||
    (await digest(qualityActualRequestEvidenceDigestInput(evidence))) !== evidence.evidenceDigest
  )
    fail();
  for (const [phase, message, format] of [
    ["generation", generation.body.input[0], generation.body.text.format],
    ["review", reviewTemplate.systemMessage, reviewTemplate.format],
  ] as const) {
    const descriptor = value.engine.phases.find((item) => item.phase === phase);
    const split = message.content.lastIndexOf("\n\n");
    if (
      !descriptor ||
      split < 1 ||
      descriptor.name !== format.name ||
      (await engineDigest(message.content.slice(0, split))) !== descriptor.systemDigest ||
      (await engineDigest(message.content.slice(split + 2))) !== descriptor.instructionDigest ||
      (await engineDigest(format)) !== descriptor.schemaDigest
    )
      fail();
  }
  const input = JSON.parse(generation.body.input[1].content);
  const profile = { ...entry.input.profile, businessNumber: undefined };
  const context = {
    profile,
    preparationContext: trackContext({ profile: entry.input.profile }),
    unextractedSourceCount: entry.input.sources.filter((source) => source.extraction === "pending")
      .length,
    sources: entry.input.sources
      .filter((source) => source.extraction !== "pending")
      .map(({ id, name, kind, text, warnings }) => ({
        sourceId: id,
        name,
        kind: sourceKindLabels[kind],
        text,
        warnings,
      })),
  };
  if (
    typeof input.preparationContext !== "string" ||
    !input.preparationContext ||
    !same(input, {
      ...context,
      selectedCandidate: {
        ...entry.input.candidate,
        classification: getCandidateClassification(entry.input.candidate),
      },
      sectionDefinitions,
    }) ||
    !same(reviewTemplate.fixedUserContext, { ...context, selectedCandidate: entry.input.candidate })
  )
    fail();
  return value;
}
/** Download exactly the validated current view; never regenerate a different timestamp/model on GET. */
export async function qualityActualArchive(
  value: QualityActualPreparation,
  registry: CandidateRegistrySnapshot,
  candidateId: string,
  model: string | null,
) {
  const checked = await qualityActualPreparation(value, registry, candidateId, model);
  return {
    filename: qualityActualDownloadName(checked.scope.version, checked.scope.candidateId).replace(
      ".json",
      `-${checked.preparationDigest.slice(0, 12)}.json`,
    ),
    text: JSON.stringify(checked, null, 2) + "\n",
  };
}
