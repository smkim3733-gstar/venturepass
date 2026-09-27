import { randomUUID } from "node:crypto";
import { StudioError } from "./studio-http";
import { caseSchema } from "./studio-schema";
import { generateObservedPlan, getPlanExecutionContract } from "./studio-engine";
import { executionDigest } from "./studio-engine-request-preparation";
import type { EngineExecutionTransportRequest } from "./studio-engine-execution-types";
import { candidateRegistryModelInput } from "./studio-plan-quality-candidate-registry";
import { planQualityEvaluationDigest as digest } from "./studio-plan-quality-evaluation";
import {
  createActualArtifact,
  deriveActualReviewRequest,
} from "./studio-plan-quality-actual-ledger";
import {
  actualLedgerStartSchema,
  actualLedgerValidatedArtifactSchema,
  type ActualLedgerReceipt,
  type ActualLedgerSnapshot,
  type ActualLedgerStart,
} from "./studio-plan-quality-actual-ledger-types";
import type { PlanQualityStore } from "./studio-plan-quality-store";
import type { ActualFinishInput } from "./studio-plan-quality-actual-store";

/** Internal synthetic adapters. No defaults, key lookup, provider client or HTTP entry point. */
export type QualityActualSimulationOptions = {
  transport: {
    provenance: "synthetic-test";
    model: string;
    contractDigest: string;
    send: (request: EngineExecutionTransportRequest) => Promise<unknown>;
  };
  tokenAdapter: {
    provenance: "synthetic-test";
    model: string;
    contractDigest: string;
    evidenceDigest: string;
    tokenizerId: string;
    tokenizerVersion: string;
    measure: (request: EngineExecutionTransportRequest) => number | Promise<number>;
  };
};
export type QualityActualSimulationResult = {
  snapshot: ActualLedgerSnapshot;
  receipt: ActualLedgerReceipt;
  replayed: boolean;
  recordingStatus: "complete" | "stopped" | "last-confirmed";
  failureCode: string | null;
};

function fail(): never {
  throw new StudioError(
    "합성 실행의 고정 범위 또는 현재 기록이 달라졌습니다.",
    409,
    "QUALITY_ACTUAL_RUNNER_SCOPE_CHANGED",
  );
}
function immutable<T>(value: T): T {
  const copy = structuredClone(value);
  function freeze(item: unknown) {
    if (item && typeof item === "object") {
      Object.values(item).forEach(freeze);
      Object.freeze(item);
    }
  }
  freeze(copy);
  return copy;
}
function isStopped(snapshot: ActualLedgerSnapshot) {
  return snapshot.events.at(-1)?.payload.kind === "execution-stopped";
}

