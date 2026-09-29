import "server-only";
import type { DatabaseSync } from "node:sqlite";
import type { CandidateRegistrySnapshot } from "./studio-plan-quality-candidate-registry-types";
import { StudioError } from "./studio-http";
import { inspectQualityDatabase } from "../../scripts/local-data-quality.mjs";
import { readProviderReservationDatabaseRows } from "../../scripts/local-data-quality-provider-reservation-database.mjs";
import { readLedgerDatabaseInput } from "./studio-plan-quality-ledger-database";
import { getProviderConfigurationProposal } from "./studio-plan-quality-provider-configuration";
import { createProviderTransmissionReview } from "./studio-plan-quality-provider-transmission-review";
import { providerTransmissionReviewInputSchema } from "./studio-plan-quality-provider-transmission-review-types";

type Context = {
  db: DatabaseSync;
  transaction: <T>(work: () => T) => T;
  registry: (version: number) => CandidateRegistrySnapshot;
};
const corrupt = (): never => {
  throw new StudioError(
    "전송 검토에 연결된 저장 기록을 확인하지 못했습니다.",
    409,
    "QUALITY_PROVIDER_TRANSMISSION_STORAGE_CORRUPT",
  );
};

/** Reads one server-owned snapshot. Never accepts an archive, configuration or write permission. */
export class ProviderTransmissionReviewStore {
  constructor(private readonly context: Context) {}
  review(value: unknown) {
    const selection = providerTransmissionReviewInputSchema.safeParse(value);
    if (!selection.success)
      throw new StudioError(
        "전송 검토할 예약 실행을 확인해 주세요.",
        400,
        "QUALITY_PROVIDER_TRANSMISSION_SELECTION_INVALID",
      );
    return this.context.transaction(() => {
      let archive;
      try {
        // Schema, unrelated evaluations/registrations, original bytes and every v8 binding must
        // pass in this SAME transaction; a selected run alone cannot establish integrity.
        inspectQualityDatabase(this.context.db, { inTransaction: true });
        const ledger = readLedgerDatabaseInput(this.context.db, this.context.registry);
        const { coverage, records } = readProviderReservationDatabaseRows(this.context.db);
        // Raw storage metadata is not part of the portable review's archive digest.
        archive = { ledger, coverage, records };
      } catch {
        return corrupt();
      }
      if (
        !this.context.db
          .prepare("SELECT id FROM quality_actual_runs WHERE id=?")
          .get(selection.data.runId)
      )
        throw new StudioError(
          "정확한 예약 실행을 찾을 수 없습니다.",
          404,
          "QUALITY_PROVIDER_RUN_NOT_FOUND",
        );
      const configuration = getProviderConfigurationProposal();
      const result = createProviderTransmissionReview({
        selection: selection.data,
        inspectedAt: new Date().toISOString(),
        configuration,
        archive,
      });
      if (result.status === "unavailable" && result.reason === "archive-invalid") return corrupt();
      return result;
    });
  }
}
