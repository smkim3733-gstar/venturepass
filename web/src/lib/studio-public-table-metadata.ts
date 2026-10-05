import { z } from "zod";
import {
  publicResearchCommandSchema,
  publicResearchCandidateSchema,
  publicResearchTableUrl,
} from "./studio-public-research-result";

export const publicTableMetadataCommandSchema = z
  .object({
    action: z.literal("read-selected-table-metadata"),
    topic: publicResearchCommandSchema.shape.topic,
    candidate: publicResearchCandidateSchema,
    searchRetrievedAt: z.iso.datetime(),
    kind: z.enum(["TBL", "PRD", "SOURCE"]),
    confirmed: z.literal(true),
  })
  .strict()
  .refine(
    ({ candidate: c }) =>
      !!c.originalUrl &&
      publicResearchTableUrl(c.originalUrl, c.organizationId, c.tableId) === c.originalUrl,
  );
export type PublicTableMetadataCommand = z.infer<typeof publicTableMetadataCommandSchema>;
const optionalText = (max: number) => z.string().max(max).nullable().optional();
const titleRows = z
  .array(
    z
      .object({
        TBL_NM: z.string().min(1).max(300),
        TBL_NM_ENG: optionalText(300),
      })
      .strict(),
  )
  .max(1);
const periodRows = z
  .array(
    z
      .object({
        PRD_SE: z.string().min(1).max(300),
        PRD_DE: z.string().min(1).max(8),
      })
      .strict(),
  )
  .max(32);
const sourceRows = z
  .array(
    z
      .object({
        JOSA_NM: z.string().max(300),
        STAT_ID: z.string().max(40),
        DEPT_NM: optionalText(300),
        DEPT_PHONE: optionalText(100),
      })
      .strict(),
  )
  .max(10);
export const publicTableMetadataLimits = {
  identityBasis: "request-target-not-echoed",
  periodsComplete: false,
  numericalDataRead: false,
  originalRead: false,
  factChecked: false,
  companyApplicabilityChecked: false,
  databaseChanged: false,
  aiInputApproved: false,
} as const;
export function decodePublicTableMetadata(raw: unknown, kind: PublicTableMetadataCommand["kind"]) {
  if (kind === "TBL") return { kind, rows: titleRows.parse(raw) };
  if (kind === "SOURCE") return { kind, rows: sourceRows.parse(raw) };
  if (kind !== "PRD") throw Error("지원하는 표 정보가 아닙니다.");
  const rows = periodRows.parse(raw);
  if (new Set(rows.map((r) => JSON.stringify([r.PRD_SE, r.PRD_DE]))).size !== rows.length)
    throw Error("수록 시점을 구분할 수 없습니다.");
  return { kind, rows };
}
export type PublicTableMetadata = ReturnType<typeof decodePublicTableMetadata>;
const envelope = z
  .object({
    command: publicTableMetadataCommandSchema,
    source: z.enum(["kosis-api-response", "not-requested"]),
    status: z.enum(["results", "empty", "not-configured"]),
    searchCheckedAt: z.iso.datetime().nullable(),
    retrievedAt: z.iso.datetime().nullable(),
    metadata: z.unknown(),
    identityBasis: z.literal("request-target-not-echoed"),
    periodsComplete: z.literal(false),
    numericalDataRead: z.literal(false),
    originalRead: z.literal(false),
    factChecked: z.literal(false),
    companyApplicabilityChecked: z.literal(false),
    databaseChanged: z.literal(false),
    aiInputApproved: z.literal(false),
  })
  .strict();
export function readPublicTableMetadataResult(raw: unknown, expected: unknown) {
  const command = publicTableMetadataCommandSchema.parse(expected);
  const value = envelope.parse(raw);
  if (JSON.stringify(value.command) !== JSON.stringify(command))
    throw Error("선택한 표 정보의 응답이 아닙니다.");
  if (value.status === "not-configured") {
    if (
      value.source !== "not-requested" ||
      value.searchCheckedAt ||
      value.retrievedAt ||
      value.metadata !== null
    )
      throw Error("표 정보 연결 상태가 올바르지 않습니다.");
    return { ...value, metadata: null };
  }
  if (value.source !== "kosis-api-response" || !value.searchCheckedAt || !value.retrievedAt)
    throw Error("표 정보 조회 시각을 확인할 수 없습니다.");
  const meta = z
    .object({ kind: z.literal(command.kind), rows: z.unknown() })
    .strict()
    .parse(value.metadata);
  const metadata = decodePublicTableMetadata(meta.rows, meta.kind);
  if ((value.status === "empty") !== (metadata.rows.length === 0))
    throw Error("표 정보 응답 상태가 올바르지 않습니다.");
  return { ...value, metadata };
}
export type PublicTableMetadataResult = ReturnType<typeof readPublicTableMetadataResult>;
