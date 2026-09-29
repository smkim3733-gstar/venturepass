/** Synthetic local HTTP requests and isolated databases; no actual approval or provider IO. */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { StudioError } from "./studio-http";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import {
  adoptReservationTestPolicy,
  reservationStoreFixture,
} from "./studio-plan-quality-provider-reservation-store-test-helpers";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { providerReservationReviewDigestInput } from "./studio-plan-quality-provider-reservation-review-types";
import {
  providerReservationHttpLimits,
  providerReservationInputSchema,
  providerReservationResponseSchema,
  providerReservationInspectionResponseSchema,
  type ProviderReservationInput,
} from "./studio-plan-quality-provider-reservation-http-types";
import { qualityProviderReservationCommandRoute } from "./studio-plan-quality-provider-reservation-command-service";
import * as configuration from "./studio-plan-quality-provider-configuration";
import * as inspectRoute from "@/app/api/studio/quality/provider-reservation/inspect/route";
import * as reserveRoute from "@/app/api/studio/quality/provider-reservation/reservations/route";
import * as lookupRoute from "@/app/api/studio/quality/provider-reservation/requests/[clientRequestId]/route";

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
const base = "http://127.0.0.1:3000/api/studio/quality/provider-reservation";
const sentinel = "SYNTHETIC COMPANY BYTES";
const post = (input: unknown) =>
  new Request(base + "/reservations", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" },
    body: JSON.stringify(input),
  });
const reserve = (input: unknown) => reserveRoute.POST(post(input));
const lookup = (
  clientRequestId: string,
  request = new Request(base + "/requests/" + clientRequestId),
) => lookupRoute.GET(request, { params: Promise.resolve({ clientRequestId }) });
async function result(response: Response) {
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  return providerReservationResponseSchema.parse(await response.json());
}
function input(): ProviderReservationInput {
  const value = reservationStoreFixture(store);
  return providerReservationInputSchema.parse({
    command: value.command,
    approvedReview: value.review,
  });
}
function rows() {
  return digest(
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'quality_%' ORDER BY name",
      )
      .all()
      .map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", state.forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-reservation-http-"));
  writeFileSync(join(directory, "studio.sqlite"), sentinel);
  store = new PlanQualityStore(directory);
  store.candidateRegistryRegister({
    expectedVersion: 0,
    clientRequestId: randomUUID(),
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  });
  adoptReservationTestPolicy(store);
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

