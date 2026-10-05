// Node-only handle registry shared with StudioStore's standalone CLI/test use.
// The server-only comparison guard/writer remain the only consumers that read under this capability.
import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import {
  comparisonStorageFail as fail,
  comparisonRootIdentity,
  comparisonFileIdentity,
  checkComparisonDatabasePath,
  requireComparisonDatabaseHandle,
} from "./studio-public-comparison-file-identity";
export type ComparisonCompanyGuard = Readonly<{ kind: "comparison-company-guard" }>;
type Owned = {
  db: DatabaseSync;
  root: string;
  file: string;
  rootIdentity: ReturnType<typeof comparisonRootIdentity>;
  identity: ReturnType<typeof comparisonFileIdentity>;
  active: boolean;
  closed: boolean;
};
const origins = new WeakMap<
  DatabaseSync,
  {
    root: string;
    rootIdentity: ReturnType<typeof comparisonRootIdentity>;
    identity: ReturnType<typeof comparisonFileIdentity>;
  }
>();
/** Captured when StudioStore opens its connection, before any capability can be requested. */
export function recordComparisonCompanyConnection(db: DatabaseSync, root: string) {
  if (origins.has(db)) fail("COMPANY_CAPABILITY_INVALID");
  const pin = (file: string) => {
    const s = lstatSync(file, { bigint: true });
    return { dev: s.dev.toString(), ino: s.ino.toString(), birthtimeNs: s.birthtimeNs.toString() };
  };
  origins.set(db, { root, rootIdentity: pin(root), identity: pin(join(root, "studio.sqlite")) });
}
const guards = new WeakMap<ComparisonCompanyGuard, Owned>();
const byDatabase = new WeakMap<DatabaseSync, Set<ComparisonCompanyGuard>>();
/** Internal issuer used only by an existing StudioStore. It does not open/create a store. */
export function issueComparisonCompanyGuard(
  db: DatabaseSync,
  root: string,
): ComparisonCompanyGuard {
  if (db.isTransaction) fail("COMPANY_TRANSACTION_ACTIVE");
  const origin = origins.get(db);
  if (!origin || origin.root !== root) fail("COMPANY_CAPABILITY_INVALID");
  const file = join(root, "studio.sqlite");
  if (
    digest(origin.identity) !== digest(comparisonFileIdentity(file)) ||
    digest(origin.rootIdentity) !== digest(comparisonRootIdentity(root))
  )
    fail("COMPANY_FILE_CHANGED");
  checkComparisonDatabasePath(root, file);
  requireComparisonDatabaseHandle(db, file);
  const token = Object.freeze({ kind: "comparison-company-guard" as const });
  guards.set(token, {
    db,
    root,
    file,
    rootIdentity: comparisonRootIdentity(root),
    identity: comparisonFileIdentity(file),
    active: false,
    closed: false,
  });
  const set = byDatabase.get(db) ?? new Set();
  set.add(token);
  byDatabase.set(db, set);
  return token;
}
export function revokeComparisonCompanyGuards(db: DatabaseSync) {
  for (const token of byDatabase.get(db) ?? []) {
    const owned = guards.get(token)!;
    owned.closed = true;
  }
  byDatabase.delete(db);
  origins.delete(db);
}
export function ownedComparisonCompanyGuard(token: ComparisonCompanyGuard) {
  const s = guards.get(token);
  if (!s || s.closed) fail("COMPANY_CAPABILITY_INVALID");
  return s;
}
