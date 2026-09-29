import "server-only";
import { z } from "zod";
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "openai/error";
import {
  providerDigest,
  providerRawDigest,
  providerRequestBodySchema,
  providerWireDigest,
} from "../../scripts/local-data-quality-provider.mjs";
import {
  captureProviderResponse,
  freezeProviderValue,
  providerObservationLimits,
  type ProviderCapturedResponse,
} from "../../scripts/local-data-quality-provider-usage.mjs";
import type {
  ProviderObservationPrepared,
  ProviderObservationRequest,
} from "./studio-provider-observation";

/** Server-owned SDK options, with no credentials, hooks, model or caller overrides.
 * This is NOT an SDK client or a capability to send. Even responses.create() starts
 * fetch asynchronously: a future owner must recheck at the actual fetch boundary. */
export const providerTransportSdkOptions = freezeProviderValue({
  baseURL: "https://api.openai.com/v1",
  maxRetries: 0,
  timeout: 120_000,
  logLevel: "off",
  adminAPIKey: null,
  webhookSecret: null,
  organization: null,
  project: null,
  fetchOptions: { redirect: "error" },
} as const);

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const preparedSchema = z
  .object({
    request: z
      .object({
        phase: z.enum(["generation", "review"]),
        sequence: z.union([z.literal(1), z.literal(2)]),
        model: z.string().min(1).max(200),
        contractDigest: hash,
        requestDigest: hash,
        artifactSha256: hash,
        inputChars: z.number().int().positive().safe(),
        maxOutputTokens: z.literal(16000),
      })
      .strict(),
    body: providerRequestBodySchema,
    rawBody: z.string().min(1),
  })
  .strict();

type UnobservedReason =
  | "timeout"
  | "connection"
  | "aborted"
  | "http-error"
  | "response-decode"
  | "capture-failed"
  | "unexpected-failure";
type ObservationBase = {
  request: ProviderObservationRequest;
  boundaryDigest: string;
  responsePersisted: false;
  costReconciled: false;
  outputValidated: false;
  automaticRetryAllowed: false;
};
export type ProviderTransportObservation = ObservationBase &
  (
    | { kind: "response-captured"; response: ProviderCapturedResponse }
    | { kind: "result-unobserved"; reason: UnobservedReason; httpStatus: number | null }
  );
export type ProviderTransportBoundary = {
  kind: "provider-transport-boundary";
  version: 1;
  prepared: ProviderObservationPrepared;
  sdkOptions: typeof providerTransportSdkOptions;
  boundaryDigest: string;
  dispatchAllowed: false;
  approvalVerified: false;
  newCommitOwnershipVerified: false;
  /** Capture synchronously, BEFORE any await, persistence, usage or output validation. */
  captureResponse: (response: unknown) => ProviderTransportObservation;
  /** Conservative: even a timeout/HTTP failure is not proof of zero provider cost. */
  captureFailure: (error: unknown) => ProviderTransportObservation;
};
export type ProviderTransportBoundaryResult =
  | { status: "prepared"; boundary: ProviderTransportBoundary }
  | { status: "refused"; reason: "invalid-request" | "request-too-large" };

/** Passive adapter only: no SDK construction, environment, DB, clock or fetch access.
 * Encode the already audited dispatch plan's prepared request on the server. Accepting
 * only a JSON string avoids retaining caller references or executing serialization
 * hooks/accessors. Digests check consistency, NOT approval or new-COMMIT ownership.
 * The writer must later match this exact request to its newly committed invocation. */
export function prepareProviderTransportBoundary(
  encoded: unknown,
): ProviderTransportBoundaryResult {
  if (typeof encoded !== "string") return { status: "refused", reason: "invalid-request" };
  // Body plus its JSON-escaped raw copy, with bounded request metadata.
  if (Buffer.byteLength(encoded) > providerObservationLimits.requestBytes * 3 + 8192)
    return { status: "refused", reason: "request-too-large" };
  let prepared: ProviderObservationPrepared;
  try {
    const parsed: unknown = JSON.parse(encoded);
    if (!preparedSchema.safeParse(parsed).success)
      return { status: "refused", reason: "invalid-request" };
    // Keep the original property order: Zod's reconstructed object is not wire evidence.
    prepared = parsed as ProviderObservationPrepared;
    const { body, request, rawBody } = prepared;
    if (Buffer.byteLength(rawBody) > providerObservationLimits.requestBytes)
      return { status: "refused", reason: "request-too-large" };
    if (
      rawBody !== JSON.stringify(body) ||
      providerRawDigest(rawBody) !== request.artifactSha256 ||
      providerWireDigest(body) !== request.requestDigest ||
      request.model !== body.model ||
      request.sequence !== (request.phase === "generation" ? 1 : 2) ||
      request.inputChars !== body.input.reduce((sum, row) => sum + row.content.length, 0) ||
      request.maxOutputTokens !== body.max_output_tokens
    )
      return { status: "refused", reason: "invalid-request" };
  } catch {
    return { status: "refused", reason: "invalid-request" };
  }
  freezeProviderValue(prepared);
  const descriptor = freezeProviderValue({
    kind: "provider-transport-boundary" as const,
    version: 1 as const,
    prepared,
    sdkOptions: providerTransportSdkOptions,
    dispatchAllowed: false as const,
    approvalVerified: false as const,
    newCommitOwnershipVerified: false as const,
  });
  const boundaryDigest = providerDigest(descriptor);
  const base: ObservationBase = {
    request: prepared.request,
    boundaryDigest,
    responsePersisted: false,
    costReconciled: false,
    outputValidated: false,
    automaticRetryAllowed: false,
  };
  const unobserved = (reason: UnobservedReason, httpStatus: number | null = null) =>
    freezeProviderValue({ ...base, kind: "result-unobserved" as const, reason, httpStatus });
  const boundary: ProviderTransportBoundary = {
    ...descriptor,
    boundaryDigest,
    captureResponse(response) {
      try {
        return freezeProviderValue({
          ...base,
          kind: "response-captured" as const,
          response: captureProviderResponse(response),
        });
      } catch {
        // Missing/invalid domain output is captured successfully by the existing contract.
        // A capture failure instead means no usable raw observation; never auto-retry.
        return unobserved("capture-failed");
      }
    },
    captureFailure(error) {
      // Never retain error.message/body/headers/cause, which may contain credentials or input.
      if (error instanceof APIConnectionTimeoutError) return unobserved("timeout");
      if (error instanceof APIUserAbortError) return unobserved("aborted");
      if (error instanceof APIConnectionError) return unobserved("connection");
      if (error instanceof APIError) {
        const status = Object.getOwnPropertyDescriptor(error, "status")?.value;
        return unobserved(
          "http-error",
          Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
        );
      }
      if (error instanceof SyntaxError) return unobserved("response-decode");
      return unobserved("unexpected-failure");
    },
  };
  return { status: "prepared", boundary: freezeProviderValue(boundary) };
}
