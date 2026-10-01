import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { StudioError } from "./studio-http";
import { validateNewProviderPreparation } from "./studio-plan-quality-provider-core";
import type { CandidateRegistrySnapshot } from "./studio-plan-quality-candidate-registry-types";
import { inspectLedgerDatabase } from "./studio-plan-quality-ledger-database";
import {
  providerBudgetScope,
  providerDigest as digest,
  providerPolicyDigestInput,
  providerStartDigestInput,
  providerCancelDigestInput,
  providerPolicySchema,
  providerStartSchema,
  providerCancelSchema,
  createProviderBudgetEvent,
  createProviderRun,
  createProviderRunEvent,
  createProviderArtifact,
  createProviderReceipt,
  validateProviderBudgetLedger,
  validateVersionedProviderRunLedger,
} from "../../scripts/local-data-quality-provider.mjs";
import type {
  ProviderEnvironment,
  ProviderPolicy,
  ProviderStart,
  ProviderCancel,
  ProviderReceipt,
  ProviderBudgetEvent,
  ProviderRun,
} from "./studio-plan-quality-provider-types";
import type {
  ProviderExecutionCommand,
  ProviderExecutionPayload,
  ProviderExecutionReceipt,
} from "./studio-plan-quality-provider-execution-types";
import {
  providerExecutionCommandSchema,
  providerExecutionOperationDigest,
  createProviderExecutionEvent,
  createProviderExecutionReceipt,
  getProviderExecutionBudgetSnapshot,
} from "../../scripts/local-data-quality-provider-execution.mjs";
import {
  captureProviderResponse,
  providerResponseMetadata,
  assessProviderUsage,
} from "../../scripts/local-data-quality-provider-usage.mjs";

type Context = {
  db: DatabaseSync;
  transaction: <T>(work: () => T, write?: boolean) => T;
  registry: (version: number) => CandidateRegistrySnapshot;
  capacity: (addedBytes: number) => void;
  synthetic: boolean;
};
export type ProviderBudgetConfigure = {
  clientRequestId: string;
  expectedRevision: number;
  policy: ProviderPolicy;
};
type State = ReturnType<typeof inspectLedgerDatabase>["provider"];
const uuid = z.string().uuid();
function fail(code: string, message: string, status = 409): never {
  throw new StudioError(message, status, code);
}

