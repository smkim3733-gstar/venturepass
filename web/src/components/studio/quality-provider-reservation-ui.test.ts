import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, afterAll, afterEach, expect, it, vi } from "vitest";
import { PlanQualityStore } from "@/lib/studio-plan-quality-store";
import { actualTestNow } from "@/lib/studio-plan-quality-actual-test-helpers";
import { policyAdoptionFixture } from "@/lib/studio-plan-quality-provider-policy-adoption-test-helpers";
import type { CandidateRegistrySnapshot } from "@/lib/studio-plan-quality-candidate-registry-types";
import type { ProviderReservationInspectionResponse } from "@/lib/studio-plan-quality-provider-reservation-http-types";
import { providerReservationReviewDigestInput } from "@/lib/studio-plan-quality-provider-reservation-review-types";
import { providerPolicyReviewDigestInput } from "@/lib/studio-plan-quality-provider-policy-review-types";
import { providerDigest as digest } from "../../../scripts/local-data-quality-provider.mjs";
import {
  qualityProviderReservationInspection as inspect,
  qualityProviderReservationArchive as archive,
  fetchProviderReservationInspection as fetchReview,
  reservationResponseBytes,
  reservationInspectUrl,
} from "./quality-provider-reservation-ui";
import { QualityProviderReservationDetails } from "./quality-provider-reservation-panel";
import { QualityProviderReservationApprovalForm } from "./quality-provider-reservation-command-panel";

vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("External access forbidden");
  }),
);
vi.mock("openai", () => ({
  default: class {
    constructor() {
      forbidden();
    }
  },
}));
vi.mock("@/lib/studio-storage", () => ({ getStudioStore: forbidden, StudioStore: forbidden }));
type ReviewResponse = Extract<ProviderReservationInspectionResponse, { status: "review" }>;
let directory: string,
  store: PlanQualityStore,
  registry: CandidateRegistrySnapshot,
  empty: ReviewResponse,
  matched: ReviewResponse;
