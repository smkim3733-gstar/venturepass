import {
  qualityExecutionPreparationSchema,
  qualityExecutionSnapshotSchema,
  qualityExecutionLookupSchema,
  qualityExecutionListSchema,
  qualityExecutionStartSchema,
  qualityExecutionPreparationDigestInput,
  qualityExecutionRunDigestInput,
  qualityExecutionEventDigestInput,
  qualityExecutionSnapshotDigestInput,
  qualityExecutionRequestDigestInput,
  qualityExecutionDownloadName,
  qualityExecutionLimits,
  type QualityExecutionPreparation,
  type QualityExecutionSnapshot,
  type QualityExecutionStart,
  type QualityExecutionReceipt,
} from "@/lib/studio-plan-quality-execution-types";
import type { CandidateRegistrySnapshot } from "@/lib/studio-plan-quality-candidate-registry-types";
import type { EngineExecutionRequest } from "@/lib/studio-engine-execution-types";
import {
  candidateRegistryDigest as digest,
  candidateRegistryCanonical as canonical,
  candidateRegistrySnapshot,
  candidateRegistryJsonBytes,
} from "./quality-candidate-registry-ui";

export const qualityExecutionBase = "/api/studio/quality/candidate-executions";
export function qualityExecutionCanRetry(
  requestId: string,
  lastNotObservedId: string | null,
  committedId: string | null,
) {
  return requestId === lastNotObservedId && requestId !== committedId;
}
export type QualityExecutionPending = {
  request: QualityExecutionStart;
  registry: CandidateRegistrySnapshot;
};
export const qualityExecutionStateLabels: Record<QualityExecutionSnapshot["state"], string> = {
  authorized: "시작 기록됨 · 진행 확인 필요",
  "dispatch-recorded": "전송 시도 기록됨 · 응답 확인 필요",
  "response-observed": "모의 응답 기록됨 · 검증 확인 필요",
  "output-validated": "단계 검증 기록됨 · 종료 확인 필요",
  completed: "모의 연결 시험 종료",
  failed: "모의 연결 시험 중단",
  unknown: "결과 미확인 · 조회 필요",
};
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
function fail(): never {
  throw new Error(
    "선택한 후보·요청과 실행 기록의 연결을 확인하지 못했습니다. 요청 내용을 보존합니다.",
  );
}
export function qualityExecutionUnsettled(value: QualityExecutionSnapshot) {
  return value.state !== "completed" && value.state !== "failed";
}
export async function qualityExecutionPreparation(
  raw: unknown,
  registry: CandidateRegistrySnapshot,
  candidateId: string,
) {
  const value = qualityExecutionPreparationSchema.parse(raw);
  await candidateRegistrySnapshot(registry, registry);
  const entry = registry.manifest.find((item) => item.candidateId === candidateId);
  const { contractDigest, ...contract } = value.engine;
  if (
    !entry ||
    value.candidateId !== candidateId ||
    value.label !== entry.label ||
    value.version !== registry.version ||
    value.versionDigest !== registry.versionDigest ||
    value.registrySourceDigest !== registry.sourceDigest ||
    value.manifestDigest !== registry.manifestDigest ||
    value.sourceDigest !== entry.sourceDigest ||
    value.candidateDigest !== entry.candidateDigest ||
    value.modelInputDigest !== entry.modelInputDigest ||
    (await digest(contract)) !== contractDigest ||
    (await digest(qualityExecutionPreparationDigestInput(value))) !== value.planDigest
  )
    return fail();
  return value;
}
export function qualityExecutionPending(
  preparation: QualityExecutionPreparation,
  registry: CandidateRegistrySnapshot,
  nonce: string,
): QualityExecutionPending {
  return structuredClone({
    request: qualityExecutionStartSchema.parse({
      clientRequestId: nonce,
      preparation,
      acknowledgedMockOnly: true,
    }),
    registry,
  });
}
async function checkLedger(value: QualityExecutionSnapshot) {
  const run = value.run,
    prep = run.preparation;
  const { contractDigest, ...contract } = prep.engine;
  if (
    (await digest(contract)) !== contractDigest ||
    (await digest(qualityExecutionPreparationDigestInput(prep))) !== prep.planDigest ||
    (await digest(qualityExecutionRunDigestInput(run))) !== run.runDigest ||
    (await digest(
      qualityExecutionRequestDigestInput({
        clientRequestId: run.clientRequestId,
        preparation: prep,
        acknowledgedMockOnly: true,
      }),
    )) !== run.inputDigest ||
    (await digest(qualityExecutionSnapshotDigestInput(value))) !== value.snapshotDigest ||
    !same(value.cost, prep.cost)
  )
    return fail();
  let state: QualityExecutionSnapshot["state"] = "authorized",
    dispatch = 0,
    responses = 0,
    validated = 0;
  let request: EngineExecutionRequest | null = null,
    responseCompleted = false;
  let plan: QualityExecutionSnapshot["output"]["plan"] = null,
    review: QualityExecutionSnapshot["output"]["review"] = null;
  for (const [index, event] of value.events.entries()) {
    if (
      event.executionId !== run.id ||
      event.revision !== index + 1 ||
      event.previousEventDigest !== (value.events[index - 1]?.eventDigest ?? null) ||
      (await digest(qualityExecutionEventDigestInput(event))) !== event.eventDigest ||
      ["completed", "failed", "unknown"].includes(state)
    )
      return fail();
    const payload = event.payload;
    if (payload.kind === "dispatch") {
      const next = payload.request;
      if (
        !(
          (dispatch === 0 && state === "authorized") ||
          (dispatch === 1 && state === "output-validated" && validated === 1)
        ) ||
        next.sequence !== dispatch + 1 ||
        next.mode !== "mock" ||
        next.provider !== "mock" ||
        next.configuredModel !== prep.model ||
        next.contractDigest !== prep.engine.contractDigest ||
        next.inputChars > prep.engine.maxInputChars ||
        next.maxOutputTokens !== prep.engine.maxOutputTokens
      )
        return fail();
      request = next;
      responseCompleted = false;
      dispatch++;
      state = "dispatch-recorded";
    } else if (payload.kind === "response") {
      if (state !== "dispatch-recorded" || !request || !same(request, payload.response.request))
        return fail();
      responseCompleted = payload.response.status === "completed";
      responses++;
      state = "response-observed";
    } else if (payload.kind === "validated") {
      if (
        state !== "response-observed" ||
        !responseCompleted ||
        !request ||
        !same(request, payload.validated.request) ||
        (await digest(payload.validated.output)) !== payload.validated.outputDigest
      )
        return fail();
      if (payload.validated.output.kind === "plan") plan = payload.validated.output.content;
      else review = payload.validated.output.findings;
      validated++;
      state = "output-validated";
    } else {
      if (payload.outcome === "completed") {
        const result = payload.result;
        if (
          state !== "output-validated" ||
          validated !== 2 ||
          !plan ||
          review === null ||
          !result ||
          payload.failureCode !== null ||
          result.contractDigest !== prep.engine.contractDigest ||
          !same(result.semanticReview, review) ||
          result.content.title !== plan.title ||
          result.content.summary !== plan.summary ||
          result.content.sections.length !== plan.sections.length ||
          result.content.sections.some((section, index) => {
            const { needsConfirmation: prior, ...previous } = plan!.sections[index];
            const { needsConfirmation: next, ...current } = section;
            return (prior && !next) || !same(previous, current);
          }) ||
          !result.semanticReview.every((finding) =>
            result.review.some((item) => same(item, finding)),
          )
        )
          return fail();
        plan = result.content;
        review = result.review;
      } else if (
        payload.result !== null ||
        payload.failureCode === null ||
        (payload.outcome === "unknown") !== (state === "dispatch-recorded")
      )
        return fail();
      state = payload.outcome;
    }
  }
  if (
    value.revision !== value.events.length ||
    value.state !== state ||
    value.dispatchCount !== dispatch ||
    value.responseCount !== responses ||
    value.validatedCount !== validated ||
    !same(value.output, { plan, review })
  )
    return fail();
  return value;
}
export async function qualityExecutionList(raw: unknown) {
  const value = qualityExecutionListSchema.parse(raw);
  if (
    new Set(value.executions.map((item) => item.run.id)).size !== value.executions.length ||
    new Set(value.executions.map((item) => item.run.clientRequestId)).size !==
      value.executions.length
  )
    return fail();
  await Promise.all(value.executions.map(checkLedger));
  return value.executions;
}
export async function qualityExecutionSnapshot(
  raw: unknown,
  registry: CandidateRegistrySnapshot,
  expected?: { id: string; revision?: number; snapshotDigest?: string },
) {
  const value = qualityExecutionSnapshotSchema.parse(raw);
  if (
    expected &&
    (value.run.id !== expected.id ||
      (expected.revision !== undefined && value.revision !== expected.revision) ||
      (expected.snapshotDigest !== undefined && value.snapshotDigest !== expected.snapshotDigest))
  )
    return fail();
  await qualityExecutionPreparation(
    value.run.preparation,
    registry,
    value.run.preparation.candidateId,
  );
  await checkLedger(value);
  const entry = registry.entries.find(
    (item) => item.candidateId === value.run.preparation.candidateId,
  )!;
  const sourceIds = new Set([
    "profile",
    ...entry.input.sources
      .filter((source) => source.extraction !== "pending")
      .map((source) => source.id),
  ]);
  for (const event of value.events)
    if (event.payload.kind === "validated" && event.payload.validated.output.kind === "review") {
      if (
        event.payload.validated.output.findings.some(
          (finding) =>
            finding.sourceIds.some((id) => !sourceIds.has(id)) ||
            (finding.sectionKey !== null &&
              !value.output.plan?.sections.some((section) => section.key === finding.sectionKey)),
        )
      )
        return fail();
    }
  return value;
}
export async function qualityExecutionRecovery(raw: unknown, pending: QualityExecutionPending) {
  const result = qualityExecutionLookupSchema.parse(raw);
  if (
    result.state === "committed" &&
    (result.receipt.clientRequestId !== pending.request.clientRequestId ||
      result.receipt.planDigest !== pending.request.preparation.planDigest ||
      result.receipt.inputDigest !==
        (await digest(qualityExecutionRequestDigestInput(pending.request))))
  )
    return fail();
  return result;
}
export async function qualityExecutionCommitted(
  raw: unknown,
  pending: QualityExecutionPending,
  receipt: QualityExecutionReceipt,
) {
  await qualityExecutionRecovery({ state: "committed", receipt }, pending);
  const value = await qualityExecutionSnapshot(raw, pending.registry, { id: receipt.executionId });
  if (
    value.run.clientRequestId !== pending.request.clientRequestId ||
    value.run.runDigest !== receipt.runDigest ||
    value.run.inputDigest !== receipt.inputDigest ||
    !same(value.run.preparation, pending.request.preparation)
  )
    return fail();
  return value;
}
export async function qualityExecutionArchive(
  response: Response,
  snapshot: QualityExecutionSnapshot,
  registry: CandidateRegistrySnapshot,
) {
  const filename = qualityExecutionDownloadName(snapshot.run.id, snapshot.revision);
  const blob = await candidateRegistryJsonBytes(
    response,
    filename,
    qualityExecutionLimits.runBytes +
      (qualityExecutionLimits.events + 2) * qualityExecutionLimits.eventBytes,
  );
  await qualityExecutionSnapshot(JSON.parse(await blob.text()), registry, {
    id: snapshot.run.id,
    revision: snapshot.revision,
    snapshotDigest: snapshot.snapshotDigest,
  });
  return { blob, filename };
}
