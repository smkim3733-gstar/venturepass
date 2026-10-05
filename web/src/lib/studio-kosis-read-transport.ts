import "server-only";
import { z } from "zod";
import { StudioError } from "./studio-http";

const MAX_BYTES = 512 * 1024;
const endpoints = {
  search: "/openapi/statisticsSearch.do",
  cell: "/openapi/Param/statisticsParameterData.do",
  metadata: "/openapi/statisticsData.do",
} as const;
export function createKosisReadGate() {
  let busy = false;
  return {
    acquire() {
      if (busy)
        throw new StudioError(
          "다른 공개 조회가 진행 중입니다. 완료 후 다시 조회해 주세요.",
          409,
          "PUBLIC_RESEARCH_BUSY",
        );
      busy = true;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          busy = false;
        }
      };
    },
  };
}
export type KosisReadGate = ReturnType<typeof createKosisReadGate>;
// Both production services share this gate. It is not a distributed rate limiter.
const sharedGate = createKosisReadGate();
export type KosisReadDependencies = {
  apiKey: () => string | undefined;
  fetch: typeof globalThis.fetch;
  now: () => string;
  gate?: KosisReadGate;
};
async function bodyJson(response: Response, signal: AbortSignal) {
  const declared = response.headers.get("content-length");
  if (
    signal.aborted ||
    (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES))
  ) {
    await response.body?.cancel();
    throw Error("Rejected public response");
  }
  if (!response.body) throw Error("Missing public body");
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    if (signal.aborted) throw Error("Canceled public read");
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw Error("Canceled public read");
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) throw Error("Public body too large");
      parts.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}
/** Internal fixed-origin transport. Parameters come only from each service's validated command. */
export function createKosisReadTransport(deps: KosisReadDependencies, fail: () => StudioError) {
  return async function read(
    kind: keyof typeof endpoints,
    parameters: Readonly<Record<string, string>>,
    callerSignal?: AbortSignal,
  ): Promise<
    { status: "not-configured" } | { status: "received"; body: unknown; retrievedAt: string }
  > {
    let key: string | undefined;
    try {
      key = deps.apiKey()?.trim();
      if (key && (key.length > 1024 || /[\s\u0000-\u001f]/.test(key))) throw fail();
      if (!Object.hasOwn(endpoints, kind) || Object.hasOwn(parameters, "apiKey")) throw fail();
    } catch {
      throw fail();
    }
    if (!key) return { status: "not-configured" };
    if (callerSignal?.aborted) throw fail();
    const release = (deps.gate ?? sharedGate).acquire();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    callerSignal?.addEventListener("abort", cancel, { once: true });
    let rejectAbort!: (reason: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => rejectAbort(fail());
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(cancel, 20_000);
    // Keep the lease until the original operation settles, even if a broken fetch ignores abort.
    const operation = (async () => {
      try {
        if (callerSignal?.aborted) controller.abort();
        if (controller.signal.aborted) throw fail();
        const url = new URL(endpoints[kind], "https://kosis.kr");
        for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
        url.searchParams.set("apiKey", key);
        const response = await deps.fetch(url, {
          method: "GET",
          redirect: "error",
          cache: "no-store",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok || response.redirected || controller.signal.aborted) {
          await response.body?.cancel();
          throw fail();
        }
        const body = await bodyJson(response, controller.signal);
        if (controller.signal.aborted) throw fail();
        const retrievedAt = z.iso.datetime().parse(deps.now());
        if (controller.signal.aborted) throw fail();
        return { status: "received" as const, body, retrievedAt };
      } catch {
        throw fail();
      } finally {
        release();
      }
    })();
    try {
      return await Promise.race([operation, aborted]);
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", onAbort);
    }
  };
}