const candidate = () => registry.entries[0].candidateId;
it.each(["matched", "blocked", "disabled"])(
  "requires all six explicit confirmations for %s review",
  (kind) => {
    const html = renderToStaticMarkup(
      createElement(QualityProviderReservationApprovalForm, {
        view: kind === "blocked" ? empty : matched,
        disabled: kind === "disabled",
        onApprove: () => {
          throw new Error("No implicit approval");
        },
      }),
    );
    expect(html.match(/type="checkbox"/g) ?? []).toHaveLength(6);
    expect(html).not.toMatch(/checked=/);
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).toContain("후보 한 건 비용 예약");
    expect(html).toContain("AI 전송은 별도 승인");
    if (kind !== "matched")
      expect(html.match(/type="checkbox"[^>]*disabled/g) ?? []).toHaveLength(6);
  },
);
const unavailable = (
  reason: Extract<ProviderReservationInspectionResponse, { status: "unavailable" }>["reason"],
): ProviderReservationInspectionResponse => ({
  responseVersion: 1,
  selection: matched.selection,
  status: "unavailable",
  reason,
  review: null,
});
const getReview = () => {
  const selection = { version: 1, versionDigest: registry.versionDigest, candidateId: candidate() };
  const result = store.providerReservationReview(selection);
  if (result.status !== "review") throw new Error("fixture");
  return { responseVersion: 1 as const, selection, ...result };
};
const reseal = (value: ReviewResponse) => {
  value.review.policyReview.reviewDigest = digest(
    providerPolicyReviewDigestInput(value.review.policyReview),
  );
  value.review.reviewDigest = digest(providerReservationReviewDigestInput(value.review));
  return value;
};
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", () => forbidden());
  directory = mkdtempSync(join(tmpdir(), "venture-reservation-browser-"));
  store = new PlanQualityStore(directory);
  registry = store.candidateRegistryRegister({
    expectedVersion: 0,
    clientRequestId: randomUUID(),
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  }).snapshot;
  empty = getReview();
  const fixture = policyAdoptionFixture(store);
  store.providerPolicyAdopt(fixture.command, fixture.review);
  matched = getReview();
}, 15000);
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.setSystemTime(actualTestNow);
});
afterAll(() => {
  store.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  const rel = relative(resolve(tmpdir()), resolve(directory));
  if (!rel.startsWith("venture-reservation-browser-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});
it("validates blocked and matched server reviews with both digests and full candidate scope", async () => {
  expect(await inspect(empty, registry, candidate())).toEqual(empty);
  expect(await inspect(matched, registry, candidate())).toEqual(matched);
});
it("downloads the complete validated envelope without changing its contents", async () => {
  const result = await archive(matched, registry, candidate());
  expect(JSON.parse(result.text)).toEqual(matched);
  expect(result.filename).toContain(candidate());
});
it.each([
  "configuration-missing-or-invalid",
  "configuration-expired",
  "selection-invalid",
  "ledger-after-inspection",
] as const)("validates and displays %s without inventing a review", async (reason) => {
  const value = unavailable(reason);
  expect(await inspect(value, registry, candidate())).toEqual(value);
  expect(JSON.parse((await archive(value, registry, candidate())).text).review).toBe(null);
  const html = renderToStaticMarkup(
    createElement(QualityProviderReservationDetails, { value, expired: false }),
  );
  expect(html).toContain('role="status"');
  expect(html).not.toContain("예약 검토 조건 충족");
});
it.each(["selection", "registry", "candidate", "label", "source", "manifest", "model-input"])(
  "rejects a changed %s binding even with resealed review digests",
  async (kind) => {
    const value = structuredClone(matched),
      changedRegistry = structuredClone(registry);
    if (kind === "selection") value.selection.versionDigest = "a".repeat(64);
    if (kind === "registry") changedRegistry.versionDigest = "a".repeat(64);
    if (kind === "candidate")
      value.review.policyReview.scope.candidateId = registry.entries[1].candidateId;
    if (kind === "label") value.review.policyReview.scope.label += " changed";
    if (kind === "source") value.review.policyReview.scope.sourceDigest = "a".repeat(64);
    if (kind === "manifest") value.review.policyReview.scope.manifestDigest = "a".repeat(64);
    if (kind === "model-input") value.review.policyReview.scope.modelInputDigest = "a".repeat(64);
    await expect(inspect(reseal(value), changedRegistry, candidate())).rejects.toThrow();
  },
);
it.each(["outer", "inner", "permission", "extra", "arithmetic"])(
  "rejects %s corruption",
  async (kind) => {
    const value = structuredClone(matched);
    if (kind === "outer") value.review.reviewDigest = "a".repeat(64);
    if (kind === "inner") {
      value.review.policyReview.bindings.model = "changed-model";
      value.review.reviewDigest = digest(providerReservationReviewDigestInput(value.review));
    }
    if (kind === "permission") Object.assign(value.review.actions, { dispatchAllowed: true });
    if (kind === "extra") Object.assign(value, { reservationAllowed: true });
    if (kind === "arithmetic") {
      value.review.policyReview.budget.availableUnits = "1";
      reseal(value);
    }
    await expect(inspect(value, registry, candidate())).rejects.toThrow();
  },
);
it("rejects a live expired review but preserves a clearly historical downloadable copy", async () => {
  vi.setSystemTime(matched.review.policyReview.expiresAt);
  await expect(inspect(matched, registry, candidate())).rejects.toThrow();
  expect(JSON.parse((await archive(matched, registry, candidate())).text)).toEqual(matched);
  expect(
    renderToStaticMarkup(
      createElement(QualityProviderReservationDetails, { value: matched, expired: true }),
    ),
  ).toContain("기한 경과");
});
it.each(["future", "excessive-lifetime"])(
  "rejects %s timestamps even when resealed",
  async (kind) => {
    const value = structuredClone(matched);
    if (kind === "future") value.review.policyReview.inspectedAt = "2026-09-27T03:01:00.000Z";
    else value.review.policyReview.expiresAt = "2026-09-27T03:16:00.000Z";
    await expect(inspect(reseal(value), registry, candidate())).rejects.toThrow();
  },
);
it("shows budget, policy reference, counts and separate approval without an execution button", () => {
  const html = renderToStaticMarkup(
    createElement(QualityProviderReservationDetails, { value: matched, expired: false }),
  );
  for (const text of [
    "별도 예약 필요",
    "현재 가용액",
    "전체 실행 기록",
    "현재 예산 기록",
    "재확인 기한",
    "예약이나 전송 승인을 뜻하지 않습니다",
  ])
    expect(html).toContain(text);
  expect(html).not.toContain("<button");
  const blocked = renderToStaticMarkup(
    createElement(QualityProviderReservationDetails, { value: empty, expired: false }),
  );
  expect(blocked).toContain("정책을 먼저 채택");
  expect(blocked).toContain("예산이 아직 설정되지");
});
it("posts only the candidate selection with no-store and an abort signal", async () => {
  const mock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json(matched));
  const signal = new AbortController().signal;
  expect(await fetchReview(registry, candidate(), signal)).toEqual(matched);
  expect(mock).toHaveBeenCalledWith(
    reservationInspectUrl,
    expect.objectContaining({
      method: "POST",
      cache: "no-store",
      signal,
      body: JSON.stringify(matched.selection),
    }),
  );
});
it.each([
  "configuration-missing-or-invalid",
  "configuration-expired",
  "selection-invalid",
  "ledger-after-inspection",
] as const)("accepts the correct HTTP status for %s", async (reason) => {
  const value = unavailable(reason),
    status = ["selection-invalid", "ledger-after-inspection"].includes(reason) ? 409 : 200;
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json(value, { status }));
  expect(await fetchReview(registry, candidate(), new AbortController().signal)).toEqual(value);
});
it.each([
  "wrong-status",
  "conflict-review",
  "server-error",
  "html",
  "oversized",
  "declared-size",
  "utf8",
  "json",
  "network",
])("rejects %s responses", async (kind) => {
  let response = Response.json(
    kind === "wrong-status" ? unavailable("selection-invalid") : matched,
    { status: kind === "conflict-review" ? 409 : kind === "server-error" ? 500 : 200 },
  );
  if (kind === "html")
    response = new Response("<html/>", { headers: { "content-type": "text/html" } });
  if (kind === "oversized")
    response = new Response(" ".repeat(reservationResponseBytes + 1), {
      headers: { "content-type": "application/json" },
    });
  if (kind === "declared-size")
    response.headers.set("content-length", String(reservationResponseBytes + 1));
  if (kind === "utf8")
    response = new Response(new Uint8Array([0xff]), {
      headers: { "content-type": "application/json" },
    });
  if (kind === "json")
    response = new Response("{", { headers: { "content-type": "application/json" } });
  const mock = vi.spyOn(globalThis, "fetch");
  if (kind === "network") mock.mockRejectedValueOnce(new Error("synthetic"));
  else mock.mockResolvedValueOnce(response);
  await expect(fetchReview(registry, candidate(), new AbortController().signal)).rejects.toThrow();
});
