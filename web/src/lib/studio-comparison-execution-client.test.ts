import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("Forbidden IO");
  }),
);
vi.mock("node:sqlite", forbidden);
vi.mock("openai", forbidden);
import { comparisonExecutionFixture } from "../../scripts/fixtures/comparison-execution";
import {
  createComparisonExecutionClient,
  executionAcknowledgements,
  executionAmount,
  executionStorageKey,
} from "./studio-comparison-execution-client";
const checks = Object.fromEntries(Object.keys(executionAcknowledgements).map((key) => [key, true]));
function setup() {
  const f = comparisonExecutionFixture(),
    memory = new Map<string, string>();
  const storage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value);
    },
    removeItem: (key: string) => {
      memory.delete(key);
    },
  };
  let mode = "valid",
    held: (() => void) | undefined;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), body });
    if (mode === "offline") throw Error("offline");
    if (mode === "hold")
      await new Promise<void>((resolve) => {
        held = resolve;
      });
    if (mode === "missing")
      return Response.json(
        { kind: "comparison-execution-error", code: "OPEN_UNAVAILABLE", runtimeObserved: false },
        { status: 503 },
      );
    if (String(url).endsWith("/preview")) return Response.json(f.preview);
    if (body.action === "open") return Response.json(f.session);
    if (body.action === "preview") return Response.json({ ...f.status, prepared: f.prepared });
    if (body.action === "execute")
      return Response.json({ ...f.status, status: "running", outcome: "pending" });
    if (body.action === "close")
      return Response.json({ ...f.status, status: "closed", closed: true });
    return Response.json(f.status);
  });
  const client = createComparisonExecutionClient(storage, fetcher);
  return {
    ...f,
    memory,
    storage,
    calls,
    client,
    fetcher,
    mode: (value: string) => {
      mode = value;
    },
    finish: () => held?.(),
  };
}
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
it("opens explicitly, validates exact original input/costs, requires all consents and sends once", async () => {
  const f = setup();
  expect(f.calls).toEqual([]);
  await f.client.open(f.company);
  await f.client.preview(f.company);
  expect(f.client.getSnapshot().input?.prepared.input.claimQuote).toBe(
    f.company.claimReviews[0].claimQuote,
  );
  await f.client.execute(f.company, {});
  expect(f.calls.filter((x) => x.body.action === "execute")).toHaveLength(0);
  await f.client.preview(f.company);
  await f.client.execute(f.company, checks);
  await f.client.execute(f.company, checks);
  expect(f.calls.filter((x) => x.body.action === "execute")).toHaveLength(1);
  expect(JSON.parse(f.memory.get(executionStorageKey)!)).toMatchObject({ attempted: true });
  expect(f.memory.get(executionStorageKey)).not.toContain("claimQuote");
});
it("lost open delivery reuses the persisted UUID, including after client recreation", async () => {
  const f = setup();
  f.mode("offline");
  await f.client.open(f.company);
  const first = f.calls[0].body;
  const restored = createComparisonExecutionClient(f.storage, f.fetcher);
  expect(f.calls).toHaveLength(1);
  f.mode("valid");
  await restored.open(f.company);
  expect(f.calls[1].body).toEqual(first);
});
it("an uncertain execute persists the attempt before fetch and permits status, never resends", async () => {
  const f = setup();
  await f.client.open(f.company);
  await f.client.preview(f.company);
  f.mode("offline");
  await f.client.execute(f.company, checks);
  f.mode("valid");
  const restored = createComparisonExecutionClient(f.storage, f.fetcher);
  await restored.open(f.company);
  await restored.execute(f.company, checks);
  await restored.command("inspect");
  expect(f.calls.filter((x) => x.body.action === "execute")).toHaveLength(1);
  expect(f.calls.at(-1)?.body.action).toBe("inspect");
});
it("concurrent clicks share the retained request and do not start additional IO", async () => {
  const f = setup();
  f.mode("hold");
  const opening = f.client.open(f.company);
  await f.client.open(f.company);
  expect(f.calls).toHaveLength(1);
  f.finish();
  await opening;
  expect(f.client.getSnapshot().busy).toBe(false);
});
it("company changes retain original routing and refuse a new company's preview", async () => {
  const f = setup();
  await f.client.open(f.company);
  const other = { ...f.company, id: crypto.randomUUID() };
  await f.client.open(other);
  await f.client.preview(other);
  await f.client.command("inspect");
  expect(f.calls).toHaveLength(2);
  expect(f.calls.every((x) => x.url.includes(f.company.id))).toBe(true);
});
it.each(["model", "identity", "binding", "expired", "retention"])(
  "rejects mismatched %s before consent",
  async (kind) => {
    const f = setup();
    await f.client.open(f.company);
    if (kind === "model") f.prepared.review.basis.model = "other";
    if (kind === "identity") f.prepared.review.identity.rawBodySha256 = "b".repeat(64);
    if (kind === "binding") f.status.companyId = crypto.randomUUID();
    if (kind === "expired") f.prepared.review.expiresAt = "2000-01-01T00:00:00.000Z";
    if (kind === "retention") f.prepared.reservation.retentionNoticeDigest = "b".repeat(64);
    await f.client.preview(f.company);
    await f.client.execute(f.company, checks);
    expect(f.client.getSnapshot().input).toBeNull();
    expect(f.calls.some((x) => x.body.action === "execute")).toBe(false);
  },
);
it("invalidates a late review when its screen changes, then requires a fresh review", async () => {
  const f = setup();
  await f.client.open(f.company);
  f.mode("hold");
  const pending = f.client.preview(f.company);
  f.client.invalidateReview();
  f.mode("valid");
  f.finish();
  await pending;
  expect(f.client.getSnapshot().input).toBeNull();
  await f.client.preview(f.company);
  expect(f.client.getSnapshot().input).not.toBeNull();
});
it("cannot release an unknown owner; explicit confirmed close or failed registration can release", async () => {
  const f = setup();
  await f.client.open(f.company);
  f.client.release();
  expect(f.memory.size).toBe(1);
  await f.client.preview(f.company);
  expect(f.client.getSnapshot().input).not.toBeNull();
  await f.client.command("close");
  expect(f.client.getSnapshot().input).toBeNull();
  await f.client.execute(f.company, checks);
  expect(f.calls.some((x) => x.body.action === "execute")).toBe(false);
  f.client.release();
  expect(f.memory.size).toBe(0);
  f.mode("missing");
  await f.client.open(f.company);
  expect(f.client.getSnapshot().registrationFailed).toBe(true);
  f.client.release();
  expect(f.memory.size).toBe(0);
});
it("storage refusal or corrupt saved routing blocks IO", async () => {
  const f = setup();
  vi.spyOn(f.storage, "setItem").mockImplementation(() => {
    throw Error("denied");
  });
  await f.client.open(f.company);
  expect(f.calls).toEqual([]);
  vi.restoreAllMocks();
  f.memory.set(executionStorageKey, "{}");
  await f.client.open(f.company);
  expect(f.calls).toEqual([]);
});
it("formats large monetary units without floating-point rounding", () => {
  expect(executionAmount("1250", 6)).toBe("0.001250");
  expect(executionAmount("999999999999999999999999999999", 2)).toBe(
    "9999999999999999999999999999.99",
  );
});

