import { z } from "zod";
import {
  publicResearchCommandSchema,
  publicResearchCandidateSchema,
  publicResearchTableUrl,
} from "./studio-public-research-result";
import {
  publicStatisticsCellTargetSchema,
  publicStatisticsCellSchema,
  publicStatisticsReadLimits,
} from "./studio-public-statistics-cell";

export const publicSelectedCellCommandSchema = z
  .object({
    action: z.literal("read-selected-statistics-cell"),
    topic: publicResearchCommandSchema.shape.topic,
    candidate: publicResearchCandidateSchema,
    searchRetrievedAt: z.iso.datetime(),
    selection: z
      .object({
        itemId: publicStatisticsCellTargetSchema.shape.itemId,
        classifications: publicStatisticsCellTargetSchema.shape.classifications,
        period: publicStatisticsCellTargetSchema.shape.period,
      })
      .strict(),
    confirmed: z.literal(true),
  })
  .strict()
  .refine(
    ({ candidate: c, selection }) =>
      !!c.originalUrl &&
      publicResearchTableUrl(c.originalUrl, c.organizationId, c.tableId) === c.originalUrl &&
      ["Y", "M", "Q"].includes(selection.period.cycle) &&
      publicStatisticsCellTargetSchema.safeParse({
        organizationId: c.organizationId,
        tableId: c.tableId,
        ...selection,
      }).success,
  );
export type PublicSelectedCellCommand = z.infer<typeof publicSelectedCellCommandSchema>;
export function selectedCellTarget(command: PublicSelectedCellCommand) {
  return publicStatisticsCellTargetSchema.parse({
    organizationId: command.candidate.organizationId,
    tableId: command.candidate.tableId,
    ...command.selection,
  });
}
export const publicSelectedCellLimits = {
  ...publicStatisticsReadLimits,
  selectionBasis: "manual-unverified",
  codeCatalogVerified: false,
} as const;
const envelope = z
  .object({
    command: publicSelectedCellCommandSchema,
    status: z.enum(["matched", "empty", "not-configured"]),
    source: z.enum(["kosis-api-response", "not-requested"]),
    searchCheckedAt: z.iso.datetime().nullable(),
    retrievedAt: z.iso.datetime().nullable(),
    cell: publicStatisticsCellSchema.nullable(),
    selectionBasis: z.literal("manual-unverified"),
    codeCatalogVerified: z.literal(false),
    wholeTableRead: z.literal(false),
    factChecked: z.literal(false),
    companyApplicabilityChecked: z.literal(false),
    databaseChanged: z.literal(false),
    aiInputApproved: z.literal(false),
  })
  .strict();
export function readPublicSelectedCellResult(raw: unknown, expected: unknown) {
  const command = publicSelectedCellCommandSchema.parse(expected);
  const value = envelope.parse(raw);
  if (JSON.stringify(command) !== JSON.stringify(value.command))
    throw Error("선택한 통계 수치의 응답이 아닙니다.");
  if (value.status === "not-configured") {
    if (
      value.source !== "not-requested" ||
      value.searchCheckedAt ||
      value.retrievedAt ||
      value.cell
    )
      throw Error("통계 조회 연결 상태를 확인할 수 없습니다.");
  } else {
    if (
      value.source !== "kosis-api-response" ||
      !value.searchCheckedAt ||
      !value.retrievedAt ||
      (value.status === "empty") !== (value.cell === null)
    )
      throw Error("통계 조회 결과 상태를 확인할 수 없습니다.");
    if (
      value.cell &&
      JSON.stringify(value.cell.classifications.map((c) => c.code)) !==
        JSON.stringify(command.selection.classifications)
    )
      throw Error("선택한 분류와 응답이 다릅니다.");
  }
  return value;
}
export type PublicSelectedCellResult = ReturnType<typeof readPublicSelectedCellResult>;
