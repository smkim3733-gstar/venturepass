import "server-only";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { samePath } from "../../scripts/local-data-files.mjs";
import { assertPublicComparisonDataOnly } from "./studio-public-claim-comparison-budget";
import { comparisonExecutionSettingsSchema } from "./studio-comparison-execution-approval";
import { comparisonExecutionInputSchema } from "./studio-comparison-execution-input-file";
import { checkComparisonDatabasePath } from "./studio-public-comparison-file-identity";
import {
  recordComparisonCompanyConnection,
  issueComparisonCompanyGuard,
  revokeComparisonCompanyGuards,
} from "./studio-comparison-company-capability";
import {
  openComparisonStorageSession,
  closeComparisonStorageSession,
  type ComparisonStorageSession,
} from "./studio-public-comparison-storage-witness";
import { createPublicComparisonPreparationReader } from "./studio-public-claim-comparison-database-v11";

const connectionSchema = z
  .object({
    dataRoot: z.string().min(1),
    controlDirectory: z.string().min(1),
    databaseInstanceId: z.string().uuid(),
  })
  .strict();
const schema = connectionSchema.extend({ settings: comparisonExecutionSettingsSchema });
const catalogSchema = connectionSchema.extend({
  companyId: z.string().uuid(),
  companyRevision: z.number().int().nonnegative().safe(),
});

/** Original connections are retained after partial acquisition or failed cleanup. */
function createPreparationConnection(raw: z.infer<typeof connectionSchema>) {
  const input = connectionSchema.parse(raw);
  if (
    !isAbsolute(input.dataRoot) ||
    !isAbsolute(input.controlDirectory) ||
    samePath(input.dataRoot, input.controlDirectory) ||
    !samePath(dirname(resolve(input.dataRoot)), dirname(resolve(input.controlDirectory)))
  )
    throw Error("COMPARISON_PREPARATION_INPUT_INVALID");
  const paths = {
    dataRoot: resolve(input.dataRoot),
    controlDirectory: resolve(input.controlDirectory),
    studioFile: join(resolve(input.dataRoot), "studio.sqlite"),
    qualityFile: join(resolve(input.dataRoot), "quality.sqlite"),
  };
  const selection = {
    databaseInstanceId: input.databaseInstanceId,
    environment: "production" as const,
    scopeId: "candidate-quality-provider-v2-live" as const,
  };
  let db: DatabaseSync | undefined,
    session: ComparisonStorageSession | undefined,
    reader: ReturnType<typeof createPublicComparisonPreparationReader> | undefined;
  let acquired = false,
    closing = false,
    closed = false;
  const inspect = () => ({
    closed,
    cleanupRequired: !!db || !!session || !!reader,
    transmissionAllowed: false as const,
  });
  return Object.freeze({
    inspect,
    acquire() {
      if (closing || closed) throw Error("COMPARISON_PREPARATION_CLOSED");
      if (!reader) {
        if (acquired) throw Error("COMPARISON_PREPARATION_CLEANUP_REQUIRED");
        acquired = true;
        checkComparisonDatabasePath(paths.dataRoot, paths.studioFile);
        db = new DatabaseSync(paths.studioFile, { readOnly: false });
        recordComparisonCompanyConnection(db, paths.dataRoot);
        const guard = issueComparisonCompanyGuard(db, paths.dataRoot);
        session = openComparisonStorageSession(paths, selection);
        reader = createPublicComparisonPreparationReader(session, guard);
      }
      return reader;
    },
    close() {
      closing = true;
      if (!closed) {
        reader?.close();
        reader = undefined;
        if (session) {
          closeComparisonStorageSession(session);
          session = undefined;
        }
        if (db) {
          if (db.isTransaction) throw Error("COMPARISON_PREPARATION_CLEANUP_REQUIRED");
          db.close();
          revokeComparisonCompanyGuards(db);
          db = undefined;
        }
        closed = true;
      }
      return inspect();
    },
  });
}

/** Explicit company catalog. No policy/key/env lookup, selection, file export or execution. */
export function createComparisonReservationCatalog(raw: unknown) {
  assertPublicComparisonDataOnly(raw, 8192);
  const { companyId, companyRevision, ...paths } = catalogSchema.parse(raw);
  const connection = createPreparationConnection(paths);
  return Object.freeze({
    inspect: connection.inspect,
    list() {
      return connection.acquire().list({ companyId, companyRevision }, new Date().toISOString());
    },
    close: connection.close,
  });
}

/** Explicit existing reservation and reviewed policy only. No default paths or keys. */
export function createComparisonInputPreparation(raw: unknown) {
  assertPublicComparisonDataOnly(raw, 128 * 1024);
  const input = schema.parse(raw);
  if (
    input.settings.basis.provenance !== "official-reviewed" ||
    input.settings.usagePolicy.provenance !== "official-reviewed"
  )
    throw Error("COMPARISON_PREPARATION_INPUT_INVALID");
  const { settings, ...paths } = input;
  const connection = createPreparationConnection(paths);
  const { companyId, companyRevision, runId } = settings;
  return Object.freeze({
    inspect: connection.inspect,
    prepare() {
      const reader = connection.acquire();
      const at = new Date().toISOString();
      const prepared = reader.prepare(
        { companyId, companyRevision, runId },
        input.settings.basis,
        input.settings.usagePolicy,
        at,
      );
      const review = prepared.review;
      if (
        review.runId !== runId ||
        review.request.selection.companyId !== companyId ||
        review.request.selection.companyRevision !== companyRevision ||
        digest(review.basis) !== digest(input.settings.basis) ||
        digest(review.usagePolicy) !== digest(input.settings.usagePolicy)
      )
        throw Error("COMPARISON_PREPARATION_REVIEW_MISMATCH");
      const document = comparisonExecutionInputSchema.parse({
        inputVersion: 1,
        databaseInstanceId: input.databaseInstanceId,
        settings: {
          companyId,
          companyRevision,
          runId,
          basis: review.basis,
          usagePolicy: review.usagePolicy,
        },
      });
      assertPublicComparisonDataOnly(document, 128 * 1024);
      return structuredClone({
        document,
        summary: {
          kind: "comparison-input-preparation" as const,
          companyId,
          companyRevision,
          runId,
          inspectedAt: at,
          expiresAt: review.expiresAt,
          reviewDigest: review.reviewDigest,
          model: review.request.model,
          costs: prepared.reservation.financialBasis.costs,
          databaseVerified: true as const,
          currentCompanyVerified: true as const,
          transmissionAllowed: false as const,
          consentRecorded: false as const,
          runtimeObserved: false as const,
        },
      });
    },

    close: connection.close,
  });
}
