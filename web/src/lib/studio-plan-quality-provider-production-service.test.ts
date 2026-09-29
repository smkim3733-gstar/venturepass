import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  ProviderProductionExecutionService,
  providerProductionServiceCapacity,
} from "./studio-plan-quality-provider-production-service";
import { providerInitialProductionIdentity } from "./studio-plan-quality-provider-production-identity";
import {
  providerProductionViewSchema,
  type ProviderProductionSelection,
} from "./studio-plan-quality-provider-production-service-types";
import { generationResponseFixture } from "./studio-plan-quality-provider-response-test-helpers";
import type { ProviderApprovedRunnerResult } from "./studio-plan-quality-provider-approved-runner";

const secret = "synthetic-private-response-do-not-serialize";
const selection = () => ({
  runId: randomUUID(),
  runDigest: "a".repeat(64),
  approvalBindingDigest: "b".repeat(64),
});
function captured(scope: ProviderProductionSelection): ProviderApprovedRunnerResult {
  const { runId, runDigest, approvalBindingDigest } = scope;
  const fixture = generationResponseFixture(
    providerInitialProductionIdentity({ runId, runDigest, approvalBindingDigest }),
  );
  return {
    generation: {
      status: "last-confirmed",
      snapshot: null,
      replayed: false,
      recoveredStages: [],
      failure: { stage: "response", reason: secret },
      transport: null,
      response: null,
      validation: null,
      stop: null,
      pendingCapture: {
        dispatch: fixture.dispatch,
        responseRequestId: fixture.responseRequestId,
        response: fixture.response,
      },
      executionCompleted: false,
      reviewStarted: false,
      automaticRetryAllowed: false,
    },
    review: null,
    executionCompleted: false,
    automaticRetryAllowed: false,
  };
}
function fixture() {
  const store = {
    providerResolveProductionIdentity: vi.fn((raw: unknown) =>
      providerInitialProductionIdentity(raw),
    ),
    providerRunApprovedProduction: vi.fn(async (raw: unknown) =>
      captured(raw as ProviderProductionSelection),
    ),
    providerRecoverProductionGenerationCapture:
      vi.fn<
        ConstructorParameters<
          typeof ProviderProductionExecutionService
        >[0]["providerRecoverProductionGenerationCapture"]
      >(),
    providerRecoverProductionReviewCapture:
      vi.fn<
        ConstructorParameters<
          typeof ProviderProductionExecutionService
        >[0]["providerRecoverProductionReviewCapture"]
      >(),
  };
  return { store, service: new ProviderProductionExecutionService(store) };
}

it("bounds retained captures without evicting them or admitting another provider call", async () => {
  const { store, service } = fixture(),
    scopes = Array.from({ length: providerProductionServiceCapacity }, selection);
  for (const scope of scopes)
    expect((await service.execute(scope)).status).toBe("capture-recovery-required");
  expect((await service.execute(selection())).reason).toBe("recovery-capacity-full");
  expect(store.providerRunApprovedProduction).toHaveBeenCalledTimes(
    providerProductionServiceCapacity,
  );
  const capture = (await store.providerRunApprovedProduction.mock.results[0].value).generation
    .pendingCapture;
  store.providerRecoverProductionGenerationCapture.mockImplementation(() => {
    throw Error(secret);
  });
  const failed = service.recover(scopes[0]);
  expect(failed).toMatchObject({
    status: "capture-recovery-required",
    reason: "capture-recovery-unconfirmed",
  });
  expect(store.providerRecoverProductionGenerationCapture.mock.calls[0][0]).toBe(capture);
  expect(JSON.stringify(failed)).not.toContain(secret);
  expect((await service.execute(scopes[0])).status).toBe("capture-recovery-required");
  expect((await service.execute(selection())).reason).toBe("recovery-capacity-full");
  expect(JSON.stringify(service)).toBe("{}");
});

it("frees capacity only after capture persistence is confirmed and never starts a review during recovery", async () => {
  const { store, service } = fixture(),
    scope = selection();
  await service.execute(scope);
  const original = (await store.providerRunApprovedProduction.mock.results[0].value).generation;
  store.providerRecoverProductionGenerationCapture.mockReturnValue({
    ...original,
    pendingCapture: null,
    failure: null,
  });
  expect(service.recover(scope).status).toBe("last-confirmed");
  expect(service.recover(scope).reason).toBe("capture-not-retained");
  expect(store.providerRunApprovedProduction).toHaveBeenCalledTimes(1);
  expect(store.providerRecoverProductionReviewCapture).not.toHaveBeenCalled();
  for (let index = 0; index < providerProductionServiceCapacity; index++)
    expect((await service.execute(selection())).status).toBe("capture-recovery-required");
});

