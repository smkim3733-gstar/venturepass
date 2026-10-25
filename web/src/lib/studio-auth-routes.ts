import { z } from "zod";
import { jsonResponse, readBoundedBody, StudioError } from "./studio-http";
import type { StudioPrincipal } from "./studio-request-scope";
import { staffPassword } from "./studio-members";
import { accessTokenFrom, sessionCookieName } from "./studio-server-auth";
import {
  supabaseChangeOwnPassword,
  supabasePasswordLogin,
  supabaseRefresh,
  supabaseSignOutOthers,
  supabaseVerifier,
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

function sessionResponse(
  session: SupabaseSession,
  principal: StudioPrincipal,
  extra: Record<string, unknown> = {},
) {
  const response = jsonResponse({
    displayName: principal.displayName,
    role: principal.role,
    ...extra,
  });
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

const passwordChangeSchema = z
  .object({ currentPassword: z.string().min(1).max(200), newPassword: staffPassword })
  .strict();
const changeFailures = {
  weak: ["비밀번호가 너무 단순합니다. 더 길게 정해 주세요.", 400, "WEAK_PASSWORD"],
  same: ["지금과 다른 비밀번호로 정해 주세요.", 400, "SAME_PASSWORD"],
  reauthentication: [
    "보안 확인이 필요합니다. 로그아웃 후 다시 로그인해 주세요.",
    401,
    "REAUTH_REQUIRED",
  ],
  failed: ["비밀번호를 바꾸지 못했습니다. 잠시 후 다시 시도해 주세요.", 502, "AUTH_FAILED"],
} as const;

/**
 * A signed-in member changes their own password. The current password is checked by a fresh
 * provider login for the same user, that fresh session makes the change (no service role key),
 * every other session is signed out, and the browser receives the fresh session cookies.
 */
export async function passwordChangeRoute(request: Request, context: AuthRouteContext) {
  try {
    assertSameOrigin(request, context.origin);
    const relogin = () => new StudioError("다시 로그인해 주세요.", 401, "UNAUTHENTICATED");
    const principal = await context.authenticate(request);
    const token = accessTokenFrom(request);
    if (!principal || !token) throw relogin();
    const verify = supabaseVerifier(context.supabase, context.fetchImpl);
    const identity = await verify(token);
    if (!identity || identity.userId !== principal.userId) throw relogin();
    const parsed = passwordChangeSchema.safeParse(
      JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 4096))),
    );
    if (!parsed.success)
      throw new StudioError(
        parsed.error.issues[0]?.message ?? "입력값을 확인해 주세요.",
        400,
        "INVALID_INPUT",
      );
    const input = parsed.data;
    if (input.newPassword === input.currentPassword) {
      const [message, status, code] = changeFailures.same;
      throw new StudioError(message, status, code);
    }
    const session = await supabasePasswordLogin(
      context.supabase,
      identity.email,
      input.currentPassword,
      context.fetchImpl,
    );
    if (!session)
      throw new StudioError("지금 비밀번호가 맞지 않습니다.", 400, "CURRENT_PASSWORD_WRONG");
    const fresh = await verify(session.accessToken);
    if (!fresh || fresh.userId !== principal.userId) throw relogin();
    const result = await supabaseChangeOwnPassword(
      context.supabase,
      session.accessToken,
      input.newPassword,
      context.fetchImpl,
    );
    if (result !== "changed") {
      const [message, status, code] = changeFailures[result];
      throw new StudioError(message, status, code);
    }
    const otherSessionsSignedOut = await supabaseSignOutOthers(
      context.supabase,
      session.accessToken,
      context.fetchImpl,
    );
    return sessionResponse(session, principal, { otherSessionsSignedOut });
  } catch (error) {
    return failure(error);
  }
}
