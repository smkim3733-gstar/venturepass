import "server-only";
import { providerTransportSdkOptions } from "./studio-plan-quality-provider-sdk-options";
import {
  comparisonSyntheticWireKey,
  createSyntheticComparisonDriver,
  type PublicComparisonTransportBoundary,
} from "./studio-public-claim-comparison-transport";

export type SyntheticComparisonSdkFetch = (url: unknown, init: unknown) => Promise<Response>;
export type SyntheticComparisonSdkOptions = typeof providerTransportSdkOptions &
  Readonly<{
    apiKey: typeof comparisonSyntheticWireKey;
    fetch: SyntheticComparisonSdkFetch;
  }>;
export type SyntheticComparisonSdkFactory = (options: SyntheticComparisonSdkOptions) => Readonly<{
  responses: Readonly<{
    create(
      body: PublicComparisonTransportBoundary["body"],
      request: Readonly<{ signal: AbortSignal }>,
    ): PromiseLike<unknown>;
  }>;
}>;
export type SyntheticComparisonNetwork = (url: unknown, wire: RequestInit) => Promise<Response>;

/** SDK-shaped fixture only. Neither imports an SDK nor has a real-network fallback.
 * These constructor-only dependencies cannot be supplied by an execution command.
 * The same private owner receives the SDK JSON; Response goes back to the fixture SDK. */
export function createSyntheticComparisonSdkDriver(
  factory: SyntheticComparisonSdkFactory,
  network: SyntheticComparisonNetwork,
) {
  if (arguments.length !== 2 || typeof factory !== "function" || typeof network !== "function")
    throw Error("PUBLIC_COMPARISON_SYNTHETIC_SDK");
  return createSyntheticComparisonDriver((boundary, hooks) =>
    hooks.sdk((fetch, request) => {
      const client = factory(
        Object.freeze({
          ...providerTransportSdkOptions,
          apiKey: comparisonSyntheticWireKey,
          fetch,
        }),
      );
      return client.responses.create(boundary.body, request);
    }, network),
  );
}
