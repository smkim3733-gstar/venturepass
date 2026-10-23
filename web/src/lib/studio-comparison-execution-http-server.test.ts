import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("Forbidden IO");
  }),
);
vi.mock("openai", forbidden);
vi.mock("node:sqlite", forbidden);
vi.mock("./studio-comparison-provider-runtime", forbidden);
vi.mock("./studio-storage", forbidden);
import {
  createComparisonExecutionHttpServer,
  comparisonExecutionHttpServer,
} from "./studio-comparison-execution-http-server";
import { comparisonExecutionSessionHeader as header } from "./studio-comparison-execution-wire";
import type { createComparisonExecutionApproval } from "./studio-comparison-execution-approval";

const companyId = "16a6a2ec-90d5-4400-b139-ec04bb8f91bb",
  runId = "98d05f74-8527-4789-831c-6611e73bc9cc";
const origin = "http://127.0.0.1:30377",
  endpoint = `${origin}/api/studio/cases/${companyId}/public-claim-comparison/execution`;
const binding = { companyId, companyRevision: 3, runId, localOrigin: origin };
const consent = {
  clientRequestId: "ef7f6e8c-d3e7-48cb-9828-626c2b2291b9",
  reviewDigest: "a".repeat(64),
  externalTransmissionAcknowledged: true,
  comparisonPurposeAcknowledged: true,
  singleCallAcknowledged: true,
  noAutomaticRetryAcknowledged: true,
  unknownCostHoldAcknowledged: true,
  noResendAcknowledged: true,
  localRetentionAcknowledged: true,
};
function setup() {
  vi.stubGlobal("fetch", forbidden);
  const server = createComparisonExecutionHttpServer();
  let status = "unused";
  const state = () => ({
    status,
    reviewDigest: null,
    selection: null,
    runtime: { service: null },
    secret: "do-not-serialize-this",
  });
  const owner = {
    inspect: vi.fn(state),
    preview: vi.fn(() => {
      status = "reviewed";
      return {
        review: { runId, request: { selection: { companyId, companyRevision: 3 } } },
        reservation: { costs: "synthetic" },
      };
    }),
    execute: vi.fn(async () => ({ secret: "SDK-internal-do-not-serialize" })),
    recover: vi.fn(),
    previewPostcapture: vi.fn(),
    writePostcapture: vi.fn(),
    recoverPostcapture: vi.fn(),
    close: vi.fn(() => {
      status = "closed";
      return state();
    }),
  };
  const ticket = server.register(
    binding,
    owner as unknown as ReturnType<typeof createComparisonExecutionApproval>,
  );
  function request(action: unknown = { action: "inspect" }, init: RequestInit = {}) {
    return new Request(endpoint, {
      method: "POST",
      headers: { origin, [header]: ticket.sessionId, "content-type": "application/json" },
      body: JSON.stringify(action),
      ...init,
    });
  }
  const handle = (action?: unknown, init?: RequestInit) =>
    server.handle(request(action, init), companyId);
  const send = async (action?: unknown, init?: RequestInit) => {
    const operation = handle(action, init),
      response = await operation.response;
    await operation.completion;
    return { response, value: await response.json() };
  };
  return { server, owner, ticket, request, handle, send };
}
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("registration is passive, local, exclusive and returns an opaque original ticket", () => {
  const f = setup();
  expect(f.owner.preview).not.toHaveBeenCalled();
  expect(f.owner.execute).not.toHaveBeenCalled();
  expect(() => f.server.register(binding, f.owner as never)).toThrow("ORIGINAL_OWNER_REQUIRED");
  expect(() =>
    f.server.register({ ...binding, localOrigin: "https://example.com" }, f.owner as never),
  ).toThrow();
  expect(f.server.inspect()).toEqual({ retained: 1, closedReceipts: 0 });
  expect(comparisonExecutionHttpServer()).toBe(comparisonExecutionHttpServer());
});
it("unknown tickets never acquire or register an owner and rejected bodies are cancelled", async () => {
  const f = setup(),
    cancel = vi.fn();
  const req = f.request(undefined, {
    headers: { origin, [header]: runId, "content-type": "application/json" },
    body: new ReadableStream({ cancel }),
    duplex: "half",
  } as RequestInit);
  const op = f.server.handle(req, companyId),
    response = await op.response;
  await op.completion;
  expect(response.status).toBe(404);
  expect(cancel).toHaveBeenCalledOnce();
  expect(f.owner.inspect).toHaveBeenCalledTimes(1);
  expect(f.server.inspect().retained).toBe(1);
});
const rejectedHeaders: Record<string, string>[] = [
  { origin: "https://evil.example", "content-type": "application/json" },
  { "content-type": "application/json" },
  { origin, "content-type": "text/plain" },
  { origin, "content-type": "application/json", "content-encoding": "gzip" },
  { origin, "content-type": "application/json", "content-length": "8193" },
];
it.each(rejectedHeaders)(
  "rejects incompatible headers before an owner call %j",
  async (headers) => {
    const f = setup();
    expect(
      (
        await f.send(
          { action: "execute", consent },
          { headers: { ...headers, [header]: f.ticket.sessionId } },
        )
      ).response.ok,
    ).toBe(false);
    expect(f.owner.execute).not.toHaveBeenCalled();
  },
);
it("strict body refuses injected policies, company/selection, false consent and oversized/invalid UTF8", async () => {
  const f = setup();
  for (const body of [
    { action: "execute", consent, basis: {} },
    { action: "recover", runId },
    { action: "preview", companyRevision: 4 },
    { action: "execute", consent: { ...consent, singleCallAcknowledged: false } },
  ])
    expect((await f.send(body)).response.status).toBe(400);
  expect((await f.send(undefined, { body: " ".repeat(8193) })).response.status).toBe(413);
  expect((await f.send(undefined, { body: new Uint8Array([255]) })).response.status).toBe(400);
  expect(f.owner.preview).not.toHaveBeenCalled();
  expect(f.owner.execute).not.toHaveBeenCalled();
  expect(f.owner.recover).not.toHaveBeenCalled();
});
it("preview checks registered company revision and never changes its trusted selection", async () => {
  const f = setup();
  const good = await f.send({ action: "preview" });
  expect(good.response.status).toBe(200);
  expect(good.value.prepared.reservation.costs).toBe("synthetic");
  f.owner.preview.mockReturnValueOnce({
    review: { runId, request: { selection: { companyId, companyRevision: 4 } } },
    reservation: { costs: "synthetic" },
  });
  expect((await f.send({ action: "preview" })).value.code).toBe("SELECTION_CHANGED");
  expect((await f.send({ action: "execute", consent })).value.code).toBe("CLEANUP_REQUIRED");
  expect(f.owner.execute).not.toHaveBeenCalled();
});
it("execution survives HTTP abort and polling/duplicate confirmation never resends", async () => {
  const f = setup();
  let finish!: (v: { secret: string }) => void;
  f.owner.execute.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const abort = new AbortController();
  const first = await f.send({ action: "execute", consent }, { signal: abort.signal });
  expect(first.response.status).toBe(202);
  abort.abort();
  expect((await f.send({ action: "execute", consent })).response.status).toBe(202);
  expect((await f.send()).value.outcome).toBe("pending");
  expect((await f.send({ action: "close" })).value.code).toBe("REQUEST_BUSY");
  expect((await f.send({ action: "recover" })).value.code).toBe("REQUEST_BUSY");
  expect(
    (await f.send({ action: "execute", consent: { ...consent, clientRequestId: runId } })).value
      .code,
  ).toBe("ORIGINAL_CONFIRMATION_REQUIRED");
  expect((await f.send({ action: "preview" })).value.code).toBe("ORIGINAL_CONFIRMATION_REQUIRED");
  finish({ secret: "SDK-internal-do-not-serialize" });
  await Promise.resolve();
  await Promise.resolve();
  expect((await f.send({ action: "execute", consent })).value.outcome).toBe("returned");
  expect(f.owner.execute).toHaveBeenCalledOnce();
  expect(f.owner.close).not.toHaveBeenCalled();
  expect(JSON.stringify((await f.send()).value)).not.toContain("secret");
  expect((await f.send({ action: "recover" })).response.status).toBe(200);
  expect(f.owner.recover).toHaveBeenCalledWith();
});
it("failed execution stays attached, never echoes failure data and never retries on repeated confirmation", async () => {
  const f = setup();
  f.owner.execute.mockRejectedValueOnce(Error("sk-do-not-expose/customer-name"));
  await f.send({ action: "execute", consent });
  const repeat = await f.send({ action: "execute", consent });
  expect(repeat.value.outcome).toBe("failed");
  expect(JSON.stringify(repeat.value)).not.toContain("sk-");
  expect(f.owner.execute).toHaveBeenCalledOnce();
  expect(f.server.inspect().retained).toBe(1);
  f.owner.recover.mockImplementationOnce(() => {
    throw Error("private-recovery-failure");
  });
  expect((await f.send({ action: "recover" })).value.code).toBe("EXECUTION_UNAVAILABLE");
  expect(f.server.inspect().retained).toBe(1);
});
it("cancelled partial input never executes and blocks close until the same cancellation ends", async () => {
  const f = setup(),
    abort = new AbortController();
  let cancelDone!: () => void;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('{"action":"execute",'));
    },
    cancel: () =>
      new Promise<void>((resolve) => {
        cancelDone = resolve;
      }),
  });
  const op = f.handle(undefined, {
    body: stream,
    signal: abort.signal,
    duplex: "half",
  } as RequestInit);
  abort.abort();
  expect((await op.response).status).toBe(409);
  expect(op.inspect().settled).toBe(false);
  expect((await f.send({ action: "close" })).value.code).toBe("REQUEST_BUSY");
  expect(f.owner.execute).not.toHaveBeenCalled();
  expect(f.owner.close).not.toHaveBeenCalled();
  cancelDone();
  await op.completion;
  expect((await f.send({ action: "close" })).value.closed).toBe(true);
  expect(f.server.inspect().retained).toBe(0);
});
it("failed body cleanup preserves the exact owner and blocks resource disposal", async () => {
  const f = setup(),
    abort = new AbortController();
  const op = f.handle(undefined, {
    body: new ReadableStream({ cancel: () => Promise.reject(Error("failure")) }),
    signal: abort.signal,
    duplex: "half",
  } as RequestInit);
  abort.abort();
  await op.response;
  await op.completion;
  expect(op.inspect().cleanupFailed).toBe(true);
  expect((await f.send()).value.bodyCleanupRequired).toBe(true);
  expect((await f.send({ action: "close" })).value.code).toBe("REQUEST_BUSY");
  expect(f.owner.close).not.toHaveBeenCalled();
});
it("deadline cancels incomplete input without sending and releases the same reader", async () => {
  const f = setup(),
    cancel = vi.fn();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const op = f.handle(undefined, {
    body: new ReadableStream({ cancel }),
    duplex: "half",
  } as RequestInit);
  await vi.advanceTimersByTimeAsync(30001);
  expect((await op.response).status).toBe(408);
  await op.completion;
  expect(cancel).toHaveBeenCalledOnce();
  expect(f.owner.execute).not.toHaveBeenCalled();
});
it("draining cleanup is explicit, original owner is retained, closed receipt is idempotent", async () => {
  const f = setup();
  f.owner.close.mockReturnValueOnce({
    status: "draining",
    reviewDigest: null,
    selection: null,
    runtime: { service: null },
    secret: "hidden",
  });
  expect((await f.send({ action: "close" })).value.code).toBe("CLEANUP_REQUIRED");
  expect(f.server.inspect().retained).toBe(1);
  expect((await f.send({ action: "preview" })).value.code).toBe("CLEANUP_REQUIRED");
  const closed = await f.send({ action: "close" });
  expect(closed.value.closed).toBe(true);
  expect(f.server.inspect()).toEqual({ retained: 0, closedReceipts: 1 });
  expect((await f.send({ action: "close" })).value).toEqual(closed.value);
  expect((await f.send({ action: "execute", consent })).value.code).toBe("SESSION_CLOSED");
  expect(f.owner.close).toHaveBeenCalledTimes(2);
});
it("wrong company/origin/path and aborted complete input never reach the owner", async () => {
  const f = setup(),
    abort = new AbortController();
  abort.abort();
  expect(
    (await f.send({ action: "execute", consent }, { signal: abort.signal })).response.status,
  ).toBe(409);
  expect((await f.server.handle(f.request(), runId).response).status).toBe(400);
  const req = new Request(endpoint + "?unexpected=1", f.request());
  expect((await f.server.handle(req, companyId).response).status).toBe(400);
  expect(f.owner.execute).not.toHaveBeenCalled();
});

