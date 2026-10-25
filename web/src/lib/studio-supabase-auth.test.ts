import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { supabasePasswordLogin, supabaseRefresh, supabaseVerifier } from "./studio-supabase-auth";

const config = { url: "https://example-project.supabase.test", anonKey: "anon-test-key" };
const fakeFetch = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("Supabase Auth over HTTP", () => {
  it("verifies a token by asking the provider for its user", async () => {
    const id = randomUUID();
    const fetchImpl = fakeFetch(200, { id, email: "staff@example.test" });
    expect(await supabaseVerifier(config, fetchImpl)("token-value-xxxxxxxxxxxxxxxx")).toEqual({
      userId: id,
      email: "staff@example.test",
    });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://example-project.supabase.test/auth/v1/user");
    expect(init.headers).toMatchObject({
      apikey: "anon-test-key",
      authorization: "Bearer token-value-xxxxxxxxxxxxxxxx",
    });
  });

  it.each([
    ["rejected token", fakeFetch(401, { message: "invalid" })],
    ["malformed user", fakeFetch(200, { id: "not-uuid", email: "x" })],
    [
      "network failure",
      vi.fn(async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    ],
  ])("treats a %s as not logged in", async (_label, fetchImpl) => {
    expect(await supabaseVerifier(config, fetchImpl)("token-value-xxxxxxxxxxxxxxxx")).toBeNull();
  });

  it("returns a session for a password login and a refresh", async () => {
    const session = {
      access_token: "a".repeat(40),
      refresh_token: "r".repeat(20),
      expires_in: 3600,
    };
    const login = fakeFetch(200, session);
    expect(await supabasePasswordLogin(config, "staff@example.test", "pw", login)).toEqual({
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      expiresIn: 3600,
    });
    const [url, init] = (login as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/auth/v1/token?grant_type=password");
    expect(JSON.parse(init.body)).toEqual({ email: "staff@example.test", password: "pw" });
    expect(await supabaseRefresh(config, "r".repeat(20), fakeFetch(200, session))).not.toBeNull();
    expect(
      await supabasePasswordLogin(config, "staff@example.test", "bad", fakeFetch(400, {})),
    ).toBeNull();
  });

  it("refuses a non-https project URL", async () => {
    const verifier = supabaseVerifier(
      { url: "http://example.test", anonKey: "k" },
      fakeFetch(200, { id: randomUUID(), email: "a@b.c" }),
    );
    expect(await verifier("token-value-xxxxxxxxxxxxxxxx")).toBeNull();
  });
});
