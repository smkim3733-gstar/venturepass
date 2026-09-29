import {
  providerProductionInspectionInputSchema,
  providerProductionViewSchema,
  type ProviderProductionInspectionInput,
} from "@/lib/studio-plan-quality-provider-production-service-types";

export const productionStatusUrl = "/api/studio/quality/provider-execution/inspect";
export const productionStatusResponseBytes = 16 * 1024;
const fail = (): never => {
  throw Error("저장된 실행 기록을 확인하지 못했습니다. 다시 조회해 주세요.");
};

export function qualityProviderProductionStatus(
  raw: unknown,
  selection: ProviderProductionInspectionInput,
  minimumRevision: number,
) {
  const input = providerProductionInspectionInputSchema.safeParse(selection);
  const parsed = providerProductionViewSchema.safeParse(raw);
  if (
    !input.success ||
    !parsed.success ||
    !Number.isSafeInteger(minimumRevision) ||
    minimumRevision < 1
  )
    return fail();
  const view = parsed.data;
  if (
    !view.selection ||
    view.selection.runId !== input.data.runId ||
    view.selection.runDigest !== input.data.runDigest ||
    view.lastAuditedRevision === null ||
    view.lastAuditedRevision < minimumRevision ||
    view.status === "unavailable" ||
    view.status === "capture-recovery-required" ||
    view.reason !== null ||
    [view.generation?.response, view.review?.response].includes("captured-not-confirmed")
  )
    return fail();
  return view;
}

/** Exactly one read-only POST. No execution/recovery call, retry, raw body or browser storage. */
export async function fetchProviderProductionStatus(
  selection: ProviderProductionInspectionInput,
  minimumRevision: number,
  signal: AbortSignal,
) {
  const input = providerProductionInspectionInputSchema.safeParse(selection);
  if (
    !input.success ||
    !Number.isSafeInteger(minimumRevision) ||
    minimumRevision < 1 ||
    signal.aborted
  )
    return fail();
  const response = await fetch(productionStatusUrl, {
    method: "POST",
    cache: "no-store",
    redirect: "error",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input.data),
  });
  if (
    response.status !== 200 ||
    !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")
  )
    return fail();
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > productionStatusResponseBytes))
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
      if (size > productionStatusResponseBytes) {
        await reader.cancel();
        return fail();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (signal.aborted) return fail();
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return qualityProviderProductionStatus(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      input.data,
      minimumRevision,
    );
  } catch {
    return fail();
  }
}
