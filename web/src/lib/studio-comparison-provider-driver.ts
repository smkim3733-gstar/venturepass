import "server-only";
import type { PublicComparisonDatabaseSelection } from "./studio-public-claim-comparison-database";
import type {
  PublicComparisonTransportBoundary,
  SyntheticComparisonHooks,
} from "./studio-public-claim-comparison-transport";

/** Internal constructor identity, never a serializable approval or an HTTP input. */
export type ComparisonProviderDriver = Readonly<{ kind: "comparison-provider-driver" }>;
type Ports = Readonly<{
  assertCurrent(selection: PublicComparisonDatabaseSelection): void;
  snapshotWire(rawBody: string, url: unknown, input: unknown): RequestInit;
  run(
    boundary: PublicComparisonTransportBoundary,
    hooks: Pick<SyntheticComparisonHooks, "sdk">,
  ): Promise<void>;
}>;
const drivers = new WeakMap<ComparisonProviderDriver, Ports>();

/** Trusted server composition only. Registration performs no configuration, SQL or SDK work. */
export function registerComparisonProviderDriver(ports: Ports): ComparisonProviderDriver {
  const fields = Object.getOwnPropertyDescriptors(ports);
  if (
    Reflect.ownKeys(fields).map(String).sort().join() !== "assertCurrent,run,snapshotWire" ||
    Object.values(fields).some((v) => !("value" in v) || typeof v.value !== "function")
  )
    throw Error("COMPARISON_PROVIDER_DRIVER_INVALID");
  const token = Object.freeze({ kind: "comparison-provider-driver" as const });
  drivers.set(token, Object.freeze({ ...ports }));
  return token;
}

/** Internal SQL owner lookup. A spread, JSON copy, Proxy or forged object never matches. */
export function requireComparisonProviderDriver(token: ComparisonProviderDriver): Ports {
  const ports = drivers.get(token);
  if (!ports) throw Error("COMPARISON_PROVIDER_DRIVER_INVALID");
  return ports;
}
