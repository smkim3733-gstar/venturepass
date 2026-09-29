import "server-only";
import OpenAI from "openai";
import {
  prepareProviderTransportBoundary,
  providerTransportSdkOptions,
  type ProviderTransportObservation,
} from "./studio-plan-quality-provider-transport-boundary";
import type { ProviderObservationPrepared } from "./studio-provider-observation";
import { snapshotProviderSdkWire } from "./studio-plan-quality-provider-sdk-wire";

type Refusal =
  "request-invalid" | "wire-rejected" | "current-check-rejected" | "sdk-preparation-failed";
export type ProviderOwnedSdkDispatchResult = {
  delivery: "not-sent" | "response-captured" | "send-result-unobserved";
  fetchStarted: boolean;
  finalCheckFailedAfterStart: boolean;
  refusal: Refusal | null;
  observation: ProviderTransportObservation | null;
  responsePersisted: false;
  automaticRetryAllowed: false;
};

/** Internal SDK mechanism with explicit dependencies; it reads no environment or authority.
 * Only the store invocation which observed a NEW successful
 * COMMIT supplies the final writer transaction closure. Nothing returned here can recover it.
 * The SDK may await before calling fetch; therefore the writer closure runs INSIDE fetch,
 * not around responses.create(). No await occurs between its final checks and network start. */
export async function dispatchOwnedProviderSdk(
  prepared: ProviderObservationPrepared,
  apiKey: string,
  network: typeof fetch,
  beforeStart: () => void,
  withCurrentWriter: (start: () => void) => void,
): Promise<ProviderOwnedSdkDispatchResult> {
  const result = prepareProviderTransportBoundary(JSON.stringify(prepared));
  let fetchStarted = false,
    finalCheckFailedAfterStart = false,
    fetchEntered = false;
  let refusal: Refusal | null = null;
  const finish = (
    observation: ProviderTransportObservation | null,
  ): ProviderOwnedSdkDispatchResult =>
    Object.freeze({
      delivery: !fetchStarted
        ? "not-sent"
        : observation?.kind === "response-captured"
          ? "response-captured"
          : "send-result-unobserved",
      fetchStarted,
      finalCheckFailedAfterStart,
      refusal,
      observation,
      responsePersisted: false,
      automaticRetryAllowed: false,
    });
  if (result.status !== "prepared") {
    refusal = "request-invalid";
    return finish(null);
  }
  const boundary = result.boundary;
  const deadline = performance.now() + providerTransportSdkOptions.timeout;
  try {
    beforeStart();
    const sdk = new OpenAI({
      ...providerTransportSdkOptions,
      apiKey,
      fetch: async (url, init) => {
        // One entry only, including rejected starts. No SDK retry can reacquire ownership.
        if (fetchEntered) throw new Error("PROVIDER_SDK_DUPLICATE_FETCH");
        fetchEntered = true;
        refusal = "wire-rejected";
        // Take the final wire snapshot before entering the writer transaction. No mutable
        // SDK options object is forwarded to the network boundary.
        const wire = snapshotProviderSdkWire(boundary.prepared.rawBody, apiKey, url, init);
        let completion: Promise<Response> | null = null;
        let gateOpen = true;
        refusal = "current-check-rejected";
        try {
          withCurrentWriter(() => {
            if (!gateOpen || fetchStarted || wire.signal?.aborted || performance.now() >= deadline)
              throw new Error("PROVIDER_SDK_START_REJECTED");
            beforeStart();
            fetchStarted = true;
            refusal = null;
            // Invoke the server-configured network synchronously while the writer slot
            // is held. A synchronous fetch throw still leaves provider cost unobserved.
            try {
              completion = Promise.resolve(network(url, wire));
            } catch (error) {
              completion = Promise.reject(error);
            }
            void completion.catch(() => undefined);
          });
        } catch (error) {
          if (!fetchStarted) throw error;
          // A read COMMIT failure cannot erase the in-flight response promise. Let the SDK
          // consume/capture it; the caller will persist it separately under the original ID.
          finalCheckFailedAfterStart = true;
        } finally {
          gateOpen = false;
        }
        if (!completion) throw new Error("PROVIDER_SDK_START_REJECTED");
        return completion;
      },
    });
    const observation = await sdk.responses
      .create(boundary.prepared.body)
      .then(boundary.captureResponse, boundary.captureFailure);
    if (!fetchStarted) {
      refusal ??= "sdk-preparation-failed";
      return finish(null);
    }
    return finish(observation);
  } catch (error) {
    if (!fetchStarted) refusal ??= "sdk-preparation-failed";
    return finish(fetchStarted ? boundary.captureFailure(error) : null);
  }
}
