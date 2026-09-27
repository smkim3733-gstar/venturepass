import { planQualityEvaluationDigest as digest } from "./studio-plan-quality-evaluation";
import { createPlanQualityValidationCandidates } from "./studio-plan-quality-validation-candidates";
import {
  candidateRegistryInputSchema,
  candidateRegistrySourceSchema,
  candidateRegistrySetId,
  candidateRegistrySnapshotSchema,
  candidateRegistrySummarySchema,
  candidateRegistrySourceDigestInput,
  candidateRegistryVersionDigestInput,
  type CandidateRegistryEntry,
  type CandidateRegistrySource,
  type CandidateRegistrySnapshot,
} from "./studio-plan-quality-candidate-registry-types";

/** Whitelist only source material and topic. Author notes are never generation input. */
export function candidateRegistryModelInput(entry: CandidateRegistryEntry) {
  return candidateRegistryInputSchema.parse(structuredClone(entry.input));
}
export function candidateRegistryManifest(entries: CandidateRegistryEntry[]) {
  return entries.map((entry) => ({
    candidateId: entry.candidateId,
    label: entry.label,
    sourceDigest: digest({ profile: entry.input.profile, sources: entry.input.sources }),
    candidateDigest: digest(entry.input.candidate),
    modelInputDigest: digest(entry.input),
    reviewerMetadataDigest: digest(entry.reviewerMetadata),
  }));
}
export function candidateRegistrySourceDigest(entries: CandidateRegistryEntry[]) {
  return digest(candidateRegistrySourceDigestInput(entries));
}
/** Only bundled synthetic candidates can enter the registration write path. */
export function createCandidateRegistrySource(): CandidateRegistrySource {
  const entries = createPlanQualityValidationCandidates().map((value) => ({
    candidateId: value.id,
    label: value.label,
    input: {
      profile: value.company.profile,
      sources: value.company.sources,
      candidate: value.candidate,
    },
    reviewerMetadata: {
      sector: value.sector,
      applicationKind: value.applicationKind,
      materialDesign: value.materialDesign,
      challengeTags: value.challengeTags,
      authoringNotes: value.authoringNotes,
    },
  }));
  const manifest = candidateRegistryManifest(entries);
  return candidateRegistrySourceSchema.parse({
    schemaVersion: 1,
    setId: candidateRegistrySetId,
    synthetic: true,
    authoredBy: "ai",
    humanAnswerKey: null,
    independentHoldoutConfirmed: false,
    performanceEvaluation: "not-performed",
    sourceDigest: candidateRegistrySourceDigest(entries),
    manifestDigest: digest(manifest),
    manifest,
    entries,
  });
}
export function candidateRegistryVersionDigest(
  value: Omit<CandidateRegistrySnapshot, "versionDigest"> | CandidateRegistrySnapshot,
) {
  return digest(candidateRegistryVersionDigestInput(value));
}
/** Archived reads validate pinned content, never compare it with today's bundled source. */
export function validateCandidateRegistrySnapshot(value: unknown): CandidateRegistrySnapshot {
  const snapshot = candidateRegistrySnapshotSchema.parse(value);
  const ids = snapshot.entries.map((entry) => entry.candidateId);
  const sourceIds = snapshot.entries.flatMap((entry) =>
    entry.input.sources.map((source) => source.id),
  );
  if (
    new Set(ids).size !== ids.length ||
    new Set(sourceIds).size !== sourceIds.length ||
    snapshot.sourceDigest !== candidateRegistrySourceDigest(snapshot.entries) ||
    snapshot.manifestDigest !== digest(snapshot.manifest) ||
    digest(candidateRegistryManifest(snapshot.entries)) !== snapshot.manifestDigest ||
    snapshot.versionDigest !== candidateRegistryVersionDigest(snapshot)
  )
    throw new Error("Candidate registry digest mismatch");
  return snapshot;
}
export function candidateRegistrySummary(snapshot: CandidateRegistrySnapshot) {
  const {
    setId,
    synthetic,
    authoredBy,
    humanAnswerKey,
    independentHoldoutConfirmed,
    performanceEvaluation,
    version,
    previousVersion,
    previousDigest,
    versionDigest,
    sourceDigest,
    manifestDigest,
    registeredAt,
    clientRequestId,
  } = snapshot;
  return candidateRegistrySummarySchema.parse({
    setId,
    synthetic,
    authoredBy,
    humanAnswerKey,
    independentHoldoutConfirmed,
    performanceEvaluation,
    version,
    previousVersion,
    previousDigest,
    versionDigest,
    sourceDigest,
    manifestDigest,
    registeredAt,
    clientRequestId,
    candidateCount: 12,
  });
}