it("exports only the intended dynamic Node handlers", () => {
  for (const route of [reserveRoute, lookupRoute]) {
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
  }
  expect(Object.keys(reserveRoute).sort()).toEqual(["POST", "dynamic", "runtime"]);
  expect(Object.keys(lookupRoute).sort()).toEqual(["GET", "dynamic", "runtime"]);
});
it("preserves the read-only inspection and commits one audited reservation with a bound receipt", async () => {
  const request = input(),
    before = rows(),
    budget = store.providerBudgetGet("production");
  const selection = {
    version: request.command.version,
    versionDigest: request.command.versionDigest,
    candidateId: request.command.candidateId,
  };
  const view = providerReservationInspectionResponseSchema.parse(
    await (
      await inspectRoute.POST(
        new Request(base + "/inspect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(selection),
        }),
      )
    ).json(),
  );
  expect(view).toMatchObject({ status: "review", review: request.approvedReview });
  expect(rows()).toBe(before);
  const exec = vi.spyOn(DatabaseSync.prototype, "exec");
  const response = await reserve(request);
  expect(exec.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
  exec.mockRestore();
  expect(response.status).toBe(200);
  const value = await result(response);
  expect(value).toMatchObject({
    state: "committed",
    delivery: "new",
    receipt: {
      clientRequestId: request.command.clientRequestId,
      commandDigest: digest(request.command),
      approvedReviewDigest: request.command.approvedReviewDigest,
      dispatchAllowed: false,
    },
  });
  if (value.state !== "committed") throw new Error("Expected commit");
  const archived = store.providerReservationLookup(request.command.clientRequestId);
  if (archived.state !== "committed") throw new Error("Expected archived commit");
  expect(value.receipt).toMatchObject({
    recordDigest: archived.record.recordDigest,
    runId: archived.record.runId,
    runDigest: archived.record.runDigest,
    startInputDigest: archived.record.startInputDigest,
  });
  expect(store.providerGet(value.receipt.runId)).toMatchObject({
    state: "reserved",
    dispatchAllowed: false,
    actualAiCalls: 0,
  });
  expect(store.providerBudgetGet("production")).toMatchObject({
    capUnits: budget.capUnits,
    recognizedUnits: budget.recognizedUnits,
    revision: budget.revision + 1,
  });
  expect(store.providerPolicyHead().revision).toBe(1);
  for (const table of [
    "quality_actual_runs",
    "quality_actual_artifacts",
    "quality_provider_reservation_bindings",
  ])
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n).toBe(1);
  const after = rows();
  expect(await result(await lookup(request.command.clientRequestId))).toEqual({
    ...value,
    delivery: "lookup",
  });
  expect(rows()).toBe(after);
});
it("keeps not-observed distinct from failure, including a nonce owned by another operation", async () => {
  const owned = String(db.prepare("SELECT nonce FROM quality_provider_policies").get()!.nonce),
    before = rows();
  for (const nonce of [randomUUID(), owned])
    expect(await result(await lookup(nonce))).toEqual({
      responseVersion: 1,
      state: "not-observed",
      clientRequestId: nonce,
      recovery: "replay-original-request",
    });
  expect(rows()).toBe(before);
});
it("recovers the same historical receipt after restart, expiry and current configuration failure", async () => {
  const request = input(),
    first = await result(await reserve(request));
  adoptReservationTestPolicy(store, 1);
  store.close();
  state.store = store = new PlanQualityStore(directory);
  vi.setSystemTime("2035-01-01T00:00:00.000Z");
  const getter = vi
    .spyOn(configuration, "getProviderConfigurationProposal")
    .mockImplementation(() => {
      throw new Error("PRIVATE configuration");
    });
  const before = rows();
  expect(await result(await reserve({ ...request, approvedReview: null }))).toEqual({
    ...first,
    delivery: "replay",
  });
  expect(await result(await lookup(request.command.clientRequestId))).toEqual({
    ...first,
    delivery: "lookup",
  });
  expect(getter).not.toHaveBeenCalled();
  expect(rows()).toBe(before);
});
it.each([
  "expired",
  "configuration",
  "policy-head",
  "ledger",
  "nonce",
  "missing-review",
  "approval-time",
])("refuses %s for this attempt without additional writes", async (kind) => {
  const request = input();
  if (kind === "expired") vi.setSystemTime(request.approvedReview!.policyReview.expiresAt);
  if (kind === "configuration")
    vi.spyOn(configuration, "getProviderConfigurationProposal").mockReturnValue(null);
  if (kind === "policy-head") adoptReservationTestPolicy(store, 1);
  if (kind === "ledger")
    store.create({
      clientRequestId: randomUUID(),
      title: "synthetic",
      manifestDigest: store.list().manifestDigest,
    });
  if (kind === "nonce") {
    expect((await reserve(request)).status).toBe(200);
    request.command.approval.approvedAt = "2026-09-27T03:00:00.001Z";
  }
  if (kind === "missing-review") request.approvedReview = null;
  if (kind === "approval-time") request.command.approval.approvedAt = "2026-09-27T03:01:00.000Z";
  const before = rows(),
    response = await reserve(request);
  expect(response.status).toBe(409);
  expect(await result(response)).toMatchObject({
    state: "refused",
    clientRequestId: request.command.clientRequestId,
  });
  expect(rows()).toBe(before);
});
it("rejects a rehashed forged review before it can reserve money", async () => {
  const request = input();
  request.approvedReview!.ledgerDigest = "a".repeat(64);
  request.approvedReview!.reviewDigest = digest(
    providerReservationReviewDigestInput(request.approvedReview!),
  );
  request.command.expectedLedgerDigest = request.approvedReview!.ledgerDigest;
  request.command.approvedReviewDigest = request.approvedReview!.reviewDigest;
  const before = rows(),
    response = await reserve(request);
  expect(response.status).toBe(409);
  expect(await result(response)).toMatchObject({ state: "refused" });
  expect(rows()).toBe(before);
});
it.each(["before", "after"])(
  "reports an actual %s-COMMIT exception as unknown and recovers the original command",
  async (phase) => {
    const request = input(),
      before = rows(),
      exec = DatabaseSync.prototype.exec;
    let injected = false;
    const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (sql === "COMMIT" && !injected) {
        injected = true;
        if (phase === "after") exec.call(this, sql);
        throw new Error("PRIVATE storage path or credential");
      }
      return exec.call(this, sql);
    });
    const response = await reserve(request);
    spy.mockRestore();
    expect(injected).toBe(true);
    expect(response.status).toBe(500);
    const unknown = await result(response);
    expect(unknown).toMatchObject({
      state: "unknown",
      clientRequestId: request.command.clientRequestId,
      recovery: "lookup-or-replay-original-request",
    });
    expect(JSON.stringify(unknown)).not.toContain("PRIVATE");
    if (phase === "before") expect(rows()).toBe(before);
    expect((await result(await lookup(request.command.clientRequestId))).state).toBe(
      phase === "after" ? "committed" : "not-observed",
    );
    expect(await result(await reserve(request))).toMatchObject({
      state: "committed",
      delivery: phase === "after" ? "replay" : "new",
    });
    expect(store.providerList().executions).toHaveLength(1);
  },
);
it("does not label response serialization failure after commit as a refusal", async () => {
  const request = input();
  vi.spyOn(Response, "json").mockImplementationOnce(() => {
    throw new StudioError("PRIVATE", 409, "QUALITY_PROVIDER_RESERVATION_NONCE_CONFLICT");
  });
  const response = await reserve(request);
  expect(response.status).toBe(500);
  expect(await result(response)).toMatchObject({ state: "unknown" });
  expect(await result(await lookup(request.command.clientRequestId))).toMatchObject({
    state: "committed",
  });
});
it.each(["record-hash", "command", "nonce", "flags", "dispatch"])(
  "rejects a mismatched server %s response after commit",
  async (kind) => {
    const request = input(),
      write = store.providerReserve.bind(store);
    const spy = vi.spyOn(store, "providerReserve").mockImplementation((command, review) => {
      const saved = structuredClone(write(command, review));
      if (kind === "record-hash") saved.record.recordDigest = "a".repeat(64);
      if (kind === "flags") saved.replayed = true;
      if (kind === "dispatch") Object.assign(saved.record, { dispatchAllowed: true });
      if (kind === "command" || kind === "nonce") {
        if (kind === "command")
          saved.record.command.approval.approvedAt = "2026-09-27T03:00:00.001Z";
        else saved.record.clientRequestId = saved.record.command.clientRequestId = randomUUID();
        saved.record.commandDigest = digest(saved.record.command);
        const { recordDigest: _unused, ...body } = saved.record;
        void _unused;
        saved.record.recordDigest = digest(body);
      }
      return saved;
    });
    const response = await reserve(request);
    spy.mockRestore();
    expect(response.status).toBe(500);
    expect(await result(response)).toMatchObject({ state: "unknown" });
    expect(await result(await lookup(request.command.clientRequestId))).toMatchObject({
      state: "committed",
    });
  },
);
it("does not return another nonce's valid commit from lookup", async () => {
  const request = input();
  await reserve(request);
  const original = store.providerReservationLookup(request.command.clientRequestId);
  vi.spyOn(store, "providerReservationLookup").mockReturnValue(original);
  const nonce = randomUUID(),
    response = await lookup(nonce);
  expect(response.status).toBe(500);
  expect(await result(response)).toMatchObject({ state: "unknown", clientRequestId: nonce });
});
it.each([new TypeError("PRIVATE"), new SyntaxError("PRIVATE"), z.string().safeParse(0).error!])(
  "does not blame client input for a server error: %s",
  async (error) => {
    const request = input();
    vi.spyOn(store, "providerReserve").mockImplementationOnce(() => {
      throw error;
    });
    const response = await reserve(request);
    expect(response.status).toBe(500);
    expect(await result(response)).toMatchObject({ state: "unknown" });
  },
);
it.each([false, true])(
  "returns unknown for corrupted evidence, including replay=%s",
  async (replay) => {
    store.create({
      clientRequestId: randomUUID(),
      title: "synthetic",
      manifestDigest: store.list().manifestDigest,
    });
    const request = input();
    if (replay) await reserve(request);
    const trigger = db
      .prepare("SELECT sql FROM sqlite_schema WHERE name='quality_runs_no_update'")
      .get()!.sql as string;
    db.exec("DROP TRIGGER quality_runs_no_update");
    db.prepare("UPDATE quality_runs SET body_hash=?").run("a".repeat(64));
    db.exec(trigger);
    const before = rows();
    for (const response of [
      await reserve(request),
      await lookup(request.command.clientRequestId),
    ]) {
      expect(response.status).toBe(500);
      expect(await result(response)).toMatchObject({ state: "unknown" });
    }
    expect(rows()).toBe(before);
  },
);
it.each([
  ["cross-origin", 403],
  ["foreign-host", 403],
  ["foreign-url", 403],
  ["forwarded-host", 403],
  ["fetch-site", 403],
  ["query", 400],
  ["content-type", 415],
  ["length", 413],
  ["invalid-length", 413],
  ["actual-size", 413],
  ["json", 400],
  ["utf8", 400],
  ["unknown-field", 400],
  ["command-field", 400],
  ["missing-ack", 400],
  ["bad-nonce", 400],
  ["bad-review", 400],
] as const)("rejects %s before opening the store", async (kind, status) => {
  const request = input();
  let url = base + "/reservations";
  const headers: Record<string, string> = { "content-type": "application/json" };
  let body: BodyInit = JSON.stringify(request);
  if (kind === "cross-origin") headers.origin = "https://foreign.example";
  if (kind === "foreign-host") headers.host = "foreign.example";
  if (kind === "foreign-url") url = "https://foreign.example/reservations";
  if (kind === "forwarded-host") headers["x-forwarded-host"] = "foreign.example";
  if (kind === "fetch-site") headers["sec-fetch-site"] = "cross-site";
  if (kind === "query") url += "?budget=1";
  if (kind === "content-type") headers["content-type"] = "application/jsonp";
  if (kind === "length")
    headers["content-length"] = String(providerReservationHttpLimits.bodyBytes + 1);
  if (kind === "invalid-length") headers["content-length"] = "-1";
  if (kind === "actual-size") body = " ".repeat(providerReservationHttpLimits.bodyBytes + 1);
  if (kind === "json") body = "{";
  if (kind === "utf8") body = new Uint8Array([0xff]);
  if (kind === "unknown-field") body = JSON.stringify({ ...request, configuration: {} });
  if (kind === "command-field")
    body = JSON.stringify({ ...request, command: { ...request.command, budgetEvents: [] } });
  if (kind === "missing-ack")
    body = JSON.stringify({
      ...request,
      command: {
        ...request.command,
        approval: { ...request.command.approval, acknowledgedReservationOnly: false },
      },
    });
  if (kind === "bad-nonce")
    body = JSON.stringify({
      ...request,
      command: { ...request.command, clientRequestId: "invalid" },
    });
  if (kind === "bad-review") body = JSON.stringify({ ...request, approvedReview: {} });
  const before = rows();
  state.opened.mockClear();
  const response = await reserveRoute.POST(new Request(url, { method: "POST", headers, body }));
  expect(response.status).toBe(status);
  expect(await result(response)).toMatchObject({ state: "refused" });
  expect(state.opened).not.toHaveBeenCalled();
  expect(rows()).toBe(before);
});
it("guards methods and lookup parameters without opening the store", async () => {
  state.opened.mockClear();
  for (const operation of ["reserve", "lookup"] as const) {
    const response = await qualityProviderReservationCommandRoute(
      new Request(base, { method: "PUT" }),
      operation,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe(operation === "reserve" ? "POST" : "GET");
  }
  expect((await lookup("invalid")).status).toBe(400);
  expect((await lookup(randomUUID(), new Request(base + "?extra=1"))).status).toBe(400);
  const foreign = await lookup(
    randomUUID(),
    new Request(base, { headers: { origin: "https://foreign.example" } }),
  );
  expect(foreign.status).toBe(403);
  expect(state.opened).not.toHaveBeenCalled();
});
