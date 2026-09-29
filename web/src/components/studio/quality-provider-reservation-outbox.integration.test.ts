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
import type { CandidateRegistrySnapshot } from "@/lib/studio-plan-quality-candidate-registry-types";
import {
  providerReservationInspectionResponseSchema,
  type ProviderReservationInspectionResponse,
} from "@/lib/studio-plan-quality-provider-reservation-http-types";
import { POST as inspect } from "@/app/api/studio/quality/provider-reservation/inspect/route";
import { POST as adopt } from "@/app/api/studio/quality/provider-reservation/reservations/route";
import { GET as lookup } from "@/app/api/studio/quality/provider-reservation/requests/[clientRequestId]/route";
import {
  candidateRegistryCanonical as canonical,
  candidateRegistryDigest as digest,
} from "./quality-candidate-registry-ui";
import {
  ReservationOutbox,
  ReservationOutboxError,
  reservationOutboxKey,
  reservationOutboxLimits,
  decodeReservationJournal,
  browserReservationOutbox,
  type ReservationOutboxDependencies,
} from "./quality-provider-reservation-outbox";

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
  registry: CandidateRegistrySnapshot;
let view: Extract<ProviderReservationInspectionResponse, { status: "review" }>,
  outbox: ReservationOutbox;
let deps: ReservationOutboxDependencies, raw: string | null;
const ack = {
  candidate: true,
  budget: true,
  reservation: true,
  financial: true,
  retention: true,
  retry: true,
};
const origin = "http://127.0.0.1:3000";
async function routedFetch(url: string, init: RequestInit) {
  const request = new Request(origin + url, init);
  if (url.endsWith("/reservations")) return adopt(request);
  return lookup(request, { params: Promise.resolve({ clientRequestId: url.split("/").at(-1)! }) });
}
async function readView() {
  const result = providerReservationInspectionResponseSchema.parse(
    await (
      await inspect(
        new Request(origin + "/api/studio/quality/provider-reservation/inspect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            version: registry.version,
            versionDigest: registry.versionDigest,
            candidateId: registry.entries[0].candidateId,
          }),
        }),
      )
    ).json(),
  );
  if (result.status !== "review") throw new Error("Expected review");
  return result;
}
const count = () =>
  db.prepare("SELECT COUNT(*) AS n FROM quality_provider_reservation_bindings").get()!.n;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", service.forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-reservation-outbox-"));
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
  db.function("quality_storage_contract", () => "quality-v8");
  adoptReservationTestPolicy(store);
  view = await readView();
  raw = null;
  let locked = false;
  deps = {
    storage: {
      getItem: vi.fn((key) => {
        expect(key).toBe(reservationOutboxKey);
        return raw;
      }),
      setItem: vi.fn((key, value) => {
        expect(key).toBe(reservationOutboxKey);
        raw = value;
      }),
      removeItem: vi.fn(() => {
        raw = null;
      }),
    },
    exclusive: async (work) => {
      if (locked) throw new ReservationOutboxError("BUSY");
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
  outbox = new ReservationOutbox(deps);
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
  if (!rel.startsWith("venture-reservation-outbox-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});
it("persists and reads back the complete command before sending, then binds the real receipt", async () => {
  vi.mocked(deps.fetch).mockImplementation(async (url, init) => {
    const stored = await decodeReservationJournal(raw!);
    expect(stored.outcome.state).toBe("pending");
    expect(init.body).toBe(canonical(stored.request));
    expect(stored.commandDigest).toBe(await digest(stored.request.command));
    return routedFetch(url, init);
  });
  const result = await outbox.begin(view, registry, ack);
  expect(result.outcome.state).toBe("committed");
  expect(count()).toBe(1);
  expect(result.request.command.expectedPolicyHead).toEqual(view.review.policyHead);
  expect(result.request.approvedReview).toEqual(view.review);
  expect(await new ReservationOutbox(deps).read()).toEqual(result);
  await expect(outbox.begin(view, registry, ack)).rejects.toMatchObject({ code: "EXISTING" });
  expect(deps.fetch).toHaveBeenCalledTimes(1);
  await outbox.dismiss(result.request.command.clientRequestId);
  expect(await outbox.read()).toBeNull();
});
it.each([
  "candidate",
  "budget",
  "reservation",
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
  if (kind === "expired") vi.setSystemTime(Date.parse(view.review.policyReview.expiresAt));
  if (kind === "future") vi.setSystemTime(Date.parse(view.review.policyReview.inspectedAt) - 1);
  if (kind === "legacy") Object.assign(input, { responseVersion: 2 });
  if (kind === "tampered") input.review.policyHead.headDigest = "b".repeat(64);
  await expect(outbox.begin(input, registry, checks)).rejects.toMatchObject({ code: "REVIEW" });
  expect(raw).toBeNull();
  expect(deps.fetch).not.toHaveBeenCalled();
  expect(deps.uuid).not.toHaveBeenCalled();
});
it("allows dismissal of a directly observed first refusal, without changing the budget", async () => {
  adoptReservationTestPolicy(store, 1);
  const result = await outbox.begin(view, registry, ack);
  expect(result.outcome.state).toBe("refused");
  expect(count()).toBe(0);
  await outbox.dismiss(result.request.command.clientRequestId);
  view = await readView();
  const adopted = await outbox.begin(view, registry, ack);
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
    const pending = await outbox.begin(view, registry, ack);
    expect(pending.outcome.state).toBe("pending");
    const saved = raw;
    if (timing === "after") vi.setSystemTime("2035-01-01T00:00:00.000Z");
    outbox = new ReservationOutbox(deps);
    await expect(outbox.dismiss(pending.request.command.clientRequestId)).rejects.toMatchObject({
      code: "PENDING",
    });
    await expect(outbox.begin(view, registry, ack)).rejects.toMatchObject({ code: "EXISTING" });
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
  const pending = await outbox.begin(view, registry, ack),
    saved = raw;
  adoptReservationTestPolicy(store, 1);
  outbox = new ReservationOutbox(deps);
  const id = pending.request.command.clientRequestId;
  expect((await outbox.recover(id, "lookup")).outcome.state).toBe("pending");
  expect((await outbox.recover(id, "replay")).outcome.state).toBe("pending");
  expect(raw).toBe(saved);
  expect(count()).toBe(0);
  await expect(outbox.dismiss(id)).rejects.toMatchObject({ code: "PENDING" });
  await expect(outbox.begin(await readView(), registry, ack)).rejects.toMatchObject({
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
  const first = outbox.begin(view, registry, ack);
  await entered.promise;
  const secondTab = new ReservationOutbox(deps),
    pending = (await secondTab.read())!;
  try {
    await expect(secondTab.begin(view, registry, ack)).rejects.toMatchObject({ code: "BUSY" });
    await expect(outbox.begin(view, registry, ack)).rejects.toMatchObject({ code: "BUSY" });
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
    await expect(outbox.begin(view, registry, ack)).rejects.toMatchObject({ code: "STORAGE" });
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(count()).toBe(0);
    raw = null;
    await expect(outbox.begin(view, registry, ack)).rejects.toMatchObject({ code: "STORAGE" });
  },
);
it("leaves the original pending bytes when terminal persistence fails, then recovers by lookup", async () => {
  vi.mocked(deps.storage.setItem).mockImplementation((key, value) => {
    if (JSON.parse(value).outcome.state === "committed") throw new Error("Quota failure");
    expect(key).toBe(reservationOutboxKey);
    raw = value;
  });
  await expect(outbox.begin(view, registry, ack)).rejects.toMatchObject({ code: "STORAGE" });
  const pending = await decodeReservationJournal(raw!);
  expect(pending.outcome.state).toBe("pending");
  expect(count()).toBe(1);
  vi.mocked(deps.storage.setItem).mockImplementation((_, value) => {
    raw = value;
  });
  outbox = new ReservationOutbox(deps);
  expect(
    (await outbox.recover(pending.request.command.clientRequestId, "lookup")).outcome.state,
  ).toBe("committed");
});
it.each(["json", "digest", "request", "oversize"])(
  "blocks corrupted stored %s without overwriting or sending",
  async (kind) => {
    vi.mocked(deps.fetch).mockRejectedValueOnce(new Error("Lost"));
    const pending = await outbox.begin(view, registry, ack);
    if (kind === "json") raw = "{";
    else if (kind === "oversize") raw = " ".repeat(reservationOutboxLimits.bytes + 1);
    else {
      const value = JSON.parse(raw!);
      if (kind === "digest") value.journalDigest = "b".repeat(64);
      else value.request.command.clientRequestId = randomUUID();
      raw = JSON.stringify(value);
    }
    const saved = raw;
    outbox = new ReservationOutbox(deps);
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
  "time",
  "grant",
  "http",
  "delivery",
  "content-type",
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
      if (kind === "time") value.receipt.recordedAt = "2030-01-01T00:00:00.000Z";
      if (kind === "grant") value.receipt.dispatchAllowed = true;
      if (kind === "delivery") value.delivery = "lookup";
      if (kind === "oversize")
        return new Response(" ".repeat(reservationOutboxLimits.responseBytes + 1), {
          headers: { "content-type": "application/json" },
        });
      return new Response(JSON.stringify(value), {
        status: kind === "http" ? 409 : 200,
        headers: { "content-type": kind === "content-type" ? "text/html" : "application/json" },
      });
    });
    const pending = await outbox.begin(view, registry, ack);
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
  await expect(outbox.begin(view, registry, ack)).rejects.toMatchObject({ code: "CHANGED" });
  expect(raw).toBe("external storage replacement");
  expect(count()).toBe(1);
});
it("cannot dismiss a newer request with a stale request ID", async () => {
  adoptReservationTestPolicy(store, 1);
  const first = await outbox.begin(view, registry, ack);
  await outbox.dismiss(first.request.command.clientRequestId);
  vi.mocked(deps.fetch).mockRejectedValueOnce(new Error("Lost"));
  const second = await outbox.begin(await readView(), registry, ack),
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
  await expect(outbox.begin(view, registry, ack)).rejects.toMatchObject({ code: "STORAGE" });
  expect(() => browserReservationOutbox()).toThrowError(
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
  const first = outbox.begin(view, registry, ack);
  await entered.promise;
  await vi.advanceTimersByTimeAsync(reservationOutboxLimits.timeoutMs);
  const pending = await first;
  expect(pending.outcome.state).toBe("pending");
  expect(count()).toBe(0);
  expect(
    (await new ReservationOutbox(deps).recover(pending.request.command.clientRequestId, "replay"))
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
    const pending = await outbox.begin(view, registry, ack);
    expect(pending.outcome.state).toBe("pending");
    await expect(outbox.dismiss(pending.request.command.clientRequestId)).rejects.toMatchObject({
      code: "PENDING",
    });
  },
);
