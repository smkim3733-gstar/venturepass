import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("openai", () => { throw Error("real SDK import forbidden"); });
import { comparisonBodyLimits as limits, createComparisonBodyBoundary } from "./studio-public-claim-comparison-body";

type Boundary = ReturnType<typeof createComparisonBodyBoundary>;
let boundaries: Boundary[] = [];
const forbidden = vi.fn(() => { throw Error("external fetch forbidden"); });
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.stubGlobal("fetch", forbidden);
});
afterEach(() => {
  boundaries.forEach((b) => b.seal());
  boundaries = [];
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(forbidden).not.toHaveBeenCalled();
});
const make = () => { const b = createComparisonBodyBoundary(); boundaries.push(b); return b; };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
async function tick() { for (let n = 0; n < 24; n++) await Promise.resolve(); }
function start(b: Boundary, value: Response | Promise<Response>) {
  return b.start({ signal: b.signal }, () => Promise.resolve(value));
}
for (const status of [200, 503])
  for (const offset of [-1, 0, 1])
    it("4I26 body byte boundary " + status + "/" + offset, async () => {
      const cap = status === 200 ? limits.successBytes : limits.errorBytes;
      const bytes = new Uint8Array(offset === -1 ? 0 : cap + offset).fill(32);
      const cancel = vi.fn();
      const raw = new Response(new ReadableStream({
        start(c) { c.enqueue(bytes); if (offset <= 0) c.close(); },
        cancel,
      }), { status });
      const b = make(), output = start(b, raw);
      if (offset > 0) {
        await expect(output).rejects.toThrow("PUBLIC_COMPARISON_BODY_UNKNOWN");
        expect(cancel).toHaveBeenCalledTimes(1);
      } else {
        const received = await output;
        expect(received).not.toBe(raw);
        expect(received.status).toBe(status);
        expect(Buffer.compare(Buffer.from(await received.arrayBuffer()), Buffer.from(bytes))).toBe(0);
      }
      b.seal();
      await b.completion;
      expect(b.inspect()).toEqual({ settled: true, cleanupFailed: false, delivered: offset <= 0 });
    });
for (const length of ["", "-1", "1.5", "1, 1", "+1", "01", "9007199254740992", "4194305"])
  it("4I26 refuses ambiguous or excessive declared length " + length, async () => {
    const cancel = vi.fn();
    const b = make();
    await expect(start(b, new Response(new ReadableStream({ cancel }),
      { headers: { "content-length": length } }))).rejects.toThrow(/BODY_UNKNOWN/);
    b.seal(); await b.completion;
    expect(cancel).toHaveBeenCalledTimes(1);
  });
it("4I26 counts exposed bytes despite compressed or understated headers and preserves bytes", async () => {
  const b = make();
  const bytes = new TextEncoder().encode('  {"한글": "그대로"}\n');
  const raw = new Response(bytes, { status: 201, statusText: "Created", headers: {
    "content-length": "1", "content-encoding": "gzip", "content-type": "application/json",
    "x-request-id": "public-test-id",
  } });
  const output = await start(b, raw);
  expect(output.status).toBe(201);
  expect(output.statusText).toBe("Created");
  expect(output.headers.get("content-length")).toBe(String(bytes.length));
  expect(output.headers.has("content-encoding")).toBe(false);
  expect(output.headers.get("x-request-id")).toBe("public-test-id");
  expect(output.headers.get("content-type")).toBe("application/json");
  expect(new Uint8Array(await output.arrayBuffer())).toEqual(bytes);
  b.seal(); await b.completion;
});
it("4I26 small declared length never bypasses observed cap", async () => {
  const b = make();
  await expect(start(b, new Response(new Uint8Array(limits.errorBytes + 1),
    { status: 429, headers: { "content-length": "1" } }))).rejects.toThrow(/BODY_UNKNOWN/);
  b.seal(); await b.completion;
});
it("4I26 one reader waits for EOF and accepts small/empty chunks without text or JSON parsing", async () => {
  let c!: ReadableStreamDefaultController<Uint8Array>;
  const b = make(), raw = new Response(new ReadableStream({ start(v) { c = v; } }));
  const getReader = vi.spyOn(raw.body!, "getReader");
  for (const method of ["text", "json", "arrayBuffer", "clone"] as const)
    vi.spyOn(raw, method).mockImplementation(() => { throw Error("unbounded read"); });
  const p = start(b, raw), done = vi.fn();
  void p.then(done);
  await tick();
  for (let n = 0; n < 30; n++) { c.enqueue(new Uint8Array(0)); c.enqueue(Uint8Array.of(65)); }
  await tick();
  expect(done).not.toHaveBeenCalled();
  c.close();
  expect(await (await p).text()).toBe("A".repeat(30));
  expect(getReader).toHaveBeenCalledTimes(1);
  b.seal(); await b.completion;
});
for (const chunk of ["not bytes", { size: 0 }])
  it("4I26 refuses a non-byte chunk " + typeof chunk, async () => {
    const b = make();
    const cancel = vi.fn();
    await expect(start(b, new Response(new ReadableStream({
      start(c) { c.enqueue(chunk); }, cancel,
    })))).rejects.toThrow(/BODY_UNKNOWN/);
    b.seal(); await b.completion;
    expect(cancel).toHaveBeenCalledTimes(1);
  });
