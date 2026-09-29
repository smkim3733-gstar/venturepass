import "server-only";
import {
  dispatchOwnedProviderSdk,
  type ProviderOwnedSdkDispatchResult,
} from "./studio-plan-quality-provider-sdk-owned";
import type { ProviderObservationPrepared } from "./studio-provider-observation";
export type { ProviderOwnedSdkDispatchResult } from "./studio-plan-quality-provider-sdk-owned";
/** Constructor-only test dependency. Never accept this from an HTTP command. There is no
 * default/global fetch fallback and this path never reads an actual credential. */
export type ProviderSdkTestNetwork = {
  provenance: "synthetic-test";
  fetch: typeof fetch;
};
export function snapshotProviderSdkTestNetwork(value: unknown): ProviderSdkTestNetwork {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error("PROVIDER_SDK_TEST_NETWORK_INVALID");
  if (Reflect.ownKeys(value).map(String).sort().join(",") !== "fetch,provenance")
    throw new Error("PROVIDER_SDK_TEST_NETWORK_INVALID");
  const provenance = Object.getOwnPropertyDescriptor(value, "provenance"),
    network = Object.getOwnPropertyDescriptor(value, "fetch");
  if (provenance?.value !== "synthetic-test" || typeof network?.value !== "function")
    throw new Error("PROVIDER_SDK_TEST_NETWORK_INVALID");
  return Object.freeze({ provenance: "synthetic-test", fetch: network.value });
}

/** Explicit synthetic path; no ambient credentials or global network fallback. */
export function dispatchOwnedProviderSdkTest(
  prepared: ProviderObservationPrepared,
  testNetwork: ProviderSdkTestNetwork,
  withCurrentWriter: (start: () => void) => void,
): Promise<ProviderOwnedSdkDispatchResult> {
  return dispatchOwnedProviderSdk(
    prepared,
    "synthetic-provider-sdk-test-only",
    snapshotProviderSdkTestNetwork(testNetwork).fetch,
    () => undefined,
    withCurrentWriter,
  );
}
