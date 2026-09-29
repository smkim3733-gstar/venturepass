/** Synthetic HTTP boundary tests with isolated SQLite; no actual consent or provider calls. */
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
  policyAdoptionFixture,
  seedPolicyTestBudget,
} from "./studio-plan-quality-provider-policy-adoption-test-helpers";
import {
  providerTestConfigure,
  providerTestStartInput,
} from "./studio-plan-quality-provider-test-helpers";
import * as configuration from "./studio-plan-quality-provider-configuration";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import {
  providerConfigurationDigestInput,
  providerReviewLimits,
} from "./studio-plan-quality-provider-review-types";
import { providerReservationReviewDigestInput } from "./studio-plan-quality-provider-reservation-review-types";
import { providerReservationInspectionResponseSchema } from "./studio-plan-quality-provider-reservation-http-types";
import { qualityProviderReservationReviewRoute } from "./studio-plan-quality-provider-reservation-service";
import * as route from "@/app/api/studio/quality/provider-reservation/inspect/route";
import { POST as policyInspect } from "@/app/api/studio/quality/provider-policy/inspect/route";
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
const base = "http://127.0.0.1:3000/api/studio/quality/provider-reservation/inspect";
const sentinel = "SYNTHETIC COMPANY DATA MUST STAY CLOSED";
const privateFailure = "SYNTHETIC PRIVATE CONFIGURATION DO NOT EXPOSE";
function selection(index = 0) {
  const registry = store.candidateRegistryGet(1);
  return {
    version: 1,
    versionDigest: registry.versionDigest,
    candidateId: registry.entries[index].candidateId,
  };
}
function post(input: unknown = selection(), init: RequestInit = {}) {
  return new Request(base, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" },
    body: JSON.stringify(input),
    ...init,
  });
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
async function inspect(request = post()) {
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
async function review(request = post()) {
  const response = await inspect(request);
  expect(response.status).toBe(200);
  const value = providerReservationInspectionResponseSchema.parse(await response.json());
  if (value.status !== "review") throw new Error(value.reason);
  expect(value.review.reviewDigest).toBe(
    digest(providerReservationReviewDigestInput(value.review)),
  );
  expect(value.review.actions).toEqual({
    reservationAllowed: false,
    dispatchAllowed: false,
    budgetWriteAllowed: false,
  });
  return value;
}
function adopt(index = 0) {
  const value = policyAdoptionFixture(store, index);
  return store.providerPolicyAdopt(value.command, value.review).record;
}
function corruptFixture(trigger: string, work: () => void) {
  const sql = db
    .prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?")
    .get(trigger)?.sql;
  if (typeof sql !== "string" || !/^quality_[a-z_]+_no_(update|delete)$/.test(trigger))
    throw new Error("Invalid fixture trigger");
  db.exec(`DROP TRIGGER ${trigger}`);
  try {
    work();
  } finally {
    db.exec(sql);
  }
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", state.forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-reservation-http-"));
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
  if (!rel.startsWith("venture-reservation-http-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});

it("exports only a dynamic Node inspection POST", () => {
  expect(route.runtime).toBe("nodejs");
  expect(route.dynamic).toBe("force-dynamic");
  expect(Object.keys(route).sort()).toEqual(["POST", "dynamic", "runtime"]);
});
it("returns an unadopted review from one audited transaction without opening write paths", async () => {
  const selected = selection(),
    request = post(selected);
  const separateHead = vi.spyOn(store, "providerPolicyHead");
  const oldContext = vi.spyOn(store, "providerReviewContext");
  const writes = [
    vi.spyOn(store, "providerPolicyAdopt"),
    vi.spyOn(store, "providerStart"),
    vi.spyOn(store, "providerBudgetConfigure"),
  ];
  const exec = vi.spyOn(DatabaseSync.prototype, "exec");
  const value = await review(request);
  expect(exec.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "COMMIT"]);
  expect(separateHead).not.toHaveBeenCalled();
  expect(oldContext).not.toHaveBeenCalled();
  for (const write of writes) expect(write).not.toHaveBeenCalled();
  expect(value.selection).toEqual(selected);
  expect(value.review.assessment).toEqual({
    state: "blocked",
    blockers: ["policy-not-adopted", "budget-not-configured"],
  });
  expect(value.review.policyHead).toEqual({ revision: 0, headDigest: null });
});
it("returns current adopted policy and budget after reopening with default write restrictions", async () => {
  const first = adopt();
  adopt(1);
  const selected = selection();
  store.close();
  store = new PlanQualityStore(directory);
  state.store = store;
  vi.setSystemTime("2026-09-27T03:30:00.000Z");
  const value = await review(post(selected));
  expect(value.review.policy).toMatchObject({
    state: "matched",
    reference: { revision: 1, recordDigest: first.recordDigest },
  });
  expect(value.review.policyHead.revision).toBe(2);
  expect(value.review.assessment).toEqual({ state: "conditions-met", blockers: [] });
  expect(value.review.policyReview.budget).toMatchObject({
    revision: 1,
    capUnits: "15000000",
    availableUnits: "15000000",
  });
  expect(db.prepare("SELECT COUNT(*) AS n FROM quality_actual_runs").get()!.n).toBe(0);
});
it("does not use another candidate's policy", async () => {
  adopt(1);
  expect((await review()).review.assessment.blockers).toEqual(["policy-not-adopted"]);
});
it("keeps insufficient production budget and independent synthetic reservations intact", async () => {
  seedPolicyTestBudget(db);
  providerTestConfigure(store);
  store.providerStart(providerTestStartInput(store));
  adopt();
  const value = await review();
  expect(value.review.assessment.blockers).toEqual(["budget-insufficient"]);
  expect(value.review.policyReview.budget).toMatchObject({
    capUnits: "1000000",
    heldUnits: "0",
    availableUnits: "1000000",
  });
  expect(value.review.runs).toEqual({
    globalCount: 1,
    productionCount: 0,
    unsettledCandidateRunIds: [],
  });
  expect(store.providerBudgetGet().heldUnits).toBe("4");
});
it("rechecks changed official configuration without falling back to an older matching adoption", async () => {
  adopt();
  const changed = configuration.getProviderConfigurationProposal();
  if (!changed) throw new Error("fixture");
  changed.proposedBudget.capUnits = "16000000";
  changed.configurationDigest = digest(providerConfigurationDigestInput(changed));
  const getter = vi
    .spyOn(configuration, "getProviderConfigurationProposal")
    .mockReturnValue(changed);
  expect((await review()).review.assessment.blockers).toEqual(["policy-changed"]);
  adopt();
  getter.mockRestore();
  expect((await review()).review.policy).toMatchObject({
    state: "changed",
    reference: { revision: 2 },
  });
});
it("sees later committed evidence on a new inspection and preserves v4/v5 policy endpoints", async () => {
  const first = await review();
  adopt();
  const next = await review();
  expect(next.review.ledgerDigest).not.toBe(first.review.ledgerDigest);
  expect(next.review.policyReview.budget.revision).toBe(1);
  const before = rows();
  expect(await (await legacyInspect(post())).json()).toMatchObject({ viewVersion: 4 });
  expect(await (await policyInspect(post())).json()).toMatchObject({ viewVersion: 5 });
  expect(rows()).toBe(before);
});
it.each(["missing", "expired"])(
  "returns %s configuration as unavailable without a review",
  async (kind) => {
    adopt();
    const selected = selection();
    if (kind === "missing")
      vi.spyOn(configuration, "getProviderConfigurationProposal").mockReturnValue(null);
    else vi.setSystemTime("2030-01-01T00:00:00.000Z");
    const response = await inspect(post(selected));
    expect(response.status).toBe(200);
    expect(providerReservationInspectionResponseSchema.parse(await response.json())).toEqual({
      responseVersion: 1,
      status: "unavailable",
      selection: selected,
      review: null,
      reason: kind === "missing" ? "configuration-missing-or-invalid" : "configuration-expired",
    });
  },
);
it.each(["digest", "candidate"])(
  "returns a %s selection mismatch as 409 without a review",
  async (kind) => {
    const selected = {
      ...selection(),
      ...(kind === "digest"
        ? { versionDigest: "a".repeat(64) }
        : { candidateId: "validation-candidate-missing" }),
    };
    const response = await inspect(post(selected));
    expect(response.status).toBe(409);
    expect(providerReservationInspectionResponseSchema.parse(await response.json())).toMatchObject({
      status: "unavailable",
      reason: "selection-invalid",
      review: null,
    });
  },
);
it("keeps an absent registry distinct from storage corruption", async () => {
  const response = await inspect(post({ ...selection(), version: 2 }));
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ code: "QUALITY_PROVIDER_CANDIDATE_NOT_FOUND" });
});
it("refuses a future ledger instead of returning usable review evidence", async () => {
  vi.setSystemTime("2026-09-27T03:01:00.000Z");
  seedPolicyTestBudget(db);
  vi.setSystemTime(actualTestNow);
  const response = await inspect();
  expect(response.status).toBe(409);
  expect(providerReservationInspectionResponseSchema.parse(await response.json())).toMatchObject({
    status: "unavailable",
    reason: "ledger-after-inspection",
    review: null,
  });
});
it.each(["evaluation", "registration", "budget-receipt", "artifact", "schema"])(
  "returns no review when %s evidence is corrupt",
  async (kind) => {
    const selected = selection();
    adopt();
    if (kind === "evaluation") {
      store.create({
        clientRequestId: randomUUID(),
        title: "synthetic unrelated evaluation",
        manifestDigest: store.list().manifestDigest,
      });
      corruptFixture("quality_runs_no_update", () => {
        db.prepare("UPDATE quality_runs SET body_hash=?").run("a".repeat(64));
      });
    } else if (kind === "registration") {
      corruptFixture("quality_candidate_requests_no_update", () => {
        db.prepare("UPDATE quality_candidate_requests SET body_hash=?").run("a".repeat(64));
      });
    } else if (kind === "budget-receipt") {
      corruptFixture("quality_actual_requests_no_delete", () => {
        db.prepare("DELETE FROM quality_actual_requests").run();
      });
    } else if (kind === "artifact") {
      providerTestConfigure(store);
      store.providerStart(providerTestStartInput(store));
      corruptFixture("quality_actual_artifacts_no_update", () => {
        db.prepare("UPDATE quality_actual_artifacts SET payload=?").run(Buffer.from("{}"));
      });
    } else db.exec("CREATE TABLE unexpected_http_fixture(value TEXT)");
    const response = await inspect(post(selected));
    expect(response.status).toBe(409);
    const value = await response.json();
    expect(value).toHaveProperty("code");
    expect(value).not.toHaveProperty("review");
  },
);

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
  ["ledger", 400],
  ["policy", 400],
  ["command", 400],
  ["version", 400],
] as const)("rejects %s before opening the store", async (kind, status) => {
  const selected = selection();
  let url = base;
  const headers: Record<string, string> = { "content-type": "application/json" };
  let body: BodyInit = JSON.stringify(selected);
  if (kind === "cross-origin") headers.origin = "https://foreign.example";
  if (kind === "foreign-host") headers.host = "foreign.example";
  if (kind === "forwarded-host") headers["x-forwarded-host"] = "foreign.example";
  if (kind === "fetch-site") headers["sec-fetch-site"] = "cross-site";
  if (kind === "nonlocal-url") url = base.replace("127.0.0.1", "foreign.example");
  if (kind === "wrong-port") headers.host = "127.0.0.1:3001";
  if (kind === "query") url += "?version=1";
  if (kind === "content-type") headers["content-type"] = "text/plain";
  if (kind === "length") headers["content-length"] = String(providerReviewLimits.bodyBytes + 1);
  if (kind === "invalid-length") headers["content-length"] = "-1";
  if (kind === "actual-size") {
    headers["content-length"] = "1";
    body = " ".repeat(providerReviewLimits.bodyBytes + 1);
  }
  if (kind === "json") body = "{";
  if (kind === "utf8") body = new Uint8Array([0xff]);
  if (kind === "empty") body = "";
  if (["configuration", "ledger", "policy", "command"].includes(kind))
    body = JSON.stringify({ ...selected, [kind]: {} });
  if (kind === "version") body = JSON.stringify({ ...selected, version: "1" });
  state.opened.mockClear();
  const response = await inspect(new Request(url, { method: "POST", headers, body }));
  expect(response.status).toBe(status);
  expect(await response.json()).not.toHaveProperty("review");
  expect(state.opened).not.toHaveBeenCalled();
});
it("allows normalized loopback host and JSON charset on legitimate local requests", async () => {
  const response = await inspect(
    new Request(base.replace("127.0.0.1", "localhost"), {
      method: "POST",
      body: JSON.stringify(selection()),
      headers: {
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json; charset=utf-8",
      },
    }),
  );
  expect(response.status).toBe(200);
  expect(providerReservationInspectionResponseSchema.parse(await response.json()).status).toBe(
    "review",
  );
});
it("rejects unsupported methods before storage with an explicit Allow header", async () => {
  const before = rows();
  state.opened.mockClear();
  for (const method of ["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
    const response = await qualityProviderReservationReviewRoute(new Request(base, { method }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(response.headers.get("cache-control")).toContain("no-store");
  }
  expect(state.opened).not.toHaveBeenCalled();
  expect(rows()).toBe(before);
});
it.each(["type", "syntax", "schema", "unknown"])(
  "conceals %s server failures and does not classify them as bad input",
  async (kind) => {
    const request = post();
    vi.spyOn(store, "providerReservationReview").mockImplementationOnce(() => {
      if (kind === "type") throw new TypeError(privateFailure);
      if (kind === "syntax") throw new SyntaxError(privateFailure);
      if (kind === "schema") z.never().parse(privateFailure);
      throw new Error(privateFailure);
    });
    const response = await inspect(request);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain(privateFailure);
    expect(JSON.parse(text)).toEqual({
      error: "예약 검토를 확인하지 못했습니다. 다시 조회해 주세요.",
      code: "PROVIDER_RESERVATION_REVIEW_UNAVAILABLE",
    });
  },
);
it.each(["scope", "permission", "internal-reason"])(
  "rejects invalid %s server output before responding",
  async (kind) => {
    const selected = selection();
    const real = store.providerReservationReview(selected);
    if (real.status !== "review") throw new Error("fixture");
    if (kind === "scope")
      real.review.policyReview.scope.candidateId = "validation-candidate-missing";
    else if (kind === "permission") Object.assign(real.review.actions, { dispatchAllowed: true });
    vi.spyOn(store, "providerReservationReview").mockReturnValueOnce(
      kind === "internal-reason"
        ? { status: "unavailable", reason: "budget-head-changed", review: null }
        : real,
    );
    const response = await inspect(post(selected));
    expect(response.status).toBe(500);
    expect(await response.json()).not.toHaveProperty("review");
  },
);
it("conceals serialization failure after the audited read and leaves the next inspection usable", async () => {
  const request = post();
  vi.spyOn(Response, "json").mockImplementationOnce(() => {
    throw new TypeError(privateFailure);
  });
  const response = await inspect(request);
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain(privateFailure);
  expect((await review()).review.policy.state).toBe("not-adopted");
});
