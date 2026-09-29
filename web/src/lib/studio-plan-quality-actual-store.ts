import { inspectLedgerDatabase } from "./studio-plan-quality-ledger-database";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { StudioError } from "./studio-http";
import { planQualityEvaluationDigest as digest } from "./studio-plan-quality-evaluation";
import type { CandidateRegistrySnapshot } from "./studio-plan-quality-candidate-registry-types";
import { validateQualityActualPreparation } from "./studio-plan-quality-actual-preparation";
import {
  actualLedgerArtifactSchema,
  actualLedgerLimits,
  actualLedgerPolicySchema,
  actualLedgerScope,
  actualLedgerStartSchema,
  actualLedgerStartDigestInput,
  type ActualLedgerArtifact,
  type ActualLedgerBudgetEvent,
  type ActualLedgerBudgetPayload,
  type ActualLedgerPolicy,
  type ActualLedgerReceipt,
  type ActualLedgerRun,
  type ActualLedgerRunPayload,
  type ActualLedgerStart,
} from "./studio-plan-quality-actual-ledger-types";
import {
  createActualRun,
  createActualBudgetEvent,
  createActualRunEvent,
  createActualReceipt,
  validateActualBudgetLedger,
  validateActualRunLedger,
  calculateActualUsage,
  actualLedgerOperationDigest,
} from "./studio-plan-quality-actual-ledger";

type Payload<K extends ActualLedgerRunPayload["kind"]> = Extract<
  ActualLedgerRunPayload,
  { kind: K }
>;
export type ActualBudgetConfigure = {
  clientRequestId: string;
  expectedRevision: number;
  policy: ActualLedgerPolicy;
};
export type ActualRecordInput<P> = {
  clientRequestId: string;
  expectedRevision: number;
  payload: P;
  artifact?: ActualLedgerArtifact;
};
export type ActualPreparedInput = ActualRecordInput<Payload<"request-prepared">>;
export type ActualDispatchInput = ActualRecordInput<Payload<"dispatch-intent">>;
export type ActualResponseInput = ActualRecordInput<
  Omit<Payload<"response-received">, "usageBudgetEventDigest">
>;
export type ActualValidatedInput = ActualRecordInput<Payload<"domain-validated">>;
export type ActualFinishInput = ActualRecordInput<
  Omit<Payload<"execution-stopped">, "releasedBudgetEventDigests">
>;
type Context = {
  db: DatabaseSync;
  transaction: <T>(work: () => T, write?: boolean) => T;
  registry: (version: number) => CandidateRegistrySnapshot;
  capacity: (addedBytes: number) => void;
  synthetic: boolean;
};
type State = ReturnType<typeof inspectLedgerDatabase>["legacy"];
const uuid = z.string().uuid();
const nonceTables = [
  "quality_provider_policies",
  "quality_requests",
  "quality_candidate_requests",
  "quality_execution_requests",
] as const;
function fail(code: string, message: string, status = 409): never {
  throw new StudioError(message, status, code);
}
const sha = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex");
const bytes = (body: string) => Buffer.byteLength(body, "utf8");
function artifactRef(value: ActualLedgerArtifact) {
  const { body, ...ref } = value;
  void body;
  return ref;
}
function assertCurrentEvidence(run: Pick<ActualLedgerRun, "preparation" | "approval">) {
  const now = Date.now(),
    prep = run.preparation;
  if (
    Date.parse(prep.preparedAt) > now ||
    Date.parse(run.approval.approvedAt) > now ||
    Date.parse(run.approval.approvedAt) < Date.parse(prep.preparedAt)
  )
    fail("QUALITY_ACTUAL_EVIDENCE_EXPIRED", "승인 시각과 준비안 유효기간을 확인해 주세요.");
  for (const value of [prep.evidence.price, prep.evidence.tokens]) {
    if (
      !value ||
      Date.parse(value.authority.reviewedAt) > now ||
      Date.parse(value.authority.validFrom) > now ||
      Date.parse(value.authority.validUntil) <= now
    )
      fail("QUALITY_ACTUAL_EVIDENCE_EXPIRED", "가격 또는 토큰 근거의 유효기간이 지났습니다.");
  }
  const budget = prep.evidence.budget;
  if (!budget || Date.parse(budget.observedAt) > now || Date.parse(budget.validUntil) <= now)
    fail("QUALITY_ACTUAL_EVIDENCE_EXPIRED", "예산 조회 근거의 유효기간이 지났습니다.");
}
const mutationSchema = z
  .object({
    clientRequestId: uuid,
    expectedRevision: z.number().int().min(0).max(actualLedgerLimits.events),
    payload: z.record(z.string(), z.unknown()),
    artifact: actualLedgerArtifactSchema.optional(),
  })
  .strict();

