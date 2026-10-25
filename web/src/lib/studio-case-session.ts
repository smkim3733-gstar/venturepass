import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudioError } from "./studio-http";
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
export async function runCaseSession<T>(
  repository: CaseRowRepository,
  caseId: string,
  run: (session: CaseSession) => T | Promise<T>,
): Promise<T> {
  const session = ephemeralStore();
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
        return;
      }
      if (current.revision === persisted.revision && current.body === persisted.body) return;
      if (!(await repository.compareAndSwap(persisted.revision, current)))
        throw new StudioError(staleMessage, 409, "STALE_REVISION");
      persisted = current;
    };
    const result = await run({ store: session.store, checkpoint });
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

let serverRepository: CaseRowRepository | null = null;
/** Server mode wiring point; null keeps the local single-user store. */
export function configureCaseRepository(repository: CaseRowRepository | null) {
  serverRepository = repository;
}

export function listCases(): Promise<CaseSummary[]> {
  if (serverRepository) return listCasesInRepository(serverRepository);
  return Promise.resolve().then(() => getStudioStore().list());
}

export function createCase(profile: CompanyProfile) {
  if (serverRepository) return createCaseInRepository(serverRepository, profile);
  return Promise.resolve().then(() => getStudioStore().create(profile));
}

export function withCaseStore<T>(
  caseId: string,
  run: (session: CaseSession) => T | Promise<T>,
): Promise<T> {
  if (serverRepository) return runCaseSession(serverRepository, caseId, run);
  return Promise.resolve().then(() => run({ store: getStudioStore(), checkpoint: async () => {} }));
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
