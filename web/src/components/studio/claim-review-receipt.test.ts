import { describe, it, expect } from "vitest";
import { claimReviewSaveAcknowledged } from "./claim-reviews";
import {
  claimReceiptFixture,
  claimReceiptResult,
  agencyId,
} from "../../../scripts/fixtures/claim-review-receipt";
describe("주장 검토 기존 요청 대조의 상위 수락 연결", () => {
  it("accepts matching claim, manual check and precise auxiliary versions without mutating inputs", () => {
    const { company, input, nonce, saved } = claimReceiptFixture();
    const before = JSON.stringify({ company, input, saved });
    expect(claimReviewSaveAcknowledged(saved, company, nonce, input)).toBe(true);
    expect(JSON.stringify({ company, input, saved })).toBe(before);
  });
  it("accepts the first unreviewed claim", () => {
    const { company, initial, nonce } = claimReceiptFixture();
    company.claimReviews = [];
    expect(
      claimReviewSaveAcknowledged(
        claimReceiptResult(company, initial, nonce),
        company,
        nonce,
        initial,
      ),
    ).toBe(true);
  });
  it.each([
    "missing",
    "nonce",
    "duplicate-nonce",
    "parent",
    "root",
    "version",
    "plan",
    "plan-version",
    "section",
    "quote",
    "nature",
    "references",
    "context",
    "owner",
    "due",
    "next",
    "method",
    "external-target",
    "external-content",
    "external-date",
    "numeric-version",
    "numeric-order",
    "plan-review",
    "judgement",
    "reviewer",
    "reason",
    "checked",
  ])("rejects %s while preserving submitted input", (kind) => {
    const { company, input, nonce, saved } = claimReceiptFixture(),
      before = JSON.stringify(input),
      r = saved.claimReviews.at(-1)!;
    if (kind === "missing") saved.claimReviews.pop();
    if (kind === "nonce") r.clientRequestId = agencyId(399);
    if (kind === "duplicate-nonce") saved.claimReviews.push(structuredClone(r));
    if (kind === "parent") r.previousVersionId = agencyId(399);
    if (kind === "root") r.claimId = agencyId(399);
    if (kind === "version") r.version = 3;
    if (kind === "plan") r.planId = agencyId(399);
    if (kind === "plan-version") r.planVersion++;
    if (kind === "section") r.sectionKey = "another";
    if (kind === "quote") r.claimQuote = "다른 인용";
    if (kind === "nature") r.nature = "future-plan";
    if (kind === "references")
      r.references.push({
        sourceId: agencyId(399),
        sourceUpdatedAt: "synthetic",
        quote: "다른 근거",
        locator: "1쪽",
      });
    if (kind === "context") r.contextNote = "다른 해석";
    if (kind === "owner") r.owner = "다른 담당자";
    if (kind === "due") r.dueOn = "2026-11-04";
    if (kind === "next") r.nextCheck = "다른 확인 사항";
    if (kind === "method") r.method = "document";
    if (kind === "external-target") r.externalCheck.target = "다른 대상";
    if (kind === "external-content") r.externalCheck.content = "다른 수기 내용";
    if (kind === "external-date") r.externalCheck.occurredOn = "2026-10-10";
    if (kind === "numeric-version") r.numericReferences[1].version = 1;
    if (kind === "numeric-order") r.numericReferences.reverse();
    if (kind === "plan-review") r.planReviewReferences.push({ id: agencyId(399), version: 1 });
    if (kind === "judgement") r.judgement.state = "consistent";
    if (kind === "reviewer") r.judgement.reviewer = "다른 판단자";
    if (kind === "reason") r.judgement.reason = "다른 판단 이유";
    if (kind === "checked") r.judgement.checkedOn = "2026-10-11";
    expect(claimReviewSaveAcknowledged(saved, company, nonce, input)).toBe(false);
    expect(JSON.stringify(input)).toBe(before);
  });
  it("rejects null, another company and older company revision", () => {
    const { company, input, nonce, saved } = claimReceiptFixture();
    expect(claimReviewSaveAcknowledged(null, company, nonce, input)).toBe(false);
    const other = structuredClone(saved);
    other.id = agencyId(399);
    expect(claimReviewSaveAcknowledged(other, company, nonce, input)).toBe(false);
    saved.revision = company.revision - 1;
    expect(claimReviewSaveAcknowledged(saved, company, nonce, input)).toBe(false);
  });
});
