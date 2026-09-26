import "server-only";
import { StudioError } from "./studio-http";
import type { StudioStore } from "./studio-storage";
import {
  sourceIntakeCommandSchema,
  sourceIntakeOriginalInputSchema,
  type SourceIntakeCommand,
  type SourceIntakeOriginalInput,
  type SourceIntakeResponse,
  type SourceIntakeStatus,
  type SourceIntakeAttemptBinding,
} from "./studio-source-intake-types";
import { extractLocalIntake, LocalIntakeExtractionError } from "./studio-source-intake-extract";
import { assertVentureCompanyWritable } from "./venturein-input-lock";
import { getAiStatus } from "./studio-engine";
import { extractExternalIntake } from "./studio-source-intake-external";
import { externalIntakeRequestDigest } from "./studio-source-intake-external-core";
import { intakeReplay, intakeResponse } from "./studio-source-intake";
import {
  sourceIntakeExternalApprovalPreviewInputSchema,
  sourceIntakeExternalConfiguration,
  type RunExternalSourceIntakeCommand,
  type SourceIntakeExternalEngine,
  type SourceIntakeExternalApprovalPreviewInput,
} from "./studio-source-intake-external-types";

const shared = globalThis as typeof globalThis & {
  __venturepassSourceIntakeJobs?: Map<string, string | null>;
};
const jobs = (shared.__venturepassSourceIntakeJobs ??= new Map<string, string | null>());
export class SourceIntakeRequestError extends StudioError {
  constructor(
    code: string,
    status: number,
    public accepted: boolean,
  ) {
    super(
      "접수 상태와 최신 기업 버전을 확인해 주세요. 보관된 원본과 완료 결과는 유지합니다.",
      status,
      code,
    );
  }
}
export function sourceIntakeStatus(store: StudioStore, caseId: string): SourceIntakeStatus {
  const active = jobs.get(caseId);
  return { company: store.get(caseId), activeItemIds: active ? [active] : [] };
}
function externalConfiguration(engine: SourceIntakeExternalEngine) {
  const status = getAiStatus();
  if (!status.aiConfigured)
    throw new StudioError(
      "외부 처리용 API 키가 설정되지 않았습니다.",
      503,
      "INTAKE_AI_NOT_CONFIGURED",
    );
  return sourceIntakeExternalConfiguration(
    engine,
    engine === "ai-document"
      ? status.model
      : process.env.OPENAI_TRANSCRIBE_MODEL?.trim() || "gpt-4o-mini-transcribe",
  );
}
/** Read-only review of the exact bytes and current server destination/model. */
export function previewSourceIntakeExternal(
  store: StudioStore,
  caseId: string,
  raw: SourceIntakeExternalApprovalPreviewInput,
) {
  const input = sourceIntakeExternalApprovalPreviewInputSchema.parse(raw);
  if (jobs.has(caseId)) throw new StudioError("접수 작업이 진행 중입니다.", 409, "INTAKE_BUSY");
  assertVentureCompanyWritable(caseId);
  return store.previewSourceIntakeExternal(caseId, input, externalConfiguration(input.engine));
}