it("4I26 timeout rejects delivery while original cancel remains owned", async () => {
  const cancellation = deferred<void>(), cancelled = vi.fn(() => cancellation.promise);
  const b = make();
  const p = start(b, new Response(new ReadableStream({ cancel: cancelled })));
  const rejected = expect(p).rejects.toThrow(/BODY_UNKNOWN/);
  await tick();
  await vi.advanceTimersByTimeAsync(limits.timeoutMs);
  await rejected;
  b.seal(); await tick();
  expect(b.signal.aborted).toBe(true);
  expect(b.inspect()).toMatchObject({ settled: false, delivered: false });
  expect(cancelled).toHaveBeenCalledTimes(1);
  cancellation.resolve(); await b.completion;
  expect(b.inspect()).toMatchObject({ settled: true, cleanupFailed: false });
});
it("4I26 late Response after timeout is only cancelled and waits for its cancel completion", async () => {
  const raw = deferred<Response>(), cancel = deferred<void>();
  const cancelled = vi.fn(() => cancel.promise), b = make();
  const p = start(b, raw.promise);
  const rejected = expect(p).rejects.toThrow(/BODY_UNKNOWN/);
  await vi.advanceTimersByTimeAsync(limits.timeoutMs); await rejected;
  b.seal(); await tick();
  expect(b.inspect().settled).toBe(false);
  raw.resolve(new Response(new ReadableStream({ cancel: cancelled })));
  await tick();
  expect(cancelled).toHaveBeenCalledTimes(1);
  expect(b.inspect().settled).toBe(false);
  cancel.resolve(); await b.completion;
  expect(b.inspect()).toEqual({ settled: true, cleanupFailed: false, delivered: false });
});
for (const mode of ["throw", "reject"])
  it("4I26 cancellation " + mode + " is a cleanup failure", async () => {
    const b = make();
    const p = start(b, new Response(new ReadableStream({
      cancel() { if (mode === "throw") throw Error("secret"); return Promise.reject(Error("secret")); },
    })));
    const rejected = expect(p).rejects.toThrow(/^PUBLIC_COMPARISON_BODY_UNKNOWN$/);
    await tick(); b.seal(); await rejected; await b.completion;
    expect(b.inspect()).toEqual({ settled: true, cleanupFailed: true, delivered: false });
  });
it("4I26 deadline starts at preparation and cannot be reset before fetch", async () => {
  const b = make(), network = vi.fn(async () => new Response("{}"));
  await vi.advanceTimersByTimeAsync(limits.timeoutMs);
  expect(() => b.start({ signal: b.signal }, network)).toThrow(/BODY_UNKNOWN/);
  expect(network).not.toHaveBeenCalled();
  b.seal(); await b.completion;
});
it("4I26 exactly forwards the checked wire and refuses a second start", async () => {
  const b = make(), c = new AbortController(), wire = { signal: c.signal, body: "{}" };
  const network = vi.fn(async (input: RequestInit) => { expect(input).toBe(wire); return new Response("{}"); });
  await b.start(wire, network);
  expect(network).toHaveBeenCalledWith(wire);
  expect(network.mock.calls[0][0].signal).toBe(c.signal);
  await expect(b.start(wire, network)).rejects.toThrow(/BODY_UNKNOWN/);
  expect(network).toHaveBeenCalledTimes(1);
  b.seal(); await b.completion;
});
for (const before of [true, false])
  it("4I26 observes SDK wire abort " + (before ? "before" : "after") + " start", async () => {
    const b = make(), c = new AbortController(), cancel = vi.fn();
    const network = vi.fn(async () => new Response(new ReadableStream({ cancel })));
    if (before) {
      c.abort();
      expect(() => b.start({ signal: c.signal }, network)).toThrow(/BODY_UNKNOWN/);
      expect(network).not.toHaveBeenCalled();
    } else {
      const p = b.start({ signal: c.signal }, network);
      const rejected = expect(p).rejects.toThrow(/BODY_UNKNOWN/);
      await tick(); c.abort(); await rejected;
      expect(cancel).toHaveBeenCalledTimes(1);
    }
    b.seal(); await b.completion;
  });
for (const status of [204, 205, 304])
  it("4I26 native bodyless status " + status + " stays bodyless", async () => {
    const b = make(), value = await start(b, new Response(null, { status }));
    expect(value.body).toBeNull(); expect(value.status).toBe(status);
    b.seal(); await b.completion;
  });
