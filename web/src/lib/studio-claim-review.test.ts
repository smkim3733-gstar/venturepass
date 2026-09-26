import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { caseSchema, emptyProfile, type SourceDocument } from "./studio-schema";
import {
  assertClaimReviewCapacity,
  buildClaimReview,
  claimReviewInputDigest,
  isClaimReviewReplay,
} from "./studio-claim-review";
import {
  claimReviewContext,
  claimReviewInputSchema,
  latestClaimReviews,
  type ClaimReviewInput,
} from "./studio-claim-review-types";
import { originalConflicts, planConflicts } from "./studio-evidence-history";
import { buildPlanReviewDecision, planReviewInputDigest } from "./studio-plan-review";
import { buildNumericCheck, numericCheckInputDigest } from "./studio-numeric-check";
import type { NumericCheckInput } from "./studio-numeric-check-types";

const now = "2026-09-25T00:00:00.000Z";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const company = caseSchema.parse({
    id: randomUUID(),
    profile: { ...emptyProfile(), companyName: "합성 주장 기업" },
    sources: [],
    analysis: null,
    selectedCandidateId: null,
    tasks: [],
    stage: "preparing",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    plans: [
      {
        id: randomUUID(),
        version: 1,
        mode: "manual",
        candidateId: "fixture",
        generatedAt: now,
        sourceRevision: 0,
        confirmedAt: null,
        content: {
          title: "합성 원고",
          summary: "미확인",
          sections: [
            {
              key: "technology",
              title: "기술",
              content: "실험 10건을 진행했다고 기재했습니다.",
              evidence: [],
              needsConfirmation: true,
            },
          ],
          actionItems: [],
          interviewQuestions: [],
        },
        review: [
          {
            id: "r1",
            severity: "warning",
            category: "evidence",
            message: "증빙 확인 필요",
            action: "원문 대조",
            sectionKey: "technology",
            sourceIds: [],
          },
        ],
      },
    ],
  });
  const input: ClaimReviewInput = {
    claimId: null,
    previousVersionId: null,
    planId: company.plans[0].id,
    planVersion: 1,
    sectionKey: "technology",
    claimQuote: "실험 10건",
    nature: "unknown",
    references: [],
    contextNote: "실적 확인 필요",
    owner: "",
    dueOn: "",
    nextCheck: "",
    method: "unreviewed",
    externalCheck: { target: "", content: "", occurredOn: "" },
    judgement: { state: "unreviewed", reviewer: "", reason: "", checkedOn: "" },
    numericReferences: [],
    planReviewReferences: [],
  };
  const reader = vi.fn<(id: string) => { source: SourceDocument; buffer: Buffer; sha256: string }>(
    () => {
      throw new Error("Unexpected original read");
    },
  );
  const build = (value = input) =>
    buildClaimReview(
      company,
      value,
      {
        id: randomUUID(),
        clientRequestId: randomUUID(),
        inputDigest: claimReviewInputDigest(value),
        recordedAt: now,
      },
      reader,
    );
  const addSource = (original = false, pending = false) => {
    const source: SourceDocument = {
      id: randomUUID(),
      name: "합성 실험 자료",
      kind: "technology",
      text: pending ? "" : "실험 10건의 기록입니다.",
      originalName: original ? "fixture.pdf" : null,
      mimeType: original ? "application/pdf" : null,
      extraction: pending ? "pending" : "manual",
      warnings: pending ? ["원본 보관, 미검토"] : [],
      createdAt: now,
      updatedAt: now,
    };
    company.sources.push(source);
    const buffer = Buffer.from("synthetic original");
    if (original) reader.mockImplementation(() => ({ source, buffer, sha256: hash(buffer) }));
    input.references.push({
      sourceId: source.id,
      sourceUpdatedAt: source.updatedAt,
      quote: pending ? "" : "실험 10건",
      locator: "1쪽",
    });
    return { source, buffer };
  };
  const addPlanReview = () => {
    const plan = company.plans[0];
    const decision = {
      planId: plan.id,
      planVersion: plan.version,
      findingIndex: 0,
      finding: plan.review[0],
      previousRecordId: null,
      status: "deferred" as const,
      reason: "확인 필요",
      reviewer: "합성 담당자",
    };
    const record = buildPlanReviewDecision(company, decision, 0, {
      id: randomUUID(),
      clientRequestId: randomUUID(),
      inputDigest: planReviewInputDigest(decision),
      recordedAt: now,
    });
    company.planReviewDecisions.push(record);
    input.planReviewReferences.push({ id: record.id, version: record.version });
    return record;
  };
  const addNumeric = () => {
    const check: NumericCheckInput = {
      checkId: null,
      previousVersionId: null,
      title: "합성 수치",
      observations: [
        {
          id: randomUUID(),
          label: "건수",
          valueText: "10",
          unit: "item",
          customUnit: "",
          basis: "reported",
          period: { kind: "unknown", start: "", end: "" },
          reference: {
            kind: "plan",
            planId: input.planId,
            sectionKey: "technology",
            quote: "실험 10건",
          },
          note: "",
        },
      ],
      comparisons: [],
      formulas: [],
      judgement: { state: "unreviewed", reviewer: "", note: "" },
    };
    const record = buildNumericCheck(
      company,
      check,
      {
        id: randomUUID(),
        clientRequestId: randomUUID(),
        inputDigest: numericCheckInputDigest(check),
        recordedAt: now,
      },
      reader,
    );
    company.numericChecks.push(record);
    input.numericReferences.push({ id: record.id, version: record.version });
    return record;
  };
  return { company, input, reader, build, addSource, addPlanReview, addNumeric };
}
const error = (code: string) => expect.objectContaining({ code });
describe("수동 주장 검토의 고정 근거와 버전", () => {
  it("최초 기록은 미검토이며 회사·원고·확정상태를 바꾸지 않는다", () => {
    const { company, build, reader } = fixture();
    const before = structuredClone(company),
      record = build();
    expect(company).toEqual(before);
    expect(record).toMatchObject({
      version: 1,
      claimId: record.id,
      origin: "manual",
      judgement: { state: "unreviewed", recordedAt: null },
    });
    expect(record.planSnapshots[0].contentSha256).toBe(
      hash(JSON.stringify(company.plans[0].content)),
    );
    expect(reader).not.toHaveBeenCalled();
  });
  it("새 원고 같은 항목으로 재연결해도 root와 이전 인용을 보존한다", () => {
    const f = fixture(),
      first = f.build();
    f.company.claimReviews.push(first);
    const plan = structuredClone(f.company.plans[0]);
    plan.id = randomUUID();
    plan.version = 2;
    plan.content.sections[0].content = "실험 12건을 목표로 합니다.";
    f.company.plans.push(plan);
    const second = f.build({
      ...f.input,
      claimId: first.claimId,
      previousVersionId: first.id,
      planId: plan.id,
      planVersion: 2,
      claimQuote: "실험 12건",
      nature: "future-plan",
    });
    f.company.claimReviews.push(second);
    expect(second).toMatchObject({
      claimId: first.claimId,
      version: 2,
      planId: plan.id,
      judgement: { state: "unreviewed" },
    });
    expect(f.company.claimReviews[0]).toEqual(first);
    expect(latestClaimReviews(f.company)).toEqual([second]);
  });
  it("후속 명시 판단만 담당자·이유·확인일과 서버시각을 기록한다", () => {
    const f = fixture(),
      first = f.build();
    f.company.claimReviews.push(first);
    const second = f.build({
      ...f.input,
      claimId: first.claimId,
      previousVersionId: first.id,
      method: "document",
      judgement: {
        state: "insufficient",
        reviewer: "담당자",
        reason: "실제 실행 증빙 필요",
        checkedOn: "2026-09-25",
      },
    });
    expect(second.judgement).toMatchObject({ state: "insufficient", recordedAt: now });
    expect(claimReviewContext(f.company, second).judgementCurrent).toBe(true);
    expect(first.judgement.state).toBe("unreviewed");
  });
  it("다른 항목·없는 root·옛 이전 버전을 거부한다", () => {
    const f = fixture(),
      first = f.build();
    f.company.claimReviews.push(first);
    const base = { ...f.input, claimId: first.id, previousVersionId: first.id };
    expect(() => f.build({ ...base, sectionKey: "market" })).toThrow(
      error("CLAIM_REVIEW_ROOT_MISMATCH"),
    );
    expect(() => f.build({ ...base, claimId: randomUUID() })).toThrow(
      error("CLAIM_REVIEW_NOT_FOUND"),
    );
    expect(() => f.build({ ...base, previousVersionId: randomUUID() })).toThrow(
      error("CLAIM_REVIEW_VERSION_STALE"),
    );
  });
  it.each(["foreign", "version", "quote", "ambiguous", "duplicatePlan"])("원고 %s 경계", (kind) => {
    const f = fixture();
    if (kind === "foreign") f.input.planId = randomUUID();
    if (kind === "version") f.input.planVersion = 2;
    if (kind === "quote") f.input.claimQuote = "실험 11건";
    if (kind === "ambiguous")
      f.company.plans[0].content.sections.push({ ...f.company.plans[0].content.sections[0] });
    if (kind === "duplicatePlan") f.company.plans.push(structuredClone(f.company.plans[0]));
    expect(() => f.build()).toThrow();
  });
  it("같은 원고 ID의 나머지 본문 변조도 고정 해시로 차단한다", () => {
    const f = fixture();
    f.company.claimReviews.push(f.build());
    f.company.plans[0].content.summary = "변조";
    expect(() => f.build()).toThrow(error("CLAIM_PLAN_CHANGED"));
  });
  it("정확 본문만 인용하고 모든 자료 검증 전에는 원본을 읽지 않는다", () => {
    const f = fixture();
    f.addSource(true);
    f.input.references.push({
      sourceId: randomUUID(),
      sourceUpdatedAt: now,
      quote: "실험 10건",
      locator: "",
    });
    expect(() => f.build()).toThrow(error("CLAIM_SOURCE_NOT_FOUND"));
    expect(f.reader).not.toHaveBeenCalled();
  });
  it.each(["stale", "inexact", "blank", "whitespace", "duplicate"])("자료 %s 경계", (kind) => {
    const f = fixture();
    const { source } = f.addSource();
    if (kind === "stale") source.updatedAt = "2026-09-25T01:00:00.000Z";
    if (kind === "inexact") f.input.references[0].quote = "다른 인용";
    if (kind === "blank") f.input.references[0].quote = "";
    if (kind === "whitespace") f.input.references[0].quote = " ";
    if (kind === "duplicate") f.company.sources.push(structuredClone(source));
    expect(() => f.build()).toThrow();
  });
  it("pending 원본은 공란 인용으로만 연결하며 분석 상태를 바꾸지 않는다", () => {
    const f = fixture();
    const { source } = f.addSource(true, true);
    const before = structuredClone(source),
      record = f.build();
    expect(record.sourceSnapshots[0]).toMatchObject({
      extraction: "pending",
      original: { sha256: hash("synthetic original") },
    });
    expect(source).toEqual(before);
    f.input.references[0].quote = "가공 사실";
    expect(() => f.build()).toThrow(error("CLAIM_SOURCE_STALE"));
  });
  it.each(["bytes", "metadata", "reportedHash"])(
    "두 번째 읽기 %s 변경은 기록하지 않는다",
    (kind) => {
      const f = fixture();
      const { source, buffer } = f.addSource(true);
      f.reader
        .mockReturnValueOnce({ source, buffer, sha256: hash(buffer) })
        .mockImplementation(() => {
          const bytes = kind === "bytes" ? Buffer.from("different original") : buffer;
          return {
            source: kind === "metadata" ? { ...source, name: "변경" } : source,
            buffer: bytes,
            sha256: kind === "reportedHash" ? "a".repeat(64) : hash(bytes),
          };
        });
      expect(() => f.build()).toThrow(error("CLAIM_ORIGINAL_CHANGED"));
      expect(f.company.claimReviews).toEqual([]);
    },
  );
  it("공통 이력은 주장 저장 뒤 원본·원고 변조도 다른 기능에 차단한다", () => {
    const f = fixture();
    const { buffer } = f.addSource(true);
    const record = f.build();
    f.company.claimReviews.push(record);
    expect(
      originalConflicts(f.company, {
        ...record.sourceSnapshots[0].original!,
        sha256: hash(Buffer.from(buffer.toString().replace("synthetic", "different"))),
      }),
    ).toBe(true);
    expect(
      planConflicts(f.company, { ...record.planSnapshots[0], contentSha256: "b".repeat(64) }),
    ).toBe(true);
  });
  it("다른 기능에서 고정한 원고 변조를 새 주장으로 덮을 수 없다", () => {
    const f = fixture();
    f.addPlanReview();
    f.company.plans[0].content.summary = "바뀐 본문";
    expect(() => f.build()).toThrow(error("CLAIM_PLAN_CHANGED"));
  });
  it("수치·검토 참고는 고유 ID와 버전을 고정하고 파생 stale는 해시에서 제외한다", () => {
    const f = fixture(),
      review = f.addPlanReview(),
      numeric = f.addNumeric();
    const first = f.build();
    f.company.claimReviews.push(first);
    expect(first.auxiliarySnapshots.map((x) => x.id)).toEqual([numeric.id, review.id]);
    review.stale = true;
    review.staleReasons = ["evidence-changed"];
    expect(() => f.build()).not.toThrow();
    expect(claimReviewContext(f.company, first).state).toBe("stale");
    review.reason = "같은 ID 판단 변조";
    expect(() => f.build()).toThrow(error("CLAIM_AUXILIARY_CHANGED"));
  });
  it.each(["version", "foreign", "otherPlan"])("참고 기록 %s 경계", (kind) => {
    const f = fixture(),
      record = f.addPlanReview();
    if (kind === "version") f.input.planReviewReferences[0].version++;
    if (kind === "foreign") f.input.planReviewReferences[0].id = randomUUID();
    if (kind === "otherPlan") record.planId = randomUUID();
    expect(() => f.build()).toThrow(error("CLAIM_AUXILIARY_INVALID"));
  });
  it("같은 수치 ID의 내용을 바꾸면 후속 연결을 거부한다", () => {
    const f = fixture(),
      numeric = f.addNumeric();
    f.company.claimReviews.push(f.build());
    numeric.title = "변경";
    expect(() => f.build()).toThrow(error("CLAIM_AUXILIARY_CHANGED"));
  });
  it("원고 판단의 저장 원고 버전이 달라지면 현재 문맥과 새 저장 모두 거부한다", () => {
    const f = fixture(),
      target = f.addPlanReview(),
      record = f.build();
    target.planVersion = 2;
    expect(claimReviewContext(f.company, record).state).toBe("stale");
    expect(() => f.build()).toThrow();
  });
  it("복수 원본 합계 24MiB를 넘으면 개별 크기가 작아도 거부한다", () => {
    const f = fixture();
    const entries = [f.addSource(true), f.addSource(true), f.addSource(true)].map(({ source }) => {
      const buffer = Buffer.alloc(9 * 1024 * 1024, 42);
      return { source, buffer, sha256: hash(buffer) };
    });
    f.reader.mockImplementation((id) => entries.find((item) => item.source.id === id)!);
    expect(() => f.build()).toThrow(error("CLAIM_ORIGINAL_LIMIT"));
    expect(f.company.claimReviews).toEqual([]);
  });
  it("11개 근거 연결은 원본을 읽기 전에 거부한다", () => {
    const f = fixture();
    f.input.references = Array.from({ length: 11 }, () => ({
      sourceId: randomUUID(),
      sourceUpdatedAt: now,
      quote: "실험",
      locator: "",
    }));
    expect(() => f.build()).toThrow();
    expect(f.reader).not.toHaveBeenCalled();
  });
  it("자료 변경·삭제 문맥을 파생해도 저장 판단은 그대로 둔다", () => {
    const f = fixture();
    const { source } = f.addSource();
    const first = f.build();
    expect(claimReviewContext(f.company, first).state).toBe("current");
    source.updatedAt = "later";
    expect(claimReviewContext(f.company, first).state).toBe("stale");
    f.company.sources = [];
    expect(claimReviewContext(f.company, first).state).toBe("missing");
    expect(first.judgement.state).toBe("unreviewed");
  });
  it("nonce는 내용이 같을 때만 재사용한다", () => {
    const f = fixture(),
      record = f.build();
    expect(isClaimReviewReplay([record], record.clientRequestId, record.inputDigest)).toBe(true);
    expect(isClaimReviewReplay([record], randomUUID(), record.inputDigest)).toBe(false);
    expect(() => isClaimReviewReplay([record], record.clientRequestId, "a".repeat(64))).toThrow(
      error("CLAIM_REVIEW_REQUEST_CONFLICT"),
    );
    expect(() =>
      isClaimReviewReplay([record, record], record.clientRequestId, record.inputDigest),
    ).toThrow();
  });
  it("전체 버전·전체 문자열·원본 개별 용량 한도를 거부한다", () => {
    const f = fixture(),
      record = f.build();
    expect(() => assertClaimReviewCapacity(Array(201).fill(record))).toThrow(
      error("CLAIM_REVIEW_LIMIT"),
    );
    expect(() =>
      assertClaimReviewCapacity([{ ...record, contextNote: "x".repeat(300001) }]),
    ).toThrow(error("CLAIM_REVIEW_LIMIT"));
    const { source } = f.addSource(true);
    const buffer = Buffer.alloc(12 * 1024 * 1024 + 1);
    f.reader.mockReturnValue({ source, buffer, sha256: hash(buffer) });
    expect(() => f.build()).toThrow(error("CLAIM_ORIGINAL_LIMIT"));
  });
  it.each(["2025-02-29", "2026-13-01", "2026-9-1", "2026-01-01\n"])(
    "잘못된 수동 날짜 %s 거부",
    (dueOn) => {
      const f = fixture();
      expect(claimReviewInputSchema.safeParse({ ...f.input, dueOn }).success).toBe(false);
    },
  );
  it("서버 메타 주입·중복 연결·최초 판단·부분 외부 확인을 거부한다", () => {
    const f = fixture();
    expect(claimReviewInputSchema.safeParse({ ...f.input, id: randomUUID() }).success).toBe(false);
    expect(
      claimReviewInputSchema.safeParse({
        ...f.input,
        judgement: {
          state: "consistent",
          reviewer: "사람",
          reason: "대조",
          checkedOn: "2026-09-25",
        },
        method: "document",
      }).success,
    ).toBe(false);
    expect(claimReviewInputSchema.safeParse({ ...f.input, method: "external" }).success).toBe(
      false,
    );
    expect(
      claimReviewInputSchema.safeParse({
        ...f.input,
        externalCheck: { target: "기관", content: "", occurredOn: "" },
      }).success,
    ).toBe(false);
    f.addSource();
    f.input.references.push({ ...f.input.references[0] });
    expect(claimReviewInputSchema.safeParse(f.input).success).toBe(false);
  });
});
