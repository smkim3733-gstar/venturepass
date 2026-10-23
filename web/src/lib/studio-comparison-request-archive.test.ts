import { expect, it, vi } from "vitest";
import { z } from "zod";
vi.mock("server-only", () => ({}));
vi.mock("openai", () => {
  throw Error("SDK forbidden");
});
vi.mock("node:sqlite", () => {
  throw Error("SQL forbidden");
});
import {
  comparisonBookingFixture,
  comparisonCancellationFixture,
} from "../../scripts/fixtures/comparison-execution";
import { createBookingClient } from "./studio-comparison-booking-client";
import { createCancellationClient } from "./studio-comparison-cancellation-client";
import { createRequestArchive } from "./studio-comparison-request-archive";
import { comparisonRequestReferenceSchema } from "./studio-comparison-history-match";
import type { ReservationView } from "./studio-comparison-reservations-wire";
function setup(kind: "booking" | "cancellation") {
  const b = comparisonBookingFixture(),
    c = comparisonCancellationFixture();
  const f = kind === "booking" ? b : c,
    company = f.company;
  const selection = kind === "booking" ? b.booking.selection : c.cancellation.selection;
  const receipt = kind === "booking" ? b.receipt : c.cancellationReceipt;
  const original = {
    version: 1 as const,
    registrationId: crypto.randomUUID(),
    selection,
    attempted: true,
    requestReference: { clientRequestId: receipt.clientRequestId, runId: receipt.runId },
  };
  const key = "venturepass.comparison-" + kind + ".v1",
    data = new Map([[key, JSON.stringify(original)]]);
  const storage = {
    getItem: vi.fn((k: string) => data.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => {
      data.set(k, v);
    }),
    removeItem: vi.fn((k: string) => {
      data.delete(k);
    }),
  };
  const at = "2026-10-14T09:40:00.000Z",
    record = {
      clientRequestId: receipt.clientRequestId,
      commandDigest: receipt.commandDigest,
      recordedAt: at,
    };
  const view: ReservationView = {
    kind: "comparison-reservation-view" as const,
    companyId: company.id,
    companyRevision: company.revision,
    inspectedAt: at,
    input: { status: "not-configured" as const, runId: null },
    currentContextVerified: false as const,
    policiesVerified: false as const,
    transmissionAllowed: false as const,
    consentRecorded: false as const,
    runtimeObserved: false as const,
    reservations: [
      {
        runId: receipt.runId,
        companyRevision: company.revision,
        companyRevisionMatches: true,
        createdAt: at,
        expiresAt: "2026-10-14T10:00:00.000Z",
        reservationExpired: false,
        model: "synthetic",
        sectionKey: "problem",
        sectionTitle: "합성",
        currency: "USD",
        unitScale: 6,
        reservedUnits: "1250",
        latestEventKind: kind === "booking" ? ("reserved" as const) : ("finalized" as const),
        history: {
          reservation:
            kind === "booking" ? record : { ...record, clientRequestId: crypto.randomUUID() },
          cancellation: kind === "booking" ? null : { ...record, releasedUnits: "1250" },
          finalizedAt: kind === "booking" ? null : at,
        },
      },
    ],
  };
  let mode = "missing",
    inspectCount = 0,
    hook = () => {};
  const calls: string[] = [];
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "GET") {
      calls.push("catalog");
      hook();
      if (mode === "catalog-failed")
        return Response.json({ code: "CLEANUP_REQUIRED" }, { status: 409 });
      return Response.json(view);
    }
    const action = JSON.parse(String(init?.body)).action;
    calls.push(action);
    if (action !== "inspect") throw Error("mutation forbidden");
    inspectCount++;
    if (mode === "network") throw Error("lost network");
    if (mode === "live" || (mode === "returned" && inspectCount === 2))
      return Response.json({
        ...(kind === "booking" ? b.booking : c.cancellation),
        registrationId: original.registrationId,
        clientRequestId: receipt.clientRequestId,
        ...(kind === "booking" ? { runId: receipt.runId } : {}),
      });
    return Response.json({ code: "OWNER_UNAVAILABLE" }, { status: 404 });
  });
  const client =
    kind === "booking"
      ? createBookingClient(storage, fetcher)
      : createCancellationClient(storage, fetcher);
  return {
    kind,
    key,
    original,
    data,
    storage,
    view,
    client,
    company,
    calls,
    fetcher,
    mode: (v: string) => {
      mode = v;
    },
    hook: (f: () => void) => {
      hook = f;
    },
  };
}
it.each(["booking", "cancellation"] as const)(
  "%s atomically preserves confirmed routing and record, survives reload and performs no new write",
  async (kind) => {
    const f = setup(kind);
    await f.client.archiveConfirmed(f.company);
    expect(f.calls).toEqual(["inspect", "catalog", "inspect"]);
    const saved = JSON.parse(f.data.get(f.key)!);
    expect(saved).toMatchObject({
      version: 2,
      active: null,
      archives: [
        {
          original: f.original,
          evidence: { runId: f.original.requestReference.runId, companyId: f.company.id },
        },
      ],
    });
    expect(f.client.getSnapshot().routing).toBeNull();
    expect(f.client.getSnapshot().status).toBeNull();
    const fetcher = vi.fn(() => {
      throw Error("network forbidden");
    });
    const restored =
      kind === "booking"
        ? createBookingClient(f.storage, fetcher)
        : createCancellationClient(f.storage, fetcher);
    await restored.showArchives();
    expect(restored.getSnapshot().archives).toEqual(saved.archives);
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it.each([
  "live",
  "returned",
  "network",
  "catalog-failed",
  "mismatch",
  "run-mismatch",
  "legacy",
  "unattempted",
  "other-company",
  "invalidated",
  "storage",
])("archive retains original routing on %s", async (mode) => {
  const f = setup("cancellation"),
    before = f.data.get(f.key);
  f.mode(mode);
  if (mode === "mismatch")
    f.view.reservations[0].history.cancellation!.clientRequestId = crypto.randomUUID();
  if (mode === "run-mismatch")
    f.data.set(
      f.key,
      JSON.stringify({
        ...f.original,
        selection: { ...f.original.selection, runId: crypto.randomUUID() },
      }),
    );
  if (mode === "legacy") {
    const old = { ...f.original, requestReference: undefined };
    f.data.set(f.key, JSON.stringify(old));
  }
  if (mode === "unattempted")
    f.data.set(f.key, JSON.stringify({ ...f.original, attempted: false }));
  if (mode === "invalidated") f.hook(() => f.client.invalidate());
  if (mode === "storage") f.storage.setItem.mockImplementation(() => {});
  const expected = f.data.get(f.key);
  await f.client.archiveConfirmed(
    mode === "other-company" ? { ...f.company, id: crypto.randomUUID() } : f.company,
  );
  expect(f.data.get(f.key)).toBe(expected ?? before);
  expect(f.client.getSnapshot().routing).not.toBeNull();
  expect(f.client.getSnapshot().archives).toHaveLength(0);
  if (mode === "live") expect(f.client.getSnapshot().message).toContain("원래 서버 연결이 남아");
});
const routingSchema = z
  .object({
    version: z.literal(1),
    registrationId: z.string().uuid(),
    selection: z
      .object({ companyId: z.string().uuid(), companyRevision: z.number() })
      .passthrough(),
    attempted: z.boolean(),
    requestReference: comparisonRequestReferenceSchema.optional(),
  })
  .strict();
it("new active routing and normal close retain archives; capacity and corrupt records fail without eviction", async () => {
  const f = setup("booking");
  await f.client.archiveConfirmed(f.company);
  const journal = createRequestArchive(f.storage, f.key, routingSchema, "reservation"),
    saved = journal.load().archives;
  const next = { ...f.original, registrationId: crypto.randomUUID(), attempted: false };
  journal.save(next);
  expect(journal.load()).toEqual({ version: 2, active: next, archives: saved });
  journal.clear(next);
  expect(journal.load().archives).toEqual(saved);
  const full = Array.from({ length: 20 }, () => ({
    ...saved[0],
    original: { ...f.original, registrationId: crypto.randomUUID() },
  }));
  f.data.set(f.key, JSON.stringify({ version: 2, active: f.original, archives: full }));
  const before = f.data.get(f.key);
  expect(() => journal.archive(f.original, f.view)).toThrow(/FULL/);
  expect(f.data.get(f.key)).toBe(before);
  full[0].evidence = { ...full[0].evidence, runId: crypto.randomUUID() };
  f.data.set(f.key, JSON.stringify({ version: 2, active: f.original, archives: full }));
  expect(() => journal.load()).toThrow(/STORAGE/);
  expect(f.storage.removeItem).not.toHaveBeenCalled();
});
it("a changed active request during the fresh read cannot be removed", async () => {
  const f = setup("booking"),
    changed = { ...f.original, registrationId: crypto.randomUUID() };
  f.hook(() => f.data.set(f.key, JSON.stringify(changed)));
  await f.client.archiveConfirmed(f.company);
  expect(JSON.parse(f.data.get(f.key)!)).toEqual(changed);
});
