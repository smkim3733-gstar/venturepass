/** Pure server-selected planning only: no durable writes, SDK or transmission ownership. */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("openai", () => {
  throw Error("No SDK in planning");
});
vi.mock("./studio-plan-quality-store", () => {
  throw Error("No DB in planning");
});
vi.mock("./studio-provider-observation", () => {
  throw Error("No transport in planning");
});
import {
  fixture,
  executionBase,
} from "./studio-plan-quality-provider-execution-version-test-helpers";
import { generationDispatchFixture } from "./studio-plan-quality-provider-dispatch-test-helpers";
import { createServerProviderPolicyContext } from "./studio-plan-quality-provider-policy-server";
import {
  prepareProviderGenerationDispatch as frozen,
  prepareVersionedProviderGenerationDispatch as prepare,
  providerGenerationDispatchPlanLimits as limits,
  type ProviderGenerationDispatchInput as Input,
} from "./studio-plan-quality-provider-dispatch-plan";
import {
  inspectVersionedProviderTransmissionApprovalArchive as inspect,
  inspectProviderTransmissionApprovalArchive as frozenInspect,
} from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import {
  providerExecutionOperationDigest as v1Digest,
  versionedProviderExecutionOperationDigest as v2Digest,
} from "../../scripts/local-data-quality-provider-execution.mjs";
import {
  providerDigest as digest,
  providerRawDigest,
} from "../../scripts/local-data-quality-provider.mjs";
import { readFixedProviderConfiguration } from "./studio-plan-quality-provider-configuration-20260927-test-fixture";
import type { PlanPromptVersion } from "./studio-plan-prompt-versions";
const v1 = "plan-observation-v1",
  v2 = "plan-observation-v2";
const fixed = readFixedProviderConfiguration()!;
const data = fixture(executionBase());
const upper = data.upper(),
  binding = upper.records[0];
