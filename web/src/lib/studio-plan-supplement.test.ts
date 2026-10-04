import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { answerSuggestionSha as sha } from "./studio-answer-suggestion";
import {
  preparePlanSupplement,
  comparePlanSupplement,
  type PlanSupplementInput,
} from "./studio-plan-supplement";
import { supplementFixture } from "./studio-plan-supplement-test-helpers";
describe("선택 보완 자료·단일 항목 수정안의 순수 준비와 대조", () => {
  it("100개 중 선택1개와 지정 본문·질문만 직렬화하며 키·시각·IO를 요구하지 않는다", () => {
    const f = supplementFixture(),
      before = JSON.stringify(f.value),
      result = f.preview();
    for (const hidden of [
      "PRIVATE_NUMBER",
      "PRIVATE_PROFILE",
      "PRIVATE_TITLE",
      "PRIVATE_SUMMARY",
      "PRIVATE_OLD_CITATION",
      "MANUAL_OTHER_",
      "EXCLUDED_",
    ])
      expect(result.payload).not.toContain(hidden);
    expect(JSON.parse(result.payload).sources).toHaveLength(1);
    expect(result.characters).toBe(result.payload.length);
    expect(result).toMatchObject({
      transmissionAllowed: false,
      databaseChanged: false,
      actualTokenCountMeasured: false,
      contextFitVerified: false,
    });
    expect(JSON.stringify(f.value)).toBe(before);
  });
  it("수정 대상 이외 수동본문·인용·제목·요약·질문·과제를 byte 수준으로 보존한다", () => {
    const f = supplementFixture(),
      before = JSON.stringify(f.value),
      result = f.compare(),
      original = f.value.plans[0].content;
    for (const section of original.sections.filter((s) => s.key !== f.input.sectionKey))
      expect(JSON.stringify(result.content.sections.find((s) => s.key === section.key))).toBe(
        JSON.stringify(section),
      );
    for (const key of ["title", "summary", "actionItems", "interviewQuestions"] as const)
      expect(JSON.stringify(result.content[key])).toBe(JSON.stringify(original[key]));
    expect(result.after.evidence[0]).toEqual(result.before.evidence[0]);
    expect(result.after.evidence).toHaveLength(2);
    expect(result.after.needsConfirmation).toBe(true);
    expect(result.additions[0]).toMatchObject({
      lineStart: 2,
      lineEnd: 2,
      quote: f.draft.addedEvidence[0].quote,
    });
    expect(result).toMatchObject({
      origin: "supplied-draft",
      reviewStatus: "unreviewed",
      databaseChanged: false,
      transmissionAllowed: false,
      factVerified: false,
      semanticQualityVerified: false,
    });
    expect(JSON.stringify(f.value)).toBe(before);
    expect(result.comparison.complete).toBe(true);
    expect(
      result.comparison.spans
        .filter((s) => s.kind !== "added")
        .map((s) => s.text)
        .join(""),
    ).toBe(result.before.content);
    expect(
      result.comparison.spans
        .filter((s) => s.kind !== "removed")
        .map((s) => s.text)
        .join(""),
    ).toBe(result.after.content);
  });
  it("반환된 비교안·원문 인용을 고쳐도 회사와 다음 결과는 불변이다", () => {
    const f = supplementFixture(),
      before = JSON.stringify(f.value),
      a = f.compare();
    a.content.sections[0].content = "변조";
    a.before.evidence[0].quote = "변조";
    a.additions[0].quote = "변조";
    const p = f.preview();
    p.retainedEvidence[0].quote = "변조";
    expect(JSON.stringify(f.value)).toBe(before);
    expect(f.compare().after.evidence[0].quote).toBe("PRIVATE_OLD_CITATION");
  });
  it.each(["company", "revision", "plan", "question", "section", "source", "name"])(
    "%s 변경은 원래 비교 신원으로 수용하지 않는다",
    (kind) => {
      const f = supplementFixture(),
        expected = f.preview().binding;
      if (kind === "company") f.value.id = randomUUID();
      if (kind === "revision") {
        f.value.revision++;
        f.input.revision++;
      }
      if (kind === "plan") {
        f.value.plans[0].content.sections[0].content += "manual edit";
        f.input.baseContentSha256 = sha(JSON.stringify(f.value.plans[0].content));
      }
      if (kind === "question" && f.input.target.kind === "visit-question") {
        f.value.plans[0].content.interviewQuestions[0] = "다른 질문";
        f.input.target.questionText = "다른 질문";
        f.input.target.questionSha256 = sha("다른 질문");
        f.input.baseContentSha256 = sha(JSON.stringify(f.value.plans[0].content));
      }
      if (kind === "section") f.input.sectionKey = "funding";
      if (kind === "source") {
        f.value.sources[0].text += "변경";
        f.input.sourceSelections[0].textSha256 = sha(f.value.sources[0].text);
      }
      if (kind === "name") f.value.sources[0].name = "다른 이름";
      expect(() => comparePlanSupplement(f.value, f.input, expected, f.draft)).toThrow();
    },
  );
  it("자료를 보완한 뒤 기준 원고가 오래되어도 최신 보관 원고/질문은 읽을 수 있다", () => {
    const f = supplementFixture();
    expect(f.value.plans[0].sourceRevision).toBeLessThan(f.value.revision);
    expect(f.compare().baseSourceRevision).toBe(1);
    expect(f.value.selectedCandidateId).toBeNull();
    expect(f.value.analysis).toBeNull();
  });
  it("다른 최신 원고가 생기면 예전 기준 원고를 묵시적으로 옮기지 않는다", () => {
    const f = supplementFixture();
    f.value.plans.push({ ...structuredClone(f.value.plans[0]), id: randomUUID(), version: 3 });
    expect(f.preview).toThrow();
  });
  it.each(["duplicate", "missing", "pending", "empty", "changed"])(
    "%s 선택 자료를 거절한다",
    (kind) => {
      const f = supplementFixture();
      if (kind === "duplicate") f.input.sourceSelections.push(f.input.sourceSelections[0]);
      if (kind === "missing") f.input.sourceSelections[0].sourceId = randomUUID();
      if (kind === "pending") f.value.sources[0].extraction = "pending";
      if (kind === "empty") {
        f.value.sources[0].text = "";
        f.input.sourceSelections[0].textSha256 = sha("");
      }
      if (kind === "changed") f.value.sources[0].text += "다른 원문";
      expect(f.preview).toThrow();
    },
  );
  it("6개/6만 자 제한은 회사100개 한도와 별개로 기존 발췌 경로에서 유지한다", () => {
    const f = supplementFixture();
    f.input.sourceSelections = f.value.sources
      .slice(0, 6)
      .map((s) => ({ sourceId: s.id, sourceUpdatedAt: s.updatedAt, textSha256: sha(s.text) }));
    expect(JSON.parse(f.preview().payload).sources).toHaveLength(6);
    const s = f.value.sources[6];
    f.input.sourceSelections.push({
      sourceId: s.id,
      sourceUpdatedAt: s.updatedAt,
      textSha256: sha(s.text),
    });
    expect(f.preview).toThrow();
    f.input.sourceSelections = [f.input.sourceSelections[0]];
    f.value.sources[0].text = "x".repeat(60001);
    f.input.sourceSelections[0].textSha256 = sha(f.value.sources[0].text);
    expect(f.preview).toThrow();
  });
  it("이스케이프 뒤 직렬화 입력이24만자를 넘으면 자르지 않고 거절한다", () => {
    const f = supplementFixture();
    f.value.sources[0].text = "\u0001".repeat(60000);
    f.input.sourceSelections[0].textSha256 = sha(f.value.sources[0].text);
    expect(f.preview).toThrow();
  });
  it.each(["outside", "wrong-quote", "wrong-offset", "overlap", "empty"])(
    "%s 추가 인용을 수용하지 않는다",
    (kind) => {
      const f = supplementFixture();
      if (kind === "outside") f.draft.addedEvidence[0].sourceId = f.value.sources[1].id;
      if (kind === "wrong-quote") f.draft.addedEvidence[0].quote = "없는 원문";
      if (kind === "wrong-offset") f.draft.addedEvidence[0].start++;
      if (kind === "overlap") f.draft.addedEvidence.push(f.draft.addedEvidence[0]);
      if (kind === "empty") f.draft.addedEvidence = [];
      expect(f.compare).toThrow();
    },
  );
  it("전체 원고/확인 완료/기존 승인 토큰/추가 필드 주입을 허용하지 않는다", () => {
    const f = supplementFixture(),
      binding = f.preview().binding;
    for (const extra of [
      { sections: [] },
      { needsConfirmation: false },
      { approved: true },
      { token: randomUUID() },
    ])
      expect(() =>
        comparePlanSupplement(f.value, f.input, binding, { ...f.draft, ...extra }),
      ).toThrow();
    expect(() =>
      preparePlanSupplement(f.value, { ...f.input, approved: true } as PlanSupplementInput),
    ).toThrow();
    expect(() =>
      comparePlanSupplement(
        f.value,
        f.input,
        { ...binding, token: randomUUID() } as typeof binding,
        f.draft,
      ),
    ).toThrow();
  });
  it("같은 입력/제안은 같은 digest이고 제안만 달라도 다른 digest다", () => {
    const f = supplementFixture(),
      a = f.compare();
    expect(f.compare()).toEqual(a);
    f.draft.content += " 확인 필요";
    expect(f.compare().proposalSha256).not.toBe(a.proposalSha256);
  });
  it("동일 인용은 기존 위치를 유지하고 변경이 전혀 없으면 채택안으로 내지 않는다", () => {
    const f = supplementFixture();
    const old = f.value.plans[0].content.sections.find((s) => s.key === "development")!;
    old.evidence.push({
      sourceId: f.draft.addedEvidence[0].sourceId,
      quote: f.draft.addedEvidence[0].quote,
      locator: "원래 위치",
    });
    old.needsConfirmation = true;
    f.input.baseContentSha256 = sha(JSON.stringify(f.value.plans[0].content));
    expect(f.compare().after.evidence).toHaveLength(2);
    f.draft.content = old.content;
    expect(f.compare).toThrow();
  });
  it("손상된 항목 구조·기준 해시와18001자 결과는 거절한다", () => {
    const f = supplementFixture();
    f.draft.content = "x".repeat(18001);
    expect(f.compare).toThrow();
    f.value.plans[0].content.sections.reverse();
    f.input.baseContentSha256 = sha(JSON.stringify(f.value.plans[0].content));
    expect(f.preview).toThrow();
    const g = supplementFixture();
    g.input.baseContentSha256 = "0".repeat(64);
    expect(g.preview).toThrow();
  });
});
