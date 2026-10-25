import { ZodError } from "zod";
import {
  configureServerRuntime,
  getServerRuntime,
  runInRequestScope,
  serverModeRequested,
  type StudioServerRuntime,
} from "./studio-request-scope";

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

const caseId = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/**
 * Routes that run on the shared server. Everything else (벤처인, Windows OCR, quality tools,
 * original files until they move to object storage) is local-only and answers 404 there.
 */
const serverRoutes: { pattern: RegExp; methods: string[] }[] = [
  { pattern: /^\/api\/studio\/status$/, methods: ["GET"] },
  { pattern: /^\/api\/studio\/cases$/, methods: ["GET", "POST"] },
  { pattern: new RegExp(`^/api/studio/cases/${caseId}$`, "i"), methods: ["GET", "PATCH"] },
  {
    pattern: new RegExp(
      `^/api/studio/cases/${caseId}/(generate|guided-preparation|preparation|answer-suggestions|source-suggestions/preview)$`,
      "i",
    ),
    methods: ["GET", "POST"],
  },
  { pattern: new RegExp(`^/api/studio/cases/${caseId}/export$`, "i"), methods: ["GET"] },
  { pattern: new RegExp(`^/api/studio/cases/${caseId}/sources$`, "i"), methods: ["POST"] },
  {
    pattern: new RegExp(`^/api/studio/cases/${caseId}/sources/direct-upload(/complete)?$`, "i"),
    methods: ["POST"],
  },
  {
    pattern: new RegExp(`^/api/studio/cases/${caseId}/sources/${caseId}$`, "i"),
    methods: ["GET"],
  },
  {
    pattern: new RegExp(`^/api/studio/cases/${caseId}/criteria-bindings/${caseId}/export$`, "i"),
    methods: ["GET"],
  },
];

/** Same-origin checks against the deployed public origin; authentication comes after. */
function assertServerRequest(request: Request, server: StudioServerRuntime) {
  const expected = new URL(server.origin).origin;
  const origin = request.headers.get("origin");
  if (origin && origin !== expected)
    throw new StudioError("다른 사이트에서 보낸 요청은 허용하지 않습니다.", 403, "CROSS_ORIGIN");
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none")
    throw new StudioError("다른 사이트에서 보낸 요청은 허용하지 않습니다.", 403, "CROSS_ORIGIN");
  if (request.method !== "GET" && request.method !== "HEAD" && !origin && !site)
    throw new StudioError("요청 출처를 확인할 수 없습니다.", 403, "CROSS_ORIGIN");
  const path = new URL(request.url).pathname;
  const route = serverRoutes.find((item) => item.pattern.test(path));
  if (!route)
    throw new StudioError("이 기능은 웹 서비스에서 제공하지 않습니다.", 404, "LOCAL_ONLY");
  if (!route.methods.includes(request.method))
    throw new StudioError("이 기능은 웹 서비스에서 제공하지 않습니다.", 405, "METHOD_NOT_ALLOWED");
}

/** Loaded on demand so the local app never imports the Postgres client. */
async function loadConfiguredRuntime() {
  const { loadServerRuntimeFromEnv } = await import("./studio-server-bootstrap");
  const runtime = await loadServerRuntimeFromEnv();
  if (runtime) configureServerRuntime(runtime);
  return runtime;
}

async function serverRoute(
  request: Request,
  server: StudioServerRuntime,
  action: () => Promise<Response> | Response,
) {
  assertServerRequest(request, server);
  const principal = await server.authenticate(request);
  if (!principal) throw new StudioError("로그인이 필요합니다.", 401, "UNAUTHENTICATED");
  if (principal.role === "viewer" && request.method !== "GET" && request.method !== "HEAD")
    throw new StudioError("조회 권한으로는 변경할 수 없습니다.", 403, "FORBIDDEN");
  const repository = server.repositoryFor(principal);
  return await runInRequestScope({ principal, repository, originals: server.originals }, action);
}

export async function studioRoute(request: Request, action: () => Promise<Response> | Response) {
  try {
    if (serverModeRequested()) {
      const server = getServerRuntime() ?? (await loadConfiguredRuntime());
      if (!server)
        throw new StudioError(
          "웹 서비스 설정(인증·저장소)이 완료되지 않았습니다.",
          503,
          "SERVER_NOT_CONFIGURED",
        );
      return await serverRoute(request, server, action);
    }
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