const base: Input = {
  identity: {
    runId: data.data.run.id,
    runDigest: data.data.run.runDigest,
    approvalBindingDigest: binding.recordDigest,
    preparedRequestId: randomUUID(),
    dispatchRequestId: randomUUID(),
  },
  inspectedAt: "2026-09-27T03:35:00.000Z",
  configuration: fixed,
  archive: upper,
  additionalUsedBytes: 0,
};
const legacy = generationDispatchFixture(fixed);
let input: Input;
const forbidden = vi.fn(() => {
  throw Error("No network");
});
function serverInput(value = input) {
  const { configuration: _, ...rest } = value;
  void _;
  return rest;
}
function result(value = input, version: PlanPromptVersion = v2) {
  return createServerProviderPolicyContext(version, fixed).prepareGenerationDispatch(
    serverInput(value),
  );
}
function plan(value = input, version: PlanPromptVersion = v2) {
  const r = result(value, version);
  if (r.status !== "prepared") throw Error(r.reason);
  return r.plan;
}
function refused(reason: string) {
  expect(result()).toEqual({ status: "refused", reason, plan: null });
}
beforeEach(() => {
  input = structuredClone(base);
  vi.stubGlobal("fetch", forbidden);
  forbidden.mockClear();
});
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("plans exact v2 r2/r3 commands and reaudits the complete archive without changing approval, budget or artifacts", () => {
  const before = structuredClone(input),
    p = plan();
  expect(input).toEqual(before);
  expect(p).toMatchObject({
    planVersion: 2,
    ownership: "new-commit-owner-required",
    dispatchAllowed: false,
    budgetWriteAllowed: false,
    transaction: "single-immediate-transaction-required",
    status: "prepared-not-committed",
  });
  expect(p.request.body).toEqual(data.preparation.generation.body);
  expect(p.request.rawBody).toBe(JSON.stringify(data.preparation.generation.body));
  expect(p.request.request.artifactSha256).toBe(providerRawDigest(p.request.rawBody));
  expect(p.request.request.contractDigest).toBe(
    binding.approvedReview.manifest.executionContract.contractDigest,
  );
  expect(
    p.rows.events.map((e) => [e.executionContractVersion, e.revision, e.payload.kind]),
  ).toEqual([
    [2, 2, "request-prepared"],
    [2, 3, "dispatch-intent"],
  ]);
  for (const [index, command] of [p.commands.prepared, p.commands.dispatch].entries()) {
    expect(p.rows.receipts[index].inputDigest).toBe(v2Digest(p.basis.runId, command));
    expect(p.rows.receipts[index].inputDigest).not.toBe(v1Digest(p.basis.runId, command));
  }
  input.archive.archive.ledger.events.push(...p.rows.events);
  input.archive.archive.ledger.receipts.push(...p.rows.receipts);
  const next = inspect(input.archive),
    snapshot = next.reservationArchive.ledger.provider.snapshots[0];
  expect(snapshot).toMatchObject({
    archiveFormatVersion: 5,
    revision: 3,
    state: "dispatching",
    dispatchIntentCount: 1,
    responseCount: 0,
    dispatchAllowed: false,
    canResume: false,
  });
  expect(input.archive.records).toEqual(before.archive.records);
  expect(input.archive.archive.records).toEqual(before.archive.archive.records);
  expect(input.archive.archive.ledger.budgetEvents).toEqual(
    before.archive.archive.ledger.budgetEvents,
  );
  expect(input.archive.archive.ledger.artifacts).toEqual(before.archive.archive.ledger.artifacts);
  expect(p.capacity.totalExposureBytes).toBe(
    next.reservationArchive.ledger.usedBytes +
      next.reservationArchive.ledger.reservedBytes +
      next.reservationArchive.usedBytes +
      next.usedBytes,
  );
  expect(() => frozenInspect(input.archive)).toThrow();
});
it("keeps v1 explicit/default complete plan bytes identical", () => {
  const expected = frozen(legacy.input);
  expect(expected.status).toBe("prepared");
  expect(JSON.stringify(prepare(v1, legacy.input))).toBe(JSON.stringify(expected));
  expect(JSON.stringify(result(legacy.input, v1))).toBe(JSON.stringify(expected));
});
it.each([v1, v2] as const)(
  "rejects the other version's valid approval when the server selects %s",
  (selected) => {
    const other = selected === v1 ? base : legacy.input;
    expect(result(other, selected)).toMatchObject({
      status: "refused",
      reason: "server-version-mismatch",
    });
  },
);
it("keeps the frozen v1 entry point closed to v2 history", () => {
  expect(frozen(input)).toMatchObject({ status: "refused", reason: "archive-invalid" });
});
it.each([undefined, null, "plan-observation-v3"])(
  "never defaults an unsupported explicit version %#",
  (selected) => {
    expect(() => prepare(selected as PlanPromptVersion, input)).toThrow();
    expect(() => createServerProviderPolicyContext(selected as PlanPromptVersion, fixed)).toThrow();
  },
);
it.each([
  "version",
  "engineVersion",
  "configuration",
  "contract",
  "tokenEvidence",
  "tokenAssessment",
  "dispatchAllowed",
])("rejects caller-controlled %s instead of treating it as server authority", (key) => {
  const server = createServerProviderPolicyContext(v2, fixed);
  expect(() => server.prepareGenerationDispatch({ ...serverInput(), [key]: true })).toThrow();
  if (key !== "configuration")
    expect(prepare(v2, { ...input, [key]: true })).toMatchObject({
      status: "refused",
      reason: "invalid-input",
    });
});
it.each(["version", "configuration", "tokenEvidence"])(
  "strictly rejects injected identity %s",
  (key) => {
    input.identity = { ...(input.identity as object), [key]: true };
    refused("invalid-input");
  },
);
it("snapshots server configuration and returns deeply detached immutable plans without wall clock use", () => {
  const c = structuredClone(fixed),
    server = createServerProviderPolicyContext(v2, c),
    request = serverInput();
  vi.spyOn(Date, "now").mockImplementation(() => {
    throw Error("No clock");
  });
  const first = server.prepareGenerationDispatch(request);
  expect(first.status).toBe("prepared");
  c.proposedBudget.capUnits = "1";
  const second = server.prepareGenerationDispatch(request);
  expect(second).toEqual(first);
  if (first.status !== "prepared") throw Error("fixture");
  expect(Object.isFrozen(first.plan.request.body.input)).toBe(true);
  expect(() => {
    first.plan.request.body.model = "changed";
  }).toThrow();
  const saved = JSON.stringify(first.plan);
  (request.identity as { runId: string }).runId = randomUUID();
  request.archive.records.splice(0);
  expect(JSON.stringify(first.plan)).toBe(saved);
});
it.each([1, 2])(
  "refuses already recorded %i-row execution prefixes, even under fresh nonces",
  (count) => {
    const p = plan();
    input.archive.archive.ledger.events.push(...p.rows.events.slice(0, count));
    input.archive.archive.ledger.receipts.push(...p.rows.receipts.slice(0, count));
    expect(() => inspect(input.archive)).not.toThrow();
    Object.assign(input.identity as object, {
      preparedRequestId: randomUUID(),
      dispatchRequestId: randomUUID(),
    });
    refused("first-generation-required");
  },
);
it.each(["before", "expiry"] as const)(
  "keeps the original approval's %s time boundary",
  (which) => {
    input.inspectedAt =
      which === "before"
        ? new Date(Date.parse(binding.recordedAt) - 1).toISOString()
        : binding.approvedReview.expiresAt;
    refused("approval-expired-or-future");
  },
);
it("accepts the exact original approval instant without extending its expiry", () => {
  input.inspectedAt = binding.recordedAt;
  expect(plan().expiresAt).toBe(binding.approvedReview.expiresAt);
});
it.each(["preparedRequestId", "dispatchRequestId"])("refuses global nonce reuse for %s", (key) => {
  (input.identity as Record<string, string>)[key] = binding.clientRequestId;
  refused("nonce-conflict");
});
it("counts all archive exposure at the exact shared capacity limit", () => {
  input.additionalUsedBytes = limits.databaseBytes - plan().capacity.totalExposureBytes;
  expect(plan().capacity.totalExposureBytes).toBe(limits.databaseBytes);
  input.additionalUsedBytes++;
  refused("capacity-exceeded");
});
it.each(["approval", "request", "receipt", "version"] as const)(
  "refuses corrupted %s history before creating rows",
  (kind) => {
    const ledger = input.archive.archive.ledger;
    if (kind === "approval") input.archive.records = [];
    if (kind === "request") {
      const artifact = ledger.artifacts[0] as { body: string; sha256: string; sizeBytes: number };
      artifact.body = artifact.body.replace("false", "true");
      artifact.sha256 = providerRawDigest(artifact.body);
      artifact.sizeBytes = Buffer.byteLength(artifact.body);
    }
    if (kind === "receipt")
      (ledger.receipts.at(-1) as { inputDigest: string }).inputDigest = "a".repeat(64);
    if (kind === "version") {
      const e = ledger.events[0] as Record<string, unknown>;
      e.executionContractVersion = 1;
      const { eventDigest: _, ...rest } = e;
      void _;
      e.eventDigest = digest(rest);
    }
    refused("archive-invalid");
  },
);
it("rejects a changed current server configuration while leaving original approval bytes intact", () => {
  const before = JSON.stringify(input.archive);
  const c = structuredClone(fixed);
  c.proposedBudget.capUnits = "30000000";
  expect(prepare(v2, { ...input, configuration: c })).toMatchObject({
    status: "refused",
    reason: "current-evidence-unavailable",
  });
  expect(JSON.stringify(input.archive)).toBe(before);
});
