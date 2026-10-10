import { expect, it } from "vitest";
import {
  diagnosisAnswersFixture,
  diagnosisAnswersResult,
} from "../../../scripts/fixtures/diagnosis-answers-receipt";
import { diagnosisAnswersSaveAcknowledged as acknowledged } from "./diagnosis-answers-response";
it("전체 답변과 원문 연결을 대조하고 원래 요청을 변경하지 않는다", () => {
  const f = diagnosisAnswersFixture(),
    before = structuredClone(f);
  expect(acknowledged(f.saved, f.company, f.request)).toBe(true);
  expect(f).toEqual(before);
});
for (const mismatch of [
  "entity",
  "criteria",
  "status",
  "reviewed",
  "note",
  "industry",
  "source-id",
  "source-time",
  "quote",
  "locator",
  "missing-evidence",
  "extra-evidence",
  "company",
  "revision",
  "request-revision",
  "profile",
  "source",
  "task",
  "agency",
  "application",
  "stage",
  "format",
] as const)
  it(mismatch + " 다른 진단 답변 저장 거절", () => {
    const f = diagnosisAnswersFixture(),
      a = f.saved.diagnosisAnswers,
      ref = a.sme.evidence[0];
    if (mismatch === "entity") a.entityType = "sole";
    if (mismatch === "criteria") a.criteriaVersion = null;
    if (mismatch === "status") a.sme.status = "contradicted";
    if (mismatch === "reviewed") {
      a.sme.status = "unknown";
      a.sme.reviewed = false;
    }
    if (mismatch === "note") a.sme.note = a.sme.note.trim();
    if (mismatch === "industry") a.industryEligibility.note = "다른 사유";
    if (mismatch === "source-id") ref.sourceId = f.company.id;
    if (mismatch === "source-time") ref.sourceUpdatedAt = "2026-10-09T00:00:00.000Z";
    if (mismatch === "quote") ref.quote = "다른 원문 문구";
    if (mismatch === "locator") ref.locator = "원본 2페이지";
    if (mismatch === "missing-evidence") {
      a.sme.status = "unknown";
      a.sme.evidence = [];
    }
    if (mismatch === "extra-evidence") a.sme.evidence.push({ ...ref, locator: "추가 위치" });
    if (mismatch === "company") f.saved.id = f.source.id;
    if (mismatch === "revision") f.saved.revision = f.company.revision;
    if (mismatch === "request-revision") f.request.revision--;
    if (mismatch === "profile") f.saved.profile.companyName += "다름";
    if (mismatch === "source") f.saved.sources.at(-1)!.text += "다름";
    if (mismatch === "task") f.saved.tasks[0].notes += "다름";
    if (mismatch === "agency") f.saved.agencyRecords = [];
    if (mismatch === "application") f.saved.applications = [];
    if (mismatch === "stage") f.saved.stage = "confirmed";
    expect(acknowledged(mismatch === "format" ? {} : f.saved, f.company, f.request)).toBe(false);
  });
it("판단 보류와 근거 비움도 명시한 그대로 수락한다", () => {
  const f = diagnosisAnswersFixture();
  f.request.answers.sme = { status: "unknown", reviewed: false, note: "미확인 유지", evidence: [] };
  f.request.answers.criteriaVersion = null;
  expect(acknowledged(diagnosisAnswersResult(f.company, f.request), f.company, f.request)).toBe(
    true,
  );
});
it("원문 연결의 배열 순서는 보존한다", () => {
  const f = diagnosisAnswersFixture();
  f.request.answers.sme.evidence.push({
    ...f.request.answers.sme.evidence[0],
    locator: "원본 2페이지",
  });
  const saved = diagnosisAnswersResult(f.company, f.request);
  saved.diagnosisAnswers.sme.evidence.reverse();
  expect(acknowledged(saved, f.company, f.request)).toBe(false);
});
it("선언 필드 순서는 파싱 후 같은 답변으로 대조한다", () => {
  const f = diagnosisAnswersFixture(),
    a = f.saved.diagnosisAnswers;
  f.saved.diagnosisAnswers = {
    industryEligibility: a.industryEligibility,
    sme: a.sme,
    criteriaVersion: a.criteriaVersion,
    entityType: a.entityType,
  };
  expect(acknowledged(f.saved, f.company, f.request)).toBe(true);
});
