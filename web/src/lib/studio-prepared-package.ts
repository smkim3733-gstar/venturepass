import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { buildPreparationPackage } from "./studio-package";
import { reviewPlan } from "./studio-engine";
import { StudioError } from "./studio-http";
import {
  preparedPackageRequestSchema,
  type PreparedPackageRequest,
  type PreparedPackageRecord,
} from "./studio-prepared-package-types";
import type { StudioStore } from "./studio-storage";
import { assertVentureCompanyWritable } from "./venturein-input-lock";

export const preparedPackageSha = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
export const preparedPackageRequestDigest = (input: PreparedPackageRequest) =>
  preparedPackageSha(JSON.stringify(preparedPackageRequestSchema.parse(input)));
export function preparedPackageError(code: string, status = 409): never {
  throw new StudioError(
    "로컬 준비본을 보관하거나 읽지 못했습니다. 원고·자료와 저장 상태를 확인해 주세요. 기존 준비본은 보존됩니다.",
    status,
    code,
  );
}

/** A local immutable archive only. No AI, portal submission or case workflow mutation. */
export async function preservePreparedPackage(
  store: StudioStore,
  caseId: string,
  raw: PreparedPackageRequest,
) {
  const input = preparedPackageRequestSchema.parse(raw);
  const existing = store.findPreparedPackageRequest(caseId, input);
  if (existing) return { package: existing, replayed: true };
  assertVentureCompanyWritable(caseId);
  const company = store.get(caseId);
  if (company.revision !== input.revision) preparedPackageError("STALE_REVISION");
  const matches = company.plans.filter((plan) => plan.id === input.planId);
  if (matches.length !== 1) preparedPackageError("PLAN_NOT_FOUND", 404);
  const plan = matches[0];
  const artifact = await buildPreparationPackage(store, caseId, {
    revision: input.revision,
    planId: input.planId,
    sourceIds: input.sourceIds,
  });
  const currentRuleFindings = reviewPlan(company, plan.content);
  const draftReasons = artifact.manifest.plan.draftReasons;
  const record: Omit<PreparedPackageRecord, "version"> = {
    id: randomUUID(),
    caseId,
    caseRevision: input.revision,
    clientRequestId: input.clientRequestId,
    input,
    requestDigest: preparedPackageRequestDigest(input),
    createdAt: new Date().toISOString(),
    scope: "local-preparation-only",
    company: {
      profile: structuredClone(company.profile),
      snapshotSha256: preparedPackageSha(JSON.stringify(company)),
    },
    plan: {
      ...structuredClone(plan),
      contentSha256: preparedPackageSha(JSON.stringify(plan.content)),
    },
    sourceIds: [...input.sourceIds],
    sources: input.sourceIds.map((sourceId) => {
      const source = company.sources.find((item) => item.id === sourceId)!;
      const original = artifact.manifest.originals.find((item) => item.sourceId === sourceId)!;
      const { text, ...metadata } = source;
      return {
        source: metadata,
        sourceSha256: preparedPackageSha(JSON.stringify(source)),
        textSha256: preparedPackageSha(text),
        originalSha256: original.sha256,
        originalSizeBytes: original.sizeBytes,
      };
    }),
    review: {
      storedFindings: structuredClone(plan.review),
      currentRuleFindings,
      confirmedAt: plan.confirmedAt,
      unconfirmedSectionKeys: plan.content.sections
        .filter((section) => section.needsConfirmation)
        .map((section) => section.key),
      currentEvidence: artifact.manifest.plan.currentEvidence,
      latestPlanVersion: artifact.manifest.plan.latestVersion,
      draft: draftReasons.length > 0,
      draftReasons,
    },
    zip: {
      fileName: "venturepass-preparation-package.zip",
      sha256: preparedPackageSha(artifact.buffer),
      sizeBytes: artifact.buffer.length,
    },
  };
  return store.commitPreparedPackage(caseId, input, record, artifact.buffer);
}
