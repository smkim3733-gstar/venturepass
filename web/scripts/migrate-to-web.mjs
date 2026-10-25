// Copies this PC app's companies (and their uploaded originals) to one organization of the
// web service. Preview by default; add --apply to write. Run from the web folder:
//   pnpm data:to-web                       (lists organizations)
//   pnpm data:to-web --organization <id>   (preview)
//   pnpm data:to-web --organization <id> --apply
// Settings come from the environment or web/.env.local and are never printed.
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

register("./ts-hooks.mjs", import.meta.url);
const webDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = (file) => import(pathToFileURL(path.join(webDirectory, "src", "lib", file)).href);

const { values } = parseArgs({
  options: {
    organization: { type: "string" },
    apply: { type: "boolean", default: false },
    case: { type: "string", multiple: true },
    "allow-duplicate": { type: "string", multiple: true },
    "data-dir": { type: "string" },
  },
  strict: true,
});

const required = ["DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
const missing = required.filter((key) => !process.env[key]?.trim());
if (missing.length) {
  console.error(`웹 서비스 설정이 없습니다: ${missing.join(", ")}`);
  console.error("web/.env.local에 직접 넣은 뒤 다시 실행해 주세요. 값은 채팅에 붙여 넣지 마세요.");
  process.exit(2);
}

const { default: postgres } = await import("postgres");
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", max: 2, prepare: false });
const executor = {
  query: async (text, params = []) => {
    const result = await sql.unsafe(text, params);
    return { rows: [...result], affectedRows: result.count };
  },
};

let exitCode = 0;
try {
  if (!values.organization) {
    const { rows } = await executor.query(
      "SELECT id, name FROM venture_organizations ORDER BY created_at",
    );
    console.log("옮길 조직을 --organization 뒤에 적어 주세요.");
    for (const row of rows) console.log(`- ${row.name}: ${row.id}`);
    if (!rows.length) console.log("- 웹 서비스에 조직이 아직 없습니다.");
  } else {
    const { SupabaseOriginalStore } = await app("studio-original-store.ts");
    const { migrateLocalDataToWeb, formatMigrationReport } = await app("studio-web-migration.ts");
    const report = await migrateLocalDataToWeb({
      dataDirectory:
        values["data-dir"] ??
        process.env.VENTURE_DATA_DIR ??
        path.join(webDirectory, ".venture-pass"),
      organizationId: values.organization,
      executor,
      originals: new SupabaseOriginalStore({
        url: process.env.SUPABASE_URL,
        serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        bucket: process.env.SUPABASE_STORAGE_BUCKET?.trim() || "venturepass-originals",
      }),
      apply: values.apply,
      caseIds: values.case,
      allowDuplicateCaseIds: values["allow-duplicate"],
    });
    console.log(formatMigrationReport(report));
    if (report.cases.some((item) => item.outcome === "failed")) exitCode = 1;
  }
} catch (error) {
  // Never print driver errors: they can include connection details.
  console.error(
    error?.name === "WebMigrationError"
      ? error.message
      : "웹 서비스에 연결하거나 자료를 읽지 못했습니다. 설정과 인터넷 연결을 확인해 주세요.",
  );
  exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
process.exit(exitCode);
