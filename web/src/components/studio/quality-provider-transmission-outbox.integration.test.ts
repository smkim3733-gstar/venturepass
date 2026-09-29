/** Browser journal + real local API/store, entirely synthetic temporary databases. */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlanQualityStore } from "@/lib/studio-plan-quality-store";
import { actualTestNow } from "@/lib/studio-plan-quality-actual-test-helpers";
import { adoptReservationTestPolicy } from "@/lib/studio-plan-quality-provider-reservation-store-test-helpers";
import { reserveTransmissionTestRun } from "@/lib/studio-plan-quality-provider-transmission-approval-store-test-helpers";
import type { ProviderSnapshot } from "@/lib/studio-plan-quality-provider-types";
import type { CandidateRegistrySnapshot } from "@/lib/studio-plan-quality-candidate-registry-types";
import {
  providerTransmissionInspectionResponseSchema,
  type ProviderTransmissionInspectionResponse,
} from "@/lib/studio-plan-quality-provider-transmission-http-types";
import { POST as inspect } from "@/app/api/studio/quality/provider-transmission/inspect/route";
import { POST as adopt } from "@/app/api/studio/quality/provider-transmission/approvals/route";
import { GET as lookup } from "@/app/api/studio/quality/provider-transmission/requests/[clientRequestId]/route";
import * as configuration from "@/lib/studio-plan-quality-provider-configuration";
import { providerTransmissionReviewDigestInput } from "@/lib/studio-plan-quality-provider-transmission-review-types";
import { providerDigest } from "../../../scripts/local-data-quality-provider.mjs";
import { providerExecutionOperationDigest } from "../../../scripts/local-data-quality-provider-execution.mjs";
import { policyOutboxKey, policyOutboxLock } from "./quality-provider-policy-outbox";
import { reservationOutboxKey, reservationOutboxLock } from "./quality-provider-reservation-outbox";
import {
  candidateRegistryCanonical as canonical,
  candidateRegistryDigest as digest,
} from "./quality-candidate-registry-ui";
import {
  TransmissionOutbox,
  TransmissionOutboxError,
  transmissionOutboxKey,
  transmissionOutboxLock,
  transmissionOutboxLimits,
  decodeTransmissionJournal,
  browserTransmissionOutbox,
  type TransmissionOutboxDependencies,
  type TransmissionJournal,
} from "./quality-provider-transmission-outbox";

vi.mock("server-only", () => ({}));
const service = vi.hoisted(() => ({
  store: null as PlanQualityStore | null,
  forbidden: vi.fn(() => {
    throw new Error("External access forbidden");
  }),
}));
vi.mock("@/lib/studio-plan-quality-store", async (original) => ({
  ...(await original<typeof import("@/lib/studio-plan-quality-store")>()),
  getPlanQualityStore: () => service.store!,
}));
vi.mock("openai", () => ({
  default: class {
    constructor() {
      service.forbidden();
    }
  },
}));
vi.mock("@/lib/studio-storage", () => ({
  getStudioStore: service.forbidden,
  StudioStore: service.forbidden,
}));
let directory: string,
  store: PlanQualityStore,
  db: DatabaseSync,
  snapshot: ProviderSnapshot,
  registry: CandidateRegistrySnapshot;
let view: Extract<ProviderTransmissionInspectionResponse, { status: "review" }>,
  outbox: TransmissionOutbox;
