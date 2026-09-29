/** Synthetic local HTTP protocol tests; no real consent, customer data or provider calls. */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { StudioError } from "./studio-http";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import { seedPolicyTestBudget } from "./studio-plan-quality-provider-policy-adoption-test-helpers";
import {
  providerTestConfigure,
  providerTestStartInput,
} from "./studio-plan-quality-provider-test-helpers";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { providerReviewDigestInput } from "./studio-plan-quality-provider-review-types";
import { providerPolicyReviewDigestInput } from "./studio-plan-quality-provider-policy-review-types";
import {
  providerPolicyAdoptionInputSchema,
  providerPolicyAdoptionResponseSchema,
  providerPolicyInspectionSchema,
  providerPolicyHttpLimits,
  type ProviderPolicyInspection,
} from "./studio-plan-quality-provider-policy-http-types";
import { qualityProviderPolicyRoute } from "./studio-plan-quality-provider-policy-service";
import * as configuration from "./studio-plan-quality-provider-configuration";
import * as inspectRoute from "@/app/api/studio/quality/provider-policy/inspect/route";
import * as adoptRoute from "@/app/api/studio/quality/provider-policy/adoptions/route";
import * as lookupRoute from "@/app/api/studio/quality/provider-policy/requests/[clientRequestId]/route";
import { POST as legacyInspect } from "@/app/api/studio/quality/provider-review/inspect/route";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  store: null as PlanQualityStore | null,
  opened: vi.fn(),
  forbidden: vi.fn(() => {
    throw new Error("External access forbidden");
  }),
}));
vi.mock("./studio-plan-quality-store", async (original) => ({
  ...(await original<typeof import("./studio-plan-quality-store")>()),
  getPlanQualityStore: () => {
    state.opened();
    return state.store!;
  },
}));
vi.mock("openai", () => ({
  default: class {
    constructor() {
      state.forbidden();
    }
  },
}));
vi.mock("./studio-storage", () => ({
  getStudioStore: state.forbidden,
  StudioStore: state.forbidden,
}));

let directory: string, store: PlanQualityStore, db: DatabaseSync;
const base = "http://127.0.0.1:3000/api/studio/quality/provider-policy";
const sentinel = "SYNTHETIC COMPANY BYTES";
const post = (path: string, input: unknown, init: RequestInit = {}) =>
  new Request(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" },
    body: JSON.stringify(input),
    ...init,
  });
