import type { CandidateRegistrySnapshot } from "@/lib/studio-plan-quality-candidate-registry-types";
import { providerReservationInspectionResponseSchema } from "@/lib/studio-plan-quality-provider-reservation-http-types";
import { providerReservationReviewDigestInput } from "@/lib/studio-plan-quality-provider-reservation-review-types";
import {
  providerPolicyReviewDigestInput,
  providerPolicyReviewLifetimeMs,
} from "@/lib/studio-plan-quality-provider-policy-review-types";
import {
  candidateRegistryDigest as digest,
  candidateRegistrySnapshot,
} from "./quality-candidate-registry-ui";

export const reservationInspectUrl = "/api/studio/quality/provider-reservation/inspect";
export const reservationResponseBytes = 128 * 1024;
const fail = () => {
  throw new Error("예약 검토 내용을 확인하지 못했습니다. 다시 조회해 주세요.");
};
/** Display/archive consistency only. Digests do not grant reservation or transmission authority. */
export async function qualityProviderReservationInspection(
  raw: unknown,
  registry: CandidateRegistrySnapshot,
  candidateId: string,
  allowExpired = false,
) {
  const value = providerReservationInspectionResponseSchema.parse(raw);
  const checked = await candidateRegistrySnapshot(registry, registry);
  const entry = checked.manifest.find((row) => row.candidateId === candidateId);
  if (
    !entry ||
    value.selection.version !== registry.version ||
    value.selection.versionDigest !== registry.versionDigest ||
    value.selection.candidateId !== candidateId
  )
    return fail();
  if (value.status === "unavailable") return value;
  const review = value.review,
    policy = review.policyReview;
  const scope = {
    ...value.selection,
    setId: registry.setId,
    registrySourceDigest: registry.sourceDigest,
    manifestDigest: registry.manifestDigest,
    label: entry.label,
    sourceDigest: entry.sourceDigest,
    candidateDigest: entry.candidateDigest,
    modelInputDigest: entry.modelInputDigest,
  };
  if (
    (await digest(scope)) !== (await digest(policy.scope)) ||
    (await digest(providerReservationReviewDigestInput(review))) !== review.reviewDigest ||
    (await digest(providerPolicyReviewDigestInput(policy))) !== policy.reviewDigest
  )
    return fail();
  const now = Date.now(),
    inspected = Date.parse(policy.inspectedAt),
    expires = Date.parse(policy.expiresAt);
  if (
    inspected > now ||
    expires <= inspected ||
    expires - inspected > providerPolicyReviewLifetimeMs ||
    (!allowExpired && expires <= now)
  )
    return fail();
  return value;
}
export async function fetchProviderReservationInspection(
  registry: CandidateRegistrySnapshot,
  candidateId: string,
  signal: AbortSignal,
) {
  const response = await fetch(reservationInspectUrl, {
    method: "POST",
    cache: "no-store",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      version: registry.version,
      versionDigest: registry.versionDigest,
      candidateId,
    }),
  });
  if (
    ![200, 409].includes(response.status) ||
    !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")
  )
    return fail();
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > reservationResponseBytes))
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
      if (size > reservationResponseBytes) {
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
  const value = await qualityProviderReservationInspection(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    registry,
    candidateId,
  );
  const conflict =
    value.status === "unavailable" &&
    ["selection-invalid", "ledger-after-inspection"].includes(value.reason);
  if (response.status !== (conflict ? 409 : 200)) return fail();
  return value;
}
export async function qualityProviderReservationArchive(
  raw: unknown,
  registry: CandidateRegistrySnapshot,
  candidateId: string,
) {
  const value = await qualityProviderReservationInspection(raw, registry, candidateId, true);
  return {
    text: JSON.stringify(value, null, 2) + "\n",
    filename: `venturepass-reservation-review-v${registry.version}-${candidateId}.json`,
  };
}
