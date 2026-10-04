import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import { supplementFixture } from "./studio-plan-supplement-test-helpers";
vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ store: null as StudioStore | null, sdk: vi.fn() }));
vi.mock("./studio-storage", async (original) => ({
  ...(await original<typeof import("./studio-storage")>()),
  getStudioStore: () => state.store!,
}));
vi.mock("openai", () => ({
  default: class {
    constructor() {
      state.sdk();
      throw Error("No SDK allowed");
    }
  },
}));
import { POST } from "@/app/api/studio/cases/[caseId]/plan-supplements/preview/route";
let directory: string, f: ReturnType<typeof supplementFixture>;
function dbRead() {
  const db = new DatabaseSync(join(directory, "studio.sqlite"));
  try {
    return ["studio_cases", "venture_accounts", "venture_workflows"].map((table) =>
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    );
  } finally {
    db.close();
  }
}
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("OPENAI_MODEL", "");
  vi.clearAllMocks();
  directory = mkdtempSync(join(tmpdir(), "venture-plan-supplement-"));
  state.store = new StudioStore(directory);
  f = supplementFixture();
  const created = state.store.create(f.value.profile);
  f.value.id = created.id;
  const db = new DatabaseSync(join(directory, "studio.sqlite"));
  try {
    db.prepare("UPDATE studio_cases SET body=?,revision=?,evidence_revision=? WHERE id=?").run(
      JSON.stringify(f.value),
      f.value.revision,
      f.value.revision,
      f.value.id,
    );
  } finally {
    db.close();
  }
});
afterEach(() => {
  state.store?.close();
  vi.unstubAllEnvs();
  const boundary = relative(resolve(tmpdir()), resolve(directory));
  if (
    !boundary.startsWith("venture-plan-supplement-") ||
    boundary.includes("..") ||
    isAbsolute(boundary)
  )
    throw Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});
const post = (body: unknown, suffix = "", headers: Record<string, string> = {}) =>
  POST(
    new Request(
      `http://localhost:3000/api/studio/cases/${f.value.id}/plan-supplements/preview${suffix}`,
      {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
          ...headers,
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
    ),
    { params: Promise.resolve({ caseId: f.value.id }) },
  );
async function preview() {
  const response = await post({ action: "prepare", input: f.input });
  expect(response.status).toBe(200);
  return response.json();
}
describe("단일 항목 보완 비교의 읽기 전용 API/SQLite", () => {
  it("키 없이 준비·비교하고 DB전체 행/원고·자료·승인에 쓰지 않는다", async () => {
    const before = dbRead(),
      prepared = await preview();
    const response = await post({
      action: "compare",
      input: f.input,
      binding: prepared.binding,
      draft: f.draft,
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      origin: "supplied-draft",
      databaseChanged: false,
      transmissionAllowed: false,
    });
    expect(result.after.content).toBe(f.draft.content);
    expect(dbRead()).toEqual(before);
    expect(state.sdk).not.toHaveBeenCalled();
    state.store!.close();
    state.store = new StudioStore(directory);
    expect(dbRead()).toEqual(before);
    expect((await preview()).binding).toEqual(prepared.binding);
  });
  it("기존 save-plan이 비교한 정확한 한 항목만 새 manual 버전에 보관할 수 있고 원래 기록은 불변이다", async () => {
    const prepared = await preview(),
      r = await post({
        action: "compare",
        input: f.input,
        binding: prepared.binding,
        draft: f.draft,
      }),
      proposal = await r.json();
    const before = state.store!.get(f.value.id),
      old = JSON.stringify(before.plans),
      sources = JSON.stringify(before.sources);
    const saved = state.store!.mutate(
      before.id,
      {
        action: "save-plan",
        revision: before.revision,
        planId: proposal.basePlanId,
        content: proposal.content,
      },
      () => [],
    );
    expect(JSON.stringify(saved.plans.slice(0, -1))).toBe(old);
    expect(JSON.stringify(saved.sources)).toBe(sources);
    expect(saved.plans.at(-1)).toMatchObject({
      mode: "manual",
      confirmedAt: null,
      content: proposal.content,
      sourceRevision: before.plans[0].sourceRevision,
    });
    expect(saved.plans.at(-1)!.version).toBe(3);
    // Test-only explicit save-plan reuse is not a new bound adoption API.
    expect(
      (await post({ action: "compare", input: f.input, binding: prepared.binding, draft: f.draft }))
        .status,
    ).toBe(409);
    expect(state.sdk).not.toHaveBeenCalled();
  });
  it("보완 자료 변경 뒤 이전 binding을 새 revision에 이식하지 않는다", async () => {
    const prepared = await preview(),
      source = { ...f.value.sources[0], text: "변경된 답변", updatedAt: "later" };
    const saved = state.store!.mutate(
        f.value.id,
        { action: "source", revision: f.value.revision, source },
        () => [],
      ),
      before = dbRead();
    expect(
      (await post({ action: "compare", input: f.input, binding: prepared.binding, draft: f.draft }))
        .status,
    ).toBe(409);
    expect(saved.revision).toBeGreaterThan(f.input.revision);
    expect(dbRead()).toEqual(before);
  });
  it.each(["query", "origin", "mime", "extra", "action", "too-large"])(
    "%s 요청은 쓰기나 SDK 실행 없이 거절한다",
    async (kind) => {
      const before = dbRead(),
        body = { action: "prepare", input: f.input };
      const response = await post(
        kind === "too-large"
          ? " ".repeat(128 * 1024 + 1)
          : kind === "extra"
            ? { ...body, approved: true }
            : kind === "action"
              ? { ...body, action: "run-ai" }
              : body,
        kind === "query" ? "?approved=true" : "",
        kind === "origin"
          ? { origin: "https://example.com" }
          : kind === "mime"
            ? { "content-type": "text/plain" }
            : {},
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(dbRead()).toEqual(before);
      expect(state.sdk).not.toHaveBeenCalled();
    },
  );
});
