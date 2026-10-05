import { afterEach, expect, it, vi } from "vitest";
import {
  createPublicStatisticsCellService,
  readPublicStatisticsCell,
} from "./studio-public-statistics-service";
import {
  createPublicResearchService,
  searchPublicResearch,
} from "./studio-public-research-service";
import { createKosisReadGate } from "./studio-kosis-read-transport";
import { syntheticCellRow, syntheticCellTarget } from "./studio-public-statistics-test-fixture";
vi.mock("server-only", () => ({}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
const now = "2026-10-05T08:00:00.000Z";
const key = "synthetic-key-only";
function setup(
  fetcher: typeof fetch = async () => Response.json([syntheticCellRow()]),
  apiKey: string | undefined = key,
) {
  const fetch = vi.fn(fetcher),
    clock = vi.fn(() => now),
    gate = createKosisReadGate();
  const deps = { fetch, apiKey: () => apiKey, now: clock, gate };
  return {
    fetch,
    clock,
    read: createPublicStatisticsCellService(deps),
    search: createPublicResearchService(deps),
  };
}
it("sends a single exact cell to fixed HTTPS and returns only literal scoped fields", async () => {
  const s = setup();
  const result = await s.read(syntheticCellTarget());
  expect(s.fetch).toHaveBeenCalledOnce();
  const [url, init] = s.fetch.mock.calls[0],
    u = new URL(String(url));
  expect(u.origin + u.pathname).toBe("https://kosis.kr/openapi/Param/statisticsParameterData.do");
  expect(Object.fromEntries(u.searchParams)).toEqual({
    method: "getList",
    apiKey: key,
    orgId: "999",
    tblId: "DT_SYNTHETIC",
    itmId: "T001",
    objL1: "001",
    objL2: "002",
    prdSe: "Y",
    startPrdDe: "2024",
    endPrdDe: "2024",
    format: "json",
    smblChk: "Y",
  });
  expect(init).toMatchObject({
    method: "GET",
    redirect: "error",
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    headers: { Accept: "application/json" },
  });
  expect(result).toMatchObject({
    status: "matched",
    source: "kosis-api-response",
    retrievedAt: now,
    wholeTableRead: false,
    factChecked: false,
    databaseChanged: false,
    companyApplicabilityChecked: false,
    aiInputApproved: false,
  });
  expect(JSON.stringify(result)).not.toContain(key);
  expect(result.cell?.lastChangedText).toBe("2025-01-01");
});
it("preserves all eight dimensions and one explicit non-year period", async () => {
  const target = syntheticCellTarget(8);
  target.period = { cycle: "Q", point: "202404" };
  const s = setup(async () => Response.json([syntheticCellRow(target)]));
  await s.read(target);
  const u = new URL(String(s.fetch.mock.calls[0][0]));
  expect(u.searchParams.get("objL8")).toBe("008");
  expect(u.searchParams.get("objL9")).toBeNull();
  expect(u.searchParams.get("startPrdDe")).toBe("202404");
  expect(u.searchParams.has("newEstPrdCnt")).toBe(false);
});
it.each([undefined, "", "  "])("keyless state %j performs no fetch or clock", async (apiKey) => {
  const fetch = vi.fn(),
    clock = vi.fn();
  const read = createPublicStatisticsCellService({ apiKey: () => apiKey, fetch, now: clock });
  expect(await read(syntheticCellTarget())).toMatchObject({
    status: "not-configured",
    source: "not-requested",
    cell: null,
    retrievedAt: null,
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(clock).not.toHaveBeenCalled();
});
it.each(["private\nkey", "x".repeat(1025)])(
  "rejects malformed server key without exposing it",
  async (apiKey) => {
    const s = setup(vi.fn(), apiKey);
    await expect(s.read(syntheticCellTarget())).rejects.toMatchObject({
      code: "PUBLIC_STATISTICS_UNAVAILABLE",
    });
    expect(s.fetch).not.toHaveBeenCalled();
  },
);
it("rejects invalid caller fields before reading even server configuration", async () => {
  const apiKey = vi.fn(),
    fetch = vi.fn();
  const read = createPublicStatisticsCellService({ apiKey, fetch, now: () => now });
  for (const extra of [
    { apiKey: key },
    { company: "private" },
    { url: "https://evil.invalid" },
    { classifications: ["ALL"] },
    { period: { cycle: "Y", point: "2024", newEstPrdCnt: 1 } },
    { text: "p".repeat(8193) },
  ])
    await expect(read({ ...syntheticCellTarget(), ...extra })).rejects.toThrow("선택한 통계 수치");
  expect(apiKey).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
it("keeps a parsed target copy across await and isolates returned copies", async () => {
  let finish!: (r: Response) => void;
  const target = syntheticCellTarget(),
    original = structuredClone(target);
  const s = setup(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const pending = s.read(target);
  target.classifications[0] = "changed";
  target.period.point = "2025";
  finish(Response.json([syntheticCellRow(original)]));
  const result = await pending;
  expect(result.target).toEqual(original);
  result.target.classifications[0] = "returned change";
  expect(target.classifications[0]).toBe("changed");
});
it("distinguishes empty rows from malformed response and duplicate cells", async () => {
  expect(await setup(async () => Response.json([])).read(syntheticCellTarget())).toMatchObject({
    status: "empty",
    cell: null,
    source: "kosis-api-response",
  });
  for (const raw of [
    { err: "30", errMsg: key },
    [syntheticCellRow(), syntheticCellRow()],
    [{ ...syntheticCellRow(), ORG_ID: "other" }],
  ]) {
    const s = setup(async () => Response.json(raw));
    await expect(s.read(syntheticCellTarget())).rejects.toMatchObject({
      code: "PUBLIC_STATISTICS_UNAVAILABLE",
    });
    expect(s.fetch).toHaveBeenCalledOnce();
  }
});
it.each([301, 302, 403, 429, 500])(
  "rejects provider HTTP %i with no retry/raw message",
  async (status) => {
    const s = setup(async () => new Response(key + " private", { status }));
    await expect(s.read(syntheticCellTarget())).rejects.toThrow(
      "선택한 공개 통계 수치를 확인하지 못했습니다",
    );
    expect(s.fetch).toHaveBeenCalledOnce();
  },
);
it("rejects redirected OK responses and cancels their body", async () => {
  const response = Response.json([syntheticCellRow()]);
  Object.defineProperty(response, "redirected", { value: true });
  const cancel = vi.spyOn(response.body!, "cancel");
  await expect(setup(async () => response).read(syntheticCellTarget())).rejects.toThrow();
  expect(cancel).toHaveBeenCalledOnce();
});
it.each(["524289", "NaN", "-1", "1.5", ""])(
  "rejects invalid/too-large content length %j",
  async (length) => {
    const response = new Response("[]", { headers: { "content-length": length } });
    const s = setup(async () => response);
    await expect(s.read(syntheticCellTarget())).rejects.toMatchObject({
      code: "PUBLIC_STATISTICS_UNAVAILABLE",
    });
    expect(s.fetch).toHaveBeenCalledOnce();
  },
);
it("accepts exactly 512KiB UTF-8 body and rejects an extra streamed byte without clipping", async () => {
  const exact = "[]" + " ".repeat(512 * 1024 - 2);
  expect(await setup(async () => new Response(exact)).read(syntheticCellTarget())).toMatchObject({
    status: "empty",
  });
  const canceled = vi.fn();
  const s = setup(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(512 * 1024 + 1));
          },
          cancel: canceled,
        }),
      ),
  );
  await expect(s.read(syntheticCellTarget())).rejects.toThrow();
  expect(canceled).toHaveBeenCalledOnce();
});
it.each(["<html>private</html>", "callback([])", "{private", "null"])(
  "rejects non-array/JSON response %s",
  async (body) => {
    await expect(
      setup(async () => new Response(body)).read(syntheticCellTarget()),
    ).rejects.toMatchObject({ code: "PUBLIC_STATISTICS_UNAVAILABLE" });
  },
);
it("rejects malformed UTF-8 and missing body", async () => {
  for (const response of [new Response(new Uint8Array([0xff])), new Response(null)]) {
    await expect(setup(async () => response).read(syntheticCellTarget())).rejects.toThrow();
  }
});
it("rejects a bad provider clock or thrown getter without leaking details", async () => {
  const fetch = vi.fn(async () => Response.json([syntheticCellRow()]));
  for (const deps of [
    { apiKey: () => key, now: () => "not-a-date" },
    {
      apiKey: () => {
        throw Error(key);
      },
      now: () => now,
    },
    {
      apiKey: () => key,
      now: () => {
        throw Error(key);
      },
    },
  ]) {
    const read = createPublicStatisticsCellService({ fetch, ...deps });
    await expect(read(syntheticCellTarget())).rejects.toThrow(
      "선택한 공개 통계 수치를 확인하지 못했습니다",
    );
  }
});
it("blocks search while a cell is in flight, then permits a new explicit search", async () => {
  let finish!: (r: Response) => void;
  const s = setup(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const pending = s.read(syntheticCellTarget());
  await expect(s.search({ topic: "services" })).rejects.toMatchObject({
    code: "PUBLIC_RESEARCH_BUSY",
  });
  expect(s.fetch).toHaveBeenCalledOnce();
  finish(Response.json([syntheticCellRow()]));
  await pending;
  const next = s.search({ topic: "services" });
  finish(Response.json([]));
  await next;
  expect(s.fetch).toHaveBeenCalledTimes(2);
});
it("blocks cell while search is in flight across the shared production services", async () => {
  vi.stubEnv("KOSIS_API_KEY", key);
  let finish!: (r: Response) => void;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((r) => {
        finish = r;
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const pending = searchPublicResearch({ topic: "services" });
  await expect(readPublicStatisticsCell(syntheticCellTarget())).rejects.toMatchObject({
    code: "PUBLIC_RESEARCH_BUSY",
  });
  finish(Response.json([]));
  await pending;
  const next = readPublicStatisticsCell(syntheticCellTarget());
  finish(Response.json([syntheticCellRow()]));
  await next;
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("does not dispatch an already aborted caller", async () => {
  const s = setup();
  await expect(s.read(syntheticCellTarget(), AbortSignal.abort())).rejects.toThrow();
  expect(s.fetch).not.toHaveBeenCalled();
});
it("cancels pending fetch at 20 seconds without retry", async () => {
  vi.useFakeTimers();
  const s = setup(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(Error(key)), { once: true });
      }),
  );
  const pending = expect(s.read(syntheticCellTarget())).rejects.toMatchObject({
    code: "PUBLIC_STATISTICS_UNAVAILABLE",
  });
  await vi.advanceTimersByTimeAsync(20_000);
  await pending;
  expect(s.fetch).toHaveBeenCalledOnce();
  expect(s.clock).not.toHaveBeenCalled();
});
it("times out a stalled body, cancels its reader and prevents partial success", async () => {
  vi.useFakeTimers();
  const canceled = vi.fn();
  const s = setup(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("["));
          },
          cancel: canceled,
        }),
      ),
  );
  const pending = expect(s.read(syntheticCellTarget())).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(20_000);
  await pending;
  expect(canceled).toHaveBeenCalledOnce();
  expect(s.clock).not.toHaveBeenCalled();
});
it("caller cancellation is bounded even if fetch ignores abort; original lease remains until settlement", async () => {
  let finish!: (r: Response) => void;
  const canceled = vi.fn();
  const s = setup(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const controller = new AbortController();
  const pending = expect(s.read(syntheticCellTarget(), controller.signal)).rejects.toThrow();
  controller.abort();
  await pending;
  await expect(s.search({ topic: "services" })).rejects.toMatchObject({
    code: "PUBLIC_RESEARCH_BUSY",
  });
  const response = new Response(new ReadableStream({ cancel: canceled }));
  finish(response);
  await new Promise((r) => setTimeout(r, 0));
  expect(canceled).toHaveBeenCalledOnce();
  expect(s.clock).not.toHaveBeenCalled();
  const next = s.read(syntheticCellTarget());
  finish(Response.json([]));
  await next;
  expect(s.fetch).toHaveBeenCalledTimes(2);
});
it("rejects an abort at the observation clock before returning any late response", async () => {
  const controller = new AbortController();
  const read = createPublicStatisticsCellService({
    apiKey: () => key,
    fetch: async () => Response.json([syntheticCellRow()]),
    now: () => {
      controller.abort();
      return now;
    },
  });
  await expect(read(syntheticCellTarget(), controller.signal)).rejects.toThrow();
});