/** Internal v2 ledger. Synthetic writes only; no transport, key or company data. */
export class ProviderLedgerStore {
  constructor(private readonly context: Context) {}
  private inspect() {
    return inspectLedgerDatabase(this.context.db, this.context.registry);
  }
  private enabled(environment: ProviderEnvironment) {
    if (!this.context.synthetic || environment !== "synthetic-test")
      fail(
        "PROVIDER_EXECUTION_DISABLED",
        "실제 AI 승인·운영 예약·전송은 아직 연결되지 않았습니다.",
        403,
      );
  }
  private free(nonce: string) {
    for (const table of [
      "quality_requests",
      "quality_candidate_requests",
      "quality_execution_requests",
      "quality_actual_requests",
      "quality_provider_policies",
    ])
      if (this.context.db.prepare(`SELECT nonce FROM ${table} WHERE nonce=?`).get(nonce))
        fail("QUALITY_PROVIDER_NONCE_CONFLICT", "같은 요청 번호가 이미 다른 기록에 사용됐습니다.");
  }
  private replay(state: State, nonce: string, inputDigest: string, kind: ProviderReceipt["kind"]) {
    const receipt = state.receipts.find((row) => row.clientRequestId === nonce);
    if (!receipt) return null;
    if (receipt.inputDigest !== inputDigest || receipt.kind !== kind)
      fail("QUALITY_PROVIDER_NONCE_CONFLICT", "같은 요청 번호의 내용이 다릅니다.");
    return receipt;
  }
  private put(
    table: string,
    keys: Record<string, string | number>,
    value: unknown,
    maximum: number,
  ) {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > maximum)
      fail("QUALITY_PROVIDER_STORAGE_LIMIT", "예약 기록의 보관 한도를 초과했습니다.", 413);
    const columns = [...Object.keys(keys), "body", "body_hash"];
    this.context.db
      .prepare(
        `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
      )
      .run(...Object.values(keys), body, digest(value));
  }
  private budgetEvent(value: ProviderBudgetEvent) {
    this.put(
      "quality_actual_budget_events",
      { scope_id: value.scopeId, revision: value.revision },
      value,
      32 * 1024,
    );
  }
  private receipt(value: ProviderReceipt) {
    this.put("quality_actual_requests", { nonce: value.clientRequestId }, value, 4096);
  }
  private scopeBudget(state: State, environment: ProviderEnvironment) {
    const scope = providerBudgetScope(environment);
    return validateProviderBudgetLedger(
      state.budgetEvents.filter((row) => row.scopeId === scope),
      scope,
    );
  }
  budgetGet(environment: ProviderEnvironment = "synthetic-test") {
    return this.context.transaction(() => this.scopeBudget(this.inspect().provider, environment));
  }
  /** Candidate, full-ledger inspection and production head share one SQLite read transaction. */
  reviewContext(version: number) {
    z.number().int().min(1).max(20).parse(version);
    return this.context.transaction(() => {
      const registry = this.context.registry(version);
      const state = this.inspect().provider;
      const budgetEvents = state.budgetEvents.filter(
        (event) => event.scopeId === providerBudgetScope("production"),
      );
      const budget = this.scopeBudget(state, "production");
      return {
        registry,
        inspectedAt: new Date().toISOString(),
        budgetEvents,
        expectedBudgetHead: { revision: budget.revision, headDigest: budget.headDigest },
      };
    });
  }
  budgetConfigure(value: ProviderBudgetConfigure) {
    const input = z
      .object({
        clientRequestId: uuid,
        expectedRevision: z.number().int().min(0).max(999),
        policy: providerPolicySchema,
      })
      .strict()
      .parse(value);
    this.enabled(input.policy.environment);
    const inputDigest = digest(providerPolicyDigestInput(input)),
      scope = providerBudgetScope(input.policy.environment);
    return this.context.transaction(() => {
      const state = this.inspect().provider,
        previous = this.replay(
          state,
          input.clientRequestId,
          inputDigest,
          "provider-budget-configure",
        );
      if (previous)
        return {
          budget: validateProviderBudgetLedger(
            state.budgetEvents.filter(
              (row) => row.scopeId === scope && row.revision <= previous.budgetRevision,
            ),
            scope,
          ),
          receipt: previous,
          newlyCommitted: false,
          replayed: true,
        };
      this.free(input.clientRequestId);
      const budget = this.scopeBudget(state, input.policy.environment);
      if (budget.revision !== input.expectedRevision)
        fail("QUALITY_PROVIDER_VERSION_CONFLICT", "예산 기록이 변경됐습니다.");
      if (budget.revision !== 0)
        fail("QUALITY_PROVIDER_BUDGET_CONFIGURED", "이미 설정한 예산을 덮어쓸 수 없습니다.");
      const event = createProviderBudgetEvent({
        schemaVersion: 2,
        scopeId: scope,
        environment: input.policy.environment,
        provenance: input.policy.provenance,
        revision: 1,
        previousDigest: null,
        eventId: input.clientRequestId,
        recordedAt: new Date().toISOString(),
        currency: input.policy.currency,
        unitScale: input.policy.unitScale,
        payload: { kind: "configure", capUnits: input.policy.capUnits },
      });
      const receipt = createProviderReceipt({
        schemaVersion: 2,
        scopeId: scope,
        kind: "provider-budget-configure",
        clientRequestId: input.clientRequestId,
        inputDigest,
        runId: null,
        runRevision: null,
        budgetRevision: 1,
        operationDigest: event.eventDigest,
        recordedAt: event.recordedAt,
      });
      this.budgetEvent(event);
      this.receipt(receipt);
      const next = this.inspect();
      this.context.capacity(0);
      return {
        budget: this.scopeBudget(next.provider, input.policy.environment),
        receipt,
        newlyCommitted: true,
        replayed: false,
      };
    }, true);
  }
  start(value: ProviderStart) {
    const input = providerStartSchema.parse(value);
    this.enabled(input.preparation.environment);
    const inputDigest = digest(providerStartDigestInput(input));
    return this.context.transaction(() => {
      const all = this.inspect(),
        state = all.provider,
        previous = this.replay(state, input.clientRequestId, inputDigest, "provider-start");
      if (previous)
        return {
          snapshot: this.snapshot(state, previous.runId!, previous.runRevision!),
          receipt: previous,
          newlyCommitted: false,
          replayed: true,
        };
      this.free(input.clientRequestId);
      const prep = input.preparation,
        scope = providerBudgetScope(prep.environment),
        budget = this.scopeBudget(state, prep.environment);
      if (
        budget.revision !== input.expectedBudgetRevision ||
        budget.headDigest !== input.expectedBudgetDigest ||
        all.globalRunCount !== input.expectedGlobalRunCount ||
        state.runs.filter((run) => run.environment === prep.environment).length !==
          input.expectedScopeRunCount
      )
        fail("QUALITY_PROVIDER_VERSION_CONFLICT", "예산 또는 실행 기록이 변경됐습니다.");
      if (all.globalRunCount >= 20)
        fail("QUALITY_PROVIDER_RUN_LIMIT", "실행 기록 한도에 도달했습니다.");
      if (
        state.snapshots.some(
          (item) =>
            (item.state === "reserved" ||
              ("eligibleForNewCandidateRun" in item && !item.eligibleForNewCandidateRun)) &&
            item.run.environment === prep.environment &&
            item.run.preparation.scope.candidateId === prep.scope.candidateId,
        )
      )
        fail("QUALITY_PROVIDER_UNSETTLED", "같은 후보의 이전 예약을 먼저 확인해 주세요.");
      validateNewProviderPreparation(
        prep,
        this.context.registry(prep.scope.version),
        new Date().toISOString(),
      );
      const now = Date.now();
      if (
        Date.parse(prep.preparedAt) > now ||
        Date.parse(prep.expiresAt) <= now ||
        Date.parse(input.approval.approvedAt) > now ||
        Date.parse(input.approval.expiresAt) <= now
      )
        fail("QUALITY_PROVIDER_SCOPE_EXPIRED", "준비안 또는 승인 범위가 만료·변경됐습니다.");
      for (const authority of [
        prep.financialBasis.evidence.context?.authority,
        prep.financialBasis.evidence.pricing?.authority,
        prep.retention,
      ])
        if (
          !authority ||
          Date.parse(authority.reviewedAt) > now ||
          Date.parse(authority.validUntil) <= now
        )
          fail("QUALITY_PROVIDER_SCOPE_EXPIRED", "가격·문맥·보관 조건의 재확인이 필요합니다.");
      if (
        prep.budget.scopeId !== scope ||
        prep.budget.revision !== budget.revision ||
        prep.budget.headDigest !== budget.headDigest ||
        prep.budget.currency !== budget.currency ||
        prep.budget.unitScale !== budget.unitScale ||
        prep.budget.capUnits !== budget.capUnits ||
        prep.budget.heldUnits !== budget.heldUnits ||
        prep.budget.recognizedUnits !== budget.recognizedUnits
      )
        fail("QUALITY_PROVIDER_SCOPE_CHANGED", "준비안의 예산 근거가 달라졌습니다.");
      const costs = prep.financialBasis.costs!;
      if (BigInt(costs.totalUnits) > BigInt(budget.availableUnits))
        fail("QUALITY_PROVIDER_BUDGET_EXCEEDED", "남은 예산보다 예약액이 큽니다.");
      this.context.capacity(33554432);
      const id = randomUUID(),
        recordedAt = new Date().toISOString();
      const reservation = createProviderBudgetEvent({
        schemaVersion: 2,
        scopeId: scope,
        environment: prep.environment,
        provenance: input.approval.provenance,
        revision: budget.revision + 1,
        previousDigest: budget.headDigest,
        eventId: input.clientRequestId,
        recordedAt,
        currency: budget.currency!,
        unitScale: budget.unitScale!,
        payload: {
          kind: "reserve-run",
          runId: id,
          preparationDigest: prep.preparationDigest,
          generationUnits: costs.generation.totalUnits,
          reviewUnits: costs.review.totalUnits,
        },
      });
      const run = createProviderRun({ input, id, recordedAt, reservation }),
        artifact = createProviderArtifact({
          runId: id,
          body: JSON.stringify(prep.generation.body),
        });
      const receipt = createProviderReceipt({
        schemaVersion: 2,
        scopeId: scope,
        kind: "provider-start",
        clientRequestId: input.clientRequestId,
        inputDigest,
        runId: id,
        runRevision: 0,
        budgetRevision: reservation.revision,
        operationDigest: run.runDigest,
        recordedAt,
      });
      this.put("quality_actual_runs", { id }, run, 2 * 1024 * 1024);
      this.context.db
        .prepare(
          "INSERT INTO quality_actual_artifacts(run_id,artifact_key,payload,sha256,size_bytes) VALUES(?,?,?,?,?)",
        )
        .run(id, artifact.key, Buffer.from(artifact.body), artifact.sha256, artifact.sizeBytes);
      this.budgetEvent(reservation);
      this.receipt(receipt);
      const next = this.inspect();
      this.context.capacity(0);
      return {
        snapshot: this.snapshot(next.provider, id, 0),
        receipt,
        newlyCommitted: true,
        replayed: false,
      };
    }, true);
  }
  private snapshot(state: State, id: string, revision?: number) {
    const value = this.archiveSnapshot(state, id, revision);
    if (value.archiveFormatVersion === 4 || value.archiveFormatVersion === 5)
      return fail(
        "PROVIDER_NATIVE_VERSION_UNSUPPORTED",
        "이 보관 버전의 전송·실행은 아직 지원하지 않습니다.",
      );
    return value;
  }
  private archiveSnapshot(state: State, id: string, revision?: number) {
    const run = state.runs.find((row) => row.id === id);
    if (!run) fail("QUALITY_PROVIDER_NOT_FOUND", "예약 기록을 찾을 수 없습니다.", 404);
    const events = state.events.filter((row) => row.runId === id);
    const target = revision ?? events.length;
    if (!Number.isInteger(target) || target < 0 || target > events.length)
      fail("QUALITY_PROVIDER_REVISION_NOT_FOUND", "예약 기록 버전이 없습니다.", 404);
    const receipts = state.receipts.filter(
        (row) => row.runId === id && row.runRevision !== null && row.runRevision <= target,
      ),
      head = Math.max(run.reservedBudgetRevision, ...receipts.map((row) => row.budgetRevision));
    const prefix = events.slice(0, target);
    const keys = new Set<string>(["generation-request"]);
    for (const event of prefix) {
      const payload = event.payload as {
        kind: string;
        phase?: string;
        artifactSha256?: string;
        finalArtifactSha256?: string;
      };
      const suffix =
        payload.kind === "request-prepared"
          ? "request"
          : payload.kind === "response-received"
            ? "response"
            : payload.kind === "domain-validated"
              ? "validated"
              : null;
      if (suffix && payload.phase && payload.artifactSha256) keys.add(`${payload.phase}-${suffix}`);
      if (payload.kind === "execution-stopped" && payload.finalArtifactSha256)
        keys.add("final-result");
    }
    return validateVersionedProviderRunLedger({
      run,
      events: prefix,
      artifacts: state.artifacts.filter((row) => row.runId === id && keys.has(row.key)),
      receipts,
      budgetEvents: state.budgetEvents.filter(
        (row) => row.scopeId === providerBudgetScope(run.environment) && row.revision <= head,
      ),
      registry: this.context.registry(run.preparation.scope.version),
    });
  }
  cancel(id: string, value: ProviderCancel) {
    uuid.parse(id);
    const input = providerCancelSchema.parse(value),
      inputDigest = digest(providerCancelDigestInput(id, input));
    return this.context.transaction(() => {
      const state = this.inspect().provider,
        run = state.runs.find((row) => row.id === id);
      if (!run) fail("QUALITY_PROVIDER_NOT_FOUND", "예약 기록을 찾을 수 없습니다.", 404);
      this.enabled(run.environment);
      const previous = this.replay(state, input.clientRequestId, inputDigest, "provider-cancel");
      if (previous)
        return {
          snapshot: this.snapshot(state, id, previous.runRevision!),
          receipt: previous,
          newlyCommitted: false,
          replayed: true,
        };
      this.free(input.clientRequestId);
      if (state.events.some((row) => row.runId === id))
        fail("QUALITY_PROVIDER_VERSION_CONFLICT", "이미 취소된 예약입니다.");
      const budget = this.scopeBudget(state, run.environment),
        costs = run.preparation.financialBasis.costs!,
        recordedAt = new Date().toISOString();
      const release = createProviderBudgetEvent({
        schemaVersion: 2,
        scopeId: budget.scopeId,
        environment: run.environment,
        provenance: run.approval.provenance,
        revision: budget.revision + 1,
        previousDigest: budget.headDigest,
        eventId: input.clientRequestId,
        recordedAt,
        currency: budget.currency!,
        unitScale: budget.unitScale!,
        payload: {
          kind: "release-run",
          runId: id,
          reservationDigest: run.reservationDigest,
          generationUnits: costs.generation.totalUnits,
          reviewUnits: costs.review.totalUnits,
          reason: "cancelled-before-dispatch",
        },
      });
      const event = createProviderRunEvent({
        schemaVersion: 2,
        runId: id,
        revision: 1,
        budgetRevision: release.revision,
        previousEventDigest: null,
        recordedAt,
        payload: {
          kind: "cancelled-before-dispatch",
          reason: input.reason,
          releaseBudgetEventDigest: release.eventDigest,
        },
      });
      const receipt = createProviderReceipt({
        schemaVersion: 2,
        scopeId: budget.scopeId,
        kind: "provider-cancel",
        clientRequestId: input.clientRequestId,
        inputDigest,
        runId: id,
        runRevision: 1,
        budgetRevision: release.revision,
        operationDigest: event.eventDigest,
        recordedAt,
      });
      this.put("quality_actual_events", { run_id: id, revision: 1 }, event, 32 * 1024);
      this.budgetEvent(release);
      this.receipt(receipt);
      const next = this.inspect();
      this.context.capacity(0);
      return {
        snapshot: this.snapshot(next.provider, id, 1),
        receipt,
        newlyCommitted: true,
        replayed: false,
      };
    }, true);
  }
  private currentScope(run: ProviderRun) {
    const preparation = run.preparation;
    validateNewProviderPreparation(
      preparation,
      this.context.registry(preparation.scope.version),
      new Date().toISOString(),
    );
    for (const authority of [
      preparation.financialBasis.evidence.context?.authority,
      preparation.financialBasis.evidence.pricing?.authority,
      preparation.retention,
    ]) {
      if (
        !authority ||
        Date.parse(authority.reviewedAt) > Date.now() ||
        Date.parse(authority.validUntil) <= Date.now()
      )
        fail("QUALITY_PROVIDER_SCOPE_EXPIRED", "전송 범위의 근거를 다시 확인해 주세요.");
    }
  }
  private record(
    id: string,
    value: ProviderExecutionCommand,
    expectedKind: ProviderExecutionPayload["kind"],
    kind: ProviderExecutionReceipt["kind"],
  ) {
    uuid.parse(id);
    const input = providerExecutionCommandSchema.parse(value);
    if (input.payload.kind !== expectedKind)
      fail("QUALITY_PROVIDER_EVENT_INVALID", "요청한 단계와 기록 종류가 다릅니다.");
    const inputDigest = providerExecutionOperationDigest(id, input);
    return this.context.transaction(() => {
      const state = this.inspect().provider;
      const current = this.snapshot(state, id);
      const run = current.run;
      this.enabled(run.environment);
      const previous = this.replay(state, input.clientRequestId, inputDigest, kind);
      if (previous)
        return {
          snapshot: this.snapshot(state, id, previous.runRevision!),
          receipt: previous,
          newlyCommitted: false,
          replayed: true,
        };
      this.free(input.clientRequestId);
      if (current.revision !== input.expectedRevision)
        fail("QUALITY_PROVIDER_VERSION_CONFLICT", "실행 기록이 변경됐습니다.");
      let scoped = state.budgetEvents.filter(
        (row) => row.scopeId === providerBudgetScope(run.environment),
      );
      let budget = getProviderExecutionBudgetSnapshot(scoped, providerBudgetScope(run.environment));
      const approved = current.events.find(
        (event) => event.payload.kind === "transmission-approved",
      );
      const approval =
        input.payload.kind === "transmission-approved"
          ? input.payload
          : approved?.payload.kind === "transmission-approved"
            ? approved.payload
            : null;
      if (["transmission-approved", "request-prepared", "dispatch-intent"].includes(expectedKind)) {
        this.currentScope(run);
        if (
          !approval ||
          Date.parse(approval.approvedAt) > Date.now() ||
          Date.parse(approval.expiresAt) <= Date.now() ||
          Date.parse(approval.manifest.executionContract.usagePolicy.authority.validUntil) <=
            Date.now()
        )
          fail("QUALITY_PROVIDER_SCOPE_EXPIRED", "전송 승인 또는 요율 구분 근거가 만료됐습니다.");
        const payload = input.payload;
        if (
          !("budgetRevision" in payload) ||
          payload.budgetRevision !== budget.revision ||
          payload.budgetDigest !== budget.headDigest ||
          budget.boundBreached ||
          BigInt(budget.deficitUnits) > BigInt(0)
        )
          fail("QUALITY_PROVIDER_BUDGET_CONFLICT", "현재 예산과 실행 범위를 다시 확인해 주세요.");
      }
      const needsArtifact =
        expectedKind === "response-received" ||
        expectedKind === "domain-validated" ||
        (input.payload.kind === "request-prepared" && input.payload.phase === "review") ||
        (input.payload.kind === "execution-stopped" && input.payload.outcome === "completed");
      if (
        needsArtifact !== Boolean(input.artifact) ||
        (input.artifact && input.artifact.runId !== id)
      )
        fail("QUALITY_PROVIDER_ARTIFACT_INVALID", "이 단계의 정확한 원문이 필요합니다.");
      const recordedAt = new Date().toISOString();
      const appendBudget = (
        payload: ProviderBudgetEvent["payload"],
        eventId: string = randomUUID(),
      ) => {
        const event = createProviderBudgetEvent({
          schemaVersion: 2,
          scopeId: budget.scopeId,
          environment: run.environment,
          provenance: run.approval.provenance,
          revision: budget.revision + 1,
          previousDigest: budget.headDigest,
          eventId,
          recordedAt,
          currency: budget.currency!,
          unitScale: budget.unitScale!,
          payload,
        });
        this.budgetEvent(event);
        scoped = [...scoped, event];
        budget = getProviderExecutionBudgetSnapshot(scoped, budget.scopeId);
        return event;
      };
      let payload: ProviderExecutionPayload;
      if (input.payload.kind === "response-received") {
        if (!approval || !input.artifact)
          fail("QUALITY_PROVIDER_EVENT_INVALID", "전송 승인과 응답 원문을 찾을 수 없습니다.");
        const raw = JSON.parse(input.artifact.body);
        if (
          !raw ||
          raw.captureKind !== "sdk-response-json-v2" ||
          Object.keys(raw).sort().join(",") !== "captureKind,response"
        )
          fail("QUALITY_PROVIDER_ARTIFACT_INVALID", "응답 원문의 형식이 다릅니다.");
        const response = captureProviderResponse(raw.response);
        if (digest(response) !== digest(raw.response))
          fail("QUALITY_PROVIDER_ARTIFACT_INVALID", "허용되지 않은 응답 필드가 있습니다.");
        const metadata = providerResponseMetadata(response, {
          configuredModel: run.preparation.model,
          requestedTier: "default",
        });
        if (digest(metadata) !== digest(input.payload.metadata))
          fail("QUALITY_PROVIDER_ARTIFACT_INVALID", "응답 원문과 사용량 근거가 다릅니다.");
        const assessment = assessProviderUsage({
          response,
          policy: approval.manifest.executionContract.usagePolicy,
          financialBasis: run.preparation.financialBasis,
          phase: input.payload.phase,
        });
        let usageBudgetEventDigest: string | null = null;
        const responsePhase = input.payload.phase;
        if (assessment.status === "known") {
          const reservation = budget.reservations
            .find((row) => row.runId === id)
            ?.phases.find((row) => row.phase === responsePhase);
          if (!reservation || reservation.settled || assessment.units === null)
            fail("QUALITY_PROVIDER_EVENT_INVALID", "정산할 예약을 확인할 수 없습니다.");
          const held = BigInt(reservation.heldUnits),
            units = BigInt(assessment.units);
          const consumed = units < held ? units : held;
          const event = appendBudget(
            {
              kind: "recognize-usage",
              runId: id,
              phase: input.payload.phase,
              reservationDigest: run.reservationDigest,
              dispatchEventDigest: input.payload.dispatchEventDigest,
              responseArtifactSha256: input.artifact.sha256,
              usageAssessmentDigest: digest(assessment),
              recognizedUnits: assessment.units,
              consumedHeldUnits: consumed.toString(),
              releasedHeldUnits: (held - consumed).toString(),
              boundExcessUnits: (units > held ? units - held : BigInt(0)).toString(),
              violations: assessment.violations,
            },
            input.clientRequestId,
          );
          usageBudgetEventDigest = event.eventDigest;
        }
        payload = { ...input.payload, usageAssessment: assessment, usageBudgetEventDigest };
      } else if (input.payload.kind === "execution-stopped") {
        const releasedBudgetEventDigests: string[] = [];
        for (const phase of ["generation", "review"] as const) {
          const reservation = budget.reservations
            .find((row) => row.runId === id)
            ?.phases.find((row) => row.phase === phase);
          const dispatched = current.events.some(
            (event) => event.payload.kind === "dispatch-intent" && event.payload.phase === phase,
          );
          if (reservation && !reservation.settled && !dispatched) {
            const event = appendBudget({
              kind: "release-phase",
              runId: id,
              phase,
              reservationDigest: run.reservationDigest,
              releasedUnits: reservation.heldUnits,
              reason: "not-dispatched",
            });
            releasedBudgetEventDigests.push(event.eventDigest);
          }
        }
        payload = { ...input.payload, releasedBudgetEventDigests };
      } else payload = input.payload;
      const event = createProviderExecutionEvent({
        schemaVersion: 2,
        executionContractVersion: 1,
        runId: id,
        revision: current.revision + 1,
        budgetRevision: budget.revision,
        previousEventDigest: current.events.at(-1)?.eventDigest ?? null,
        recordedAt,
        payload,
      });
      const receipt = createProviderExecutionReceipt({
        schemaVersion: 2,
        scopeId: budget.scopeId,
        kind,
        clientRequestId: input.clientRequestId,
        inputDigest,
        runId: id,
        runRevision: event.revision,
        budgetRevision: budget.revision,
        operationDigest: event.eventDigest,
        recordedAt,
      });
      if (input.artifact) {
        const artifact = input.artifact;
        this.context.db
          .prepare(
            "INSERT INTO quality_actual_artifacts(run_id,artifact_key,payload,sha256,size_bytes) VALUES(?,?,?,?,?)",
          )
          .run(
            id,
            artifact.key,
            Buffer.from(artifact.body, "utf8"),
            artifact.sha256,
            artifact.sizeBytes,
          );
      }
      this.put("quality_actual_events", { run_id: id, revision: event.revision }, event, 32 * 1024);
      this.receipt(receipt);
      const next = this.inspect();
      this.context.capacity(0);
      return {
        snapshot: this.snapshot(next.provider, id, event.revision),
        receipt,
        newlyCommitted: true,
        replayed: false,
      };
    }, true);
  }
  recordApprove(id: string, input: ProviderExecutionCommand<"transmission-approved">) {
    return this.record(id, input, "transmission-approved", "provider-approve");
  }
  recordPrepared(id: string, input: ProviderExecutionCommand<"request-prepared">) {
    return this.record(id, input, "request-prepared", "provider-prepared");
  }
  recordDispatch(id: string, input: ProviderExecutionCommand<"dispatch-intent">) {
    return this.record(id, input, "dispatch-intent", "provider-dispatch");
  }
  recordResponse(id: string, input: ProviderExecutionCommand<"response-received">) {
    return this.record(id, input, "response-received", "provider-response");
  }
  recordValidated(id: string, input: ProviderExecutionCommand<"domain-validated">) {
    return this.record(id, input, "domain-validated", "provider-validated");
  }
  recordFinish(id: string, input: ProviderExecutionCommand<"execution-stopped">) {
    return this.record(id, input, "execution-stopped", "provider-finish");
  }
  getArchive(id: string, revision?: number) {
    uuid.parse(id);
    return this.context.transaction(() =>
      this.archiveSnapshot(this.inspect().provider, id, revision),
    );
  }
  get(id: string, revision?: number) {
    uuid.parse(id);
    return this.context.transaction(() => this.snapshot(this.inspect().provider, id, revision));
  }
  list() {
    return this.context.transaction(() => {
      const state = this.inspect().provider;
      return { executions: state.runs.map((run) => this.snapshot(state, run.id)) };
    });
  }
  lookup(nonce: string) {
    uuid.parse(nonce);
    return this.context.transaction(() => {
      const receipt = this.inspect().provider.receipts.find((row) => row.clientRequestId === nonce);
      return receipt
        ? { state: "committed" as const, receipt }
        : { state: "not-observed" as const };
    });
  }
  artifact(id: string, key = "generation-request") {
    uuid.parse(id);
    return this.context.transaction(() => {
      const state = this.inspect().provider;
      this.archiveSnapshot(state, id);
      const artifact = state.artifacts.find((row) => row.runId === id && row.key === key);
      if (!artifact)
        fail("QUALITY_PROVIDER_ARTIFACT_NOT_FOUND", "보관한 원문을 찾을 수 없습니다.", 404);
      return { ...artifact, body: Buffer.from(artifact.body) };
    });
  }
  download(id: string, revision: number) {
    uuid.parse(id);
    return this.context.transaction(() => {
      const state = this.inspect().provider,
        snapshot = this.archiveSnapshot(state, id, revision),
        scope = providerBudgetScope(snapshot.run.environment);
      const receipts = state.receipts
        .filter(
          (row) => row.runId === id && row.runRevision !== null && row.runRevision <= revision,
        )
        .sort((a, b) => a.runRevision! - b.runRevision!);
      const head = Math.max(
        snapshot.run.reservedBudgetRevision,
        ...receipts.map((row) => row.budgetRevision),
      );
      const raw = (table: string, where: string, args: (string | number)[]) =>
        this.context.db
          .prepare(`SELECT body FROM ${table} ${where}`)
          .all(...args)
          .map((row) => String(row.body));
      const keys = new Set(snapshot.artifacts.map((row) => row.key));
      const artifacts = state.artifacts
        .filter((row) => row.runId === id && keys.has(row.key))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map((artifact) => ({
          runId: id,
          key: artifact.key,
          sha256: artifact.sha256,
          sizeBytes: artifact.sizeBytes,
          encoding: "base64",
          payload: Buffer.from(artifact.body).toString("base64"),
        }));
      const format = snapshot.archiveFormatVersion;
      const kind =
        format === 3 || format === 5
          ? "provider-execution-archive"
          : "provider-reservation-archive";
      const body = `{"schemaVersion":2,"archiveFormatVersion":${format},"kind":"${kind}","run":${raw("quality_actual_runs", "WHERE id=?", [id])[0]},"events":[${raw("quality_actual_events", "WHERE run_id=? AND revision<=? ORDER BY revision", [id, revision]).join(",")}],"budgetEvents":[${raw("quality_actual_budget_events", "WHERE scope_id=? AND revision<=? ORDER BY revision", [scope, head]).join(",")}],"receipts":[${receipts.map((row) => raw("quality_actual_requests", "WHERE nonce=?", [row.clientRequestId])[0]).join(",")}],"artifacts":${JSON.stringify(artifacts)}}\n`;
      return { snapshot, body };
    });
  }
}
