import "server-only";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { StudioError } from "./studio-http";
import type { CandidateRegistrySnapshot } from "./studio-plan-quality-candidate-registry-types";
import { inspectQualityDatabase } from "../../scripts/local-data-quality.mjs";
import { inspectLedgerDatabase } from "./studio-plan-quality-ledger-database";
import {
  providerDigest as digest,
  providerBudgetScope,
  validateProviderBudgetLedger,
} from "../../scripts/local-data-quality-provider.mjs";
import { getProviderConfigurationProposal } from "./studio-plan-quality-provider-configuration";
import {
  compareProviderPolicyAdoptionRetry,
  prepareProviderPolicyAdoption,
} from "./studio-plan-quality-provider-policy-adoption";
import {
  providerPolicyAdoptionCommandSchema,
  providerPolicyAdoptionLimits,
  type ProviderPolicyAdoptionRecord,
} from "./studio-plan-quality-provider-policy-adoption-types";

type Context = {
  db: DatabaseSync;
  transaction: <T>(work: () => T, write?: boolean) => T;
  registry: (version: number) => CandidateRegistrySnapshot;
  capacity: (addedBytes: number) => void;
};
export type ProviderPolicyAdoptionCommit = {
  state: "committed";
  record: ProviderPolicyAdoptionRecord;
  newlyCommitted: boolean;
  replayed: boolean;
};
const nonceSql = `SELECT nonce FROM quality_requests
  UNION ALL SELECT nonce FROM quality_candidate_requests
  UNION ALL SELECT nonce FROM quality_execution_requests
  UNION ALL SELECT nonce FROM quality_actual_requests
  UNION ALL SELECT nonce FROM quality_provider_policies`;
const fail = (code: string, message: string, status = 409): never => {
  throw new StudioError(message, status, code);
};

