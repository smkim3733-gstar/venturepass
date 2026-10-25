import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  supabasePasswordLogin,
  supabaseRefresh,
  supabaseStaffAccounts,
  supabaseVerifier,
} from "./studio-supabase-auth";

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

describe("Supabase Auth admin API for staff accounts", () => {
  const admin = { url: config.url, serviceRoleKey: "service-test-key" };

  it("creates a confirmed account with the service role key and returns its id", async () => {
    const id = randomUUID();
    const fetchImpl = fakeFetch(200, { id, email: "new@example.test" });
    expect(
      await supabaseStaffAccounts(admin, fetchImpl).create("new@example.test", "pw-123456789"),
    ).toBe(id);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${config.url}/auth/v1/admin/users`);
    expect(init.headers).toMatchObject({ authorization: "Bearer service-test-key" });
    expect(JSON.parse(String(init.body))).toMatchObject({ email_confirm: true });
  });

  it("explains an existing e-mail and hides other provider failures", async () => {
    await expect(
      supabaseStaffAccounts(admin, fakeFetch(422, { error_code: "email_exists" })).create(
        "dup@example.test",
        "pw-123456789",
      ),
    ).rejects.toMatchObject({ status: 409, code: "ACCOUNT_EXISTS" });
    await expect(
      supabaseStaffAccounts(admin, fakeFetch(500, { msg: "internal detail" })).create(
        "x@example.test",
        "pw-123456789",
      ),
    ).rejects.toMatchObject({ status: 502, code: "AUTH_ADMIN_FAILED" });
  });

  it("updates a password only for a UUID user path", async () => {
    const fetchImpl = fakeFetch(200, {});
    const accounts = supabaseStaffAccounts(admin, fetchImpl);
    const id = randomUUID();
    await accounts.setPassword(id, "pw-123456789");
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      `${config.url}/auth/v1/admin/users/${id}`,
    );
    await expect(accounts.setPassword("../other", "pw-123456789")).rejects.toThrow();
  });
});
