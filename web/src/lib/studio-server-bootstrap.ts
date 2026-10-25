import type { SqlExecutor } from "./studio-postgres-repository";
import { PostgresCaseRowRepository } from "./studio-postgres-repository";
import type { StudioServerRuntime } from "./studio-request-scope";
import { createPrincipalResolver, type AccessTokenVerifier } from "./studio-server-auth";
import { supabaseVerifier, type SupabaseAuthConfig } from "./studio-supabase-auth";

/** Settings for the shared web service. Secrets come from the hosting environment only. */
export type ServerSettings = {
  origin: string;
  databaseUrl: string;
  supabase: SupabaseAuthConfig;
};

const requiredKeys = [
  "VENTUREPASS_ORIGIN",
  "DATABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
] as const;

/** Null unless server mode is requested and every setting is present and well formed. */
export function serverSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): ServerSettings | null {
  if (env.VENTUREPASS_MODE !== "server") return null;
  if (requiredKeys.some((key) => !env[key]?.trim())) return null;
  try {
    const origin = new URL(env.VENTUREPASS_ORIGIN!).origin;
    if (!origin.startsWith("https://")) return null;
    return {
      origin,
      databaseUrl: env.DATABASE_URL!,
      supabase: { url: env.SUPABASE_URL!, anonKey: env.SUPABASE_ANON_KEY! },
    };
  } catch {
    return null;
  }
}

/** Builds the runtime from an executor and verifier; production passes Postgres and Supabase. */
export function createServerRuntime(
  origin: string,
  executor: SqlExecutor,
  verify: AccessTokenVerifier,
): StudioServerRuntime {
  return {
    origin,
    authenticate: createPrincipalResolver(executor, verify),
    repositoryFor: (principal) => new PostgresCaseRowRepository(executor, principal.organizationId),
  };
}

/** `postgres` client adapter. Supabase's pooler needs unnamed statements (prepare: false). */
export async function postgresExecutor(databaseUrl: string): Promise<SqlExecutor> {
  const { default: postgres } = await import("postgres");
  const sql = postgres(databaseUrl, { ssl: "require", max: 5, prepare: false, idle_timeout: 20 });
  return {
    query: async (text, params = []) => {
      const result = await sql.unsafe(text, params as never[]);
      return { rows: [...result] as never[], affectedRows: result.count };
    },
  };
}

/** Login route context: the same settings and membership check as API requests. */
export async function loadAuthRouteContextFromEnv() {
  const settings = serverSettingsFromEnv();
  const runtime = await loadServerRuntimeFromEnv();
  if (!settings || !runtime) return null;
  return {
    origin: settings.origin,
    supabase: settings.supabase,
    authenticate: runtime.authenticate,
  };
}

let pending: Promise<StudioServerRuntime | null> | null = null;
/** Lazily wires the runtime once per server process; incomplete settings stay unconfigured. */
export function loadServerRuntimeFromEnv(): Promise<StudioServerRuntime | null> {
  pending ??= (async () => {
    const settings = serverSettingsFromEnv();
    if (!settings) return null;
    return createServerRuntime(
      settings.origin,
      await postgresExecutor(settings.databaseUrl),
      supabaseVerifier(settings.supabase),
    );
  })().catch(() => {
    pending = null;
    return null;
  });
  return pending;
}
