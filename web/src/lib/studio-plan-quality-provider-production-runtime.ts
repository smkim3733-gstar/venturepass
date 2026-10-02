import "server-only";
import { providerProductionDirectory } from "./studio-plan-quality-provider-production-directory";
import {
  prepareProviderTransportBoundary,
  providerTransportSdkOptions,
} from "./studio-plan-quality-provider-transport-boundary";
import { snapshotProviderSdkWire } from "./studio-plan-quality-provider-sdk-wire";
import { dispatchOwnedProviderSdk } from "./studio-plan-quality-provider-sdk-owned";
import {
  ProviderGenerationDispatchStore,
  type ProviderDispatchContext,
} from "./studio-plan-quality-provider-dispatch-store";

import type { PlanPromptVersion } from "./studio-plan-prompt-versions";
import { createServerProviderPolicyContext } from "./studio-plan-quality-provider-policy-server";
import { getProviderConfigurationProposal } from "./studio-plan-quality-provider-configuration";

declare const runtimeBrand: unique symbol;
/** Nonserializable server configuration identity, NOT approval or new-COMMIT ownership. */
export type ProviderProductionRuntime = Readonly<{
  kind: "provider-production-runtime";
  version: 1;
  [runtimeBrand]: true;
}>;
type PolicyContext = ReturnType<typeof createServerProviderPolicyContext>;
type PrivateRuntime = {
  apiKey: string;
  directory: string;
  revoked: boolean;
  selection?: PolicyContext;
};
const runtimes = new WeakMap<object, PrivateRuntime>();
const executions = new WeakMap<object, ProviderProductionRuntime>();
/** Constructor authenticity check only. Cannot mint or extract a credential-bearing driver. */
export function isProviderProductionExecution(
  value: unknown,
  runtime: unknown,
  selection?: PolicyContext,
) {
  return (
    !!value &&
    typeof value === "object" &&
    executions.has(value) &&
    executions.get(value) === runtime &&
    lookup(runtime)?.selection === selection
  );
}
const lookup = (value: unknown) =>
  value && typeof value === "object" ? runtimes.get(value) : undefined;
/** Configuration drift is a monotonic revocation, never permission to adopt a new key/DB.
 * Recheck at each send boundary; recording an already observed response does not call this. */
function current(state: PrivateRuntime) {
  if (state.revoked) return false;
  try {
    if (
      process.env.OPENAI_API_KEY?.trim() === state.apiKey &&
      providerProductionDirectory() === state.directory
    )
      return true;
  } catch {
    // An unavailable working directory also closes new sends, not capture-only recovery.
  }
  state.apiKey = "";
  state.revoked = true;
  return false;
}
const unavailable = (reason: "unrecognized-runtime" | "revoked") =>
  Object.freeze({
    status: "unavailable" as const,
    reason,
    dispatchAllowed: false as const,
    recordingAllowed: false as const,
  });

/** Called explicitly by a trusted server composition root only. No automatic module/DB load,
 * command options, ambient URL/model/project override, API call or credential authentication.
 * The actual key lives only in a private WeakMap, never on the returned handle. */
export function createProviderProductionRuntime(): ProviderProductionRuntime {
  if (arguments.length !== 0) throw Error("PROVIDER_PRODUCTION_RUNTIME_OPTIONS_FORBIDDEN");
  return createRuntime();
}

/** Explicit trusted server selection. Configuration and credential come only from the server,
 * never from a command, stored contract, caller-supplied configuration or test network. */
export function createVersionedProviderProductionRuntime(
  version: PlanPromptVersion,
): ProviderProductionRuntime {
  if (
    arguments.length !== 1 ||
    (version !== "plan-observation-v1" && version !== "plan-observation-v2")
  )
    throw Error("PROVIDER_PRODUCTION_RUNTIME_VERSION_INVALID");
  return createRuntime(
    createServerProviderPolicyContext(version, getProviderConfigurationProposal()),
  );
}

/** Internal immutable context shared by policy writers and the runtime-owned dispatch store.
 * Access at construction requires an authentic, current runtime; no credential is exposed. */
export function providerProductionPolicyContext(runtime: ProviderProductionRuntime) {
  requireProviderProductionRuntime(runtime);
  return lookup(runtime)!.selection;
}

function createRuntime(selection?: PolicyContext): ProviderProductionRuntime {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key || !/^sk-[A-Za-z0-9_-]{16,1024}$/.test(key))
    throw Error("PROVIDER_PRODUCTION_CREDENTIAL_UNAVAILABLE");
  const runtime = Object.freeze(
    Object.assign(Object.create(null), {
      kind: "provider-production-runtime",
      version: 1,
    }),
  ) as ProviderProductionRuntime;
  runtimes.set(runtime, {
    apiKey: key,
    directory: providerProductionDirectory(),
    revoked: false,
    selection,
  });
  return runtime;
}

