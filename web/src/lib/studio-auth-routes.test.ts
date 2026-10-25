import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  loginRoute,
  logoutRoute,
  passwordChangeRoute,
  refreshCookieName,
  refreshRoute,
  type AuthRouteContext,
} from "./studio-auth-routes";
import { accessTokenFrom, sessionCookieName } from "./studio-server-auth";

const origin = "https://venturepass.test";
const goodToken = "approved-access-token-xxxxxxxx";
const pendingToken = "pending-access-token-xxxxxxxxx";
const sessionFor = (accessToken: string) => ({
  access_token: accessToken,
  refresh_token: "refresh-token-value",
  expires_in: 3600,
});

function context(): AuthRouteContext {
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (body.password === "correct") return Response.json(sessionFor(goodToken));
    if (body.password === "pending") return Response.json(sessionFor(pendingToken));
    if (body.refresh_token === "refresh-token-value") return Response.json(sessionFor(goodToken));
    return new Response("{}", { status: 400 });
  }) as unknown as typeof fetch;
  return {
    origin,
    supabase: { url: "https://project.supabase.test", anonKey: "anon" },
    fetchImpl,
    authenticate: async (request) =>
      accessTokenFrom(request) === goodToken
        ? {
            userId: randomUUID(),
            organizationId: randomUUID(),
            role: "editor",
            displayName: "가상 담당자",
          }
        : null,
  };
}
const post = (path: string, body: unknown, headers: Record<string, string> = { origin }) =>
  new Request(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const cookies = (response: Response) => response.headers.getSetCookie();

describe("staff login routes", () => {
  it("sets HttpOnly session cookies only for an approved member", async () => {
    const response = await loginRoute(
      post("/api/auth/login", { email: "staff@example.test", password: "correct" }),
      context(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ displayName: "가상 담당자", role: "editor" });
    const set = cookies(response);
    expect(set.find((item) => item.startsWith(`${sessionCookieName}=`))).toMatch(
      /HttpOnly; Secure; SameSite=Lax/,
    );
    expect(set.find((item) => item.startsWith(`${refreshCookieName}=`))).toMatch(
      /Path=\/api\/auth; HttpOnly; Secure; SameSite=Strict/,
    );
  });

  it("does not set cookies for a wrong password or an unapproved account", async () => {
    const wrong = await loginRoute(
      post("/api/auth/login", { email: "staff@example.test", password: "wrong" }),
      context(),
    );
    expect(wrong.status).toBe(401);
    expect(cookies(wrong)).toEqual([]);
    const pending = await loginRoute(
      post("/api/auth/login", { email: "staff@example.test", password: "pending" }),
      context(),
    );
    expect(pending.status).toBe(403);
    expect((await pending.json()).code).toBe("MEMBERSHIP_REQUIRED");
    expect(cookies(pending)).toEqual([]);
  });

  it("rejects cross-site and malformed login requests", async () => {
    const crossSite = await loginRoute(
      post(
        "/api/auth/login",
        { email: "staff@example.test", password: "correct" },
        { origin: "https://evil.example" },
      ),
      context(),
    );
    expect(crossSite.status).toBe(403);
    const malformed = await loginRoute(post("/api/auth/login", { email: "x" }), context());
    expect(malformed.status).toBe(400);
  });

  it("refreshes from the refresh cookie and clears both cookies on logout", async () => {
    const refreshed = await refreshRoute(
      post("/api/auth/refresh", {}, { origin, cookie: `${refreshCookieName}=refresh-token-value` }),
      context(),
    );
    expect(refreshed.status).toBe(200);
    const missing = await refreshRoute(post("/api/auth/refresh", {}), context());
    expect(missing.status).toBe(401);
    const logout = await logoutRoute(post("/api/auth/logout", {}), { origin });
    expect(logout.status).toBe(200);
    expect(cookies(logout).every((item) => item.includes("Max-Age=0"))).toBe(true);
  });
});

describe("own password change", () => {
  const userId = randomUUID();
  const email = "staff@example.test";
  const cookieToken = "cookie-access-token-xxxxxxxxxx";
  const freshToken = "fresh-access-token-xxxxxxxxxxx";

  function setup(options: { changeError?: string; otherUser?: boolean } = {}) {
    let password = "current-password";
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
      const { pathname, search } = new URL(url);
      const method = init.method ?? "GET";
      const bearer = String((init.headers as Record<string, string>).authorization ?? "");
      calls.push(`${method} ${pathname}${search} ${bearer.replace("Bearer ", "")}`);
      if (pathname === "/auth/v1/user" && method === "GET") {
        if (bearer !== `Bearer ${cookieToken}` && bearer !== `Bearer ${freshToken}`)
          return new Response("{}", { status: 401 });
        const id = options.otherUser && bearer.includes(freshToken) ? randomUUID() : userId;
        return Response.json({ id, email });
      }
      if (pathname === "/auth/v1/token") {
        const body = JSON.parse(String(init.body));
        return body.email === email && body.password === password
          ? Response.json(sessionFor(freshToken))
          : new Response("{}", { status: 400 });
      }
      if (pathname === "/auth/v1/user" && method === "PUT") {
        if (bearer !== `Bearer ${freshToken}`) return new Response("{}", { status: 401 });
        if (options.changeError)
          return Response.json({ error_code: options.changeError }, { status: 422 });
        password = JSON.parse(String(init.body)).password;
        return Response.json({ id: userId, email });
      }
      if (pathname === "/auth/v1/logout") return new Response(null, { status: 204 });
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    const context: AuthRouteContext = {
      origin,
      supabase: { url: "https://project.supabase.test", anonKey: "anon" },
      fetchImpl,
      authenticate: async (request) =>
        [cookieToken, freshToken].includes(accessTokenFrom(request) ?? "")
          ? { userId, organizationId: randomUUID(), role: "viewer", displayName: "가상 담당자" }
          : null,
    };
    return { context, calls, password: () => password };
  }
  const change = (body: unknown, cookie = `${sessionCookieName}=${cookieToken}`) =>
    post("/api/auth/password", body, { origin, cookie });

  it("checks the current password, changes it with the member's own session and renews cookies", async () => {
    const { context, calls, password } = setup();
    const response = await passwordChangeRoute(
      change({ currentPassword: "current-password", newPassword: "new-password-123" }),
      context,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      displayName: "가상 담당자",
      role: "viewer",
      otherSessionsSignedOut: true,
    });
    expect(password()).toBe("new-password-123");
    expect(calls).toContain(`PUT /auth/v1/user ${freshToken}`);
    expect(calls).toContain(`POST /auth/v1/logout?scope=others ${freshToken}`);
    expect(calls.some((call) => call.includes("/admin/"))).toBe(false);
    expect(cookies(response).find((item) => item.startsWith(`${sessionCookieName}=`))).toContain(
      freshToken,
    );
  });

  it("refuses a wrong current password, a reused or short password and a missing session", async () => {
    const { context, password } = setup();
    const wrong = await passwordChangeRoute(
      change({ currentPassword: "wrong", newPassword: "new-password-123" }),
      context,
    );
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).code).toBe("CURRENT_PASSWORD_WRONG");
    expect(cookies(wrong)).toEqual([]);
    const same = await passwordChangeRoute(
      change({ currentPassword: "current-password", newPassword: "current-password" }),
      context,
    );
    expect((await same.json()).code).toBe("SAME_PASSWORD");
    const short = await passwordChangeRoute(
      change({ currentPassword: "current-password", newPassword: "short" }),
      context,
    );
    expect(short.status).toBe(400);
    expect((await short.json()).error).toContain("10자 이상");
    const anonymous = await passwordChangeRoute(
      change({ currentPassword: "current-password", newPassword: "new-password-123" }, ""),
      context,
    );
    expect(anonymous.status).toBe(401);
    const crossSite = await passwordChangeRoute(
      post(
        "/api/auth/password",
        { currentPassword: "current-password", newPassword: "new-password-123" },
        { origin: "https://evil.example", cookie: `${sessionCookieName}=${cookieToken}` },
      ),
      context,
    );
    expect(crossSite.status).toBe(403);
    expect(password()).toBe("current-password");
  });

  it("does not change anything when the fresh login belongs to someone else", async () => {
    const { context, calls } = setup({ otherUser: true });
    const response = await passwordChangeRoute(
      change({ currentPassword: "current-password", newPassword: "new-password-123" }),
      context,
    );
    expect(response.status).toBe(401);
    expect(calls.some((call) => call.startsWith("PUT"))).toBe(false);
  });

  it("explains provider refusals without setting cookies", async () => {
    for (const [errorCode, code] of [
      ["weak_password", "WEAK_PASSWORD"],
      ["reauthentication_needed", "REAUTH_REQUIRED"],
      ["unexpected", "AUTH_FAILED"],
    ]) {
      const { context } = setup({ changeError: errorCode });
      const response = await passwordChangeRoute(
        change({ currentPassword: "current-password", newPassword: "new-password-123" }),
        context,
      );
      expect((await response.json()).code).toBe(code);
      expect(cookies(response)).toEqual([]);
    }
  });
});
