import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  scopeProviderProductionOperation,
  type ProviderProductionOperation,
} from "./studio-plan-quality-provider-production-scope";
import { providerGenerationRunnerNonces } from "./studio-plan-quality-provider-generation-runner";
import { providerReviewRunnerScope } from "./studio-plan-quality-provider-approved-runner";
import { ProviderGenerationDispatchStore } from "./studio-plan-quality-provider-dispatch-store";
import { isProviderProductionExecution } from "./studio-plan-quality-provider-production-runtime";
const original = {
  runId: randomUUID(),
  runDigest: "a".repeat(64),
  approvalBindingDigest: "b".repeat(64),
  preparedRequestId: randomUUID(),
  dispatchRequestId: randomUUID(),
};
const g = providerGenerationRunnerNonces(original);
const generation = {
  dispatch: original,
  responseRequestId: g.responseRequestId,
  responseEventDigest: "c".repeat(64),
  validationRequestId: g.validationRequestId,
};
const r = providerReviewRunnerScope({ generation, validationEventDigest: "d".repeat(64) });
const validation = {
  dispatch: r.dispatch,
  responseRequestId: r.nonces.responseRequestId,
  responseEventDigest: "e".repeat(64),
  validationRequestId: r.nonces.validationRequestId,
};
const examples: [ProviderProductionOperation, unknown][] = [
  ["generation-send", original],
  ["review-send", r.dispatch],
  [
    "generation-response",
    { dispatch: original, responseRequestId: g.responseRequestId, response: { id: "synthetic" } },
  ],
  ["generation-validation", generation],
  [
    "generation-stop",
    {
      dispatch: original,
      stopRequestId: g.unobservedStopRequestId,
      observation: { kind: "unobserved", disposition: "stop-with-possible-in-flight-response" },
    },
  ],
  [
    "generation-stop",
    {
      dispatch: original,
      stopRequestId: g.responseStopRequestId,
      observation: {
        kind: "response",
        responseRequestId: g.responseRequestId,
        responseEventDigest: "c".repeat(64),
      },
    },
  ],
  [
    "review-response",
    {
      dispatch: r.dispatch,
      responseRequestId: r.nonces.responseRequestId,
      response: { id: "synthetic" },
    },
  ],
  ["review-validation", validation],
  [
    "review-stop",
    {
      dispatch: r.dispatch,
      stopRequestId: r.nonces.unobservedStopRequestId,
      observation: { kind: "unobserved", disposition: "stop-with-possible-in-flight-response" },
    },
  ],
  [
    "review-stop",
    {
      dispatch: r.dispatch,
      stopRequestId: r.nonces.responseStopRequestId,
      observation: {
        kind: "response",
        responseRequestId: r.nonces.responseRequestId,
        responseEventDigest: "e".repeat(64),
      },
    },
  ],
  [
    "finalization",
    {
      validation,
      validationEventDigest: "f".repeat(64),
      finalizationRequestId: r.nonces.finalizationRequestId,
    },
  ],
];
it.each(examples)(
  "normalizes %s only for the original approval and v1 phase nonce scope",
  (operation, input) => {
    const value = scopeProviderProductionOperation(original, operation, input);
    expect(Object.isFrozen(value)).toBe(true);
    expect(value).not.toHaveProperty("dispatchAllowed", true);
    for (const field of [
      "runId",
      "runDigest",
      "approvalBindingDigest",
      "preparedRequestId",
      "dispatchRequestId",
    ] as const) {
      const changed = {
        ...original,
        [field]: field.endsWith("Digest") ? "0".repeat(64) : randomUUID(),
      };
      expect(() => scopeProviderProductionOperation(changed, operation, input)).toThrow(
        /^PROVIDER_PRODUCTION_SCOPE_REJECTED$/,
      );
    }
    expect(() =>
      scopeProviderProductionOperation(original, operation, {
        ...(input as object),
        authority: true,
      }),
    ).toThrow(/^PROVIDER_PRODUCTION_SCOPE_REJECTED$/);
    // Mutate each v1 stage nonce at every nesting level, leaving original generation intent IDs.
    const mutate = (value: unknown): unknown[] => {
      if (!value || typeof value !== "object") return [];
      const row = value as Record<string, unknown>,
        variants: unknown[] = [];
      for (const [field, child] of Object.entries(row)) {
        if (
          [
            "responseRequestId",
            "validationRequestId",
            "stopRequestId",
            "finalizationRequestId",
          ].includes(field)
        )
          variants.push({ ...row, [field]: randomUUID() });
        for (const changed of mutate(child)) variants.push({ ...row, [field]: changed });
      }
      return variants;
    };
    for (const changed of mutate(input))
      expect(() => scopeProviderProductionOperation(original, operation, changed)).toThrow(
        /^PROVIDER_PRODUCTION_SCOPE_REJECTED$/,
      );
  },
);
it("does not treat a serialized runtime or unknown operation as a grant", () => {
  expect(() =>
    scopeProviderProductionOperation(original, "admin" as ProviderProductionOperation, original),
  ).toThrow(/^PROVIDER_PRODUCTION_SCOPE_REJECTED$/);
  expect(() =>
    scopeProviderProductionOperation(original, "generation-send", {
      ...original,
      runtime: { kind: "provider-production-runtime", version: 1 },
    }),
  ).toThrow(/^PROVIDER_PRODUCTION_SCOPE_REJECTED$/);
});
it("rejects a caller-made production driver before opening any permission", () => {
  const driver = { assertCurrent: vi.fn(), dispatch: vi.fn() };
  expect(isProviderProductionExecution(driver, {})).toBe(false);
  expect(
    () =>
      new ProviderGenerationDispatchStore({
        synthetic: false,
        productionExecution: driver,
        productionRuntime: {},
      } as unknown as ConstructorParameters<typeof ProviderGenerationDispatchStore>[0]),
  ).toThrow("PROVIDER_PRODUCTION_EXECUTION_INVALID");
  expect(driver.assertCurrent).not.toHaveBeenCalled();
  expect(driver.dispatch).not.toHaveBeenCalled();
});
