import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { getPlanExecutionContract } from "./studio-engine";
import { runQualityMockExecution } from "./studio-plan-quality-execution-runner";
import { qualityExecutionSnapshotSchema } from "./studio-plan-quality-execution-types";
import { StudioError } from "./studio-http";
const state = vi.hoisted(() => ({
  store: null as PlanQualityStore | null,
  opened: vi.fn(),
  external: vi.fn(() => {
    throw new Error("External IO forbidden");
  }),
}));
vi.mock("server-only", () => ({}));
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
import { GET as list, POST as start } from "@/app/api/studio/quality/candidate-executions/route";
import { POST as prepare } from "@/app/api/studio/quality/candidate-executions/prepare/route";
import { GET as get } from "@/app/api/studio/quality/candidate-executions/[executionId]/route";
import { GET as revisionGet } from "@/app/api/studio/quality/candidate-executions/[executionId]/revisions/[revision]/route";
import { GET as download } from "@/app/api/studio/quality/candidate-executions/[executionId]/revisions/[revision]/download/route";
import { GET as lookup } from "@/app/api/studio/quality/candidate-executions/requests/[clientRequestId]/route";
let directory: string, store: PlanQualityStore;
const base = "http://127.0.0.1:3000/api/studio/quality/candidate-executions";
const request = (body: unknown, headers: Record<string, string> = {}, url = base) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
function input() {
  const registry = store.candidateRegistryList();
  if (!registry.versions.length)
    store.candidateRegistryRegister({
      expectedVersion: 0,
      clientRequestId: randomUUID(),
      sourceDigest: registry.source.sourceDigest,
      acknowledgedCandidateStatus: true,
    });
  return {
    clientRequestId: randomUUID(),
    acknowledgedMockOnly: true as const,
    preparation: store.executionPrepare(
      { version: 1, candidateId: registry.source.entries[0].candidateId },
      getPlanExecutionContract(),
    ),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", state.external);
  directory = mkdtempSync(join(tmpdir(), "venturepass-execution-api-"));
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
  if (!rel.startsWith("venturepass-execution-api-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(target, { recursive: true, force: true });
});
describe("mock candidate execution API and durable orchestration", () => {
  it("prepares exact registered input, records two calls and preserves all archived bytes across restart/replay", async () => {
    const payload = input(),
      selected = payload.preparation;
    const prepared = await prepare(
      request({ version: 1, candidateId: selected.candidateId }, {}, base + "/prepare"),
    );
    expect(prepared.status).toBe(200);
    expect(await prepared.json()).toEqual(selected);
    expect(selected.cost).toMatchObject({
      actualCharge: 0,
      actualAiAllowed: false,
      priceEvidence: null,
    });
    const old = store.create({
      clientRequestId: randomUUID(),
      title: "기존 평가 보존",
      manifestDigest: store.list().manifestDigest,
    }).run;
    const oldBytes = store.download(old.id, 0).body,
      registryBytes = store.candidateRegistryDownload(1).body;
    const response = await start(request(payload));
    expect(response.status).toBe(200);
    const result = await response.json(),
      snapshot = qualityExecutionSnapshotSchema.parse(result.snapshot);
    expect(snapshot).toMatchObject({
      state: "completed",
      revision: 7,
      dispatchCount: 2,
      responseCount: 2,
      validatedCount: 2,
      actualAiCalls: 0,
      canResume: false,
    });
    expect(snapshot.events.map((event) => event.payload.kind)).toEqual([
      "dispatch",
      "response",
      "validated",
      "dispatch",
      "response",
      "validated",
      "finished",
    ]);
    expect(snapshot.output.plan?.summary).toContain("제출용 원고 아님");
    expect(snapshot.notice).toContain("품질 합격 또는 독립 검증을 증명하지 않습니다");
    for (const event of snapshot.events)
      if (event.payload.kind === "response") {
        expect(event.payload.response.usage).toBeNull();
        expect(event.payload.response.responseId).toContain("mock-");
      }
    const id = snapshot.run.id,
      context = { params: Promise.resolve({ executionId: id, revision: "0" }) };
    const historical = await (
      await download(new Request(`${base}/${id}/revisions/0/download`), context)
    ).text();
    expect(JSON.parse(historical).state).toBe("authorized");
    const completeBytes = store.executionDownload(id, 7).body;
    store.close();
    store = new PlanQualityStore(directory);
    state.store = store;
    const append = vi.spyOn(store, "executionAppend");
    expect(await (await start(request(payload))).json()).toEqual({ ...result, replayed: true });
    expect(append).not.toHaveBeenCalled();
    const recovered = await (
      await lookup(new Request(`${base}/requests/${payload.clientRequestId}`), {
        params: Promise.resolve({ clientRequestId: payload.clientRequestId }),
      })
    ).json();
    expect(recovered).toMatchObject({
      state: "committed",
      receipt: {
        executionId: id,
        clientRequestId: payload.clientRequestId,
        planDigest: selected.planDigest,
      },
    });
    expect(
      await (
        await get(new Request(`${base}/${id}`), { params: Promise.resolve({ executionId: id }) })
      ).json(),
    ).toEqual(snapshot);
    const downloaded = await download(new Request(`${base}/${id}/revisions/7/download`), {
      params: Promise.resolve({ executionId: id, revision: "7" }),
    });
    expect(await downloaded.text()).toBe(completeBytes);
    expect(downloaded.headers.get("content-disposition")).toContain(
      `venturepass-quality-execution-${id}-r7.json`,
    );
    expect(downloaded.headers.get("content-security-policy")).toContain("sandbox");
    expect(store.executionDownload(id, 0).body).toBe(historical);
    expect(store.download(old.id, 0).body).toBe(oldBytes);
    expect(store.candidateRegistryDownload(1).body).toBe(registryBytes);
    expect((await (await list(new Request(base))).json()).executions).toHaveLength(1);
  }, 15000);
  it.each(["external host", "external origin", "cross-site", "external URL"])(
    "rejects %s before opening storage",
    async (kind) => {
      const headers: Record<string, string> =
        kind === "external host"
          ? { host: "evil.example" }
          : kind === "external origin"
            ? { origin: "https://evil.example" }
            : kind === "cross-site"
              ? { "sec-fetch-site": "cross-site" }
              : {};
      const response = await start(
        request(
          {},
          headers,
          kind === "external URL"
            ? "https://evil.example/api/studio/quality/candidate-executions"
            : base,
        ),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ accepted: false });
      expect(state.opened).not.toHaveBeenCalled();
    },
  );
  it.each([
    { mode: "actual-ai" },
    { provider: "OpenAI" },
    { company: { name: "customer" } },
    { transport: "custom" },
    { acknowledgedMockOnly: false },
  ])("rejects unsupported input %j", async (override) => {
    const response = await start(request({ ...input(), ...override }));
    expect(response.status).toBe(400);
    expect(state.opened).not.toHaveBeenCalled();
    expect(store.executionList().executions).toEqual([]);
  });
  it("rejects queries, media type, oversized JSON, malformed UTF8 and missing registration", async () => {
    for (const [req, status] of [
      [request({}, {}, base + "?mode=actual-ai"), 400],
      [request({}, { "content-type": "text/plain" }), 415],
      [request({ padding: "x".repeat(50 * 1024) }), 413],
      [
        new Request(base, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: new Uint8Array([255]),
        }),
        400,
      ],
      [
        new Request(base, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        }),
        400,
      ],
    ] as const)
      expect((await start(req)).status).toBe(status);
    expect(state.opened).not.toHaveBeenCalled();
    expect(
      (await prepare(request({ version: 1, candidateId: "validation-candidate-missing" }))).status,
    ).toBe(404);
  });
  it.each(["-1", "01", "8", "1.0", "1e0"])("rejects revision %s", async (revision) => {
    expect(
      (
        await revisionGet(new Request(base), {
          params: Promise.resolve({ executionId: randomUUID(), revision }),
        })
      ).status,
    ).toBe(400);
    expect(state.opened).not.toHaveBeenCalled();
  });
  it("keeps an unobserved request distinct from failure and never resumes a committed incomplete run", async () => {
    const payload = input(),
      initial = store.executionStart(payload, getPlanExecutionContract()).snapshot;
    const append = vi.spyOn(store, "executionAppend");
    const replay = await (await start(request(payload))).json();
    expect(replay).toEqual({ snapshot: initial, replayed: true });
    expect(append).not.toHaveBeenCalled();
    const clientRequestId = randomUUID();
    expect(
      await (
        await lookup(new Request(base), { params: Promise.resolve({ clientRequestId }) })
      ).json(),
    ).toEqual({ state: "not-observed" });
    expect((await start(request({ ...payload, clientRequestId }))).status).toBe(409);
    expect(store.executionList().executions).toHaveLength(1);
  });
  it("retains a durable dispatch as unknown on transport failure without retrying or opening the next phase", async () => {
    const initial = store.executionStart(input(), getPlanExecutionContract()).snapshot;
    const transport = vi.fn(async () => {
      throw new Error("PRIVATE TRANSPORT DETAILS");
    });
    const result = await runQualityMockExecution(store, initial, transport);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      state: "unknown",
      dispatchCount: 1,
      responseCount: 0,
      canResume: false,
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE TRANSPORT DETAILS");
    await expect(runQualityMockExecution(store, result, transport)).rejects.toMatchObject({
      code: "QUALITY_EXECUTION_REPLAY",
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("persists response metadata before rejecting malformed output, with no review call", async () => {
    const initial = store.executionStart(input(), getPlanExecutionContract()).snapshot;
    const transport = vi.fn(async () => ({
      id: "mock-malformed",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "{" }] }],
    }));
    const result = await runQualityMockExecution(store, initial, transport);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ state: "failed", responseCount: 1, validatedCount: 0 });
    expect(result.events[1].payload).toMatchObject({
      kind: "response",
      response: { responseId: "mock-malformed" },
    });
  });
  it("blocks transport if dispatch cannot commit and blocks the next call if response recording fails", async () => {
    const initial = store.executionStart(input(), getPlanExecutionContract()).snapshot;
    const original = store.executionAppend.bind(store);
    let failKind = "dispatch";
    vi.spyOn(store, "executionAppend").mockImplementation((id, rev, payload) => {
      if (payload.kind === failKind) throw new Error("PRIVATE STORAGE DETAILS");
      return original(id, rev, payload);
    });
    const transport = vi.fn(async () => ({ id: "mock-response", status: "completed", output: [] }));
    const result = await runQualityMockExecution(store, initial, transport);
    expect(transport).not.toHaveBeenCalled();
    expect(result.state).toBe("failed");
    failKind = "response";
    const second = store.executionStart(input(), getPlanExecutionContract()).snapshot;
    const unknown = await runQualityMockExecution(store, second, transport);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(unknown).toMatchObject({ state: "unknown", dispatchCount: 1, responseCount: 0 });
    expect(unknown.events.at(-1)?.payload).toMatchObject({ failureCode: "RESPONSE_UNRECORDED" });
  });
  it("does not claim rejection when post-start recording is unavailable and recovers its receipt", async () => {
    const payload = input();
    vi.spyOn(store, "executionAppend").mockImplementation(() => {
      throw new Error("PRIVATE STORAGE DETAILS");
    });
    const response = await start(request(payload));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).not.toHaveProperty("accepted");
    expect(JSON.stringify(body)).not.toContain("PRIVATE");
    expect(store.executionLookup(payload.clientRequestId).state).toBe("committed");
    expect(store.executionList().executions[0].state).toBe("authorized");
  });
  it.each(["QUALITY_STORAGE_UNSAFE", "QUALITY_STORAGE_CORRUPT"])(
    "keeps %s ambiguous",
    async (code) => {
      const payload = input();
      vi.spyOn(store, "executionStart").mockImplementation(() => {
        throw new StudioError("기록 확인 필요", 409, code);
      });
      expect(await (await start(request(payload))).json()).not.toHaveProperty("accepted");
    },
  );
});
