import { randomUUID } from "node:crypto";
import { StudioError } from "./studio-http";
import { caseSchema } from "./studio-schema";
import { candidateRegistryModelInput } from "./studio-plan-quality-candidate-registry";
import {
  validateNewProviderPreparation,
  providerDigest,
  providerWireDigest,
} from "./studio-plan-quality-provider-core";
import {
  generateObservedProviderPlan,
  type ProviderObservationPrepared,
} from "./studio-provider-observation";
import {
  createProviderExecutionArtifact,
  deriveProviderExecutionReviewRequest,
  validateProviderExecutionManifest,
} from "../../scripts/local-data-quality-provider-execution.mjs";
import { freezeProviderValue } from "../../scripts/local-data-quality-provider-usage.mjs";
import type {
  ProviderExecutionCommand,
  ProviderExecutionOutput,
} from "./studio-plan-quality-provider-execution-types";
import type { ProviderSnapshot } from "./studio-plan-quality-provider-types";
import type { PlanQualityStore } from "./studio-plan-quality-store";

export type ProviderSimulationOptions = {
  transport: {
    provenance: "synthetic-test";
    model: string;
    contractDigest: string;
    send: (request: ProviderObservationPrepared) => Promise<unknown>;
  };
};
export type ProviderSimulationResult = {
  snapshot: ProviderSnapshot;
  receipt: ReturnType<PlanQualityStore["providerRecordApprove"]>["receipt"];
  replayed: boolean;
  recordingStatus: "complete" | "stopped" | "last-confirmed";
  failureCode: string | null;
};
function fail(): never {
  throw new StudioError(
    "전송 승인과 현재 실행 근거가 달라졌습니다.",
    409,
    "QUALITY_PROVIDER_RUNNER_SCOPE_CHANGED",
  );
}
function immutable<T>(value: T): T {
  return freezeProviderValue(structuredClone(value));
}
function stopped(value: ProviderSnapshot) {
  return value.archiveFormatVersion === 3 && value.terminal;
}

