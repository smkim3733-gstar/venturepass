/** Temporary synthetic DBs/consent fixtures only. No customer data or provider access. */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import {
  adoptReservationTestPolicy,
  reservationStoreFixture,
} from "./studio-plan-quality-provider-reservation-store-test-helpers";
import {
  providerTestConfigure,
  providerTestStartInput,
} from "./studio-plan-quality-provider-test-helpers";
import * as configuration from "./studio-plan-quality-provider-configuration";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { providerTransmissionReviewDigestInput } from "./studio-plan-quality-provider-transmission-review-types";
import {
  providerTransmissionHttpLimits,
  providerTransmissionInspectionResponseSchema,
} from "./studio-plan-quality-provider-transmission-http-types";
import { qualityProviderTransmissionReviewRoute } from "./studio-plan-quality-provider-transmission-service";
import * as route from "@/app/api/studio/quality/provider-transmission/inspect/route";
import { POST as reservationInspect } from "@/app/api/studio/quality/provider-reservation/inspect/route";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  store: null as PlanQualityStore | null,
  opened: vi.fn(),
  forbidden: vi.fn(() => {
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
const base = "http://127.0.0.1:3000/api/studio/quality/provider-transmission/inspect";
const sentinel = "SYNTHETIC COMPANY DATABASE MUST STAY CLOSED";
const privateFailure = "SYNTHETIC PRIVATE CONFIGURATION DO NOT EXPOSE";
type Selection = { runId: string; runDigest: string };
const absent = (): Selection => ({ runId: randomUUID(), runDigest: "a".repeat(64) });
function post(input: unknown, init: RequestInit = {}) {
  return new Request(base, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" },
    body: JSON.stringify(input),
    ...init,
  });
}
function reserve(): Selection {
  adoptReservationTestPolicy(store);
  const input = reservationStoreFixture(store),
    result = store.providerReserve(input.command, input.review);
  return { runId: result.record.runId, runDigest: result.record.runDigest };
}
function rows() {
  return digest({
    schema: db.prepare("SELECT name,type,sql FROM sqlite_schema ORDER BY name").all(),
    tables: db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'quality_%' ORDER BY name",
      )
      .all()
      .map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]),
  });
}
async function inspect(request: Request) {
  const before = rows();
  try {
    const response = await route.POST(request);
    expect(response.headers.get("cache-control")).toBe("no-store, private, max-age=0");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    return response;
  } finally {
    expect(rows()).toBe(before);
  }
}
async function review(selected: Selection, request = post(selected)) {
  const response = await inspect(request);
  expect(response.status).toBe(200);
  const value = providerTransmissionInspectionResponseSchema.parse(await response.json());
  if (value.status !== "review") throw new Error(value.reason);
  expect(value.selection).toEqual(selected);
  expect(value.review.reviewDigest).toBe(
    digest(providerTransmissionReviewDigestInput(value.review)),
  );
  expect(value.review.actions).toEqual({
    approvalWriteAllowed: false,
    dispatchAllowed: false,
    budgetWriteAllowed: false,
  });
  return value;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", state.forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-transmission-http-"));
  writeFileSync(join(directory, "studio.sqlite"), sentinel);
  store = new PlanQualityStore(directory);
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
  if (!rel.startsWith("venture-transmission-http-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});

it("exports only a dynamic Node inspection POST", () => {
  expect(route.runtime).toBe("nodejs");
  expect(route.dynamic).toBe("force-dynamic");
  expect(Object.keys(route).sort()).toEqual(["POST", "dynamic", "runtime"]);
});
it("returns the exact audited reservation review from one transaction without invoking writes", async () => {
  const selected = reserve();
  const read = vi.spyOn(store, "providerTransmissionReview");
  const writes = [
    vi.spyOn(store, "providerReserve"),
    vi.spyOn(store, "providerPolicyAdopt"),
    vi.spyOn(store, "providerRecordApprove"),
    vi.spyOn(store, "providerRecordDispatch"),
    vi.spyOn(store, "providerBudgetConfigure"),
  ];
  const extraReads = [
    vi.spyOn(store, "providerGet"),
    vi.spyOn(store, "providerReviewContext"),
    vi.spyOn(store, "providerReservationReview"),
  ];
  const exec = vi.spyOn(DatabaseSync.prototype, "exec");
  const value = await review(selected);
  expect(exec.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "COMMIT"]);
  expect(read).toHaveBeenCalledExactlyOnceWith(selected);
  for (const spy of [...writes, ...extraReads]) expect(spy).not.toHaveBeenCalled();
  expect(value.review.assessment).toEqual({ state: "conditions-met", blockers: [] });
  expect(value.review.run).toMatchObject({
    id: selected.runId,
    runDigest: selected.runDigest,
    state: "reserved",
  });
});
it("preserves repeated/restarted results and returns a later policy conflict as a blocked review", async () => {
  const selected = reserve(),
    first = await review(selected);
  expect(await review(selected)).toEqual(first);
  store.close();
  store = new PlanQualityStore(directory);
  state.store = store;
  expect(await review(selected)).toEqual(first);
  adoptReservationTestPolicy(store);
  expect((await review(selected)).review.assessment).toEqual({
    state: "blocked",
    blockers: ["policy-superseded"],
  });
});
it("keeps the reservation inspection API and its selection contract intact", async () => {
  const selected = reserve();
  const registry = store.candidateRegistryGet(1);
  const selection = {
    version: 1,
    versionDigest: registry.versionDigest,
    candidateId: registry.entries[0].candidateId,
  };
  const before = rows();
  const result = await reservationInspect(post(selection));
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    responseVersion: 1,
    status: "review",
    selection,
    review: { assessment: { blockers: expect.arrayContaining(["candidate-unsettled"]) } },
  });
  expect(rows()).toBe(before);
  await review(selected);
});
it("distinguishes an absent run from a stale run digest without returning a review", async () => {
  const selected = reserve();
  const missing = await inspect(post(absent()));
  expect(missing.status).toBe(404);
  expect(await missing.json()).toMatchObject({ code: "QUALITY_PROVIDER_RUN_NOT_FOUND" });
  const mismatch = await inspect(post({ ...selected, runDigest: "a".repeat(64) }));
  expect(mismatch.status).toBe(409);
  expect(await mismatch.json()).toMatchObject({
    status: "unavailable",
    reason: "selection-invalid",
    review: null,
  });
});
it("returns missing configuration as unavailable and future/expired reservations as conflicts", async () => {
  const selected = reserve();
  const getter = vi.spyOn(configuration, "getProviderConfigurationProposal").mockReturnValue(null);
  const missing = await inspect(post(selected));
  expect(missing.status).toBe(200);
  expect(await missing.json()).toMatchObject({
    status: "unavailable",
    reason: "configuration-missing-or-invalid",
    review: null,
  });
  getter.mockRestore();
  vi.setSystemTime(Date.parse(actualTestNow) - 1);
  const future = await inspect(post(selected));
  expect(future.status).toBe(409);
  expect(await future.json()).toMatchObject({
    status: "unavailable",
    reason: "archive-after-inspection",
    review: null,
  });
  vi.setSystemTime("2030-01-01T00:00:00.000Z");
  const expired = await inspect(post(selected));
  expect(expired.status).toBe(409);
  expect(await expired.json()).toMatchObject({
    status: "unavailable",
    reason: "reservation-expired",
    review: null,
  });
});
it("rejects a synthetic run without enabling production transmission", async () => {
  store.close();
  store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
  state.store = store;
  providerTestConfigure(store);
  const { run } = store.providerStart(providerTestStartInput(store)).snapshot;
  const response = await inspect(post({ runId: run.id, runDigest: run.runDigest }));
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    status: "unavailable",
    reason: "production-reservation-required",
    review: null,
  });
});
it("rejects a missing reservation binding instead of disclosing a partial review", async () => {
  const selected = reserve();
  const trigger = "quality_provider_reservation_bindings_no_delete";
  const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(trigger)!.sql as string;
  db.exec(`DROP TRIGGER ${trigger}`);
  try {
    db.exec("DELETE FROM quality_provider_reservation_bindings");
  } finally {
    db.exec(sql);
  }
  const response = await inspect(post(selected));
  expect(response.status).toBe(409);
  expect(await response.json()).not.toHaveProperty("review");
});
it.each([
  ["configuration-missing-or-invalid", 200],
  ["configuration-expired", 200],
  ["configuration-changed", 409],
  ["selection-invalid", 409],
  ["archive-after-inspection", 409],
  ["production-reservation-required", 409],
  ["reservation-binding-required", 409],
  ["reservation-expired", 409],
  ["preparation-changed", 409],
] as const)("exposes %s with its explicit HTTP status", async (reason, status) => {
  const selection = absent();
  vi.spyOn(store, "providerTransmissionReview").mockReturnValueOnce({
    status: "unavailable",
    reason,
    review: null,
  });
  const response = await inspect(post(selection));
  expect(response.status).toBe(status);
  expect(providerTransmissionInspectionResponseSchema.parse(await response.json())).toEqual({
    responseVersion: 1,
    selection,
    status: "unavailable",
    reason,
    review: null,
  });
});
it.each([
  ["cross-origin", 403],
  ["foreign-host", 403],
  ["forwarded-host", 403],
  ["fetch-site", 403],
  ["nonlocal-url", 403],
  ["wrong-port", 403],
  ["query", 400],
  ["content-type", 415],
  ["length", 413],
  ["invalid-length", 413],
  ["actual-size", 413],
  ["json", 400],
  ["utf8", 400],
  ["empty", 400],
  ["configuration", 400],
  ["archive", 400],
  ["ledger", 400],
  ["inspectedAt", 400],
  ["command", 400],
  ["approval", 400],
  ["run-id", 400],
  ["run-digest", 400],
] as const)("rejects %s before opening storage", async (kind, status) => {
  const selected = absent();
  let url = base;
  const headers: Record<string, string> = { "content-type": "application/json" };
  let body: BodyInit = JSON.stringify(selected);
  if (kind === "cross-origin") headers.origin = "https://foreign.example";
  if (kind === "foreign-host") headers.host = "foreign.example";
  if (kind === "forwarded-host") headers["x-forwarded-host"] = "foreign.example";
  if (kind === "fetch-site") headers["sec-fetch-site"] = "cross-site";
  if (kind === "nonlocal-url") url = base.replace("127.0.0.1", "foreign.example");
  if (kind === "wrong-port") headers.host = "127.0.0.1:3001";
  if (kind === "query") url += "?runId=extra";
  if (kind === "content-type") headers["content-type"] = "text/plain";
  if (kind === "length")
    headers["content-length"] = String(providerTransmissionHttpLimits.bodyBytes + 1);
  if (kind === "invalid-length") headers["content-length"] = "-1";
  if (kind === "actual-size") {
    headers["content-length"] = "1";
    body = " ".repeat(providerTransmissionHttpLimits.bodyBytes + 1);
  }
  if (kind === "json") body = "{";
  if (kind === "utf8") body = new Uint8Array([0xff]);
  if (kind === "empty") body = "";
  if (["configuration", "archive", "ledger", "inspectedAt", "command", "approval"].includes(kind))
    body = JSON.stringify({ ...selected, [kind]: {} });
  if (kind === "run-id") body = JSON.stringify({ ...selected, runId: "invalid" });
  if (kind === "run-digest") body = JSON.stringify({ ...selected, runDigest: "a" });
  state.opened.mockClear();
  const response = await inspect(new Request(url, { method: "POST", headers, body }));
  expect(response.status).toBe(status);
  expect(await response.json()).not.toHaveProperty("review");
  expect(state.opened).not.toHaveBeenCalled();
});
it("cancels a chunked oversize body before storage even when content-length is absent", async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(4096));
      controller.enqueue(new Uint8Array(1));
    },
    cancel,
  });
  const request = new Request(base, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stream,
    duplex: "half",
  } as RequestInit);
  const response = await inspect(request);
  expect(response.status).toBe(413);
  expect(cancel).toHaveBeenCalledOnce();
  expect(state.opened).not.toHaveBeenCalled();
});
it("supports normalized loopback Host and JSON charset", async () => {
  const selected = reserve();
  await review(
    selected,
    new Request(base.replace("127.0.0.1", "localhost"), {
      method: "POST",
      body: JSON.stringify(selected),
      headers: {
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json; charset=utf-8",
      },
    }),
  );
});
it("rejects unsupported methods without opening storage", async () => {
  const before = rows();
  for (const method of ["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
    const response = await qualityProviderTransmissionReviewRoute(new Request(base, { method }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(response.headers.get("cache-control")).toContain("no-store");
  }
  expect(state.opened).not.toHaveBeenCalled();
  expect(rows()).toBe(before);
});
it.each(["type", "syntax", "schema", "unknown"])(
  "conceals %s server failures as 500",
  async (kind) => {
    vi.spyOn(store, "providerTransmissionReview").mockImplementationOnce(() => {
      if (kind === "type") throw new TypeError(privateFailure);
      if (kind === "syntax") throw new SyntaxError(privateFailure);
      if (kind === "schema") z.never().parse(privateFailure);
      throw new Error(privateFailure);
    });
    const response = await inspect(post(absent()));
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain(privateFailure);
    expect(JSON.parse(body)).toEqual({
      code: "PROVIDER_TRANSMISSION_REVIEW_UNAVAILABLE",
      error: "전송 검토를 확인하지 못했습니다. 다시 조회해 주세요.",
    });
  },
);
it.each(["inspection-invalid", "archive-invalid"] as const)(
  "conceals internal %s results as 500",
  async (reason) => {
    vi.spyOn(store, "providerTransmissionReview").mockReturnValueOnce({
      status: "unavailable",
      reason,
      review: null,
    });
    const response = await inspect(post(absent()));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(reason);
  },
);
it.each([
  "selection",
  "permission",
  "outer-digest",
  "manifest",
  "execution-contract",
  "usage-policy",
  "financial-binding",
  "request-contract",
  "request-body",
  "request-sha",
  "template",
])("rejects inconsistent %s output even when its outer digest is recomputed", async (kind) => {
  const selected = reserve();
  const result = store.providerTransmissionReview(selected);
  if (result.status !== "review") throw new Error("fixture");
  const v = result.review,
    c = v.manifest.executionContract;
  if (kind === "selection") v.run.id = randomUUID();
  if (kind === "permission") Object.assign(v.actions, { dispatchAllowed: true });
  if (kind === "manifest") v.manifest.manifestDigest = "a".repeat(64);
  if (kind === "execution-contract") c.contractDigest = "a".repeat(64);
  if (kind === "usage-policy") c.usagePolicyDigest = "a".repeat(64);
  if (kind === "financial-binding") c.usagePolicy.financialBasisDigest = "a".repeat(64);
  if (kind === "request-contract") v.request.contract.baseContract.contractDigest = "a".repeat(64);
  if (kind === "request-body") v.request.generation.body.input[1].content += " altered";
  if (kind === "request-sha") v.request.generation.sha256 = "a".repeat(64);
  if (kind === "template") v.request.reviewTemplate.systemMessage.content += " altered";
  const without = (value: object, field: string) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
  if (kind === "financial-binding") c.usagePolicyDigest = digest(c.usagePolicy);
  if (["financial-binding", "usage-policy"].includes(kind))
    c.contractDigest = digest(without(c, "contractDigest"));
  if (["financial-binding", "usage-policy", "execution-contract"].includes(kind))
    v.manifest.manifestDigest = digest(without(v.manifest, "manifestDigest"));
  v.reviewDigest =
    kind === "outer-digest" ? "a".repeat(64) : digest(providerTransmissionReviewDigestInput(v));
  vi.spyOn(store, "providerTransmissionReview").mockReturnValueOnce(result);
  const response = await inspect(post(selected));
  expect(response.status).toBe(500);
  expect(await response.json()).not.toHaveProperty("review");
});
it("hides serialization failure and permits a subsequent independent inspection", async () => {
  const selected = reserve();
  vi.spyOn(Response, "json").mockImplementationOnce(() => {
    throw new TypeError(privateFailure);
  });
  const response = await inspect(post(selected));
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain(privateFailure);
  await review(selected);
});
