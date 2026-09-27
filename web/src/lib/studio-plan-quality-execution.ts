import { planQualityEvaluationDigest as digest } from "./studio-plan-quality-evaluation";
import { validateCandidateRegistrySnapshot } from "./studio-plan-quality-candidate-registry";
import type { CandidateRegistrySnapshot } from "./studio-plan-quality-candidate-registry-types";
import {
  engineExecutionContractSchema,
  type EngineExecutionContract,
  type EngineExecutionRequest,
} from "./studio-engine-execution-types";
import {
  qualityExecutionPreparationSchema,
  qualityExecutionRunSchema,
  qualityExecutionEventSchema,
  qualityExecutionSnapshotSchema,
  qualityExecutionMockModel,
  qualityExecutionNotice,
  qualityExecutionPreparationDigestInput,
  qualityExecutionRunDigestInput,
  qualityExecutionEventDigestInput,
  qualityExecutionSnapshotDigestInput,
  qualityExecutionRequestDigestInput,
  type QualityExecutionPreparation,
  type QualityExecutionRun,
  type QualityExecutionEvent,
  type QualityExecutionSnapshot,
} from "./studio-plan-quality-execution-types";

const invalid = (): never => {
  throw new Error("Quality execution binding or event order mismatch");
};
const same = (left: unknown, right: unknown) => digest(left) === digest(right);
export function createQualityExecutionPreparation(
  registry: CandidateRegistrySnapshot,
  candidateId: string,
  contract: EngineExecutionContract,
  expectedRunCount: number,
): QualityExecutionPreparation {
  const archived = validateCandidateRegistrySnapshot(registry);
  const entry = archived.entries.find((item) => item.candidateId === candidateId);
  const manifest = archived.manifest.find((item) => item.candidateId === candidateId);
  if (!entry || !manifest) return invalid();
  const engine = engineExecutionContractSchema.parse(contract);
  const { contractDigest, ...engineBody } = engine;
  if (
    digest(engineBody) !== contractDigest ||
    engine.phases[0].phase !== "generation" ||
    engine.phases[1].phase !== "review"
  )
    return invalid();
  const payload: Omit<QualityExecutionPreparation, "planDigest"> = {
    schemaVersion: 1,
    kind: "mock-candidate-execution",
    mode: "mock",
    provider: "mock",
    model: qualityExecutionMockModel,
    destination: "local-mock-transport",
    setId: archived.setId,
    version: archived.version,
    versionDigest: archived.versionDigest,
    registrySourceDigest: archived.sourceDigest,
    manifestDigest: archived.manifestDigest,
    candidateId,
    label: entry.label,
    sourceDigest: manifest.sourceDigest,
    candidateDigest: manifest.candidateDigest,
    modelInputDigest: manifest.modelInputDigest,
    engine,
    expectedRunCount,
    purpose: "synthetic-candidate-generation-and-review",
    cost: {
      kind: "mock-no-charge",
      actualCharge: 0,
      currency: null,
      priceEvidence: null,
      actualAiAllowed: false,
      actualAiBudget: null,
      inputTokenEstimate: null,
    },
    humanAnswerKey: null,
    independentHoldoutConfirmed: false,
    performanceEvaluation: "not-performed",
    actualExecutionBlockReason:
      "실제 AI 실행의 가격 근거·금액 상한·전송 승인이 준비되지 않아 실행할 수 없습니다.",
  };
  return qualityExecutionPreparationSchema.parse({
    ...payload,
    planDigest: digest(qualityExecutionPreparationDigestInput(payload)),
  });
}

export function validateQualityExecutionPreparation(
  value: unknown,
  registry: CandidateRegistrySnapshot,
) {
  const preparation = qualityExecutionPreparationSchema.parse(value);
  const expected = createQualityExecutionPreparation(
    registry,
    preparation.candidateId,
    preparation.engine,
    preparation.expectedRunCount,
  );
  if (!same(preparation, expected)) return invalid();
  return preparation;
}

