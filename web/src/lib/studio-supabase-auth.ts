import { z } from "zod";
import { StudioError } from "./studio-http";
import type { StaffAccounts } from "./studio-members";
import type { AccessTokenVerifier } from "./studio-server-auth";

/** Public project URL and anon key. The service-role key is never used for staff login. */
export type SupabaseAuthConfig = { url: string; anonKey: string };
export type SupabaseSession = { accessToken: string; refreshToken: string; expiresIn: number };
type Fetch = typeof fetch;

const userSchema = z.object({ id: z.string().uuid(), email: z.string().min(3) });
const sessionSchema = z.object({
  access_token: z.string().min(20),
  refresh_token: z.string().min(8),
  expires_in: z
    .number()
    .int()
    .positive()
    .max(7 * 24 * 3600),
});

function endpoint(config: SupabaseAuthConfig, path: string) {
  const base = new URL(config.url);
  if (base.protocol !== "https:" && base.hostname !== "127.0.0.1" && base.hostname !== "localhost")
    throw new Error("Supabase URL must use https");
  return new URL(path, base).toString();
}

/** Asks Supabase Auth who owns the token; any failure is treated as "not logged in". */
export function supabaseVerifier(config: SupabaseAuthConfig, fetchImpl: Fetch = fetch) {
  const verify: AccessTokenVerifier = async (token) => {
    try {
      const response = await fetchImpl(endpoint(config, "/auth/v1/user"), {
        headers: { apikey: config.anonKey, authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!response.ok) return null;
      const user = userSchema.safeParse(await response.json());
      return user.success ? { userId: user.data.id, email: user.data.email } : null;
    } catch {
      return null;
    }
  };
  return verify;
}

async function tokenRequest(
  config: SupabaseAuthConfig,
  grant: "password" | "refresh_token",
  body: Record<string, string>,
  fetchImpl: Fetch,
): Promise<SupabaseSession | null> {
  try {
    const response = await fetchImpl(endpoint(config, `/auth/v1/token?grant_type=${grant}`), {
      method: "POST",
      headers: { apikey: config.anonKey, "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const session = sessionSchema.safeParse(await response.json());
    return session.success
      ? {
          accessToken: session.data.access_token,
          refreshToken: session.data.refresh_token,
          expiresIn: session.data.expires_in,
        }
      : null;
  } catch {
    return null;
  }
}

export function supabasePasswordLogin(
  config: SupabaseAuthConfig,
  email: string,
  password: string,
  fetchImpl: Fetch = fetch,
) {
  return tokenRequest(config, "password", { email, password }, fetchImpl);
}

export function supabaseRefresh(
  config: SupabaseAuthConfig,
  refreshToken: string,
  fetchImpl: Fetch = fetch,
) {
  return tokenRequest(config, "refresh_token", { refresh_token: refreshToken }, fetchImpl);
}

/** Server-only admin access. The service role key bypasses all checks and never reaches a browser. */
export type SupabaseAdminConfig = { url: string; serviceRoleKey: string };

/** Staff login accounts through the Supabase Auth admin API (confirmed, no invitation e-mail). */
export function supabaseStaffAccounts(
  config: SupabaseAdminConfig,
  fetchImpl: Fetch = fetch,
): StaffAccounts {
  const call = (path: string, method: string, body?: unknown) =>
    fetchImpl(endpoint({ url: config.url, anonKey: config.serviceRoleKey }, path), {
      method,
      headers: {
        apikey: config.serviceRoleKey,
        authorization: `Bearer ${config.serviceRoleKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  const failed = () =>
    new StudioError(
      "로그인 계정 처리에 실패했습니다. 잠시 후 다시 시도해 주세요.",
      502,
      "AUTH_ADMIN_FAILED",
    );
  const userPath = (userId: string) => `/auth/v1/admin/users/${z.string().uuid().parse(userId)}`;
  return {
    async create(email, password) {
      const response = await call("/auth/v1/admin/users", "POST", {
        email,
        password,
        email_confirm: true,
      });
      if (response.status === 422 || response.status === 409) {
        const body = (await response.json().catch(() => ({}))) as { error_code?: string };
        if (body.error_code === "email_exists" || response.status === 409)
          throw new StudioError(
            "이미 로그인 계정이 있는 이메일입니다. Supabase 사용자 목록을 확인해 주세요.",
            409,
            "ACCOUNT_EXISTS",
          );
        if (body.error_code === "weak_password")
          throw new StudioError(
            "비밀번호가 너무 단순합니다. 더 길게 정해 주세요.",
            400,
            "WEAK_PASSWORD",
          );
      }
      if (!response.ok) throw failed();
      const user = userSchema.safeParse(await response.json().catch(() => null));
      if (!user.success) throw failed();
      return user.data.id;
    },
    async setPassword(userId, password) {
      const response = await call(userPath(userId), "PUT", { password });
      if (response.status === 422) {
        const body = (await response.json().catch(() => ({}))) as { error_code?: string };
        if (body.error_code === "weak_password")
          throw new StudioError(
            "비밀번호가 너무 단순합니다. 더 길게 정해 주세요.",
            400,
            "WEAK_PASSWORD",
          );
      }
      if (!response.ok) throw failed();
    },
    async remove(userId) {
      await call(userPath(userId), "DELETE");
    },
  };
}