let deps: TransmissionOutboxDependencies, raw: string | null;
const ack = {
  external: true,
  currentPolicyAndBudget: true,
  generationAndReview: true,
  financial: true,
  retention: true,
  retry: true,
};
const origin = "http://127.0.0.1:3000";
async function routedFetch(url: string, init: RequestInit) {
  const request = new Request(origin + url, init);
  if (url.endsWith("/approvals")) return adopt(request);
  return lookup(request, { params: Promise.resolve({ clientRequestId: url.split("/").at(-1)! }) });
}
async function readView() {
  const result = providerTransmissionInspectionResponseSchema.parse(
    await (
      await inspect(
        new Request(origin + "/api/studio/quality/provider-transmission/inspect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            runId: snapshot.run.id,
            runDigest: snapshot.run.runDigest,
          }),
        }),
      )
    ).json(),
  );
  if (result.status !== "review") throw new Error("Expected review");
  return result;
}
const count = () =>
  db.prepare("SELECT COUNT(*) AS n FROM quality_provider_transmission_bindings").get()!.n;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", service.forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-transmission-outbox-"));
  writeFileSync(join(directory, "studio.sqlite"), "SYNTHETIC COMPANY SENTINEL");
  store = new PlanQualityStore(directory);
  service.store = store;
  registry = store.candidateRegistryRegister({
    expectedVersion: 0,
    clientRequestId: randomUUID(),
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  }).snapshot;
  db = new DatabaseSync(join(directory, "quality-evaluation", "quality.sqlite"));
  db.function("quality_storage_contract", () => "quality-v9");
  const reservation = reserveTransmissionTestRun(store);
  snapshot = store.providerGet(reservation.runId);
  view = await readView();
  raw = null;
  let locked = false;
  deps = {
    storage: {
      getItem: vi.fn((key) => {
        expect(key).toBe(transmissionOutboxKey);
        return raw;
      }),
      setItem: vi.fn((key, value) => {
        expect(key).toBe(transmissionOutboxKey);
        raw = value;
      }),
      removeItem: vi.fn((key) => {
        expect(key).toBe(transmissionOutboxKey);
        raw = null;
      }),
    },
    exclusive: async (work) => {
      if (locked) throw new TransmissionOutboxError("BUSY");
      locked = true;
      try {
        return await work();
      } finally {
        locked = false;
      }
    },
    fetch: vi.fn(routedFetch),
    now: () => new Date().toISOString(),
    uuid: vi.fn(randomUUID),
  };
  outbox = new TransmissionOutbox(deps);
}, 15000);
afterEach(() => {
  expect(service.forbidden).not.toHaveBeenCalled();
  expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe("SYNTHETIC COMPANY SENTINEL");
  db.close();
  store.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  const rel = relative(resolve(tmpdir()), resolve(directory));
  if (!rel.startsWith("venture-transmission-outbox-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});
it("persists and reads back the complete command before sending, then binds the real receipt", async () => {
  const budget = store.providerBudgetGet("production");
  vi.mocked(deps.fetch).mockImplementation(async (url, init) => {
    const stored = await decodeTransmissionJournal(raw!);
    expect(stored.outcome.state).toBe("pending");
    expect(init.body).toBe(canonical(stored.request));
    expect(stored.commandDigest).toBe(await digest(stored.request.command));
    return routedFetch(url, init);
  });
  const result = await outbox.begin(view, registry, snapshot, ack);
  expect(result.outcome.state).toBe("committed");
  expect(count()).toBe(1);
  expect(result.request.command.expectedPolicyHead).toEqual(view.review.policy.head);
  expect(result.request.approvedReview).toEqual(view.review);
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(store.providerGet(snapshot.run.id)).toMatchObject({
    state: "approved",
    revision: 1,
    actualAiCalls: null,
    dispatchIntentCount: 0,
    responseCount: 0,
    dispatchAllowed: false,
  });
  expect(await new TransmissionOutbox(deps).read()).toEqual(result);
  await expect(outbox.begin(view, registry, snapshot, ack)).rejects.toMatchObject({
    code: "EXISTING",
  });
  expect(deps.fetch).toHaveBeenCalledTimes(1);
  await outbox.dismiss(result.request.command.clientRequestId);
  expect(await outbox.read()).toBeNull();
});
it.each([
  "external",
  "currentPolicyAndBudget",
  "generationAndReview",
  "financial",
  "retention",
  "retry",
  "expired",
  "legacy",
  "tampered",
  "future",
])("does not persist or send %s without a current reviewed confirmation", async (kind) => {
  const input = structuredClone(view);
  const checks = { ...ack };
  if (kind in checks) checks[kind as keyof typeof checks] = false;
  if (kind === "expired") vi.setSystemTime(Date.parse(view.review.expiresAt));
  if (kind === "future") vi.setSystemTime(Date.parse(view.review.inspectedAt) - 1);
  if (kind === "legacy") Object.assign(input, { responseVersion: 2 });
  if (kind === "tampered") input.review.policy.head.headDigest = "b".repeat(64);
  await expect(outbox.begin(input, registry, snapshot, checks)).rejects.toMatchObject({
    code: "REVIEW",
  });
  expect(raw).toBeNull();
  expect(deps.fetch).not.toHaveBeenCalled();
  expect(deps.uuid).not.toHaveBeenCalled();
});
it("allows dismissal of a directly observed first refusal, without changing the budget", async () => {
  // Another candidate changes the global policy head but preserves this run's selected reference.
  adoptReservationTestPolicy(store, 1);
  const result = await outbox.begin(view, registry, snapshot, ack);
  expect(result.outcome.state).toBe("refused");
  expect(count()).toBe(0);
  await outbox.dismiss(result.request.command.clientRequestId);
  view = await readView();
  const adopted = await outbox.begin(view, registry, snapshot, ack);
  expect(adopted.outcome.state).toBe("committed");
  expect(adopted.request.command).not.toHaveProperty("initialBudgetRequestId");
  expect(adopted.request.command).not.toHaveProperty("budgetAction");
  expect(store.providerBudgetGet("production").capUnits).toBe("15000000");
});
it.each(["before", "after"])(
  "recovers a lost %s-commit response after page restart with the same command",
  async (timing) => {
    let originalBody: unknown;
    vi.mocked(deps.fetch).mockImplementationOnce(async (url, init) => {
      originalBody = init.body;
      if (timing === "after") await routedFetch(url, init);
      throw new Error("Lost response");
    });
    const pending = await outbox.begin(view, registry, snapshot, ack);
    expect(pending.outcome.state).toBe("pending");
    const saved = raw;
    if (timing === "after") vi.setSystemTime("2035-01-01T00:00:00.000Z");
    outbox = new TransmissionOutbox(deps);
    await expect(outbox.dismiss(pending.request.command.clientRequestId)).rejects.toMatchObject({
      code: "PENDING",
    });
    await expect(outbox.begin(view, registry, snapshot, ack)).rejects.toMatchObject({
      code: "EXISTING",
    });
    const seen = await outbox.recover(pending.request.command.clientRequestId, "lookup");
    expect(seen.outcome.state).toBe(timing === "after" ? "committed" : "pending");
    if (timing === "before") {
      expect(raw).toBe(saved);
      vi.mocked(deps.fetch).mockImplementationOnce(async (url, init) => {
        expect(init.body).toBe(originalBody);
        return routedFetch(url, init);
      });
      expect(
        (await outbox.recover(pending.request.command.clientRequestId, "replay")).outcome.state,
      ).toBe("committed");
    }
    expect(count()).toBe(1);
    expect(deps.uuid).toHaveBeenCalledTimes(1);
  },
);
it("keeps a previously unknown request pending after not-observed and a later definite refusal", async () => {
  vi.mocked(deps.fetch).mockRejectedValueOnce(new Error("Network unavailable"));
  const pending = await outbox.begin(view, registry, snapshot, ack),
    saved = raw;
  adoptReservationTestPolicy(store, 1);
  outbox = new TransmissionOutbox(deps);
  const id = pending.request.command.clientRequestId;
  expect((await outbox.recover(id, "lookup")).outcome.state).toBe("pending");
  expect((await outbox.recover(id, "replay")).outcome.state).toBe("pending");
  expect(raw).toBe(saved);
  expect(count()).toBe(0);
  await expect(outbox.dismiss(id)).rejects.toMatchObject({ code: "PENDING" });
  await expect(outbox.begin(await readView(), registry, snapshot, ack)).rejects.toMatchObject({
    code: "EXISTING",
  });
});
it("holds one lock across persistence and network, refusing a second tab and double click", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  vi.mocked(deps.fetch).mockImplementationOnce(async (url, init) => {
    entered.resolve();
    await release.promise;
    return routedFetch(url, init);
  });
  const first = outbox.begin(view, registry, snapshot, ack);
  await entered.promise;
  const secondTab = new TransmissionOutbox(deps),
    pending = (await secondTab.read())!;
  try {
    await expect(secondTab.begin(view, registry, snapshot, ack)).rejects.toMatchObject({
      code: "BUSY",
    });
    await expect(outbox.begin(view, registry, snapshot, ack)).rejects.toMatchObject({
      code: "BUSY",
    });
    await expect(
      secondTab.recover(pending.request.command.clientRequestId, "lookup"),
    ).rejects.toMatchObject({ code: "BUSY" });
    expect(deps.fetch).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve();
  }
  expect((await first).outcome.state).toBe("committed");
  expect((await secondTab.read())!.outcome.state).toBe("committed");
  expect(count()).toBe(1);
});
it.each(["throw", "after-write-throw", "read-back"])(
  "sends nothing when initial persistence fails: %s",
  async (kind) => {
    vi.mocked(deps.storage.setItem).mockImplementationOnce((_key, value) => {
      if (kind === "after-write-throw") raw = value;
      if (kind === "read-back") {
        raw = "{}";
        return;
      }
      throw new Error("Storage unavailable");
    });
    await expect(outbox.begin(view, registry, snapshot, ack)).rejects.toMatchObject({
      code: "STORAGE",
    });
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(count()).toBe(0);
    raw = null;
    await expect(outbox.begin(view, registry, snapshot, ack)).rejects.toMatchObject({
      code: "STORAGE",
    });
  },
);
it("leaves the original pending bytes when terminal persistence fails, then recovers by lookup", async () => {
  vi.mocked(deps.storage.setItem).mockImplementation((key, value) => {
    if (JSON.parse(value).outcome.state === "committed") throw new Error("Quota failure");
    expect(key).toBe(transmissionOutboxKey);
    raw = value;
  });
  await expect(outbox.begin(view, registry, snapshot, ack)).rejects.toMatchObject({
    code: "STORAGE",
  });
  const pending = await decodeTransmissionJournal(raw!);
  expect(pending.outcome.state).toBe("pending");
  expect(count()).toBe(1);
  vi.mocked(deps.storage.setItem).mockImplementation((_, value) => {
    raw = value;
  });
  outbox = new TransmissionOutbox(deps);
  expect(
    (await outbox.recover(pending.request.command.clientRequestId, "lookup")).outcome.state,
  ).toBe("committed");
});
it.each(["json", "digest", "request", "oversize"])(
  "blocks corrupted stored %s without overwriting or sending",
  async (kind) => {
    vi.mocked(deps.fetch).mockRejectedValueOnce(new Error("Lost"));
    const pending = await outbox.begin(view, registry, snapshot, ack);
    if (kind === "json") raw = "{";
    else if (kind === "oversize") raw = " ".repeat(transmissionOutboxLimits.bytes + 1);
    else {
      const value = JSON.parse(raw!);
      if (kind === "digest") value.journalDigest = "b".repeat(64);
      else value.request.command.clientRequestId = randomUUID();
      raw = JSON.stringify(value);
    }
    const saved = raw;
    outbox = new TransmissionOutbox(deps);
    await expect(outbox.read()).rejects.toMatchObject({ code: "CORRUPT" });
    await expect(
      outbox.recover(pending.request.command.clientRequestId, "replay"),
    ).rejects.toMatchObject({ code: "CORRUPT" });
    expect(raw).toBe(saved);
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(count()).toBe(0);
  },
);
it.each([
  "commandDigest",
  "nonce",
  "reviewDigest",
  "runId",
  "runDigest",
  "recordDigest",
  "executionInputDigest",
  "approvalEventDigest",
  "approvalRevision",
  "time",
  "earlier-time",
  "in-range-time",
  "grant",
  "budget-grant",
  "http",
  "other-success-http",
  "delivery",
  "content-type",
  "extra-field",
  "utf8",
  "declared-size",
  "invalid-length",
  "oversize",
])(
  "retains pending state for a mismatched %s receipt and recovers the real result",
  async (kind) => {
    vi.mocked(deps.fetch).mockImplementationOnce(async (url, init) => {
      const response = await routedFetch(url, init),
        value = await response.json();
      if (kind === "commandDigest") value.receipt.commandDigest = "b".repeat(64);
      if (kind === "nonce") value.receipt.clientRequestId = randomUUID();
      if (kind === "reviewDigest") value.receipt.approvedReviewDigest = "b".repeat(64);
      if (
        ["runDigest", "recordDigest", "executionInputDigest", "approvalEventDigest"].includes(kind)
      )
        value.receipt[kind] = "b".repeat(64);
      if (kind === "runId") value.receipt.runId = randomUUID();
      if (kind === "approvalRevision") value.receipt.approvalRevision = 2;
      if (kind === "time") value.receipt.recordedAt = "2030-01-01T00:00:00.000Z";
      if (kind === "earlier-time")
        value.receipt.recordedAt = new Date(Date.parse(view.review.inspectedAt) - 1).toISOString();
      if (kind === "in-range-time")
        value.receipt.recordedAt = new Date(Date.parse(view.review.inspectedAt) + 1).toISOString();
      if (kind === "grant") value.receipt.dispatchAllowed = true;
      if (kind === "budget-grant") value.receipt.budgetWriteAllowed = true;
      if (kind === "delivery") value.delivery = "lookup";
      if (kind === "extra-field") value.receipt.permission = true;
      if (kind === "utf8")
        return new Response(new Uint8Array([0xff]), {
          headers: { "content-type": "application/json" },
        });
      if (kind === "oversize")
        return new Response(" ".repeat(transmissionOutboxLimits.responseBytes + 1), {
          headers: { "content-type": "application/json" },
        });
      return new Response(JSON.stringify(value), {
        status: kind === "http" ? 409 : kind === "other-success-http" ? 201 : 200,
        headers: {
          "content-type": kind === "content-type" ? "text/html" : "application/json",
          ...(kind === "declared-size"
            ? { "content-length": String(transmissionOutboxLimits.responseBytes + 1) }
            : {}),
          ...(kind === "invalid-length" ? { "content-length": "invalid" } : {}),
        },
      });
    });
    const pending = await outbox.begin(view, registry, snapshot, ack);
    expect(pending.outcome.state).toBe("pending");
    expect(count()).toBe(1);
    expect(
      (await outbox.recover(pending.request.command.clientRequestId, "lookup")).outcome.state,
    ).toBe("committed");
  },
);
it("does not overwrite changed storage when an old response arrives", async () => {
  vi.mocked(deps.fetch).mockImplementationOnce(async (url, init) => {
    const response = await routedFetch(url, init);
    raw = "external storage replacement";
    return response;
  });
  await expect(outbox.begin(view, registry, snapshot, ack)).rejects.toMatchObject({
    code: "CHANGED",
  });
  expect(raw).toBe("external storage replacement");
  expect(count()).toBe(1);
});
it("cannot dismiss a newer request with a stale request ID", async () => {
  adoptReservationTestPolicy(store, 1);
  const first = await outbox.begin(view, registry, snapshot, ack);
  await outbox.dismiss(first.request.command.clientRequestId);
  vi.mocked(deps.fetch).mockRejectedValueOnce(new Error("Lost"));
  const second = await outbox.begin(await readView(), registry, snapshot, ack),
    saved = raw;
  await expect(outbox.dismiss(first.request.command.clientRequestId)).rejects.toMatchObject({
    code: "CHANGED",
  });
  expect(raw).toBe(saved);
  expect(second.outcome.state).toBe("pending");
});
it("handles read denial and unsupported browser capabilities without sending", async () => {
  vi.mocked(deps.storage.getItem).mockImplementation(() => {
    throw new Error("Denied");
  });
  await expect(outbox.read()).rejects.toMatchObject({ code: "STORAGE" });
  await expect(outbox.begin(view, registry, snapshot, ack)).rejects.toMatchObject({
    code: "STORAGE",
  });
  expect(() => browserTransmissionOutbox()).toThrowError(
    expect.objectContaining({ code: "UNSUPPORTED" }),
  );
  expect(deps.fetch).not.toHaveBeenCalled();
});
it("times out without clearing the command and releases the lock for exact recovery", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const entered = Promise.withResolvers<void>();
  vi.mocked(deps.fetch).mockImplementationOnce(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        entered.resolve();
        init.signal!.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
      }),
  );
  const first = outbox.begin(view, registry, snapshot, ack);
  await entered.promise;
  await vi.advanceTimersByTimeAsync(transmissionOutboxLimits.timeoutMs);
  const pending = await first;
  expect(pending.outcome.state).toBe("pending");
  expect(count()).toBe(0);
  expect(
    (await new TransmissionOutbox(deps).recover(pending.request.command.clientRequestId, "replay"))
      .outcome.state,
  ).toBe("committed");
  expect(deps.uuid).toHaveBeenCalledTimes(1);
});
it.each(["missing-id", "wrong-id", "http"])(
  "does not treat an unbound %s refusal as terminal",
  async (kind) => {
    vi.mocked(deps.fetch).mockImplementationOnce(async (_url, init) => {
      const id = JSON.parse(String(init.body)).command.clientRequestId;
      return Response.json(
        {
          responseVersion: 1,
          state: "refused",
          clientRequestId: kind === "missing-id" ? null : kind === "wrong-id" ? randomUUID() : id,
          code: "INVALID_INPUT",
          error: "not a trusted resolution",
        },
        { status: kind === "http" ? 200 : 409 },
      );
    });
    const pending = await outbox.begin(view, registry, snapshot, ack);
    expect(pending.outcome.state).toBe("pending");
    await expect(outbox.dismiss(pending.request.command.clientRequestId)).rejects.toMatchObject({
      code: "PENDING",
    });
  },
);

