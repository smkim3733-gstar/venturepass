import "server-only";
import { qualityV9TableSql } from "../../scripts/local-data-quality-schema.mjs";
import { publicComparisonV11Columns } from "./studio-public-claim-comparison-database-v11-schema";
export const publicComparisonV12Columns = {
  ...publicComparisonV11Columns,
  quality_provider_transmission_bindings: ["run_id", "nonce", "body", "body_hash"],
} as const;
export const publicComparisonV12InsertGates = Object.fromEntries(
  [...Object.keys(qualityV9TableSql), "quality_provider_purpose_coverage"].map((table) => {
    const columns = publicComparisonV12Columns[table as keyof typeof publicComparisonV12Columns];
    const condition = columns
      ? " WHEN comparison_v12_insert_guard('" +
        table +
        "'," +
        columns.map((c) => "NEW." + c).join(",") +
        ") IS NOT 1"
      : "";
    return [
      table + "_v12_writer",
      "CREATE TRIGGER " +
        table +
        "_v12_writer BEFORE INSERT ON " +
        table +
        condition +
        " BEGIN SELECT RAISE(ABORT,'comparison writer unavailable'); END",
    ];
  }),
);