function openFixture() {
  const f = setup(),
    server = createComparisonExecutionHttpServer();
  const factory = vi.fn(async () => ({
    runId,
    approval: f.owner as unknown as ReturnType<typeof createComparisonExecutionApproval>,
  }));
  const action = { action: "open", companyRevision: 3, clientRequestId: consent.clientRequestId };
  const start = (value: unknown = action, signal?: AbortSignal) =>
    server.handle(
      f.request(value, {
        headers: { origin, "content-type": "application/json" },
        signal,
      }),
      companyId,
      factory,
    );
  return { ...f, server, factory, action, start };
}
it("open reads only a complete strict selection before invoking the trusted factory", async () => {
  const f = openFixture();
  for (const value of [{ ...f.action, runId }, { ...f.action, basis: {} }, { action: "inspect" }])
    expect((await f.start(value).response).status).toBe(400);
  expect(f.factory).not.toHaveBeenCalled();
  const response = await f.start().response,
    ticket = await response.json();
  expect(response.status).toBe(200);
  expect(ticket).toMatchObject({ companyId, companyRevision: 3, runId, closed: false });
  expect(f.factory).toHaveBeenCalledWith(companyId, 3);
  expect(f.owner.preview).not.toHaveBeenCalled();
  expect(f.owner.execute).not.toHaveBeenCalled();
});
it("concurrent open and disconnect retain one original ticket without reconstructing the runtime", async () => {
  const f = openFixture(),
    abort = new AbortController();
  let finish!: (value: Awaited<ReturnType<typeof f.factory>>) => void;
  f.factory.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const first = f.start(f.action, abort.signal);
  await vi.waitFor(() => expect(f.factory).toHaveBeenCalledOnce());
  const repeated = f.start();
  abort.abort();
  expect((await first.response).status).toBe(409);
  expect((await f.start({ ...f.action, clientRequestId: runId }).response).status).toBe(409);
  finish({ runId, approval: f.owner as never });
  const delivered = await (await repeated.response).json();
  await first.completion;
  expect(await (await f.start().response).json()).toEqual(delivered);
  expect(f.factory).toHaveBeenCalledOnce();
  expect(f.server.inspect().retained).toBe(1);
});
it("open replay ignores later configuration failure but refuses changed selection and new nonce", async () => {
  const f = openFixture();
  const ticket = await (await f.start().response).json();
  f.factory.mockRejectedValue(Error("private-config-error"));
  expect(await (await f.start().response).json()).toEqual(ticket);
  expect((await f.start({ ...f.action, companyRevision: 4 }).response).status).toBe(409);
  expect((await f.start({ ...f.action, clientRequestId: runId }).response).status).toBe(409);
  expect(f.factory).toHaveBeenCalledOnce();
  const closed = f.server.handle(
    f.request(
      { action: "close" },
      { headers: { origin, "content-type": "application/json", [header]: ticket.sessionId } },
    ),
    companyId,
  );
  expect((await closed.response).status).toBe(200);
  await closed.completion;
  expect((await (await f.start().response).json()).closed).toBe(true);
  expect(f.factory).toHaveBeenCalledOnce();
});
it("failed registration keeps the returned original owner for explicit close retry", async () => {
  const f = openFixture();
  f.owner.inspect.mockReturnValue({
    status: "reviewed",
    reviewDigest: null,
    selection: null,
    runtime: { service: null },
    secret: "hidden",
  });
  f.owner.close.mockReturnValueOnce({
    status: "draining",
    reviewDigest: null,
    selection: null,
    runtime: { service: null },
    secret: "hidden",
  });
  expect((await (await f.start().response).json()).code).toBe("CLEANUP_REQUIRED");
  expect(f.server.inspect().retained).toBe(1);
  expect((await f.start({ ...f.action, clientRequestId: runId }).response).status).toBe(409);
  expect((await (await f.start().response).json()).code).toBe("OPEN_UNAVAILABLE");
  expect(f.factory).toHaveBeenCalledOnce();
  expect(f.owner.close).toHaveBeenCalledTimes(2);
  expect(f.server.inspect().retained).toBe(0);
});

