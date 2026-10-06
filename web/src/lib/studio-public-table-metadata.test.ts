import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createKosisReadGate } from "./studio-kosis-read-transport";
import { createPublicTableMetadataService } from "./studio-public-table-metadata-service";
import {
  decodePublicTableMetadata,
  readPublicTableMetadataResult,
} from "./studio-public-table-metadata";
import { PublicTableMetadata } from "@/components/studio/public-table-metadata";
import { POST } from "@/app/api/studio/public-research/search/route";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("SDK/SQL activation forbidden");
  }),
);
vi.mock("openai", forbidden);
vi.mock("openai/helpers/zod", forbidden);
vi.mock("openai/error", forbidden);
vi.mock("node:sqlite", forbidden);
vi.mock("./studio-storage", forbidden);
vi.mock("./studio-plan-quality-store", forbidden);
vi.mock("./studio-plan-quality-provider-production-runtime", forbidden);
vi.mock("./studio-plan-quality-provider-configuration-current", forbidden);
it("4H9 metadata route and presentation import without SDK/SQL activation", () => {
  expect(typeof POST).toBe("function");
  expect(typeof PublicTableMetadata).toBe("function");
  expect(forbidden).not.toHaveBeenCalled();
});

const at = "2026-10-05T08:42:00.000Z";
const candidate = {
  organizationId: "999",
  tableId: "DT_SYNTHETIC",
  title: "합성 표",
  organization: "합성 기관",
  periodStart: "2020",
  periodEnd: "2024",
  originalUrl: "https://kosis.kr/statHtml/statHtml.do?orgId=999&tblId=DT_SYNTHETIC",
};
const command = {
  action: "read-selected-table-metadata" as const,
  topic: "services" as const,
  candidate,
  searchRetrievedAt: at,
  kind: "TBL" as const,
  confirmed: true as const,
};
const searchRow = {
  ORG_ID: candidate.organizationId,
  TBL_ID: candidate.tableId,
  TBL_NM: candidate.title,
  ORG_NM: candidate.organization,
  STRT_PRD_DE: "2020",
  END_PRD_DE: "2024",
  LINK_URL: candidate.originalUrl,
};
const rows = {
  TBL: [{ TBL_NM: "합성 메타 이름", TBL_NM_ENG: null }],
  PRD: [
    { PRD_SE: "IR", PRD_DE: "unknown" },
    { PRD_SE: "Y", PRD_DE: "2024" },
  ],
  SOURCE: [
    { JOSA_NM: "합성 조사", STAT_ID: "SYNTHETIC", DEPT_NM: null, DEPT_PHONE: "<img src=x>" },
  ],
};
function setup(meta: unknown = rows.TBL, search: unknown = [searchRow]) {
  const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) =>
    new URL(String(input)).pathname.endsWith("statisticsSearch.do")
      ? Response.json(search)
      : Response.json(meta),
  );
  const read = createPublicTableMetadataService({
    apiKey: () => "synthetic-only-key",
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
it.each(["TBL", "PRD", "SOURCE"] as const)(
  "checks exact current candidate and reads only %s without echoed ID claims",
  async (kind) => {
    const s = setup(rows[kind]),
      value = await s.read({ ...command, kind });
    expect(s.fetch).toHaveBeenCalledTimes(2);
    const first = new URL(String(s.fetch.mock.calls[0][0])),
      second = new URL(String(s.fetch.mock.calls[1][0]));
    expect(first.searchParams.get("searchNm")).toBe("서비스업");
    expect(Object.fromEntries(second.searchParams)).toEqual({
      method: "getMeta",
      type: kind,
      orgId: "999",
      tblId: "DT_SYNTHETIC",
      format: "json",
      content: "json",
      apiKey: "synthetic-only-key",
    });
    expect(value).toMatchObject({
      status: "results",
      source: "kosis-api-response",
      identityBasis: "request-target-not-echoed",
      periodsComplete: false,
      numericalDataRead: false,
      factChecked: false,
      databaseChanged: false,
      aiInputApproved: false,
      metadata: { kind, rows: rows[kind] },
      searchCheckedAt: at,
      retrievedAt: at,
    });
    expect(JSON.stringify(value)).not.toContain("synthetic-only-key");
    expect(readPublicTableMetadataResult(value, { ...command, kind })).toEqual(value);
  },
);
it.each([
  { TBL_NM: "renamed" },
  { ORG_NM: "changed" },
  { STRT_PRD_DE: "1999" },
  { END_PRD_DE: "2025" },
  { TBL_ID: "OTHER" },
  { ORG_ID: "998" },
  { LINK_URL: "https://evil.invalid" },
])("rejects changed current candidate %j before metadata dispatch", async (patch) => {
  const s = setup(rows.TBL, [{ ...searchRow, ...patch }]);
  await expect(s.read(command)).rejects.toMatchObject({ code: "PUBLIC_TABLE_SELECTION_CHANGED" });
  expect(s.fetch).toHaveBeenCalledOnce();
});
it.each([[], [searchRow, searchRow], { err: "bad" }, [{ ...searchRow, TBL_NM: undefined }]])(
  "rejects missing/ambiguous search provenance %j",
  async (fresh) => {
    const s = setup(rows.TBL, fresh);
    await expect(s.read(command)).rejects.toThrow();
    expect(s.fetch).toHaveBeenCalledOnce();
  },
);
it.each([
  { company: "private" },
  { apiKey: "private" },
  { url: "https://evil.invalid" },
  { confirmed: false },
  { kind: "ITM" },
  { kind: "NCD" },
  { kind: "UNIT" },
  { kind: "ALL" },
  { action: "read-cell" },
  { searchRetrievedAt: "bad" },
  { candidate: { ...candidate, company: "private" } },
  { candidate: { ...candidate, originalUrl: null } },
  { candidate: { ...candidate, organizationId: "999&secret=x" } },
])("rejects unapproved command %j before I/O", async (patch) => {
  const s = setup();
  await expect(s.read({ ...command, ...patch })).rejects.toThrow();
  expect(s.fetch).not.toHaveBeenCalled();
});
it("reports missing key without upstream reads", async () => {
  const fetch = vi.fn();
  const read = createPublicTableMetadataService({ apiKey: () => "", fetch, now: () => at });
  expect(await read(command)).toMatchObject({
    status: "not-configured",
    source: "not-requested",
    metadata: null,
  });
  expect(fetch).not.toHaveBeenCalled();
});
it.each(["TBL", "PRD", "SOURCE"] as const)(
  "keeps empty %s distinct from absent statistics",
  async (kind) => {
    const s = setup([]);
    expect(await s.read({ ...command, kind })).toMatchObject({
      status: "empty",
      metadata: { kind, rows: [] },
    });
  },
);
it.each([
  ["TBL", [{ TBL_NM: "a" }, { TBL_NM: "b" }]],
  ["TBL", [{ TBL_NM: "x".repeat(301) }]],
  ["TBL", [{ TBL_NM: "a", ORG_ID: "999" }]],
  ["TBL", [{ TBL_NM: "a", script: "bad" }]],
  [
    "PRD",
    [
      { PRD_SE: "Y", PRD_DE: "2024" },
      { PRD_SE: "Y", PRD_DE: "2024" },
    ],
  ],
  ["PRD", Array.from({ length: 33 }, (_, i) => ({ PRD_SE: "Y", PRD_DE: String(i) }))],
  ["PRD", [{ PRD_SE: "Y", PRD_DE: "123456789" }]],
  ["PRD", [{ PRD_SE: "Y", PRD_DE: 2024 }]],
  ["SOURCE", Array(11).fill(rows.SOURCE[0])],
  ["SOURCE", [{ JOSA_NM: "x".repeat(301), STAT_ID: "s" }]],
  ["SOURCE", [{ JOSA_NM: "a", STAT_ID: "x".repeat(41) }]],
  ["SOURCE", [{ JOSA_NM: "a", STAT_ID: "s", DEPT_PHONE: "x".repeat(101) }]],
  ["SOURCE", [{ JOSA_NM: "a" }]],
  ["SOURCE", { err: "private" }],
] as const)("rejects malformed/oversized metadata %s %j", async (kind, body) => {
  const s = setup(body);
  await expect(s.read({ ...command, kind })).rejects.toMatchObject({
    code: "PUBLIC_TABLE_METADATA_UNAVAILABLE",
  });
  expect(s.fetch).toHaveBeenCalledTimes(2);
});
it("preserves missing/null/empty literal fields and isolates copies", () => {
  const raw = [{ JOSA_NM: "", STAT_ID: "", DEPT_NM: null, DEPT_PHONE: "<a href=x>name</a>" }];
  const value = decodePublicTableMetadata(raw, "SOURCE");
  expect(value.rows).toEqual(raw);
  if (value.kind !== "SOURCE") throw Error("Unexpected test metadata kind");
  value.rows[0].JOSA_NM = "changed";
  expect(raw[0].JOSA_NM).toBe("");
  const title = decodePublicTableMetadata([{ TBL_NM: "한".repeat(300) }], "TBL");
  if (title.kind !== "TBL") throw Error("Unexpected test metadata kind");
  expect(title.rows[0].TBL_NM).toHaveLength(300);
});
it("copies the complete expected selection before await", async () => {
  let finish!: (r: Response) => void;
  const snapshot = structuredClone(command),
    original = structuredClone(command);
  const fetch = vi.fn((input: Parameters<typeof globalThis.fetch>[0]) =>
    new URL(String(input)).pathname.endsWith("statisticsSearch.do")
      ? new Promise<Response>((r) => {
          finish = r;
        })
      : Promise.resolve(Response.json(rows.TBL)),
  );
  const read = createPublicTableMetadataService({
    apiKey: () => "synthetic",
    fetch,
    now: () => at,
    gate: createKosisReadGate(),
  });
  const pending = read(snapshot);
  snapshot.candidate.tableId = "changed";
  finish(Response.json([searchRow]));
  expect((await pending).command).toEqual(original);
});
it.each(["command", "source", "kind", "authority", "time", "status", "extra"])(
  "rejects altered client response %s",
  async (alteration) => {
    const value = await setup().read(command);
    let raw: unknown = value;
    if (alteration === "command")
      raw = { ...value, command: { ...command, candidate: { ...candidate, tableId: "OTHER" } } };
    if (alteration === "source") raw = { ...value, source: "supplied-response" };
    if (alteration === "kind") raw = { ...value, metadata: { kind: "PRD", rows: rows.PRD } };
    if (alteration === "authority") raw = { ...value, factChecked: true };
    if (alteration === "time") raw = { ...value, retrievedAt: null };
    if (alteration === "status") raw = { ...value, status: "empty" };
    if (alteration === "extra") raw = { ...value, receiptVerified: true };
    expect(() => readPublicTableMetadataResult(raw, command)).toThrow();
  },
);
it("uses one total 20-second deadline for both provider reads", async () => {
  vi.useFakeTimers();
  let finish!: (r: Response) => void;
  const fetch = vi.fn((input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    if (new URL(String(input)).pathname.endsWith("statisticsSearch.do"))
      return new Promise<Response>((r) => {
        finish = r;
      });
    return new Promise<Response>((_r, reject) =>
      init?.signal?.addEventListener("abort", () => reject(Error("synthetic")), { once: true }),
    );
  });
  const read = createPublicTableMetadataService({
    apiKey: () => "synthetic",
    fetch,
    now: () => at,
    gate: createKosisReadGate(),
  });
  const pending = expect(read(command)).rejects.toMatchObject({
    code: "PUBLIC_TABLE_METADATA_UNAVAILABLE",
  });
  await vi.advanceTimersByTimeAsync(15000);
  finish(Response.json([searchRow]));
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(5000);
  await pending;
});
it("cancels before dispatch and between search and metadata", async () => {
  const s = setup();
  await expect(s.read(command, AbortSignal.abort())).rejects.toThrow();
  expect(s.fetch).not.toHaveBeenCalled();
  const controller = new AbortController();
  const fetch = vi.fn(async () => Response.json([searchRow]));
  const read = createPublicTableMetadataService({
    apiKey: () => "synthetic",
    fetch,
    now: () => {
      controller.abort();
      return at;
    },
    gate: createKosisReadGate(),
  });
  await expect(read(command, controller.signal)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledOnce();
});
it("SSR does not query or render metadata/authority and escapes the candidate", () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const html = renderToStaticMarkup(
    createElement(PublicTableMetadata, {
      candidate: { ...candidate, title: "<script>bad</script>" },
      searchResult: {
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
      },
    }),
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain('aria-label="읽은 표 정보"');
  expect(html).not.toContain(" open=");
});
function request(raw: unknown = command, extra: RequestInit = {}, suffix = "") {
  return new Request("http://localhost/api/studio/public-research/search" + suffix, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(raw),
    ...extra,
  });
}
it("routes metadata and preserves the old search response with no-store", async () => {
  vi.stubEnv("KOSIS_API_KEY", "synthetic");
  const s = setup();
  vi.stubGlobal("fetch", s.fetch);
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(readPublicTableMetadataResult(await response.json(), command).metadata?.kind).toBe("TBL");
  const old = await POST(request({ topic: "services" }));
  expect(old.status).toBe(200);
  expect(await old.json()).toHaveProperty("candidates");
  expect(s.fetch).toHaveBeenCalledTimes(3);
});
it("rejects local request threats and old/new body limits before provider access", async () => {
  vi.stubEnv("KOSIS_API_KEY", "synthetic");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  for (const [req, status] of [
    [request(command, {}, "?x=private"), 400],
    [
      request(command, {
        headers: { "content-type": "application/json", origin: "https://evil.invalid" },
      }),
      403,
    ],
    [request(command, { headers: { "content-type": "text/plain" } }), 415],
    [request({ ...command, company: "private" }), 400],
    [request({ ...command, note: "x".repeat(8192) }), 413],
    [request({ topic: "x".repeat(1024) }), 413],
  ] as const)
    expect((await POST(req)).status).toBe(status);
  expect(fetch).not.toHaveBeenCalled();
});

const commentCommand = { ...command, kind: "CMMT" as const };
const comment = {
  CMMT_NM: " 표 주석 ",
  CMMT_DC: " 원래 주석\n<svg onload=alert(1)> & https://example.invalid ",
  OBJ_ID: "",
  OBJ_NM: null,
  ITM_ID: " 01 ",
  ITM_NM: "원래 명칭",
};
it("4H9 reads the exact CMMT target through the existing route without scope promotion", async () => {
  vi.stubEnv("KOSIS_API_KEY", "synthetic-only-key");
  const s = setup([comment, comment, { CMMT_NM: "", CMMT_DC: "" }]);
  vi.stubGlobal("fetch", s.fetch);
  const response = await POST(request(commentCommand));
  expect(response.status).toBe(200);
  const result = readPublicTableMetadataResult(await response.json(), commentCommand);
  expect(result.metadata).toEqual({
    kind: "CMMT",
    rows: [comment, comment, { CMMT_NM: "", CMMT_DC: "" }],
  });
  expect(s.fetch).toHaveBeenCalledTimes(2);
  expect(Object.fromEntries(new URL(String(s.fetch.mock.calls[1][0])).searchParams)).toEqual({
    method: "getMeta",
    type: "CMMT",
    orgId: "999",
    tblId: "DT_SYNTHETIC",
    format: "json",
    content: "json",
    apiKey: "synthetic-only-key",
  });
  expect(result).toMatchObject({
    originalRead: false,
    numericalDataRead: false,
    identityBasis: "request-target-not-echoed",
    factChecked: false,
    databaseChanged: false,
    companyApplicabilityChecked: false,
    aiInputApproved: false,
  });
  expect(response.headers.get("cache-control")).toContain("no-store");
});
it("4H9 preserves absent/null/empty/whitespace, order and duplicates in detached copies", () => {
  const raw = [{ CMMT_NM: "", CMMT_DC: "" }, comment, comment];
  const meta = decodePublicTableMetadata(raw, "CMMT");
  expect(meta.rows).toEqual(raw);
  expect(Object.hasOwn(meta.rows[0], "OBJ_ID")).toBe(false);
  if (meta.kind !== "CMMT") throw Error("Unexpected kind");
  expect(meta.rows[1].OBJ_ID).toBe("");
  expect(meta.rows[1].OBJ_NM).toBeNull();
  meta.rows[1].CMMT_DC = "changed";
  expect(raw[1].CMMT_DC).toBe(comment.CMMT_DC);
  expect(meta.rows[2].CMMT_DC).toBe(comment.CMMT_DC);
});
it("4H9 accepts all application row and field boundaries without shortening", () => {
  const row = {
    CMMT_NM: "한".repeat(40),
    CMMT_DC: "한".repeat(3000),
    OBJ_ID: "o".repeat(40),
    OBJ_NM: "한".repeat(3000),
    ITM_ID: "i".repeat(40),
    ITM_NM: "한".repeat(3000),
  };
  expect(decodePublicTableMetadata([row], "CMMT").rows).toEqual([row]);
  expect(decodePublicTableMetadata(Array(100).fill(comment), "CMMT").rows).toHaveLength(100);
});
it.each([
  null,
  {},
  { err: "30", errMsg: "synthetic-only-key" },
  "<html>private</html>",
  Array(101).fill(comment),
  ...["CMMT_NM", "CMMT_DC"].flatMap((key) =>
    [undefined, null, 1, []].map((v) => [{ ...comment, [key]: v }]),
  ),
  ...[
    ["CMMT_NM", 41],
    ["CMMT_DC", 3001],
    ["OBJ_ID", 41],
    ["OBJ_NM", 3001],
    ["ITM_ID", 41],
    ["ITM_NM", 3001],
  ].map(([key, size]) => [{ ...comment, [key]: "x".repeat(Number(size)) }]),
  [{ ...comment, OBJ_ID: 1 }],
  [{ ...comment, ITM_NM: [] }],
  [{ ...comment, ORG_ID: "999" }],
  [{ ...comment, PRD_DE: "2024" }],
])("4H9 rejects unsupported comment payload %# with a safe failure", async (raw) => {
  const s = setup(raw);
  await expect(s.read(commentCommand)).rejects.toMatchObject({
    code: "PUBLIC_TABLE_METADATA_UNAVAILABLE",
    message: "선택한 표 정보를 확인하지 못했습니다. 검색 후보를 다시 확인해 주세요.",
  });
  expect(s.fetch).toHaveBeenCalledTimes(2);
});
it.each(["objId", "itmId", "objL1", "prdSe", "startPrdDe", "page", "url", "company", "apiKey"])(
  "4H9 rejects uncontracted selector %s before transport",
  async (key) => {
    const s = setup([comment]);
    await expect(s.read({ ...commentCommand, [key]: "private" })).rejects.toThrow();
    expect(s.fetch).not.toHaveBeenCalled();
  },
);
it("4H9 keeps zero received rows distinct from malformed or absent comments", async () => {
  const result = await setup([]).read(commentCommand);
  expect(readPublicTableMetadataResult(result, commentCommand)).toMatchObject({
    status: "empty",
    metadata: { kind: "CMMT", rows: [] },
    originalRead: false,
  });
  expect(() =>
    readPublicTableMetadataResult({ ...result, status: "results" }, commentCommand),
  ).toThrow();
});
it("4H9 candidate change and configuration loss never turn into empty success", async () => {
  const s = setup([comment], [{ ...searchRow, TBL_NM: "changed" }]);
  await expect(s.read(commentCommand)).rejects.toMatchObject({
    code: "PUBLIC_TABLE_SELECTION_CHANGED",
  });
  expect(s.fetch).toHaveBeenCalledOnce();
  const fetch = vi.fn(async () => Response.json([searchRow]));
  let calls = 0;
  const read = createPublicTableMetadataService({
    apiKey: () => (++calls === 1 ? "synthetic" : ""),
    fetch,
    now: () => at,
    gate: createKosisReadGate(),
  });
  await expect(read(commentCommand)).rejects.toMatchObject({
    code: "PUBLIC_TABLE_METADATA_UNAVAILABLE",
  });
  expect(fetch).toHaveBeenCalledOnce();
  const unavailable = createPublicTableMetadataService({ apiKey: () => "", fetch, now: () => at });
  expect(await unavailable(commentCommand)).toMatchObject({
    status: "not-configured",
    metadata: null,
  });
  expect(fetch).toHaveBeenCalledOnce();
});
it.each(["kind", "target", "authority", "extra"])(
  "4H9 rejects altered accepted envelope %s",
  async (change) => {
    const result = await setup([comment]).read(commentCommand);
    const raw = structuredClone(result);
    if (change === "kind") raw.command.kind = "TBL";
    if (change === "target") raw.command.candidate.title = "other";
    if (change === "authority") Object.assign(raw, { originalRead: true });
    if (change === "extra") Object.assign(raw, { cellApplicable: true });
    expect(() => readPublicTableMetadataResult(raw, commentCommand)).toThrow();
  },
);
it("4H9 aborted original I/O holds the shared slot until its own completion", async () => {
  let finish!: (r: Response) => void;
  let entered!: () => void;
  const reached = new Promise<void>((r) => {
    entered = r;
  });
  const gate = createKosisReadGate();
  const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) => {
    if (new URL(String(input)).pathname.endsWith("statisticsSearch.do"))
      return Response.json([searchRow]);
    entered();
    return new Promise<Response>((r) => {
      finish = r;
    });
  });
  const read = createPublicTableMetadataService({
    apiKey: () => "synthetic",
    fetch,
    now: () => at,
    gate,
  });
  const controller = new AbortController();
  const pending = expect(read(commentCommand, controller.signal)).rejects.toThrow();
  await reached;
  controller.abort();
  await pending;
  await expect(read(commentCommand)).rejects.toMatchObject({ code: "PUBLIC_RESEARCH_BUSY" });
  expect(fetch).toHaveBeenCalledTimes(2);
  finish(Response.json([comment]));
  await vi.waitFor(() => {
    const release = gate.acquire();
    release();
  });
});
