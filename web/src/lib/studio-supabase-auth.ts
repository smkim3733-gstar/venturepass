import { z } from "zod";
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
