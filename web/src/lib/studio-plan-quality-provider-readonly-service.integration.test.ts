import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow, actualTestPlan } from "./studio-plan-quality-actual-test-helpers";
import {
  providerTestConfigure,
  providerTestStartInput,
} from "./studio-plan-quality-provider-test-helpers";
import {
  providerExecutionTestApproval,
  providerExecutionTestResponse,
} from "./studio-plan-quality-provider-execution-test-helpers";
import { runQualityProviderSimulation } from "./studio-plan-quality-provider-runner";
import { planQualityEvaluationDigest as digest } from "./studio-plan-quality-evaluation";
import type { CandidateRegistrySnapshot } from "./studio-plan-quality-candidate-registry-types";
import type { ProviderStart } from "./studio-plan-quality-provider-types";
import {
  providerReviewViewSchema,
  providerReviewDigestInput,
  providerReviewBlockerCodes,
} from "./studio-plan-quality-provider-review-types";

const state = vi.hoisted(() => ({
  store: null as PlanQualityStore | null,
  opened: vi.fn(),
  proposal: null as unknown,
  environmentRead: vi.fn(),
  forbidden: vi.fn(() => {
    throw new Error("Forbidden provider or company access");
  }),
}));
vi.mock("server-only", () => ({}));
// Preserve the original unconfigured API contract independently of a later read-only proposal.
vi.mock("./studio-plan-quality-provider-configuration", async (original) => ({
  ...(await original<typeof import("./studio-plan-quality-provider-configuration")>()),
  getProviderConfigurationProposal: () => state.proposal,
}));
vi.mock("./studio-plan-quality-store", async (original) => ({
  ...(await original<typeof import("./studio-plan-quality-store")>()),
  getPlanQualityStore: () => {
    state.opened();
    return state.store!;
  },
}));
vi.mock("./studio-storage", () => ({
  getStudioStore: state.forbidden,
  StudioStore: state.forbidden,
}));
vi.mock("openai", () => ({
  default: class {
    constructor() {
      state.forbidden();
    }
  },
}));
import * as inspectRoute from "@/app/api/studio/quality/provider-review/inspect/route";
import * as overviewRoute from "@/app/api/studio/quality/provider-ledger/route";
import { GET as get } from "@/app/api/studio/quality/provider-ledger/runs/[runId]/route";
import { GET as revision } from "@/app/api/studio/quality/provider-ledger/runs/[runId]/revisions/[revision]/route";
import { GET as download } from "@/app/api/studio/quality/provider-ledger/runs/[runId]/revisions/[revision]/download/route";
import { GET as artifact } from "@/app/api/studio/quality/provider-ledger/runs/[runId]/revisions/[revision]/artifacts/[artifactKey]/route";
import { GET as lookup } from "@/app/api/studio/quality/provider-ledger/requests/[clientRequestId]/route";
import { POST as legacyInspect } from "@/app/api/studio/quality/actual-preparation/route";
import { qualityProviderReviewRoute } from "./studio-plan-quality-provider-review-service";
import { qualityProviderLedgerRoute } from "./studio-plan-quality-provider-ledger-service";

let directory: string, store: PlanQualityStore, registry: CandidateRegistrySnapshot;
let reservedInput: ProviderStart,
  reservedId: string,
  cancelledId: string,
  completedId: string,
  completedRevision: number;
let baseline: string, originalEnvironment: NodeJS.ProcessEnv;
const base = "http://127.0.0.1:3000/api/studio/quality";
const request = (suffix = "", init?: RequestInit) =>
  new Request(base + "/provider-ledger" + suffix, init);
const input = () => ({
  version: registry.version,
  versionDigest: registry.versionDigest,
  candidateId: registry.entries[0].candidateId,
});
const post = (body: unknown = input(), init: RequestInit = {}, suffix = "") =>
  new Request(base + "/provider-review/inspect" + suffix, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  });
