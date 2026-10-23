import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("node:sqlite", () => {
  throw Error("SQL forbidden");
});
vi.mock("openai", () => {
  throw Error("SDK forbidden");
});
import { comparisonBookingFixture } from "../../scripts/fixtures/comparison-execution";
import { createBookingHttpServer } from "./studio-comparison-booking-http";
import { createBookingClient } from "./studio-comparison-booking-client";
import { bookingConsents, type BookingState } from "./studio-comparison-booking-wire";
import type { createComparisonReservationBooking } from "./studio-comparison-reservation-booking";
const origin = "http://127.0.0.1:30331";
function fixture() {
  const f = comparisonBookingFixture();
  let state: BookingState = { ...f.booking };
  const owner = {
    inspect: vi.fn(() => ({
      ...state,
      kind: undefined,
      registrationId: undefined,
      selection: undefined,
      review: undefined,
    })),
    review: vi.fn(() => f.rawReview),
    reserve: vi.fn(() => {
      state = {
        ...state,
        status: "recorded",
        receipt: f.receipt,
        clientRequestId: f.receipt.clientRequestId,
        runId: f.receipt.runId,
      };
    }),
    recover: vi.fn(),
    revoke: vi.fn(),
    close: vi.fn(() => {
      state = { ...state, status: "closed", retained: false };
    }),
  };
  owner.inspect.mockImplementation(() => {
    const { kind, registrationId, selection, review, ...result } = state;
    void kind;
    void registrationId;
    void selection;
    void review;
    return result as ReturnType<typeof owner.inspect>;
  });
  owner.review.mockImplementation(() => {
    state = {
      ...state,
      status: "review",
      retained: true,
      clientRequestId: f.receipt.clientRequestId,
      runId: f.receipt.runId,
    };
    return f.rawReview;
  });
  const server = createBookingHttpServer(),
    open = vi.fn(() => owner as unknown as ReturnType<typeof createComparisonReservationBooking>);
  const url = origin + `/api/studio/cases/${f.company.id}/public-claim-comparison/booking`;
  const consent = {
    reviewDigest: f.review.reviewDigest,
    ...Object.fromEntries(bookingConsents.map(([key]) => [key, true])),
  };
  async function call(
    body: unknown,
    init: RequestInit = {},
    id: string = f.booking.registrationId,
  ) {
    const request = new Request(url, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        "x-venturepass-comparison-booking": id,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
      ...init,
    });
    const op = server.handle(request, f.company.id, open);
    const response = await op.response;
    await op.completion;
    return { response, value: await response.json() };
  }
  const start = () => call({ action: "open", selection: f.booking.selection });
  return { ...f, owner, open, server, call, start, consent };
}
afterEach(() => vi.restoreAllMocks());
it("booking HTTP waits for exact body EOF before opening and abort releases the original reader", async () => {
  const f = fixture();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn(),
    controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      stream = c;
    },
    cancel,
  });
  const request = new Request(
    origin + `/api/studio/cases/${f.company.id}/public-claim-comparison/booking`,
    {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        "x-venturepass-comparison-booking": f.booking.registrationId,
      },
      body,
      signal: controller.signal,
      duplex: "half",
    } as RequestInit,
  );
  const op = f.server.handle(request, f.company.id, f.open);
  stream.enqueue(
    new TextEncoder().encode(JSON.stringify({ action: "open", selection: f.booking.selection })),
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(f.open).not.toHaveBeenCalled();
  controller.abort();
  expect((await op.response).status).toBeGreaterThanOrEqual(400);
  await op.completion;
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(f.open).not.toHaveBeenCalled();
});
it("booking HTTP keeps one passive original owner and projects only bounded review metadata", async () => {
  const f = fixture();
  await f.start();
  await f.start();
  expect(f.open).toHaveBeenCalledTimes(1);
  expect(f.owner.review).not.toHaveBeenCalled();
  const result = await f.call({ action: "review" });
  expect(result.response.status).toBe(200);
  expect(result.value.review).toEqual(f.review);
  expect(JSON.stringify(result.value)).not.toMatch(/financialBasis|databaseInstanceId|dataRoot/);
  expect(
    (await f.call({ action: "open", selection: { ...f.booking.selection, companyRevision: 999 } }))
      .response.status,
  ).toBe(409);
  expect(
    (await f.call({ action: "open", selection: f.booking.selection }, {}, crypto.randomUUID()))
      .response.status,
  ).toBe(409);
});
it.each([
  "foreign",
  "missing-origin",
  "wrong-selection",
  "query-policy",
  "bad-json",
  "oversize",
  "media",
  "aborted",
])("booking HTTP rejects %s before acquisition", async (kind) => {
  const f = fixture();
  let body: unknown = { action: "open", selection: f.booking.selection };
  const init: RequestInit = {};
  if (kind === "foreign" || kind === "missing-origin")
    init.headers = {
      ...(kind === "foreign" ? { origin: "https://foreign.invalid" } : {}),
      "content-type": "application/json",
      "x-venturepass-comparison-booking": f.booking.registrationId,
    };
  if (kind === "wrong-selection")
    body = {
      action: "open",
      selection: { ...f.booking.selection, companyId: crypto.randomUUID() },
    };
  if (kind === "query-policy") body = { ...(body as object), evidence: {} };
  if (kind === "bad-json") body = "{";
  if (kind === "oversize") body = "x".repeat(8193);
  if (kind === "media")
    init.headers = {
      origin,
      "content-type": "text/plain",
      "x-venturepass-comparison-booking": f.booking.registrationId,
    };
  if (kind === "aborted") init.signal = AbortSignal.abort();
  expect((await f.call(body, init)).response.status).toBeGreaterThanOrEqual(400);
  expect(f.open).not.toHaveBeenCalled();
});
it("booking HTTP requires five exact consents and retains failed close for explicit retry", async () => {
  const f = fixture();
  await f.start();
  await f.call({ action: "review" });
  expect(
    (
      await f.call({
        action: "reserve",
        consent: { ...f.consent, currentBudgetReservationAcknowledged: false },
      })
    ).response.status,
  ).toBe(400);
  expect(f.owner.reserve).not.toHaveBeenCalled();
  expect((await f.call({ action: "reserve", consent: f.consent })).value.receipt).toEqual(
    f.receipt,
  );
  f.owner.close.mockImplementationOnce(() => {});
  expect((await f.call({ action: "close" })).value.status).toBe("recorded");
  expect((await f.call({ action: "recover" })).response.status).toBe(200);
  expect((await f.call({ action: "close" })).value.status).toBe("closed");
  await f.call({ action: "close" });
  expect(f.owner.close).toHaveBeenCalledTimes(2);
  expect((await f.start()).value.code).toBe("OWNER_CLOSED");
});
it("booking HTTP retains original owner after reserve throws and never retries it on inspection", async () => {
  const f = fixture();
  await f.start();
  f.owner.reserve.mockImplementationOnce(() => {
    throw Error("lost reply");
  });
  expect((await f.call({ action: "reserve", consent: f.consent })).response.status).toBe(409);
  await f.call({ action: "inspect" });
  await f.call({ action: "recover" });
  expect(f.owner.reserve).toHaveBeenCalledTimes(1);
  expect(f.open).toHaveBeenCalledTimes(1);
});
function clientFixture() {
  const f = comparisonBookingFixture(),
    data = new Map<string, string>(),
    actions: string[] = [];
  let mode = "valid",
    rid = "",
    recorded = false;
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/preview")) return Response.json(f.preview);
    const body = JSON.parse(String(init?.body));
    actions.push(body.action);
    rid = new Headers(init?.headers).get("x-venturepass-comparison-booking")!;
    if (mode === "missing") return Response.json({ code: "NOT_CONFIGURED" }, { status: 503 });
    if (body.action === "reserve") {
      recorded = true;
      if (mode === "lost") throw Error("lost response");
    }
    const value = {
      ...f.booking,
      registrationId: rid,
      status:
        body.action === "close"
          ? "closed"
          : recorded
            ? "recorded"
            : body.action === "review"
              ? "review"
              : "unused",
      review: body.action === "review" ? f.review : null,
      clientRequestId: f.receipt.clientRequestId,
      runId: f.receipt.runId,
      ...(recorded
        ? { receipt: f.receipt, clientRequestId: f.receipt.clientRequestId, runId: f.receipt.runId }
        : {}),
    };
    if (mode === "mismatch") value.registrationId = crypto.randomUUID();
    return Response.json(value);
  });
  const client = createBookingClient(storage, fetcher),
    consent = {
      reviewDigest: f.review.reviewDigest,
      ...Object.fromEntries(bookingConsents.map(([key]) => [key, true])),
    };
  return {
    ...f,
    data,
    actions,
    storage,
    fetcher,
    client,
    consent,
    mode(value: string) {
      mode = value;
    },
  };
}
it("booking client invalidation during review prevents a late consent view and preview request", async () => {
  const f = clientFixture();
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let reached!: () => void;
  const reachedReview = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const client = createBookingClient(f.storage, async (input, init) => {
    if (JSON.parse(String(init?.body)).action === "review") {
      reached();
      await wait;
    }
    return f.fetcher(input, init);
  });
  const task = client.prepare(f.company, f.booking.selection);
  await reachedReview;
  client.invalidate();
  finish();
  await task;
  expect(client.getSnapshot().input).toBeNull();
  expect(f.fetcher.mock.calls.some(([input]) => String(input).endsWith("/preview"))).toBe(false);
});
it("missing booking owner guides historical records without matching or replacing its request", async () => {
  const f = clientFixture();
  await f.client.prepare(f.company, f.booking.selection);
  f.mode("lost");
  await f.client.reserve(f.company, f.consent);
  const saved = [...f.data.entries()],
    fetcher = vi.fn(async () => Response.json({ code: "OWNER_UNAVAILABLE" }, { status: 404 }));
  const restored = createBookingClient(f.storage, fetcher);
  await restored.inspect();
  expect(restored.getSnapshot().message).toContain("과거 예약을 이번 요청의 결과로 단정하지");
  expect([...f.data.entries()]).toEqual(saved);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(f.actions.filter((a) => a === "reserve")).toHaveLength(1);
  expect(restored.getSnapshot().status?.receipt).toBeUndefined();
});
it.each(["open", "reserve"])(
  "booking client storage failure before %s blocks that mutation",
  async (action) => {
    const f = clientFixture();
    const storage = { ...f.storage, setItem: vi.fn(f.storage.setItem) },
      client = createBookingClient(storage, f.fetcher);
    if (action === "reserve") await client.prepare(f.company, f.booking.selection);
    storage.setItem.mockImplementation(() => {
      throw Error("quota");
    });
    if (action === "open") await client.prepare(f.company, f.booking.selection);
    else await client.reserve(f.company, f.consent);
    expect(f.actions).not.toContain(action);
  },
);
it("booking client is passive, reviews exact input, persists only routing and five explicit consents precede reserve", async () => {
  const f = clientFixture();
  expect(f.fetcher).not.toHaveBeenCalled();
  await f.client.prepare(f.company, f.booking.selection);
  expect(f.client.getSnapshot().input?.preview.identity).toEqual(f.preview.identity);
  expect([...f.data.values()].join()).not.toMatch(
    /claimQuote|retention|consent|costs|synthetic-model/,
  );
  await f.client.reserve(f.company, { ...f.consent, noAutomaticRetryAcknowledged: false });
  expect(f.actions).not.toContain("reserve");
  await f.client.prepare(f.company, f.booking.selection);
  await f.client.reserve(f.company, f.consent);
  expect(f.actions.filter((a) => a === "reserve")).toHaveLength(1);
  expect(f.client.getSnapshot().status?.receipt).toEqual(f.receipt);
});
it("booking client restores original routing after lost reserve and permits only explicit recovery", async () => {
  const f = clientFixture();
  await f.client.prepare(f.company, f.booking.selection);
  f.mode("lost");
  await f.client.reserve(f.company, f.consent);
  const restored = createBookingClient(f.storage, f.fetcher);
  const count = f.fetcher.mock.calls.length;
  expect(restored.getSnapshot().routing).toBeNull();
  expect(f.fetcher).toHaveBeenCalledTimes(count);
  f.mode("valid");
  await restored.inspect();
  await restored.recover();
  await restored.reserve(f.company, f.consent);
  expect(f.actions.filter((a) => a === "reserve")).toHaveLength(1);
  expect(restored.getSnapshot().status?.receipt).toEqual(f.receipt);
});
it.each(["invalidate", "other-snapshot", "expired", "binding"])(
  "booking client blocks %s from becoming consent",
  async (kind) => {
    const f = clientFixture();
    if (kind === "binding") f.mode("mismatch");
    if (kind === "expired") f.review.expiresAt = "2020-01-01T00:00:00.000Z";
    await f.client.prepare(f.company, f.booking.selection);
    if (kind === "invalidate") f.client.invalidate();
    await f.client.reserve(
      kind === "other-snapshot" ? structuredClone(f.company) : f.company,
      f.consent,
    );
    expect(f.actions).not.toContain("reserve");
  },
);
it("booking client missing config is actionable, close forgets only a proven released owner", async () => {
  const f = clientFixture();
  f.mode("missing");
  await f.client.prepare(f.company, f.booking.selection);
  expect(f.client.getSnapshot().message).toContain("설정되지");
  expect(f.data.size).toBe(0);
  f.mode("valid");
  await f.client.prepare(f.company, f.booking.selection);
  await f.client.close();
  expect(f.data.size).toBe(0);
  expect(f.client.getSnapshot().status?.status).toBe("closed");
});

