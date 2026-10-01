import "server-only";
import type { DatabaseSync } from "node:sqlite";
import type { CandidateRegistrySnapshot } from "./studio-plan-quality-candidate-registry-types";
import { StudioError } from "./studio-http";
import { inspectQualityDatabase } from "../../scripts/local-data-quality.mjs";
import { readLedgerDatabaseInput } from "./studio-plan-quality-ledger-database";
import { providerReviewInputSchema } from "./studio-plan-quality-provider-review-types";
import { getProviderConfigurationProposal } from "./studio-plan-quality-provider-configuration";
import { createProviderReservationReview } from "./studio-plan-quality-provider-reservation-review";

import type { createServerProviderPolicyContext } from "./studio-plan-quality-provider-policy-server";

type Context = {
  selection?: ReturnType<typeof createServerProviderPolicyContext>;
  db: DatabaseSync;
  transaction: <T>(work: () => T) => T;
  registry: (version: number) => CandidateRegistrySnapshot;
};
const corrupt = (): never => {
  throw new StudioError(
    "예약 검토에 연결된 저장 기록을 확인하지 못했습니다.",
    409,
    "QUALITY_PROVIDER_RESERVATION_STORAGE_CORRUPT",
  );
};

/** Server-owned read only. No caller-supplied ledger/configuration, mutation flag or transport. */
export class ProviderReservationReviewStore {
  constructor(private readonly context: Context) {}
  review(value: unknown) {
    const selection = providerReviewInputSchema.safeParse(value);
    if (!selection.success)
      throw new StudioError(
        "예약 검토할 등록 후보를 확인해 주세요.",
        400,
        "QUALITY_PROVIDER_RESERVATION_SELECTION_INVALID",
      );
    return this.context.transaction(() => {
      try {
        // Includes schema, evaluation/registration receipts and original bytes in all environments.
        inspectQualityDatabase(this.context.db, { inTransaction: true });
      } catch {
        return corrupt();
      }
      // An absent requested version is a selection error, not evidence of database corruption.
      const selected = this.context.registry(selection.data.version);
      const registries = new Map([[selected.version, selected]]);
      let ledger;
      try {
        ledger = readLedgerDatabaseInput(
          this.context.db,
          (version) => {
            let registry = registries.get(version);
            if (!registry) {
              registry = this.context.registry(version);
              registries.set(version, registry);
            }
            return registry;
          },
          [selection.data.version],
        );
      } catch {
        return corrupt();
      }
      // A selected server never reads a later/default configuration instead of its snapshot.
      // Legacy resolution still precedes the inspection clock.
      const configuration = this.context.selection ? undefined : getProviderConfigurationProposal();
      const input = {
        selection: selection.data,
        inspectedAt: new Date().toISOString(),
        ledger,
      };
      const result = this.context.selection
        ? this.context.selection.reservationReview(input)
        : createProviderReservationReview({ ...input, configuration });
      if (result.status === "unavailable" && result.reason === "ledger-invalid") return corrupt();
      return result;
    });
  }
}