const context = <T extends Record<string, string>>(params: T) => ({
  params: Promise.resolve(params),
});
const hash = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex");
function rowsDigest() {
  const db = new DatabaseSync(join(directory, "quality-evaluation", "quality.sqlite"), {
    readOnly: true,
  });
  try {
    const names = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'quality_%' ORDER BY name",
      )
      .all();
    return digest(
      names.map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]),
    );
  } finally {
    db.close();
  }
}
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(actualTestNow));
  vi.stubGlobal("fetch", state.forbidden);
  directory = mkdtempSync(join(tmpdir(), "venturepass-provider-readonly-api-"));
  writeFileSync(join(directory, "studio.sqlite"), "synthetic company sentinel");
  store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
  registry = store.candidateRegistryRegister({
    expectedVersion: 0,
    clientRequestId: randomUUID(),
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  }).snapshot;
  providerTestConfigure(store);
  reservedInput = providerTestStartInput(store);
  reservedId = store.providerStart(reservedInput).snapshot.run.id;
  cancelledId = store.providerStart(providerTestStartInput(store, 1)).snapshot.run.id;
  store.providerCancel(cancelledId, {
    clientRequestId: randomUUID(),
    expectedRevision: 0,
    reason: "test-cleanup",
  });
  completedId = store.providerStart(providerTestStartInput(store, 2)).snapshot.run.id;
  const approval = providerExecutionTestApproval(store, completedId);
  const result = await runQualityProviderSimulation(store, completedId, approval, {
    transport: {
      provenance: "synthetic-test",
      model: "synthetic-provider-model",
      contractDigest: approval.payload.manifest.executionContract.contractDigest,
      send: async ({ request: wire }) =>
        providerExecutionTestResponse(
          wire.phase === "generation" ? actualTestPlan(registry, 2) : { findings: [] },
        ),
    },
  });
  expect(result.snapshot.state).toBe("completed");
  completedRevision = result.snapshot.revision;
  store.close();
  store = new PlanQualityStore(directory);
  state.store = store;
  baseline = rowsDigest();
}, 30000);
beforeEach(() => {
  vi.clearAllMocks();
  state.proposal = null;
  originalEnvironment = process.env;
  process.env = new Proxy(originalEnvironment, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^(OPENAI|VENTURE_DATA_DIR)/.test(property)) {
        state.environmentRead(property);
        throw new Error("Credential/config access forbidden");
      }
      return Reflect.get(target, property, receiver);
    },
  });
});
afterEach(() => {
  process.env = originalEnvironment;
  vi.restoreAllMocks();
  expect(state.environmentRead).not.toHaveBeenCalled();
  expect(state.forbidden).not.toHaveBeenCalled();
  expect(rowsDigest()).toBe(baseline);
});
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  store?.close();
  expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe("synthetic company sentinel");
  const target = resolve(directory),
    rel = relative(resolve(tmpdir()), target);
  if (!rel.startsWith("venturepass-provider-readonly-api-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(target, { recursive: true, force: true });
});

