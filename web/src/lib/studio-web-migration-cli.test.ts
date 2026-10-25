import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { emptyProfile } from "./studio-schema";
import { StudioStore } from "./studio-storage";

const web = process.cwd();
const flags = ["--experimental-transform-types", "--no-warnings"];
const settings = ["DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
const cleanEnv = () => {
  const env = { ...process.env };
  for (const key of [...settings, "VENTUREPASS_MODE"]) delete env[key];
  return env;
};
let directory = "";
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = "";
});

describe("web migration command", () => {
  it("names missing settings without printing any values", () => {
    const result = spawnSync(process.execPath, [...flags, "scripts/migrate-to-web.mjs"], {
      cwd: web,
      env: cleanEnv(),
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  });

  it("loads the app's TypeScript migration code in plain Node and previews a PC folder", () => {
    directory = mkdtempSync(join(tmpdir(), "venturepass-cli-test-"));
    const store = new StudioStore(directory);
    store.create({ ...emptyProfile(), companyName: "가상 명령 회사" });
    store.close();
    const hooks = pathToFileURL(join(web, "scripts", "ts-hooks.mjs")).href;
    const migration = pathToFileURL(join(web, "src", "lib", "studio-web-migration.ts")).href;
    const pglite = pathToFileURL(
      join(web, "node_modules", "@electric-sql", "pglite", "dist", "index.js"),
    ).href;
    // The command itself needs a real database; this drives the same module with PGlite.
    const program = `
      import { register } from "node:module";
      register(${JSON.stringify(hooks)});
      const { PGlite } = await import(${JSON.stringify(pglite)});
      const { migrateLocalDataToWeb, formatMigrationReport } = await import(${JSON.stringify(migration)});
      const { ensureVenturePassSchema } = await import(${JSON.stringify(migration.replace("studio-web-migration", "studio-postgres-repository"))});
      const { MemoryOriginalStore } = await import(${JSON.stringify(migration.replace("studio-web-migration", "studio-original-store"))});
      const db = new PGlite();
      const executor = { query: async (t, p) => { const r = await db.query(t, p); return { rows: r.rows, affectedRows: r.affectedRows ?? 0 }; } };
      await ensureVenturePassSchema(executor);
      const org = crypto.randomUUID();
      await executor.query("INSERT INTO venture_organizations (id, name) VALUES ($1, '가상 조직')", [org]);
      const report = await migrateLocalDataToWeb({ dataDirectory: process.argv[1], organizationId: org, executor, originals: new MemoryOriginalStore() });
      console.log(formatMigrationReport(report));
      await db.close();
    `;
    const result = spawnSync(
      process.execPath,
      [...flags, "--input-type=module", "-e", program, directory],
      { cwd: web, env: cleanEnv(), encoding: "utf8", timeout: 120_000 },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("가상 명령 회사");
    expect(result.stdout).toContain("옮길 수 있습니다");
  }, 150_000);
});