it("lost opinion delivery clears stale review and requires inspect then original recovery without write retry", async () => {
  const f = setup();
  await f.client.open(f.company);
  await f.client.command("postcapture-preview");
  f.mode("offline");
  await f.client.postcapture("record-result");
  expect(f.client.getSnapshot().status).toBeNull();
  f.mode("valid");
  await f.client.postcapture("record-result");
  expect(f.calls.filter((c) => c.body.action === "record-result")).toHaveLength(1);
  f.status.postcapture.record = "recovery-required";
  await f.client.command("inspect");
  await f.client.postcapture("record-result", true);
  expect(f.calls.at(-1)?.body).toEqual({
    action: "recover-postcapture",
    operation: "record-result",
  });
  expect(f.calls.filter((c) => c.body.action === "execute")).toHaveLength(0);
  expect(f.memory.get(executionStorageKey)).not.toContain("postcapture");
});
it("unknown cost and unrecorded opinion cannot settle; original snapshot is required", async () => {
  const f = setup();
  await f.client.open(f.company);
  await f.client.command("postcapture-preview");
  await f.client.postcapture("settle-finalize");
  f.status.postcapture.review.comparisonRecorded = true;
  f.status.postcapture.review.usageStatus = "unknown";
  await f.client.command("postcapture-preview");
  await f.client.postcapture("settle-finalize");
  expect(f.calls.filter((c) => c.body.action === "settle-finalize")).toHaveLength(0);
  f.status.postcapture.review.usageStatus = "known";
  await f.client.command("postcapture-preview");
  await f.client.postcapture("settle-finalize");
  expect(f.calls.at(-1)?.body).toEqual({
    action: "settle-finalize",
    reviewDigest: f.status.postcapture.review.reviewDigest,
  });
});