describe("read-only v2 review", () => {
  it("shows the server proposal without adopting synthetic budget or changing any ledger rows", async () => {
    const configuration = await vi.importActual<
      typeof import("./studio-plan-quality-provider-configuration")
    >("./studio-plan-quality-provider-configuration");
    state.proposal = configuration.getProviderConfigurationProposal();
    const response = await inspectRoute.POST(post());
    expect(response.status).toBe(200);
    const value = providerReviewViewSchema.parse(await response.json());
    expect(value).toMatchObject({
      state: "proposal-only",
      viewVersion: 2,
      model: "gpt-5.4-2026-03-05",
      budget: null,
      preparation: null,
      transmissionManifest: null,
      accountAccess: "not-checked",
      actualExecutionEnabled: false,
      proposal: {
        adoption: "not-adopted",
        proposedBudget: { currency: "USD", capUnits: "15000000", status: "not-approved" },
      },
    });
    expect(value.financialBasis?.costs?.totalUnits).toBe("11220000");
    expect(store.providerBudgetGet().currency).toBe("TST");
    expect(store.providerBudgetGet("production").revision).toBe(0);
  });
  it("falls back to the unchanged missing view when the source proposal expires", async () => {
    const configuration = await vi.importActual<
      typeof import("./studio-plan-quality-provider-configuration")
    >("./studio-plan-quality-provider-configuration");
    state.proposal = configuration.getProviderConfigurationProposal();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    try {
      const expired = await (await inspectRoute.POST(post())).text();
      state.proposal = null;
      expect(await (await inspectRoute.POST(post())).text()).toBe(expired);
      expect(JSON.parse(expired).state).toBe("configuration-missing");
    } finally {
      vi.setSystemTime(new Date(actualTestNow));
    }
  });
  it("returns exact registered scope and null operating facts without reusing synthetic money", async () => {
    const response = await inspectRoute.POST(post());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const value = providerReviewViewSchema.parse(await response.json());
    const manifest = registry.manifest[0];
    expect(value.scope).toEqual({
      ...input(),
      setId: registry.setId,
      registrySourceDigest: registry.sourceDigest,
      manifestDigest: registry.manifestDigest,
      label: manifest.label,
      sourceDigest: manifest.sourceDigest,
      candidateDigest: manifest.candidateDigest,
      modelInputDigest: manifest.modelInputDigest,
    });
    expect(value).toMatchObject({
      state: "configuration-missing",
      environment: "production",
      model: null,
      financialBasis: null,
      budget: null,
      retention: null,
      preparation: null,
      transmissionManifest: null,
      actualExecutionEnabled: false,
      accountAccess: "not-checked",
    });
    expect(value.blockers.map(({ code }) => code)).toEqual(providerReviewBlockerCodes);
    expect(value.viewDigest).toBe(digest(providerReviewDigestInput(value)));
    expect(store.providerBudgetGet().heldUnits).toBe("4");
  });
  it.each(["model", "price", "budget", "approval", "environment", "transport", "body", "profile"])(
    "rejects client-controlled %s",
    async (field) => {
      expect((await inspectRoute.POST(post({ ...input(), [field]: "injected" }))).status).toBe(400);
      expect(state.opened).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["query", {}, "?environment=synthetic-test", 400],
    [
      "foreign host",
      { headers: { "content-type": "application/json", host: "example.invalid" } },
      "",
      403,
    ],
    [
      "cross-origin",
      { headers: { "content-type": "application/json", origin: "https://example.invalid" } },
      "",
      403,
    ],
    [
      "fetch-site",
      { headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" } },
      "",
      403,
    ],
    ["content-type", { headers: { "content-type": "text/plain" } }, "", 415],
    [
      "declared size",
      { headers: { "content-type": "application/json", "content-length": "4097" } },
      "",
      413,
    ],
    ["stream size", { body: " ".repeat(4097) }, "", 413],
    ["JSON", { body: "{" }, "", 400],
    ["UTF8", { body: new Uint8Array([255]) }, "", 400],
  ] as const)("rejects %s before storage", async (_name, init, suffix, status) => {
    expect((await inspectRoute.POST(post(input(), init, suffix))).status).toBe(status);
    expect(state.opened).not.toHaveBeenCalled();
  });
  it("rejects wrong methods and exposes no public reservation or execution endpoint", async () => {
    const response = await qualityProviderReviewRoute(
      new Request(base + "/provider-review/inspect"),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(state.opened).not.toHaveBeenCalled();
    expect(inspectRoute).not.toHaveProperty("GET");
    expect(overviewRoute).not.toHaveProperty("POST");
  });
  it("rejects changed or missing scope", async () => {
    expect(
      (await inspectRoute.POST(post({ ...input(), versionDigest: "0".repeat(64) }))).status,
    ).toBe(409);
    expect(
      (await inspectRoute.POST(post({ ...input(), candidateId: "validation-candidate-missing" })))
        .status,
    ).toBe(404);
    expect((await inspectRoute.POST(post({ ...input(), version: 2 }))).status).toBe(404);
  });
  it("keeps legacy A exact bytes and rejects any synthetic financial promotion", async () => {
    const make = () =>
      new Request(base + "/actual-preparation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input(), model: null }),
      });
    const old = await (await legacyInspect(make())).text();
    await inspectRoute.POST(post());
    expect(await (await legacyInspect(make())).text()).toBe(old);
    expect(JSON.parse(old)).toMatchObject({
      environment: "production",
      readiness: "blocked",
      evidence: { price: null, tokens: null, budget: null },
      costs: null,
    });
  });
  it("sanitizes unexpected storage errors", async () => {
    vi.spyOn(store, "candidateRegistryGet").mockImplementationOnce(() => {
      throw new Error("secret raw upstream input");
    });
    const response = await inspectRoute.POST(post());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret raw");
  });
  it("does not allow unsupported ready branches or a reworded blocker contract", async () => {
    const value = await (await inspectRoute.POST(post())).json();
    expect(providerReviewViewSchema.safeParse({ ...value, state: "reviewable" }).success).toBe(
      false,
    );
    expect(
      providerReviewViewSchema.safeParse({ ...value, budget: { capUnits: "0" } }).success,
    ).toBe(false);
    value.blockers[0].message = "모델 확인 완료";
    expect(providerReviewViewSchema.safeParse(value).success).toBe(false);
  });
});

describe("read-only v2 ledger", () => {
  it("separates synthetic budget from missing operating budget and returns raw states", async () => {
    const response = await overviewRoute.GET(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.budgets.production).toBeNull();
    expect(body.budgets.synthetic).toEqual(store.providerBudgetGet());
    expect(body.actualExecutionEnabled).toBe(false);
    expect(body.executions).toEqual(store.providerList().executions);
    expect(body.executions.map((v: { state: string }) => v.state)).toEqual([
      "reserved",
      "cancelled-before-dispatch",
      "completed",
    ]);
    expect(await (await get(request(), context({ runId: completedId }))).json()).toEqual(
      store.providerGet(completedId),
    );
    expect(
      await (await revision(request(), context({ runId: completedId, revision: "0" }))).json(),
    ).toEqual(store.providerGet(completedId, 0));
  });
  it("returns exact committed nonce receipts and does not grant transport ownership", async () => {
    const result = await (
      await lookup(request(), context({ clientRequestId: reservedInput.clientRequestId }))
    ).json();
    expect(result).toEqual(store.providerLookup(reservedInput.clientRequestId));
    expect(result).not.toHaveProperty("newlyCommitted");
    expect(
      await (await lookup(request(), context({ clientRequestId: randomUUID() }))).json(),
    ).toEqual({ state: "not-observed" });
  });
  it("downloads unchanged format2/format3 raw archives and original artifact bytes", async () => {
    for (const [id, rev] of [
      [completedId, 0],
      [completedId, completedRevision],
      [cancelledId, 1],
    ] as const) {
      const expected = store.providerDownload(id, rev).body;
      const response = await download(request(), context({ runId: id, revision: String(rev) }));
      expect(await response.text()).toBe(expected);
      expect(response.headers.get("x-content-sha256")).toBe(hash(expected));
      expect(response.headers.get("content-disposition")).toContain(`r${rev}`);
    }
    const expected = store.providerArtifact(completedId, "review-request");
    const response = await artifact(
      request(),
      context({
        runId: completedId,
        revision: String(completedRevision),
        artifactKey: "review-request",
      }),
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(expected.body);
    expect(response.headers.get("x-content-sha256")).toBe(expected.sha256);
  });
  it("never exposes later artifacts through an earlier prefix", async () => {
    const opened = vi.spyOn(store, "providerArtifact");
    const response = await artifact(
      request(),
      context({ runId: completedId, revision: "0", artifactKey: "review-request" }),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("PROVIDER_LEDGER_ARTIFACT_NOT_IN_REVISION");
    expect(opened).not.toHaveBeenCalled();
  });
  it.each(["key", "runId", "sha256", "sizeBytes", "body"])(
    "rechecks %s before returning artifact",
    async (field) => {
      const original = store.providerArtifact(completedId, "generation-request");
      const altered = {
        ...original,
        [field]:
          field === "body"
            ? Buffer.from("tampered")
            : field === "sizeBytes"
              ? original.sizeBytes + 1
              : "changed",
      };
      vi.spyOn(store, "providerArtifact").mockReturnValueOnce(altered as typeof original);
      expect(
        (
          await artifact(
            request(),
            context({ runId: completedId, revision: "0", artifactKey: "generation-request" }),
          )
        ).status,
      ).toBe(409);
    },
  );
  it.each([
    ["cross host", { headers: { host: "example.invalid" } }, "", 403],
    ["cross origin", { headers: { origin: "https://example.invalid" } }, "", 403],
    ["query", {}, "?environment=production", 400],
    ["write", { method: "POST" }, "", 405],
  ] as const)("rejects %s before storage", async (_name, init, suffix, status) => {
    expect((await qualityProviderLedgerRoute(request(suffix, init), "overview")).status).toBe(
      status,
    );
    expect(state.opened).not.toHaveBeenCalled();
  });
  it.each(["-1", "01", "33", "1.5", ""])("rejects revision %s", async (value) => {
    expect(
      (await revision(request(), context({ runId: reservedId, revision: value }))).status,
    ).toBe(400);
    expect(state.opened).not.toHaveBeenCalled();
  });
  it("rejects malformed paths and does not expose arbitrary files", async () => {
    expect((await get(request(), context({ runId: "not-uuid" }))).status).toBe(400);
    expect((await lookup(request(), context({ clientRequestId: "../secret" }))).status).toBe(400);
    expect(
      (
        await artifact(
          request(),
          context({ runId: reservedId, revision: "0", artifactKey: "../../studio.sqlite" }),
        )
      ).status,
    ).toBe(400);
    expect(state.opened).not.toHaveBeenCalled();
    expect((await get(request(), context({ runId: randomUUID() }))).status).toBe(404);
  });
  it("sanitizes raw database errors and leaves production writes closed", async () => {
    vi.spyOn(store, "providerGet").mockImplementationOnce(() => {
      throw new Error("private artifact body secret");
    });
    const response = await get(request(), context({ runId: reservedId }));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private artifact");
    expect(() => store.providerStart(reservedInput)).toThrow(
      expect.objectContaining({ code: "PROVIDER_EXECUTION_DISABLED" }),
    );
  });
  it("preserves bytes after later wall-clock changes", async () => {
    const expected = store.providerDownload(completedId, completedRevision).body;
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    try {
      expect(
        await (
          await download(
            request(),
            context({ runId: completedId, revision: String(completedRevision) }),
          )
        ).text(),
      ).toBe(expected);
    } finally {
      vi.setSystemTime(new Date(actualTestNow));
    }
  });
});