it.each(["before", "after"])(
  "keeps the original journal across a real %s-COMMIT error",
  async (phase) => {
    const exec = DatabaseSync.prototype.exec;
    let injected = false;
    const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (sql === "COMMIT" && !injected) {
        injected = true;
        if (phase === "after") exec.call(this, sql);
        throw new Error("Synthetic COMMIT interruption");
      }
      return exec.call(this, sql);
    });
    const pending = await outbox.begin(view, registry, snapshot, ack);
    spy.mockRestore();
    expect(injected).toBe(true);
    expect(pending.outcome.state).toBe("pending");
    expect(count()).toBe(phase === "after" ? 1 : 0);
    const saved = raw,
      id = pending.request.command.clientRequestId;
    store.close();
    store = new PlanQualityStore(directory);
    service.store = store;
    if (phase === "after") {
      vi.setSystemTime("2035-01-01T00:00:00.000Z");
      vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(() => {
        throw new Error("Must not read current configuration");
      });
    }
    const reopened = new TransmissionOutbox(deps);
    const observed = await reopened.recover(id, "lookup");
    expect(observed.outcome.state).toBe(phase === "after" ? "committed" : "pending");
    if (phase === "before") expect(raw).toBe(saved);
    expect((await reopened.recover(id, "replay")).outcome.state).toBe("committed");
    expect(count()).toBe(1);
    expect(deps.uuid).toHaveBeenCalledTimes(1);
  },
);

