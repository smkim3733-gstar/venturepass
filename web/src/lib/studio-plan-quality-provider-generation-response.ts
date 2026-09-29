import { z } from "zod";
import {
  captureProviderResponse,
  freezeProviderValue,
  providerResponseMetadata,
  type ProviderUsageAssessment,
} from "../../scripts/local-data-quality-provider-usage.mjs";
import { createProviderExecutionArtifact } from "../../scripts/local-data-quality-provider-execution.mjs";
import { providerGenerationDispatchIdentitySchema } from "./studio-plan-quality-provider-dispatch-plan";
import type {
  ProviderExecutionCommand,
  ProviderExecutionSnapshot,
} from "./studio-plan-quality-provider-execution-types";

const inputSchema = z
  .object({
    dispatch: providerGenerationDispatchIdentitySchema,
    responseRequestId: z.string().uuid(),
    response: z.unknown(),
  })
  .strict();

/** Server capture only; SDK selection/JSON limits are identical to the native observation path.
 * No metadata, costs, configuration, permissions or transport can be supplied by the caller. */
export function captureGenerationResponseInput(raw: unknown) {
  const input = inputSchema.parse(raw);
  return freezeProviderValue({ ...input, response: captureProviderResponse(input.response) });
}
export type ProviderGenerationResponseInput = ReturnType<typeof captureGenerationResponseInput>;
export type ProviderGenerationResponseRecord = {
  state: "committed";
  dispatch: ProviderGenerationResponseInput["dispatch"];
  responseRequestId: string;
  inputDigest: string;
  responseEventDigest: string;
  responseArtifactSha256: string;
  revision: number;
  recordedAt: string;
  usageAssessment: ProviderUsageAssessment;
  usageBudgetEventDigest: string | null;
  responsePersisted: true;
  dispatchAllowed: false;
  budgetWriteAllowed: false;
  automaticRetryAllowed: false;
};
export type ProviderGenerationResponseResult = {
  record: ProviderGenerationResponseRecord;
  newlyCommitted: boolean;
  replayed: boolean;
};

/** The snapshot/dispatch must come from the writer's complete v9 audit, never a client snapshot. */
export function generationResponseCommand(
  input: ProviderGenerationResponseInput,
  snapshot: ProviderExecutionSnapshot,
  expectedRevision: number,
): ProviderExecutionCommand<"response-received"> {
  const dispatched = snapshot.events[2];
  if (dispatched?.payload.kind !== "dispatch-intent" || dispatched.payload.phase !== "generation")
    throw new Error("Generation dispatch required");
  const artifact = createProviderExecutionArtifact({
    runId: snapshot.run.id,
    key: "generation-response",
    body: JSON.stringify({ captureKind: "sdk-response-json-v2", response: input.response }),
  });
  return freezeProviderValue({
    clientRequestId: input.responseRequestId,
    expectedRevision,
    artifact,
    payload: {
      kind: "response-received",
      phase: "generation",
      requestDigest: dispatched.payload.requestDigest,
      dispatchEventDigest: dispatched.eventDigest,
      artifactSha256: artifact.sha256,
      metadata: providerResponseMetadata(input.response, {
        configuredModel: snapshot.run.preparation.model,
      }),
    },
  });
}
