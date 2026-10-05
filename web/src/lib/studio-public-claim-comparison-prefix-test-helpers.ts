import type { DatabaseSync } from "node:sqlite";
import { inspectQualitySchema } from "../../scripts/local-data-quality-schema.mjs";
import {
  readPublicComparisonRows,
  decodePublicComparisonPrefix,
} from "./studio-public-claim-comparison-database-rows";
export function readPublicComparisonPrefix(db: DatabaseSync) {
  return decodePublicComparisonPrefix(
    readPublicComparisonRows(db, inspectQualitySchema(db).schema),
    {
      databaseInstanceId: "4900300f-313a-4114-bbf5-5b0d33b7c824",
      environment: "production",
      scopeId: "candidate-quality-provider-v2-live",
    },
  );
}
