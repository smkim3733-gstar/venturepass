import "server-only";
import { z, ZodError } from "zod";
import { assertLocalRequest, jsonResponse, readBoundedBody, StudioError } from "./studio-http";
import { getPlanQualityStore } from "./studio-plan-quality-store";
import {
  providerTransmissionApprovalHttpLimits,
  providerTransmissionApprovalInputSchema,
  providerTransmissionApprovalResponseSchema,
  type ProviderTransmissionApprovalResponse,
} from "./studio-plan-quality-provider-transmission-approval-http-types";
import { providerTransmissionApprovalBindingSchema } from "./studio-plan-quality-provider-transmission-approval-types";
import { providerTransmissionReviewDigestInput } from "./studio-plan-quality-provider-transmission-review-types";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import {
  createProviderExecutionEvent,
  providerExecutionOperationDigest,
} from "../../scripts/local-data-quality-provider-execution.mjs";
import type { ProviderExecutionCommand } from "./studio-plan-quality-provider-execution-types";

// Only audited pre-write refusals. Storage/audit/COMMIT/response failures remain unknown.
const commandRefusals = new Set(
  [
    "INVALID_INPUT",
    "SELECTION_CHANGED",
    "NONCE_CONFLICT",
    "REVIEW_NOT_CURRENT",
    "APPROVAL_BLOCKED",
    "BINDINGS_CHANGED",
    "APPROVAL_TIME_INVALID",
    "CAPACITY_EXCEEDED",
  ].map((reason) => `QUALITY_PROVIDER_TRANSMISSION_${reason}`),
);
const historicalSchema = z
  .object({
    state: z.literal("committed"),
    record: providerTransmissionApprovalBindingSchema,
    dispatchAllowed: z.literal(false),
    budgetWriteAllowed: z.literal(false),
  })
  .strict();
const commitSchema = historicalSchema
  .extend({ newlyCommitted: z.boolean(), replayed: z.boolean() })
  .refine((v) => v.newlyCommitted !== v.replayed, "Invalid approval delivery flags");
const lookupSchema = z.discriminatedUnion("state", [
  historicalSchema,
  z.object({ state: z.literal("not-observed") }).strict(),
]);
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
function reply(value: ProviderTransmissionApprovalResponse, status = 200) {
  return jsonResponse(providerTransmissionApprovalResponseSchema.parse(value), status);
}
function committed(
  record: z.infer<typeof providerTransmissionApprovalBindingSchema>,
  delivery: "new" | "replay" | "lookup",
  clientRequestId: string,
  expectedCommandDigest?: string,
) {
  // Output consistency, not archive authentication. The store already audited the full DB.
  // Reconstruct only the original native approval from frozen fields: no current clock/config/IO.
  const { recordDigest, ...body } = record,
    command = record.command,
    review = record.approvedReview;
  const approvedAt = Date.parse(command.approval.approvedAt),
    recordedAt = Date.parse(record.recordedAt);
  if (
    record.clientRequestId !== clientRequestId ||
    command.clientRequestId !== clientRequestId ||
    record.commandDigest !== digest(command) ||
    recordDigest !== digest(body) ||
    review.reviewDigest !== digest(providerTransmissionReviewDigestInput(review)) ||
    command.approvedReviewDigest !== review.reviewDigest ||
    (expectedCommandDigest !== undefined && record.commandDigest !== expectedCommandDigest) ||
    record.runId !== command.runId ||
    record.runId !== review.run.id ||
    record.runDigest !== command.runDigest ||
    record.runDigest !== review.run.runDigest ||
    command.expectedArchiveDigest !== review.archiveDigest ||
    command.expectedCoverageDigest !== review.coverageDigest ||
    command.expectedReservationBindingDigest !== review.reservation.bindingDigest ||
    command.expectedManifestDigest !== review.manifest.manifestDigest ||
    !same(command.expectedRun, {
      revision: review.run.revision,
      snapshotDigest: review.run.snapshotDigest,
    }) ||
    !same(command.expectedPolicyHead, review.policy.head) ||
    !same(command.expectedPolicyReference, review.policy.reservedReference) ||
    !same(command.expectedPolicyReference, review.policy.currentReference) ||
    !same(command.expectedBudgetHead, {
      revision: review.budget.revision,
      headDigest: review.budget.headDigest,
    }) ||
    command.approval.acknowledgedRetentionNoticeDigest !== digest(review.retention) ||
    review.assessment.state !== "conditions-met" ||
    approvedAt < Date.parse(review.inspectedAt) ||
    approvedAt > recordedAt ||
    recordedAt >= Date.parse(review.expiresAt)
  )
    throw new Error("Approval response identity mismatch");
  const execution: ProviderExecutionCommand<"transmission-approved"> = {
    clientRequestId,
    expectedRevision: 0,
    payload: {
      kind: "transmission-approved",
      manifest: review.manifest,
      provenance: "explicit-user",
      approvedAt: command.approval.approvedAt,
      expiresAt: review.expiresAt,
      acknowledgedExternalTransmission: true,
      acknowledgedGenerationAndDerivedReview: true,
      acknowledgedRetentionNoticeDigest: command.approval.acknowledgedRetentionNoticeDigest,
      acknowledgedFinancialReservationNotTokenFit: true,
      acknowledgedUnknownCostHoldAndNoRetry: true,
      budgetRevision: command.expectedBudgetHead.revision,
      budgetDigest: command.expectedBudgetHead.headDigest,
    },
  };
  const event = createProviderExecutionEvent({
    schemaVersion: 2,
    executionContractVersion: 1,
    runId: record.runId,
    revision: 1,
    budgetRevision: command.expectedBudgetHead.revision,
    previousEventDigest: null,
    recordedAt: record.recordedAt,
    payload: execution.payload,
  });
  if (
    record.executionInputDigest !== providerExecutionOperationDigest(record.runId, execution) ||
    record.approvalEventDigest !== event.eventDigest
  )
    throw new Error("Native approval identity mismatch");
  return reply({
    responseVersion: 1,
    state: "committed",
    delivery,
    receipt: {
      clientRequestId,
      commandDigest: record.commandDigest,
      recordDigest,
      approvedReviewDigest: review.reviewDigest,
      runId: record.runId,
      runDigest: record.runDigest,
      executionInputDigest: record.executionInputDigest,
      approvalEventDigest: record.approvalEventDigest,
      approvalRevision: record.approvalRevision,
      recordedAt: record.recordedAt,
      dispatchAllowed: false,
      budgetWriteAllowed: false,
    },
  });
}

