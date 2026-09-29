import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, afterAll, afterEach, expect, it, vi } from "vitest";
import { PlanQualityStore } from "@/lib/studio-plan-quality-store";
import { actualTestNow } from "@/lib/studio-plan-quality-actual-test-helpers";
import {
  adoptReservationTestPolicy,
  reservationStoreFixture,
} from "@/lib/studio-plan-quality-provider-reservation-store-test-helpers";
import type { CandidateRegistrySnapshot } from "@/lib/studio-plan-quality-candidate-registry-types";
import type { ProviderSnapshot } from "@/lib/studio-plan-quality-provider-types";
import type { ProviderTransmissionInspectionResponse } from "@/lib/studio-plan-quality-provider-transmission-http-types";
import { providerTransmissionReviewDigestInput } from "@/lib/studio-plan-quality-provider-transmission-review-types";
import { providerDigest as digest } from "../../../scripts/local-data-quality-provider.mjs";
import {
  qualityProviderTransmissionInspection as inspect,
  qualityProviderTransmissionArchive as archive,
  fetchProviderTransmissionInspection as fetchReview,
  transmissionResponseBytes,
  transmissionInspectUrl,
} from "./quality-provider-transmission-ui";
import {
  QualityProviderTransmissionDetails,
  QualityProviderTransmissionPanel,
} from "./quality-provider-transmission-panel";
import {
  QualityProviderTransmissionApprovalForm,
  QualityProviderTransmissionCommandPanel,
} from "./quality-provider-transmission-command-panel";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("External IO forbidden");
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
type Review = Extract<ProviderTransmissionInspectionResponse, { status: "review" }>;
let directory: string,
  store: PlanQualityStore,
  registry: CandidateRegistrySnapshot,
  snapshot: ProviderSnapshot,
  matched: Review,
  blocked: Review;
