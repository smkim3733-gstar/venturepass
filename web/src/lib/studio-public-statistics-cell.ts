import { z } from "zod";
import {
  publicResearchIdentifierSchema,
  publicResearchTableUrl,
} from "./studio-public-research-result";

const code = publicResearchIdentifierSchema.refine((s) => s.toUpperCase() !== "ALL");
export const publicStatisticsCellTargetSchema = z
  .object({
    organizationId: code,
    tableId: code,
    itemId: code,
    classifications: z.array(code).min(1).max(8),
    period: z
      .object({
        cycle: z.enum(["Y", "M", "Q", "S"]),
        point: z.string().min(4).max(6),
      })
      .strict(),
  })
  .strict()
  .refine(({ period }) => {
    const { cycle, point } = period;
    if (!/^[0-9]{4}(?:[0-9]{2})?$/.test(point) || point.slice(0, 4) === "0000") return false;
    if (cycle === "Y") return point.length === 4;
    if (point.length !== 6) return false;
    const suffix = Number(point.slice(4));
    return suffix >= 1 && suffix <= (cycle === "M" ? 12 : cycle === "Q" ? 4 : 2);
  });
export type PublicStatisticsCellTarget = z.infer<typeof publicStatisticsCellTargetSchema>;
const invalid = () => Error("선택한 통계 수치의 범위 또는 응답을 확인할 수 없습니다.");
export function readPublicStatisticsCellTarget(raw: unknown): PublicStatisticsCellTarget {
  try {
    const serialized = JSON.stringify(raw);
    if (!serialized || new TextEncoder().encode(serialized).byteLength > 8 * 1024) throw invalid();
    return publicStatisticsCellTargetSchema.parse(raw);
  } catch {
    throw invalid();
  }
}
const text = (max: number) => z.string().max(max).nullable().optional();
const classificationShape: Record<string, z.ZodType> = {};
for (let i = 1; i <= 8; i++) {
  classificationShape[`C${i}`] = publicResearchIdentifierSchema.optional();
  for (const name of ["OBJ_NM", "OBJ_NM_ENG", "NM", "NM_ENG"])
    classificationShape[`C${i}_${name}`] = text(3000);
}
// Known English fields are tolerated but not used to infer missing Korean labels.
const rowSchema = z
  .object({
    ...classificationShape,
    ORG_ID: publicResearchIdentifierSchema,
    TBL_ID: publicResearchIdentifierSchema,
    TBL_NM: z.string().min(1).max(300),
    ITM_ID: publicResearchIdentifierSchema,
    ITM_NM: text(3000),
    ITM_NM_ENG: text(3000),
    UNIT_ID: text(40),
    UNIT_NM: text(1000),
    UNIT_NM_ENG: text(1000),
    PRD_SE: z.enum(["Y", "M", "Q", "S"]),
    PRD_DE: z.string().max(8),
    DT: z.string().max(100),
    LST_CHN_DE: text(10),
  })
  .strict();

export type PublicStatisticsCell = {
  tableName: string;
  itemName: string | null;
  classifications: { code: string; dimensionName: string | null; valueName: string | null }[];
  unitId: string | null;
  unitName: string | null;
  value: string;
  lastChangedText: string | null;
};
export const publicStatisticsReadLimits = {
  wholeTableRead: false,
  factChecked: false,
  companyApplicabilityChecked: false,
  databaseChanged: false,
  aiInputApproved: false,
} as const;
/** Parsing caller-supplied data is not proof that a provider request occurred. */
export function decodePublicStatisticsCell(raw: unknown, rawTarget: unknown) {
  try {
    const target = readPublicStatisticsCellTarget(rawTarget);
    const rows = z.array(rowSchema).max(1).parse(raw);
    let cell: PublicStatisticsCell | null = null;
    if (rows.length) {
      const row = rows[0];
      const fields: Record<string, unknown> = row;
      if (
        row.ORG_ID !== target.organizationId ||
        row.TBL_ID !== target.tableId ||
        row.ITM_ID !== target.itemId ||
        row.PRD_SE !== target.period.cycle ||
        row.PRD_DE !== target.period.point
      )
        throw invalid();
      const classifications: PublicStatisticsCell["classifications"] = [];
      for (let i = 1; i <= 8; i++) {
        const expected = target.classifications[i - 1];
        if (expected !== undefined) {
          if (fields[`C${i}`] !== expected) throw invalid();
          classifications.push({
            code: expected,
            dimensionName: (fields[`C${i}_OBJ_NM`] as string | null | undefined) ?? null,
            valueName: (fields[`C${i}_NM`] as string | null | undefined) ?? null,
          });
        } else if (Object.keys(row).some((key) => key === `C${i}` || key.startsWith(`C${i}_`))) {
          throw invalid();
        }
      }
      cell = {
        tableName: row.TBL_NM,
        itemName: row.ITM_NM ?? null,
        classifications,
        unitId: row.UNIT_ID ?? null,
        unitName: row.UNIT_NM ?? null,
        value: row.DT,
        lastChangedText: row.LST_CHN_DE ?? null,
      };
    }
    const url = new URL("https://kosis.kr/statHtml/statHtml.do");
    url.searchParams.set("orgId", target.organizationId);
    url.searchParams.set("tblId", target.tableId);
    return {
      ...publicStatisticsReadLimits,
      source: "supplied-response" as const,
      status: cell ? ("matched" as const) : ("empty" as const),
      target,
      cell,
      originalUrl: publicResearchTableUrl(url.href, target.organizationId, target.tableId)!,
    };
  } catch {
    throw invalid();
  }
}