it("preserves an expired unobserved request after reopening and later refusals", async () => {
  vi.mocked(deps.fetch).mockRejectedValueOnce(new Error("Unobserved"));
  const pending = await outbox.begin(view, registry, snapshot, ack),
    saved = raw;
  vi.setSystemTime(view.review.expiresAt);
  const reopened = new TransmissionOutbox(deps),
    id = pending.request.command.clientRequestId;
  expect(await reopened.read()).toEqual(pending);
  expect((await reopened.recover(id, "lookup")).outcome.state).toBe("pending");
  expect((await reopened.recover(id, "replay")).outcome.state).toBe("pending");
  expect(raw).toBe(saved);
  expect(count()).toBe(0);
  await expect(reopened.dismiss(id)).rejects.toMatchObject({ code: "PENDING" });
  expect(deps.uuid).toHaveBeenCalledTimes(1);
});

it.each([
  "runId",
  "runDigest",
  "archive",
  "coverage",
  "reservation",
  "manifest",
  "snapshot",
  "policy",
  "budget",
  "retention",
  "approvedAt",
  "nested-manifest",
  "nested-contract",
  "nested-usage",
  "financial",
])("rejects rehashed stored %s mismatches before network or overwrite", async (kind) => {
  vi.mocked(deps.fetch).mockRejectedValueOnce(new Error("Unobserved"));
  const pending = await outbox.begin(view, registry, snapshot, ack);
  const journal: TransmissionJournal = JSON.parse(raw!);
  const c = journal.request.command,
    r = journal.request.approvedReview,
    bad = "b".repeat(64);
  if (kind === "runId") c.runId = randomUUID();
  if (kind === "runDigest") c.runDigest = bad;
  if (kind === "archive") c.expectedArchiveDigest = bad;
  if (kind === "coverage") c.expectedCoverageDigest = bad;
  if (kind === "reservation") c.expectedReservationBindingDigest = bad;
  if (kind === "manifest") c.expectedManifestDigest = bad;
  if (kind === "snapshot") c.expectedRun.snapshotDigest = bad;
  if (kind === "policy") c.expectedPolicyReference.clientRequestId = randomUUID();
  if (kind === "budget") c.expectedBudgetHead.headDigest = bad;
  if (kind === "retention") c.approval.acknowledgedRetentionNoticeDigest = bad;
  if (kind === "approvedAt") c.approval.approvedAt = r.expiresAt;
  if (kind === "nested-manifest") {
    r.manifest.manifestDigest = bad;
    c.expectedManifestDigest = bad;
  }
  if (kind === "nested-contract") r.manifest.executionContract.contractDigest = bad;
  if (kind === "nested-usage") r.manifest.executionContract.usagePolicyDigest = bad;
  if (kind === "financial") r.financialBasis.evidence.context.authority.documentDigest = bad;
  r.reviewDigest = await digest(providerTransmissionReviewDigestInput(r));
  c.approvedReviewDigest = r.reviewDigest;
  journal.commandDigest = await digest(c);
  const { journalDigest: _discarded, ...body } = journal;
  void _discarded;
  raw = canonical({ ...body, journalDigest: await digest(body) });
  const saved = raw;
  const reopened = new TransmissionOutbox(deps);
  await expect(reopened.read()).rejects.toMatchObject({ code: "CORRUPT" });
  await expect(
    reopened.recover(pending.request.command.clientRequestId, "replay"),
  ).rejects.toMatchObject({ code: "CORRUPT" });
  expect(raw).toBe(saved);
  expect(deps.fetch).toHaveBeenCalledTimes(1);
  expect(count()).toBe(0);
});