/** Explicit policy adoption only. Does not enable provider execution, reserve cost or access transport. */
export class ProviderPolicyAdoptionStore {
  constructor(private readonly context: Context) {}
  private inspect() {
    try {
      // Include evaluation/registration receipts and archived execution bytes, even on replay/lookup.
      inspectQualityDatabase(this.context.db, { inTransaction: true });
    } catch {
      return fail(
        "QUALITY_PROVIDER_POLICY_STORAGE_CORRUPT",
        "정책 채택에 연결된 저장 기록을 확인하지 못했습니다.",
      );
    }
    return inspectLedgerDatabase(this.context.db, this.context.registry);
  }
  head() {
    return this.context.transaction(() => {
      const { revision, headDigest } = this.inspect().policy;
      return { revision, headDigest };
    });
  }
  /** One audited read snapshot; never combine a review with a separately fetched policy head. */
  reviewContext(version: number) {
    z.number().int().min(1).max(20).parse(version);
    return this.context.transaction(() => {
      const state = this.inspect();
      const registry = this.context.registry(version);
      const scope = providerBudgetScope("production");
      const budgetEvents = state.provider.budgetEvents.filter((event) => event.scopeId === scope);
      const budget = validateProviderBudgetLedger(budgetEvents, scope);
      return {
        registry,
        inspectedAt: new Date().toISOString(),
        budgetEvents,
        expectedBudgetHead: { revision: budget.revision, headDigest: budget.headDigest },
        expectedPolicyHead: {
          revision: state.policy.revision,
          headDigest: state.policy.headDigest,
        },
      };
    });
  }
  lookup(nonce: string) {
    z.string().uuid().parse(nonce);
    return this.context.transaction(() => {
      const record = this.inspect().policy.records.find((row) => row.clientRequestId === nonce);
      return record ? { state: "committed" as const, record } : { state: "not-observed" as const };
    });
  }
  adopt(rawCommand: unknown, approvedReview: unknown): ProviderPolicyAdoptionCommit {
    const command = providerPolicyAdoptionCommandSchema.parse(rawCommand);
    return this.context.transaction(() => {
      const state = this.inspect();
      const previous = state.policy.records.find(
        (row) => row.clientRequestId === command.clientRequestId,
      );
      if (previous) {
        if (compareProviderPolicyAdoptionRetry(command, previous) !== "same-request")
          fail("QUALITY_PROVIDER_POLICY_NONCE_CONFLICT", "같은 정책 요청 번호의 내용이 다릅니다.");
        return { state: "committed", record: previous, newlyCommitted: false, replayed: true };
      }
      const registry = this.context.registry(command.version);
      const scope = providerBudgetScope("production");
      const budgetEvents = state.provider.budgetEvents.filter((event) => event.scopeId === scope);
      const budget = validateProviderBudgetLedger(budgetEvents, scope);
      // Resolve current server authority after acquiring the write lock, never from a client parameter.
      const configuration = getProviderConfigurationProposal();
      const prepared = prepareProviderPolicyAdoption({
        command,
        review: approvedReview,
        current: {
          registry,
          candidateId: command.candidateId,
          inspectedAt: new Date().toISOString(),
          configuration,
          budgetEvents,
          expectedBudgetHead: { revision: budget.revision, headDigest: budget.headDigest },
        },
        currentPolicyHead: { revision: state.policy.revision, headDigest: state.policy.headDigest },
        usedRequestIds: this.context.db
          .prepare(nonceSql)
          .all()
          .map((row) => row.nonce),
      });
      if (prepared.status !== "prepared")
        return fail(
          `QUALITY_PROVIDER_POLICY_${prepared.reason.replaceAll("-", "_").toUpperCase()}`,
          "정책 채택 조건이 변경됐습니다. 검토안을 다시 확인해 주세요.",
        );
      const { record, initialization } = prepared.plan;
      if (
        initialization &&
        (state.legacy.budgetEvents.length +
          state.provider.budgetEvents.length +
          state.reservedBudgetEventSlots +
          1 >
          1000 ||
          state.legacy.receipts.length +
            state.provider.receipts.length +
            state.reservedReceiptSlots +
            1 >
            1000)
      )
        fail(
          "QUALITY_PROVIDER_POLICY_STORAGE_LIMIT",
          "예산 기록과 예약된 후속 기록의 보관 한도를 초과했습니다.",
          413,
        );
      const rows = [
        {
          table: "quality_provider_policies",
          keys: {
            scope_id: record.scopeId,
            revision: record.revision,
            nonce: record.clientRequestId,
          } as Record<string, string | number>,
          value: record,
          maximum: providerPolicyAdoptionLimits.recordBytes,
        },
        ...(initialization
          ? [
              {
                table: "quality_actual_budget_events",
                keys: {
                  scope_id: initialization.event.scopeId,
                  revision: initialization.event.revision,
                },
                value: initialization.event,
                maximum: 32 * 1024,
              },
              {
                table: "quality_actual_requests",
                keys: { nonce: initialization.receipt.clientRequestId },
                value: initialization.receipt,
                maximum: 4096,
              },
            ]
          : []),
      ].map((row) => ({ ...row, body: JSON.stringify(row.value) }));
      if (rows.some((row) => Buffer.byteLength(row.body) > row.maximum))
        fail("QUALITY_PROVIDER_POLICY_STORAGE_LIMIT", "정책 기록의 보관 한도를 초과했습니다.", 413);
      this.context.capacity(rows.reduce((bytes, row) => bytes + Buffer.byteLength(row.body), 0));
      for (const row of rows) {
        const columns = [...Object.keys(row.keys), "body", "body_hash"];
        this.context.db
          .prepare(
            `INSERT INTO ${row.table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
          )
          .run(...Object.values(row.keys), row.body, digest(row.value));
      }
      this.inspect();
      this.context.capacity(0);
      // The parent commits before this result is exposed to the caller.
      return { state: "committed", record, newlyCommitted: true, replayed: false };
    }, true);
  }
}
