import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { actualTestRegistry, actualTestNow } from "@/lib/studio-plan-quality-actual-test-helpers";
import {
  createProviderConfigurationProposalView,
  getProviderConfigurationProposal,
} from "@/lib/studio-plan-quality-provider-configuration";
import { createProviderPolicyReview } from "@/lib/studio-plan-quality-provider-policy-review";
import { planQualityEvaluationDigest as digest } from "@/lib/studio-plan-quality-evaluation";
import {
  providerReviewDigestInput,
  providerProposalBlockerMessages,
} from "@/lib/studio-plan-quality-provider-review-types";
import { providerPolicyReviewDigestInput } from "@/lib/studio-plan-quality-provider-policy-review-types";
import {
  providerPolicyViewBlockerCodes,
  providerPolicyViewSchema,
  type ProviderPolicyView,
} from "@/lib/studio-plan-quality-provider-policy-view-types";
import { createProviderBudgetEvent } from "../../../scripts/local-data-quality-provider.mjs";
import type { ProviderBudgetEvent } from "@/lib/studio-plan-quality-provider-types";
import { qualityProviderReview, qualityProviderReviewArchive } from "./quality-provider-review-ui";
import { QualityProviderPolicyDetails } from "./quality-provider-policy-details";
import { QualityProviderPolicyApprovalForm } from "./quality-provider-policy-adoption-panel";
import {
  providerPolicyInspectionSchema,
  type ProviderPolicyInspection,
} from "@/lib/studio-plan-quality-provider-policy-http-types";

vi.mock("server-only", () => ({}));
const registry = actualTestRegistry();
function makeView(cap?: string, currency = "USD") {
  const events: ProviderBudgetEvent[] =
    cap === undefined
      ? []
      : [
          createProviderBudgetEvent({
            schemaVersion: 2,
            scopeId: "candidate-quality-provider-v2-live",
            environment: "production",
            provenance: "explicit-user",
            revision: 1,
            previousDigest: null,
            eventId: randomUUID(),
            recordedAt: actualTestNow,
            currency,
            unitScale: 6,
            payload: { kind: "configure", capUnits: cap },
          }),
        ];
  const input = {
    registry,
    candidateId: registry.entries[0].candidateId,
    inspectedAt: actualTestNow,
    configuration: getProviderConfigurationProposal(),
    budgetEvents: events,
    expectedBudgetHead: { revision: events.length, headDigest: events.at(-1)?.eventDigest ?? null },
  };
  const proposal = createProviderConfigurationProposalView(input)!;
  const policy = createProviderPolicyReview(input);
  if (policy.status !== "review") throw new Error("Invalid synthetic fixture");
  const value = {
    ...proposal,
    viewVersion: 4 as const,
    policyReview: policy.review,
    blockers: providerPolicyViewBlockerCodes.map((code) => ({
      code,
      message: providerProposalBlockerMessages[code],
    })),
  };
  return providerPolicyViewSchema.parse({
    ...value,
    viewDigest: digest(providerReviewDigestInput(value)),
  });
}
const inspect = (value: unknown) =>
  qualityProviderReview(value, registry, registry.entries[0].candidateId);
const seal = (value: ProviderPolicyView) => {
  value.policyReview.reviewDigest = digest(providerPolicyReviewDigestInput(value.policyReview));
  value.viewDigest = digest(providerReviewDigestInput(value));
  return value;
};
afterEach(() => vi.useRealTimers());