it("rejects a rehashed stored receipt linked to a different event", async () => {
  const journal = await outbox.begin(view, registry, snapshot, ack);
  if (journal.outcome.state !== "committed") throw new Error("Expected commit");
  journal.outcome.receipt.approvalEventDigest = "b".repeat(64);
  const { journalDigest: _discarded, ...body } = journal;
  void _discarded;
  raw = canonical({ ...body, journalDigest: await digest(body) });
  await expect(new TransmissionOutbox(deps).read()).rejects.toMatchObject({ code: "CORRUPT" });
});

it("does not accept another valid review's record even when native identity and echoed command match", async () => {
  vi.setSystemTime(Date.parse(actualTestNow) + 1);
  const newer = await readView();
  expect(newer.review.reviewDigest).not.toBe(view.review.reviewDigest);
  vi.mocked(deps.fetch).mockImplementationOnce(async (_url, init) => {
    const original: TransmissionJournal["request"] = JSON.parse(String(init.body));
    const alternate = structuredClone(original);
    alternate.command.approvedReviewDigest = newer.review.reviewDigest;
    alternate.approvedReview = newer.review;
    const response = await adopt(
      new Request(origin + "/api/studio/quality/provider-transmission/approvals", {
        ...init,
        body: canonical(alternate),
      }),
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    const record = store.providerTransmissionApprovalLookup(original.command.clientRequestId);
    if (record.state !== "committed") throw new Error("Expected stored record");
    const event = store.providerGet(snapshot.run.id).events[0];
    if (event.payload.kind !== "transmission-approved") throw new Error("Expected approval event");
    expect(result.receipt.executionInputDigest).toBe(
      providerExecutionOperationDigest(original.command.runId, {
        clientRequestId: original.command.clientRequestId,
        expectedRevision: 0,
        payload: event.payload,
      }),
    );
    // Spoofed summary fields cannot hide the record's different full original review.
    result.receipt.commandDigest = providerDigest(original.command);
    result.receipt.approvedReviewDigest = original.command.approvedReviewDigest;
    return Response.json(result);
  });
  const pending = await outbox.begin(view, registry, snapshot, ack),
    saved = raw;
  expect(pending.outcome.state).toBe("pending");
  expect(count()).toBe(1);
  const id = pending.request.command.clientRequestId;
  expect((await outbox.recover(id, "lookup")).outcome.state).toBe("pending");
  expect((await outbox.recover(id, "replay")).outcome.state).toBe("pending");
  expect(raw).toBe(saved);
});

it("keeps the lock through terminal persistence and isolates the other two journals", async () => {
  const saved = new Map([
    [policyOutboxKey, "policy sentinel"],
    [reservationOutboxKey, "reservation sentinel"],
  ]);
  let locked = false;
  const request = vi.fn(
    async (_name: string, _options: unknown, work: (lock: object | null) => Promise<unknown>) => {
      expect(_name).toBe(transmissionOutboxLock);
      expect(_options).toEqual({ mode: "exclusive", ifAvailable: true });
      if (locked) return work(null);
      locked = true;
      try {
        return await work({});
      } finally {
        locked = false;
      }
    },
  );
  let competitor: Promise<unknown> | undefined;
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (JSON.parse(value).outcome.state === "committed")
        competitor = browserTransmissionOutbox()
          .recover(JSON.parse(value).request.command.clientRequestId, "lookup")
          .catch((error) => error.code);
      saved.set(key, value);
    },
    removeItem: (key: string) => {
      saved.delete(key);
    },
  };
  vi.stubGlobal("window", { isSecureContext: true, localStorage: storage });
  vi.stubGlobal("navigator", { locks: { request } });
  vi.stubGlobal("fetch", routedFetch);
  const browser = browserTransmissionOutbox();
  const result = await browser.begin(view, registry, snapshot, ack);
  expect(result.outcome.state).toBe("committed");
  expect(await competitor).toBe("BUSY");
  await browser.dismiss(result.request.command.clientRequestId);
  expect(saved).toEqual(
    new Map([
      [policyOutboxKey, "policy sentinel"],
      [reservationOutboxKey, "reservation sentinel"],
    ]),
  );
  expect(new Set([policyOutboxLock, reservationOutboxLock, transmissionOutboxLock]).size).toBe(3);
});

it("keeps a successful response pending if it arrives after the timeout", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.mocked(deps.fetch).mockImplementationOnce(async (url, init) => {
    const response = await routedFetch(url, init);
    await vi.advanceTimersByTimeAsync(transmissionOutboxLimits.timeoutMs);
    return response;
  });
  const pending = await outbox.begin(view, registry, snapshot, ack);
  expect(pending.outcome.state).toBe("pending");
  expect(count()).toBe(1);
  expect(
    (await outbox.recover(pending.request.command.clientRequestId, "lookup")).outcome.state,
  ).toBe("committed");
});