async function runExternal(
  store: StudioStore,
  caseId: string,
  input: RunExternalSourceIntakeCommand,
): Promise<SourceIntakeResponse> {
  const company = store.get(caseId);
  // A saved request is returned before reading keys/configuration/originals or constructing an SDK.
  const replay = intakeReplay(company, input.clientRequestId, externalIntakeRequestDigest(input));
  if (replay) return intakeResponse(company, replay.id);
  const configuration = externalConfiguration(input.approval.engine);
  const preview = store.previewSourceIntakeExternal(
    caseId,
    {
      revision: input.revision,
      itemId: input.itemId,
      expectedItemVersion: input.expectedItemVersion,
      engine: input.approval.engine,
    },
    configuration,
  );
  if (JSON.stringify(preview.approval) !== JSON.stringify(input.approval))
    throw new StudioError(
      "승인할 원본과 처리 설정을 다시 확인해 주세요.",
      409,
      "INTAKE_EXTERNAL_APPROVAL_STALE",
    );
  if (preview.requiresDuplicateAcknowledgement && !input.acknowledgePossibleDuplicate)
    throw new StudioError(
      "중복 처리·비용 가능성을 확인해 주세요.",
      409,
      "INTAKE_EXTERNAL_DUPLICATE_ACK_REQUIRED",
    );
  const original = store.originalForVentureInput(caseId, input.approval.sourceId);
  const state: { binding: SourceIntakeAttemptBinding | null; replay: SourceIntakeResponse | null } =
    {
      binding: null,
      replay: null,
    };
  let result: Awaited<ReturnType<typeof extractExternalIntake>>;
  try {
    result = await extractExternalIntake(
      {
        engine: configuration.engine,
        model: configuration.model,
        originalName: input.approval.originalName,
        mimeType: input.approval.mimeType,
        originalSha256: input.approval.originalSha256,
        buffer: original.buffer,
      },
      () => {
        assertVentureCompanyWritable(caseId);
        const begin = store.beginSourceIntakeExternalAttempt(caseId, input, configuration);
        if (!begin.started) {
          state.replay = begin.response;
          throw new Error("Durable request already exists");
        }
        const current = begin.response.item;
        if (!current || !begin.attemptId)
          throw new StudioError("외부 요청 기록을 확인해 주세요.", 409, "INTAKE_ATTEMPT_CHANGED");
        state.binding = {
          revision: begin.response.company.revision,
          itemId: current.id,
          itemVersion: current.version,
          attemptId: begin.attemptId,
        };
      },
    );
  } catch (error) {
    if (state.replay) return state.replay;
    if (!state.binding) throw error;
    return store.finishSourceIntakeExternalAttempt(caseId, state.binding, {
      status: "unknown",
      code: "INTAKE_EXTERNAL_RESULT_UNKNOWN",
    });
  }
  if (!state.binding)
    throw new StudioError("외부 요청 기록을 확인해 주세요.", 409, "INTAKE_ATTEMPT_CHANGED");
  // A failed/late final commit stays uncertain. Never send again or overwrite a newer version.
  return store.finishSourceIntakeExternalAttempt(caseId, state.binding, {
    status: "completed",
    ...result,
  });
}
function accepted(store: StudioStore, caseId: string, nonce: string): boolean {
  try {
    return store
      .get(caseId)
      .sourceIntakes.some((item) =>
        item.requests.some((request) => request.clientRequestId === nonce),
      );
  } catch {
    return true;
  } // Unreadable acknowledgment is uncertain, never a safe new-request signal.
}
async function withJob(
  store: StudioStore,
  caseId: string,
  nonce: string,
  itemId: string | null,
  work: () => Promise<SourceIntakeResponse> | SourceIntakeResponse,
): Promise<SourceIntakeResponse> {
  if (jobs.has(caseId))
    throw new SourceIntakeRequestError("INTAKE_BUSY", 409, accepted(store, caseId, nonce));
  jobs.set(caseId, itemId);
  try {
    assertVentureCompanyWritable(caseId);
    return await work();
  } catch (error) {
    throw new SourceIntakeRequestError(
      error instanceof StudioError ? error.code : "INTAKE_FAILED",
      error instanceof StudioError ? error.status : 500,
      accepted(store, caseId, nonce),
    );
  } finally {
    jobs.delete(caseId);
  }
}

