import "server-only";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { z } from "zod";
import { StudioError } from "./studio-http";
import type { CandidateRegistrySnapshot } from "./studio-plan-quality-candidate-registry-types";
import { inspectQualityDatabaseUsage } from "../../scripts/local-data-quality.mjs";
import { readProviderReservationDatabaseRows } from "../../scripts/local-data-quality-provider-reservation-database.mjs";
import { readProviderTransmissionApprovalDatabaseRows } from "../../scripts/local-data-quality-provider-transmission-database.mjs";
import { inspectProviderTransmissionApprovalArchive } from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { readLedgerDatabaseInput } from "./studio-plan-quality-ledger-database";
import { getProviderConfigurationProposal } from "./studio-plan-quality-provider-configuration";
import { providerTransmissionCommandSchema } from "./studio-plan-quality-provider-transmission-command";
import { prepareProviderTransmissionApproval } from "./studio-plan-quality-provider-transmission-plan";
import type { ProviderTransmissionApprovalBinding } from "./studio-plan-quality-provider-transmission-approval-types";

type Context = {
  db: DatabaseSync;
  transaction: <T>(work: () => T, write?: boolean) => T;
  registry: (version: number) => CandidateRegistrySnapshot;
  capacity: (addedBytes: number) => void;
};
type HistoricalApproval = {
  state: "committed";
  record: ProviderTransmissionApprovalBinding;
  dispatchAllowed: false;
  budgetWriteAllowed: false;
};
export type ProviderTransmissionApprovalCommit = HistoricalApproval & {
  newlyCommitted: boolean;
  replayed: boolean;
};
const historical = (record: ProviderTransmissionApprovalBinding): HistoricalApproval => ({
  state: "committed",
  record,
  dispatchAllowed: false,
  budgetWriteAllowed: false,
});
const fail = (code: string, message: string, status = 409): never => {
  throw new StudioError(message, status, code);
};
const conflict = () =>
  fail(
    "QUALITY_PROVIDER_TRANSMISSION_NONCE_CONFLICT",
    "같은 전송 승인 요청 번호가 다른 내용이나 작업에 사용되었습니다.",
  );

/** Stores explicit approval only. A historical receipt never grants dispatch or budget writes. */
export class ProviderTransmissionApprovalStore {
  constructor(private readonly context: Context) {}
  private inspect() {
    try {
      const usage = inspectQualityDatabaseUsage(this.context.db);
      const ledger = readLedgerDatabaseInput(this.context.db, this.context.registry);
      const { coverage, records } = readProviderReservationDatabaseRows(this.context.db);
      // Only the portable v8 archive participates in the approved review's digest.
      const archive = { ledger, coverage, records };
      const approval = inspectProviderTransmissionApprovalArchive({
        archive,
        ...readProviderTransmissionApprovalDatabaseRows(this.context.db),
      });
      const reservation = approval.reservationArchive;
      // Includes approval coverage/prior bindings, unrelated tables and raw encoding overhead.
      // Subtract canonical v8 bytes too: the planner already counts them itself.
      const additionalUsedBytes =
        usage.usedBytes - reservation.ledger.usedBytes - reservation.usedBytes;
      if (!Number.isSafeInteger(additionalUsedBytes) || additionalUsedBytes < 0)
        throw new Error("Invalid storage accounting");
      return { archive, records: approval.records, additionalUsedBytes };
    } catch {
      return fail(
        "QUALITY_PROVIDER_TRANSMISSION_STORAGE_CORRUPT",
        "전송 승인에 연결된 저장 기록을 확인하지 못했습니다.",
      );
    }
  }
  lookup(nonce: string) {
    z.string().uuid().parse(nonce);
    return this.context.transaction(() => {
      const record = this.inspect().records.find((row) => row.clientRequestId === nonce);
      return record ? historical(record) : { state: "not-observed" as const };
    });
  }
  approve(rawCommand: unknown, approvedReview: unknown): ProviderTransmissionApprovalCommit {
    const command = providerTransmissionCommandSchema.parse(rawCommand);
    return this.context.transaction(() => {
      const before = this.inspect();
      const previous = before.records.find(
        (row) => row.clientRequestId === command.clientRequestId,
      );
      // Replay is archival: full original command, before current configuration/time/review.
      // A native input digest alone omits review/CAS fields and cannot establish identity.
      if (previous) {
        if (
          digest(command) !== previous.commandDigest ||
          digest(command) !== digest(previous.command)
        )
          return conflict();
        return { ...historical(previous), newlyCommitted: false, replayed: true };
      }
      const db = this.context.db;
      const occupied = db
        .prepare(
          `SELECT nonce FROM (
        SELECT nonce FROM quality_requests UNION ALL SELECT nonce FROM quality_candidate_requests
        UNION ALL SELECT nonce FROM quality_execution_requests UNION ALL SELECT nonce FROM quality_actual_requests
        UNION ALL SELECT nonce FROM quality_provider_policies) WHERE nonce=? LIMIT 1`,
        )
        .get(command.clientRequestId);
      // Also rejects legacy approval receipts without an original command binding.
      if (occupied) return conflict();
      const plan = prepareProviderTransmissionApproval({
        command,
        review: approvedReview,
        current: {
          selection: { runId: command.runId, runDigest: command.runDigest },
          archive: before.archive,
          configuration: getProviderConfigurationProposal(),
          inspectedAt: new Date().toISOString(),
        },
        additionalUsedBytes: before.additionalUsedBytes,
      });
      if (plan.status !== "prepared")
        return fail(
          `QUALITY_PROVIDER_TRANSMISSION_${plan.reason.replaceAll("-", "_").toUpperCase()}`,
          "전송 승인 조건이 변경됐습니다. 검토안을 다시 확인해 주세요.",
          plan.reason === "capacity-exceeded" ? 413 : 409,
        );
      const { event, receipt, binding } = plan.plan.rows;
      // Native event/receipt bytes consume existing reserved storage; only binding adds exposure.
      this.context.capacity(Buffer.byteLength(JSON.stringify(binding)));
      const insert = (table: string, keys: Record<string, SQLInputValue>, value: unknown) => {
        const columns = [...Object.keys(keys), "body", "body_hash"];
        db.prepare(
          `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
        ).run(...Object.values(keys), JSON.stringify(value), digest(value));
      };
      insert("quality_actual_events", { run_id: event.runId, revision: event.revision }, event);
      insert("quality_actual_requests", { nonce: receipt.clientRequestId }, receipt);
      insert(
        "quality_provider_transmission_bindings",
        { run_id: binding.runId, nonce: binding.clientRequestId },
        binding,
      );
      // Full approval coverage is valid only after all three rows exist, before parent COMMIT.
      const saved = this.inspect().records.find(
        (row) => row.clientRequestId === command.clientRequestId,
      );
      if (!saved || digest(saved) !== digest(binding))
        return fail(
          "QUALITY_PROVIDER_TRANSMISSION_STORAGE_CORRUPT",
          "전송 승인 저장 결과를 확인하지 못했습니다.",
        );
      this.context.capacity(0);
      return { ...historical(saved), newlyCommitted: true, replayed: false };
    }, true);
  }
}
