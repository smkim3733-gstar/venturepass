import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
vi.mock("server-only", () => ({}));
const calls = vi.hoisted(() => ({
  db: vi.fn(),
  dbClose: vi.fn(),
  session: vi.fn(() => ({})),
  sessionClose: vi.fn(),
  factory: vi.fn(),
  check: vi.fn(),
  forbidden: vi.fn(() => {
    throw Error("network forbidden");
  }),
}));
vi.mock("openai", calls.forbidden);
vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    isTransaction = false;
    constructor() {
      calls.db();
    }
    close() {
      calls.dbClose();
    }
  },
}));
vi.mock("./studio-public-comparison-file-identity", () => ({
  checkComparisonDatabasePath: calls.check,
}));
vi.mock("./studio-comparison-company-capability", () => ({
  recordComparisonCompanyConnection: vi.fn(),
  issueComparisonCompanyGuard: vi.fn(() => ({})),
  revokeComparisonCompanyGuards: vi.fn(),
}));
vi.mock("./studio-public-comparison-storage-witness", () => ({
  openComparisonStorageSession: calls.session,
  closeComparisonStorageSession: calls.sessionClose,
}));
vi.mock("./studio-public-claim-comparison-database-v11", () => ({
  createPublicComparisonCancellationStore: calls.factory,
}));
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { comparisonCancellationFixture } from "../../scripts/fixtures/comparison-execution";
import { createComparisonCancellation } from "./studio-comparison-cancellation";
import { openConfiguredCancellation } from "./studio-comparison-cancellation-open";
import { createCancellationHttpServer } from "./studio-comparison-cancellation-http";
import { createCancellationClient } from "./studio-comparison-cancellation-client";
import type { CancellationSelection } from "./studio-comparison-cancellation-wire";
const origin = "http://127.0.0.1:30331",
  at = "2026-10-14T09:40:00.000Z";
function setup() {
  const f = comparisonCancellationFixture(),
    hash = "a".repeat(64),
    selection: CancellationSelection = f.cancellation.selection;
  const input = {
    dataRoot: join(tmpdir(), "cancellation-unit", "data"),
    controlDirectory: join(tmpdir(), "cancellation-unit", "control"),
    databaseInstanceId: crypto.randomUUID(),
    selection,
  };
  const { reviewDigest: _d, ...display } = f.cancellationReview;
  void _d;
  const body = {
    ...display,
    databaseInstanceId: input.databaseInstanceId,
    expectedBindingDigest: hash,
    reservationDigest: hash,
    expectedRunHead: { revision: 1, headDigest: hash },
    expectedBudgetHead: { revision: 3, headDigest: hash },
  };
  const review = { ...body, reviewDigest: digest(body) };
  let saved: unknown = null;
  const store = {
    review: vi.fn(() => structuredClone(review)),
    cancel: vi.fn((command: unknown) => {
      saved = structuredClone(command);
      return {
        status: "committed",
        witnessMatched: true,
        result: { status: "replay", command: saved },
      };
    }),
    lookup: vi.fn(() =>
      saved
        ? {
            status: "recorded",
            command: saved,
            recordedAt: at,
            currency: review.currency,
            unitScale: review.unitScale,
            releasedUnits: review.releasedUnits,
          }
        : { status: "not-observed" },
    ),
    close: vi.fn(() => ({ closed: true })),
  };
  calls.factory.mockReturnValue(store);
  vi.stubEnv("VENTURE_DATA_DIR", input.dataRoot);
  vi.stubEnv("VENTUREPASS_COMPARISON_EXECUTION_CONTROL_DIR", input.controlDirectory);
  vi.stubEnv("VENTUREPASS_COMPARISON_EXECUTION_DATABASE_ID", input.databaseInstanceId);
  const owner = createComparisonCancellation(input),
    consent = {
      reviewDigest: review.reviewDigest,
      cancelReservationAcknowledged: true,
      retainedEvidenceAcknowledged: true,
    };
  const server = createCancellationHttpServer(),
    open = vi.fn(openConfiguredCancellation),
    registrationId = crypto.randomUUID();
  const endpoint =
    origin + `/api/studio/cases/${selection.companyId}/public-claim-comparison/cancellation`;
  async function request(action: unknown, id: string = registrationId, extra: RequestInit = {}) {
    const op = server.handle(
      new Request(endpoint, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          "x-venturepass-comparison-cancellation": id,
        },
        body: typeof action === "string" ? action : JSON.stringify(action),
        ...extra,
      }),
      selection.companyId,
      open,
    );
    const response = await op.response;
    await op.completion;
    return response;
  }
  const data = new Map<string, string>(),
    storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
      removeItem: (key: string) => {
        data.delete(key);
      },
    };
  let lose = false;
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const action = JSON.parse(String(init?.body));
    const response = await request(
      action,
      new Headers(init?.headers).get("x-venturepass-comparison-cancellation")!,
      { signal: init?.signal ?? undefined },
    );
    if (lose && action.action === "cancel") throw Error("lost response");
    return response;
  });
  const client = createCancellationClient(storage, fetcher);
  return {
    ...f,
    input,
    selection,
    review,
    store,
    owner,
    consent,
    request,
    open,
    storage,
    data,
    client,
    fetcher,
    lose() {
      lose = true;
    },
    clear() {
      saved = null;
    },
  };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
  vi.stubGlobal("fetch", calls.forbidden);
});
afterEach(() => {
  expect(calls.forbidden).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});
