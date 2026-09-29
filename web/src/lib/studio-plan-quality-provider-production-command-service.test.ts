import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  execute: vi.fn<(selection: unknown) => Promise<unknown>>(),
  recover: vi.fn<(selection: unknown) => unknown>(),
  forbidden: vi.fn(() => {
    throw Error("Unrequested runtime/store/network access");
  }),
}));
vi.mock("./studio-plan-quality-provider-production-server", () => ({
  executeProviderProductionSelection: state.execute,
  recoverProviderProductionSelection: state.recover,
  installProviderProductionServer: state.forbidden,
  retireProviderProductionServer: state.forbidden,
  inspectProviderProductionServer: state.forbidden,
}));
vi.mock("./studio-plan-quality-store", () => ({
  PlanQualityStore: state.forbidden,
  getPlanQualityStore: state.forbidden,
}));
vi.mock("openai", () => ({ default: state.forbidden }));
import { StudioError } from "./studio-http";
import {
  providerProductionViewSchema,
  type ProviderProductionView,
} from "./studio-plan-quality-provider-production-service-types";
import * as executeRoute from "@/app/api/studio/quality/provider-execution/execute/route";
import * as recoverRoute from "@/app/api/studio/quality/provider-execution/recover/route";

const selection = {
  runId: "11111111-1111-4111-8111-111111111111",
  runDigest: "a".repeat(64),
  approvalBindingDigest: "b".repeat(64),
};
const secret = "PRIVATE_RAW_KEY_ERROR_DO_NOT_RETURN";
function view(reason: ProviderProductionView["reason"] = null): ProviderProductionView {
  return {
    viewVersion: 1,
    selection,
    status: reason ? "unavailable" : "completed",
    reason,
    generation: reason
      ? null
      : { lastConfirmed: "validated", response: "recorded", failureStage: null, stopOutcome: null },
    review: reason
      ? null
      : { lastConfirmed: "completed", response: "recorded", failureStage: null, stopOutcome: null },
    lastAuditedRevision: reason ? null : 10,
    lastAuditedBudget: reason ? "unconfirmed" : "settled",
    recovery: reason ? "reconcile-before-continuing" : "none",
    executionCompleted: !reason,
    automaticRetryAllowed: false,
  };
}
async function safe(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store, private, max-age=0");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("retry-after")).toBeNull();
  const body = await response.text();
  expect(body).not.toContain(secret);
  return JSON.parse(body);
}
beforeEach(() => {
  state.execute.mockReset().mockResolvedValue(view());
  state.recover.mockReset().mockReturnValue(view());
  vi.stubGlobal("fetch", state.forbidden);
});
afterEach(() => {
  expect(state.forbidden).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe.each(["execute", "recover"] as const)("%s HTTP boundary", (action) => {
  const route = action === "execute" ? executeRoute : recoverRoute;
  const selected = action === "execute" ? state.execute : state.recover;
  const other = action === "execute" ? state.recover : state.execute;
  const base = `http://127.0.0.1:3000/api/studio/quality/provider-execution/${action}`;
  const post = (raw: unknown = selection, init: RequestInit = {}) =>
    new Request(base, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" },
      body: JSON.stringify(raw),
      ...init,
    });

  it("exposes only a dynamic Node POST and forwards the three approved fields exactly once", async () => {
    expect(Object.keys(route).sort()).toEqual(["POST", "dynamic", "runtime"]);
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
    const body = await safe(await route.POST(post()), 200);
    expect(providerProductionViewSchema.parse(body)).toEqual(view());
    expect(selected).toHaveBeenCalledTimes(1);
    expect(selected).toHaveBeenCalledWith(selection);
    expect(other).not.toHaveBeenCalled();
  });

  it("rejects local/origin/method/query/media/UTF-8/size violations before entering the owner", async () => {
    const cases: Array<[Request, number]> = [
      [new Request(base), 405],
      [post(selection, { method: "DELETE" }), 405],
      [new Request(base.replace("127.0.0.1", "foreign.invalid"), { method: "POST" }), 403],
      [
        post(selection, {
          headers: { "content-type": "application/json", host: "foreign.invalid" },
        }),
        403,
      ],
      [
        post(selection, {
          headers: { "content-type": "application/json", host: "127.0.0.1:3001" },
        }),
        403,
      ],
      [
        post(selection, {
          headers: { "content-type": "application/json", origin: "https://foreign.invalid" },
        }),
        403,
      ],
      [
        post(selection, {
          headers: { "content-type": "application/json", "x-forwarded-host": "foreign.invalid" },
        }),
        403,
      ],
      [
        post(selection, {
          headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
        }),
        403,
      ],
      [new Request(base + "?action=execute", { method: "POST" }), 400],
      [post(selection, { headers: { "content-type": "text/plain" } }), 415],
      [post(selection, { headers: { "content-type": "application/jsonp" } }), 415],
      [post(selection, { headers: {} }), 415],
      [post(selection, { body: "{" }), 400],
      [post(selection, { body: "" }), 400],
      [post(selection, { body: new Uint8Array([0xff]) }), 400],
      [
        post(selection, {
          headers: { "content-type": "application/json", "content-length": "4097" },
        }),
        413,
      ],
      [
        post(selection, {
          headers: { "content-type": "application/json", "content-length": "-1" },
        }),
        413,
      ],
      [
        post(selection, {
          headers: { "content-type": "application/json", "content-length": "1" },
          body: " ".repeat(4097),
        }),
        413,
      ],
    ];
    for (const [request, status] of cases) {
      const response = await route.POST(request);
      if (status === 405) expect(response.headers.get("allow")).toBe("POST");
      await safe(response, status);
    }
    expect(selected).not.toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
  });

  it.each([
    "action",
    "runtime",
    "apiKey",
    "model",
    "fetch",
    "directory",
    "signal",
    "response",
    "pendingCapture",
    "preparedRequestId",
    "dispatchRequestId",
    "expectedRevision",
  ])("rejects client %s as an extra command field", async (field) => {
    expect(
      await safe(await route.POST(post({ ...selection, [field]: secret })), 400),
    ).toMatchObject({ code: "INVALID_INPUT" });
    expect(selected).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [],
    {},
    { runId: selection.runId, runDigest: selection.runDigest },
    { ...selection, runId: "invalid" },
    { ...selection, approvalBindingDigest: "short" },
  ])("rejects an incomplete/invalid approval selection (%#)", async (raw) => {
    await safe(await route.POST(post(raw)), 400);
    expect(selected).not.toHaveBeenCalled();
  });

  it("cancels an oversized streaming body without admitting an operation", async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(2048));
        controller.enqueue(new Uint8Array(2049));
      },
      cancel: cancelled,
    });
    const request = post(selection, { body, duplex: "half" } as RequestInit);
    await safe(await route.POST(request), 413);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(selected).not.toHaveBeenCalled();
  });

  it("rejects abort before dispatch, including one observed while reading the body", async () => {
    const before = new AbortController();
    before.abort();
    expect(
      await safe(await route.POST(post(selection, { signal: before.signal })), 409),
    ).toMatchObject({ code: "REQUEST_ABORTED" });
    const during = new AbortController();
    const body = new ReadableStream({
      pull(controller) {
        during.abort();
        controller.enqueue(new TextEncoder().encode(JSON.stringify(selection)));
        controller.close();
      },
    });
    expect(
      await safe(
        await route.POST(
          post(selection, { signal: during.signal, body, duplex: "half" } as RequestInit),
        ),
        409,
      ),
    ).toMatchObject({ code: "REQUEST_ABORTED" });
    expect(selected).not.toHaveBeenCalled();
  });

  it("sanitizes stream exceptions instead of echoing their messages/status codes", async () => {
    for (const code of [secret, "TOO_LARGE"]) {
      const body = new ReadableStream({
        start(controller) {
          controller.error(new StudioError(secret, 418, code));
        },
      });
      await safe(
        await route.POST(post(selection, { body, duplex: "half" } as RequestInit)),
        code === "TOO_LARGE" ? 413 : 400,
      );
    }
    expect(selected).not.toHaveBeenCalled();
  });

  it.each([
    "runId",
    "runDigest",
    "approvalBindingDigest",
    "null-selection",
    "raw",
    "phase-raw",
    "completion",
    "retry",
  ])("rejects %s output corruption before serialization", async (kind) => {
    const changed: Record<string, unknown> = structuredClone(view());
    if (kind === "null-selection") changed.selection = null;
    else if (kind === "raw") changed.pendingCapture = secret;
    else if (kind === "phase-raw")
      changed.generation = { ...view().generation, responseBody: secret };
    else if (kind === "completion") changed.executionCompleted = false;
    else if (kind === "retry") changed.automaticRetryAllowed = true;
    else
      changed.selection = {
        ...selection,
        [kind]: kind === "runId" ? "22222222-2222-4222-8222-222222222222" : "c".repeat(64),
      };
    if (action === "execute") state.execute.mockResolvedValue(changed);
    else state.recover.mockReturnValue(changed);
    expect(await safe(await route.POST(post()), 500)).toMatchObject({
      code: "PROVIDER_PRODUCTION_COMMAND_UNAVAILABLE",
    });
    expect(other).not.toHaveBeenCalled();
  });

  it.each([
    "execution-unavailable",
    "execution-in-progress",
    "recovery-capacity-full",
    "capture-not-retained",
  ] as const)("returns the safe %s view without suggesting a retry", async (reason) => {
    if (action === "execute") state.execute.mockResolvedValue(view(reason));
    else state.recover.mockReturnValue(view(reason));
    expect(
      await safe(await route.POST(post()), reason === "execution-unavailable" ? 503 : 409),
    ).toEqual(view(reason));
    expect(other).not.toHaveBeenCalled();
  });

  it("sanitizes command exceptions even if typed as input or SDK errors", async () => {
    for (const error of [
      Error(secret),
      new StudioError(secret, 418, secret),
      new StudioError(secret, 403, "LOCAL_ONLY"),
      new TypeError(secret),
    ]) {
      selected.mockImplementation(() => {
        throw error;
      });
      expect(await safe(await route.POST(post()), 500)).toMatchObject({
        code: "PROVIDER_PRODUCTION_COMMAND_UNAVAILABLE",
      });
    }
  });
});

it("does not detach, cancel, recover or retry an admitted execution when the HTTP request aborts", async () => {
  let started!: () => void, finish!: (result: ProviderProductionView) => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  state.execute.mockImplementation(() => {
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const abort = new AbortController();
  const response = executeRoute.POST(
    new Request("http://127.0.0.1:3000/api/studio/quality/provider-execution/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(selection),
      signal: abort.signal,
    }),
  );
  await began;
  abort.abort();
  finish(view());
  expect(await safe(await response, 200)).toEqual(view());
  expect(state.execute).toHaveBeenCalledTimes(1);
  expect(state.execute).toHaveBeenCalledWith(selection);
  expect(state.recover).not.toHaveBeenCalled();
});
