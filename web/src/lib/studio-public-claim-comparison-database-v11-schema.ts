import "server-only";
import { qualityV9TableSql } from "../../scripts/local-data-quality-schema.mjs";

/** Exact columns covered by a transaction's private, single-use insert plan. */
export const publicComparisonV11Columns = {
  quality_actual_runs: ["id", "body", "body_hash"],
  quality_actual_events: ["run_id", "revision", "body", "body_hash"],
  quality_actual_artifacts: ["run_id", "artifact_key", "payload", "sha256", "size_bytes"],
  quality_actual_requests: ["nonce", "body", "body_hash"],
  quality_actual_budget_events: ["scope_id", "revision", "body", "body_hash"],
  quality_provider_reservation_bindings: ["run_id", "nonce", "body", "body_hash"],
} as const;
export const publicComparisonV11InsertGates = Object.fromEntries(
  [...Object.keys(qualityV9TableSql), "quality_provider_purpose_coverage"].map((table) => {
    const columns = publicComparisonV11Columns[table as keyof typeof publicComparisonV11Columns];
    const condition = columns
      ? ` WHEN comparison_v11_insert_guard('${table}',${columns.map((c) => `NEW.${c}`).join(",")}) IS NOT 1`
      : "";
    return [
      `${table}_v11_writer`,
      `CREATE TRIGGER ${table}_v11_writer BEFORE INSERT ON ${table}${condition} BEGIN SELECT RAISE(ABORT,'comparison writer unavailable'); END`,
    ];
  }),
);
