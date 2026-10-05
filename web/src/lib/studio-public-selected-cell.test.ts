import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createKosisReadGate } from "./studio-kosis-read-transport";
import {
  createPublicSelectedCellService,
  readSelectedPublicStatisticsCell,
} from "./studio-public-selected-cell-service";
import {
  publicSelectedCellCommandSchema,
  readPublicSelectedCellResult,
} from "./studio-public-selected-cell";
import { syntheticCellRow, syntheticCellTarget } from "./studio-public-statistics-test-fixture";
import {
  PublicSelectedCell,
  PublicSelectedCellResultView,
} from "@/components/studio/public-selected-cell";
import { POST } from "@/app/api/studio/public-research/search/route";
import { searchPublicResearch } from "./studio-public-research-service";
vi.mock("server-only", () => ({}));
const at = "2026-10-05T09:30:00.000Z";
const candidate = {
  organizationId: "999",
  tableId: "DT_SYNTHETIC",
  title: "합성 표",
  organization: "합성 기관",
  periodStart: "2020",
  periodEnd: "2024",
  originalUrl: "https://kosis.kr/statHtml/statHtml.do?orgId=999&tblId=DT_SYNTHETIC",
};
const selection = {
  itemId: "T001",
  classifications: ["001", "002"],
  period: { cycle: "Y", point: "2024" },
};
const command = {
  action: "read-selected-statistics-cell",
  topic: "services",
  candidate,
  searchRetrievedAt: at,
  selection,
  confirmed: true,
};
const searchRow = {
  ORG_ID: "999",
  TBL_ID: "DT_SYNTHETIC",
  TBL_NM: "합성 표",
  ORG_NM: "합성 기관",
  STRT_PRD_DE: "2020",
  END_PRD_DE: "2024",
  LINK_URL: candidate.originalUrl,
};
function setup(rows: unknown = [syntheticCellRow()], search: unknown = [searchRow]) {
  const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) =>
    Response.json(new URL(String(input)).pathname.endsWith("statisticsSearch.do") ? search : rows),
  );
  const read = createPublicSelectedCellService({
    apiKey: () => "synthetic-only",
    fetch,
    now: () => at,
    gate: createKosisReadGate(),
  });
  return { fetch, read };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
