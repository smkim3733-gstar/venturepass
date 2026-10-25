import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudioError } from "./studio-http";
import { currentRequestScope, serverModeRequested } from "./studio-request-scope";
import {
  originalObjectKey,
  removeOldTemporaryObjects,
  type OriginalObjectStore,
} from "./studio-original-store";
import type { CaseSummary, CompanyProfile } from "./studio-schema";
import { getStudioStore, StudioStore, type CaseRowSnapshot } from "./studio-storage";

/**
 * Persistence for company document rows outside this process (server mode). Every call is
 * already scoped to one organization by whoever constructed the repository.
 */
export interface CaseRowRepository {
  list(): Promise<CaseRowSnapshot[]>;
  load(id: string): Promise<CaseRowSnapshot>;
  insert(row: CaseRowSnapshot): Promise<void>;
  /** Writes only if the stored revision still equals `expectedRevision`. */
  compareAndSwap(expectedRevision: number, row: CaseRowSnapshot): Promise<boolean>;
  remove(id: string, expectedRevision: number): Promise<boolean>;
}

export type CaseSession = {
  store: StudioStore;
  /**
   * Makes the current row durable before slow external work (AI calls) so a crash keeps the
   * same checkpoints the local SQLite store would. A no-op in local mode.
   */
  checkpoint(): Promise<void>;
  /**
   * Server mode: copies these sources' originals from object storage into the session so
   * StudioStore code that reads originals (ZIP packages) works unchanged. Local: a no-op.
   */
  stageOriginals(sourceIds: string[]): Promise<void>;
};

const staleMessage = "다른 작업에서 기업정보가 변경되었습니다. 새로고침 후 다시 시도해 주세요.";

function ephemeralStore() {
  const root = mkdtempSync(join(tmpdir(), "venturepass-session-"));
  return { root, store: new StudioStore(root, { memory: true }) };
}

function dispose(session: { root: string; store: StudioStore }) {
  session.store.close();
  rmSync(session.root, { recursive: true, force: true });
}

/**
 * Runs unchanged StudioStore logic against one case loaded from `repository`, then saves the
 * result with a revision compare-and-swap. A concurrent writer yields 409 instead of a lost
 * update, exactly like the local store's CAS.
 */
/** Original files of one organization's cases, keyed by the server (see originalObjectKey). */
export type SessionOriginals = { store: OriginalObjectStore; organizationId: string };

type StoredSource = { id: string; originalName: string | null; mimeType: string | null };
function sourcesWithOriginals(body: string): StoredSource[] {
  const parsed = JSON.parse(body) as { sources?: StoredSource[] };
  return (parsed.sources ?? []).filter((source) => source.originalName);
}

export async function runCaseSession<T>(
  repository: CaseRowRepository,
  caseId: string,
  run: (session: CaseSession) => T | Promise<T>,
  originals?: SessionOriginals,
): Promise<T> {
  const session = ephemeralStore();
  const key = (sourceId: string) => originalObjectKey(originals!.organizationId, caseId, sourceId);
  const uploaded = new Set<string>();
  // Originals written during this session (addUpload) go to object storage before the row
  // that references them; a lost CAS leaves at most an unreferenced object, never a dangling row.
  const uploadNewOriginals = async (current: CaseRowSnapshot) => {
    if (!originals) return [];
    const added: string[] = [];
    for (const source of sourcesWithOriginals(current.body)) {
      if (uploaded.has(source.id)) continue;
      const file = join(session.root, "originals", caseId, `${source.id}.bin`);
      if (!existsSync(file)) continue;
      await originals.store.put(
        key(source.id),
        readFileSync(file),
        source.mimeType || "application/octet-stream",
      );
      uploaded.add(source.id);
      added.push(source.id);
    }
    return added;
  };
  const removeOriginals = async (sourceIds: string[]) => {
    if (!originals) return;
    // Best effort after the row is saved: a failure leaves an unreferenced object only.
    for (const sourceId of sourceIds) await originals.store.remove(key(sourceId)).catch(() => {});
  };
  try {
    let persisted = await repository.load(caseId);
    session.store.importCaseRow(persisted);
    const checkpoint = async () => {
      let current: CaseRowSnapshot | null;
      try {
        current = session.store.exportCaseRow(caseId);
      } catch (error) {
        if (!(error instanceof StudioError) || error.code !== "NOT_FOUND") throw error;
        current = null;
      }
      if (!current) {
        if (!(await repository.remove(caseId, persisted.revision)))
          throw new StudioError(staleMessage, 409, "STALE_REVISION");
        await removeOriginals(sourcesWithOriginals(persisted.body).map((source) => source.id));
        if (originals)
          for (const kind of ["exports", "staging"] as const)
            await removeOldTemporaryObjects(
              originals.store,
              originals.organizationId,
              caseId,
              kind,
              0,
            ).catch(() => {});
        return;
      }
      if (current.revision === persisted.revision && current.body === persisted.body) return;
      const added = await uploadNewOriginals(current);
      if (!(await repository.compareAndSwap(persisted.revision, current))) {
        await removeOriginals(added);
        throw new StudioError(staleMessage, 409, "STALE_REVISION");
      }
      const kept = new Set(sourcesWithOriginals(current.body).map((source) => source.id));
      await removeOriginals(
        sourcesWithOriginals(persisted.body)
          .map((source) => source.id)
          .filter((id) => !kept.has(id)),
      );
      persisted = current;
    };
    const stageOriginals = async (sourceIds: string[]) => {
      if (!originals) return;
      const stored = new Map(
        sourcesWithOriginals(session.store.exportCaseRow(caseId).body).map((source) => [
          source.id,
          source,
        ]),
      );
      for (const sourceId of sourceIds) {
        if (!stored.has(sourceId) || uploaded.has(sourceId)) continue;
        const bytes = await originals.store.get(key(sourceId));
        if (!bytes) continue;
        const directory = join(session.root, "originals", caseId);
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, `${sourceId}.bin`), bytes, { flag: "wx" });
        // Already in object storage: the checkpoint must not upload it again.
        uploaded.add(sourceId);
      }
    };
    const result = await run({ store: session.store, checkpoint, stageOriginals });
    await checkpoint();
    return result;
  } finally {
    dispose(session);
  }
}