describe("verified policy review browser binding and display", () => {
  it.each([undefined, "20000000", "10000000"])(
    "keeps %s budget and complete JSON archive readable after expiry",
    async (cap) => {
      const value = makeView(cap);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2035-01-01T00:00:00.000Z"));
      expect(await inspect(value)).toEqual(value);
      const archive = await qualityProviderReviewArchive(value, registry, value.scope.candidateId);
      expect(JSON.parse(archive.text)).toEqual(value);
      expect(archive.filename).toContain(value.viewDigest.slice(0, 12));
      expect(Object.values(value.policyReview.actions)).toEqual([false, false, false, false]);
    },
  );
  it.each([
    "scope",
    "time",
    "expiry",
    "model",
    "configurationDigest",
    "requestReviewDigest",
    "financialBasisDigest",
    "retentionDigest",
    "usagePolicyDigest",
    "reservation",
    "proposal",
    "grant",
    "balance",
    "blockers",
  ])("rejects resealed mismatched %s", async (field) => {
    const value = makeView("20000000"),
      policy = value.policyReview;
    if (field === "scope") policy.scope.candidateId = registry.entries[1].candidateId;
    else if (field === "time") policy.inspectedAt = "2026-09-27T03:00:01.000Z";
    else if (field === "expiry") policy.expiresAt = "2026-09-27T03:14:59.000Z";
    else if (field === "model") policy.bindings.model = "another-model";
    else if (field === "reservation") {
      policy.reservation.generationUnits = "5610001";
      policy.reservation.reviewUnits = "5609999";
    } else if (field === "proposal") policy.proposedBudget.basis += "changed";
    else if (field === "grant") Object.assign(policy.actions, { dispatchAllowed: true });
    else if (field === "balance") policy.budget.availableUnits = "99999999";
    else if (field === "blockers") value.blockers[0].message = "승인 완료";
    else policy.bindings[field as "configurationDigest"] = "a".repeat(64);
    await expect(inspect(seal(value))).rejects.toThrow();
  });
  it("rejects an invalid nested digest even when the outer digest is correct", async () => {
    const value = makeView();
    value.policyReview.reviewDigest = "a".repeat(64);
    value.viewDigest = digest(providerReviewDigestInput(value));
    await expect(inspect(value)).rejects.toThrow();
  });
  it("shows recognized use and unresolved holds, with a prior bound violation taking priority over available funds", async () => {
    const value = makeView("20000000"),
      review = value.policyReview;
    Object.assign(review.budget, {
      recognizedUnits: "500000",
      heldUnits: "1000000",
      availableUnits: "18500000",
      boundBreached: true,
    });
    Object.assign(review.assessment, {
      state: "budget-bound-breached",
      availableBeforeReservationUnits: "18500000",
      availableAfterReservationUnits: "7280000",
    });
    await inspect(seal(value));
    const text = renderToStaticMarkup(createElement(QualityProviderPolicyDetails, { review }))
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
    expect(text).toContain("확인된 사용 금액 USD 0.5");
    expect(text).toContain("미정산 예약 금액 USD 1");
    expect(text).toContain("현재 가용액 USD 18.5");
    expect(text).toContain("잔액과 관계없이 해당 사용 내역을 먼저 확인");
    expect(text).not.toContain("확보할 수 있습니다");
  });
  it.each([
    [undefined, "USD", "운영 예산 미설정", "미승인 제안 한도를 적용했을 때의 가정 계산"],
    ["20000000", "USD", "현재 예산에서 한 건의 추가 예약액을 확보", "USD 8.78"],
    ["10000000", "USD", "현재 가용액이 한 건의 추가 예약액보다 적습니다", "USD 1.22"],
    ["20000000", "KRW", "통화 또는 금액 단위가 다릅니다", "KRW 20"],
  ])("renders %s/%s with explicit review-only state", (cap, currency, message, amount) => {
    const html = renderToStaticMarkup(
      createElement(QualityProviderPolicyDetails, { review: makeView(cap, currency).policyReview }),
    );
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain(message);
    expect(text).toContain(amount);
    expect(text).toContain("마지막 조회 기준");
    expect(text).toContain("다시 읽기로 확인");
    expect(html).not.toMatch(/<(button|form)\b/);
    if (currency === "KRW") expect(text).not.toContain("추가 예약 후 가용액");
    if (cap === undefined) expect(text).toContain("현재 가용액 미설정");
  });
});

