import "server-only";
import OpenAI from "openai";
import { z } from "zod";
import { providerTransportSdkOptions } from "./studio-plan-quality-provider-sdk-options";
import { snapshotProviderSdkWire } from "./studio-plan-quality-provider-sdk-wire";
import { registerComparisonProviderDriver } from "./studio-comparison-provider-driver";
import {
  createProviderPublicComparisonExecution,
  createProviderPublicComparisonService,
} from "./studio-public-claim-comparison-database-v11";
import type { ComparisonStorageSession } from "./studio-public-comparison-storage-witness";
import type { ComparisonCompanyGuard } from "./studio-public-comparison-company-guard";

const selectionSchema = z
  .object({
    databaseInstanceId: z.string().uuid(),
    environment: z.literal("production"),
    scopeId: z.literal("candidate-quality-provider-v2-live"),
  })
  .strict();
type ServerDependencies = Readonly<{
  apiKey: string;
  selection: z.infer<typeof selectionSchema>;
  network: typeof fetch;
  assertCurrent(): void;
}>;

/** Internal server composition. These dependencies are never accepted from an HTTP command.
 * Does not open a store, read env, grant approval, reserve funds or construct the SDK.
 * The caller retains the execution, session and guard through response/body cleanup.
 * A server configuration owner must pin paths/credentials and revoke assertCurrent on drift. */
export function createPublicComparisonProviderExecution(
  session: ComparisonStorageSession,
  companyGuard: ComparisonCompanyGuard,
  dependencies: ServerDependencies,
) {
  if (arguments.length !== 3) throw Error("COMPARISON_PROVIDER_CONFIGURATION_INVALID");
  return createProviderPublicComparisonExecution(
    session,
    companyGuard,
    providerDriver(dependencies),
  );
}

/** Internal full service. Keeps dispatch, capture, validation and recovery on the same owner. */
export function createPublicComparisonProviderService(
  session: ComparisonStorageSession,
  companyGuard: ComparisonCompanyGuard,
  dependencies: ServerDependencies,
) {
  if (arguments.length !== 3) throw Error("COMPARISON_PROVIDER_CONFIGURATION_INVALID");
  return createProviderPublicComparisonService(session, companyGuard, providerDriver(dependencies));
}

function providerDriver(dependencies: ServerDependencies) {
  const fields = Object.getOwnPropertyDescriptors(dependencies);
  if (
    Reflect.ownKeys(fields).map(String).sort().join() !==
      "apiKey,assertCurrent,network,selection" ||
    Object.values(fields).some((v) => !("value" in v))
  )
    throw Error("COMPARISON_PROVIDER_CONFIGURATION_INVALID");
  const { apiKey, network, assertCurrent } = dependencies;
  if (
    typeof apiKey !== "string" ||
    !/^sk-[A-Za-z0-9_-]{16,1024}$/.test(apiKey) ||
    typeof network !== "function" ||
    typeof assertCurrent !== "function"
  )
    throw Error("COMPARISON_PROVIDER_CONFIGURATION_INVALID");
  const selection = selectionSchema.parse(dependencies.selection);
  const checkCurrent = () => {
    const result: unknown = assertCurrent();
    if (result !== undefined) {
      // An async check must never let execution race ahead of its decision.
      void Promise.resolve(result).catch(() => undefined);
      throw Error("COMPARISON_PROVIDER_SYNCHRONOUS_CHECK_REQUIRED");
    }
  };
  return registerComparisonProviderDriver({
    assertCurrent(actual) {
      if (
        actual.databaseInstanceId !== selection.databaseInstanceId ||
        actual.environment !== selection.environment ||
        actual.scopeId !== selection.scopeId
      )
        throw Error("COMPARISON_PROVIDER_STORAGE_MISMATCH");
      checkCurrent();
    },
    snapshotWire: (rawBody, url, input) => snapshotProviderSdkWire(rawBody, apiKey, url, input),
    run(boundary, hooks) {
      // Only the fresh, durable SQL owner calls this. Replays never construct an SDK.
      return hooks.sdk(
        (fetch, request) => {
          checkCurrent();
          const client = new OpenAI({ ...providerTransportSdkOptions, apiKey, fetch });
          return client.responses.create(boundary.body, request);
        },
        (url, wire) => network(url as string, wire),
      );
    },
  });
}
