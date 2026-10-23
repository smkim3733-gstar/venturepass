import { z } from "zod";
import {
  decodeInputDownload,
  inputSelectionSchema,
  type InputDownload,
  type InputSelection,
} from "./studio-comparison-input-wire";
type State = { busy: boolean; result: InputDownload | null; message: string };
async function body(response: Response) {
  if (!response.body) throw Error("INPUT_UNAVAILABLE");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 1024 * 1024) {
        await reader.cancel();
        throw Error("INPUT_UNAVAILABLE");
      }
      chunks.push(item.value);
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
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!response.ok)
    throw Error(
      ["CLEANUP_REQUIRED", "NOT_CONFIGURED"].includes(value?.code)
        ? value.code
        : "INPUT_UNAVAILABLE",
    );
  return value;
}
/** Explicit read-only POST, no automatic calls, retries, storage or activation. */
export function createInputPreparationClient(fetcher: typeof fetch) {
  let state: State = { busy: false, result: null, message: "" },
    pending: AbortController | null = null;
  const listeners = new Set<() => void>();
  function update(value: Partial<State>) {
    state = { ...state, ...value };
    listeners.forEach((fn) => fn());
  }
  async function request(raw: InputSelection, cleanup: boolean) {
    if (pending) return;
    const selection = inputSelectionSchema.parse(raw),
      controller = new AbortController();
    pending = controller;
    update({
      busy: true,
      result: null,
      message: cleanup
        ? "준비 연결을 정리하고 있습니다."
        : "선택한 예약과 검토된 정책을 확인하고 있습니다.",
    });
    try {
      const response = await fetcher(
        `/api/studio/cases/${selection.companyId}/public-claim-comparison/input-preparation`,
        {
          method: cleanup ? "DELETE" : "POST",
          headers: cleanup ? undefined : { "content-type": "application/json" },
          body: cleanup ? undefined : JSON.stringify(selection),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
        },
      );
      const value = await body(response);
      if (pending !== controller || controller.signal.aborted) return;
      if (cleanup) {
        z.object({ closed: z.literal(true) })
          .strict()
          .parse(value);
        update({ message: "준비 연결을 정리했습니다. 필요한 예약을 다시 선택해 준비하세요." });
      } else {
        const result = decodeInputDownload(value, selection);
        const hash = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(result.content),
        );
        if (
          Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("") !==
          result.sha256
        )
          throw Error("INPUT_UNAVAILABLE");
        if (pending !== controller || controller.signal.aborted) return;
        decodeInputDownload(result, selection);
        update({
          result,
          message:
            "실행 입력 파일을 준비했습니다. 내려받은 파일을 검토한 뒤 운영 담당자가 별도로 활성화해야 합니다.",
        });
      }
    } catch (failure) {
      if (pending === controller && !controller.signal.aborted)
        update({
          message:
            failure instanceof Error && failure.message === "NOT_CONFIGURED"
              ? "검토된 실행 준비 정책이 설정되지 않았습니다. 운영 담당자가 정책 파일을 확인해 주세요."
              : failure instanceof Error && failure.message === "CLEANUP_REQUIRED"
                ? "이전 준비 연결의 정리가 필요합니다. 준비 연결 정리 후 다시 시도하세요."
                : "입력 파일을 준비하지 못했습니다. 준비 연결을 정리한 뒤 회사 버전·예약·정책을 확인해 주세요.",
        });
    } finally {
      if (pending === controller) {
        pending = null;
        update({ busy: false });
      }
    }
  }
  return Object.freeze({
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    getSnapshot: () => state,
    prepare: (selection: InputSelection) => request(selection, false),
    cleanup: (selection: InputSelection) => request(selection, true),
    invalidate() {
      pending?.abort();
      pending = null;
      update({ busy: false, result: null, message: "" });
    },
  });
}
