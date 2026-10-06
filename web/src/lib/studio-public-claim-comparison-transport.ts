import "server-only";
import { z } from "zod";
import { freezeProviderValue } from "../../scripts/local-data-quality-provider-usage.mjs";
import { assertPublicComparisonDataOnly } from "./studio-public-claim-comparison-budget";
import { inspectArchivedPublicClaimRequest } from "./studio-public-claim-comparison-request";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";

/** Passive reconstruction. This contains no credentials, SDK or execution authority. */
export function preparePublicComparisonTransportBoundary(raw: unknown) {
  assertPublicComparisonDataOnly(raw, 8 * 1024 * 1024);
  const input = z
    .object({ command: z.unknown(), context: z.string(), identity: z.unknown() })
    .strict()
    .parse(raw);
  const { request } = inspectArchivedPublicClaimRequest(input.command, input.context);
  if (digest(request.identity) !== digest(input.identity))
    throw Error("PUBLIC_COMPARISON_WIRE_IDENTITY");
  return Object.freeze({
    source: "supplied-comparison-transport-boundary" as const,
    rawBody: request.rawBody,
    body: freezeProviderValue(request.body),
    destination: request.contract.destination,
    requestedTier: null,
    maxCalls: 1,
    automaticRetryLimit: 0,
    timeoutMs: request.contract.timeoutMs,
    dispatchAllowed: false,
  });
}
export type PublicComparisonTransportBoundary = ReturnType<
  typeof preparePublicComparisonTransportBoundary
>;
export type SyntheticComparisonHooks = Readonly<{
  start(
    url: unknown,
    wire: unknown,
    startFake: (wire: RequestInit) => Promise<unknown>,
  ): Promise<void>;
  sdk(
    invoke: (
      fetch: (url: unknown, input: unknown) => Promise<Response>,
      request: Readonly<{ signal: AbortSignal }>,
    ) => PromiseLike<unknown>,
    network: (url: unknown, wire: RequestInit) => Promise<Response>,
  ): Promise<void>;
  markUnknown(): void;
}>;
export type SyntheticComparisonDriver = Readonly<{ kind: "synthetic-comparison-fixture" }>;
type Fixture = (
  boundary: PublicComparisonTransportBoundary,
  hooks: SyntheticComparisonHooks,
) => Promise<void>;
const fixtures = new WeakMap<SyntheticComparisonDriver, Fixture>();
/** Test composition only; never installed in production and never grants provider authority. */
export function createSyntheticComparisonDriver(fixture: Fixture): SyntheticComparisonDriver {
  if (typeof fixture !== "function") throw Error("PUBLIC_COMPARISON_SYNTHETIC_DRIVER");
  const token = Object.freeze({ kind: "synthetic-comparison-fixture" as const });
  fixtures.set(token, fixture);
  return token;
}
export function requireSyntheticComparisonDriver(token: SyntheticComparisonDriver): Fixture {
  const fixture = fixtures.get(token);
  if (!fixture) throw Error("PUBLIC_COMPARISON_SYNTHETIC_DRIVER");
  return fixture;
}
// Deliberately public dummy value, not a credential or environment lookup.
export const comparisonSyntheticWireKey = "synthetic-comparison-no-provider-authority";
