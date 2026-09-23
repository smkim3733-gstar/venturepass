import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(webRoot, "..");
const inputPath = join(workspaceRoot, "분석", "workbook_data.json");
const sourcePath = join(workspaceRoot, "벤처기업명단(2026년8월).xlsx");
const dataRoot = join(webRoot, "data");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function dateValue(value, id) {
  const compact = String(value);
  assert(/^\d{8}$/.test(compact), `Invalid confirmation date for record ${id}`);
  const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  const date = new Date(`${iso}T00:00:00Z`);
  assert(
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === iso,
    `Invalid confirmation date for record ${id}`,
  );
  return iso;
}

function distribution(records, key) {
  const counts = new Map();
  for (const record of records) counts.set(record[key], (counts.get(record[key]) ?? 0) + 1);
  return [...counts]
    .map(([label, count]) => ({ label, count, share: count / records.length }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "ko"));
}

const workbook = JSON.parse(await readFile(inputPath, "utf8"));
const indices = Object.fromEntries(workbook.headers.map((header, index) => [header, index]));
const required = [
  "연번",
  "업체명",
  "벤처확인유형",
  "지역",
  "주소",
  "업종분류(기보)",
  "업종명(11차)",
  "주생산품",
  "벤처유효시작일",
  "벤처유효종료일",
  "신규/재확인",
];
for (const header of required)
  assert(Number.isInteger(indices[header]), `Missing source column: ${header}`);
const rows = workbook.rows.filter((row) => row[indices["벤처확인유형"]] === "혁신성장유형");
assert(
  workbook.rows.length === 40858,
  "Unexpected source record count; review the source snapshot before importing",
);
assert(
  rows.length === 26525,
  "Unexpected innovation record count; review the source snapshot before importing",
);
assert(
  JSON.stringify(rows) === JSON.stringify(workbook.innovation_rows),
  "Innovation rows do not match the original rows",
);

const ids = new Set();
const companies = rows.map((row) => {
  const value = (column) => row[indices[column]];
  const id = Number(value("연번"));
  assert(
    Number.isSafeInteger(id) && id > 0 && !ids.has(id),
    `Invalid or duplicate original record ID: ${id}`,
  );
  ids.add(id);
  const confirmationKind = value("신규/재확인");
  assert(
    confirmationKind === "신규" || confirmationKind === "재확인",
    `Unknown confirmation kind: ${confirmationKind}`,
  );
  const company = {
    id,
    name: String(value("업체명") ?? ""),
    region: String(value("지역") ?? ""),
    address: String(value("주소") ?? ""),
    industry: String(value("업종분류(기보)") ?? ""),
    detailIndustry: String(value("업종명(11차)") ?? ""),
    product: String(value("주생산품") ?? ""),
    validFrom: dateValue(value("벤처유효시작일"), id),
    validUntil: dateValue(value("벤처유효종료일"), id),
    confirmationKind,
  };
  assert(
    company.name && company.region && company.industry,
    `Missing required company fields: ${id}`,
  );
  assert(company.validFrom <= company.validUntil, `Reversed confirmation dates: ${id}`);
  return company;
});

const sourceSha256 = createHash("sha256")
  .update(await readFile(sourcePath))
  .digest("hex");
assert(
  sourceSha256 === workbook.summary.quality["원본SHA256"],
  "Source workbook differs from the audited snapshot",
);
const summary = {
  source: "벤처기업명단(2026년8월).xlsx",
  sourceSha256,
  snapshotMonth: "2026-08",
  total: workbook.rows.length,
  innovation: companies.length,
  innovationShare: companies.length / workbook.rows.length,
  industries: distribution(companies, "industry"),
  regions: distribution(companies, "region"),
  kinds: distribution(companies, "confirmationKind"),
  detailIndustryCount: new Set(companies.map(({ detailIndustry }) => detailIndustry)).size,
  detailIndustries: distribution(companies, "detailIndustry").slice(0, 20),
  notes: [
    "기업 수는 원본 명단의 기록 수입니다. 원본 연번을 ID로 사용하며 같은 이름의 기업도 별도 기록으로 유지합니다.",
    "2026년 8월 명단에 포함된 혁신성장유형 기록이며, 8월 신규 승인 실적 또는 현재 유효기업 조회 결과가 아닙니다.",
    "유효시작일과 유효종료일은 확인유효기간입니다. 설립일과 업력은 이 명단에 없습니다.",
    "신규는 벤처확인 신청 구분이며 신규 창업을 의미하지 않습니다.",
    "업종·지역별 비중은 명단 구성비입니다. 합격률이나 개별 기업의 선정 이유를 뜻하지 않습니다.",
    "지역과 업종은 원본 표기를 유지했습니다. 대표자명은 앱 데이터에서 제외했습니다.",
  ],
};

await mkdir(dataRoot, { recursive: true });
await writeFile(join(dataRoot, "venture-companies.json"), `${JSON.stringify(companies)}\n`, "utf8");
await writeFile(
  join(dataRoot, "venture-summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
  "utf8",
);
console.log(
  `Imported ${companies.length.toLocaleString("en-US")} innovation records from ${summary.total.toLocaleString("en-US")} source rows.`,
);
console.log(`Server data: ${dataRoot}`);
console.log(`Source SHA-256: ${sourceSha256}`);
