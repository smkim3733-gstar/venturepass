import { caseSchema } from "./studio-schema";
import {
  generateObservedPlan,
  generatePlan,
  getPlanExecutionContract,
  StudioEngineError,
} from "./studio-engine";
import type { EngineExecutionTransportRequest } from "./studio-engine-execution-types";
import { candidateRegistryModelInput } from "./studio-plan-quality-candidate-registry";
import {
  qualityExecutionMockModel,
  type QualityExecutionEventPayload,
  type QualityExecutionSnapshot,
} from "./studio-plan-quality-execution-types";
import type { PlanQualityStore } from "./studio-plan-quality-store";
import { StudioError } from "./studio-http";

/** Called only after a new start receipt commits. Never called for nonce replays. */
export async function runQualityMockExecution(
  store: PlanQualityStore,
  initial: QualityExecutionSnapshot,
  testTransport?: (request: EngineExecutionTransportRequest) => Promise<unknown>,
) {
  if (
    initial.revision !== 0 ||
    initial.state !== "authorized" ||
    initial.run.preparation.mode !== "mock"
  )
    throw new StudioError(
      "이미 시작한 모의 실행은 다시 호출할 수 없습니다.",
      409,
      "QUALITY_EXECUTION_REPLAY",
    );
  let current = initial;
  let recordingFailure = false;
  function append(payload: QualityExecutionEventPayload) {
    try {
      current = store.executionAppend(current.run.id, current.revision, payload);
    } catch (error) {
      recordingFailure = true;
      throw error;
    }
  }
  try {
    const prep = initial.run.preparation;
    const registered = store.candidateRegistryGet(prep.version);
    if (registered.versionDigest !== prep.versionDigest)
      throw new StudioError(
        "등록 후보 원문 연결이 달라졌습니다.",
        409,
        "QUALITY_EXECUTION_SCOPE_CHANGED",
      );
    const entry = registered.entries.find((value) => value.candidateId === prep.candidateId);
    if (!entry)
      throw new StudioError(
        "등록 후보를 찾을 수 없습니다.",
        404,
        "QUALITY_EXECUTION_CANDIDATE_NOT_FOUND",
      );
    const input = candidateRegistryModelInput(entry);
    // In-memory engine context only. No StudioStore, company row, or customer case is opened.
    const company = caseSchema.parse({
      id: initial.run.id,
      profile: input.profile,
      sources: input.sources,
      analysis: null,
      selectedCandidateId: input.candidate.id,
      plans: [],
      tasks: [],
      stage: "preparing",
      revision: 0,
      createdAt: initial.run.authorizedAt,
      updatedAt: initial.run.authorizedAt,
    });
    const mockPlan = await generatePlan(company, input.candidate, "assisted");
    mockPlan.summary = `[로컬 모의 연결 시험 · 제출용 원고 아님] ${mockPlan.summary}`;
    const transport =
      testTransport ??
      (async ({ request }: EngineExecutionTransportRequest) => ({
        id: `mock-${initial.run.id}-${request.sequence}`,
        _request_id: `mock-request-${initial.run.id}-${request.sequence}`,
        model: qualityExecutionMockModel,
        status: "completed",
        usage: null,
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: JSON.stringify(request.phase === "generation" ? mockPlan : { findings: [] }),
              },
            ],
          },
        ],
      }));
    const result = await generateObservedPlan(company, input.candidate, {
      mode: "mock",
      model: qualityExecutionMockModel,
      contractDigest: prep.engine.contractDigest,
      transport,
      beforeRequest: () => {
        if (
          getPlanExecutionContract().contractDigest !== prep.engine.contractDigest ||
          store.executionGet(initial.run.id).revision !== current.revision
        )
          throw new StudioError(
            "모의 실행의 현재 기록 또는 엔진이 달라졌습니다.",
            409,
            "QUALITY_EXECUTION_SCOPE_CHANGED",
          );
      },
      hooks: {
        onDispatch: (request) => append({ kind: "dispatch", request }),
        onResponse: (response) => append({ kind: "response", response }),
        onValidated: (validated) => append({ kind: "validated", validated }),
      },
    });
    append({ kind: "finished", outcome: "completed", failureCode: null, result });
  } catch (error) {
    // Preserve the last durable record if even failure recording is unavailable.
    const unknown = current.dispatchCount > current.responseCount;
    const invalidOutput =
      error instanceof StudioEngineError &&
      [
        "AI_INVALID_OUTPUT",
        "AI_INVALID_PLAN",
        "AI_INVALID_REVIEW",
        "AI_INVALID_EVIDENCE",
        "AI_INVALID_CLAIM",
        "AI_INCOMPLETE",
      ].includes(error.code);
    append({
      kind: "finished",
      outcome: unknown ? "unknown" : "failed",
      result: null,
      failureCode:
        recordingFailure && unknown
          ? "RESPONSE_UNRECORDED"
          : invalidOutput
            ? "OUTPUT_INVALID"
            : "ENGINE_FAILED",
    });
  }
  return current;
}
