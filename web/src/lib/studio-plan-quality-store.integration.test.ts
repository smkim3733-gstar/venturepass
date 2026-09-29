import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
vi.mock("server-only", () => ({}));
import { failQualityReceiptInsert } from "./studio-plan-quality-policy-storage-test-helpers";
import * as evaluation from "./studio-plan-quality-evaluation";
import {
  createPlanQualityRecordTemplate,
  planQualityArchiveSchema,
  planQualityRunSnapshotSchema,
  planQualityStoreLimits,
} from "./studio-plan-quality-store-types";

const state = vi.hoisted(() => ({
  store: null as PlanQualityStore | null,
  external: vi.fn(() => {
    throw new Error("External IO forbidden");
  }),
}));
vi.mock("./studio-plan-quality-store", async (original) => ({
  ...(await original<typeof import("./studio-plan-quality-store")>()),
  getPlanQualityStore: () => state.store!,
}));
vi.mock("./studio-storage", () => ({
  getStudioStore: () => state.external(),
  StudioStore: () => state.external(),
}));
vi.mock("openai", () => ({
  default: class {
    constructor() {
      state.external();
    }
  },
}));
import { GET, POST } from "@/app/api/studio/quality/runs/route";
import { GET as detail } from "@/app/api/studio/quality/runs/[runId]/route";
import { POST as append } from "@/app/api/studio/quality/runs/[runId]/records/route";
import { GET as historical } from "@/app/api/studio/quality/runs/[runId]/revisions/[revision]/route";
import { GET as lookup } from "@/app/api/studio/quality/runs/requests/[clientRequestId]/route";
import { GET as download } from "@/app/api/studio/quality/runs/[runId]/revisions/[revision]/download/route";
import { GET as fixtureDetail } from "@/app/api/studio/quality/runs/[runId]/fixtures/[fixtureId]/route";
let directory: string, store: PlanQualityStore;
const base = "http://127.0.0.1:3000/api/studio/quality/runs";
const context = (runId: string) => ({ params: Promise.resolve({ runId }) });
const request = (body: unknown, url = base, headers: Record<string, string> = {}) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const createInput = () => ({
  clientRequestId: randomUUID(),
  title: "합성 계약 시험",
  manifestDigest: store.list().manifestDigest,
});
const create = () => store.create(createInput()).run;
beforeEach(() => {
  state.external.mockClear();
  vi.stubGlobal("fetch", state.external);
  directory = mkdtempSync(join(tmpdir(), "venturepass-quality-records-"));
  writeFileSync(join(directory, "studio.sqlite"), "COMPANY DATABASE MUST NOT BE OPENED");
  store = new PlanQualityStore(directory);
  state.store = store;
}, 15000);
afterEach(() => {
  expect(state.external).not.toHaveBeenCalled();
  expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe(
    "COMPANY DATABASE MUST NOT BE OPENED",
  );
  store.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  const target = resolve(directory),
    boundary = resolve(tmpdir()),
    rel = relative(boundary, target);
  if (!rel.startsWith("venturepass-quality-records-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(target, { recursive: true, force: true });
});

describe("fixed synthetic quality history persistence", () => {
  it("pins all 50 inputs without inventing evaluation, AI execution, or completion", () => {
    const run = create();
    expect(run.revision).toBe(0);
    expect(run.records).toHaveLength(50);
    expect(run.summary?.counts.unevaluated).toBe(50);
    expect(run.summary?.counts.passed).toBe(0);
    expect(run.recordSource).toBe("user-supplied-records");
    const { fixture, template } = store.fixture(run.id, run.manifest[0].fixtureId);
    expect(fixture.synthetic).toBe(true);
    expect(fixture.sources.length).toBeGreaterThan(0);
    expect(
      evaluation.planQualityEvaluationDigest({
        profile: fixture.profile,
        sources: fixture.sources,
      }),
    ).toBe(template.sourceDigest);
    expect(template.answerKey).toBeNull();
    expect(template.execution).toBeNull();
    expect(template.humanReviews).toEqual([]);
  });
  it("commits a full append-only revision and keeps historical JSON stable after later edits", () => {
    const run = create(),
      record = structuredClone(run.records[0]);
    record.answerKey = {
      authorId: "synthetic-author",
      factsAndIssues: ["합성 자료의 사실을 기록한 시험"],
      sufficientForCompleteDraft: false,
      mustBlockSubmission: true,
      rationale: "합성 계약시험이며 실제 평가가 아닙니다.",
    };
    const first = store.save(run.id, { revision: 0, clientRequestId: randomUUID(), record });
    const archive = store.download(run.id, 1).body;
    record.answerKey.rationale = "두 번째 합성 기록";
    const second = store.save(run.id, { revision: 1, clientRequestId: randomUUID(), record });
    expect(second.run.revision).toBe(2);
    expect(second.run.history.at(-1)?.fixtureRevision).toBe(2);
    expect(store.get(run.id, 1).records[0].answerKey?.rationale).toBe(
      first.run.records[0].answerKey?.rationale,
    );
    expect(store.download(run.id, 1).body).toBe(archive);
    expect(planQualityArchiveSchema.parse(JSON.parse(archive))).not.toHaveProperty(
      "currentRevision",
    );
    expect(store.get(run.id, 1).currentRevision).toBe(2);
  });
  it("replays exact nonce after newer revisions, rejects same nonce with changed scope", () => {
    const input = createInput(),
      run = store.create(input).run;
    const record = run.records[0],
      payload = { revision: 0, clientRequestId: randomUUID(), record };
    store.save(run.id, payload);
    store.save(run.id, { ...payload, revision: 1, clientRequestId: randomUUID() });
    expect(store.save(run.id, payload)).toMatchObject({
      replayed: true,
      run: { revision: 1, currentRevision: 2 },
    });
    expect(store.create(input)).toMatchObject({
      replayed: true,
      run: { revision: 0, currentRevision: 2 },
    });
    expect(() => store.create({ ...input, title: "다른 제목" })).toThrowError(
      expect.objectContaining({ code: "QUALITY_NONCE_CONFLICT" }),
    );
    expect(() => store.save(run.id, { ...payload, revision: 2 })).toThrowError(
      expect.objectContaining({ code: "QUALITY_NONCE_CONFLICT" }),
    );
    expect(store.lookup(payload.clientRequestId)).toMatchObject({
      state: "committed",
      receipt: { runId: run.id, revision: 1 },
    });
    expect(store.lookup(randomUUID())).toEqual({ state: "not-observed" });
  });
  it("uses CAS across independent database connections and records no failed request", () => {
    const run = create(),
      other = new PlanQualityStore(directory);
    try {
      const payload = { revision: 0, clientRequestId: randomUUID(), record: run.records[0] };
      other.save(run.id, payload);
      const rejected = { ...payload, clientRequestId: randomUUID() };
      expect(() => store.save(run.id, rejected)).toThrowError(
        expect.objectContaining({ code: "QUALITY_REVISION_CONFLICT" }),
      );
      expect(store.lookup(rejected.clientRequestId)).toEqual({ state: "not-observed" });
      expect(store.get(run.id).revision).toBe(1);
    } finally {
      other.close();
    }
  }, 15000);
  it.each(["sourceDigest", "candidateDigest", "inputPlanDigest", "rubricDigest"] as const)(
    "rejects changed %s without a revision",
    (key) => {
      const run = create(),
        record = { ...run.records[0], [key]: "f".repeat(64) },
        clientRequestId = randomUUID();
      expect(() => store.save(run.id, { revision: 0, clientRequestId, record })).toThrowError(
        expect.objectContaining({ code: "QUALITY_INVALID_RECORD" }),
      );
      expect(store.get(run.id).revision).toBe(0);
      expect(store.lookup(clientRequestId)).toEqual({ state: "not-observed" });
    },
  );
  it("rejects a fabricated execution digest and an unknown/customer corpus fixture", () => {
    const run = create(),
      record = structuredClone(run.records[0]);
    record.execution = {
      executionId: "mock-only",
      mode: "mock",
      provider: null,
      model: null,
      generatedAt: new Date().toISOString(),
      inputDigest: evaluation.planQualityInputDigest(record),
      output: { plan: null, disposition: "failed", submissionReadiness: "not-observed" },
      outputDigest: "0".repeat(64),
    };
    expect(() =>
      store.save(run.id, { revision: 0, clientRequestId: randomUUID(), record }),
    ).toThrowError(expect.objectContaining({ code: "QUALITY_INVALID_RECORD" }));
    expect(() =>
      store.save(run.id, {
        revision: 0,
        clientRequestId: randomUUID(),
        record: { ...run.records[0], fixtureId: "customer-company" },
      }),
    ).toThrowError(expect.objectContaining({ code: "QUALITY_INVALID_RECORD" }));
    expect(store.get(run.id).summary?.actualAiRecorded).toBe(0);
  });
  it("keeps old pinned fixtures/history readable but blocks current aggregation and append after corpus changes", () => {
    const input = createInput(),
      run = store.create(input).run,
      archive = store.download(run.id, 0).body;
    const manifest = evaluation.createPlanQualityEvaluationManifest();
    manifest[0].label = "Changed future corpus";
    vi.spyOn(evaluation, "createPlanQualityEvaluationManifest").mockReturnValue(manifest);
    const newer = new PlanQualityStore(directory);
    try {
      expect(newer.get(run.id)).toMatchObject({ manifestCurrent: false, summary: null });
      expect(newer.fixture(run.id, run.manifest[0].fixtureId).fixture.label).toBe(
        run.manifest[0].label,
      );
      expect(newer.download(run.id, 0).body).toBe(archive);
      expect(newer.create(input).replayed).toBe(true);
      expect(() =>
        newer.save(run.id, { revision: 0, clientRequestId: randomUUID(), record: run.records[0] }),
      ).toThrowError(expect.objectContaining({ code: "QUALITY_MANIFEST_CHANGED" }));
    } finally {
      newer.close();
    }
  }, 15000);
  it("detects stored record corruption and immutable tables reject updates", () => {
    const run = create(),
      db = new DatabaseSync(join(directory, "quality-evaluation", "quality.sqlite"));
    try {
      expect(() => db.prepare("UPDATE quality_runs SET body='{}' WHERE id=?").run(run.id)).toThrow(
        "immutable",
      );
      const trigger = db
        .prepare("SELECT sql FROM sqlite_schema WHERE name='quality_runs_no_update'")
        .get()!.sql as string;
      db.exec("DROP TRIGGER quality_runs_no_update");
      db.prepare("UPDATE quality_runs SET body='{}' WHERE id=?").run(run.id);
      // Isolate body corruption from v8's earlier whole-schema rejection.
      expect(() => store.get(run.id)).toThrow();
      db.exec(trigger);
      expect(() => store.get(run.id)).toThrowError(
        expect.objectContaining({ code: "QUALITY_STORAGE_CORRUPT" }),
      );
    } finally {
      db.close();
    }
  });
  it("keeps immutable downloads readable when a newer validator rejects previously accepted records", () => {
    const run = create();
    store.save(run.id, { revision: 0, clientRequestId: randomUUID(), record: run.records[0] });
    const before = store.download(run.id, 1).body;
    vi.spyOn(evaluation, "validatePlanQualityEvaluation").mockReturnValue({
      ok: false,
      errors: ["future-validation-rule"],
    });
    expect(store.download(run.id, 1).body).toBe(before);
    expect(() =>
      store.save(run.id, { revision: 1, clientRequestId: randomUUID(), record: run.records[0] }),
    ).toThrowError(expect.objectContaining({ code: "QUALITY_INVALID_RECORD" }));
    expect(store.get(run.id).revision).toBe(1);
  });
  it("enforces retention limits inside the transaction without accepting another nonce", () => {
    const previousRuns = planQualityStoreLimits.runs;
    // Smaller test budget exercises the identical transaction branch without 20 large snapshots.
    Object.assign(planQualityStoreLimits, { runs: 1 });
    try {
      create();
      const input = createInput();
      expect(() => store.create(input)).toThrowError(
        expect.objectContaining({ code: "QUALITY_RUN_LIMIT" }),
      );
      expect(store.lookup(input.clientRequestId)).toEqual({ state: "not-observed" });
    } finally {
      Object.assign(planQualityStoreLimits, { runs: previousRuns });
    }
  });
  it("does not follow a substituted quality storage directory", () => {
    const nested = join(directory, "linked"),
      elsewhere = join(directory, "quality-evaluation");
    symlinkSync(elsewhere, nested, process.platform === "win32" ? "junction" : "dir");
    expect(() => new PlanQualityStore(nested)).toThrowError(
      expect.objectContaining({ code: "QUALITY_STORAGE_UNSAFE" }),
    );
    expect(existsSync(join(elsewhere, "quality-evaluation"))).toBe(false);
  });
  it("rolls back the revision if recording its nonce fails", () => {
    const run = create(),
      input = { revision: 0, clientRequestId: randomUUID(), record: run.records[0] };
    const failure = failQualityReceiptInsert("quality_requests");
    expect(() => store.save(run.id, input)).toThrow("synthetic receipt insertion failure");
    expect(failure).toHaveBeenCalledOnce();
    expect(store.get(run.id).revision).toBe(0);
    expect(store.lookup(input.clientRequestId)).toEqual({ state: "not-observed" });
  });
  it("orders by revision when the local clock moves backwards, preserving observed timestamps", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-26T05:00:00.000Z"));
      const run = create(),
        input = { revision: 0, clientRequestId: randomUUID(), record: run.records[0] };
      const before = store.download(run.id, 0).body;
      vi.setSystemTime(new Date("2026-09-26T04:00:00.000Z"));
      const saved = store.save(run.id, input);
      expect(saved.run.revision).toBe(1);
      expect(saved.run.updatedAt).toBe("2026-09-26T04:00:00.000Z");
      expect(saved.run.history.map((v) => v.revision)).toEqual([0, 1]);
      expect(store.download(run.id, 0).body).toBe(before);
      expect(store.save(run.id, input).replayed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it("detects a deleted revision whose committed receipt still exists", () => {
    const run = create();
    store.save(run.id, { revision: 0, clientRequestId: randomUUID(), record: run.records[0] });
    const db = new DatabaseSync(join(directory, "quality-evaluation", "quality.sqlite"));
    try {
      db.exec("DROP TRIGGER quality_revisions_no_delete; DELETE FROM quality_revisions;");
      expect(() => store.get(run.id)).toThrowError(
        expect.objectContaining({ code: "QUALITY_STORAGE_CORRUPT" }),
      );
    } finally {
      db.close();
    }
  });
  it("enforces record, total-byte, and per-run revision limits without partial writes", () => {
    const run = create(),
      limits = { ...planQualityStoreLimits };
    const input = { revision: 0, clientRequestId: randomUUID(), record: run.records[0] };
    try {
      Object.assign(planQualityStoreLimits, { recordBytes: 1 });
      expect(() => store.save(run.id, input)).toThrowError(
        expect.objectContaining({ code: "QUALITY_RECORD_LIMIT" }),
      );
      Object.assign(planQualityStoreLimits, { recordBytes: limits.recordBytes, totalBytes: 1 });
      expect(() => store.save(run.id, input)).toThrowError(
        expect.objectContaining({ code: "QUALITY_STORAGE_LIMIT" }),
      );
      Object.assign(planQualityStoreLimits, { totalBytes: limits.totalBytes, revisions: 1 });
      store.save(run.id, input);
      expect(() =>
        store.save(run.id, { ...input, revision: 1, clientRequestId: randomUUID() }),
      ).toThrowError(expect.objectContaining({ code: "QUALITY_REVISION_LIMIT" }));
      expect(store.get(run.id).revision).toBe(1);
    } finally {
      Object.assign(planQualityStoreLimits, limits);
    }
  });
});

describe("local quality API boundary", () => {
  it("supports create/list/fixture/append/history/receipt and stable JSON export", async () => {
    const response = await POST(request(createInput()));
    expect(response.status).toBe(200);
    const run = planQualityRunSnapshotSchema.parse((await response.json()).run);
    expect((await (await GET(new Request(base))).json()).runs).toHaveLength(1);
    const fixtureResponse = await fixtureDetail(new Request(base), {
      params: Promise.resolve({ runId: run.id, fixtureId: run.manifest[0].fixtureId }),
    });
    expect((await fixtureResponse.json()).fixture.synthetic).toBe(true);
    const input = {
      revision: 0,
      clientRequestId: randomUUID(),
      record: createPlanQualityRecordTemplate(run.manifest[0]),
    };
    expect((await append(request(input), context(run.id))).status).toBe(200);
    expect((await detail(new Request(base), context(run.id))).status).toBe(200);
    expect(
      (
        await historical(new Request(base), {
          params: Promise.resolve({ runId: run.id, revision: "0" }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await (
          await lookup(new Request(base), {
            params: Promise.resolve({ clientRequestId: input.clientRequestId }),
          })
        ).json()
      ).state,
    ).toBe("committed");
    const exported = await download(new Request(base), {
      params: Promise.resolve({ runId: run.id, revision: "1" }),
    });
    expect(exported.headers.get("cache-control")).toContain("no-store");
    expect(exported.headers.get("content-disposition")).toContain("attachment");
    expect(planQualityArchiveSchema.parse(await exported.json()).revision).toBe(1);
  });
  it.each([
    ["external URL", "https://example.com/api/studio/quality/runs", {}, 403],
    ["cross origin", base, { origin: "https://example.com" }, 403],
    ["cross site", base, { "sec-fetch-site": "cross-site" }, 403],
    ["content type", base, { "content-type": "text/plain" }, 415],
    ["URL query", base + "?companyId=anything", {}, 400],
    ["body limit", base, { "content-length": "999999" }, 413],
  ] as const)("rejects %s before saving", async (_label, url, headers, status) => {
    const response = await POST(request(createInput(), url, headers));
    expect(response.status).toBe(status);
    expect((await response.json()).accepted).toBe(false);
    expect(store.list().runs).toEqual([]);
  });
  it("rejects unknown fields and malformed records, returns definite CAS failures", async () => {
    const created = await POST(request({ ...createInput(), customerCorpus: [] }));
    expect(created.status).toBe(400);
    const run = create();
    const payload = { revision: 0, clientRequestId: randomUUID(), record: run.records[0] };
    await append(request(payload), context(run.id));
    const conflict = await append(
      request({ ...payload, clientRequestId: randomUUID() }),
      context(run.id),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      accepted: false,
      code: "QUALITY_REVISION_CONFLICT",
    });
    expect(
      (
        await historical(new Request(base), {
          params: Promise.resolve({ runId: run.id, revision: "01" }),
        })
      ).status,
    ).toBe(400);
  });
});
