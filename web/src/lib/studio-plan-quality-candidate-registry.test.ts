import { describe, expect, it } from "vitest";
import { planQualityEvaluationDigest as digest } from "./studio-plan-quality-evaluation";
import {
  createCandidateRegistrySource,
  candidateRegistryModelInput,
  candidateRegistryVersionDigest,
  validateCandidateRegistrySnapshot,
} from "./studio-plan-quality-candidate-registry";
import {
  candidateRegistryNotice,
  candidateRegistryRegisterSchema,
  candidateRegistrySourceDigestInput,
  candidateRegistryVersionDigestInput,
  type CandidateRegistrySnapshot,
} from "./studio-plan-quality-candidate-registry-types";

function snapshot() {
  const value: Omit<CandidateRegistrySnapshot, "versionDigest"> = {
    ...createCandidateRegistrySource(),
    kind: "validation-candidate-set" as const,
    version: 1,
    previousVersion: null,
    previousDigest: null,
    registeredAt: "2026-09-27T00:00:00.000Z",
    clientRequestId: "10e3bdf5-6a8d-4e00-9a01-7377279a0f19",
    notice: candidateRegistryNotice,
  };
  return { ...value, versionDigest: candidateRegistryVersionDigest(value) };
}
describe("bundled candidate registration contract", () => {
  it("pins 12 synthetic candidates without inventing answers, plans or evaluation", () => {
    const value = createCandidateRegistrySource();
    expect(value.entries).toHaveLength(12);
    expect(value).toMatchObject({
      authoredBy: "ai",
      humanAnswerKey: null,
      independentHoldoutConfirmed: false,
      performanceEvaluation: "not-performed",
    });
    expect(value.sourceDigest).toBe(digest(candidateRegistrySourceDigestInput(value.entries)));
    expect(value.manifestDigest).toBe(digest(value.manifest));
    expect(value.entries.every((entry) => !("plan" in entry.input))).toBe(true);
    expect(createCandidateRegistrySource()).toEqual(value);
  });
  it("whitelists only input and returns an isolated copy", () => {
    const entry = createCandidateRegistrySource().entries[0];
    const input = candidateRegistryModelInput(entry);
    expect(Object.keys(input).sort()).toEqual(["candidate", "profile", "sources"]);
    for (const key of ["authoringNotes", "challengeTags", "materialDesign", "reviewerMetadata"])
      expect(input).not.toHaveProperty(key);
    input.sources[0].text = "changed";
    expect(entry.input.sources[0].text).not.toBe("changed");
  });
  it("uses browser-safe exact canonical digest inputs", () => {
    const value = snapshot();
    expect(value.versionDigest).toBe(digest(candidateRegistryVersionDigestInput(value)));
    expect(candidateRegistryVersionDigestInput(value)).not.toHaveProperty("versionDigest");
    expect(validateCandidateRegistrySnapshot(value)).toEqual(value);
  });
  it.each(["input", "metadata", "manifest", "chain", "status"])("rejects %s corruption", (kind) => {
    const value = snapshot();
    if (kind === "input") value.entries[0].input.sources[0].text += "tampered";
    if (kind === "metadata") value.entries[0].reviewerMetadata.authoringNotes.push("tampered");
    if (kind === "manifest") value.manifest[0].label += "tampered";
    if (kind === "chain") value.previousVersion = 1 as never;
    if (kind === "status") value.independentHoldoutConfirmed = true as never;
    expect(() => validateCandidateRegistrySnapshot(value)).toThrow();
  });
  it("never accepts arbitrary corpus or unacknowledged registration input", () => {
    const input = {
      expectedVersion: 0,
      clientRequestId: snapshot().clientRequestId,
      sourceDigest: snapshot().sourceDigest,
      acknowledgedCandidateStatus: true,
    };
    expect(candidateRegistryRegisterSchema.safeParse(input).success).toBe(true);
    expect(candidateRegistryRegisterSchema.safeParse({ ...input, entries: [] }).success).toBe(
      false,
    );
    expect(
      candidateRegistryRegisterSchema.safeParse({ ...input, acknowledgedCandidateStatus: false })
        .success,
    ).toBe(false);
  });
});