it("cancellation owner is passive and pins selection, review, one command and release receipt", () => {
  const f = setup();
  expect(calls.db).not.toHaveBeenCalled();
  f.owner.review();
  f.input.selection.runId = crypto.randomUUID();
  const result = f.owner.cancel(f.consent);
  expect(result).toMatchObject({
    status: "recorded",
    receipt: { cancelled: true, refundVerified: false, releasedUnits: "1250" },
  });
  expect(f.store.cancel).toHaveBeenCalledTimes(1);
  expect(f.owner.close()).toMatchObject({ status: "closed", retained: false });
});
it.each(["missing", "digest", "first-consent", "second-consent", "expired", "extra"])(
  "cancellation owner rejects %s before any cancellation attempt",
  (kind) => {
    const f = setup();
    if (kind !== "missing") f.owner.review();
    if (kind === "expired") vi.setSystemTime("2100-01-01T00:00:00.000Z");
    const c = {
      ...f.consent,
      ...(kind === "digest" ? { reviewDigest: "b".repeat(64) } : {}),
      ...(kind === "first-consent" ? { cancelReservationAcknowledged: false } : {}),
      ...(kind === "second-consent" ? { retainedEvidenceAcknowledged: false } : {}),
      ...(kind === "extra" ? { releasedUnits: "0" } : {}),
    };
    expect(() => f.owner.cancel(c)).toThrow();
    expect(f.store.cancel).not.toHaveBeenCalled();
    expect(f.owner.inspect()).toMatchObject({
      status: kind === "missing" ? "unused" : "review",
      receipt: null,
    });
    expect(() => f.owner.recover()).toThrow(/OWNER_UNAVAILABLE/);
  },
);
it("cancellation duplicate, lost delivery and revoked recovery only read the original command", () => {
  const f = setup();
  f.owner.review();
  const write = f.store.cancel.getMockImplementation()!;
  f.store.cancel.mockImplementationOnce((c) => {
    write(c);
    throw Error("lost");
  });
  expect(() => f.owner.cancel(f.consent)).toThrow();
  const result = f.owner.recover();
  expect(result.status).toBe("recorded");
  expect(f.owner.cancel(f.consent).receipt).toEqual(result.receipt);
  f.owner.revoke();
  vi.setSystemTime("2100-01-01T00:00:00.000Z");
  expect(f.owner.recover().receipt).toEqual(result.receipt);
  expect(f.store.cancel).toHaveBeenCalledTimes(1);
});
it("cancellation unobserved attempt cannot generate a replacement write or nonce", () => {
  const f = setup();
  f.owner.review();
  f.store.cancel.mockImplementationOnce(() => {
    throw Error("not stored");
  });
  expect(() => f.owner.cancel(f.consent)).toThrow();
  const id = f.owner.inspect().clientRequestId;
  expect(f.owner.recover().status).toBe("not-observed");
  expect(f.owner.cancel(f.consent).clientRequestId).toBe(id);
  expect(f.store.cancel).toHaveBeenCalledTimes(1);
});
it("cancellation changed receipt is refused and failed cleanup retains the exact store", () => {
  const f = setup();
  f.owner.review();
  f.store.lookup.mockImplementationOnce(() => ({
    status: "recorded",
    command: {},
    recordedAt: at,
    currency: "USD",
    unitScale: 6,
    releasedUnits: "1250",
  }));
  expect(() => f.owner.cancel(f.consent)).toThrow(/RECEIPT/);
  f.store.close.mockReturnValueOnce({ closed: false });
  expect(f.owner.close()).toMatchObject({ status: "draining", retained: true });
  expect(calls.sessionClose).not.toHaveBeenCalled();
  expect(f.owner.close().status).toBe("closed");
  expect(calls.factory).toHaveBeenCalledTimes(1);
});
it("cancellation partial acquisition cannot retry new resources and cleans the original DB", () => {
  const f = setup();
  calls.session.mockImplementationOnce(() => {
    throw Error("session");
  });
  expect(() => f.owner.review()).toThrow();
  expect(() => f.owner.review()).toThrow();
  expect(calls.db).toHaveBeenCalledTimes(1);
  expect(f.owner.close().status).toBe("closed");
  expect(calls.dbClose).toHaveBeenCalledTimes(1);
});
it("configured cancellation revokes new writes on changed paths and retains recovery after settings withdrawal", () => {
  const f = setup(),
    owner = openConfiguredCancellation(f.selection);
  owner.review();
  owner.cancel(f.consent);
  vi.stubEnv("VENTUREPASS_COMPARISON_EXECUTION_DATABASE_ID", "");
  expect(() => owner.cancel(f.consent)).toThrow(/CHANGED/);
  expect(owner.recover().status).toBe("recorded");
  expect(owner.close().status).toBe("closed");
});
it("cancellation HTTP retains one owner, projects no internal heads, requires consent and returns original close receipt", async () => {
  const f = setup(),
    action = { action: "open", selection: f.selection };
  await f.request(action);
  await f.request(action);
  expect(f.open).toHaveBeenCalledTimes(1);
  const review = await (await f.request({ action: "review" })).json();
  expect(review.review.runId).toBe(f.selection.runId);
  expect(JSON.stringify(review)).not.toMatch(/expectedBudgetHead|databaseInstanceId|studio.sqlite/);
  expect(
    (
      await f.request({
        action: "cancel",
        consent: { ...f.consent, cancelReservationAcknowledged: false },
      })
    ).status,
  ).toBe(400);
  expect(f.store.cancel).not.toHaveBeenCalled();
  expect(
    (await (await f.request({ action: "cancel", consent: f.consent })).json()).receipt.cancelled,
  ).toBe(true);
  await f.request({ action: "recover" });
  await f.request({ action: "close" });
  await f.request({ action: "close" });
  expect(f.store.cancel).toHaveBeenCalledTimes(1);
  expect(f.store.close).toHaveBeenCalledTimes(1);
});
it.each(["foreign", "oversize", "malformed", "policy", "other-company", "aborted"])(
  "cancellation HTTP blocks %s before owner acquisition",
  async (kind) => {
    const f = setup();
    let body: unknown = { action: "open", selection: f.selection };
    const init: RequestInit = {};
    if (kind === "foreign")
      init.headers = {
        origin: "https://foreign.invalid",
        "content-type": "application/json",
        "x-venturepass-comparison-cancellation": crypto.randomUUID(),
      };
    if (kind === "oversize") body = "x".repeat(8193);
    if (kind === "malformed") body = "{";
    if (kind === "policy") body = { ...(body as object), policy: {} };
    if (kind === "other-company")
      body = { action: "open", selection: { ...f.selection, companyId: crypto.randomUUID() } };
    if (kind === "aborted") init.signal = AbortSignal.abort();
    expect((await f.request(body, undefined, init)).status).toBeGreaterThanOrEqual(400);
    expect(f.open).not.toHaveBeenCalled();
  },
);
it("cancellation client is passive and recovers a lost write after reload without resending", async () => {
  const f = setup();
  expect(f.fetcher).not.toHaveBeenCalled();
  await f.client.review(f.company, f.selection);
  expect(f.client.getSnapshot().status?.review?.runId).toBe(f.selection.runId);
  f.lose();
  await f.client.cancel(f.company, f.consent);
  expect([...f.data.values()].join()).not.toMatch(/releasedUnits|notice|consent|reviewDigest/);
  const restored = createCancellationClient(f.storage, f.fetcher),
    count = f.fetcher.mock.calls.length;
  expect(f.fetcher).toHaveBeenCalledTimes(count);
  await restored.inspect();
  await restored.recover();
  expect(restored.getSnapshot().status?.receipt?.cancelled).toBe(true);
  await restored.cancel(f.company, f.consent);
  expect(f.store.cancel).toHaveBeenCalledTimes(1);
  await restored.close();
  expect(f.data.size).toBe(0);
});
it("missing cancellation owner guides persisted history without clearing or resending its attempted request", async () => {
  const f = setup();
  await f.client.review(f.company, f.selection);
  f.lose();
  await f.client.cancel(f.company, f.consent);
  const saved = [...f.data.entries()],
    fetcher = vi.fn(async () => Response.json({ code: "OWNER_UNAVAILABLE" }, { status: 404 }));
  const restored = createCancellationClient(f.storage, fetcher);
  await restored.inspect();
  expect(restored.getSnapshot().message).toContain("저장된 예약·취소 기록");
  expect(restored.getSnapshot().routing?.attempted).toBe(true);
  expect([...f.data.entries()]).toEqual(saved);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(f.store.cancel).toHaveBeenCalledTimes(1);
  expect(restored.getSnapshot().status?.receipt).toBeUndefined();
});
it.each(["invalidated", "snapshot", "storage", "expired", "missing-consent"])(
  "cancellation client %s prevents mutation",
  async (kind) => {
    const f = setup();
    await f.client.review(f.company, f.selection);
    if (kind === "invalidated") f.client.invalidate();
    if (kind === "storage")
      vi.spyOn(f.storage, "setItem").mockImplementation(() => {
        throw Error("quota");
      });
    if (kind === "expired") vi.setSystemTime("2100-01-01T00:00:00.000Z");
    await f.client.cancel(
      kind === "snapshot" ? structuredClone(f.company) : f.company,
      kind === "missing-consent"
        ? { ...f.consent, retainedEvidenceAcknowledged: false }
        : f.consent,
    );
    expect(f.store.cancel).not.toHaveBeenCalled();
  },
);

