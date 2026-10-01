import "server-only";
import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { z } from "zod";
import { StudioError } from "./studio-http";
import type { CandidateRegistrySnapshot } from "./studio-plan-quality-candidate-registry-types";
import { inspectQualityDatabaseUsage } from "../../scripts/local-data-quality.mjs";
import { readProviderReservationDatabaseRows } from "../../scripts/local-data-quality-provider-reservation-database.mjs";
import { inspectProviderReservationArchive } from "../../scripts/local-data-quality-provider-reservation-binding.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { readLedgerDatabaseInput } from "./studio-plan-quality-ledger-database";
import { getProviderConfigurationProposal } from "./studio-plan-quality-provider-configuration";
import { providerReservationCommandSchema } from "./studio-plan-quality-provider-reservation-command";
import { prepareProviderReservation } from "./studio-plan-quality-provider-reservation-plan";
import type { ProviderReservationBinding } from "./studio-plan-quality-provider-reservation-archive-types";

import type { createServerProviderPolicyContext } from "./studio-plan-quality-provider-policy-server";

type Context = {
  selection?: ReturnType<typeof createServerProviderPolicyContext>;
  db: DatabaseSync;
  transaction: <T>(work: () => T, write?: boolean) => T;
  registry: (version: number) => CandidateRegistrySnapshot;
  capacity: (addedBytes: number) => void;
};
export type ProviderReservationCommit = {
  state: "committed";
  record: ProviderReservationBinding;
  newlyCommitted: boolean;
  replayed: boolean;
};
const fail = (code: string, message: string, status = 409): never => {
  throw new StudioError(message, status, code);
};
const conflict = () =>
  fail(
    "QUALITY_PROVIDER_RESERVATION_NONCE_CONFLICT",
    "같은 예약 요청 번호가 다른 내용이나 작업에 사용되었습니다.",
  );

/** Explicit reservation only. No transport, budget initialization or native execution gate changes. */
export class ProviderReservationStore {
  constructor(private readonly context: Context) {}
  private inspect() {
    try {
      const usage = inspectQualityDatabaseUsage(this.context.db);
      const ledger = readLedgerDatabaseInput(this.context.db, this.context.registry);
      const archive = inspectProviderReservationArchive({
        ledger,
        ...readProviderReservationDatabaseRows(this.context.db),
      });
      const additionalUsedBytes = usage.usedBytes - archive.ledger.usedBytes;
      if (!Number.isSafeInteger(additionalUsedBytes) || additionalUsedBytes < 0)
        throw new Error("Invalid storage accounting");
      return { ...archive, additionalUsedBytes };
    } catch {
      return fail(
        "QUALITY_PROVIDER_RESERVATION_STORAGE_CORRUPT",
        "예약에 연결된 저장 기록을 확인하지 못했습니다.",
      );
    }
  }
  lookup(nonce: string) {
    z.string().uuid().parse(nonce);
    return this.context.transaction(() => {
      const record = this.inspect().records.find((row) => row.clientRequestId === nonce);
      return record ? { state: "committed" as const, record } : { state: "not-observed" as const };
    });
  }
  reserve(rawCommand: unknown, approvedReview: unknown): ProviderReservationCommit {
    const command = providerReservationCommandSchema.parse(rawCommand);
    return this.context.transaction(() => {
      // Replay is an archival operation: never fetch current configuration or mint another run.
      const before = this.inspect();
      const previous = before.records.find(
        (row) => row.clientRequestId === command.clientRequestId,
      );
      if (previous) {
        if (
          digest(command) !== previous.commandDigest ||
          digest(command) !== digest(previous.command)
        )
          return conflict();
        return { state: "committed", record: previous, newlyCommitted: false, replayed: true };
      }
      const db = this.context.db;
      // A native receipt alone (including a grandfathered run) never proves this command committed.
      const occupied = db
        .prepare(
          `SELECT nonce FROM (
        SELECT nonce FROM quality_requests UNION ALL SELECT nonce FROM quality_candidate_requests
        UNION ALL SELECT nonce FROM quality_execution_requests UNION ALL SELECT nonce FROM quality_actual_requests
        UNION ALL SELECT nonce FROM quality_provider_policies) WHERE nonce=? LIMIT 1`,
        )
        .get(command.clientRequestId);
      if (occupied) return conflict();
      const selected = this.context.registry(command.version);
      const ledger = readLedgerDatabaseInput(
        db,
        (version) => (version === selected.version ? selected : this.context.registry(version)),
        [command.version],
      );
      const configuration = this.context.selection ? undefined : getProviderConfigurationProposal();
      const input = {
        command,
        review: approvedReview,
        current: {
          selection: {
            version: command.version,
            versionDigest: command.versionDigest,
            candidateId: command.candidateId,
          },
          ledger,
          inspectedAt: new Date().toISOString(),
        },
        runId: randomUUID(),
        additionalUsedBytes: before.additionalUsedBytes,
      };
      const plan = this.context.selection
        ? this.context.selection.prepareReservation(input)
        : prepareProviderReservation({
            ...input,
            current: { ...input.current, configuration },
          });
      if (plan.status !== "prepared")
        return fail(
          `QUALITY_PROVIDER_RESERVATION_${plan.reason.replaceAll("-", "_").toUpperCase()}`,
          "예약 조건이 변경됐습니다. 검토안을 다시 확인해 주세요.",
          plan.reason === "capacity-exceeded" ? 413 : 409,
        );
      const { run, artifact, budgetEvent, receipt, binding } = plan.plan.rows;
      // Initial native rows consume part of the run's reservation; do not count them twice.
      this.context.capacity(
        run.storageReservationBytes + Buffer.byteLength(JSON.stringify(binding)),
      );
      const insert = (table: string, keys: Record<string, SQLInputValue>, value: unknown) => {
        const columns = [...Object.keys(keys), "body", "body_hash"];
        db.prepare(
          `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
        ).run(...Object.values(keys), JSON.stringify(value), digest(value));
      };
      insert("quality_actual_runs", { id: run.id }, run);
      db.prepare(
        "INSERT INTO quality_actual_artifacts(run_id,artifact_key,payload,sha256,size_bytes) VALUES(?,?,?,?,?)",
      ).run(
        artifact.runId,
        artifact.key,
        Buffer.from(artifact.body, "utf8"),
        artifact.sha256,
        artifact.sizeBytes,
      );
      insert(
        "quality_actual_budget_events",
        { scope_id: budgetEvent.scopeId, revision: budgetEvent.revision },
        budgetEvent,
      );
      insert("quality_actual_requests", { nonce: receipt.clientRequestId }, receipt);
      insert(
        "quality_provider_reservation_bindings",
        { run_id: binding.runId, nonce: binding.clientRequestId },
        binding,
      );
      const saved = this.inspect().records.find(
        (row) => row.clientRequestId === command.clientRequestId,
      );
      if (!saved || digest(saved) !== digest(binding))
        return fail(
          "QUALITY_PROVIDER_RESERVATION_STORAGE_CORRUPT",
          "예약 저장 결과를 확인하지 못했습니다.",
        );
      this.context.capacity(0);
      // The parent commits all five rows before exposing this historical receipt.
      return { state: "committed", record: saved, newlyCommitted: true, replayed: false };
    }, true);
  }
}
