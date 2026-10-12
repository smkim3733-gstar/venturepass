import { describe, it, expect } from "vitest";
import { visitAnswerSaveAcknowledged } from "./visit-answer-response";
import {
  visitReceiptFixture,
  visitReceiptResult,
  agencyId,
} from "../../../scripts/fixtures/visit-answer-receipt";
type Fixture = ReturnType<typeof visitReceiptFixture>;
const check = (f: Fixture) => visitAnswerSaveAcknowledged(f.saved, f.company, f.nonce, f.input);
describe("visit answer receipt before company acceptance", () => {
  it("accepts an exact reviewed successor and leaves raw input and prior history untouched", () => {
    const f = visitReceiptFixture(),
      before = structuredClone(f);
    expect(check(f)).toBe(true);
    expect(f).toEqual(before);
  });
  it("accepts a first unreviewed blank answer without treating blanks as earlier values", () => {
    const f = visitReceiptFixture();
    f.company.visitAnswers = [];
    f.input = {
      ...f.input,
      answerId: null,
      previousVersionId: null,
      answerText: "",
      respondentName: "",
      pairs: [],
      followUpNote: "",
      review: { reviewed: false, reviewer: "", note: "" },
    };
    f.saved = visitReceiptResult(f.company, f.input, f.nonce);
    expect(check(f)).toBe(true);
    expect(f.saved.visitAnswers[0].answerId).toBe(f.saved.visitAnswers[0].id);
  });
  it("accepts explicit cleared fields and retained unreviewed notes", () => {
    const f = visitReceiptFixture();
    f.input = {
      ...f.input,
      answerText: "",
      respondentName: "",
      pairs: [],
      followUpNote: "",
      review: { reviewed: false, reviewer: "  담당자  ", note: "  확인 필요\n둘째 줄  " },
    };
    f.saved = visitReceiptResult(f.company, f.input, f.nonce);
    expect(check(f)).toBe(true);
    expect(f.saved.visitAnswers[0].answerText).toBe("이전 모의 답변");
  });
  const cases: [string, (f: Fixture) => void][] = [
    [
      "missing",
      (f) => {
        f.saved.visitAnswers.pop();
      },
    ],
    [
      "nonce",
      (f) => {
        f.saved.visitAnswers.at(-1)!.clientRequestId = agencyId(99);
      },
    ],
    [
      "parent",
      (f) => {
        f.saved.visitAnswers.at(-1)!.previousVersionId = null;
      },
    ],
    [
      "root",
      (f) => {
        f.saved.visitAnswers.at(-1)!.answerId = agencyId(99);
      },
    ],
    [
      "version",
      (f) => {
        f.saved.visitAnswers.at(-1)!.version = 3;
      },
    ],
    [
      "same text different question index",
      (f) => {
        f.saved.visitAnswers.at(-1)!.questionIndex = 0;
      },
    ],
    [
      "question text",
      (f) => {
        f.saved.visitAnswers.at(-1)!.questionText = "다른 질문";
      },
    ],
    [
      "plan",
      (f) => {
        f.saved.visitAnswers.at(-1)!.planId = agencyId(99);
      },
    ],
    [
      "submission",
      (f) => {
        f.saved.visitAnswers.at(-1)!.submissionRecordId = agencyId(99);
      },
    ],
    [
      "role",
      (f) => {
        f.saved.visitAnswers.at(-1)!.respondentRole = "other";
      },
    ],
    [
      "respondent",
      (f) => {
        f.saved.visitAnswers.at(-1)!.respondentName = "다른 담당자";
      },
    ],
    [
      "answer whitespace",
      (f) => {
        f.saved.visitAnswers.at(-1)!.answerText = f.input.answerText.trim();
      },
    ],
    [
      "followup",
      (f) => {
        f.saved.visitAnswers.at(-1)!.followUpNote = "다른 후속";
      },
    ],
    [
      "second pair",
      (f) => {
        f.saved.visitAnswers.at(-1)!.pairs[1].contextNote = "다른 메모";
      },
    ],
    [
      "pair ordering",
      (f) => {
        f.saved.visitAnswers.at(-1)!.pairs.reverse();
      },
    ],
    [
      "plan quote",
      (f) => {
        f.saved.visitAnswers.at(-1)!.pairs[1].planReference!.quote = "다른 인용";
      },
    ],
    [
      "source binding",
      (f) => {
        f.saved.visitAnswers.at(-1)!.pairs[1].sources = [
          { sourceId: agencyId(98), sourceUpdatedAt: "old", quote: "인용", locator: "1쪽" },
        ];
      },
    ],
    [
      "review missing",
      (f) => {
        f.saved.visitAnswers.at(-1)!.review.reviewedAt = null;
      },
    ],
    [
      "review time",
      (f) => {
        f.saved.visitAnswers.at(-1)!.review.reviewedAt = "2026-10-11T00:00:00.000Z";
      },
    ],
    [
      "reviewer",
      (f) => {
        f.saved.visitAnswers.at(-1)!.review.reviewer = "다른 검토자";
      },
    ],
    [
      "review note whitespace",
      (f) => {
        f.saved.visitAnswers.at(-1)!.review.note = f.input.review.note.trim();
      },
    ],
    [
      "altered old answer",
      (f) => {
        f.saved.visitAnswers[0].answerText = "변경";
      },
    ],
    [
      "removed old answer",
      (f) => {
        f.saved.visitAnswers.shift();
      },
    ],
    [
      "extra appended answer",
      (f) => {
        f.saved.visitAnswers.push({
          ...f.saved.visitAnswers[0],
          id: agencyId(96),
          clientRequestId: agencyId(97),
        });
      },
    ],
    [
      "duplicate id",
      (f) => {
        f.saved.visitAnswers.at(-1)!.id = f.company.visitAnswers[0].id;
      },
    ],
    [
      "duplicate request",
      (f) => {
        f.saved.visitAnswers[0].clientRequestId = f.nonce;
      },
    ],
    [
      "duplicate version",
      (f) => {
        f.saved.visitAnswers.at(-1)!.version = 1;
      },
    ],
    [
      "original nonce reused",
      (f) => {
        f.company.visitAnswers[0].clientRequestId = f.nonce;
        f.saved = visitReceiptResult(f.company, f.input, f.nonce);
      },
    ],
    [
      "stale previous",
      (f) => {
        f.input.previousVersionId = agencyId(99);
        f.saved = visitReceiptResult(f.company, f.input, f.nonce);
      },
    ],
    [
      "root belongs to different question",
      (f) => {
        f.input.questionIndex = 0;
        f.saved = visitReceiptResult(f.company, f.input, f.nonce);
      },
    ],
    [
      "first answer already exists",
      (f) => {
        f.input.answerId = null;
        f.input.previousVersionId = null;
        f.input.review.reviewed = false;
        f.saved = visitReceiptResult(f.company, f.input, f.nonce);
      },
    ],
    [
      "company",
      (f) => {
        f.saved.id = agencyId(99);
      },
    ],
    [
      "revision",
      (f) => {
        f.saved.revision = f.company.revision;
      },
    ],
    [
      "profile",
      (f) => {
        f.saved.profile.companyName = "다른 회사";
      },
    ],
    [
      "plan edited",
      (f) => {
        f.saved.plans[0].content.title = "다른 원고";
      },
    ],
    [
      "task deleted",
      (f) => {
        f.saved.tasks.pop();
      },
    ],
    [
      "agency records deleted",
      (f) => {
        f.saved.agencyRecords = [];
      },
    ],
    [
      "wrong original format",
      (f) => {
        f.company.revision = -1;
      },
    ],
  ];
  it.each(cases)("rejects %s", (_name, alter) => {
    const f = visitReceiptFixture();
    alter(f);
    expect(check(f)).toBe(false);
  });
  it.each([null, {}, { id: "invalid" }])("rejects malformed response %j", (response) => {
    const f = visitReceiptFixture();
    expect(visitAnswerSaveAcknowledged(response, f.company, f.nonce, f.input)).toBe(false);
  });
});