const reseal = (value: Review) => {
  value.review.reviewDigest = digest(providerTransmissionReviewDigestInput(value.review));
  return value;
};
const unavailable = (
  reason: Extract<ProviderTransmissionInspectionResponse, { status: "unavailable" }>["reason"],
): ProviderTransmissionInspectionResponse => ({
  responseVersion: 1,
  selection: matched.selection,
  status: "unavailable",
  reason,
  review: null,
});
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", () => forbidden());
  directory = mkdtempSync(join(tmpdir(), "venture-transmission-browser-"));
  store = new PlanQualityStore(directory);
  registry = store.candidateRegistryRegister({
    expectedVersion: 0,
    clientRequestId: randomUUID(),
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  }).snapshot;
  adoptReservationTestPolicy(store);
  const input = reservationStoreFixture(store),
    saved = store.providerReserve(input.command, input.review);
  snapshot = store.providerGet(saved.record.runId);
  const selection = { runId: snapshot.run.id, runDigest: snapshot.run.runDigest };
  const result = store.providerTransmissionReview(selection);
  if (result.status !== "review") throw new Error(result.reason);
  matched = { responseVersion: 1, selection, ...result };
  adoptReservationTestPolicy(store);
  const next = store.providerTransmissionReview(selection);
  if (next.status !== "review") throw new Error(next.reason);
  blocked = { responseVersion: 1, selection, ...next };
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
  if (!rel.startsWith("venture-transmission-browser-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});
it("validates current and blocked reviews against the immutable selected reservation", async () => {
  expect(await inspect(matched, registry, snapshot)).toEqual(matched);
  expect(await inspect(blocked, registry, snapshot)).toEqual(blocked);
});
it("requires six fresh confirmations and displays the exact scope, amount and retention notice", () => {
  const approve = vi.fn();
  const html = renderToStaticMarkup(
    createElement(QualityProviderTransmissionApprovalForm, {
      view: matched,
      disabled: false,
      onApprove: approve,
    }),
  );
  expect(html.match(/type="checkbox"/g)).toHaveLength(6);
  expect(html).not.toContain('checked=""');
  expect(html).toMatch(/<button[^>]*disabled=""/);
  for (const text of [
    matched.review.scope.label,
    matched.review.request.model,
    matched.review.run.id,
    matched.review.retention.notice,
    matched.review.retention.sourceUrl,
    "OpenAI로 외부 전송",
    "생성 1회·검토 1회",
    "실제 토큰 적합성",
    "자동 재시도에 동의하지",
    "이번 승인으로 예산을 변경하지",
    "승인 기록만 저장",
  ])
    expect(html).toContain(text);
  expect(approve).not.toHaveBeenCalled();
});
it.each(["blocked", "disabled"])("locks all confirmations for a %s review", (kind) => {
  const html = renderToStaticMarkup(
    createElement(QualityProviderTransmissionApprovalForm, {
      view: kind === "blocked" ? blocked : matched,
      disabled: kind === "disabled",
      onApprove: vi.fn(),
    }),
  );
  expect(html.match(/disabled=""/g)).toHaveLength(7);
  if (kind === "blocked") expect(html).toContain("보완 사항을 먼저 확인");
});
it("requires browser journal initialization before exposing new approval controls", () => {
  const html = renderToStaticMarkup(
    createElement(QualityProviderTransmissionCommandPanel, {
      registry,
      snapshot,
      view: matched,
    }),
  );
  expect(html).toContain("보관한 요청을 확인하고 있습니다");
  expect(html).not.toContain('type="checkbox"');
  expect(
    renderToStaticMarkup(
      createElement(QualityProviderTransmissionCommandPanel, {
        registry: null,
        snapshot: null,
        view: null,
      }),
    ),
  ).toBe("");
});
it("archives the complete verified envelope without mutation or current approval claims", async () => {
  const before = JSON.stringify(matched),
    result = await archive(matched, registry, snapshot);
  expect(JSON.parse(result.text)).toEqual(matched);
  expect(JSON.stringify(matched)).toBe(before);
  expect(result.filename).toContain(snapshot.run.id);
});
it.each([
  "configuration-missing-or-invalid",
  "configuration-expired",
  "configuration-changed",
  "selection-invalid",
  "archive-after-inspection",
  "production-reservation-required",
  "reservation-binding-required",
  "reservation-expired",
  "preparation-changed",
] as const)("displays %s without inventing a review", async (reason) => {
  const value = unavailable(reason);
  expect(await inspect(value, registry, snapshot)).toEqual(value);
  expect(JSON.parse((await archive(value, registry, snapshot)).text).review).toBe(null);
  const html = renderToStaticMarkup(
    createElement(QualityProviderTransmissionDetails, { value, expired: false }),
  );
  expect(html).toContain('role="status"');
  expect(html).not.toContain("검토 조건 충족");
});
it.each([
  "selection-id",
  "selection-digest",
  "registry",
  "snapshot",
  "label",
  "source",
  "manifest-scope",
  "request",
  "financial",
  "retention",
  "preparation",
  "reservation",
  "manifest",
  "execution",
  "usage",
  "permission",
  "digest",
])("rejects %s mismatch even with a recomputed outer digest", async (kind) => {
  const v = structuredClone(matched),
    reg = structuredClone(registry),
    snap = structuredClone(snapshot);
  if (kind === "selection-id") v.selection.runId = randomUUID();
  if (kind === "selection-digest") v.selection.runDigest = "a".repeat(64);
  if (kind === "registry") reg.versionDigest = "a".repeat(64);
  if (kind === "snapshot") snap.snapshotDigest = "a".repeat(64);
  if (kind === "label") v.review.scope.label += " changed";
  if (kind === "source") v.review.scope.registrySourceDigest = "a".repeat(64);
  if (kind === "manifest-scope") v.review.scope.manifestDigest = "a".repeat(64);
  if (kind === "request") v.review.request.generation.body.input[1].content += " changed";
  if (kind === "financial")
    v.review.financialBasis.evidence.context.authority.excerpt += " changed";
  if (kind === "retention") v.review.retention.notice += " changed";
  if (kind === "preparation")
    v.review.run.preparationDigest = v.review.manifest.preparationDigest = "a".repeat(64);
  if (kind === "reservation") v.review.reservation.reservationDigest = "a".repeat(64);
  if (kind === "manifest") v.review.manifest.manifestDigest = "a".repeat(64);
  if (kind === "execution") v.review.manifest.executionContract.contractDigest = "a".repeat(64);
  if (kind === "usage") v.review.manifest.executionContract.usagePolicyDigest = "a".repeat(64);
  if (kind === "permission") Object.assign(v.review.actions, { approvalWriteAllowed: true });
  reseal(v);
  if (kind === "digest") v.review.reviewDigest = "a".repeat(64);
  await expect(inspect(v, reg, snap)).rejects.toThrow();
});
it("rejects future inspection times and permits expired downloads only as historical copies", async () => {
  vi.setSystemTime(Date.parse(actualTestNow) - 1);
  await expect(inspect(matched, registry, snapshot)).rejects.toThrow();
  vi.setSystemTime(matched.review.expiresAt);
  await expect(inspect(matched, registry, snapshot)).rejects.toThrow();
  expect(JSON.parse((await archive(matched, registry, snapshot)).text)).toEqual(matched);
});
it("labels current/blocked/expired details and contains no consent or dispatch controls", () => {
  const html = renderToStaticMarkup(
    createElement(QualityProviderTransmissionDetails, { value: matched, expired: false }),
  );
  expect(html).toContain("별도 승인 필요");
  expect(html).toContain("현재 가용액");
  expect(html).toContain("이미 예약한 금액");
  expect(html).toContain("검토 요청의 고정 문맥");
  expect(html).not.toContain('type="checkbox"');
  expect(html).not.toContain("<button");
  const stale = renderToStaticMarkup(
    createElement(QualityProviderTransmissionDetails, { value: matched, expired: true }),
  );
  expect(stale).toContain("전송 검토 기한 경과");
  expect(stale).not.toContain("조회 당시 전송 검토 조건 충족");
  expect(
    renderToStaticMarkup(
      createElement(QualityProviderTransmissionDetails, { value: blocked, expired: false }),
    ),
  ).toContain("채택 정책이 바뀌었습니다");
});
it("initially offers only inspection and respects the parent's disabled state", () => {
  const html = renderToStaticMarkup(
    createElement(QualityProviderTransmissionPanel, {
      registry,
      snapshot,
      disabled: true,
      onBusyChange: () => undefined,
    }),
  );
  expect(html).toContain("전송 검토 조회");
  expect(html).toMatch(/<button[^>]*disabled/);
  expect(html).not.toContain("JSON 내려받기");
  expect(html).not.toContain('type="checkbox"');
});
it("keeps the reserved amount in its original unit when the current budget is incompatible", () => {
  const value = structuredClone(matched);
  value.review.budget.currency = "KRW";
  value.review.budget.unitScale = 0;
  value.review.facts.budgetCompatible = false;
  value.review.assessment = { state: "blocked", blockers: ["budget-incompatible"] };
  const html = renderToStaticMarkup(
    createElement(QualityProviderTransmissionDetails, { value, expired: false }),
  );
  const ownHold = html.match(/이 실행의 남은 예약<\/dt><dd[^>]*>(.*?)<\/dd>/)?.[1];
  expect(ownHold).toContain("USD");
  expect(ownHold).not.toContain("KRW");
  expect(html).toContain("현재 누적 한도</dt><dd");
  expect(html).toContain("KRW");
});
it("fetches only the strict selected run through the inspection endpoint", async () => {
  const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(matched));
  const signal = new AbortController().signal;
  expect(await fetchReview(registry, snapshot, signal)).toEqual(matched);
  expect(request).toHaveBeenCalledExactlyOnceWith(transmissionInspectUrl, {
    method: "POST",
    cache: "no-store",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(matched.selection),
  });
});
it.each([
  "status",
  "content-type",
  "declared-size",
  "invalid-length",
  "actual-size",
  "utf8",
  "json",
  "wrong-status",
  "aborted",
])("rejects %s transport output", async (kind) => {
  let response: Response;
  if (kind === "status") response = new Response("{}", { status: 500 });
  else if (kind === "content-type") response = new Response(JSON.stringify(matched));
  else if (kind === "declared-size" || kind === "invalid-length")
    response = Response.json(matched, {
      headers: {
        "content-length": kind === "declared-size" ? String(transmissionResponseBytes + 1) : "-1",
      },
    });
  else if (kind === "actual-size")
    response = new Response(" ".repeat(transmissionResponseBytes + 1), {
      headers: { "content-type": "application/json", "content-length": "1" },
    });
  else if (kind === "utf8")
    response = new Response(new Uint8Array([0xff]), {
      headers: { "content-type": "application/json" },
    });
  else if (kind === "json")
    response = new Response("{", { headers: { "content-type": "application/json" } });
  else response = Response.json(matched, { status: kind === "wrong-status" ? 409 : 200 });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
  const controller = new AbortController();
  if (kind === "aborted") controller.abort();
  await expect(fetchReview(registry, snapshot, controller.signal)).rejects.toThrow();
});
it.each([
  ["configuration-expired", 200],
  ["reservation-expired", 409],
  ["configuration-changed", 409],
] as const)("requires the exact HTTP status for %s", async (reason, status) => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json(unavailable(reason), { status }))
    .mockResolvedValueOnce(
      Response.json(unavailable(reason), { status: status === 200 ? 409 : 200 }),
    );
  expect(await fetchReview(registry, snapshot, new AbortController().signal)).toEqual(
    unavailable(reason),
  );
  await expect(fetchReview(registry, snapshot, new AbortController().signal)).rejects.toThrow();
});