export async function createCaseInRepository(
  repository: CaseRowRepository,
  profile: CompanyProfile,
) {
  const session = ephemeralStore();
  try {
    const created = session.store.create(profile);
    await repository.insert(session.store.exportCaseRow(created.id));
    return created;
  } finally {
    dispose(session);
  }
}

/** Same summaries and staleness refresh as the local list. */
export async function listCasesInRepository(repository: CaseRowRepository): Promise<CaseSummary[]> {
  const rows = await repository.list();
  const session = ephemeralStore();
  try {
    for (const row of rows) session.store.importCaseRow(row);
    return session.store.list();
  } finally {
    dispose(session);
  }
}

/**
 * The organization's repository for this request (server mode), or null for the local
 * single-user store. Server mode without a request scope fails closed.
 */
function scopedRepository(): CaseRowRepository | null {
  const scope = currentRequestScope();
  if (scope) return scope.repository;
  if (serverModeRequested()) throw new StudioError("로그인이 필요합니다.", 401, "UNAUTHENTICATED");
  return null;
}

export function listCases(): Promise<CaseSummary[]> {
  return Promise.resolve().then(() => {
    const repository = scopedRepository();
    return repository ? listCasesInRepository(repository) : getStudioStore().list();
  });
}

export function createCase(profile: CompanyProfile) {
  return Promise.resolve().then(() => {
    const repository = scopedRepository();
    return repository
      ? createCaseInRepository(repository, profile)
      : getStudioStore().create(profile);
  });
}

function scopedOriginals(): SessionOriginals | undefined {
  const scope = currentRequestScope();
  return scope?.originals
    ? { store: scope.originals, organizationId: scope.principal.organizationId }
    : undefined;
}

export function withCaseStore<T>(
  caseId: string,
  run: (session: CaseSession) => T | Promise<T>,
): Promise<T> {
  return Promise.resolve().then(() => {
    const repository = scopedRepository();
    return repository
      ? runCaseSession(repository, caseId, run, scopedOriginals())
      : run({
          store: getStudioStore(),
          checkpoint: async () => {},
          stageOriginals: async () => {},
        });
  });
}

/** True when this request can store uploaded originals (always true locally). */
export function originalsAvailable() {
  return !currentRequestScope() || Boolean(currentRequestScope()?.originals);
}

/** The stored original of a source, checked against the company record first. */
export async function readOriginalFile(caseId: string, sourceId: string) {
  const repository = scopedRepository();
  if (!repository) return getStudioStore().originalForVentureInput(caseId, sourceId);
  const originals = scopedOriginals();
  const source = await runCaseSession(repository, caseId, ({ store }) =>
    store.get(caseId).sources.find((item) => item.id === sourceId),
  );
  if (!source?.originalName || !originals)
    throw new StudioError("원본 파일을 찾을 수 없습니다.", 404, "SOURCE_NOT_FOUND");
  const bytes = await originals.store.get(
    originalObjectKey(originals.organizationId, caseId, sourceId),
  );
  if (!bytes) throw new StudioError("원본 파일이 저장소에 없습니다.", 404, "SOURCE_NOT_FOUND");
  return { source, buffer: Buffer.from(bytes) };
}

/** In-process repository with the same CAS contract; for tests and local experiments. */
export class MemoryCaseRowRepository implements CaseRowRepository {
  private rows = new Map<string, CaseRowSnapshot>();
  async list() {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }
  async load(id: string) {
    const row = this.rows.get(id);
    if (!row) throw new StudioError("기업을 찾을 수 없습니다.", 404, "NOT_FOUND");
    return { ...row };
  }
  async insert(row: CaseRowSnapshot) {
    if (this.rows.has(row.id)) throw new StudioError("이미 있는 기업입니다.", 409, "CASE_EXISTS");
    this.rows.set(row.id, { ...row });
  }
  async compareAndSwap(expectedRevision: number, row: CaseRowSnapshot) {
    const current = this.rows.get(row.id);
    if (!current || current.revision !== expectedRevision) return false;
    this.rows.set(row.id, { ...row });
    return true;
  }
  async remove(id: string, expectedRevision: number) {
    const current = this.rows.get(id);
    if (!current || current.revision !== expectedRevision) return false;
    this.rows.delete(id);
    return true;
  }
}