for (const mode of ["used", "locked", "error", "redirect"])
  it("4I26 refuses invalid Response state " + mode, async () => {
    const b = make();
    let raw = new Response("x");
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    if (mode === "used") await raw.text();
    if (mode === "locked") reader = raw.body!.getReader();
    if (mode === "error") raw = Response.error();
    if (mode === "redirect") {
      // Native redirected flag cannot be manufactured without network; 3xx remains bounded error.
      raw = Response.redirect("https://example.invalid/");
    }
    if (mode === "redirect") {
      expect((await start(b, raw)).status).toBe(302);
    } else await expect(start(b, raw)).rejects.toThrow(/BODY_UNKNOWN/);
    b.seal(); await b.completion;
    reader?.releaseLock();
  });
it("4I26 response subclass getters cannot execute as response evidence", async () => {
  class Trap extends Response { get body(): Response["body"] { throw Error("getter"); } }
  const b = make();
  expect(await (await start(b, new Trap("{}"))).text()).toBe("{}");
  b.seal(); await b.completion;
});
it("4I26 read failure and release failure do not expose prefix or erase cleanup", async () => {
  const b = make(), raw = new Response(new ReadableStream<Uint8Array>({
    pull(c) { c.error(Error("secret read error")); },
  }));
  await expect(start(b, raw)).rejects.toThrow(/^PUBLIC_COMPARISON_BODY_UNKNOWN$/);
  b.seal(); await b.completion;
  expect(b.inspect()).toMatchObject({ delivered: false });
  const second = make(), response = new Response("{}");
  const original = response.body!.getReader.bind(response.body!);
  vi.spyOn(response.body!, "getReader").mockImplementation(() => {
    const reader = original();
    vi.spyOn(reader, "releaseLock").mockImplementation(() => { throw Error("secret cleanup"); });
    return reader;
  });
  await expect(start(second, response)).rejects.toThrow(/BODY_UNKNOWN/);
  second.seal(); await second.completion;
  expect(second.inspect()).toEqual({ delivered: false, settled: true, cleanupFailed: true });
});

it("4I26 original read remains pending after fast rejection and completed cancellation", async () => {
  const b = make(), raw = new Response(new ReadableStream<Uint8Array>());
  const read = deferred<ReadableStreamReadResult<Uint8Array<ArrayBuffer>>>();
  const original = raw.body!.getReader.bind(raw.body!);
  const released = vi.fn();
  vi.spyOn(raw.body!, "getReader").mockImplementation(() => {
    const reader = original();
    vi.spyOn(reader, "read").mockImplementation(() => read.promise);
    const release = reader.releaseLock.bind(reader);
    vi.spyOn(reader, "releaseLock").mockImplementation(() => { released(); release(); });
    return reader;
  });
  const p = start(b, raw), rejected = expect(p).rejects.toThrow(/BODY_UNKNOWN/);
  await tick();
  await vi.advanceTimersByTimeAsync(limits.timeoutMs);
  await rejected; b.seal(); await tick();
  expect(b.inspect().settled).toBe(false);
  expect(released).not.toHaveBeenCalled();
  read.resolve({ done: false, value: Uint8Array.of(65) });
  await b.completion;
  expect(b.inspect()).toEqual({ settled: true, cleanupFailed: false, delivered: false });
  expect(released).toHaveBeenCalledTimes(1);
});
it("4I26 late original fetch rejection settles without an unhandled replacement request", async () => {
  const b = make(), raw = deferred<Response>();
  const p = start(b, raw.promise), rejected = expect(p).rejects.toThrow(/BODY_UNKNOWN/);
  await vi.advanceTimersByTimeAsync(limits.timeoutMs);
  await rejected; b.seal(); await tick();
  expect(b.inspect().settled).toBe(false);
  raw.reject(Error("private fetch failure"));
  await b.completion;
  expect(b.inspect()).toEqual({ settled: true, cleanupFailed: false, delivered: false });
});
for (const mode of ["timer", "listener"] as const)
  it("4I26 " + mode + " cleanup failure remains explicit", async () => {
    const b = make(), c = new AbortController();
    await b.start({ signal: c.signal }, async () => new Response("{}"));
    const timerSpy = mode === "timer" ? vi.spyOn(globalThis, "clearTimeout").mockImplementationOnce(() => { throw Error("cleanup"); }) : undefined;
    const listenerSpy = mode === "listener" ? vi.spyOn(c.signal, "removeEventListener").mockImplementationOnce(() => { throw Error("cleanup"); }) : undefined;
    try {
      b.seal(); await b.completion;
      expect(b.inspect()).toEqual({ settled: true, cleanupFailed: true, delivered: true });
    } finally {
      timerSpy?.mockRestore();
      listenerSpy?.mockRestore();
    }
  });
