import { ZodError } from "zod";

export class StudioError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = "INVALID_REQUEST",
  ) {
    super(message);
    this.name = "StudioError";
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
export const privateHeaders = {
  "Cache-Control": "no-store, private, max-age=0",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

/** This installation is bound to loopback; this is not a substitute for SaaS authentication. */
export function assertLocalRequest(request: Request) {
  const url = new URL(request.url);
  const host = request.headers.get("host") ?? url.host;
  let hostUrl: URL;
  try {
    hostUrl = new URL(`${url.protocol}//${host}`);
  } catch {
    throw new StudioError("로컬 앱에서만 사용할 수 있습니다.", 403, "LOCAL_ONLY");
  }
  if (
    !LOCAL_HOSTS.has(url.hostname) ||
    !LOCAL_HOSTS.has(hostUrl.hostname) ||
    !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host) ||
    hostUrl.port !== url.port
  ) {
    throw new StudioError("로컬 앱에서만 사용할 수 있습니다.", 403, "LOCAL_ONLY");
  }
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedHost && forwardedHost !== host) {
    throw new StudioError("외부 프록시 요청은 지원하지 않습니다.", 403, "LOCAL_ONLY");
  }
  const origin = request.headers.get("origin");
  // Next can normalize Request.url to localhost while retaining the browser's loopback Host.
  // Match browser Origin against that validated Host, not Next's internal alias.
  if (origin && origin !== hostUrl.origin) {
    throw new StudioError("다른 사이트에서 보낸 요청은 허용하지 않습니다.", 403, "CROSS_ORIGIN");
  }
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    throw new StudioError("다른 사이트에서 보낸 요청은 허용하지 않습니다.", 403, "CROSS_ORIGIN");
  }
}

export function jsonResponse(value: unknown, status = 200) {
  return Response.json(value, { status, headers: privateHeaders });
}

export async function studioRoute(request: Request, action: () => Promise<Response> | Response) {
  try {
    assertLocalRequest(request);
    return await action();
  } catch (error) {
    if (error instanceof StudioError)
      return jsonResponse({ error: error.message, code: error.code }, error.status);
    if (error instanceof ZodError)
      return jsonResponse(
        { error: error.issues[0]?.message ?? "입력값을 확인해 주세요.", code: "INVALID_INPUT" },
        400,
      );
    if (error instanceof SyntaxError)
      return jsonResponse({ error: "요청 형식을 확인해 주세요.", code: "INVALID_JSON" }, 400);
    // Never echo upstream SDK errors: they can contain uploaded text or configuration details.
    return jsonResponse(
      { error: "처리하지 못했습니다. 잠시 후 다시 시도해 주세요.", code: "INTERNAL_ERROR" },
      500,
    );
  }
}

export async function readBoundedBody(request: Request, maximum: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    throw new StudioError("요청 용량이 허용 범위를 초과했습니다.", 413, "TOO_LARGE");
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new StudioError("요청 용량이 허용 범위를 초과했습니다.", 413, "TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
  }
  return JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 2 * 1024 * 1024)));
}

export function attachmentHeaders(name: string, contentType: string) {
  return {
    ...privateHeaders,
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name).replaceAll("'", "%27")}`,
    "Content-Security-Policy": "sandbox; default-src 'none'",
  };
}