it("retains capture even when a malformed internal summary cannot be projected", async () => {
  const { store, service } = fixture(),
    scope = selection();
  const result = captured(scope);
  result.generation.failure = { stage: secret as "response", reason: secret };
  store.providerRunApprovedProduction.mockResolvedValue(result);
  const view = await service.execute(scope);
  expect(view.reason).toBe("execution-unavailable");
  expect(JSON.stringify(view)).not.toContain(secret);
  store.providerRecoverProductionGenerationCapture.mockReturnValue({
    ...result.generation,
    failure: null,
  });
  expect(service.recover(scope).status).toBe("capture-recovery-required");
  expect(store.providerRecoverProductionGenerationCapture.mock.calls[0][0]).toBe(
    result.generation.pendingCapture,
  );
  expect(store.providerRunApprovedProduction).toHaveBeenCalledTimes(1);
});

it("sanitizes unexpected exceptions and rejects raw/configuration input before store access", async () => {
  const { store, service } = fixture();
  store.providerResolveProductionIdentity.mockImplementation(() => {
    throw Error(secret);
  });
  const invalid = await service.execute({ ...selection(), apiKey: secret, pendingCapture: secret });
  expect(invalid).toMatchObject({ reason: "invalid-selection", selection: null });
  expect(store.providerResolveProductionIdentity).not.toHaveBeenCalled();
  const failed = await service.execute(selection());
  expect(failed).toMatchObject({
    status: "unavailable",
    reason: "execution-unavailable",
    executionCompleted: false,
  });
  expect(JSON.stringify(failed)).not.toContain(secret);
  expect(store.providerRunApprovedProduction).not.toHaveBeenCalled();
  expect(
    providerProductionViewSchema.safeParse({ ...failed, pendingCapture: secret }).success,
  ).toBe(false);
  expect(
    providerProductionViewSchema.safeParse({ ...failed, executionCompleted: true }).success,
  ).toBe(false);
});

it("initial identity depends only on the complete approval scope and keeps its v1 namespace stable", () => {
  const scope = {
    runId: "11111111-1111-4111-8111-111111111111",
    runDigest: "a".repeat(64),
    approvalBindingDigest: "b".repeat(64),
  };
  const first = providerInitialProductionIdentity(scope);
  expect(first).toEqual({
    ...scope,
    preparedRequestId: "a8c88f65-d351-578a-9617-665bfcb9ce6d",
    dispatchRequestId: "9a193c81-b1a9-563a-bd6b-a6d7666c9ffb",
  });
  expect(first).toEqual(
    providerInitialProductionIdentity({
      approvalBindingDigest: scope.approvalBindingDigest,
      runDigest: scope.runDigest,
      runId: scope.runId,
    }),
  );
  expect(first.preparedRequestId).not.toBe(first.dispatchRequestId);
  expect(first.preparedRequestId).toMatch(/^[a-f0-9-]{14}5/);
  expect(
    providerInitialProductionIdentity({ ...scope, approvalBindingDigest: "c".repeat(64) }),
  ).not.toEqual(first);
  expect(() =>
    providerInitialProductionIdentity({ ...scope, dispatchRequestId: randomUUID() }),
  ).toThrow();
});

it("counts active executions against capture capacity before starting another run", async () => {
  const { store, service } = fixture();
  const scopes = Array.from({ length: providerProductionServiceCapacity }, selection);
  const finishes: Array<() => void> = [];
  store.providerRunApprovedProduction.mockImplementation(
    (raw) =>
      new Promise((resolve) => {
        finishes.push(() => resolve(captured(raw as ProviderProductionSelection)));
      }),
  );
  const owners = scopes.map((scope) => service.execute(scope));
  try {
    expect((await service.execute(scopes[0])).reason).toBe("execution-in-progress");
    expect((await service.execute(selection())).reason).toBe("recovery-capacity-full");
    expect(store.providerRunApprovedProduction).toHaveBeenCalledTimes(
      providerProductionServiceCapacity,
    );
  } finally {
    finishes.forEach((finish) => finish());
  }
  const results = await Promise.all(owners);
  expect(results.every((view) => view.status === "capture-recovery-required")).toBe(true);
  expect((await service.execute(selection())).reason).toBe("recovery-capacity-full");
});
