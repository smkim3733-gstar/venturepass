import {
  reserveTransmissionTestRun,
  transmissionStoreFixture,
} from "./studio-plan-quality-provider-transmission-approval-store-test-helpers";
import { providerTransmissionInspectionResponseSchema } from "./studio-plan-quality-provider-transmission-http-types";
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
import { adoptReservationTestPolicy } from "./studio-plan-quality-provider-reservation-store-test-helpers";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { providerTransmissionReviewDigestInput } from "./studio-plan-quality-provider-transmission-review-types";
import {
  providerTransmissionApprovalHttpLimits,
  providerTransmissionApprovalInputSchema,
  providerTransmissionApprovalResponseSchema,
  type ProviderTransmissionApprovalInput,
} from "./studio-plan-quality-provider-transmission-approval-http-types";
import { qualityProviderTransmissionApprovalRoute } from "./studio-plan-quality-provider-transmission-approval-service";
import * as configuration from "./studio-plan-quality-provider-configuration";
import * as inspectRoute from "@/app/api/studio/quality/provider-transmission/inspect/route";
import * as approvalRoute from "@/app/api/studio/quality/provider-transmission/approvals/route";
import * as lookupRoute from "@/app/api/studio/quality/provider-transmission/requests/[clientRequestId]/route";

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
let directory: string,
  store: PlanQualityStore,
  db: DatabaseSync,
  selection: { runId: string; runDigest: string };
const base = "http://127.0.0.1:3000/api/studio/quality/provider-transmission";
const sentinel = "SYNTHETIC COMPANY BYTES";
const post = (input: unknown) =>
  new Request(base + "/approvals", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" },
    body: JSON.stringify(input),
  });
