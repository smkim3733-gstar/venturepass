import { describe, it, expect } from "vitest";
import { appealPreparationSaveAcknowledged } from "./appeal-preparation-response";
import {
  appealReceiptFixture,
  appealReceiptResult,
  agencyId,
} from "../../../scripts/fixtures/appeal-preparation-receipt";
type Fixture = ReturnType<typeof appealReceiptFixture>;
const check = (f: Fixture) =>
  appealPreparationSaveAcknowledged(f.saved, f.company, f.nonce, f.input);
describe("appeal preparation receipt before company acceptance", () => {
  it("accepts exact correction-bound successor without mutating command or prior history", () => {
    const f = appealReceiptFixture(),
      before = structuredClone(f);
    expect(check(f)).toBe(true);
    expect(f).toEqual(before);
  });
  it("accepts first unreviewed preparation with optional values explicitly blank", () => {
    const f = appealReceiptFixture();
    f.company.appealPreparations = [];
    f.input = {
      ...f.input,
      preparationId: null,
      previousVersionId: null,
      intent: "undecided",
      intentNote: "",
      deadlineOn: "",
      deadlineNote: "",
      review: { reviewed: false, reviewer: "", note: "" },
    };
    f.saved = appealReceiptResult(f.company, f.input, f.nonce);
    expect(check(f)).toBe(true);
    expect(f.saved.appealPreparations[0].preparationId).toBe(f.saved.appealPreparations[0].id);
  });
  it("accepts explicit clearing of deadline and drafts while keeping previous content", () => {
    const f = appealReceiptFixture();
    f.input = {
      ...f.input,
      deadlineOn: "",
      deadlineNote: "",
      intentNote: "",
      review: { reviewed: false, reviewer: "  담당자  ", note: "  재확인\n메모  " },
      reasons: f.input.reasons.map((r) => ({
        ...r,
        claim: "",
        gap: "",
        draft: "",
        planClaim: null,
      })),
    };
    f.saved = appealReceiptResult(f.company, f.input, f.nonce);
    expect(check(f)).toBe(true);
    expect(f.saved.appealPreparations[0].reasons[0].draft).toBe("이전 소명 1");
  });
  const cases: [string, (f: Fixture) => void][] = [
    [
      "missing",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        f.saved.appealPreparations.pop();
      },
    ],
    [
      "nonce",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        last.clientRequestId = agencyId(199);
      },
    ],
    [
      "parent",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        last.previousVersionId = null;
      },
    ],
    [
      "root",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        last.preparationId = agencyId(199);
      },
    ],
    [
      "version",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        last.version = 3;
      },
    ],
    [
      "notice root",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        last.noticeRecordId = agencyId(199);
      },
    ],
    [
      "notice version",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        last.noticeVersionId = f.company.agencyRecords.find(
          (r) => r.id === f.input.noticeRecordId,
        )!.id;
      },
    ],
    [
      "title",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        last.title = "다른 제목";
      },
    ],
    [
      "intent",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        last.intent = "preparing";
      },
    ],
    [
      "intent note whitespace",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        last.intentNote = last.intentNote.trim();
      },
    ],
    [
      "deadline",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        last.deadlineOn = "2026-11-04";
      },
    ],
    [
      "deadline note",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        last.deadlineNote = "다른 근거";
      },
    ],
    [
      "reason id",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        last.reasons[1].id = agencyId(199);
      },
    ],
    [
      "reason field",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        last.reasons[1].noticeField = "body";
      },
    ],
    [
      "reason quote",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        last.reasons[1].noticeQuote = "다른 인용";
      },
    ],
    [
      "second claim",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        last.reasons[1].claim = "다른 주장";
      },
    ],
    [
      "second gap",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        last.reasons[1].gap = "다른 보강";
      },
    ],
    [
      "second draft whitespace",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        last.reasons[1].draft = last.reasons[1].draft.trim();
      },
    ],
    [
      "reason order",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        last.reasons.reverse();
      },
    ],
    [
      "plan binding",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        last.reasons[1].planClaim!.sectionKey = "other";
      },
    ],
    [
      "plan quote",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        last.reasons[1].planClaim!.quote = "다른 원고";
      },
    ],
    [
      "evidence",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        last.reasons[1].evidence = [
          {
            sourceId: agencyId(198),
            sourceUpdatedAt: "synthetic",
            quote: "다른 자료",
            locator: "1쪽",
          },
        ];
      },
    ],
    [
      "additional evidence",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        last.reasons[1].additionalEvidence = [
          {
            sourceId: agencyId(198),
            sourceUpdatedAt: "synthetic",
            quote: "다른 증빙",
            locator: "2쪽",
          },
        ];
      },
    ],
    [
      "review flag",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        last.review.reviewedAt = null;
      },
    ],
    [
      "review time",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        last.review.reviewedAt = "2026-10-12T04:00:00.000Z";
      },
    ],
    [
      "reviewer",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        last.review.reviewer = "다른 담당자";
      },
    ],
    [
      "review note whitespace",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        last.review.note = last.review.note.trim();
      },
    ],
    [
      "old history altered",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        f.saved.appealPreparations[0].intentNote = "바뀐 과거";
      },
    ],
    [
      "old history removed",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        f.saved.appealPreparations.shift();
      },
    ],
    [
      "extra record",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        f.saved.appealPreparations.push({
          ...structuredClone(last),
          id: agencyId(196),
          clientRequestId: agencyId(197),
          version: 3,
        });
      },
    ],
    [
      "duplicate id",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        last.id = f.company.appealPreparations[0].id;
      },
    ],
    [
      "duplicate nonce",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        last.clientRequestId = f.company.appealPreparations[0].clientRequestId;
      },
    ],
    [
      "duplicate version",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        last.version = 1;
      },
    ],
    [
      "original nonce already present",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        f.company.appealPreparations[0].clientRequestId = f.nonce;
        f.saved.appealPreparations[0].clientRequestId = f.nonce;
      },
    ],
    [
      "stale previous command",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        f.input.previousVersionId = agencyId(199);
      },
    ],
    [
      "other root notice",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        f.company.appealPreparations[0].noticeRecordId = agencyId(199);
        f.saved.appealPreparations[0].noticeRecordId = agencyId(199);
      },
    ],
    [
      "first command duplicates root",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        f.input.preparationId = null;
        f.input.previousVersionId = null;
        f.saved = appealReceiptResult(f.company, f.input, f.nonce);
      },
    ],
    [
      "stale notice command",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        f.input.noticeVersionId = f.input.noticeRecordId;
        f.saved = appealReceiptResult(f.company, f.input, f.nonce);
      },
    ],
    [
      "missing original notice",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        f.company.agencyRecords = [];
        f.saved.agencyRecords = [];
      },
    ],
    [
      "other company",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        f.saved.id = agencyId(199);
      },
    ],
    [
      "same revision",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        f.saved.revision = f.company.revision;
      },
    ],
    [
      "negative original revision",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        f.company.revision = -1;
      },
    ],
    [
      "company profile",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        f.saved.profile.companyName = "다른 기업";
      },
    ],
    [
      "plan altered",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        f.saved.plans[0].content.title = "다른 원고";
      },
    ],
    [
      "task altered",
      (f) => {
        const last = f.saved.appealPreparations.at(-1)!;
        void last;
        f.saved.tasks[0].title = "다른 업무";
      },
    ],
  ];
  it.each(cases)("rejects %s", (_name, alter) => {
    const f = appealReceiptFixture();
    alter(f);
    expect(check(f)).toBe(false);
  });
  it.each([null, {}, { id: "invalid" }])("rejects malformed response %j", (value) => {
    const f = appealReceiptFixture();
    expect(appealPreparationSaveAcknowledged(value, f.company, f.nonce, f.input)).toBe(false);
  });
});
