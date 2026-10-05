import "server-only";
import { z } from "zod";
import {
  captureProviderResponse,
  freezeProviderValue,
  reportedProviderResponseMetadata,
  type ProviderCapturedResponse,
  type ProviderReportedResponseMetadata,
} from "../../scripts/local-data-quality-provider-usage.mjs";
import { parseProviderResponseOutput } from "./studio-provider-observation";
import {
  inspectPublicClaimComparisonRequest,
  validatePublicClaimComparisonRequestResponse,
  type PublicClaimComparisonRequestPreview,
} from "./studio-public-claim-comparison-request";
import { publicClaimComparisonRequestAuthority } from "./studio-public-claim-comparison-request-types";
import { publicClaimComparisonLimits } from "./studio-public-claim-comparison-types";
import { StudioError } from "./studio-http";
import type { StudioCase } from "./studio-schema";

// Application-supported subset only; no assertion of provider/model compatibility.
const nonblank = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => Boolean(s.trim()));
const envelope = z.object({
  id: nonblank(500),
  model: nonblank(200),
  output: z.array(z.unknown()).max(50),
});
const message = z.object({
  type: z.literal("message"),
  role: z.literal("assistant"),
  status: z.literal("completed"),
  content: z
    .array(
      z.object({
        type: z.literal("output_text"),
        text: z.string().max(publicClaimComparisonLimits.responseCharacters),
      }),
    )
    .length(1),
});
const outputKind = z.object({ type: z.enum(["message", "reasoning"]) });
const boundaries = Object.freeze({
  ...publicClaimComparisonRequestAuthority,
  kind: "public-claim-comparison-response-capture" as const,
  captureVersion: "public-claim-comparison-capture-v1" as const,
  source: "supplied-response" as const,
  evidenceOrigin: "manual-unverified" as const,
  providerExecutionObserved: false as const,
  providerResponseAuthenticated: false as const,
  usageVerified: false as const,
  databaseWriteAllowed: false as const,
});
type Comparison = ReturnType<typeof validatePublicClaimComparisonRequestResponse>;
type Request = {
  identity: PublicClaimComparisonRequestPreview["identity"];
  model: string;
  requestedTier: null;
};
type RejectedState =
  | "context-changed"
  | "request-rejected"
  | "response-incomplete"
  | "response-unsupported"
  | "model-mismatch"
  | "comparison-rejected";
type Captured = {
  capture: ProviderCapturedResponse;
  metadata: ProviderReportedResponseMetadata;
};
export type PublicClaimComparisonCapturedResult = typeof boundaries &
  (
    | {
        state: "capture-unavailable";
        capture: null;
        metadata: null;
        request: null;
        comparison: null;
      }
    | (Captured & { state: RejectedState; request: Request | null; comparison: null })
    | (Captured & { state: "comparison-ready"; request: Request; comparison: Comparison })
  );

/**
 * Passive supplied JSON adapter. Capture happens synchronously before any context check.
 * No SDK client, configuration, I/O, approval, cost assessment or persistent recovery.
 */
export function capturePublicClaimComparisonResponse(
  company: StudioCase,
  command: unknown,
  expectedIdentity: unknown,
  suppliedResponse: unknown,
): PublicClaimComparisonCapturedResult {
  let capture: ProviderCapturedResponse;
  try {
    capture = captureProviderResponse(suppliedResponse);
  } catch {
    // Never echo arbitrary exceptions or expose a partial/truncated capture.
    return freezeProviderValue({
      ...boundaries,
      state: "capture-unavailable",
      capture: null,
      metadata: null,
      request: null,
      comparison: null,
    });
  }
  const metadata = reportedProviderResponseMetadata(capture);
  let request: Request | null = null;
  const reject = (state: RejectedState): PublicClaimComparisonCapturedResult =>
    freezeProviderValue({ ...boundaries, state, capture, metadata, request, comparison: null });
  let current: PublicClaimComparisonRequestPreview;
  try {
    current = inspectPublicClaimComparisonRequest(company, command, expectedIdentity);
  } catch (error) {
    return reject(
      error instanceof StudioError && error.status === 409 ? "context-changed" : "request-rejected",
    );
  }
  request = {
    identity: current.identity,
    model: current.command.model,
    // The frozen request omits service_tier; response tier cannot fill it in.
    requestedTier: null,
  };
  const decoded = decodePublicClaimCapturedOutput(capture,current.command.model);
  if (decoded.state !== "parsed") return reject(decoded.state);
  const output = decoded.output;
  try {
    const comparison = validatePublicClaimComparisonRequestResponse(
      company,
      current.command,
      current.identity,
      output,
    );
    return freezeProviderValue({
      ...boundaries,
      state: "comparison-ready",
      capture,
      metadata,
      request,
      comparison,
    });
  } catch {
    return reject("comparison-rejected");
  }
}

/** Shared narrow envelope/JSON check; capture must already be copied by captureProviderResponse. */
export function decodePublicClaimCapturedOutput(capture: ProviderCapturedResponse, model: string) {
  if (capture.status !== "completed") return {state:"response-incomplete" as const};
  const parsed = envelope.safeParse(capture);
  if (!parsed.success) return {state:"response-unsupported" as const};
  if (parsed.data.model !== model) return {state:"model-mismatch" as const};
  const messages: unknown[] = [];
  for (const item of parsed.data.output) {
    const kind = outputKind.safeParse(item);
    if (!kind.success) return {state:"response-unsupported" as const};
    if (kind.data.type === "message") messages.push(item);
  }
  if (messages.length !== 1 || !message.safeParse(messages[0]).success)
    return {state:"response-unsupported" as const};
  let output: unknown;
  try {
    // Reuse the existing JSON extraction without changing legacy output handling.
    output = parseProviderResponseOutput(capture);
  } catch {
    return {state:"response-unsupported" as const};
  }
  return {state:"parsed" as const,output};
}
