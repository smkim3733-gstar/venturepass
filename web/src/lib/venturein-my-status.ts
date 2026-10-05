import { z } from "zod";
import {
  validateVentureScreenSnapshot,
  verifyVentureCompany,
  type VentureScreenSnapshot,
} from "./venturein-inspection";

export const ventureMyStatusUrl = "https://www.smes.go.kr/venturein/myVntr/viewMyVntr";
export const ventureMyStatusLimits = { rows: 100, cellChars: 500 } as const;
export const ventureMyApplicationHeaders = [
  "No", "신청번호", "신청일자", "통지완료일자", "결과", "결과확인", "이의신청", "결제정보",
] as const;
export const ventureMyCertificateHeaders = [
  "No", "유형", "발급일자", "유효기간", "벤처확인발급번호", "최초확인일자",
  "변경사항", "신청내역보기", "벤처확인취소일자", "확인서출력",
] as const;
export const ventureMyReadColumns = {
  application: ["신청번호", "신청일자", "통지완료일자", "결과"],
  certificate: ["유형", "발급일자", "유효기간", "벤처확인발급번호", "최초확인일자", "벤처확인취소일자"],
} as const;

const reasonSchema = z.enum(["ambiguous-structure", "observation-limit", "unsupported-content"]);
const observedTable = z.object({
  state: z.literal("observed"),
  headers: z.array(z.string().max(100)).min(1).max(11),
  rows: z.array(z.array(z.string().max(ventureMyStatusLimits.cellChars)).max(11))
    .max(ventureMyStatusLimits.rows),
}).strict();
export const ventureMyTableSchema = z.discriminatedUnion("state", [
  observedTable,
  z.object({ state: z.literal("not-present") }).strict(),
  z.object({ state: z.literal("unsupported"), reason: reasonSchema }).strict(),
]);
export type VentureMyTable = z.infer<typeof ventureMyTableSchema>;
const identity = z.string().min(1).max(200).refine(
  (value) => value === value.trim() && !/[\u0000-\u001f\u007f*\u2022\u25cf\u2026]/u.test(value),
);
const expectedSchema = z.object({
  businessNumber: z.string().max(100),
  applicationNumber: identity.nullable(),
}).strict();
export type VentureMyStatusExpected = z.infer<typeof expectedSchema>;
const inputSchema = z.object({
  screen: z.unknown(),
  applications: ventureMyTableSchema,
  certificates: ventureMyTableSchema,
}).strict();

export class VentureMyStatusError extends Error {
  constructor(public readonly code: "INVALID_OBSERVATION" | "UNSUPPORTED_PAGE" | "COMPANY_UNVERIFIED" | "SCREEN_CHANGED" | "READ_FAILED") {
    super("현재 회사의 벤처인 기록을 정확히 읽지 못했습니다. 원래 화면과 신청번호를 확인해 주세요.");
    this.name = "VentureMyStatusError";
  }
}
export function validateVentureMyStatusExpected(input: unknown): VentureMyStatusExpected {
  const parsed = expectedSchema.safeParse(input);
  if (!parsed.success) throw new VentureMyStatusError("INVALID_OBSERVATION");
  return parsed.data;
}
export type VentureMyApplication = {
  applicationNumber: string;
  applicationDateText: string | null;
  notifiedDateText: string | null;
  resultText: string | null;
};
export type VentureMyCertificate = {
  certificateNumber: string;
  typeText: string | null;
  issuedDateText: string | null;
  validityText: string | null;
  firstConfirmedDateText: string | null;
  cancelledDateText: string | null;
};
export type VentureMyRows<T> =
  | { state: "observed"; rows: T[] }
  | { state: "not-present"; rows: [] }
  | { state: "unsupported"; rows: []; reason: z.infer<typeof reasonSchema> };
export const normalizeVentureMyLabel = (value: string) => value.replace(/\s+/gu, " ").trim();