it("cancellation pins one request ID before consent and verifies storage before writing", async () => {
  const f = setup();
  await f.client.review(f.company, f.selection);
  const requestId = f.client.getSnapshot().status!.clientRequestId;
  expect(requestId).toEqual(expect.any(String));
  expect(f.store.cancel).not.toHaveBeenCalled();
  vi.spyOn(f.storage, "setItem").mockImplementationOnce(() => {});
  await f.client.cancel(f.company, f.consent);
  expect(f.store.cancel).not.toHaveBeenCalled();
  await f.client.review(f.company, f.selection);
  f.lose();
  const original = f.store.cancel.getMockImplementation()!;
  f.store.cancel.mockImplementation((command) => {
    const pending = JSON.parse([...f.data.values()][0]);
    expect(pending).toMatchObject({
      attempted: true,
      requestReference: { clientRequestId: requestId, runId: f.selection.runId },
    });
    return original(command);
  });
  await f.client.cancel(f.company, f.consent);
  expect(f.store.cancel).toHaveBeenCalledTimes(1);
  const command = f.store.cancel.mock.calls[0][0] as { clientRequestId: string };
  expect(command.clientRequestId).toBe(requestId);
  const saved = [...f.data.entries()];
  const restored = createCancellationClient(f.storage, async () =>
    Response.json({ code: "OWNER_UNAVAILABLE" }, { status: 404 }),
  );
  await restored.inspect();
  expect([...f.data.entries()]).toEqual(saved);
  await restored.cancel(f.company, f.consent);
  expect(f.store.cancel).toHaveBeenCalledTimes(1);
});
it("cancellation rejects an original-owner response with a different server nonce", async () => {
  const f = setup();
  await f.client.review(f.company, f.selection);
  f.lose();
  await f.client.cancel(f.company, f.consent);
  const forged = createCancellationClient(f.storage, async () =>
    Response.json({
      ...f.cancellation,
      registrationId: f.client.getSnapshot().routing!.registrationId,
      clientRequestId: crypto.randomUUID(),
    }),
  );
  await forged.inspect();
  expect(forged.getSnapshot().status).toBeNull();
  expect(forged.getSnapshot().routing?.attempted).toBe(true);
});