/** The runner itself must acquire approval and dispatch commits. No production transport exists. */
export async function runQualityProviderSimulation(
  store: PlanQualityStore,
  id: string,
  approval: ProviderExecutionCommand<"transmission-approved">,
  options: ProviderSimulationOptions,
): Promise<ProviderSimulationResult> {
  approval = immutable(approval);
  let initial: ReturnType<PlanQualityStore["providerRecordApprove"]>;
  try {
    initial = store.providerRecordApprove(id, structuredClone(approval));
  } catch {
    throw new StudioError(
      "전송 승인 기록을 확인하지 못했습니다. 자동 재전송하지 않습니다.",
      409,
      "QUALITY_PROVIDER_APPROVAL_FAILED",
    );
  }
  let current = initial.snapshot;
  const receipt = initial.receipt;
  if (!initial.newlyCommitted || initial.replayed) {
    try {
      current = store.providerGet(id);
    } catch {
      /* Keep exact committed approval prefix. */
    }
    return {
      snapshot: current,
      receipt,
      replayed: true,
      recordingStatus:
        current.state === "completed"
          ? "complete"
          : stopped(current)
            ? "stopped"
            : "last-confirmed",
      failureCode: null,
    };
  }
  const run = current.run,
    prep = run.preparation;
  let grant: { eventDigest: string; request: ProviderObservationPrepared } | null = null;
  let pending: ProviderObservationPrepared | null = null;
  let recordingFailure = false,
    lateResponseRecorded = false;
  const apply = (work: () => ReturnType<PlanQualityStore["providerRecordPrepared"]>) => {
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
  function currentEvidence() {
    const registry = store.candidateRegistryGet(prep.scope.version);
    try {
      validateNewProviderPreparation(prep, registry, new Date().toISOString());
    } catch {
      // Expired or changed execution evidence interrupts permission to continue;
      // it does not establish that the already captured model output is invalid.
      fail();
    }
    for (const authority of [
      prep.financialBasis.evidence.context?.authority,
      prep.financialBasis.evidence.pricing?.authority,
      prep.retention,
      approval.payload.manifest.executionContract.usagePolicy.authority,
    ])
      if (
        !authority ||
        Date.parse(authority.reviewedAt) > Date.now() ||
        Date.parse(authority.validUntil) <= Date.now()
      )
        fail();
    if (
      Date.parse(approval.payload.approvedAt) > Date.now() ||
      Date.parse(approval.payload.expiresAt) <= Date.now()
    )
      fail();
  }
  function guard() {
    const observed = store.providerGet(id);
    if (
      observed.snapshotDigest !== current.snapshotDigest ||
      observed.run.runDigest !== run.runDigest
    )
      fail();
    currentEvidence();
  }
  function requestMatches(value: ProviderObservationPrepared) {
    if (
      value.request.model !== prep.model ||
      value.body.model !== prep.model ||
      value.request.contractDigest !== approval.payload.manifest.executionContract.contractDigest ||
      value.request.requestDigest !== providerWireDigest(value.body) ||
      JSON.stringify(value.body) !== value.rawBody
    )
      fail();
  }
  try {
    const manifest = validateProviderExecutionManifest(run, approval.payload.manifest),
      transport = { ...options.transport };
    if (
      run.environment !== "synthetic-test" ||
      transport.provenance !== "synthetic-test" ||
      typeof transport.send !== "function" ||
      transport.model !== prep.model ||
      transport.contractDigest !== manifest.executionContract.contractDigest
    )
      fail();
    const registry = store.candidateRegistryGet(prep.scope.version),
      entry = registry.entries.find((v) => v.candidateId === prep.scope.candidateId);
    if (!entry || registry.versionDigest !== prep.scope.versionDigest) fail();
    const source = candidateRegistryModelInput(entry);
    const company = caseSchema.parse({
      id,
      profile: source.profile,
      sources: source.sources,
      analysis: null,
      selectedCandidateId: source.candidate.id,
      plans: [],
      tasks: [],
      stage: "preparing",
      revision: 0,
      createdAt: prep.preparedAt,
      updatedAt: prep.preparedAt,
    });
    const result = await generateObservedProviderPlan(company, source.candidate, {
      preparation: prep,
      generationRequestBody: store.providerArtifact(id).body.toString("utf8"),
      executionContractDigest: manifest.executionContract.contractDigest,
      usagePolicy: manifest.executionContract.usagePolicy,
      beforeRequest: guard,
      transport: {
        provenance: "synthetic-test",
        send: async (value) => {
          guard();
          requestMatches(value);
          const owned = grant;
          grant = null;
          if (
            !owned ||
            owned.eventDigest !== current.events.at(-1)?.eventDigest ||
            JSON.stringify(owned.request) !== JSON.stringify(value) ||
            store.providerArtifact(id, `${value.request.phase}-request`).body.toString("utf8") !==
              value.rawBody
          )
            fail();
          const budget = store.providerBudgetGet();
          if (
            "boundBreached" in budget &&
            (budget.boundBreached || BigInt(budget.deficitUnits) > BigInt(0))
          )
            fail();
          currentEvidence();
          return transport.send(immutable(value));
        },
      },
      hooks: {
        onRequestPrepared: (value) => {
          guard();
          requestMatches(value);
          if (pending || grant) fail();
          const phase = value.request.phase;
          let derivedFrom: {
            generationEventDigest: string;
            artifactSha256: string;
            outputDigest: string;
          } | null = null;
          if (phase === "generation") {
            if (store.providerArtifact(id).body.toString("utf8") !== value.rawBody) fail();
          } else {
            const event = current.events.find(
              (v) => v.payload.kind === "domain-validated" && v.payload.phase === "generation",
            );
            const artifact = store.providerArtifact(id, "generation-validated"),
              output = JSON.parse(artifact.body.toString("utf8")) as ProviderExecutionOutput;
            if (
              !event ||
              event.payload.kind !== "domain-validated" ||
              event.payload.artifactSha256 !== artifact.sha256 ||
              output.kind !== "plan" ||
              event.payload.outputDigest !== providerDigest(output)
            )
              fail();
            if (JSON.stringify(deriveProviderExecutionReviewRequest(run, output)) !== value.rawBody)
              fail();
            derivedFrom = {
              generationEventDigest: event.eventDigest,
              artifactSha256: artifact.sha256,
              outputDigest: event.payload.outputDigest,
            };
          }
          const artifact = createProviderExecutionArtifact({
              runId: id,
              key: `${phase}-request`,
              body: value.rawBody,
            }),
            budget = store.providerBudgetGet();
          apply(() =>
            store.providerRecordPrepared(id, {
              clientRequestId: randomUUID(),
              expectedRevision: current.revision,
              ...(phase === "review" ? { artifact } : {}),
              payload: {
                kind: "request-prepared",
                phase,
                requestDigest: value.request.requestDigest,
                artifactSha256: artifact.sha256,
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
          const event = current.events.at(-1),
            approved = current.events.find((v) => v.payload.kind === "transmission-approved");
          if (
            !event ||
            event.payload.kind !== "request-prepared" ||
            event.payload.requestDigest !== request.requestDigest ||
            !approved
          )
            fail();
          const budget = store.providerBudgetGet(),
            payload = event.payload;
          const committed = apply(() =>
            store.providerRecordDispatch(id, {
              clientRequestId: randomUUID(),
              expectedRevision: current.revision,
              payload: {
                kind: "dispatch-intent",
                phase: request.phase,
                requestDigest: request.requestDigest,
                preparedEventDigest: event.eventDigest,
                approvalEventDigest: approved.eventDigest,
                artifactSha256: payload.artifactSha256,
                budgetRevision: budget.revision,
                budgetDigest: budget.headDigest!,
              },
            }),
          );
          grant = { eventDigest: committed.snapshot.events.at(-1)!.eventDigest, request: pending };
          pending = null;
        },
        onResponseCaptured: ({ request, metadata, capturedResponse }) => {
          const dispatch = current.events.at(-1);
          if (
            !dispatch ||
            dispatch.payload.kind !== "dispatch-intent" ||
            dispatch.payload.requestDigest !== request.requestDigest
          )
            fail();
          const latest = store.providerGet(id),
            changed = latest.snapshotDigest !== current.snapshotDigest,
            last = latest.events.at(-1);
          if (
            latest.run.runDigest !== run.runDigest ||
            current.events.some(
              (event, index) => latest.events[index]?.eventDigest !== event.eventDigest,
            ) ||
            (changed &&
              (latest.events.length !== current.events.length + 1 ||
                last?.payload.kind !== "execution-stopped" ||
                last.payload.outcome !== "result-unobserved"))
          )
            fail();
          current = latest;
          const artifact = createProviderExecutionArtifact({
            runId: id,
            key: `${request.phase}-response`,
            body: JSON.stringify({
              captureKind: "sdk-response-json-v2",
              response: capturedResponse,
            }),
          });
          apply(() =>
            store.providerRecordResponse(id, {
              clientRequestId: randomUUID(),
              expectedRevision: current.revision,
              artifact,
              payload: {
                kind: "response-received",
                phase: request.phase,
                requestDigest: request.requestDigest,
                dispatchEventDigest: dispatch.eventDigest,
                artifactSha256: artifact.sha256,
                metadata,
              },
            }),
          );
          if (changed) {
            lateResponseRecorded = true;
            fail();
          }
          const response = current.events.at(-1),
            budget = store.providerBudgetGet();
          if (
            response?.payload.kind !== "response-received" ||
            response.payload.usageAssessment.status !== "known" ||
            ("boundBreached" in budget && budget.boundBreached)
          )
            fail();
        },
        onValidated: (value) => {
          guard();
          const response = current.events.at(-1);
          if (
            !response ||
            response.payload.kind !== "response-received" ||
            response.payload.requestDigest !== value.request.requestDigest
          )
            fail();
          const artifact = createProviderExecutionArtifact({
            runId: id,
            key: `${value.request.phase}-validated`,
            body: JSON.stringify(value.output),
          });
          apply(() =>
            store.providerRecordValidated(id, {
              clientRequestId: randomUUID(),
              expectedRevision: current.revision,
              artifact,
              payload: {
                kind: "domain-validated",
                phase: value.request.phase,
                requestDigest: value.request.requestDigest,
                responseEventDigest: response.eventDigest,
                artifactSha256: artifact.sha256,
                outputDigest: value.outputDigest,
              },
            }),
          );
        },
      },
    });
    guard();
    const artifact = createProviderExecutionArtifact({
      runId: id,
      key: "final-result",
      body: JSON.stringify(result),
    });
    apply(() =>
      store.providerRecordFinish(id, {
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
    grant = null;
    try {
      current = store.providerGet(id);
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
    if (stopped(current))
      return {
        snapshot: current,
        receipt,
        replayed: false,
        recordingStatus: current.state === "completed" ? "complete" : "stopped",
        failureCode: current.state === "completed" ? null : "EXECUTION_STOPPED",
      };
    const dispatches = current.events.filter((v) => v.payload.kind === "dispatch-intent"),
      responses = current.events.filter((v) => v.payload.kind === "response-received");
    const unknown = dispatches.length > responses.length,
      unsettled = responses.some(
        (v) =>
          v.payload.kind === "response-received" && v.payload.usageAssessment.status !== "known",
      );
    let budget: ReturnType<PlanQualityStore["providerBudgetGet"]>;
    try {
      budget = store.providerBudgetGet();
    } catch {
      return {
        snapshot: current,
        receipt,
        replayed: false,
        recordingStatus: "last-confirmed",
        failureCode: "RECORDING_UNCONFIRMED",
      };
    }
    const bound = "boundBreached" in budget && budget.boundBreached;
    const payload: ProviderExecutionCommand<"execution-stopped">["payload"] = {
      kind: "execution-stopped",
      finalArtifactSha256: null,
      outcome: unknown
        ? "result-unobserved"
        : unsettled
          ? "needs-cost-review"
          : bound
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
          : bound
            ? "BOUND_BREACHED"
            : recordingFailure
              ? "STORAGE_FAILED"
              : dispatches.length === 0 || error instanceof StudioError
                ? "INTERRUPTED"
                : "OUTPUT_INVALID",
    };
    try {
      apply(() =>
        store.providerRecordFinish(id, {
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
        current = store.providerGet(id);
      } catch {
        /* Preserve last proven prefix. */
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