/** Separate explicit approval only. Never invokes provider/runner or a second evidence read. */
export async function qualityProviderTransmissionApprovalRoute(
  request: Request,
  operation: "approve" | "lookup",
  params: { clientRequestId?: string } = {},
) {
  let readingInput = true,
    stored = false;
  let clientRequestId: string | null = null;
  try {
    assertLocalRequest(request);
    const method = operation === "approve" ? "POST" : "GET";
    if (request.method !== method) {
      const response = reply(
        {
          responseVersion: 1,
          state: "refused",
          clientRequestId,
          error: "지원하지 않는 요청 방식입니다.",
          code: "METHOD_NOT_ALLOWED",
        },
        405,
      );
      response.headers.set("Allow", method);
      return response;
    }
    if (new URL(request.url).search)
      throw new StudioError("URL 매개변수는 지원하지 않습니다.", 400, "INVALID_QUERY");
    if (operation === "lookup") {
      clientRequestId = z.string().uuid().parse(params.clientRequestId);
      readingInput = false;
      const result = lookupSchema.parse(
        getPlanQualityStore().providerTransmissionApprovalLookup(clientRequestId),
      );
      if (result.state === "committed") return committed(result.record, "lookup", clientRequestId);
      return reply({
        responseVersion: 1,
        state: "not-observed",
        clientRequestId,
        recovery: "replay-original-request",
      });
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? ""))
      throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
    const input = providerTransmissionApprovalInputSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await readBoundedBody(request, providerTransmissionApprovalHttpLimits.bodyBytes),
        ),
      ),
    );
    clientRequestId = input.command.clientRequestId;
    const commandDigest = digest(input.command);
    readingInput = false;
    const raw = getPlanQualityStore().providerApproveTransmission(
      input.command,
      input.approvedReview,
    );
    stored = true;
    const result = commitSchema.parse(raw);
    return committed(
      result.record,
      result.replayed ? "replay" : "new",
      clientRequestId,
      commandDigest,
    );
  } catch (error) {
    if (
      error instanceof StudioError &&
      (readingInput || (operation === "approve" && !stored && commandRefusals.has(error.code)))
    )
      return reply(
        {
          responseVersion: 1,
          state: "refused",
          clientRequestId,
          code: error.code,
          error: readingInput
            ? error.message
            : "전송 승인 조건이 변경됐습니다. 검토안을 다시 확인해 주세요.",
        },
        error.status,
      );
    if (readingInput && error instanceof ZodError)
      return reply(
        {
          responseVersion: 1,
          state: "refused",
          clientRequestId,
          code: "INVALID_INPUT",
          error: "전송 승인 명령과 명시적 확인 내용을 확인해 주세요.",
        },
        400,
      );
    if (readingInput && (error instanceof SyntaxError || error instanceof TypeError))
      return reply(
        {
          responseVersion: 1,
          state: "refused",
          clientRequestId,
          code: "INVALID_JSON",
          error: "JSON 요청 형식을 확인해 주세요.",
        },
        400,
      );
    return reply(
      {
        responseVersion: 1,
        state: "unknown",
        clientRequestId,
        code: "PROVIDER_TRANSMISSION_APPROVAL_OUTCOME_UNKNOWN",
        error: "저장 결과를 확인하지 못했습니다. 원래 요청 번호와 명령으로 확인해 주세요.",
        recovery: "lookup-or-replay-original-request",
      },
      500,
    );
  }
}