/** This caller must acquire both start and dispatch commits itself. Replays never invoke adapters. */
export async function runQualityActualSimulation(
  store: PlanQualityStore,
  start: ActualLedgerStart,
  options: QualityActualSimulationOptions,
): Promise<QualityActualSimulationResult> {
  let initial: ReturnType<PlanQualityStore["actualStart"]>;
  try {
    initial = store.actualStart(actualLedgerStartSchema.parse(structuredClone(start)));
  } catch {
    throw new StudioError(
      "합성 실행 시작 기록을 확인하지 못했습니다. 자동 재전송하지 않습니다.",
      409,
      "QUALITY_ACTUAL_START_FAILED",
    );
  }
  let current = initial.snapshot;
  const receipt = initial.receipt;
  if (!initial.newlyCommitted || initial.replayed) {
    try {
      current = store.actualGet(current.run.id);
    } catch {
      /* Keep last proven start snapshot. */
    }
    return {
      snapshot: current,
      receipt,
      replayed: true,
      recordingStatus:
        current.state === "completed"
          ? "complete"
          : isStopped(current)
            ? "stopped"
            : "last-confirmed",
      failureCode: null,
    };
  }
  const run = current.run,
    prep = run.preparation,
    id = run.id;
  let recordingFailure = false;
  let lateResponseRecorded = false;
  // A grant exists only in this invocation, is bound to exact bytes, and is consumed before send.
  let grant: { eventDigest: string; request: EngineExecutionTransportRequest } | null = null;
  let pending: EngineExecutionTransportRequest | null = null;
  const apply = (work: () => ReturnType<PlanQualityStore["actualRecordPrepared"]>) => {
    try {
      const result = work();
      if (!result.newlyCommitted || result.replayed) fail();
      current = result.snapshot;
      return result;
    } catch (error) {
      recordingFailure = true;
      throw error;
    }
  };
  function guard() {
    const observed = store.actualGet(id);
    if (
      observed.snapshotDigest !== current.snapshotDigest ||
      observed.run.runDigest !== run.runDigest ||
      getPlanExecutionContract().contractDigest !== prep.engine.contractDigest ||
      store.candidateRegistryGet(prep.scope.version).versionDigest !== prep.scope.versionDigest
    )
      fail();
  }
  function currentEvidence() {
    const now = Date.now();
    for (const evidence of [prep.evidence.price, prep.evidence.tokens]) {
      if (
        !evidence ||
        Date.parse(evidence.authority.reviewedAt) > now ||
        Date.parse(evidence.authority.validFrom) > now ||
        Date.parse(evidence.authority.validUntil) <= now
      )
        fail();
    }
    const budget = prep.evidence.budget;
    if (!budget || Date.parse(budget.observedAt) > now || Date.parse(budget.validUntil) <= now)
      fail();
  }
  function requestMatches(value: EngineExecutionTransportRequest) {
    if (
      value.request.mode !== "mock" ||
      value.request.provider !== "mock" ||
      value.request.configuredModel !== prep.model ||
      value.body.model !== prep.model ||
      value.request.contractDigest !== prep.engine.contractDigest ||
      value.request.requestDigest !== executionDigest(value.body)
    )
      fail();
  }
  try {
    const transport = { ...options.transport },
      tokens = { ...options.tokenAdapter };
    const evidence = prep.evidence.tokens;
    if (
      !evidence ||
      !prep.model ||
      !prep.requestEvidence ||
      transport.provenance !== "synthetic-test" ||
      tokens.provenance !== "synthetic-test" ||
      typeof transport.send !== "function" ||
      typeof tokens.measure !== "function" ||
      transport.model !== prep.model ||
      tokens.model !== prep.model ||
      transport.contractDigest !== prep.engine.contractDigest ||
      tokens.contractDigest !== prep.engine.contractDigest ||
      tokens.evidenceDigest !== digest(evidence) ||
      tokens.tokenizerId !== evidence.tokenizerId ||
      tokens.tokenizerVersion !== evidence.tokenizerVersion
    )
      fail();
    const registry = store.candidateRegistryGet(prep.scope.version);
    const entry = registry.entries.find((item) => item.candidateId === prep.scope.candidateId);
    if (!entry || registry.versionDigest !== prep.scope.versionDigest) fail();
    const input = candidateRegistryModelInput(entry);
    const company = caseSchema.parse({
      id,
      profile: input.profile,
      sources: input.sources,
      analysis: null,
      selectedCandidateId: input.candidate.id,
      plans: [],
      tasks: [],
      stage: "preparing",
      revision: 0,
      createdAt: prep.preparedAt,
      updatedAt: prep.preparedAt,
    });
    const result = await generateObservedPlan(company, input.candidate, {
      mode: "mock",
      model: prep.model,
      contractDigest: prep.engine.contractDigest,
      beforeRequest: guard,
      transport: async (value) => {
        guard();
        requestMatches(value);
        const owned = grant;
        grant = null;
        if (
          !owned ||
          owned.eventDigest !== current.events.at(-1)?.eventDigest ||
          JSON.stringify(owned.request) !== JSON.stringify(value) ||
          store.actualArtifact(id, `${value.request.phase}-request`).body.toString("utf8") !==
            JSON.stringify(value.body)
        )
          fail();
        const budget = store.actualBudgetGet();
        if (budget.boundBreached || BigInt(budget.deficitUnits) > BigInt(0)) fail();
        currentEvidence();
        return transport.send(immutable(value));
      },
      hooks: {
        onRequestPrepared: async (value) => {
          guard();
          requestMatches(value);
          if (pending || grant) fail();
          const phase = value.request.phase;
          let derivedFrom: { generationEventDigest: string; artifactSha256: string } | null = null;
          let expected: EngineExecutionTransportRequest["body"];
          if (phase === "generation") {
            expected = prep.requestEvidence!.generation.body;
            if (
              store.actualArtifact(id, "generation-request").body.toString("utf8") !==
              JSON.stringify(value.body)
            )
              fail();
          } else {
            const event = current.events.find(
              (item) =>
                item.payload.kind === "domain-validated" && item.payload.phase === "generation",
            );
            const artifact = store.actualArtifact(id, "generation-validated");
            const output = actualLedgerValidatedArtifactSchema.parse(
              JSON.parse(artifact.body.toString("utf8")),
            );
            if (
              !event ||
              event.payload.kind !== "domain-validated" ||
              event.payload.artifactSha256 !== artifact.sha256 ||
              output.kind !== "plan"
            )
              fail();
            expected = deriveActualReviewRequest(run, output);
            derivedFrom = {
              generationEventDigest: event.eventDigest,
              artifactSha256: artifact.sha256,
            };
          }
          if (JSON.stringify(value.body) !== JSON.stringify(expected)) fail();
          const measured = await tokens.measure(immutable(value));
          guard();
          if (
            !Number.isSafeInteger(measured) ||
            measured <= 0 ||
            measured > evidence[phase].inputUpperBound ||
            measured > evidence.maxInputTokens ||
            measured + value.body.max_output_tokens > evidence.contextWindowTokens
          )
            fail();
          const artifact = createActualArtifact({
            runId: id,
            key: `${phase}-request`,
            body: JSON.stringify(value.body),
          });
          const budget = store.actualBudgetGet();
          apply(() =>
            store.actualRecordPrepared(id, {
              clientRequestId: randomUUID(),
              expectedRevision: current.revision,
              ...(phase === "review" ? { artifact } : {}),
              payload: {
                kind: "request-prepared",
                phase,
                requestDigest: value.request.requestDigest,
                artifactSha256: artifact.sha256,
                inputTokenUpperBound: measured,
                derivedFrom,
                budgetRevision: budget.revision,
                budgetDigest: budget.headDigest!,
              },
            }),
          );
          pending = immutable(value);
        },
        onDispatch: (request) => {
          guard();
          if (!pending || JSON.stringify(pending.request) !== JSON.stringify(request)) fail();
          const event = current.events.at(-1);
          if (
            !event ||
            event.payload.kind !== "request-prepared" ||
            event.payload.requestDigest !== request.requestDigest
          )
            fail();
          const budget = store.actualBudgetGet();
          const committed = apply(() =>
            store.actualRecordDispatch(id, {
              clientRequestId: randomUUID(),
              expectedRevision: current.revision,
              payload: {
                kind: "dispatch-intent",
                phase: request.phase,
                requestDigest: request.requestDigest,
                preparedEventDigest: event.eventDigest,
                artifactSha256:
                  event.payload.kind === "request-prepared" ? event.payload.artifactSha256 : "",
                budgetRevision: budget.revision,
                budgetDigest: budget.headDigest!,
              },
            }),
          );
          grant = { eventDigest: committed.snapshot.events.at(-1)!.eventDigest, request: pending };
          pending = null;
        },
        onResponseCaptured: ({ metadata, capturedResponse }) => {
          const event = current.events.at(-1);
          if (
            !event ||
            event.payload.kind !== "dispatch-intent" ||
            event.payload.requestDigest !== metadata.request.requestDigest
          )
            fail();
          const latest = store.actualGet(id);
          const changed = latest.snapshotDigest !== current.snapshotDigest;
          const last = latest.events.at(-1);
          if (
            latest.run.runDigest !== run.runDigest ||
            current.events.some(
              (item, index) => latest.events[index]?.eventDigest !== item.eventDigest,
            ) ||
            (changed &&
              (latest.events.length !== current.events.length + 1 ||
                last?.payload.kind !== "execution-stopped" ||
                last.payload.outcome !== "result-unobserved"))
          )
            fail();
          // A stop while transport awaited revokes further calls, not the duty to
          // preserve the already-dispatched response and its observed usage.
          current = latest;
          const artifact = createActualArtifact({
            runId: id,
            key: `${metadata.request.phase}-response`,
            body: JSON.stringify({ captureKind: "sdk-response-json", response: capturedResponse }),
          });
          apply(() =>
            store.actualRecordResponse(id, {
              clientRequestId: randomUUID(),
              expectedRevision: current.revision,
              artifact,
              payload: {
                kind: "response-received",
                phase: metadata.request.phase,
                requestDigest: metadata.request.requestDigest,
                dispatchEventDigest: event.eventDigest,
                artifactSha256: artifact.sha256,
                metadata,
              },
            }),
          );
          if (changed) {
            lateResponseRecorded = true;
            fail();
          }
          const budget = store.actualBudgetGet();
          if (
            budget.boundBreached ||
            !budget.reservations.find(
              (item) => item.runId === id && item.phase === metadata.request.phase,
            )?.settled
          )
            fail();
        },
        // The captured-response hook owns the one durable response event.
        onResponse: () => {},
        onValidated: (value) => {
          guard();
          const event = current.events.at(-1);
          if (
            !event ||
            event.payload.kind !== "response-received" ||
            event.payload.requestDigest !== value.request.requestDigest
          )
            fail();
          const artifact = createActualArtifact({
            runId: id,
            key: `${value.request.phase}-validated`,
            body: JSON.stringify(value.output),
          });
          apply(() =>
            store.actualRecordValidated(id, {
              clientRequestId: randomUUID(),
              expectedRevision: current.revision,
              artifact,
              payload: {
                kind: "domain-validated",
                phase: value.request.phase,
                requestDigest: value.request.requestDigest,
                responseEventDigest: event.eventDigest,
                artifactSha256: artifact.sha256,
                outputDigest: value.outputDigest,
              },
            }),
          );
        },
      },
    });
    guard();
    const artifact = createActualArtifact({
      runId: id,
      key: "final-result",
      body: JSON.stringify(result),
    });
    apply(() =>
      store.actualRecordFinish(id, {
        clientRequestId: randomUUID(),
        expectedRevision: current.revision,
        artifact,
        payload: {
          kind: "execution-stopped",
          outcome: "completed",
          failureCode: null,
          finalArtifactSha256: artifact.sha256,
        },
      }),
    );
    return {
      snapshot: current,
      receipt,
      replayed: false,
      recordingStatus: "complete",
      failureCode: null,
    };
  } catch (error) {
    const scopeInterrupted =
      error instanceof StudioError && error.code === "QUALITY_ACTUAL_RUNNER_SCOPE_CHANGED";
    grant = null;
    // Never infer whether a failed write committed. Inspect the last durable ledger if available.
    try {
      current = store.actualGet(id);
    } catch {
      return {
        snapshot: current,
        receipt,
        replayed: false,
        recordingStatus: "last-confirmed",
        failureCode: "RECORDING_UNCONFIRMED",
      };
    }
    if (lateResponseRecorded)
      return {
        snapshot: current,
        receipt,
        replayed: false,
        recordingStatus: "last-confirmed",
        failureCode: "LATE_RESPONSE_RECORDED",
      };
    if (isStopped(current))
      return {
        snapshot: current,
        receipt,
        replayed: false,
        recordingStatus: current.state === "completed" ? "complete" : "stopped",
        failureCode: current.state === "completed" ? null : "EXECUTION_STOPPED",
      };
    const dispatches = current.events.filter((item) => item.payload.kind === "dispatch-intent");
    const responses = current.events.filter((item) => item.payload.kind === "response-received");
    const unknown = dispatches.length > responses.length;
    const unsettled = responses.some(
      (item) =>
        item.payload.kind === "response-received" && item.payload.usageBudgetEventDigest === null,
    );
    const payload: ActualFinishInput["payload"] = {
      kind: "execution-stopped",
      finalArtifactSha256: null,
      outcome: unknown
        ? "result-unobserved"
        : unsettled
          ? "needs-cost-review"
          : current.costState === "bound-breached"
            ? "bound-breached"
            : dispatches.length === 0
              ? "before-dispatch"
              : "output-invalid",
      failureCode: unknown
        ? recordingFailure
          ? "STORAGE_FAILED"
          : "INTERRUPTED"
        : unsettled
          ? "COST_UNSETTLED"
          : current.costState === "bound-breached"
            ? "BOUND_BREACHED"
            : recordingFailure
              ? "STORAGE_FAILED"
              : dispatches.length === 0 || scopeInterrupted
                ? "INTERRUPTED"
                : "OUTPUT_INVALID",
    };
    try {
      apply(() =>
        store.actualRecordFinish(id, {
          clientRequestId: randomUUID(),
          expectedRevision: current.revision,
          payload,
        }),
      );
      return {
        snapshot: current,
        receipt,
        replayed: false,
        recordingStatus: "stopped",
        failureCode: payload.failureCode,
      };
    } catch {
      try {
        current = store.actualGet(id);
      } catch {
        /* Last confirmed state remains accurate. */
      }
      return {
        snapshot: current,
        receipt,
        replayed: false,
        recordingStatus: "last-confirmed",
        failureCode: "RECORDING_UNCONFIRMED",
      };
    }
  }
}
