import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  loginRoute,
  logoutRoute,
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
