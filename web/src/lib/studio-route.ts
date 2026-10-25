import { ZodError } from "zod";
import {
  configureServerRuntime,
  getServerRuntime,
  runInRequestScope,
  serverModeRequested,
  type StudioServerRuntime,
} from "./studio-request-scope";
import { assertLocalRequest, jsonResponse, StudioError } from "./studio-http";

// Route handlers import from here. Browser code reaches studio-http (StudioError and friends)
// through shared modules, so the server runtime, Postgres client and auth stay out of it.
export * from "./studio-http";

const caseId = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/**
 * Routes that run on the shared server. Everything else (벤처인, Windows OCR, quality tools,
 * original files until they move to object storage) is local-only and answers 404 there.
 */
const serverRoutes: { pattern: RegExp; methods: string[] }[] = [
  { pattern: /^\/api\/studio\/status$/, methods: ["GET"] },
  { pattern: /^\/api\/studio\/cases$/, methods: ["GET", "POST"] },
  { pattern: /^\/api\/studio\/members$/, methods: ["GET", "POST"] },
  { pattern: new RegExp(`^/api/studio/members/${caseId}$`, "i"), methods: ["PATCH"] },
  { pattern: new RegExp(`^/api/studio/members/${caseId}/password$`, "i"), methods: ["POST"] },
  { pattern: new RegExp(`^/api/studio/cases/${caseId}$`, "i"), methods: ["GET", "PATCH"] },
  {
    pattern: new RegExp(
      `^/api/studio/cases/${caseId}/(generate|guided-preparation|preparation|answer-suggestions|source-suggestions/preview)$`,
      "i",
    ),
    methods: ["GET", "POST"],
  },
  { pattern: new RegExp(`^/api/studio/cases/${caseId}/export$`, "i"), methods: ["GET"] },
  { pattern: new RegExp(`^/api/studio/cases/${caseId}/package$`, "i"), methods: ["POST"] },
  {
    pattern: new RegExp(`^/api/studio/cases/${caseId}/package/exports/${caseId}$`, "i"),
    methods: ["GET"],
  },
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
  return await runInRequestScope(
    { principal, repository, originals: server.originals, members: server.members },
    action,
  );
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
