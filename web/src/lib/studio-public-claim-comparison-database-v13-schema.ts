import "server-only";
import { qualityV9TableSql } from "../../scripts/local-data-quality-schema.mjs";
import { publicComparisonV11Columns } from "./studio-public-claim-comparison-database-v11-schema";
export const publicComparisonV13Columns = {
  ...publicComparisonV11Columns,
  quality_provider_transmission_bindings: ["run_id", "nonce", "body", "body_hash"],
} as const;
export const publicComparisonV13InsertGates = Object.fromEntries(
  [...Object.keys(qualityV9TableSql), "quality_provider_purpose_coverage"].map((table) => {
    const columns = publicComparisonV13Columns[table as keyof typeof publicComparisonV13Columns];
    const condition = columns
      ? " WHEN comparison_v13_insert_guard('" +
        table +
        "'," +
        columns.map((c) => "NEW." + c).join(",") +
        ") IS NOT 1"
      : "";
    return [
      table + "_v13_writer",
      "CREATE TRIGGER " +
        table +
        "_v13_writer BEFORE INSERT ON " +
        table +
        condition +
        " BEGIN SELECT RAISE(ABORT,'comparison writer unavailable'); END",
    ];
  }),
);
