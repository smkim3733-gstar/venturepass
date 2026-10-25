import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listCasesInRepository, runCaseSession } from "./studio-case-session";
import { MemoryOriginalStore, originalObjectKey } from "./studio-original-store";
import {
  ensureVenturePassSchema,
  PostgresCaseRowRepository,
  type SqlExecutor,
} from "./studio-postgres-repository";
import { emptyProfile, type SourceDocument } from "./studio-schema";
import { StudioStore } from "./studio-storage";
import { formatMigrationReport, migrateLocalDataToWeb } from "./studio-web-migration";

const orgA = randomUUID();
const orgB = randomUUID();
let database: PGlite;
let executor: SqlExecutor;
let dataDirectory: string;
let originals: MemoryOriginalStore;

function source(name: string): SourceDocument {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name,
    kind: "technology",
    text: "가상 본문",
    originalName: name,
    mimeType: "text/plain",
    extraction: "local",
    warnings: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** A local PC data folder with synthetic companies; returns their ids and original bytes. */
function seedLocal(companies: { name: string; businessNumber?: string; files?: number }[]) {
  const store = new StudioStore(dataDirectory);
  try {
    return companies.map((company) => {
      const created = store.create({
        ...emptyProfile(),
        companyName: company.name,
        businessNumber: company.businessNumber ?? "",
      });
      let revision = created.revision;
      const files: { sourceId: string; bytes: Uint8Array }[] = [];
      for (let index = 0; index < (company.files ?? 0); index += 1) {
        const item = source(`가상_원본_${index}.txt`);
        const bytes = new TextEncoder().encode(`${company.name} 원본 ${index} ${randomUUID()}`);
        revision = store.addUpload(created.id, revision, item, bytes).revision;
        files.push({ sourceId: item.id, bytes });
      }
      return { id: created.id, files };
    });
  } finally {
    store.close();
  }
}
const localRow = (id: string) => {
  const store = new StudioStore(dataDirectory);
  try {
    return store.exportCaseRow(id);
  } finally {
    store.close();
  }
};
const run = (options: Partial<Parameters<typeof migrateLocalDataToWeb>[0]> = {}) =>
  migrateLocalDataToWeb({
    dataDirectory,
    organizationId: orgA,
    executor,
    originals,
    ...options,
  });
const webRows = async () =>
  (await executor.query<{ id: string }>("SELECT id FROM venture_cases ORDER BY id")).rows;
const fileSha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

beforeEach(async () => {
  dataDirectory = mkdtempSync(join(tmpdir(), "venturepass-migration-test-"));
  originals = new MemoryOriginalStore();
  database = new PGlite();
  executor = {
    query: async (text, params) => {
      const result = await database.query(text, params);
      return { rows: result.rows as never[], affectedRows: result.affectedRows ?? 0 };
    },
  };
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
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("moving PC app companies to the web service", () => {
  it("only reports in preview mode and leaves both sides unchanged", async () => {
    const [company] = seedLocal([{ name: "가상 미리보기 회사", files: 2 }]);
    const before = fileSha(join(dataDirectory, "studio.sqlite"));
    const report = await run();
    expect(report.apply).toBe(false);
    expect(report.cases).toEqual([
      expect.objectContaining({ caseId: company.id, outcome: "ready", originals: 2 }),
    ]);
    expect(await webRows()).toEqual([]);
    expect(originals.objects.size).toBe(0);
    expect(fileSha(join(dataDirectory, "studio.sqlite"))).toBe(before);
    expect(formatMigrationReport(report)).toContain("--apply");
  });

  it("copies the exact row and originals, and a second run changes nothing", async () => {
    const [company] = seedLocal([{ name: "가상 이전 회사", files: 2 }]);
    const report = await run({ apply: true });
    expect(report.cases[0]).toMatchObject({ outcome: "migrated", originals: 2 });

    const repository = new PostgresCaseRowRepository(executor, orgA);
    expect(await repository.load(company.id)).toEqual(localRow(company.id));
    for (const file of company.files)
      expect(await originals.get(originalObjectKey(orgA, company.id, file.sourceId))).toEqual(
        file.bytes,
      );
    const [summary] = await listCasesInRepository(repository);
    expect(summary.companyName).toBe("가상 이전 회사");
    const loaded = await runCaseSession(repository, company.id, ({ store }) =>
      store.get(company.id),
    );
    expect(loaded.sources).toHaveLength(2);

    const again = await run({ apply: true });
    expect(again.cases[0].outcome).toBe("already-migrated");
    expect(await webRows()).toHaveLength(1);
    expect(originals.objects.size).toBe(2);
  });

  it("skips a company the web already has under another id unless allowed", async () => {
    const [web, webNamed] = seedLocal([
      { name: "가상 중복 회사", businessNumber: "123-45-67890" },
      { name: "가상 이름 회사 주식회사" },
    ]);
    await run({ apply: true });
    const [byNumber, byName] = seedLocal([
      { name: "다른 이름", businessNumber: "1234567890" },
      { name: "(주) 가상 이름 회사" },
    ]);

    const report = await run({ apply: true, caseIds: [byNumber.id] });
    expect(report.cases[0]).toMatchObject({ outcome: "duplicate-company", duplicateOf: web.id });
    const named = await run({ caseIds: [byName.id] });
    expect(named.cases[0]).toMatchObject({
      outcome: "duplicate-company",
      duplicateOf: webNamed.id,
    });

    const allowed = await run({
      apply: true,
      caseIds: [byNumber.id],
      allowDuplicateCaseIds: [byNumber.id],
    });
    expect(allowed.cases[0].outcome).toBe("migrated");
  });

  it("never overwrites a web copy that changed or belongs to another organization", async () => {
    const [changed, foreign] = seedLocal([
      { name: "가상 변경 회사" },
      { name: "가상 타조직 회사" },
    ]);
    await run({ apply: true, caseIds: [changed.id] });
    const repository = new PostgresCaseRowRepository(executor, orgA);
    await runCaseSession(repository, changed.id, ({ store }) => {
      const current = store.get(changed.id);
      store.mutate(
        changed.id,
        {
          action: "profile",
          revision: current.revision,
          profile: { ...current.profile, industry: "웹에서 고친 업종" },
        },
        () => [],
      );
    });
    const webBody = (await repository.load(changed.id)).body;
    await new PostgresCaseRowRepository(executor, orgB).insert(localRow(foreign.id));

    const report = await run({ apply: true });
    const outcome = (id: string) => report.cases.find((item) => item.caseId === id)?.outcome;
    expect(outcome(changed.id)).toBe("changed-on-web");
    expect(outcome(foreign.id)).toBe("other-organization");
    expect((await repository.load(changed.id)).body).toBe(webBody);
    await expect(repository.load(foreign.id)).rejects.toMatchObject({ status: 404 });
  });

  it("does not move a company whose original is missing on this PC", async () => {
    const [company] = seedLocal([{ name: "가상 누락 회사", files: 2 }]);
    unlinkSync(join(dataDirectory, "originals", company.id, `${company.files[1].sourceId}.bin`));
    const report = await run({ apply: true });
    expect(report.cases[0].outcome).toBe("original-missing");
    expect(await webRows()).toEqual([]);
    expect(originals.objects.size).toBe(0);
  });

  it("removes the originals it uploaded when saving the company fails", async () => {
    const [company] = seedLocal([{ name: "가상 실패 회사", files: 2 }]);
    const failing: SqlExecutor = {
      query: async (text, params) => {
        if (text.startsWith("INSERT INTO venture_cases")) throw new Error("synthetic failure");
        return executor.query(text, params);
      },
    };
    const report = await run({ apply: true, executor: failing });
    expect(report.cases[0]).toMatchObject({ caseId: company.id, outcome: "failed" });
    expect(originals.objects.size).toBe(0);
    expect(await webRows()).toEqual([]);
  });

  it("refuses an unknown organization and counts PC-only data it leaves behind", async () => {
    const [company] = seedLocal([{ name: "가상 PC 전용 회사" }]);
    await expect(run({ organizationId: randomUUID() })).rejects.toThrow("그 조직이 없습니다");
    await expect(run({ organizationId: "not-a-uuid" })).rejects.toThrow("형식");
    const local = new DatabaseSync(join(dataDirectory, "studio.sqlite"));
    local
      .prepare(
        "INSERT INTO venture_workflows (case_id, revision, body, updated_at) VALUES (?, 1, '{}', ?)",
      )
      .run(company.id, new Date().toISOString());
    local.close();
    const report = await run();
    expect(report.notMigrated).toEqual({
      ventureAccounts: 0,
      ventureWorkflows: 1,
      preparedPackages: 0,
      intakeOnlyOriginals: 0,
    });
    expect(formatMigrationReport(report)).toContain("벤처인 진행 기록 1개");
  });

  it("explains a missing PC data folder", async () => {
    await expect(run({ dataDirectory: join(dataDirectory, "missing") })).rejects.toThrow(
      "studio.sqlite",
    );
  });
});
