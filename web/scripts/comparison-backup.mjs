import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const comparisonBackupHelp = `공개 주장 비교 SQL10~13의 종료된 원장·양쪽 증인 보관
node --conditions=react-server --import ./scripts/operational-typescript-loader.mjs scripts/comparison-backup.mjs <명령>
모든 명령: --database-id <기존 DB UUID> --storage-version <10|11|12|13>
backup: --data-root <기존 자료 절대 경로> --control-dir <기존 제어 절대 경로> --destination <새 보관 폴더>
verify: --archive <보관 폴더 절대 경로>
restore-candidate: --archive <보관 폴더 절대 경로> --destination <새 검토용 폴더>
기존 앱/원장 연결을 먼저 정상 종료하세요. WAL·잠금·미완료 증인은 자동 정리하지 않습니다.
대상은 동기화/Git 밖의 새 폴더여야 합니다. studio.sqlite·설정·키·원본 첨부는 포함하지 않습니다.
비교 원장에는 비교 본문·비용·승인·nonce가 포함될 수 있으므로 비공개로 보관합니다.
.restore-pending은 영구 실행 차단 표시입니다. 복원 후보를 운영 경로로 사용하거나 표시를 제거하지 마세요.
검증은 당시 보관본의 구조·일관성 확인이며 최신성·실제 청구·현재 회사 확인이나 재실행 승인이 아닙니다.
manifestSha256은 별도 안전한 곳에 보관하세요. 파일의 SHA만으로 공격자의 전체 보관본 교체를 인증할 수 없습니다.`;

export function parseComparisonBackupArguments(args) {
  if (args.length === 1 && args[0] === "--help") return null;
  const paths =
    args[0] === "backup"
      ? ["data-root", "control-dir", "destination"]
      : args[0] === "verify"
        ? ["archive"]
        : args[0] === "restore-candidate"
          ? ["archive", "destination"]
          : null;
  if (!paths) throw Error("INVALID_ARGUMENTS");
  const names = ["database-id", "storage-version", ...paths],
    values = {};
  if (args.length !== names.length * 2 + 1) throw Error("INVALID_ARGUMENTS");
  for (let i = 1; i < args.length; i += 2) {
    const name = args[i].slice(2);
    if (!args[i].startsWith("--") || !names.includes(name) || name in values || !args[i + 1])
      throw Error("INVALID_ARGUMENTS");
    values[name] = args[i + 1];
  }
  if (
    !/^(10|11|12|13)$/.test(values["storage-version"]) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      values["database-id"],
    )
  )
    throw Error("INVALID_ARGUMENTS");
  for (const key of paths) if (!isAbsolute(values[key])) throw Error("ABSOLUTE_PATH_REQUIRED");
  return { command: args[0], ...values };
}
export async function runComparisonBackupCommand(args) {
  const values = parseComparisonBackupArguments(args);
  if (!values) return { help: comparisonBackupHelp };
  const api = await import("../src/lib/studio-comparison-backup.ts");
  const selection = {
    databaseInstanceId: values["database-id"],
    environment: "production",
    scopeId: "candidate-quality-provider-v2-live",
  };
  const version = Number(values["storage-version"]);
  if (values.command === "backup")
    return api.backupComparisonData({
      dataRoot: resolve(values["data-root"]),
      controlDirectory: resolve(values["control-dir"]),
      destination: resolve(values.destination),
      selection,
      storageVersion: version,
    });
  if (values.command === "verify")
    return api.verifyComparisonBackup(resolve(values.archive), selection, version);
  return api.restoreComparisonCandidate(
    resolve(values.archive),
    resolve(values.destination),
    selection,
    version,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runComparisonBackupCommand(process.argv.slice(2));
    console.log(result.help ?? JSON.stringify(result));
  } catch (error) {
    // No customer paths, row bodies or raw SQLite diagnostics on stdout/stderr.
    const code = String(error?.code ?? error?.message ?? "");
    const safe = /^(?:PUBLIC_COMPARISON_)?[A-Z][A-Z_]{2,90}$/.test(code)
      ? code
      : "COMPARISON_BACKUP_FAILED";
    console.error(safe);
    process.exitCode = 1;
  }
}