it("booking stores the exact server reference before reserve delivery and blocks silent storage loss", async () => {
  const f = clientFixture();
  await f.client.prepare(f.company, f.booking.selection);
  vi.spyOn(f.storage, "setItem").mockImplementationOnce(() => {});
  await f.client.reserve(f.company, f.consent);
  expect(f.actions).not.toContain("reserve");
  await f.client.prepare(f.company, f.booking.selection);
  const fetcher = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (input, init) => {
    if (JSON.parse(String(init?.body)).action === "reserve")
      expect(JSON.parse([...f.data.values()][0])).toMatchObject({
        attempted: true,
        requestReference: { clientRequestId: f.receipt.clientRequestId, runId: f.receipt.runId },
      });
    return fetcher(input, init);
  });
  f.mode("lost");
  await f.client.reserve(f.company, f.consent);
  const saved = [...f.data.entries()];
  const restored = createBookingClient(f.storage, async () =>
    Response.json({
      ...f.booking,
      registrationId: f.client.getSnapshot().routing!.registrationId,
      clientRequestId: crypto.randomUUID(),
      runId: f.receipt.runId,
    }),
  );
  await restored.inspect();
  expect(restored.getSnapshot().status).toBeNull();
  expect([...f.data.entries()]).toEqual(saved);
  expect(f.actions.filter((a) => a === "reserve")).toHaveLength(1);
});
