import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProviderProductionView } from "@/lib/studio-plan-quality-provider-production-service-types";
import {
  canStartProviderProduction,
  fetchProviderProductionCommand,
  productionCommandError,
  type ProductionAction,
} from "./quality-provider-production-command-ui";
import { QualityProviderProductionDetails } from "./quality-provider-production-panel";

const selection = {
  runId: "11111111-1111-4111-8111-111111111111",
  runDigest: "a".repeat(64),
  approvalBindingDigest: "b".repeat(64),
};
const approved = (): ProviderProductionView => ({
  viewVersion: 1,
  selection,
  status: "last-confirmed",
  reason: null,
  generation: {
    lastConfirmed: "approved",
    response: "not-observed",
    failureStage: null,
    stopOutcome: null,
  },
  review: null,
  lastAuditedRevision: 1,
  lastAuditedBudget: "unsettled",
  recovery: "none",
  executionCompleted: false,
  automaticRetryAllowed: false,
});
const pending = (): ProviderProductionView => ({
  ...approved(),
  status: "capture-recovery-required",
  recovery: "server-capture",
  generation: {
    ...approved().generation!,
    lastConfirmed: "dispatch-recorded",
    response: "captured-not-confirmed",
  },
  lastAuditedRevision: null,
  lastAuditedBudget: "unconfirmed",
});
const unavailable = (reason: ProviderProductionView["reason"]): ProviderProductionView => ({
  ...approved(),
  status: "unavailable",
  reason,
  generation: null,
  lastAuditedRevision: null,
  lastAuditedBudget: "unconfirmed",
  recovery: "reconcile-before-continuing",
});
const network = vi.fn<typeof fetch>();
const storage = vi.fn(() => {
  throw Error("No browser persistence");
});
const secret = "PRIVATE_PROVIDER_ERROR_NEVER_RENDER";
beforeEach(() => {
  network.mockReset();
  storage.mockClear();
  vi.stubGlobal("fetch", network);
  vi.stubGlobal("localStorage", { getItem: storage, setItem: storage });
  vi.stubGlobal("sessionStorage", { getItem: storage, setItem: storage });
});
afterEach(() => {
  expect(storage).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
const call = (
  action: ProductionAction = "execute",
  floor = 1,
  signal = new AbortController().signal,
) => fetchProviderProductionCommand(action, selection, floor, signal);

it.each(["execute", "recover"] as const)(
  "posts exactly one %s with the original three-field selection",
  async (action) => {
    network.mockResolvedValue(Response.json(pending()));
    const signal = new AbortController().signal;
    expect(await call(action, 1, signal)).toEqual(pending());
    expect(network.mock.calls).toEqual([
      [
        `/api/studio/quality/provider-execution/${action}`,
        {
          method: "POST",
          cache: "no-store",
          redirect: "error",
          signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(selection),
        },
      ],
    ]);
  },
);

it.each([
  "execution-unavailable",
  "execution-in-progress",
  "recovery-capacity-full",
  "capture-not-retained",
] as const)("accepts the typed %s view only with its corresponding HTTP status", async (reason) => {
  const status = reason === "execution-unavailable" ? 503 : 409;
  network.mockResolvedValueOnce(Response.json(unavailable(reason), { status }));
  expect(await call()).toEqual(unavailable(reason));
  network.mockResolvedValueOnce(Response.json(unavailable(reason), { status: 200 }));
  await expect(call()).rejects.toThrow(productionCommandError);
  expect(network).toHaveBeenCalledTimes(2);
});

it.each(["runId", "runDigest", "approvalBindingDigest"] as const)(
  "rejects another %s even when the rest of the result is valid",
  async (key) => {
    network.mockResolvedValue(
      Response.json({
        ...pending(),
        selection: {
          ...selection,
          [key]: key === "runId" ? "22222222-2222-4222-8222-222222222222" : "c".repeat(64),
        },
      }),
    );
    await expect(call()).rejects.toThrow(productionCommandError);
    expect(network).toHaveBeenCalledTimes(1);
  },
);

it.each([
  "network",
  "body-error",
  "status",
  "error-object-409",
  "media",
  "declared-size",
  "declared-invalid",
  "stream-size",
  "utf8",
  "json",
  "private-field",
  "stale",
  "fake-completion",
  "retry",
  "invalid-selection",
])("rejects %s without exposing raw errors or retrying", async (kind) => {
  let response = Response.json(approved());
  if (kind === "network") network.mockRejectedValue(Error(secret));
  else {
    if (kind === "body-error")
      response = new Response(
        new ReadableStream({
          start(controller) {
            controller.error(Error(secret));
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    if (kind === "status" || kind === "error-object-409")
      response = Response.json({ error: secret }, { status: kind === "status" ? 500 : 409 });
    if (kind === "media") response = new Response(secret);
    if (kind === "declared-size" || kind === "declared-invalid")
      response = Response.json(approved(), {
        headers: { "content-length": kind === "declared-size" ? "16385" : "garbage" },
      });
    if (kind === "stream-size")
      response = new Response(" ".repeat(16385), {
        headers: { "content-type": "application/json" },
      });
    if (kind === "utf8")
      response = new Response(new Uint8Array([255]), {
        headers: { "content-type": "application/json" },
      });
    if (kind === "json")
      response = new Response(secret, { headers: { "content-type": "application/json" } });
    if (kind === "private-field")
      response = Response.json({ ...pending(), pendingCapture: secret });
    if (kind === "fake-completion")
      response = Response.json({ ...approved(), status: "completed", executionCompleted: true });
    if (kind === "retry") response = Response.json({ ...pending(), automaticRetryAllowed: true });
    if (kind === "invalid-selection")
      response = Response.json(unavailable("invalid-selection"), { status: 409 });
    network.mockResolvedValue(response);
  }
  await expect(call("execute", kind === "stale" ? 5 : 1)).rejects.toThrow(productionCommandError);
  expect(network).toHaveBeenCalledTimes(1);
});

it("rejects invalid input/pre-abort before fetching and late aborted responses after fetching", async () => {
  const aborted = new AbortController();
  aborted.abort();
  await expect(call("execute", 1, aborted.signal)).rejects.toThrow(productionCommandError);
  await expect(call("execute", 0)).rejects.toThrow(productionCommandError);
  await expect(call("install" as ProductionAction)).rejects.toThrow(productionCommandError);
  await expect(
    fetchProviderProductionCommand(
      "execute",
      { ...selection, raw: secret } as typeof selection,
      1,
      new AbortController().signal,
    ),
  ).rejects.toThrow(productionCommandError);
  expect(network).not.toHaveBeenCalled();
  const late = new AbortController();
  network.mockImplementation(async () => {
    late.abort();
    return Response.json(pending());
  });
  await expect(call("recover", 1, late.signal)).rejects.toThrow(productionCommandError);
  expect(network).toHaveBeenCalledTimes(1);
});

it("offers new paid execution only at approved r1 or generation-validated r5", () => {
  const r5: ProviderProductionView = {
    ...approved(),
    lastAuditedRevision: 5,
    generation: { ...approved().generation!, lastConfirmed: "validated", response: "recorded" },
  };
  expect(canStartProviderProduction(approved())).toBe(true);
  expect(canStartProviderProduction(r5)).toBe(true);
  for (const view of [
    pending(),
    unavailable("execution-unavailable"),
    { ...approved(), lastAuditedRevision: 3 },
    { ...r5, recovery: "reconcile-before-continuing" as const },
    { ...r5, review: r5.generation },
    { ...r5, reason: "capture-recovery-unconfirmed" as const },
    { ...r5, status: "stopped" as const },
  ])
    expect(canStartProviderProduction(view)).toBe(false);
});

it("renders unknown and retained-capture results without invented completion or revision", () => {
  const html = renderToStaticMarkup(
    createElement(QualityProviderProductionDetails, { value: pending() }),
  );
  expect(html).toContain("보관된 응답의 저장 확인 필요");
  expect(html).toContain("확인된 저장 시점 없음");
  expect(html).not.toContain("rnull");
  expect(html).not.toContain("생성·검토 최종 결과 저장 완료");
  expect(html).not.toContain("approvalBindingDigest");
  expect(
    renderToStaticMarkup(
      createElement(QualityProviderProductionDetails, {
        value: unavailable("capture-not-retained"),
      }),
    ),
  ).toContain("원래 전송의 응답과 비용을 확인");
});