it.each([1, 8])(
  "reads the exact %i classification selection without normalizing codes",
  async (count) => {
    const target = syntheticCellTarget(count);
    target.itemId = "t00a";
    target.classifications = Array(count).fill("00a");
    const original = {
      ...command,
      selection: {
        itemId: target.itemId,
        classifications: target.classifications,
        period: target.period,
      },
    };
    const s = setup(
      [syntheticCellRow(target)],
      [
        {
          ...searchRow,
          TBL_ID: "OTHER",
          LINK_URL: "https://kosis.kr/statHtml/statHtml.do?orgId=999&tblId=OTHER",
        },
        searchRow,
      ],
    );
    const result = await s.read(original);
    expect(result).toMatchObject({
      status: "matched",
      selectionBasis: "manual-unverified",
      codeCatalogVerified: false,
      factChecked: false,
      databaseChanged: false,
      aiInputApproved: false,
      source: "kosis-api-response",
    });
    expect(result.cell?.classifications.map((c) => c.code)).toEqual(target.classifications);
    expect(readPublicSelectedCellResult(result, original)).toEqual(result);
    const url = new URL(String(s.fetch.mock.calls[1][0]));
    expect(url.pathname).toBe("/openapi/Param/statisticsParameterData.do");
    expect(url.searchParams.get("itmId")).toBe("t00a");
    expect(url.searchParams.get("objL" + count)).toBe("00a");
    expect(url.searchParams.get("smblChk")).toBe("Y");
    expect(url.searchParams.get("startPrdDe")).toBe("2024");
    expect(url.searchParams.get("endPrdDe")).toBe("2024");
    expect(s.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain("synthetic-only");
  },
);
it.each([
  ["Y", "2024"],
  ["M", "202401"],
  ["Q", "202404"],
])("uses cycle %s and exact point %s", async (cycle, point) => {
  const target = syntheticCellTarget();
  target.period = { cycle: cycle as "Y" | "M" | "Q", point };
  expect(
    (
      await setup([syntheticCellRow(target)]).read({
        ...command,
        selection: { ...selection, period: target.period },
      })
    ).status,
  ).toBe("matched");
});
it.each([
  { itemId: "ALL" },
  { itemId: "all" },
  { itemId: "A+B" },
  { itemId: "https://kosis.kr/?apiKey=secret" },
  { itemId: "x".repeat(41) },
  { classifications: [] },
  { classifications: Array(9).fill("A") },
  { classifications: ["001", "", "002"] },
  { classifications: ["001", "ALL"] },
  { period: { cycle: "S", point: "202401" } },
  { period: { cycle: "H", point: "202401" } },
  { period: { cycle: "Y", point: "latest" } },
  { period: { cycle: "Y", point: "2024-2025" } },
  { period: { cycle: "Y", point: "202401" } },
  { period: { cycle: "M", point: "202413" } },
  { period: { cycle: "Q", point: "202405" } },
  { period: { cycle: "Y", point: "0000" } },
  { period: { cycle: "Y", point: "2024", end: "2025" } },
  { organizationId: "998" },
  { apiKey: "SECRET" },
  { note: "PRIVATE" },
])("rejects invalid manual selection %j before I/O", async (patch) => {
  const s = setup();
  await expect(s.read({ ...command, selection: { ...selection, ...patch } })).rejects.toThrow();
  expect(s.fetch).not.toHaveBeenCalled();
});
it.each([
  { confirmed: false },
  { company: "PRIVATE" },
  { url: "https://evil.invalid" },
  { apiKey: "SECRET" },
  { userStatsId: "X" },
  { action: "read-cell" },
  { searchRetrievedAt: "invalid" },
  { candidate: { ...candidate, originalUrl: null } },
  { candidate: { ...candidate, tableId: "OTHER" } },
  { candidate: { ...candidate, extra: "PRIVATE" } },
])("rejects unsupported command %j", async (patch) => {
  const s = setup();
  await expect(s.read({ ...command, ...patch })).rejects.toThrow();
  expect(s.fetch).not.toHaveBeenCalled();
});
it.each([
  { TBL_NM: "changed" },
  { ORG_NM: "changed" },
  { STRT_PRD_DE: "1999" },
  { END_PRD_DE: "2025" },
  { TBL_ID: "OTHER" },
  { ORG_ID: "998" },
  { LINK_URL: "https://evil.invalid" },
])("changed candidate %j stops before cell", async (patch) => {
  const s = setup(undefined, [{ ...searchRow, ...patch }]);
  await expect(s.read(command)).rejects.toMatchObject({ code: "PUBLIC_TABLE_SELECTION_CHANGED" });
  expect(s.fetch).toHaveBeenCalledOnce();
});
it.each([[], [searchRow, searchRow], { err: "PRIVATE" }])(
  "rejects absent/ambiguous candidate %j",
  async (search) => {
    const s = setup(undefined, search);
    await expect(s.read(command)).rejects.toThrow();
    expect(s.fetch).toHaveBeenCalledOnce();
  },
);
it.each([
  { ORG_ID: "998" },
  { TBL_ID: "OTHER" },
  { ITM_ID: "t001" },
  { C1: "1" },
  { C2: "001" },
  { C3: "003" },
  { PRD_SE: "M" },
  { PRD_DE: "2023" },
  { DT: 12 },
  { UNIT_NM: 9 },
])("rejects row identity/format mismatch %j", async (patch) => {
  const s = setup([{ ...syntheticCellRow(), ...patch }]);
  await expect(s.read(command)).rejects.toMatchObject({ code: "PUBLIC_SELECTED_CELL_UNAVAILABLE" });
  expect(s.fetch).toHaveBeenCalledTimes(2);
});
it.each([
  [syntheticCellRow(), syntheticCellRow()],
  { err: "PRIVATE" },
  [{ ...syntheticCellRow(), DT: "x".repeat(101) }],
])("does not pick first or truncate oversized response %j", async (rows) => {
  await expect(setup(rows).read(command)).rejects.toThrow();
});
it.each(["", "0", "-", "...", "12,345.00", "<b>1</b>"])(
  "preserves raw value %s including empty string",
  async (DT) => {
    const result = await setup([{ ...syntheticCellRow(), DT, UNIT_NM: null }]).read(command);
    expect(result.cell?.value).toBe(DT);
    expect(result.cell?.unitName).toBeNull();
  },
);
it("distinguishes no row from a zero or missing connection", async () => {
  const s = setup([]);
  expect(await s.read(command)).toMatchObject({
    status: "empty",
    cell: null,
    source: "kosis-api-response",
  });
  const fetch = vi.fn();
  const missing = createPublicSelectedCellService({ fetch, apiKey: () => "", now: () => at });
  expect(await missing(command)).toMatchObject({
    status: "not-configured",
    cell: null,
    retrievedAt: null,
    searchCheckedAt: null,
    source: "not-requested",
  });
  expect(fetch).not.toHaveBeenCalled();
});
it("does not turn a lost key after search into an empty result", async () => {
  let calls = 0;
  const fetch = vi.fn(async () => Response.json([searchRow]));
  const read = createPublicSelectedCellService({
    fetch,
    apiKey: () => (++calls === 1 ? "synthetic" : ""),
    now: () => at,
  });
  await expect(read(command)).rejects.toMatchObject({ code: "PUBLIC_SELECTED_CELL_UNAVAILABLE" });
  expect(fetch).toHaveBeenCalledOnce();
});
it("copies manual selection and candidate before awaits", async () => {
  let finish!: (r: Response) => void;
  const input = structuredClone(command),
    original = structuredClone(command);
  const fetch = vi.fn((url: Parameters<typeof globalThis.fetch>[0]) =>
    new URL(String(url)).pathname.endsWith("statisticsSearch.do")
      ? new Promise<Response>((r) => {
          finish = r;
        })
      : Promise.resolve(Response.json([syntheticCellRow()])),
  );
  const read = createPublicSelectedCellService({
    fetch,
    apiKey: () => "synthetic",
    now: () => at,
    gate: createKosisReadGate(),
  });
  const pending = read(input);
  input.selection.itemId = "changed";
  input.selection.classifications[0] = "changed";
  input.candidate.title = "changed";
  finish(Response.json([searchRow]));
  const result = await pending;
  expect(result.command).toEqual(original);
  const copied = readPublicSelectedCellResult(result, original);
  copied.command.selection.classifications[0] = "mutated";
  expect(result.command.selection.classifications[0]).toBe("001");
});
it.each([
  "command",
  "source",
  "authority",
  "catalog",
  "classification",
  "extra",
  "time",
  "status",
  "cell-extra",
])("rejects altered envelope %s", async (change) => {
  const v = await setup().read(command);
  let raw: unknown = v;
  if (change === "command")
    raw = { ...v, command: { ...command, selection: { ...selection, itemId: "OTHER" } } };
  if (change === "source") raw = { ...v, source: "supplied-response" };
  if (change === "authority") raw = { ...v, databaseChanged: true };
  if (change === "catalog") raw = { ...v, codeCatalogVerified: true };
  if (change === "classification")
    raw = {
      ...v,
      cell: {
        ...v.cell,
        classifications: [{ code: "WRONG", dimensionName: null, valueName: null }],
      },
    };
  if (change === "extra") raw = { ...v, approval: true };
  if (change === "time") raw = { ...v, retrievedAt: null };
  if (change === "status") raw = { ...v, status: "empty" };
  if (change === "cell-extra") raw = { ...v, cell: { ...v.cell, script: "bad" } };
  expect(() => readPublicSelectedCellResult(raw, command)).toThrow();
});
it("aborts before dispatch with zero reads", async () => {
  const s = setup();
  const controller = new AbortController();
  controller.abort();
  await expect(s.read(command, controller.signal)).rejects.toThrow();
  expect(s.fetch).not.toHaveBeenCalled();
});
it("bounds both requests by one 20 second deadline and preserves busy until ignored fetch settles", async () => {
  vi.useFakeTimers();
  let release!: (r: Response) => void;
  const fetch = vi.fn(async (url: Parameters<typeof globalThis.fetch>[0]) => {
    if (new URL(String(url)).pathname.endsWith("statisticsSearch.do")) {
      await new Promise((r) => setTimeout(r, 15000));
      return Response.json([searchRow]);
    }
    return new Promise<Response>((r) => {
      release = r;
    });
  });
  const gate = createKosisReadGate();
  const read = createPublicSelectedCellService({
    fetch,
    apiKey: () => "synthetic",
    now: () => at,
    gate,
  });
  const pending = expect(read(command)).rejects.toMatchObject({
    code: "PUBLIC_SELECTED_CELL_UNAVAILABLE",
  });
  await vi.advanceTimersByTimeAsync(15000);
  expect(fetch).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(5000);
  await pending;
  await expect(read(command)).rejects.toMatchObject({ code: "PUBLIC_RESEARCH_BUSY" });
  expect(fetch).toHaveBeenCalledTimes(2);
  release(Response.json([syntheticCellRow()]));
  await vi.advanceTimersByTimeAsync(0);
  const releaseGate = gate.acquire();
  releaseGate();
});
it("production exports share the transport gate while a cell is pending and abort without retry", async () => {
  vi.stubEnv("KOSIS_API_KEY", "synthetic");
  let release!: (r: Response) => void;
  const fetch = vi.fn((url: Parameters<typeof globalThis.fetch>[0]) =>
    new URL(String(url)).pathname.endsWith("statisticsSearch.do")
      ? Promise.resolve(Response.json([searchRow]))
      : new Promise<Response>((r) => {
          release = r;
        }),
  );
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  const pending = readSelectedPublicStatisticsCell(command, controller.signal);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  await expect(searchPublicResearch({ topic: "services" })).rejects.toMatchObject({
    code: "PUBLIC_RESEARCH_BUSY",
  });
  const rejected = expect(pending).rejects.toThrow();
  controller.abort();
  await rejected;
  release(Response.json([syntheticCellRow()]));
  await new Promise((r) => setTimeout(r, 0));
  expect(fetch).toHaveBeenCalledTimes(2);
});
function request(raw: unknown, options?: RequestInit, query = "") {
  return new Request("http://localhost/api/studio/public-research/search" + query, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(raw),
    ...options,
  });
}
it("actual route function connects fresh search and cell with no-store response", async () => {
  const s = setup();
  vi.stubGlobal("fetch", s.fetch);
  vi.stubEnv("KOSIS_API_KEY", "synthetic");
  const response = await POST(request(command));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(readPublicSelectedCellResult(await response.json(), command).status).toBe("matched");
  expect(s.fetch).toHaveBeenCalledTimes(2);
});
it.each(["query", "origin", "extra", "large", "half-year", "full-url"])(
  "HTTP boundary rejects %s before provider",
  async (kind) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("KOSIS_API_KEY", "synthetic");
    let req = request({ ...command, company: "PRIVATE" });
    let status = 400;
    if (kind === "query") req = request(command, undefined, "?x=1");
    if (kind === "origin") {
      req = request(command, {
        headers: { "content-type": "application/json", origin: "https://evil.invalid" },
      });
      status = 403;
    }
    if (kind === "large") {
      req = request({ ...command, note: "x".repeat(8192) });
      status = 413;
    }
    if (kind === "half-year")
      req = request({
        ...command,
        selection: { ...selection, period: { cycle: "S", point: "202401" } },
      });
    if (kind === "full-url")
      req = request({
        ...command,
        selection: { ...selection, itemId: "https://kosis.kr/?apiKey=PRIVATE" },
      });
    expect((await POST(req)).status).toBe(status);
    expect(fetch).not.toHaveBeenCalled();
  },
);
it("SSR is closed/no automatic transmission and result literals remain text", async () => {
  const search = {
    topic: "services",
    query: "서비스업",
    provider: "KOSIS 국가통계포털",
    status: "results",
    retrievedAt: at,
    page: 1,
    pageSize: 10,
    candidates: [candidate],
    originalRead: false,
    databaseChanged: false,
  } as const;
  const markup = renderToStaticMarkup(
    createElement(PublicSelectedCell, {
      candidate,
      searchResult: { ...search, candidates: [candidate] },
    }),
  );
  expect(markup).not.toContain("<details open");
  expect(markup).not.toContain('checked=""');
  const result = await setup([
    { ...syntheticCellRow(), DT: "<b>1</b>", ITM_NM: "<img src=x>", C1_NM: "가".repeat(3000) },
  ]).read(command);
  const html = renderToStaticMarkup(createElement(PublicSelectedCellResultView, { result }));
  expect(html).not.toMatch(/<(?:script|img|a|input)\b/);
  expect(html).toContain("&lt;b&gt;1&lt;/b&gt;");
  expect(html).toContain("가".repeat(3000));
});
it("schema does not infer a default period or classification", () => {
  expect(
    publicSelectedCellCommandSchema.safeParse({ ...command, selection: { itemId: "T001" } })
      .success,
  ).toBe(false);
});
