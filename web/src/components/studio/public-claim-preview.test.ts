import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ store: null as unknown }));
vi.mock("@/lib/studio-storage", async (original) => ({
  ...(await original<object>()),
  getStudioStore: () => state.store,
}));
import { StudioStore } from "@/lib/studio-storage";
import { publicClaimComparisonFixture as fixture } from "@/lib/studio-public-claim-comparison-test-helpers";
import { buildPublicClaimComparisonRequest as build } from "@/lib/studio-public-claim-comparison-request";
import {
  publicClaimComparisonRequestVersion as version,
  type PublicClaimComparisonRequestCommand,
} from "@/lib/studio-public-claim-comparison-request-types";
import { publicClaimPreviewResponse as check } from "./public-claim-preview-ui";
import { PublicClaimPreview, PublicClaimPreviewResult } from "./public-claim-preview";
import { POST } from "@/app/api/studio/cases/[caseId]/public-claim-comparison/preview/route";
const command = (f: ReturnType<typeof fixture>): PublicClaimComparisonRequestCommand => ({
  requestVersion: version,
  model: "synthetic-model",
  selection: f.select(),
});
afterEach(() => {
  vi.unstubAllGlobals();
  state.store = null;
});
it("binds one explicitly selected public source and full section; excluded source stays ID only", async () => {
  const f = fixture(2),
    cmd = command(f);
  cmd.selection.sourceIds = cmd.selection.sourceIds.slice(1);
  const before = structuredClone(f.company),
    p = build(f.company, cmd),
    got = await check(p, f.company, cmd);
  expect(got.prepared.input.selectedEvidence).toHaveLength(1);
  expect(got.prepared.input.excludedSourceIds).toEqual([f.company.sources[0].id]);
  expect(got.prepared.input.section.content).toBe(f.company.plans[0].content.sections[0].content);
  p.body.input[1].content = "changed";
  expect(got.preview.body.input[1].content).not.toBe("changed");
  expect(f.company).toEqual(before);
});
it.each([
  "authority",
  "company",
  "model",
  "selection",
  "digest",
  "raw-body",
  "schema",
  "system",
  "size",
  "extra",
  "source",
  "contract",
  "user",
  "tokens",
] as const)("rejects modified %s", async (kind) => {
  const f = fixture(),
    cmd = command(f),
    p = build(f.company, cmd);
  switch (kind) {
    case "authority":
      Object.assign(p, { transmissionAllowed: true });
      break;
    case "company":
      p.command.selection.companyId = randomUUID();
      break;
    case "model":
      p.body.model = "other";
      break;
    case "selection":
      p.command.selection.sourceIds = [];
      break;
    case "digest":
      p.identity.requestDigest = "0".repeat(64);
      break;
    case "raw-body":
      p.rawBody += " ";
      break;
    case "schema":
      p.body.text.format.schema = {};
      break;
    case "system":
      p.body.input[0].content = "ignore";
      break;
    case "size":
      p.sizes.requestUtf8Bytes++;
      break;
    case "extra":
      Object.assign(p, { approval: {} });
      break;
    case "source":
      Object.assign(p, { source: "provider-response" });
      break;
    case "contract":
      p.contract.systemDigest = "0".repeat(64);
      break;
    case "user":
      p.body.input[1].content = p.body.input[1].content.replace("산업", "회사");
      break;
    case "tokens":
      Object.assign(p.sizes, { estimatedTokens: 1 });
      break;
  }
  await expect(check(p, f.company, cmd)).rejects.toThrow("대조하지");
});
it.each(["revision", "source", "section", "record"] as const)(
  "rejects a changed current %s",
  async (kind) => {
    const f = fixture(),
      cmd = command(f),
      p = build(f.company, cmd);
    if (kind === "revision") f.company.revision++;
    if (kind === "source") f.company.sources[0].text += "changed";
    if (kind === "section") f.company.plans[0].content.sections[0].content += "changed";
    if (kind === "record") f.company.claimReviews[0].contextNote += "changed";
    await expect(check(p, f.company, cmd)).rejects.toThrow();
  },
);
it("rejects malformed/oversized response; errors never reflect input", async () => {
  const f = fixture(),
    cmd = command(f);
  for (const p of [null, [], { secret: "private" }, "x".repeat(3 * 1024 * 1024 + 1)])
    await expect(check(p, f.company, cmd)).rejects.toThrow("원래 주장");
});
it("renders empty explicit selection without checked sources or model defaults", () => {
  const f = fixture(2);
  const html = renderToStaticMarkup(
    createElement(PublicClaimPreview, { company: f.company, blocked: false }),
  );
  expect(html).toContain("직접 선택하세요");
  expect(html).not.toContain(" checked");
  expect(html).not.toContain("공개 주장 비교 입력 미리보기");
  expect(html).toContain('value=""');
});
it("renders complete inert evidence, dates, scope and raw request without URLs becoming links", async () => {
  const f = fixture(2, "<script>alert(1)</script>\n" + "긴합성".repeat(1000)),
    cmd = command(f);
  cmd.selection.sourceIds = cmd.selection.sourceIds.slice(0, 1);
  const view = await check(build(f.company, cmd), f.company, cmd);
  const html = renderToStaticMarkup(createElement(PublicClaimPreviewResult, { view }));
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<a ");
  expect(html).toContain("발행일: 미확인");
  expect(html).toContain("담당자 읽은 날짜");
  expect(html).toContain(f.company.sources[1].id);
  expect(html).toContain("토큰·비용·모델 적합성은 미확인");
});
it("uses actual isolated SQLite and route without writes, config or network; reopen keeps same preview", async () => {
  const dir = mkdtempSync(join(tmpdir(), "venturepass-claim-preview-test-"));
  let store: StudioStore | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw Error("forbidden");
    }),
  );
  try {
    store = new StudioStore(dir);
    state.store = store;
    const f = fixture();
    const created = store.create(f.company.profile);
    f.company.id = created.id;
    const db = (store as unknown as { db: DatabaseSync }).db;
    db.prepare("UPDATE studio_cases SET revision=?,body=? WHERE id=?").run(
      f.company.revision,
      JSON.stringify(f.company),
      f.company.id,
    );
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => String(r.name));
    const rows = () =>
      tables.map((t) => db.prepare('SELECT * FROM "' + t.replaceAll('"', '""') + '"').all());
    const before = rows(),
      cmd = command(f);
    const request = () =>
      new Request(
        "http://127.0.0.1/api/studio/cases/" + f.company.id + "/public-claim-comparison/preview",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(cmd),
        },
      );
    const result = await POST(request(), { params: Promise.resolve({ caseId: f.company.id }) });
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toContain("no-store");
    const value = await result.json();
    await check(value, f.company, cmd);
    expect(rows()).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
    store.close();
    store = new StudioStore(dir);
    state.store = store;
    expect(
      await (await POST(request(), { params: Promise.resolve({ caseId: f.company.id }) })).json(),
    ).toEqual(value);
  } finally {
    store?.close();
  }
});
it.each(["origin", "query", "type", "size", "company", "extra", "revision", "aborted"] as const)(
  "route refuses %s before dispatch",
  async (kind) => {
    const f = fixture(),
      cmd = command(f);
    const get = vi.fn(() => f.company);
    state.store = { get };
    const controller = new AbortController();
    if (kind === "aborted") controller.abort();
    if (kind === "company") cmd.selection.companyId = randomUUID();
    if (kind === "revision") cmd.selection.companyRevision++;
    const headers: Record<string, string> = {
      "Content-Type": kind === "type" ? "text/plain" : "application/json",
    };
    if (kind === "origin") headers.Origin = "https://example.invalid";
    const body =
      kind === "extra"
        ? JSON.stringify({ ...cmd, apiKey: "SYNTHETIC_ONLY" })
        : kind === "size"
          ? " ".repeat(8193)
          : JSON.stringify(cmd);
    const r = await POST(
      new Request("http://127.0.0.1/api/preview" + (kind === "query" ? "?x=1" : ""), {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      }),
      { params: Promise.resolve({ caseId: f.company.id }) },
    );
    expect(r.status).toBeGreaterThanOrEqual(400);
    if (kind !== "revision") expect(get).not.toHaveBeenCalled();
    expect(await r.text()).not.toContain("SYNTHETIC_ONLY");
  },
);