/** Validate stored evidence only; does not call the engine or contact any provider. */
export function validateQualityExecutionLedger(
  runValue: unknown,
  eventValues: unknown[],
  registry: CandidateRegistrySnapshot,
): QualityExecutionSnapshot {
  const run = qualityExecutionRunSchema.parse(runValue);
  validateQualityExecutionPreparation(run.preparation, registry);
  if (
    digest(qualityExecutionRunDigestInput(run)) !== run.runDigest ||
    run.inputDigest !==
      digest(
        qualityExecutionRequestDigestInput({
          clientRequestId: run.clientRequestId,
          preparation: run.preparation,
          acknowledgedMockOnly: true,
        }),
      )
  )
    return invalid();
  const events = eventValues.map((value) => qualityExecutionEventSchema.parse(value));
  let request: EngineExecutionRequest | null = null;
  let state: QualityExecutionSnapshot["state"] = "authorized";
  let dispatchCount = 0,
    responseCount = 0,
    validatedCount = 0;
  let responseCompleted = false;
  let plan: QualityExecutionSnapshot["output"]["plan"] = null,
    review: QualityExecutionSnapshot["output"]["review"] = null;
  for (const [index, event] of events.entries()) {
    if (
      event.executionId !== run.id ||
      event.revision !== index + 1 ||
      event.previousEventDigest !== (events[index - 1]?.eventDigest ?? null) ||
      event.eventDigest !== digest(qualityExecutionEventDigestInput(event)) ||
      ["completed", "failed", "unknown"].includes(state)
    )
      return invalid();
    const payload = event.payload;
    if (payload.kind === "dispatch") {
      const next = payload.request;
      if (
        !(
          (dispatchCount === 0 && state === "authorized") ||
          (dispatchCount === 1 && state === "output-validated" && validatedCount === 1)
        ) ||
        next.sequence !== dispatchCount + 1 ||
        next.mode !== "mock" ||
        next.provider !== "mock" ||
        next.configuredModel !== run.preparation.model ||
        next.contractDigest !== run.preparation.engine.contractDigest ||
        next.inputChars > run.preparation.engine.maxInputChars ||
        next.maxOutputTokens !== run.preparation.engine.maxOutputTokens
      )
        return invalid();
      request = next;
      responseCompleted = false;
      dispatchCount++;
      state = "dispatch-recorded";
    } else if (payload.kind === "response") {
      if (state !== "dispatch-recorded" || !request || !same(request, payload.response.request))
        return invalid();
      responseCompleted = payload.response.status === "completed";
      responseCount++;
      state = "response-observed";
    } else if (payload.kind === "validated") {
      if (
        state !== "response-observed" ||
        !responseCompleted ||
        !request ||
        !same(request, payload.validated.request) ||
        digest(payload.validated.output) !== payload.validated.outputDigest
      )
        return invalid();
      const output = payload.validated.output;
      if (output.kind === "plan") plan = output.content;
      else {
        const entry = registry.entries.find(
          (item) => item.candidateId === run.preparation.candidateId,
        )!;
        const sourceIds = new Set([
          "profile",
          ...entry.input.sources
            .filter((source) => source.extraction !== "pending")
            .map((source) => source.id),
        ]);
        const sectionKeys = new Set(plan?.sections.map((section) => section.key));
        if (
          !plan ||
          output.findings.some(
            (finding) =>
              finding.sourceIds.some((id) => !sourceIds.has(id)) ||
              (finding.sectionKey !== null && !sectionKeys.has(finding.sectionKey)),
          )
        )
          return invalid();
        review = output.findings;
      }
      validatedCount++;
      state = "output-validated";
    } else {
      if (payload.outcome === "completed") {
        if (
          state !== "output-validated" ||
          validatedCount !== 2 ||
          !plan ||
          review === null ||
          payload.failureCode !== null
        )
          return invalid();
        const result = payload.result;
        if (
          !result ||
          result.contractDigest !== run.preparation.engine.contractDigest ||
          !same(result.semanticReview, review) ||
          result.content.title !== plan.title ||
          result.content.summary !== plan.summary ||
          result.content.sections.length !== plan.sections.length ||
          result.content.sections.some((section, position) => {
            const original = plan!.sections[position];
            const { needsConfirmation: previousConfirmation, ...previous } = original;
            const { needsConfirmation: currentConfirmation, ...current } = section;
            return (previousConfirmation && !currentConfirmation) || !same(previous, current);
          }) ||
          !result.semanticReview.every((finding) =>
            result.review.some((item) => same(item, finding)),
          )
        )
          return invalid();
        plan = result.content;
        review = result.review;
      } else {
        if (
          payload.result !== null ||
          payload.failureCode === null ||
          (payload.outcome === "unknown") !== (state === "dispatch-recorded")
        )
          return invalid();
      }
      state = payload.outcome;
    }
  }
  const body: Omit<QualityExecutionSnapshot, "snapshotDigest"> = {
    schemaVersion: 1,
    run,
    revision: events.length,
    events,
    state,
    canResume: false,
    dispatchCount,
    responseCount,
    validatedCount,
    actualAiCalls: 0,
    cost: run.preparation.cost,
    output: { plan, review },
    notice: qualityExecutionNotice,
  };
  return qualityExecutionSnapshotSchema.parse({
    ...body,
    snapshotDigest: digest(qualityExecutionSnapshotDigestInput(body)),
  });
}

export function qualityExecutionIsUnsettled(snapshot: QualityExecutionSnapshot) {
  return snapshot.state !== "completed" && snapshot.state !== "failed";
}
export function qualityExecutionCreateRun(input: {
  id: string;
  clientRequestId: string;
  preparation: QualityExecutionPreparation;
  authorizedAt: string;
}): QualityExecutionRun {
  const payload: Omit<QualityExecutionRun, "runDigest"> = {
    ...input,
    inputDigest: digest(
      qualityExecutionRequestDigestInput({
        clientRequestId: input.clientRequestId,
        preparation: input.preparation,
        acknowledgedMockOnly: true,
      }),
    ),
  };
  return qualityExecutionRunSchema.parse({
    ...payload,
    runDigest: digest(qualityExecutionRunDigestInput(payload)),
  });
}
export function qualityExecutionCreateEvent(
  input: Omit<QualityExecutionEvent, "eventDigest">,
): QualityExecutionEvent {
  return qualityExecutionEventSchema.parse({
    ...input,
    eventDigest: digest(qualityExecutionEventDigestInput(input)),
  });
}
