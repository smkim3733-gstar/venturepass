import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCaseInRepository,
  listCasesInRepository,
  runCaseSession,
} from "./studio-case-session";
import {
  ensureVenturePassSchema,
  PostgresCaseRowRepository,
  venturePassSchemaScript,
  type SqlExecutor,
} from "./studio-postgres-repository";
import { emptyProfile } from "./studio-schema";

const review = () => [];
const profile = { ...emptyProfile(), companyName: "합성 Postgres 회사" };
let database: PGlite;
let executor: SqlExecutor;
const orgA = randomUUID();
const orgB = randomUUID();

beforeEach(async () => {
  database = new PGlite();
  executor = {
    query: async (text, params) => {
      const result = await database.query(text, params);
      return { rows: result.rows as never[], affectedRows: result.affectedRows ?? 0 };
    },
  };
  await ensureVenturePassSchema(executor);
  await ensureVenturePassSchema(executor);
  for (const [id, name] of [
    [orgA, "합성 조직 A"],
    [orgB, "합성 조직 B"],
  ])
    await executor.query("INSERT INTO venture_organizations (id, name) VALUES ($1, $2)", [
      id,
      name,
    ]);
});
afterEach(async () => {
  await database.close();
});

describe("Supabase schema script", () => {
  it("matches the statements the code applies, including row level security", () => {
    const script = readFileSync(join(process.cwd(), "supabase", "schema.sql"), "utf8").replace(
      /\r\n/g,
      "\n",
    );
    expect(script).toBe(venturePassSchemaScript());
    expect(script.match(/ENABLE ROW LEVEL SECURITY/g)).toHaveLength(3);
  });
});

describe("Postgres company rows", () => {
  it("runs a session mutation and stores the exact JSON text it produced", async () => {
    const repository = new PostgresCaseRowRepository(executor, orgA);
    const created = await createCaseInRepository(repository, profile);
    await runCaseSession(repository, created.id, ({ store }) =>
      store.mutate(
        created.id,
        { action: "profile", revision: 0, profile: { ...profile, industry: "합성 업종" } },
        review,
      ),
    );
    const saved = await repository.load(created.id);
    expect(saved.revision).toBe(1);
    const reparsed = JSON.parse(saved.body);
    expect(reparsed.profile.industry).toBe("합성 업종");
    expect(JSON.stringify(reparsed)).toBe(saved.body);
  });

  it("rejects a stale compare-and-swap so concurrent sessions cannot lose an update", async () => {
    const repository = new PostgresCaseRowRepository(executor, orgA);
    const created = await createCaseInRepository(repository, profile);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = runCaseSession(repository, created.id, async ({ store }) => {
      await gate;
      return store.mutate(
        created.id,
        { action: "profile", revision: 0, profile: { ...profile, industry: "느린 쪽" } },
        review,
      );
    });
    await runCaseSession(repository, created.id, ({ store }) =>
      store.mutate(
        created.id,
        { action: "profile", revision: 0, profile: { ...profile, industry: "빠른 쪽" } },
        review,
      ),
    );
    release();
    await expect(slow).rejects.toMatchObject({ status: 409 });
    expect(JSON.parse((await repository.load(created.id)).body).profile.industry).toBe("빠른 쪽");
  });

  it("never reveals or changes a company of another organization", async () => {
    const ownerRepository = new PostgresCaseRowRepository(executor, orgA);
    const otherRepository = new PostgresCaseRowRepository(executor, orgB);
    const created = await createCaseInRepository(ownerRepository, profile);
    const row = await ownerRepository.load(created.id);
    await expect(otherRepository.load(created.id)).rejects.toMatchObject({ status: 404 });
    expect(await otherRepository.compareAndSwap(0, { ...row, revision: 1 })).toBe(false);
    expect(await otherRepository.remove(created.id, 0)).toBe(false);
    expect(await listCasesInRepository(otherRepository)).toEqual([]);
    expect((await ownerRepository.load(created.id)).revision).toBe(0);
  });

  it("treats a malformed id as not found instead of a database error", async () => {
    const repository = new PostgresCaseRowRepository(executor, orgA);
    await expect(repository.load("not-a-uuid")).rejects.toMatchObject({ status: 404 });
  });

  it("deletes only at the revision the session saw", async () => {
    const repository = new PostgresCaseRowRepository(executor, orgA);
    const created = await createCaseInRepository(repository, profile);
    expect(await repository.remove(created.id, 1)).toBe(false);
    await runCaseSession(repository, created.id, ({ store }) => store.delete(created.id, 0));
    await expect(repository.load(created.id)).rejects.toMatchObject({ status: 404 });
  });
});