const lookup = (
  clientRequestId: string,
  request = new Request(base + "/requests/" + clientRequestId),
) => lookupRoute.GET(request, { params: Promise.resolve({ clientRequestId }) });
const result = async (response: Response) => {
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  return providerPolicyAdoptionResponseSchema.parse(await response.json());
};
function rows() {
  return digest(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'quality_%' ORDER BY name",
      )
      .all()
      .map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]),
  );
}
function selection(index = 0) {
  const registry = store.candidateRegistryGet(1);
  return {
    version: 1,
    versionDigest: registry.versionDigest,
    candidateId: registry.entries[index].candidateId,
  };
}
async function inspection(index = 0) {
  const response = await inspectRoute.POST(post("/inspect", selection(index)));
  expect(response.status).toBe(200);
  return providerPolicyInspectionSchema.parse(await response.json());
}
function approval(view: ProviderPolicyInspection) {
  return providerPolicyAdoptionInputSchema.parse({
    command: {
      commandVersion: 1,
      kind: "adopt-provider-policy",
      clientRequestId: randomUUID(),
      version: view.scope.version,
      versionDigest: view.scope.versionDigest,
      candidateId: view.scope.candidateId,
      expectedPolicyHead: view.policyHead,
      approvedReviewDigest: view.policyReview.reviewDigest,
      budgetAction: view.policyReview.budget.revision
        ? "keep-existing-budget"
        : "initialize-proposed-budget",
      initialBudgetRequestId: view.policyReview.budget.revision ? null : randomUUID(),
      approval: {
        noticeVersion: 1,
        acknowledgedPolicy: true,
        acknowledgedBudgetAction: true,
        reservationAndTransmission: "separate-approval-required",
        approvedAt: new Date().toISOString(),
      },
    },
    approvedReview: view.policyReview,
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", state.forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-policy-http-"));
  writeFileSync(join(directory, "studio.sqlite"), sentinel);
  store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
  store.candidateRegistryRegister({
    expectedVersion: 0,
    clientRequestId: randomUUID(),
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  });
  state.store = store;
  db = new DatabaseSync(join(directory, "quality-evaluation", "quality.sqlite"));
  db.function("quality_storage_contract", () => "quality-v9");
}, 15000);
afterEach(() => {
  expect(state.forbidden).not.toHaveBeenCalled();
  expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe(sentinel);
  db.close();
  store.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  const rel = relative(resolve(tmpdir()), resolve(directory));
  if (!rel.startsWith("venture-policy-http-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});

it("exports only the intended dynamic Node handlers", () => {
  for (const route of [inspectRoute, adoptRoute, lookupRoute]) {
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
  }
  expect(Object.keys(adoptRoute).sort()).toEqual(["POST", "dynamic", "runtime"]);
  expect(Object.keys(lookupRoute).sort()).toEqual(["GET", "dynamic", "runtime"]);
});
it("returns v5 from one audited read transaction and leaves the old v4 endpoint unchanged", async () => {
  const before = rows();
  const oldContext = vi.spyOn(store, "providerReviewContext");
  const separateHead = vi.spyOn(store, "providerPolicyHead");
  const input = selection();
  const exec = vi.spyOn(DatabaseSync.prototype, "exec");
  const view = providerPolicyInspectionSchema.parse(
    await (await inspectRoute.POST(post("/inspect", input))).json(),
  );
  expect(exec.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "COMMIT"]);
  expect(oldContext).not.toHaveBeenCalled();
  expect(separateHead).not.toHaveBeenCalled();
  expect(view.policyHead).toEqual({ revision: 0, headDigest: null });
  expect(view.policyReview.budget.revision).toBe(0);
  expect(view.viewDigest).toBe(digest(providerReviewDigestInput(view)));
  expect(Object.values(view.policyReview.actions)).toEqual([false, false, false, false]);
  const legacy = await (await legacyInspect(post("/inspect", selection()))).json();
  expect(legacy.viewVersion).toBe(4);
  expect(legacy).not.toHaveProperty("policyHead");
  expect(rows()).toBe(before);
});
it.each(["missing", "expired"])(
  "preserves the %s configuration response without writes",
  async (kind) => {
    const before = rows();
    if (kind === "missing")
      vi.spyOn(configuration, "getProviderConfigurationProposal").mockReturnValue(null);
    else vi.setSystemTime("2030-01-01T00:00:00.000Z");
    const response = await inspectRoute.POST(post("/inspect", selection()));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ viewVersion: kind === "missing" ? 1 : 3 });
    expect(rows()).toBe(before);
  },
);
it("adopts an inspected policy, initializes exactly one budget and returns a bound receipt", async () => {
  const input = approval(await inspection());
  const response = await adoptRoute.POST(post("/adoptions", input));
  expect(response.status).toBe(200);
  const value = await result(response);
  expect(value).toMatchObject({
    state: "committed",
    delivery: "new",
    receipt: {
      clientRequestId: input.command.clientRequestId,
      requestDigest: digest(input.command),
      revision: 1,
      approvedReviewDigest: input.command.approvedReviewDigest,
      budgetTransition: {
        kind: "initialize-proposed-budget",
        before: { revision: 0 },
        after: { revision: 1 },
      },
      reservationAllowed: false,
      dispatchAllowed: false,
    },
  });
  const lookedUp = await result(await lookup(input.command.clientRequestId));
  expect(lookedUp).toEqual({ ...value, delivery: "lookup" });
  const view = await inspection();
  expect(view.policyHead).toEqual(store.providerPolicyHead());
  expect(view.policyReview.budget).toMatchObject({
    revision: 1,
    capUnits: "15000000",
    heldUnits: "0",
    recognizedUnits: "0",
  });
  expect(db.prepare("SELECT COUNT(*) AS n FROM quality_actual_runs").get()!.n).toBe(0);
  expect(() =>
    store.providerBudgetConfigure({
      clientRequestId: randomUUID(),
      expectedRevision: 1,
      policy: {
        environment: "production",
        provenance: "explicit-user",
        currency: "USD",
        unitScale: 6,
        capUnits: "999999999",
      },
    }),
  ).toThrowError(expect.objectContaining({ code: "PROVIDER_EXECUTION_DISABLED" }));
});
it("keeps existing production budget and independent synthetic reservations unchanged", async () => {
  seedPolicyTestBudget(db);
  providerTestConfigure(store);
  store.providerStart(providerTestStartInput(store));
  const budgetRows = db.prepare("SELECT * FROM quality_actual_budget_events ORDER BY rowid").all();
  const held = store.providerBudgetGet();
  const input = approval(await inspection());
  expect(input.approvedReview?.assessment.state).toBe("budget-insufficient");
  const value = await result(await adoptRoute.POST(post("/adoptions", input)));
  expect(value).toMatchObject({
    state: "committed",
    receipt: { budgetTransition: { kind: "keep-existing-budget" } },
  });
  expect(db.prepare("SELECT * FROM quality_actual_budget_events ORDER BY rowid").all()).toEqual(
    budgetRows,
  );
  expect(store.providerBudgetGet()).toEqual(held);
});
it("replays the original receipt after restart, later policy, expiry and configuration failure", async () => {
  const input = approval(await inspection());
  const first = await result(await adoptRoute.POST(post("/adoptions", input)));
  await adoptRoute.POST(post("/adoptions", approval(await inspection(1))));
  const before = rows();
  store.close();
  store = new PlanQualityStore(directory);
  state.store = store;
  vi.setSystemTime("2030-01-01T00:00:00.000Z");
  const config = vi
    .spyOn(configuration, "getProviderConfigurationProposal")
    .mockImplementation(() => {
      throw new Error("configuration unavailable");
    });
  expect(await result(await lookup(input.command.clientRequestId))).toEqual({
    ...first,
    delivery: "lookup",
  });
  expect(
    await result(await adoptRoute.POST(post("/adoptions", { ...input, approvedReview: null }))),
  ).toEqual({ ...first, delivery: "replay" });
  expect(config).not.toHaveBeenCalled();
  expect(rows()).toBe(before);
});
it.each(["policy", "budget", "expiry", "forged-review", "no-review", "nonce"])(
  "refuses a changed %s without any further writes",
  async (kind) => {
    const input = approval(await inspection());
    if (kind === "policy") await adoptRoute.POST(post("/adoptions", approval(await inspection(1))));
    if (kind === "budget") seedPolicyTestBudget(db);
    if (kind === "expiry") vi.setSystemTime(Date.parse(actualTestNow) + 16 * 60 * 1000);
    if (kind === "forged-review" && input.approvedReview) {
      input.approvedReview.bindings.model = "client-forged-model";
      input.approvedReview.reviewDigest = digest(
        providerPolicyReviewDigestInput(input.approvedReview),
      );
      input.command.approvedReviewDigest = input.approvedReview.reviewDigest;
    }
    if (kind === "no-review") input.approvedReview = null;
    if (kind === "nonce") {
      await adoptRoute.POST(post("/adoptions", input));
      input.command.approval.approvedAt = "2026-01-01T00:00:00.000Z";
    }
    const before = rows();
    const response = await adoptRoute.POST(post("/adoptions", input));
    expect(response.status).toBe(409);
    expect(await result(response)).toMatchObject({
      state: "refused",
      clientRequestId: input.command.clientRequestId,
    });
    expect(rows()).toBe(before);
  },
);
it.each(["before", "after"])(
  "recovers a %s-commit failure with the original nonce",
  async (timing) => {
    const input = approval(await inspection());
    const adopt = store.providerPolicyAdopt.bind(store);
    const injected = vi
      .spyOn(store, "providerPolicyAdopt")
      .mockImplementationOnce((command, review) => {
        if (timing === "after") adopt(command, review);
        throw new Error("PRIVATE upstream credential/path must not be echoed");
      });
    const response = await adoptRoute.POST(post("/adoptions", input));
    expect(response.status).toBe(500);
    expect(await result(response)).toMatchObject({
      state: "unknown",
      clientRequestId: input.command.clientRequestId,
      recovery: "lookup-or-replay-original-request",
    });
    injected.mockRestore();
    const status = await result(await lookup(input.command.clientRequestId));
    expect(status.state).toBe(timing === "after" ? "committed" : "not-observed");
    if (status.state === "not-observed") expect(status.recovery).toBe("replay-original-request");
    const retried = await result(await adoptRoute.POST(post("/adoptions", input)));
    expect(retried).toMatchObject({
      state: "committed",
      delivery: timing === "after" ? "replay" : "new",
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM quality_provider_policies").get()!.n).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM quality_actual_budget_events").get()!.n).toBe(1);
  },
);
it("does not label serialization failure after commit as a refusal", async () => {
  const input = approval(await inspection());
  vi.spyOn(Response, "json").mockImplementationOnce(() => {
    throw new StudioError("hidden", 409, "QUALITY_PROVIDER_POLICY_NONCE_CONFLICT");
  });
  expect(await result(await adoptRoute.POST(post("/adoptions", input)))).toMatchObject({
    state: "unknown",
  });
  expect(await result(await lookup(input.command.clientRequestId))).toMatchObject({
    state: "committed",
  });
});
it("blocks reads, lookup and replay when unrelated archived evaluation evidence is corrupt", async () => {
  const input = approval(await inspection());
  await adoptRoute.POST(post("/adoptions", input));
  store.create({
    clientRequestId: randomUUID(),
    title: "synthetic unrelated evidence",
    manifestDigest: store.list().manifestDigest,
  });
  const trigger = db
    .prepare("SELECT sql FROM sqlite_schema WHERE name='quality_runs_no_update'")
    .get()!.sql as string;
  db.exec("DROP TRIGGER quality_runs_no_update");
  db.prepare("UPDATE quality_runs SET body_hash=?").run("a".repeat(64));
  db.exec(trigger);
  const before = rows();
  expect(
    (await inspectRoute.POST(post("/inspect", { ...input.command, ...selection() }))).status,
  ).toBe(400);
  const response = await inspectRoute.POST(post("/inspect", selection()));
  expect(response.status).toBe(409);
  expect(await response.json()).not.toHaveProperty("policyReview");
  for (const response of [
    await lookup(input.command.clientRequestId),
    await adoptRoute.POST(post("/adoptions", input)),
  ]) {
    expect(response.status).toBe(500);
    expect(await result(response)).toMatchObject({ state: "unknown" });
  }
  expect(rows()).toBe(before);
});

it.each([
  ["cross-origin", 403],
  ["foreign-host", 403],
  ["forwarded-host", 403],
  ["fetch-site", 403],
  ["query", 400],
  ["content-type", 415],
  ["length", 413],
  ["actual-size", 413],
  ["json", 400],
  ["utf8", 400],
  ["unknown-field", 400],
  ["command-field", 400],
  ["missing-ack", 400],
  ["bad-nonce", 400],
] as const)("rejects %s before opening the store", async (kind, status) => {
  const input = approval(await inspection());
  let path = "/adoptions";
  const headers: Record<string, string> = { "content-type": "application/json" };
  let body: BodyInit = JSON.stringify(input);
  if (kind === "cross-origin") headers.origin = "https://foreign.example";
  if (kind === "foreign-host") headers.host = "foreign.example";
  if (kind === "forwarded-host") headers["x-forwarded-host"] = "foreign.example";
  if (kind === "fetch-site") headers["sec-fetch-site"] = "cross-site";
  if (kind === "query") path += "?budget=1";
  if (kind === "content-type") headers["content-type"] = "text/plain";
  if (kind === "length") headers["content-length"] = String(providerPolicyHttpLimits.bodyBytes + 1);
  if (kind === "actual-size") body = " ".repeat(providerPolicyHttpLimits.bodyBytes + 1);
  if (kind === "json") body = "{";
  if (kind === "utf8") body = new Uint8Array([0xff]);
  if (kind === "unknown-field") body = JSON.stringify({ ...input, configuration: {} });
  if (kind === "command-field")
    body = JSON.stringify({ ...input, command: { ...input.command, budgetEvents: [] } });
  if (kind === "missing-ack")
    body = JSON.stringify({
      ...input,
      command: {
        ...input.command,
        approval: { ...input.command.approval, acknowledgedPolicy: false },
      },
    });
  if (kind === "bad-nonce")
    body = JSON.stringify({
      ...input,
      command: { ...input.command, clientRequestId: "not-a-uuid" },
    });
  const before = rows();
  state.opened.mockClear();
  const response = await adoptRoute.POST(
    new Request(base + path, { method: "POST", headers, body }),
  );
  expect(response.status).toBe(status);
  expect(await result(response)).toMatchObject({ state: "refused" });
  expect(state.opened).not.toHaveBeenCalled();
  expect(rows()).toBe(before);
});
it("guards methods and lookup parameters before opening the store", async () => {
  state.opened.mockClear();
  for (const operation of ["adopt", "lookup"] as const) {
    const response = await qualityProviderPolicyRoute(
      new Request(base, { method: "PUT" }),
      operation,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe(operation === "adopt" ? "POST" : "GET");
  }
  expect((await lookup("invalid")).status).toBe(400);
  expect((await lookup(randomUUID(), new Request(base + "?extra=1"))).status).toBe(400);
  expect(
    (
      await lookup(
        randomUUID(),
        new Request(base, { headers: { origin: "https://foreign.example" } }),
      )
    ).status,
  ).toBe(403);
  expect(state.opened).not.toHaveBeenCalled();
});