it("postcapture commands require completed original execution, exact wire shape and original owner", async () => {
  const f = setup(),
    reviewDigest = "a".repeat(64);
  expect((await f.send({ action: "postcapture-preview" })).response.status).toBe(409);
  expect(f.owner.previewPostcapture).not.toHaveBeenCalled();
  await f.send({ action: "execute", consent });
  expect(
    (await f.send({ action: "record-result", reviewDigest, units: "0" })).response.status,
  ).toBe(400);
  expect(f.owner.writePostcapture).not.toHaveBeenCalled();
  expect((await f.send({ action: "postcapture-preview" })).response.status).toBe(200);
  await f.send({ action: "record-result", reviewDigest });
  await f.send({ action: "settle-finalize", reviewDigest });
  await f.send({ action: "recover-postcapture", operation: "record-result" });
  expect(f.owner.writePostcapture.mock.calls).toEqual([
    ["record-result", reviewDigest],
    ["settle-finalize", reviewDigest],
  ]);
  expect(f.owner.recoverPostcapture).toHaveBeenCalledWith("record-result");
  expect(f.owner.execute).toHaveBeenCalledTimes(1);
  await f.send({ action: "close" });
  expect((await f.send({ action: "postcapture-preview" })).response.status).toBe(409);
});

it("postcapture recovery remains accessible after close is draining", async () => {
  const f = setup();
  await f.send({ action: "execute", consent });
  f.owner.close.mockImplementationOnce(() => ({ ...f.owner.inspect(), status: "draining" }));
  expect((await f.send({ action: "close" })).response.status).toBe(409);
  expect(
    (await f.send({ action: "record-result", reviewDigest: consent.reviewDigest })).response.status,
  ).toBe(409);
  expect(
    (await f.send({ action: "recover-postcapture", operation: "record-result" })).response.status,
  ).toBe(200);
  expect(f.owner.recoverPostcapture).toHaveBeenCalledWith("record-result");
  expect(f.owner.writePostcapture).not.toHaveBeenCalled();
});