function makeInspection(cap?: string) {
  const value = {
    ...makeView(cap),
    viewVersion: 5 as const,
    policyHead: cap
      ? { revision: 1, headDigest: "a".repeat(64) }
      : { revision: 0, headDigest: null },
  };
  return providerPolicyInspectionSchema.parse({
    ...value,
    viewDigest: digest(providerReviewDigestInput(value)),
  });
}
const sealInspection = (value: ProviderPolicyInspection) => {
  value.policyReview.reviewDigest = digest(providerPolicyReviewDigestInput(value.policyReview));
  value.viewDigest = digest(providerReviewDigestInput(value));
  return value;
};
describe("v5 policy inspection browser binding", () => {
  it.each([undefined, "20000000", "1000000"])(
    "requires two explicit confirmations for %s budget",
    (cap) => {
      const html = renderToStaticMarkup(
        createElement(QualityProviderPolicyApprovalForm, {
          view: makeInspection(cap),
          disabled: false,
          onApprove: () => {
            throw new Error("No implicit approval");
          },
        }),
      );
      expect(html.match(/type="checkbox"/g) ?? []).toHaveLength(2);
      expect(html).not.toMatch(/checked=/);
      expect(html).toMatch(/<button[^>]*disabled/);
      expect(html).toContain(cap ? "기존 누적 한도 유지" : "최초 누적 예산 설정");
      expect(html).toContain("비용 예약과 AI 전송은 별도 승인");
    },
  );
  it.each([undefined, "20000000", "10000000"])(
    "preserves %s budget, policy head and exact download after review expiry",
    async (cap) => {
      const value = makeInspection(cap);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime("2035-01-01T00:00:00.000Z");
      expect(await inspect(value)).toEqual(value);
      const archive = await qualityProviderReviewArchive(value, registry, value.scope.candidateId);
      expect(JSON.parse(archive.text)).toEqual(value);
      expect(archive.filename).toContain(value.viewDigest.slice(0, 12));
      expect(JSON.parse(archive.text).policyHead).toEqual(value.policyHead);
      expect(Object.values(value.policyReview.actions)).toEqual([false, false, false, false]);
    },
  );
  it("rejects a changed policy head that was not included in the outer digest", async () => {
    const value = makeInspection("20000000");
    value.policyHead.headDigest = "b".repeat(64);
    await expect(inspect(value)).rejects.toThrow();
  });
  it.each([
    undefined,
    { revision: 0, headDigest: "a".repeat(64) },
    { revision: 1, headDigest: null },
    { revision: 101, headDigest: "a".repeat(64) },
    { revision: 1, headDigest: "invalid" },
    { revision: 1, headDigest: "a".repeat(64), dispatchAllowed: true },
  ])("rejects an invalid or absent policy head even if resealed: %j", async (policyHead) => {
    const value = { ...makeInspection(), policyHead };
    value.viewDigest = digest(providerReviewDigestInput(value));
    await expect(inspect(value)).rejects.toThrow();
  });
  it.each(["scope", "model", "time", "blocker", "grant", "reservation"])(
    "keeps v4 nested consistency checks for resealed v5 %s tampering",
    async (field) => {
      const value = makeInspection();
      if (field === "scope") value.policyReview.scope.candidateId = registry.entries[1].candidateId;
      if (field === "model") value.policyReview.bindings.model = "client-forged-model";
      if (field === "time") value.policyReview.inspectedAt = "2026-09-27T03:00:01.000Z";
      if (field === "blocker") value.blockers[0].message = "승인 완료";
      if (field === "grant") Object.assign(value.policyReview.actions, { dispatchAllowed: true });
      if (field === "reservation") {
        value.policyReview.reservation.generationUnits = "5610001";
        value.policyReview.reservation.reviewUnits = "5609999";
      }
      await expect(inspect(sealInspection(value))).rejects.toThrow();
    },
  );
  it("shows the inspected policy count without presenting a new adoption as completed", () => {
    const value = makeInspection("20000000");
    const text = renderToStaticMarkup(
      createElement(QualityProviderPolicyDetails, {
        review: value.policyReview,
        policyHead: value.policyHead,
      }),
    )
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
    expect(text).toContain("전체 정책 채택 기록: 1건");
    expect(text).toContain("이번 제안의 새 채택은 실행되지 않았습니다");
    expect(text).toContain("현재 누적 한도 USD 20");
  });
});
