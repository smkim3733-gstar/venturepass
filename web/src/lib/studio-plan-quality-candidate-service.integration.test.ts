import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
vi.mock("server-only", () => ({}));
import { StudioError } from "./studio-http";
import {
  candidateRegistryCatalogSchema,
  candidateRegistrySnapshotSchema,
} from "./studio-plan-quality-candidate-registry-types";
const state = vi.hoisted(() => ({
  store: null as PlanQualityStore | null,
  opened: vi.fn(),
  external: vi.fn(() => {
    throw new Error("External IO forbidden");
  }),
}));
vi.mock("./studio-plan-quality-store", async (original) => ({
  ...(await original<typeof import("./studio-plan-quality-store")>()),
  getPlanQualityStore: () => {
    state.opened();
    return state.store!;
  },
}));
vi.mock("./studio-storage", () => ({
  getStudioStore: state.external,
  StudioStore: state.external,
}));
vi.mock("openai", () => ({
  default: class {
    constructor() {
      state.external();
    }
  },
}));
import { GET as list } from "@/app/api/studio/quality/candidate-sets/route";
import { POST as register } from "@/app/api/studio/quality/candidate-sets/ai-validation-candidates/versions/route";
import { GET as get } from "@/app/api/studio/quality/candidate-sets/ai-validation-candidates/versions/[version]/route";
import { GET as download } from "@/app/api/studio/quality/candidate-sets/ai-validation-candidates/versions/[version]/download/route";
import { GET as lookup } from "@/app/api/studio/quality/candidate-sets/requests/[clientRequestId]/route";
let directory: string, store: PlanQualityStore;
const base = "http://127.0.0.1:3000/api/studio/quality/candidate-sets";
const versions = base + "/ai-validation-candidates/versions";
const context = (version: string) => ({ params: Promise.resolve({ version }) });
const request = (body: unknown, headers: Record<string, string> = {}, url = versions) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const input = () => ({
  expectedVersion: 0,
  clientRequestId: randomUUID(),
  sourceDigest: store.candidateRegistryList().source.sourceDigest,
  acknowledgedCandidateStatus: true as const,
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", state.external);
  directory = mkdtempSync(join(tmpdir(), "venturepass-candidate-api-"));
  writeFileSync(join(directory, "studio.sqlite"), "COMPANY DATA UNTOUCHED");
  store = new PlanQualityStore(directory);
  state.store = store;
});
afterEach(() => {
  expect(state.external).not.toHaveBeenCalled();
  expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe("COMPANY DATA UNTOUCHED");
  store.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  const target = resolve(directory),
    rel = relative(resolve(tmpdir()), target);
  if (!rel.startsWith("venturepass-candidate-api-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(target, { recursive: true, force: true });
});
describe("bundled candidate registry local API", () => {
  it("lists unregistered 12 and preserves fixed 50 without evaluation claims", async () => {
    const response = await list(new Request(base));
    const catalog = candidateRegistryCatalogSchema.parse(await response.json());
    expect(catalog.versions).toEqual([]);
    expect(catalog.source.entries).toHaveLength(12);
    expect(catalog.source).toMatchObject({
      authoredBy: "ai",
      humanAnswerKey: null,
      independentHoldoutConfirmed: false,
      performanceEvaluation: "not-performed",
    });
    expect(store.list().manifest).toHaveLength(50);
    expect(store.list().runs).toEqual([]);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("registers, looks up a lost response, replays same request and downloads exact stored bytes after restart", async () => {
    const payload = input();
    const response = await register(request(payload));
    expect(response.status).toBe(200);
    const result = await response.json();
    const snapshot = candidateRegistrySnapshotSchema.parse(result.snapshot);
    expect(snapshot.version).toBe(1);
    expect(result.replayed).toBe(false);
    const fixed50 = store.create({
      clientRequestId: randomUUID(),
      title: "기존 회귀 별도 보존",
      manifestDigest: store.list().manifestDigest,
    }).run;
    const oldArchive = store.download(fixed50.id, 0).body;
    const original = await (
      await download(new Request(versions + "/1/download"), context("1"))
    ).text();
    expect(original).toBe(store.candidateRegistryDownload(1).body);
    store.close();
    store = new PlanQualityStore(directory);
    state.store = store;
    const receipt = await (
      await lookup(new Request(base + "/requests/" + payload.clientRequestId), {
        params: Promise.resolve({ clientRequestId: payload.clientRequestId }),
      })
    ).json();
    expect(receipt).toMatchObject({
      state: "committed",
      receipt: {
        clientRequestId: payload.clientRequestId,
        version: 1,
        versionDigest: snapshot.versionDigest,
      },
    });
    const replay = await (await register(request(payload))).json();
    expect(replay).toEqual({ ...result, replayed: true });
    expect(await (await get(new Request(versions + "/1"), context("1"))).json()).toEqual(snapshot);
    const downloaded = await download(new Request(versions + "/1/download"), context("1"));
    expect(await downloaded.text()).toBe(original);
    expect(downloaded.headers.get("content-disposition")).toContain(
      "venturepass-quality-candidates-v1.json",
    );
    expect(downloaded.headers.get("content-security-policy")).toContain("sandbox");
    expect(store.download(fixed50.id, 0).body).toBe(oldArchive);
  });
  it.each([
    ["external host", { host: "evil.example" }, versions],
    ["external origin", { origin: "https://evil.example" }, versions],
    ["cross-site", { "sec-fetch-site": "cross-site" }, versions],
    ["external URL", {}, "https://evil.example/api/studio/quality/candidate-sets"],
  ])("rejects %s before store access", async (_label, headers, url) => {
    const response = await register(
      request(input(), headers as Record<string, string>, url as string),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ accepted: false });
    expect(state.opened).not.toHaveBeenCalled();
  });
  it.each(["0", "01", "-1", "1.0", "21", "1e0", "../1", "999"])(
    "rejects invalid version %s before store access",
    async (version) => {
      const response = await get(
        new Request(versions + "/" + encodeURIComponent(version)),
        context(version),
      );
      expect(response.status).toBe(400);
      expect(state.opened).not.toHaveBeenCalled();
    },
  );
  it.each([
    { acknowledgedCandidateStatus: false },
    { expectedVersion: -1 },
    { clientRequestId: "not-uuid" },
    { sourceDigest: "not-sha" },
    { entries: [] },
    { company: { name: "customer" } },
    { humanAnswerKey: {} },
    { independentHoldoutConfirmed: true },
    { performanceEvaluation: "passed" },
  ])("rejects noncontract fields or consent %j", async (override) => {
    const response = await register(request({ ...input(), ...override }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ accepted: false });
    expect(state.opened).not.toHaveBeenCalled();
  });
  it("checks query, JSON media type, bounded bytes, JSON and UTF-8 before opening storage", async () => {
    for (const [req, status] of [
      [request(input(), {}, versions + "?setId=customer"), 400],
      [request(input(), { "content-type": "text/plain" }), 415],
      [request({ ...input(), padding: "x".repeat(4096) }), 413],
      [
        new Request(versions, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        }),
        400,
      ],
      [
        new Request(versions, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: new Uint8Array([255]),
        }),
        400,
      ],
    ] as const)
      expect((await register(req)).status).toBe(status);
    expect(state.opened).not.toHaveBeenCalled();
  });
  it("rejects stale corpus and changed nonce payload without writing a version", async () => {
    const payload = input();
    const stale = { ...payload, sourceDigest: "0".repeat(64) };
    expect((await register(request(stale))).status).toBe(409);
    expect(store.candidateRegistryList().versions).toEqual([]);
    await register(request(payload));
    const conflict = await register(request({ ...payload, expectedVersion: 1 }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ accepted: false });
    expect(store.candidateRegistryList().versions).toHaveLength(1);
  });
  it("reports missing request as not-observed, never proof of rejection", async () => {
    const clientRequestId = randomUUID();
    const response = await lookup(new Request(base + "/requests/" + clientRequestId), {
      params: Promise.resolve({ clientRequestId }),
    });
    expect(await response.json()).toEqual({ state: "not-observed" });
    expect((await get(new Request(versions + "/1"), context("1"))).status).toBe(404);
  });
  it.each(["QUALITY_STORAGE_UNSAFE", "QUALITY_STORAGE_CORRUPT", "internal"])(
    "keeps %s acceptance unknown and hides internal data",
    async (code) => {
      vi.spyOn(store, "candidateRegistryRegister").mockImplementation(() => {
        if (code === "internal") throw new Error("PRIVATE-MARKER");
        throw new StudioError("품질 저장소 확인 필요", 409, code);
      });
      const result = await (await register(request(input()))).json();
      expect(result).not.toHaveProperty("accepted");
      expect(JSON.stringify(result)).not.toContain("PRIVATE-MARKER");
    },
  );
});