/** Internal synthetic ledger storage. No transport, credentials, company rows or file artifacts. */
export class ActualLedgerStore {
  constructor(private readonly context: Context) {}
  private assertEnabled() {
    if (!this.context.synthetic)
      fail(
        "ACTUAL_EXECUTION_DISABLED",
        "실제 AI 실행과 운영 비용 예약은 연결되지 않았습니다.",
        403,
      );
  }
  private nonceFree(nonce: string) {
    for (const table of [...nonceTables, "quality_actual_requests"])
      if (this.context.db.prepare(`SELECT nonce FROM ${table} WHERE nonce=?`).get(nonce))
        fail("QUALITY_ACTUAL_NONCE_CONFLICT", "같은 요청 번호가 다른 품질 기록에 사용됐습니다.");
  }
  /** Complete shared inspection; public legacy methods still return v1 records only. */
  inspect(): State {
    return inspectLedgerDatabase(this.context.db, this.context.registry).legacy;
  }
  reservedStorageBytes() {
    return inspectLedgerDatabase(this.context.db, this.context.registry).reservedBytes;
  }
  private slots(state: State) {
    if (
      state.budgetEvents.length +
        state.snapshots.reduce((sum, v) => sum + v.storage.remainingBudgetEventSlots, 0) >
        actualLedgerLimits.budgetEvents ||
      state.receipts.length +
        state.snapshots.reduce((sum, v) => sum + v.storage.remainingReceiptSlots, 0) >
        actualLedgerLimits.receipts
    )
      fail("QUALITY_ACTUAL_STORAGE_LIMIT", "비용 원장의 예약 기록 한도에 도달했습니다.");
  }
  private writeJson(
    table: string,
    keys: Record<string, string | number>,
    value: unknown,
    max: number,
  ) {
    const body = JSON.stringify(value);
    if (bytes(body) > max)
      fail("QUALITY_ACTUAL_STORAGE_LIMIT", "비용 원장 기록의 보관 한도를 초과했습니다.", 413);
    const columns = [...Object.keys(keys), "body", "body_hash"];
    this.context.db
      .prepare(
        `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
      )
      .run(...Object.values(keys), body, digest(value));
  }
  private putArtifact(value: ActualLedgerArtifact, state: State) {
    const parsed = actualLedgerArtifactSchema.parse(value);
    if (bytes(parsed.body) !== parsed.sizeBytes || sha(parsed.body) !== parsed.sha256)
      fail("QUALITY_ACTUAL_ARTIFACT_INVALID", "원문 바이트와 해시가 다릅니다.");
    const previous = state.artifacts.find((v) => v.runId === parsed.runId && v.key === parsed.key);
    if (previous) {
      if (previous.body !== parsed.body || previous.sha256 !== parsed.sha256)
        fail("QUALITY_ACTUAL_ARTIFACT_CONFLICT", "보관된 실행 원문을 교체할 수 없습니다.");
      return;
    }
    this.context.db
      .prepare(
        "INSERT INTO quality_actual_artifacts(run_id,artifact_key,payload,sha256,size_bytes) VALUES(?,?,?,?,?)",
      )
      .run(
        parsed.runId,
        parsed.key,
        Buffer.from(parsed.body, "utf8"),
        parsed.sha256,
        parsed.sizeBytes,
      );
  }
  private putBudget(value: ActualLedgerBudgetEvent) {
    this.writeJson(
      "quality_actual_budget_events",
      { scope_id: actualLedgerScope, revision: value.revision },
      value,
      actualLedgerLimits.eventBytes,
    );
  }
  private putReceipt(value: ActualLedgerReceipt) {
    this.writeJson(
      "quality_actual_requests",
      { nonce: value.clientRequestId },
      value,
      actualLedgerLimits.receiptBytes,
    );
  }
  private nextBudget(
    state: State,
    payload: ActualLedgerBudgetPayload,
    eventId: string = randomUUID(),
  ) {
    return createActualBudgetEvent({
      scopeId: actualLedgerScope,
      revision: state.budget.revision + 1,
      previousDigest: state.budget.headDigest,
      eventId,
      recordedAt: new Date().toISOString(),
      provenance: "synthetic-test",
      currency: state.budget.currency!,
      unitScale: state.budget.unitScale!,
      payload,
    });
  }
  private replay(
    state: State,
    nonce: string,
    inputDigest: string,
    kind: ActualLedgerReceipt["kind"],
  ) {
    const receipt = state.receipts.find((v) => v.clientRequestId === nonce);
    if (!receipt) return null;
    if (receipt.inputDigest !== inputDigest || receipt.kind !== kind)
      fail("QUALITY_ACTUAL_NONCE_CONFLICT", "같은 요청 번호에 다른 비용 원장 작업이 기록됐습니다.");
    return receipt;
  }
  budgetGet() {
    return this.context.transaction(() => this.inspect().budget);
  }
  budgetConfigure(value: ActualBudgetConfigure) {
    this.assertEnabled();
    const input = z
      .object({
        clientRequestId: uuid,
        expectedRevision: z.number().int().min(0).max(999),
        policy: actualLedgerPolicySchema,
      })
      .strict()
      .parse(value);
    const inputDigest = digest({ kind: "actual-budget-configure", ...input });
    return this.context.transaction(() => {
      const state = this.inspect(),
        previous = this.replay(
          state,
          input.clientRequestId,
          inputDigest,
          "actual-budget-configure",
        );
      if (previous)
        return {
          budget: validateActualBudgetLedger(state.budgetEvents.slice(0, previous.budgetRevision)),
          receipt: previous,
          newlyCommitted: false,
          replayed: true,
        };
      this.nonceFree(input.clientRequestId);
      if (state.budget.revision !== input.expectedRevision)
        fail("QUALITY_ACTUAL_BUDGET_CONFLICT", "예산 원장이 변경됐습니다.");
      if (state.budget.revision !== 0)
        fail(
          "QUALITY_ACTUAL_BUDGET_CONFIGURED",
          "이미 설정한 합성 예산은 새 요청으로 덮어쓸 수 없습니다.",
        );
      if (
        state.budget.revision &&
        (state.budget.currency !== input.policy.currency ||
          state.budget.unitScale !== input.policy.unitScale)
      )
        fail("QUALITY_ACTUAL_BUDGET_SCOPE", "예산 통화와 단위를 변경할 수 없습니다.");
      if (BigInt(input.policy.capUnits) < BigInt(state.budget.exposureUnits))
        fail(
          "QUALITY_ACTUAL_BUDGET_EXCEEDED",
          "이미 기록한 비용과 예약보다 작은 예산은 설정할 수 없습니다.",
        );
      const event = createActualBudgetEvent({
        scopeId: actualLedgerScope,
        revision: state.budget.revision + 1,
        previousDigest: state.budget.headDigest,
        eventId: input.clientRequestId,
        recordedAt: new Date().toISOString(),
        provenance: "synthetic-test",
        currency: input.policy.currency,
        unitScale: input.policy.unitScale,
        payload: { kind: "configure", capUnits: input.policy.capUnits },
      });
      const receipt = createActualReceipt({
        kind: "actual-budget-configure",
        clientRequestId: input.clientRequestId,
        inputDigest,
        runId: null,
        runRevision: null,
        budgetRevision: event.revision,
        operationDigest: event.eventDigest,
        recordedAt: event.recordedAt,
      });
      this.putBudget(event);
      this.putReceipt(receipt);
      const next = this.inspect();
      this.slots(next);
      this.context.capacity(0);
      return { budget: next.budget, receipt, newlyCommitted: true, replayed: false };
    }, true);
  }
  start(value: ActualLedgerStart) {
    this.assertEnabled();
    const input = actualLedgerStartSchema.parse(value),
      inputDigest = digest(actualLedgerStartDigestInput(input));
    return this.context.transaction(() => {
      const state = this.inspect(),
        previous = this.replay(state, input.clientRequestId, inputDigest, "actual-start");
      if (previous)
        return {
          snapshot: this.getFromState(state, previous.runId!, previous.runRevision!),
          receipt: previous,
          newlyCommitted: false,
          replayed: true,
        };
      this.nonceFree(input.clientRequestId);
      if (
        state.budget.revision !== input.expectedBudgetRevision ||
        state.budget.headDigest !== input.expectedBudgetDigest ||
        state.runs.length !== input.expectedActualRunCount
      )
        fail("QUALITY_ACTUAL_VERSION_CONFLICT", "예산 또는 실행 기록이 변경됐습니다.");
      if (
        inspectLedgerDatabase(this.context.db, this.context.registry).globalRunCount >=
        actualLedgerLimits.runs
      )
        fail("QUALITY_ACTUAL_RUN_LIMIT", "비용 원장 실행 기록 한도에 도달했습니다.");
      if (
        state.budget.boundBreached ||
        state.snapshots.some(
          (v) =>
            v.sameCandidateBlocked &&
            v.run.preparation.scope.candidateId === input.preparation.scope.candidateId,
        )
      )
        fail("QUALITY_ACTUAL_UNSETTLED", "이전 실행의 결과 또는 비용이 미확정입니다.");
      const prep = input.preparation,
        registry = this.context.registry(prep.scope.version);
      assertCurrentEvidence(input);
      try {
        validateQualityActualPreparation(prep, {
          registry,
          candidateId: prep.scope.candidateId,
          model: prep.model,
          preparedAt: prep.preparedAt,
          price: prep.evidence.price,
          tokens: prep.evidence.tokens,
          budget: prep.evidence.budget,
          environment: "synthetic-test",
        });
      } catch {
        fail("QUALITY_ACTUAL_SCOPE_CHANGED", "준비안과 등록 원문·엔진 범위가 다릅니다.");
      }
      const evidence = prep.evidence.budget;
      if (
        prep.readiness !== "calculation-ready" ||
        !prep.costs ||
        !evidence ||
        !prep.requestEvidence ||
        input.approval.approvedPreparationDigest !== prep.preparationDigest ||
        evidence.currency !== state.budget.currency ||
        evidence.unitScale !== state.budget.unitScale ||
        evidence.capUnits !==
          (BigInt(state.budget.capUnits) - BigInt(state.budget.recognizedUsageUnits)).toString() ||
        evidence.unsettledUnits !== state.budget.heldUnits ||
        evidence.ledgerDigest !== state.budget.headDigest
      )
        fail("QUALITY_ACTUAL_SCOPE_CHANGED", "예산 조회 근거와 준비안이 일치하지 않습니다.");
      const amount = BigInt(prep.costs.generationUnits) + BigInt(prep.costs.reviewUnits);
      if (amount > BigInt(state.budget.availableUnits))
        fail("QUALITY_ACTUAL_BUDGET_EXCEEDED", "예약할 비용이 남은 예산을 초과합니다.");
      // Reject an exhausted reservation before inserting provisional rows. Shared
      // archival inspection treats an over-cap persisted ledger as corruption.
      this.context.capacity(actualLedgerLimits.reservationBytes);
      const id = randomUUID(),
        recordedAt = new Date().toISOString();
      const reservation = this.nextBudget(
        state,
        {
          kind: "reserve-run",
          runId: id,
          preparationDigest: prep.preparationDigest,
          generationUnits: prep.costs.generationUnits,
          reviewUnits: prep.costs.reviewUnits,
        },
        input.clientRequestId,
      );
      const run = createActualRun({ input, id, recordedAt, reservation });
      const body = JSON.stringify(prep.requestEvidence.generation.body),
        artifact: ActualLedgerArtifact = {
          runId: id,
          key: "generation-request",
          body,
          sha256: sha(body),
          sizeBytes: bytes(body),
        };
      const receipt = createActualReceipt({
        kind: "actual-start",
        clientRequestId: input.clientRequestId,
        inputDigest,
        runId: id,
        runRevision: 0,
        budgetRevision: reservation.revision,
        operationDigest: run.runDigest,
        recordedAt,
      });
      this.writeJson("quality_actual_runs", { id }, run, actualLedgerLimits.runBytes);
      this.putArtifact(artifact, state);
      this.putBudget(reservation);
      this.putReceipt(receipt);
      const next = this.inspect();
      this.slots(next);
      this.context.capacity(0);
      return {
        snapshot: next.snapshots.find((v) => v.run.id === id)!,
        receipt,
        newlyCommitted: true,
        replayed: false,
      };
    }, true);
  }
  private getFromState(state: State, id: string, revision?: number) {
    const current = state.snapshots.find((v) => v.run.id === id);
    if (!current) fail("QUALITY_ACTUAL_NOT_FOUND", "비용 원장 실행을 찾을 수 없습니다.", 404);
    const target = revision ?? current.revision;
    if (!Number.isInteger(target) || target < 0 || target > current.revision)
      fail("QUALITY_ACTUAL_REVISION_NOT_FOUND", "실행 기록 버전을 찾을 수 없습니다.", 404);
    if (target === current.revision) return current;
    const receipts = state.receipts.filter(
        (v) => v.runId === id && v.runRevision !== null && v.runRevision <= target,
      ),
      head = Math.max(current.run.reservedBudgetRevision, ...receipts.map((v) => v.budgetRevision));
    const events = current.events.slice(0, target),
      keys = new Set<string>(["generation-request"]);
    for (const event of events) {
      if ("artifactSha256" in event.payload)
        for (const artifact of state.artifacts)
          if (artifact.runId === id && artifact.sha256 === event.payload.artifactSha256)
            keys.add(artifact.key);
      if (event.payload.kind === "execution-stopped" && event.payload.finalArtifactSha256)
        keys.add("final-result");
    }
    return validateActualRunLedger({
      run: current.run,
      events,
      artifacts: state.artifacts.filter((v) => v.runId === id && keys.has(v.key)),
      budgetEvents: state.budgetEvents.slice(0, head),
      receipts,
      registry: this.context.registry(current.run.preparation.scope.version),
    });
  }
  private record(
    id: string,
    kind: ActualLedgerReceipt["kind"],
    expectedKind: ActualLedgerRunPayload["kind"],
    value: ActualRecordInput<unknown>,
  ) {
    this.assertEnabled();
    uuid.parse(id);
    const input = mutationSchema.parse(value);
    if (
      input.payload.kind !== expectedKind ||
      "usageBudgetEventDigest" in input.payload ||
      "releasedBudgetEventDigests" in input.payload
    )
      fail("QUALITY_ACTUAL_EVENT_INVALID", "실행 기록 종류 또는 서버 계산 필드가 다릅니다.");
    if (
      input.artifact &&
      (input.artifact.runId !== id ||
        bytes(input.artifact.body) !== input.artifact.sizeBytes ||
        sha(input.artifact.body) !== input.artifact.sha256)
    )
      fail("QUALITY_ACTUAL_ARTIFACT_INVALID", "원문 바이트와 실행 연결이 다릅니다.");
    const inputDigest = actualLedgerOperationDigest({
      kind,
      clientRequestId: input.clientRequestId,
      runId: id,
      expectedRevision: input.expectedRevision,
      payload: input.payload,
      artifact: input.artifact,
    });
    return this.context.transaction(() => {
      const state = this.inspect(),
        previous = this.replay(state, input.clientRequestId, inputDigest, kind);
      if (previous)
        return {
          snapshot: this.getFromState(state, id, previous.runRevision!),
          receipt: previous,
          newlyCommitted: false,
          replayed: true,
        };
      this.nonceFree(input.clientRequestId);
      const current = this.getFromState(state, id);
      if (current.revision !== input.expectedRevision)
        fail("QUALITY_ACTUAL_VERSION_CONFLICT", "실행 기록이 변경됐습니다.");
      if (expectedKind === "request-prepared" || expectedKind === "dispatch-intent") {
        assertCurrentEvidence(current.run);
        if (
          state.budget.boundBreached ||
          input.payload.budgetRevision !== state.budget.revision ||
          input.payload.budgetDigest !== state.budget.headDigest
        )
          fail("QUALITY_ACTUAL_BUDGET_CONFLICT", "현재 예산 또는 전송 상한을 다시 확인해 주세요.");
      }
      const needsArtifact =
        expectedKind === "response-received" ||
        expectedKind === "domain-validated" ||
        (expectedKind === "request-prepared" && input.payload.phase === "review") ||
        (expectedKind === "execution-stopped" && input.payload.outcome === "completed");
      if (needsArtifact !== Boolean(input.artifact))
        fail("QUALITY_ACTUAL_ARTIFACT_INVALID", "이 실행 단계에 필요한 원문 범위가 다릅니다.");
      let payload: ActualLedgerRunPayload;
      let nextBudgetState = state;
      if (expectedKind === "response-received") {
        const response = input.payload as Omit<
          Payload<"response-received">,
          "usageBudgetEventDigest"
        >;
        const recognition = calculateActualUsage({
          run: current.run,
          phase: response.phase,
          metadata: response.metadata,
          artifact: input.artifact!,
        });
        let usageBudgetEventDigest: string | null = null;
        if (recognition) {
          const event = this.nextBudget(nextBudgetState, recognition);
          this.putBudget(event);
          usageBudgetEventDigest = event.eventDigest;
          const budgetEvents = [...nextBudgetState.budgetEvents, event];
          nextBudgetState = {
            ...nextBudgetState,
            budgetEvents,
            budget: validateActualBudgetLedger(budgetEvents),
          };
        }
        payload = { ...response, usageBudgetEventDigest };
      } else if (expectedKind === "execution-stopped") {
        const stopped = input.payload as Omit<
          Payload<"execution-stopped">,
          "releasedBudgetEventDigests"
        >;
        const releasedBudgetEventDigests: string[] = [];
        for (const phase of ["generation", "review"] as const) {
          const reservation = nextBudgetState.budget.reservations.find(
            (v) => v.runId === id && v.phase === phase,
          );
          if (
            reservation &&
            !reservation.settled &&
            !current.events.some(
              (v) => v.payload.kind === "dispatch-intent" && v.payload.phase === phase,
            )
          ) {
            const event = this.nextBudget(nextBudgetState, {
              kind: "release-unused",
              runId: id,
              phase,
              reservationDigest: current.run.reservationDigest,
              units: reservation.heldUnits,
              reason: "not-dispatched",
            });
            this.putBudget(event);
            releasedBudgetEventDigests.push(event.eventDigest);
            const budgetEvents = [...nextBudgetState.budgetEvents, event];
            nextBudgetState = {
              ...nextBudgetState,
              budgetEvents,
              budget: validateActualBudgetLedger(budgetEvents),
            };
          }
        }
        payload = { ...stopped, releasedBudgetEventDigests };
      } else payload = input.payload as ActualLedgerRunPayload;
      const event = createActualRunEvent({
        runId: id,
        revision: current.revision + 1,
        previousEventDigest: current.events.at(-1)?.eventDigest ?? null,
        recordedAt: new Date().toISOString(),
        budgetRevision: nextBudgetState.budget.revision,
        payload,
      });
      const receipt = createActualReceipt({
        kind,
        clientRequestId: input.clientRequestId,
        inputDigest,
        runId: id,
        runRevision: event.revision,
        budgetRevision: nextBudgetState.budget.revision,
        operationDigest: event.eventDigest,
        recordedAt: event.recordedAt,
      });
      if (input.artifact) this.putArtifact(input.artifact, state);
      this.writeJson(
        "quality_actual_events",
        { run_id: id, revision: event.revision },
        event,
        actualLedgerLimits.eventBytes,
      );
      this.putReceipt(receipt);
      const next = this.inspect();
      this.slots(next);
      this.context.capacity(0);
      return {
        snapshot: next.snapshots.find((v) => v.run.id === id)!,
        receipt,
        newlyCommitted: true,
        replayed: false,
      };
    }, true);
  }
  recordPrepared(id: string, value: ActualPreparedInput) {
    return this.record(id, "actual-prepare", "request-prepared", value);
  }
  recordDispatch(id: string, value: ActualDispatchInput) {
    return this.record(id, "actual-dispatch", "dispatch-intent", value);
  }
  recordResponse(id: string, value: ActualResponseInput) {
    return this.record(id, "actual-response", "response-received", value);
  }
  recordValidated(id: string, value: ActualValidatedInput) {
    return this.record(id, "actual-validate", "domain-validated", value);
  }
  recordFinish(id: string, value: ActualFinishInput) {
    return this.record(id, "actual-stop", "execution-stopped", value);
  }
  get(id: string, revision?: number) {
    uuid.parse(id);
    return this.context.transaction(() => this.getFromState(this.inspect(), id, revision));
  }
  list() {
    return this.context.transaction(() => ({ executions: this.inspect().snapshots }));
  }
  lookup(nonce: string) {
    uuid.parse(nonce);
    return this.context.transaction(() => {
      const state = this.inspect(),
        receipt = state.receipts.find((v) => v.clientRequestId === nonce);
      return receipt
        ? { state: "committed" as const, receipt }
        : { state: "not-observed" as const };
    });
  }
  artifact(id: string, key: string) {
    uuid.parse(id);
    return this.context.transaction(() => {
      const state = this.inspect();
      this.getFromState(state, id);
      const artifact = state.artifacts.find((v) => v.runId === id && v.key === key);
      if (!artifact)
        fail("QUALITY_ACTUAL_ARTIFACT_NOT_FOUND", "보관한 실행 원문을 찾을 수 없습니다.", 404);
      return { ...artifactRef(artifact), body: Buffer.from(artifact.body, "utf8") };
    });
  }
  download(id: string, revision: number) {
    uuid.parse(id);
    return this.context.transaction(() => {
      const state = this.inspect(),
        snapshot = this.getFromState(state, id, revision);
      const raw = (table: string, where: string, args: (string | number)[]) =>
        this.context.db
          .prepare(`SELECT body FROM ${table} ${where}`)
          .all(...args)
          .map((row) => String(row.body));
      const receipts = state.receipts
          .filter((v) => v.runId === id && v.runRevision !== null && v.runRevision <= revision)
          .sort((a, b) => a.runRevision! - b.runRevision!),
        head = Math.max(
          snapshot.run.reservedBudgetRevision,
          ...receipts.map((v) => v.budgetRevision),
        );
      const artifactKeys = new Set(snapshot.artifacts.map((v) => v.key));
      const artifacts = state.artifacts
        .filter((v) => v.runId === id && artifactKeys.has(v.key))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map((value) => ({
          ...artifactRef(value),
          encoding: "base64",
          payload: Buffer.from(value.body, "utf8").toString("base64"),
        }));
      // This v1 emitter joins stored JSON bytes. Future archive formats must not rewrite this one.
      const body = `{"schemaVersion":1,"archiveFormatVersion":1,"kind":"actual-ledger-simulation-archive","run":${raw("quality_actual_runs", "WHERE id=?", [id])[0]},"events":[${raw("quality_actual_events", "WHERE run_id=? AND revision<=? ORDER BY revision", [id, revision]).join(",")}],"budgetEvents":[${raw("quality_actual_budget_events", "WHERE scope_id=? AND revision<=? ORDER BY revision", [actualLedgerScope, head]).join(",")}],"receipts":[${receipts.map((receipt) => raw("quality_actual_requests", "WHERE nonce=?", [receipt.clientRequestId])[0]).join(",")}],"artifacts":${JSON.stringify(artifacts)}}\n`;
      return { snapshot, body };
    });
  }
}