/** Revoke every future use of this handle and drop our secret reference. Existing DB holds
 * and already-started provider requests are unaffected; this is not a provider cancellation. */
export function revokeProviderProductionRuntime(value: unknown) {
  const state = lookup(value);
  if (!state || state.revoked) return false;
  state.apiKey = "";
  state.revoked = true;
  return true;
}

/** Public description is deliberately safe to serialize. Presence is not API/billing validation
 * and cannot open a store's write gate or authorize even one SDK request. */
export function inspectProviderProductionRuntime(value: unknown) {
  const state = lookup(value);
  if (!state) return unavailable("unrecognized-runtime");
  if (!current(state)) return unavailable("revoked");
  return Object.freeze({
    status: "configured" as const,
    environment: "production" as const,
    credentialSource: "server-environment" as const,
    credentialAuthenticated: false as const,
    sdkOptions: providerTransportSdkOptions,
    dispatchAllowed: false as const,
    recordingAllowed: false as const,
    ownership: "new-commit-owner-required" as const,
  });
}

/** Constructor validation runs before opening/creating a DB. JSON, spreads, proxies and TS casts
 * cannot reproduce the module-owned object identity. No getter or input property is evaluated. */
export function requireProviderProductionRuntime(value: unknown): ProviderProductionRuntime {
  if (inspectProviderProductionRuntime(value).status !== "configured")
    throw Error("PROVIDER_PRODUCTION_RUNTIME_UNAVAILABLE");
  return value as ProviderProductionRuntime;
}

/** Internal composition factory called by PlanQualityStore, never an HTTP/runner command.
 * Returns an audited store, not a credential getter, SDK client or free-standing send callback.
 * The concrete store grants a private invocation permit only for the original approval scope. */
export function createProviderProductionDispatchStore(
  context: ProviderDispatchContext,
  runtime: ProviderProductionRuntime,
) {
  requireProviderProductionRuntime(runtime);
  const fields = Object.getOwnPropertyDescriptors(context);
  if (
    Reflect.ownKeys(fields).map(String).sort().join(",") !==
      "artifact,capacity,db,get,registry,transaction" ||
    Object.values(fields).some((field) => !("value" in field))
  )
    throw Error("PROVIDER_PRODUCTION_CONTEXT_INVALID");
  const state = lookup(runtime)!;
  const network = globalThis.fetch.bind(globalThis);
  const assertCurrent = () => {
    if (!current(state) || !state.apiKey) throw Error("PROVIDER_PRODUCTION_RUNTIME_UNAVAILABLE");
  };
  const execution = Object.freeze({
    assertCurrent,
    dispatch: (
      prepared: Parameters<typeof dispatchOwnedProviderSdk>[0],
      writer: Parameters<typeof dispatchOwnedProviderSdk>[4],
    ) => dispatchOwnedProviderSdk(prepared, state.apiKey, network, assertCurrent, writer),
  });
  executions.set(execution, runtime);
  return new ProviderGenerationDispatchStore({
    ...context,
    synthetic: false,
    selection: state.selection,
    productionRuntime: runtime,
    productionExecution: execution,
  });
}

/** Offline production wire compatibility only. Raw input is an SDK wire, never an HTTP command.
 * It validates the same fixed wire as the test SDK driver but returns no headers/key/body/client.
 * No credential/network accessor or stand-alone sending function is exported from this module.
 * The internal store factory above keeps SDK dependencies within the original approval boundary. */
export function inspectProviderProductionWire(
  runtime: unknown,
  encodedPrepared: unknown,
  url: unknown,
  input: unknown,
) {
  const refusal = (reason: "runtime-unavailable" | "request-invalid" | "wire-incompatible") =>
    Object.freeze({ status: "refused" as const, reason, dispatchAllowed: false as const });
  const state = lookup(runtime);
  if (!state || !current(state)) return refusal("runtime-unavailable");
  const prepared = prepareProviderTransportBoundary(encodedPrepared);
  if (prepared.status !== "prepared") return refusal("request-invalid");
  try {
    snapshotProviderSdkWire(prepared.boundary.prepared.rawBody, state.apiKey, url, input);
    // A hostile iterable may revoke the handle while Headers reads it. Even this read-only
    // compatibility result must not report a now-revoked runtime as usable.
    if (!current(state)) return refusal("runtime-unavailable");
    return Object.freeze({
      status: "wire-compatible-not-authorized" as const,
      boundaryDigest: prepared.boundary.boundaryDigest,
      request: prepared.boundary.prepared.request,
      dispatchAllowed: false as const,
      recordingAllowed: false as const,
      approvalVerified: false as const,
      newCommitOwnershipVerified: false as const,
    });
  } catch {
    return refusal("wire-incompatible");
  }
}