/** Explicit commands only; a saved attempt is never transmitted again on a nonce replay. */
export async function runSourceIntakeCommand(
  store: StudioStore,
  caseId: string,
  rawInput: SourceIntakeCommand,
): Promise<SourceIntakeResponse> {
  const input = sourceIntakeCommandSchema.parse(rawInput);
  return withJob(
    store,
    caseId,
    input.clientRequestId,
    "itemId" in input ? input.itemId : null,
    async () => {
      if (input.action === "create") return store.createSourceIntakeBatch(caseId, input);
      if (input.action === "adopt") return store.adoptSourceIntakeResult(caseId, input);
      if (input.action === "discard-result") return store.discardSourceIntakeResult(caseId, input);
      if (input.action === "cancel-awaiting-original")
        return store.cancelSourceIntakeItem(caseId, input);
      if (input.action === "run-external") return runExternal(store, caseId, input);
      const company = store.get(caseId);
      const matches = company.sourceIntakes.filter((item) => item.id === input.itemId);
      if (matches.length !== 1)
        throw new StudioError("접수 항목을 찾을 수 없습니다.", 404, "INTAKE_NOT_FOUND");
      const item = matches[0];
      if (
        input.action === "resume" &&
        (item.attempts.at(-1)?.externalRequestStarted ||
          ["requesting_external", "external_result_unknown"].includes(item.phase))
      )
        return store.resumeSourceIntakeExternal(caseId, input);
      if (
        input.action === "resume" &&
        ["awaiting_original", "storing_original"].includes(item.phase)
      )
        return store.resumeSourceIntakeOriginal(caseId, input);
      const engine =
        input.action === "run-next"
          ? input.engine
          : (item.attempts.at(-1)?.engine ?? "local-document");
      if (engine !== "local-document" && engine !== "windows-ko")
        throw new StudioError(
          "외부 요청의 저장 상태를 먼저 확인해 주세요.",
          409,
          "INTAKE_EXTERNAL_RECOVERY_REQUIRED",
        );
      const begin = store.beginSourceIntakeAttempt(caseId, input, engine);
      if (!begin.started) return begin.response;
      const current = begin.response.item;
      if (!current || !begin.attemptId)
        throw new StudioError("추출 시작 기록을 확인해 주세요.", 409, "INTAKE_ATTEMPT_CHANGED");
      const binding = {
        revision: begin.response.company.revision,
        itemId: current.id,
        itemVersion: current.version,
        attemptId: begin.attemptId,
      };
      const original = store.originalForVentureInput(caseId, current.sourceId);
      assertVentureCompanyWritable(caseId);
      if (
        !current.original ||
        original.sha256 !== current.original.sha256 ||
        original.source.updatedAt !== current.original.sourceUpdatedAt ||
        original.buffer.length !== current.original.sizeBytes ||
        original.source.originalName !== current.original.originalName ||
        original.source.mimeType !== current.original.mimeType
      )
        throw new StudioError("보관 원본이 변경되었습니다.", 409, "INTAKE_ORIGINAL_CHANGED");
      let result;
      try {
        result = await extractLocalIntake(
          {
            name: current.original.originalName,
            mimeType: current.original.mimeType,
            buffer: original.buffer,
          },
          engine,
        );
      } catch (error) {
        return store.finishSourceIntakeAttempt(caseId, binding, {
          status: "failed",
          code:
            error instanceof LocalIntakeExtractionError ? error.code : "INTAKE_EXTRACTION_FAILED",
          phase: error instanceof LocalIntakeExtractionError ? error.phase : "retryable_failure",
        });
      }
      // Store re-reads original bytes and checks full item/attempt/source/CAS before commit.
      return store.finishSourceIntakeAttempt(caseId, binding, { status: "completed", ...result });
    },
  );
}

export async function uploadSourceIntakeOriginal(
  store: StudioStore,
  caseId: string,
  itemId: string,
  rawInput: SourceIntakeOriginalInput,
  original: { name: string; mimeType: string | null; buffer: Buffer },
): Promise<SourceIntakeResponse> {
  const input = sourceIntakeOriginalInputSchema.parse(rawInput);
  return withJob(store, caseId, input.clientRequestId, itemId, () =>
    store.storeSourceIntakeOriginal(caseId, itemId, input, original),
  );
}
