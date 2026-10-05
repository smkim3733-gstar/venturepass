// Synthetic codes/labels only; never an operating key or a customer's statistics selection.
import type { PublicStatisticsCellTarget } from "./studio-public-statistics-cell";
export function syntheticCellTarget(count = 2): PublicStatisticsCellTarget {
  return {
    organizationId: "999",
    tableId: "DT_SYNTHETIC",
    itemId: "T001",
    classifications: Array.from({ length: count }, (_, i) => `00${i + 1}`),
    period: { cycle: "Y", point: "2024" },
  };
}
export function syntheticCellRow(target = syntheticCellTarget()): Record<string, unknown> {
  const row: Record<string, unknown> = {
    ORG_ID: target.organizationId,
    TBL_ID: target.tableId,
    TBL_NM: "합성 통계표",
    ITM_ID: target.itemId,
    ITM_NM: "합성 항목",
    UNIT_ID: "U001",
    UNIT_NM: "합성 단위",
    PRD_SE: target.period.cycle,
    PRD_DE: target.period.point,
    DT: "12,345.00",
    LST_CHN_DE: "2025-01-01",
  };
  target.classifications.forEach((id, i) => {
    row[`C${i + 1}`] = id;
    row[`C${i + 1}_OBJ_NM`] = `합성 분류 ${i + 1}`;
    row[`C${i + 1}_NM`] = `합성 값 ${i + 1}`;
  });
  return row;
}