function decodeTable<T>(
  table: VentureMyTable,
  kind: "application" | "certificate",
  convert: (read: (name: string) => string | null) => T & { identity: string | null },
): VentureMyRows<T> {
  if (table.state !== "observed") return { ...table, rows: [] };
  const unsupported = (): VentureMyRows<T> => ({
    state: "unsupported", rows: [], reason: "ambiguous-structure",
  });
  const headers = table.headers.map(normalizeVentureMyLabel);
  // Only the observed trailing, blank certificate header is dispensable.
  if (kind === "certificate" && headers.length === 11 && headers[10] === "") headers.pop();
  const wanted: readonly string[] = kind === "application"
    ? headers.includes("이의신청가능기간")
      ? [...ventureMyApplicationHeaders, "이의신청가능기간"]
      : ventureMyApplicationHeaders
    : ventureMyCertificateHeaders;
  if (
    headers.length !== wanted.length || new Set(headers).size !== headers.length ||
    headers.some((label) => !wanted.includes(label))
  ) return unsupported();
  const identities = new Set<string>();
  const rows: T[] = [];
  for (const cells of table.rows) {
    if (cells.length !== headers.length) return unsupported();
    const read = (name: string) => cells[headers.indexOf(name)]?.trim() || null;
    const record = convert(read);
    if (!identity.safeParse(record.identity).success || identities.has(record.identity!))
      return unsupported();
    identities.add(record.identity!);
    const { identity: omitted, ...rest } = record;
    void omitted;
    rows.push(rest as T);
  }
  return { state: "observed", rows };
}

/**
 * Supplied parsing is never an authenticated observation, a receipt, or a write permission.
 * Number matching is literal; ordering/dates never select a target or link a certificate.
 */
export function decodeVentureMyStatus(input: unknown, expectedInput: unknown) {
  const parsed = inputSchema.safeParse(input);
  const expected = validateVentureMyStatusExpected(expectedInput);
  if (!parsed.success) throw new VentureMyStatusError("INVALID_OBSERVATION");
  let screen: VentureScreenSnapshot;
  try { screen = validateVentureScreenSnapshot(parsed.data.screen); }
  catch { throw new VentureMyStatusError("INVALID_OBSERVATION"); }
  if (screen.url !== ventureMyStatusUrl) throw new VentureMyStatusError("UNSUPPORTED_PAGE");
  if (verifyVentureCompany(screen, expected.businessNumber).status !== "matched")
    throw new VentureMyStatusError("COMPANY_UNVERIFIED");
  const applications = decodeTable<VentureMyApplication>(parsed.data.applications, "application", (read) => ({
    identity: read("신청번호"), applicationNumber: read("신청번호")!,
    applicationDateText: read("신청일자"), notifiedDateText: read("통지완료일자"), resultText: read("결과"),
  }));
  const certificates = decodeTable<VentureMyCertificate>(parsed.data.certificates, "certificate", (read) => ({
    identity: read("벤처확인발급번호"), certificateNumber: read("벤처확인발급번호")!,
    typeText: read("유형"), issuedDateText: read("발급일자"), validityText: read("유효기간"),
    firstConfirmedDateText: read("최초확인일자"), cancelledDateText: read("벤처확인취소일자"),
  }));
  const requested = expected.applicationNumber;
  const match = applications.state === "observed"
    ? applications.rows.find((row) => row.applicationNumber === requested) : undefined;
  return {
    origin: "supplied-observation" as const,
    screenId: screen.id,
    observedAt: screen.observedAt,
    url: screen.url,
    companyNumberMatched: true as const,
    applications,
    certificates,
    target: {
      applicationNumber: requested,
      state: requested === null ? "not-requested" as const
        : applications.state !== "observed" ? "unverified" as const
          : match ? "matched" as const : "not-observed" as const,
      row: match ? { ...match } : null,
    },
    // Current progress cannot be attributed to an application from the inspected evidence.
    progressAttribution: "unverified" as const,
    certificateApplicationLink: "unverified" as const,
    officialStatusChecked: false as const,
    receiptVerified: false as const,
    transmissionAllowed: false as const,
    databaseChanged: false as const,
  };
}
