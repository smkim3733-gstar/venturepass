import type { CandidateRegistrySnapshot } from "@/lib/studio-plan-quality-candidate-registry-types";
import type { ProviderSnapshot } from "@/lib/studio-plan-quality-provider-types";
import {
  providerTransmissionInspectionResponseSchema,
  providerTransmissionInspectionStatus,
} from "@/lib/studio-plan-quality-provider-transmission-http-types";
import { providerTransmissionReviewDigestInput } from "@/lib/studio-plan-quality-provider-transmission-review-types";
import {
  candidateRegistryDigest as digest,
  candidateRegistryCanonical as canonical,
} from "./quality-candidate-registry-ui";
import { qualityProviderSnapshot } from "./quality-provider-review-ui";

export const transmissionInspectUrl = "/api/studio/quality/provider-transmission/inspect";
export const transmissionResponseBytes = 128 * 1024;
const fail = (): never => {
  throw new Error("전송 검토 내용을 확인하지 못했습니다. 다시 조회해 주세요.");
};
const without = (value: object, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** Browser display/archive binding only. A historical snapshot and hashes grant no permission. */
export async function qualityProviderTransmissionInspection(
  raw: unknown,
  registry: CandidateRegistrySnapshot,
  snapshot: ProviderSnapshot,
  allowExpired = false,
) {
  const value = providerTransmissionInspectionResponseSchema.parse(raw);
  const checked = await qualityProviderSnapshot(snapshot, registry, {
    id: snapshot.run.id,
    candidateId: snapshot.run.preparation.scope.candidateId,
    revision: snapshot.revision,
    snapshotDigest: snapshot.snapshotDigest,
  });
  const run = checked.run,
    prep = run.preparation;
  if (
    run.environment !== "production" ||
    value.selection.runId !== run.id ||
    value.selection.runDigest !== run.runDigest
  )
    return fail();
  if (value.status === "unavailable") return value;
  const v = value.review,
    manifest = v.manifest,
    contract = manifest.executionContract;
  const entry = registry.manifest.find((row) => row.candidateId === prep.scope.candidateId);
  if (!entry) return fail();
  const scope = {
    ...prep.scope,
    setId: registry.setId,
    registrySourceDigest: registry.sourceDigest,
    manifestDigest: registry.manifestDigest,
    label: entry.label,
  };
  const request = {
    scope: prep.scope,
    model: prep.model,
    contract: prep.contract,
    generation: prep.generation,
    reviewTemplate: prep.reviewTemplate,
  };
  if (
    !same(v.scope, scope) ||
    !same(v.request, request) ||
    !same(v.financialBasis, prep.financialBasis) ||
    !same(v.retention, prep.retention) ||
    v.run.preparationDigest !== prep.preparationDigest ||
    v.run.recordedAt !== run.recordedAt ||
    v.run.preparedAt !== prep.preparedAt ||
    v.run.preparationExpiresAt !== prep.expiresAt ||
    v.run.revision < checked.revision ||
    v.reservation.reservationDigest !== run.reservationDigest ||
    (await digest(providerTransmissionReviewDigestInput(v))) !== v.reviewDigest ||
    (await digest(without(manifest, "manifestDigest"))) !== manifest.manifestDigest ||
    (await digest(without(contract, "contractDigest"))) !== contract.contractDigest ||
    (await digest(contract.usagePolicy)) !== contract.usagePolicyDigest ||
    contract.usagePolicy.financialBasisDigest !== prep.financialBasisDigest
  )
    return fail();
  const now = Date.now();
  if (Date.parse(v.inspectedAt) > now || (!allowExpired && Date.parse(v.expiresAt) <= now))
    return fail();
  return value;
}
export async function fetchProviderTransmissionInspection(
  registry: CandidateRegistrySnapshot,
  snapshot: ProviderSnapshot,
  signal: AbortSignal,
) {
  const response = await fetch(transmissionInspectUrl, {
    method: "POST",
    cache: "no-store",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId: snapshot.run.id, runDigest: snapshot.run.runDigest }),
  });
  if (
    ![200, 409].includes(response.status) ||
    !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")
  )
    return fail();
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > transmissionResponseBytes))
    return fail();
  const reader = response.body?.getReader();
  if (!reader) return fail();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > transmissionResponseBytes) {
        await reader.cancel();
        return fail();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const value = await qualityProviderTransmissionInspection(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    registry,
    snapshot,
  );
  if (response.status !== providerTransmissionInspectionStatus(value) || signal.aborted)
    return fail();
  return value;
}
export async function qualityProviderTransmissionArchive(
  raw: unknown,
  registry: CandidateRegistrySnapshot,
  snapshot: ProviderSnapshot,
) {
  const value = await qualityProviderTransmissionInspection(raw, registry, snapshot, true);
  return {
    text: JSON.stringify(value, null, 2) + "\n",
    filename: `venturepass-transmission-review-${snapshot.run.id}.json`,
  };
}
