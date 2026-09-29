import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProviderProductionView } from "@/lib/studio-plan-quality-provider-production-service-types";
import {
  qualityProviderProductionStatus,
  fetchProviderProductionStatus,
  productionStatusUrl,
  productionStatusResponseBytes,
} from "./quality-provider-production-ui";
import {
  QualityProviderProductionDetails,
  QualityProviderProductionPanel,
} from "./quality-provider-production-panel";

const selection = { runId: "11111111-1111-4111-8111-111111111111", runDigest: "a".repeat(64) };
const phase = (
  lastConfirmed: NonNullable<ProviderProductionView["generation"]>["lastConfirmed"],
  response: NonNullable<ProviderProductionView["generation"]>["response"] = "not-observed",
) => ({ lastConfirmed, response, failureStage: null, stopOutcome: null });
const approved = (): ProviderProductionView => ({
  viewVersion: 1,
  selection: { ...selection, approvalBindingDigest: "b".repeat(64) },
  status: "last-confirmed",
  reason: null,
  generation: phase("approved"),
  review: null,
  lastAuditedRevision: 1,
  lastAuditedBudget: "unsettled",
  recovery: "none",
  executionCompleted: false,
  automaticRetryAllowed: false,
});
const validated = (): ProviderProductionView => ({
  ...approved(),
  generation: phase("validated", "recorded"),
  review: phase("validated", "recorded"),
  lastAuditedRevision: 9,
  lastAuditedBudget: "settled",
});
const completed = (): ProviderProductionView => ({
  ...validated(),
  status: "completed",
  review: phase("completed", "recorded"),
  lastAuditedRevision: 10,
  executionCompleted: true,
});
const secret = "PRIVATE_BODY_NOT_FOR_BROWSER_ERROR";
const network = vi.fn<typeof fetch>(),
  storage = vi.fn(() => {
    throw Error("Browser persistence forbidden");
  });
beforeEach(() => {
  network.mockReset();
  storage.mockClear();
  vi.stubGlobal("fetch", network);
  vi.stubGlobal("localStorage", { getItem: storage, setItem: storage });
});
afterEach(() => {
  expect(storage).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it("makes one bounded no-store status request with only the two-field selection", async () => {
  network.mockResolvedValue(Response.json(completed()));
  const abort = new AbortController();
  expect(await fetchProviderProductionStatus(selection, 1, abort.signal)).toEqual(completed());
  expect(network).toHaveBeenCalledTimes(1);
  expect(network.mock.calls[0]).toEqual([
    productionStatusUrl,
    {
      method: "POST",
      cache: "no-store",
      redirect: "error",
      signal: abort.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(selection),
    },
  ]);
});

it("rejects stale/mismatched/extra private results and fabricated completion", () => {
  const mutations = [
    { ...completed(), selection: { ...completed().selection!, runDigest: "c".repeat(64) } },
    { ...completed(), pendingCapture: secret },
    { ...validated(), status: "completed", executionCompleted: true },
    { ...completed(), generation: null },
    { ...approved(), generation: { ...phase("approved"), response: "captured-not-confirmed" } },
  ];
  for (const raw of mutations)
    expect(() => qualityProviderProductionStatus(raw, selection, 1)).toThrow(/저장된 실행 기록/);
  expect(() => qualityProviderProductionStatus(approved(), selection, 5)).toThrow();
  expect(() => qualityProviderProductionStatus(validated(), selection, 10)).toThrow();
  expect(qualityProviderProductionStatus(completed(), selection, 1)).toEqual(completed());
});

it.each([
  "status",
  "content-type",
  "declared-size",
  "stream-size",
  "utf8",
  "json",
  "private-field",
])("rejects %s responses without a retry or a raw error", async (kind) => {
  let response: Response;
  if (kind === "status") response = Response.json({ error: secret }, { status: 500 });
  else if (kind === "content-type")
    response = new Response(secret, { headers: { "content-type": "text/html" } });
  else if (kind === "declared-size")
    response = Response.json(approved(), {
      headers: { "content-length": String(productionStatusResponseBytes + 1) },
    });
  else if (kind === "stream-size")
    response = new Response(" ".repeat(productionStatusResponseBytes + 1), {
      headers: { "content-type": "application/json" },
    });
  else if (kind === "utf8")
    response = new Response(new Uint8Array([0xff]), {
      headers: { "content-type": "application/json" },
    });
  else if (kind === "json")
    response = new Response(secret, { headers: { "content-type": "application/json" } });
  else response = Response.json({ ...approved(), raw: secret });
  network.mockResolvedValue(response);
  await expect(
    fetchProviderProductionStatus(selection, 1, new AbortController().signal),
  ).rejects.toThrow("저장된 실행 기록을 확인하지 못했습니다. 다시 조회해 주세요.");
  expect(network).toHaveBeenCalledTimes(1);
});

it("does not fetch invalid selections or already aborted reads, and discards a late aborted response", async () => {
  const abort = new AbortController();
  abort.abort();
  await expect(fetchProviderProductionStatus(selection, 1, abort.signal)).rejects.toThrow();
  await expect(
    fetchProviderProductionStatus(
      { ...selection, apiKey: secret } as typeof selection,
      1,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(network).not.toHaveBeenCalled();
  const current = new AbortController();
  network.mockImplementation(async () => {
    current.abort();
    return Response.json(approved());
  });
  await expect(fetchProviderProductionStatus(selection, 1, current.signal)).rejects.toThrow();
  expect(network).toHaveBeenCalledTimes(1);
});

it("renders validation as incomplete and completion only for the confirmed final result", () => {
  const partial = renderToStaticMarkup(
    createElement(QualityProviderProductionDetails, { value: validated() }),
  );
  expect(partial).toContain("최종 결과 저장 완료는 아직 확인되지 않았습니다");
  expect(partial).not.toContain("생성·검토 최종 결과 저장 완료");
  const final = renderToStaticMarkup(
    createElement(QualityProviderProductionDetails, { value: completed() }),
  );
  expect(final).toContain("생성·검토 최종 결과 저장 완료");
  expect(final).toContain("저장 기록 r10");
  expect(final).toContain("예약 정산 확인");
  expect(final).not.toContain("approvalBindingDigest");
});

it("renders unsettled/unobserved and stopped cost-review records without execution or retry controls", () => {
  const unobserved = {
    ...approved(),
    generation: phase("dispatch-recorded", "unobserved"),
    lastAuditedRevision: 3,
    recovery: "reconcile-before-continuing" as const,
  };
  const html = renderToStaticMarkup(
    createElement(QualityProviderProductionDetails, { value: unobserved }),
  );
  expect(html).toContain("응답 저장을 확인하지 못했습니다");
  expect(html).toContain("미정산 예약 남음");
  const stopped: ProviderProductionView = {
    ...unobserved,
    status: "stopped",
    generation: { ...phase("stopped", "recorded"), stopOutcome: "needs-cost-review" },
  };
  expect(
    renderToStaticMarkup(createElement(QualityProviderProductionDetails, { value: stopped })),
  ).toContain("사용 비용 확인 필요");
  const panel = renderToStaticMarkup(
    createElement(QualityProviderProductionPanel, {
      selection,
      minimumRevision: 1,
      disabled: true,
    }),
  );
  expect(panel).toContain("실행 기록 조회");
  expect(panel).toContain("disabled");
  expect(panel).not.toContain("재전송");
  expect(panel).not.toContain("실행 시작");
  expect(network).not.toHaveBeenCalled();
});
