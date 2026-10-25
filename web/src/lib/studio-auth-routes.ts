import { z } from "zod";
import { jsonResponse, readBoundedBody, StudioError } from "./studio-http";
import type { StudioPrincipal } from "./studio-request-scope";
import { sessionCookieName } from "./studio-server-auth";
import {
  supabasePasswordLogin,
  supabaseRefresh,
  type SupabaseAuthConfig,
  type SupabaseSession,
} from "./studio-supabase-auth";

export const refreshCookieName = "vp_refresh_token";
const refreshMaxAge = 30 * 24 * 3600;

/** Everything the login routes need; production reads it from the server settings. */
export type AuthRouteContext = {
  origin: string;
  supabase: SupabaseAuthConfig;
  authenticate(request: Request): Promise<StudioPrincipal | null>;
  fetchImpl?: typeof fetch;
};

const loginSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(200),
});

function assertSameOrigin(request: Request, origin: string) {
  if (request.method !== "POST")
    throw new StudioError("POST 요청만 지원합니다.", 405, "METHOD_NOT_ALLOWED");
  if (request.headers.get("origin") !== new URL(origin).origin)
    throw new StudioError("다른 사이트에서 보낸 요청은 허용하지 않습니다.", 403, "CROSS_ORIGIN");
}

function cookie(name: string, value: string, maxAge: number, path: string, sameSite: string) {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=${path}; HttpOnly; Secure; SameSite=${sameSite}`;
}

function sessionResponse(session: SupabaseSession, principal: StudioPrincipal) {
  const response = jsonResponse({ displayName: principal.displayName, role: principal.role });
  response.headers.append(
    "set-cookie",
    cookie(sessionCookieName, session.accessToken, session.expiresIn, "/", "Lax"),
  );
  response.headers.append(
    "set-cookie",
    cookie(refreshCookieName, session.refreshToken, refreshMaxAge, "/api/auth", "Strict"),
  );
  return response;
}

/** Only an approved active member receives cookies; a valid password alone is not enough. */
async function principalFor(context: AuthRouteContext, session: SupabaseSession) {
  return context.authenticate(
    new Request(context.origin, { headers: { authorization: `Bearer ${session.accessToken}` } }),
  );
}

function failure(error: unknown) {
  if (error instanceof StudioError)
    return jsonResponse({ error: error.message, code: error.code }, error.status);
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return jsonResponse(
      { error: "이메일과 비밀번호를 확인해 주세요.", code: "INVALID_INPUT" },
      400,
    );
  return jsonResponse({ error: "로그인을 처리하지 못했습니다.", code: "INTERNAL_ERROR" }, 500);
}

export async function loginRoute(request: Request, context: AuthRouteContext) {
  try {
    assertSameOrigin(request, context.origin);
    const input = loginSchema.parse(
      JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 4096))),
    );
    const session = await supabasePasswordLogin(
      context.supabase,
      input.email,
      input.password,
      context.fetchImpl,
    );
    if (!session)
      throw new StudioError("이메일 또는 비밀번호를 확인해 주세요.", 401, "LOGIN_FAILED");
    const principal = await principalFor(context, session);
    if (!principal)
      throw new StudioError("관리자 승인 후 이용할 수 있습니다.", 403, "MEMBERSHIP_REQUIRED");
    return sessionResponse(session, principal);
  } catch (error) {
    return failure(error);
  }
}

function cookieValue(request: Request, name: string) {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export async function refreshRoute(request: Request, context: AuthRouteContext) {
  try {
    assertSameOrigin(request, context.origin);
    const refreshToken = cookieValue(request, refreshCookieName);
    if (!refreshToken || refreshToken.length > 4096)
      throw new StudioError("다시 로그인해 주세요.", 401, "UNAUTHENTICATED");
    const session = await supabaseRefresh(context.supabase, refreshToken, context.fetchImpl);
    if (!session) throw new StudioError("다시 로그인해 주세요.", 401, "UNAUTHENTICATED");
    const principal = await principalFor(context, session);
    if (!principal)
      throw new StudioError("관리자 승인 후 이용할 수 있습니다.", 403, "MEMBERSHIP_REQUIRED");
    return sessionResponse(session, principal);
  } catch (error) {
    return failure(error);
  }
}

export async function logoutRoute(request: Request, context: Pick<AuthRouteContext, "origin">) {
  try {
    assertSameOrigin(request, context.origin);
    const response = jsonResponse({ ok: true });
    response.headers.append("set-cookie", cookie(sessionCookieName, "", 0, "/", "Lax"));
    response.headers.append("set-cookie", cookie(refreshCookieName, "", 0, "/api/auth", "Strict"));
    return response;
  } catch (error) {
    return failure(error);
  }
}
