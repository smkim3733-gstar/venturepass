import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { readSafe, safePath, nativePaths, samePath, writeNew } from "./local-data-files.mjs";

const commonNames = ["data-root", "control-dir", "database-id", "company-id", "company-revision"];
const prepareNames = [...commonNames, "run-id", "policy-file", "output"];
export const comparisonInputHelp = `기존 공개 근거 비교 예약의 실행 입력 준비 (외부 전송 없음)
회사별 예약 조회: 같은 명령의 list 동작에 아래 data-root/control-dir/database-id/company-id/company-revision만 지정합니다.
목록의 runId를 직접 선택해 prepare의 --run-id에 사용합니다. 목록 조회는 정책 검토나 실행 승인이 아닙니다.
node --conditions=react-server --import ./scripts/operational-typescript-loader.mjs scripts/comparison-input.mjs prepare
  --data-root <기존 자료 절대 경로> --control-dir <기존 증인 제어 절대 경로>
  --database-id <기존 DB UUID> --company-id <회사 UUID> --company-revision <현재 버전>
  --run-id <기존 예약 UUID> --policy-file <검토된 정책 JSON 절대 경로> --output <새 JSON 절대 경로>
정책 파일은 basis와 usagePolicy만 포함하며 공식 근거 검토를 대신하지 않습니다.
출력은 제어 디렉터리의 형제 파일이어야 하며 기존 파일을 덮어쓰지 않습니다.
예약·정책·예산·승인·환경 설정을 만들거나 바꾸지 않습니다. 이후 실행 화면에서 최신 검토와 별도 동의가 필요합니다.`;

export function parseComparisonInputArguments(args) {
  if (args.length === 1 && args[0] === "--help") return null;
  const names = args[0] === "list" ? commonNames : args[0] === "prepare" ? prepareNames : null;
  if (!names || args.length !== 1 + names.length * 2) throw Error("INVALID_ARGUMENTS");
  const values = {};
  for (let i = 1; i < args.length; i += 2) {
    const name = args[i].slice(2);
    if (!args[i].startsWith("--") || !names.includes(name) || name in values || !args[i + 1])
      throw Error("INVALID_ARGUMENTS");
    values[name] = args[i + 1];
  }
  if (
    !/^(0|[1-9]\d{0,15})$/.test(values["company-revision"]) ||
    !Number.isSafeInteger(Number(values["company-revision"]))
  )
    throw Error("INVALID_ARGUMENTS");
  for (const name of args[0] === "list"
    ? ["data-root", "control-dir"]
    : ["data-root", "control-dir", "policy-file", "output"])
    if (!isAbsolute(values[name])) throw Error("ABSOLUTE_PATH_REQUIRED");
  if (
    args[0] === "prepare" &&
    (!samePath(dirname(resolve(values.output)), dirname(resolve(values["control-dir"]))) ||
      !/\.json$/i.test(values.output))
  )
    throw Error("OUTPUT_LOCATION_INVALID");
  return { command: args[0], ...values };
}

function closePreparation(owner) {
  try {
    if (!owner.close().closed) throw Error("not closed");
  } catch {
    throw Error("PREPARATION_CLEANUP_REQUIRED");
  }
}

/** Catalog data is released only after the original reader confirms cleanup. */
export async function listComparisonInputReservations(args) {
  const values = parseComparisonInputArguments(args);
  if (!values || values.command !== "list") throw Error("INVALID_ARGUMENTS");
  const { createComparisonReservationCatalog } =
    await import("../src/lib/studio-comparison-input-preparation.ts");
  const owner = createComparisonReservationCatalog({
    dataRoot: values["data-root"],
    controlDirectory: values["control-dir"],
    databaseInstanceId: values["database-id"],
    companyId: values["company-id"],
    companyRevision: Number(values["company-revision"]),
  });
  try {
    return owner.list();
  } finally {
    closePreparation(owner);
  }
}

export async function runComparisonInputCommand(args) {
  return args[0] === "list"
    ? listComparisonInputReservations(args)
    : prepareComparisonInputFile(args);
}

/** Explicit CLI only. Failure before confirmed cleanup never publishes an input file.
 * Existing outputs are refused even when their contents happen to match. */
export async function prepareComparisonInputFile(args) {
  const values = parseComparisonInputArguments(args);
  if (!values) return { help: comparisonInputHelp };
  if (values.command !== "prepare") throw Error("INVALID_ARGUMENTS");
  const output = resolve(values.output),
    source = resolve(values["policy-file"]);
  safePath(dirname(output), "directory");
  nativePaths([dirname(output)]);
  try {
    lstatSync(output);
    throw Error("OUTPUT_EXISTS");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const read = () => readSafe(source, 128 * 1024, null, true);
  const original = read(),
    policy = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(original.bytes));
  if (
    !policy ||
    typeof policy !== "object" ||
    Array.isArray(policy) ||
    Object.keys(policy).sort().join(",") !== "basis,usagePolicy"
  )
    throw Error("POLICY_FILE_INVALID");
  // Help/argument/file rejection must not import SQL or any runtime owner.
  const { createComparisonInputPreparation } =
    await import("../src/lib/studio-comparison-input-preparation.ts");
  const owner = createComparisonInputPreparation({
    dataRoot: values["data-root"],
    controlDirectory: values["control-dir"],
    databaseInstanceId: values["database-id"],
    settings: {
      companyId: values["company-id"],
      companyRevision: Number(values["company-revision"]),
      runId: values["run-id"],
      ...policy,
    },
  });
  let result;
  try {
    result = owner.prepare();
  } finally {
    closePreparation(owner);
  }
  if (read().sha256 !== original.sha256) throw Error("POLICY_FILE_CHANGED");
  if (Date.parse(result.summary.expiresAt) <= Date.now()) throw Error("PREPARATION_EXPIRED");
  const bytes = Buffer.from(JSON.stringify(result.document, null, 2) + "\n");
  if (bytes.length > 128 * 1024) throw Error("OUTPUT_LIMIT");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  writeNew(output, bytes);
  if (readSafe(output, 128 * 1024).sha256 !== sha256) throw Error("OUTPUT_VERIFICATION_FAILED");
  return { status: "prepared", ...result.summary, outputSha256: sha256 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runComparisonInputCommand(process.argv.slice(2));
    console.log(result.help ?? JSON.stringify(result));
  } catch (error) {
    const safe = new Set([
      "INVALID_ARGUMENTS",
      "ABSOLUTE_PATH_REQUIRED",
      "OUTPUT_LOCATION_INVALID",
      "OUTPUT_EXISTS",
      "POLICY_FILE_INVALID",
      "POLICY_FILE_CHANGED",
      "PREPARATION_CLEANUP_REQUIRED",
      "PREPARATION_EXPIRED",
      "OUTPUT_LIMIT",
      "OUTPUT_VERIFICATION_FAILED",
    ]);
    console.error(
      JSON.stringify({
        status: "blocked",
        code: safe.has(error.message) ? error.message : "PREPARATION_UNAVAILABLE",
        transmissionAllowed: false,
      }),
    );
    process.exitCode = 1;
  }
}
