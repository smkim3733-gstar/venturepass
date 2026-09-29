import {
  providerProductionSelectionSchema,
  providerProductionViewSchema,
  type ProviderProductionSelection,
  type ProviderProductionView,
} from "@/lib/studio-plan-quality-provider-production-service-types";
import { productionStatusResponseBytes } from "./quality-provider-production-ui";

export type ProductionAction = "execute" | "recover";
export const productionCommandError =
  "실행 결과를 확정하지 못했습니다. 원래 실행 기록을 조회하거나 보관된 응답을 복구해 주세요.";
const fail = (): never => {
  throw Error(productionCommandError);
};

/** UI eligibility only; the server rechecks the original approval and dispatch ownership. */
export function canStartProviderProduction(view: ProviderProductionView) {
  return (
    view.status === "last-confirmed" &&
    view.reason === null &&
    view.recovery === "none" &&
    view.review === null &&
    ((view.lastAuditedRevision === 1 &&
      view.generation?.lastConfirmed === "approved" &&
      view.generation.response === "not-observed") ||
      (view.lastAuditedRevision === 5 &&
        view.generation?.lastConfirmed === "validated" &&
        view.generation.response === "recorded"))
  );
}

/** One explicit command, never a retry or a browser-persisted payload. */
export async function fetchProviderProductionCommand(
  action: ProductionAction,
  selection: ProviderProductionSelection,
  minimumRevision: number,
  signal: AbortSignal,
): Promise<ProviderProductionView> {
  try {
    const input = providerProductionSelectionSchema.safeParse(selection);
    if (
      !input.success ||
      !["execute", "recover"].includes(action) ||
      !Number.isSafeInteger(minimumRevision) ||
      minimumRevision < 1 ||
      signal.aborted
    )
      return fail();
    const response = await fetch(`/api/studio/quality/provider-execution/${action}`, {
      method: "POST",
      cache: "no-store",
      redirect: "error",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input.data),
    });
    if (
      ![200, 409, 503].includes(response.status) ||
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
        if (signal.aborted) {
          await reader.cancel();
          return fail();
        }
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
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const view = providerProductionViewSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    const expectedStatus =
      view.status === "unavailable" ? (view.reason === "execution-unavailable" ? 503 : 409) : 200;
    if (
      signal.aborted ||
      response.status !== expectedStatus ||
      view.reason === "invalid-selection" ||
      !view.selection ||
      view.selection.runId !== input.data.runId ||
      view.selection.runDigest !== input.data.runDigest ||
      view.selection.approvalBindingDigest !== input.data.approvalBindingDigest ||
      (view.lastAuditedRevision !== null && view.lastAuditedRevision < minimumRevision)
    )
      return fail();
    return view;
  } catch {
    return fail();
  }
}