const approve = (input: unknown) => approvalRoute.POST(post(input));
const lookup = (
  clientRequestId: string,
  request = new Request(base + "/requests/" + clientRequestId),
) => lookupRoute.GET(request, { params: Promise.resolve({ clientRequestId }) });
async function result(response: Response) {
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  return providerTransmissionApprovalResponseSchema.parse(await response.json());
}
function input(): ProviderTransmissionApprovalInput {
  const value = transmissionStoreFixture(store, selection);
  return providerTransmissionApprovalInputSchema.parse({
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
  state.opened.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", state.forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-transmission-approval-http-"));
  writeFileSync(join(directory, "studio.sqlite"), sentinel);
  store = new PlanQualityStore(directory);
  store.candidateRegistryRegister({
    expectedVersion: 0,
    clientRequestId: randomUUID(),
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  });
  selection = reserveTransmissionTestRun(store);
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
  if (!rel.startsWith("venture-transmission-approval-http-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});

it("exports only the intended dynamic Node handlers", () => {
  for (const route of [approvalRoute, lookupRoute]) {
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
  }
  expect(Object.keys(approvalRoute).sort()).toEqual(["POST", "dynamic", "runtime"]);
  expect(Object.keys(lookupRoute).sort()).toEqual(["GET", "dynamic", "runtime"]);
});
it("preserves read-only inspection and commits one approval without budget or dispatch writes", async () => {
  const request = input(),
    before = rows(),
    budget = store.providerBudgetGet("production");
  const selection = {
    runId: request.command.runId,
    runDigest: request.command.runDigest,
  };
  const view = providerTransmissionInspectionResponseSchema.parse(
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
  state.opened.mockClear();
  const response = await approve(request);
  expect(state.opened).toHaveBeenCalledOnce();
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
      budgetWriteAllowed: false,
    },
  });
  if (value.state !== "committed") throw new Error("Expected commit");
  const archived = store.providerTransmissionApprovalLookup(request.command.clientRequestId);
  if (archived.state !== "committed") throw new Error("Expected archived commit");
  expect(value.receipt).toMatchObject({
    recordDigest: archived.record.recordDigest,
    runId: archived.record.runId,
    runDigest: archived.record.runDigest,
    executionInputDigest: archived.record.executionInputDigest,
    approvalEventDigest: archived.record.approvalEventDigest,
    approvalRevision: 1,
    recordedAt: archived.record.recordedAt,
  });
  expect(store.providerGet(value.receipt.runId)).toMatchObject({
    state: "approved",
    dispatchAllowed: false,
    actualAiCalls: null,
    dispatchIntentCount: 0,
    responseCount: 0,
  });
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(store.providerPolicyHead().revision).toBe(1);
  for (const table of [
    "quality_actual_runs",
    "quality_actual_artifacts",
    "quality_actual_events",
    "quality_provider_transmission_bindings",
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
    first = await result(await approve(request));
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
  expect(await result(await approve({ ...request, approvedReview: null }))).toEqual({
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
  if (kind === "expired") vi.setSystemTime(request.approvedReview!.expiresAt);
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
    expect((await approve(request)).status).toBe(200);
    request.command.approval.approvedAt = "2026-09-27T03:00:00.001Z";
  }
  if (kind === "missing-review") request.approvedReview = null;
  if (kind === "approval-time") request.command.approval.approvedAt = "2026-09-27T03:01:00.000Z";
  const before = rows(),
    response = await approve(request);
  expect(response.status).toBe(409);
  expect(await result(response)).toMatchObject({
    state: "refused",
    clientRequestId: request.command.clientRequestId,
  });
  expect(rows()).toBe(before);
});
it("rejects a rehashed forged review before approval writes", async () => {
  const request = input();
  request.approvedReview!.archiveDigest = "a".repeat(64);
  request.approvedReview!.reviewDigest = digest(
    providerTransmissionReviewDigestInput(request.approvedReview!),
  );
  request.command.expectedArchiveDigest = request.approvedReview!.archiveDigest;
  request.command.approvedReviewDigest = request.approvedReview!.reviewDigest;
  const before = rows(),
    response = await approve(request);
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
    const response = await approve(request);
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
    expect(await result(await approve(request))).toMatchObject({
      state: "committed",
      delivery: phase === "after" ? "replay" : "new",
    });
    expect(store.providerList().executions).toHaveLength(1);
  },
);
it("does not label response serialization failure after commit as a refusal", async () => {
  const request = input();
  vi.spyOn(Response, "json").mockImplementationOnce(() => {
    throw new StudioError("PRIVATE", 409, "QUALITY_PROVIDER_TRANSMISSION_NONCE_CONFLICT");
  });
  const response = await approve(request);
  expect(response.status).toBe(500);
  expect(await result(response)).toMatchObject({ state: "unknown" });
  expect(await result(await lookup(request.command.clientRequestId))).toMatchObject({
    state: "committed",
  });
});
it.each([
  "record-hash",
  "command",
  "nonce",
  "flags",
  "no-flags",
  "dispatch",
  "top-dispatch",
  "budget-write",
  "run-id",
  "run-digest",
  "native-input",
  "native-event",
  "recorded-at",
  "review-hash",
])("rejects a mismatched server %s response after commit", async (kind) => {
  const request = input(),
    write = store.providerApproveTransmission.bind(store);
  const spy = vi
    .spyOn(store, "providerApproveTransmission")
    .mockImplementation((command, review) => {
      const saved = structuredClone(write(command, review));
      if (kind === "record-hash") saved.record.recordDigest = "a".repeat(64);
      if (kind === "flags") saved.replayed = true;
      if (kind === "no-flags") saved.newlyCommitted = false;
      if (kind === "dispatch") Object.assign(saved.record, { dispatchAllowed: true });
      if (kind === "top-dispatch") Object.assign(saved, { dispatchAllowed: true });
      if (kind === "budget-write") Object.assign(saved, { budgetWriteAllowed: true });
      if (kind === "run-id") saved.record.runId = randomUUID();
      if (kind === "run-digest") saved.record.runDigest = "a".repeat(64);
      if (kind === "native-input") saved.record.executionInputDigest = "a".repeat(64);
      if (kind === "native-event") saved.record.approvalEventDigest = "a".repeat(64);
      if (kind === "recorded-at") saved.record.recordedAt = "2026-09-27T03:00:00.001Z";
      if (kind === "review-hash") saved.record.approvedReview.reviewDigest = "a".repeat(64);
      if (kind === "command" || kind === "nonce") {
        if (kind === "command")
          saved.record.command.approval.approvedAt = "2026-09-27T03:00:00.001Z";
        else saved.record.clientRequestId = saved.record.command.clientRequestId = randomUUID();
        saved.record.commandDigest = digest(saved.record.command);
      }
      if (kind !== "record-hash") {
        const { recordDigest: _unused, ...body } = saved.record;
        void _unused;
        saved.record.recordDigest = digest(body);
      }
      return saved;
    });
  const response = await approve(request);
  spy.mockRestore();
  expect(response.status).toBe(500);
  expect(await result(response)).toMatchObject({ state: "unknown" });
  expect(await result(await lookup(request.command.clientRequestId))).toMatchObject({
    state: "committed",
  });
});
it("does not return another nonce's valid commit from lookup", async () => {
  const request = input();
  await approve(request);
  const original = store.providerTransmissionApprovalLookup(request.command.clientRequestId);
  vi.spyOn(store, "providerTransmissionApprovalLookup").mockReturnValue(original);
  const nonce = randomUUID(),
    response = await lookup(nonce);
  expect(response.status).toBe(500);
  expect(await result(response)).toMatchObject({ state: "unknown", clientRequestId: nonce });
});
it.each(["dispatch", "budget", "not-observed-extra"])(
  "rejects a malformed %s lookup envelope",
  async (kind) => {
    const request = input();
    await approve(request);
    const saved = store.providerTransmissionApprovalLookup(request.command.clientRequestId);
    if (saved.state !== "committed") throw new Error("Expected commit");
    const invalid =
      kind === "not-observed-extra"
        ? { state: "not-observed", dispatchAllowed: true }
        : { ...saved, [kind === "dispatch" ? "dispatchAllowed" : "budgetWriteAllowed"]: true };
    vi.spyOn(store, "providerTransmissionApprovalLookup").mockReturnValue(invalid as never);
    const response = await lookup(request.command.clientRequestId);
    expect(response.status).toBe(500);
    expect(await result(response)).toMatchObject({
      state: "unknown",
      clientRequestId: request.command.clientRequestId,
    });
  },
);
it("refuses a different full command sharing the original native approval identity", async () => {
  const first = input();
  vi.setSystemTime(new Date(Date.parse(actualTestNow) + 1000));
  const second = input();
  first.command.approval.approvedAt = second.command.approval.approvedAt;
  second.command.clientRequestId = first.command.clientRequestId;
  const committed = await result(await approve(first)),
    before = rows();
  expect(committed.state).toBe("committed");
  const response = await approve(second);
  expect(response.status).toBe(409);
  expect(await result(response)).toMatchObject({
    state: "refused",
    code: "QUALITY_PROVIDER_TRANSMISSION_NONCE_CONFLICT",
  });
  expect(await result(await lookup(first.command.clientRequestId))).toEqual({
    ...committed,
    delivery: "lookup",
  });
  expect(rows()).toBe(before);
});
it.each(["ARCHIVE_INVALID", "PLANNED_ARCHIVE_INVALID", "STORAGE_CORRUPT"])(
  "keeps %s unknown instead of declaring the original request refused",
  async (code) => {
    const request = input(),
      before = rows();
    vi.spyOn(store, "providerApproveTransmission").mockImplementationOnce(() => {
      throw new StudioError(
        "PRIVATE credentials and path",
        409,
        `QUALITY_PROVIDER_TRANSMISSION_${code}`,
      );
    });
    const response = await approve(request);
    expect(response.status).toBe(500);
    const value = await result(response);
    expect(value).toMatchObject({
      state: "unknown",
      clientRequestId: request.command.clientRequestId,
    });
    expect(JSON.stringify(value)).not.toContain("PRIVATE");
    expect(rows()).toBe(before);
  },
);
it("hides store-opening failures for both command and lookup", async () => {
  const request = input(),
    before = rows();
  state.opened.mockImplementation(() => {
    throw new SyntaxError("PRIVATE database path");
  });
  for (const response of [await approve(request), await lookup(request.command.clientRequestId)]) {
    expect(response.status).toBe(500);
    expect(await result(response)).toMatchObject({
      state: "unknown",
      clientRequestId: request.command.clientRequestId,
    });
  }
  state.opened.mockReset();
  expect(rows()).toBe(before);
});
it.each([new TypeError("PRIVATE"), new SyntaxError("PRIVATE"), z.string().safeParse(0).error!])(
  "does not blame client input for a server error: %s",
  async (error) => {
    const request = input();
    vi.spyOn(store, "providerApproveTransmission").mockImplementationOnce(() => {
      throw error;
    });
    const response = await approve(request);
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
    if (replay) await approve(request);
    const trigger = db
      .prepare("SELECT sql FROM sqlite_schema WHERE name='quality_runs_no_update'")
      .get()!.sql as string;
    db.exec("DROP TRIGGER quality_runs_no_update");
    db.prepare("UPDATE quality_runs SET body_hash=?").run("a".repeat(64));
    db.exec(trigger);
    const before = rows();
    for (const response of [
      await approve(request),
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
  let url = base + "/approvals";
  const headers: Record<string, string> = { "content-type": "application/json" };
  let body: BodyInit = JSON.stringify(request);
  if (kind === "cross-origin") headers.origin = "https://foreign.example";
  if (kind === "foreign-host") headers.host = "foreign.example";
  if (kind === "foreign-url") url = "https://foreign.example/approvals";
  if (kind === "forwarded-host") headers["x-forwarded-host"] = "foreign.example";
  if (kind === "fetch-site") headers["sec-fetch-site"] = "cross-site";
  if (kind === "query") url += "?budget=1";
  if (kind === "content-type") headers["content-type"] = "application/jsonp";
  if (kind === "length")
    headers["content-length"] = String(providerTransmissionApprovalHttpLimits.bodyBytes + 1);
  if (kind === "invalid-length") headers["content-length"] = "-1";
  if (kind === "actual-size")
    body = " ".repeat(providerTransmissionApprovalHttpLimits.bodyBytes + 1);
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
        approval: { ...request.command.approval, acknowledgedExternalTransmission: false },
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
  const response = await approvalRoute.POST(new Request(url, { method: "POST", headers, body }));
  expect(response.status).toBe(status);
  expect(await result(response)).toMatchObject({ state: "refused" });
  expect(state.opened).not.toHaveBeenCalled();
  expect(rows()).toBe(before);
});
it("guards methods and lookup parameters without opening the store", async () => {
  state.opened.mockClear();
  for (const operation of ["approve", "lookup"] as const) {
    const response = await qualityProviderTransmissionApprovalRoute(
      new Request(base, { method: "PUT" }),
      operation,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe(operation === "approve" ? "POST" : "GET");
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
it("accepts exactly the UTF-8 byte limit and rejects one additional byte before opening storage", async () => {
  const request = input(),
    body = JSON.stringify(request),
    maximum = providerTransmissionApprovalHttpLimits.bodyBytes,
    bytes = Buffer.byteLength(body, "utf8");
  expect(bytes).toBeGreaterThan(body.length);
  expect(bytes).toBeLessThan(maximum);
  const padded = body + " ".repeat(maximum - bytes),
    before = rows();
  state.opened.mockClear();
  const rejected = await approvalRoute.POST(
    new Request(base + "/approvals", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "1" },
      body: padded + " ",
    }),
  );
  expect(rejected.status).toBe(413);
  expect(await result(rejected)).toMatchObject({ state: "refused", code: "TOO_LARGE" });
  expect(state.opened).not.toHaveBeenCalled();
  expect(rows()).toBe(before);
  const accepted = await approvalRoute.POST(
    new Request(base + "/approvals", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-length": String(maximum),
      },
      body: padded,
    }),
  );
  expect(accepted.status).toBe(200);
  expect(await result(accepted)).toMatchObject({ state: "committed", delivery: "new" });
  expect(state.opened).toHaveBeenCalledOnce();
});
it("cancels an oversized chunked body before opening storage", async () => {
  const cancelled = vi.fn(),
    before = rows(),
    maximum = providerTransmissionApprovalHttpLimits.bodyBytes;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(maximum));
      controller.enqueue(new Uint8Array(1));
    },
    cancel: cancelled,
  });
  state.opened.mockClear();
  const response = await approvalRoute.POST(
    new Request(base + "/approvals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit),
  );
  expect(response.status).toBe(413);
  expect(await result(response)).toMatchObject({ state: "refused", code: "TOO_LARGE" });
  expect(cancelled).toHaveBeenCalledOnce();
  expect(state.opened).not.toHaveBeenCalled();
  expect(rows()).toBe(before);
});
it("accepts valid UTF-8 split across stream chunks without a second store read", async () => {
  const request = input(),
    encoded = new TextEncoder().encode(JSON.stringify(request)),
    split = encoded.findIndex((value) => value >= 0x80) + 1;
  expect(split).toBeGreaterThan(0);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded.slice(0, split));
      controller.enqueue(encoded.slice(split));
      controller.close();
    },
  });
  state.opened.mockClear();
  const response = await approvalRoute.POST(
    new Request(base + "/approvals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit),
  );
  expect(response.status).toBe(200);
  expect(await result(response)).toMatchObject({ state: "committed", delivery: "new" });
  expect(state.opened).toHaveBeenCalledOnce();
});
