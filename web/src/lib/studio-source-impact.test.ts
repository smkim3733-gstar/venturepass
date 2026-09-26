import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { caseSchema, emptyProfile, type StudioCase } from "./studio-schema";
import { claimReviewRecordSchema } from "./studio-claim-review-types";
import { responsePreparationSchema } from "./studio-response-preparation-types";
import { appealPreparationSchema } from "./studio-appeal-types";
import { visitAnswerSchema } from "./studio-visit-answer-types";
import { numericCheckSchema, evaluateNumericCheck } from "./studio-numeric-check-types";
import { planReviewDecisionSchema } from "./studio-plan-review-types";
import { diagnosisSchema } from "./studio-diagnosis-types";
import { agencyRecordSchema } from "./studio-agency-records";
import { applicationEventSchema } from "./studio-application-types";
import { candidateSelectionSchema } from "./studio-candidate-selection-types";
import {
  buildSourceImpact,
  sourceImpactDestinationExists,
  sourceImpactLimit,
  sourceImpactNavigationIsCurrent,
} from "./studio-source-impact";
import { SourceImpactPanel } from "@/components/studio/source-impact-panel";

const now = "2026-09-25T00:00:00.000Z";
const later = "2026-09-25T00:00:01.000Z";
const hash = "a".repeat(64);
const quote = "시험 자료의 등록 인용";
const saved = () => ({
  id: randomUUID(),
  clientRequestId: randomUUID(),
  inputDigest: hash,
  origin: "manual",
  recordedAt: now,
});
function fixture(): StudioCase {
  const sourceId = randomUUID();
  return caseSchema.parse({
    id: randomUUID(),
    revision: 1,
    createdAt: now,
    updatedAt: now,
    profile: { ...emptyProfile(), companyName: "합성 자료 영향 기업" },
    sources: [
      {
        id: sourceId,
        name: "합성 기술 문서",
        kind: "technology",
        text: `${quote}\n다른 본문은 출력 대상이 아님`,
        extraction: "manual",
        originalName: null,
        mimeType: null,
        createdAt: now,
        updatedAt: now,
        warnings: [],
      },
    ],
    analysis: null,
    selectedCandidateId: null,
    tasks: [],
    stage: "drafting",
    plans: [
      {
        id: randomUUID(),
        version: 1,
        generatedAt: now,
        mode: "manual",
        candidateId: "candidate",
        sourceRevision: 1,
        confirmedAt: null,
        review: [],
        content: {
          title: "합성 원고",
          summary: "",
          sections: [
            {
              key: "solution",
              title: "신청 기술",
              content: "원고에 적힌 합성 주장",
              evidence: [{ sourceId, quote, locator: "1쪽" }],
              needsConfirmation: true,
            },
          ],
          actionItems: [],
          interviewQuestions: ["합성 질문"],
        },
      },
    ],
  });
}
function ref(company: StudioCase) {
  return {
    sourceId: company.sources[0].id,
    sourceUpdatedAt: company.sources[0].updatedAt,
    quote,
    locator: "1쪽",
  };
}
function snapshot(company: StudioCase) {
  const source = company.sources[0];
  return {
    sourceId: source.id,
    sourceName: source.name,
    sourceUpdatedAt: source.updatedAt,
    extraction: source.extraction,
    textSha256: hash,
    original: null,
  };
}
function planSnapshot(company: StudioCase) {
  return { planId: company.plans[0].id, version: company.plans[0].version, contentSha256: hash };
}
function addClaim(company: StudioCase) {
  const base = saved();
  const plan = company.plans[0];
  const record = claimReviewRecordSchema.parse({
    ...base,
    claimId: base.id,
    previousVersionId: null,
    version: 1,
    planId: plan.id,
    planVersion: plan.version,
    sectionKey: "solution",
    claimQuote: plan.content.sections[0].content,
    nature: "unknown",
    references: [ref(company)],
    sourceSnapshots: [snapshot(company)],
    planSnapshots: [planSnapshot(company)],
    numericReferences: [],
    planReviewReferences: [],
    auxiliarySnapshots: [],
    contextNote: "",
    owner: "",
    dueOn: "",
    nextCheck: "",
    method: "unreviewed",
    externalCheck: { target: "", content: "", occurredOn: "" },
    judgement: { state: "unreviewed", reviewer: "", reason: "", checkedOn: "", recordedAt: null },
  });
  company.claimReviews.push(record);
  return record;
}
function rows(company: StudioCase) {
  return buildSourceImpact(company).groups.flatMap((group) => group.rows);
}
function claimRow(company: StudioCase) {
  return rows(company).find((row) => row.target.kind === "claim")!;
}
function candidate(company: StudioCase) {
  return {
    id: "candidate",
    title: "합성 후보",
    problem: "",
    solution: "",
    targetCustomer: "",
    differentiation: "",
    stage: "",
    businessModel: "",
    recommendation: "",
    evidence: [{ sourceId: company.sources[0].id, quote, locator: "1쪽" }],
    gaps: [],
  };
}
function addAllArtifacts(company: StudioCase) {
  const candidateRecord = candidate(company);
  company.analysis = {
    generatedAt: now,
    mode: "assisted",
    sourceRevision: 1,
    summary: "",
    candidates: [candidateRecord],
    facts: [
      {
        id: "fact",
        statement: "합성 기재",
        status: "unverified",
        evidence: candidateRecord.evidence,
      },
    ],
    questions: [],
    warnings: [],
  };
  company.candidateSelections.push(
    candidateSelectionSchema.parse({
      ...saved(),
      event: "selection",
      reason: "합성 선택 이유",
      previousCandidateId: null,
      candidateId: candidateRecord.id,
      analysisGeneratedAt: now,
      analysisSourceRevision: 1,
      analysisMode: "assisted",
      analysisDigest: hash,
      candidateDigest: hash,
      candidate: candidateRecord,
      previousCandidate: null,
      previousContext: "none",
      previousRecordId: null,
    }),
  );
  company.diagnoses.push(
    diagnosisSchema.parse({
      id: randomUUID(),
      clientRequestId: randomUUID(),
      requestDigest: hash,
      version: 1,
      sourceRevision: 1,
      inputFingerprint: hash,
      criteriaVersion: "test",
      generatedAt: now,
      stale: false,
      mode: "assisted",
      outcome: "insufficient",
      items: [
        {
          id: "technology",
          title: "기술 기재",
          area: "technology",
          status: "unknown",
          reason: "검토 필요",
          evidence: [
            { ...ref(company), sourceName: company.sources[0].name, provenance: "reported" },
          ],
          unknowns: [],
          nextActions: [],
        },
      ],
      questions: [],
      actions: [],
      warnings: [],
    }),
  );
  const decisionBase = saved();
  company.planReviewDecisions.push(
    planReviewDecisionSchema.parse({
      ...decisionBase,
      rootId: decisionBase.id,
      version: 1,
      planId: company.plans[0].id,
      planVersion: 1,
      findingIndex: 0,
      finding: {
        id: "finding",
        severity: "warning",
        category: "근거 확인",
        message: "합성 확인 의견",
        action: "대조",
        sectionKey: "solution",
        sourceIds: [company.sources[0].id],
      },
      previousRecordId: null,
      status: "pending",
      reason: "확인 필요",
      reviewer: "담당",
      reviewKey: hash,
      planContentSha256: hash,
      findingSha256: hash,
      planSourceRevision: 1,
      evidenceRevision: 1,
      evidenceFingerprint: hash,
      stale: false,
      staleReasons: [],
    }),
  );
  addClaim(company);
  const responseBase = saved();
  company.responsePreparations.push(
    responsePreparationSchema.parse({
      ...responseBase,
      preparationId: responseBase.id,
      previousVersionId: null,
      version: 1,
      mode: "assisted",
      reviewStatus: "unreviewed",
      requestRecordId: randomUUID(),
      requestVersionId: randomUUID(),
      title: "답변 준비",
      items: [
        {
          id: randomUUID(),
          requestQuote: "요청 인용",
          summary: "합성 답변 항목",
          planClaim: null,
          evidence: [ref(company)],
          gap: "",
          draft: "확인 전 답변",
        },
      ],
      sourceSnapshots: [snapshot(company)],
      planSnapshots: [],
    }),
  );
  const appealBase = saved();
  company.appealPreparations.push(
    appealPreparationSchema.parse({
      ...appealBase,
      preparationId: appealBase.id,
      previousVersionId: null,
      version: 1,
      noticeRecordId: randomUUID(),
      noticeVersionId: randomUUID(),
      title: "소명 준비",
      intent: "undecided",
      intentNote: "",
      deadlineOn: "",
      deadlineNote: "",
      reasons: [
        {
          id: randomUUID(),
          noticeField: "body",
          noticeQuote: "통보 인용",
          claim: "소명 기재",
          planClaim: null,
          gap: "",
          evidence: [ref(company)],
          additionalEvidence: [],
          draft: "",
        },
      ],
      review: { reviewedAt: null, reviewer: "", note: "" },
      sourceSnapshots: [snapshot(company)],
      planSnapshots: [],
    }),
  );
  const visitBase = saved();
  company.visitAnswers.push(
    visitAnswerSchema.parse({
      ...visitBase,
      answerId: visitBase.id,
      previousVersionId: null,
      version: 1,
      planId: company.plans[0].id,
      questionIndex: 0,
      questionText: "합성 질문",
      submissionRecordId: null,
      respondentRole: "representative",
      respondentName: "",
      answerText: "합성 답변",
      pairs: [
        {
          id: randomUUID(),
          answerQuote: "합성 답변",
          planReference: null,
          sources: [ref(company)],
          contextNote: "",
        },
      ],
      followUpNote: "",
      questionSnapshot: {
        planId: company.plans[0].id,
        planVersion: 1,
        planTitle: company.plans[0].content.title,
        planContentSha256: hash,
        questionIndex: 0,
        questionText: "합성 질문",
        questionSha256: hash,
      },
      submissionSnapshot: null,
      sourceSnapshots: [snapshot(company)],
      checkVersion: "paired-spelling-v1",
      checks: [],
      review: { reviewedAt: null, reviewer: "", note: "" },
    }),
  );
  const numberBase = saved();
  const numberInput = {
    observations: [
      {
        id: randomUUID(),
        label: "합성 수치",
        valueText: "",
        unit: "unknown" as const,
        customUnit: "",
        period: { kind: "unknown" as const, start: "", end: "" },
        basis: "unknown" as const,
        reference: { kind: "source" as const, ...ref(company) },
        note: "",
      },
    ],
    comparisons: [],
    formulas: [],
  };
  company.numericChecks.push(
    numericCheckSchema.parse({
      ...numberBase,
      checkId: numberBase.id,
      previousVersionId: null,
      version: 1,
      title: "수치 대조",
      ...numberInput,
      sourceSnapshots: [snapshot(company)],
      planSnapshots: [],
      evaluation: evaluateNumericCheck(numberInput),
      judgement: { state: "unreviewed", reviewer: "", note: "", recordedAt: null },
    }),
  );
}

describe("explicit source impact projection", () => {
  it("keeps legacy section evidence unknown even when the exact quote is present", () => {
    const company = fixture();
    expect(rows(company)[0]).toMatchObject({
      state: "unknown",
      binding: "quote-only",
      reasons: ["VERSION_UNAVAILABLE"],
      target: { kind: "plan-section", id: company.plans[0].id, partId: "solution" },
    });
  });
  it("reports exact missing quote without inferring which sentence in the section changed", () => {
    const company = fixture();
    company.sources[0].text = "다른 등록 본문";
    expect(rows(company)[0]).toMatchObject({
      state: "changed",
      reasons: ["QUOTE_MISSING"],
      excerpt: "",
      target: { kind: "plan-section", sectionKey: "solution" },
    });
  });
  it("matches a versioned reference only within registered metadata and quotes", () => {
    const company = fixture();
    const record = addClaim(company);
    expect(claimRow(company)).toMatchObject({
      state: "current",
      reasons: [],
      binding: "versioned-reference",
      excerpt: record.claimQuote,
      target: { kind: "claim", id: record.id, partId: record.claimId, version: 1 },
      destination: { tab: "plan" },
    });
  });
  it.each([
    [
      "timestamp",
      (company: StudioCase) => {
        company.sources[0].updatedAt = later;
      },
      "VERSION_CHANGED",
    ],
    [
      "name",
      (company: StudioCase) => {
        company.sources[0].name = "정정 자료명";
      },
      "METADATA_CHANGED",
    ],
    [
      "quote",
      (company: StudioCase) => {
        company.sources[0].text = "인용 삭제";
      },
      "QUOTE_MISSING",
    ],
    [
      "extraction",
      (company: StudioCase) => {
        company.sources[0].extraction = "pending";
        company.sources[0].text = "";
      },
      "BODY_PENDING",
    ],
    [
      "original",
      (company: StudioCase) => {
        company.sources[0].originalName = "새 원본.pdf";
      },
      "METADATA_CHANGED",
    ],
  ] as const)("identifies %s changes at the exact versioned target", (_name, change, reason) => {
    const company = fixture();
    addClaim(company);
    change(company);
    expect(claimRow(company).state).toBe("changed");
    expect(claimRow(company).reasons).toContain(reason);
  });
  it("does not normalize whitespace in quotes", () => {
    const company = fixture();
    addClaim(company);
    company.sources[0].text = quote.replaceAll(" ", "  ");
    expect(claimRow(company).reasons).toContain("QUOTE_MISSING");
  });
  it("records missing versioned sources but does not invent prior existence for ID-only links", () => {
    const company = fixture();
    addClaim(company);
    company.sources = [];
    expect(claimRow(company).state).toBe("changed");
    expect(rows(company).find((row) => row.target.kind === "plan-section")?.state).toBe("unknown");
  });
  it("fails closed for duplicate current source identities", () => {
    const company = fixture();
    addClaim(company);
    company.sources.push(structuredClone(company.sources[0]));
    expect(claimRow(company)).toMatchObject({ state: "unknown", reasons: ["SOURCE_AMBIGUOUS"] });
  });
  it.each(["missing", "duplicate", "conflicting-version"])(
    "does not confirm %s frozen snapshots",
    (mode) => {
      const company = fixture();
      const record = addClaim(company);
      if (mode === "missing") record.sourceSnapshots = [];
      else if (mode === "duplicate")
        record.sourceSnapshots.push(structuredClone(record.sourceSnapshots[0]));
      else record.sourceSnapshots[0].sourceUpdatedAt = later;
      expect(claimRow(company).state).toBe("unknown");
      expect(claimRow(company).reasons[0]).toMatch(/^SNAPSHOT_/);
    },
  );
  it("does not attribute stale plan context to an unchanged linked source", () => {
    const company = fixture();
    addClaim(company);
    company.plans[0].content.sections[0].content = "원고만 정정";
    expect(claimRow(company)).toMatchObject({ state: "current", context: "stale", reasons: [] });
  });
  it("keeps each claim version's plan ID and historical status distinct", () => {
    const company = fixture();
    const before = addClaim(company);
    const second = structuredClone(before);
    second.id = randomUUID();
    second.previousVersionId = before.id;
    second.version = 2;
    const plan = structuredClone(company.plans[0]);
    plan.id = randomUUID();
    plan.version = 2;
    company.plans.push(plan);
    second.planId = plan.id;
    second.planVersion = 2;
    second.planSnapshots = [{ planId: plan.id, version: 2, contentSha256: hash }];
    company.claimReviews.push(second);
    const found = rows(company).filter((row) => row.target.kind === "claim");
    expect(found.map((row) => [row.target.id, row.target.planId, row.historical])).toEqual([
      [before.id, before.planId, true],
      [second.id, second.planId, false],
    ]);
  });
  it("keeps profile references unversioned and unrelated sources explicitly unlinked", () => {
    const company = fixture();
    company.plans[0].content.sections[0].evidence[0].sourceId = "profile";
    const result = buildSourceImpact(company);
    expect(result.groups.find((group) => group.sourceId === company.sources[0].id)?.rows).toEqual(
      [],
    );
    expect(result.groups.find((group) => group.sourceId === "profile")?.rows[0]).toMatchObject({
      state: "unknown",
      reasons: ["PROFILE_UNVERSIONED"],
    });
  });
  it("collects candidates, preserved selection, diagnosis, review, claims, answer pairs and numbers with exact part IDs", () => {
    const company = fixture();
    addAllArtifacts(company);
    const result = rows(company);
    expect(new Set(result.map((row) => row.target.kind))).toEqual(
      new Set([
        "candidate",
        "fact",
        "candidate-selection",
        "plan-section",
        "diagnosis",
        "plan-review",
        "claim",
        "appeal",
        "response",
        "visit",
        "numeric",
      ]),
    );
    expect(result.find((row) => row.target.kind === "response")?.target.partId).toBe(
      company.responsePreparations[0].items[0].id,
    );
    expect(result.find((row) => row.target.kind === "visit")?.target.partId).toBe(
      company.visitAnswers[0].pairs[0].id,
    );
    expect(result.find((row) => row.target.kind === "numeric")?.target.partId).toBe(
      company.numericChecks[0].observations[0].id,
    );
    company.analysis = null;
    expect(rows(company).some((row) => row.target.kind === "candidate-selection")).toBe(true);
    expect(rows(company).some((row) => row.target.kind === "candidate")).toBe(false);
  });
  it("does not propagate source effects through a plan reference or infer unlinked meaning", () => {
    const company = fixture();
    addAllArtifacts(company);
    company.visitAnswers[0].pairs[0].sources = [];
    company.visitAnswers[0].pairs[0].planReference = {
      sectionKey: "solution",
      quote: company.plans[0].content.sections[0].content,
    };
    expect(rows(company).some((row) => row.target.kind === "visit")).toBe(false);
  });
  it("compares original metadata while preserving agency and submission snapshots as historical", () => {
    const company = fixture();
    const source = company.sources[0];
    source.originalName = "합성.pdf";
    source.mimeType = "application/pdf";
    const original = {
      sourceId: source.id,
      sourceName: source.name,
      originalName: source.originalName,
      mimeType: source.mimeType,
      sizeBytes: 100,
      sha256: hash,
      sourceUpdatedAt: now,
    };
    const agencyBase = saved();
    company.agencyRecords.push(
      agencyRecordSchema.parse({
        ...agencyBase,
        kind: "request",
        requestRecordId: agencyBase.id,
        requestVersionId: agencyBase.id,
        previousVersionId: null,
        version: 1,
        institution: "합성 기관",
        title: "합성 요청",
        body: "합성 본문",
        occurredOn: "",
        dueOn: "",
        dueNote: "",
        note: "",
        responseStatus: null,
        evidence: [{ ...original, capturedAt: now }],
      }),
    );
    const submissionBase = saved();
    const plan = company.plans[0];
    company.applicationEvents.push(
      applicationEventSchema.parse({
        ...submissionBase,
        kind: "submission-recorded",
        applicationId: randomUUID(),
        submissionRecordId: submissionBase.id,
        previousVersionId: null,
        version: 1,
        occurredOn: "2026-09-25",
        recordedBy: "합성 담당자",
        note: "",
        claim: "reported-submitted",
        officialVerification: "unverified",
        companySnapshot: {
          caseId: company.id,
          revision: company.revision,
          companyName: company.profile.companyName,
          businessNumber: "",
        },
        plan: {
          id: plan.id,
          version: plan.version,
          generatedAt: now,
          mode: "manual",
          candidateId: "candidate",
          sourceRevision: 1,
          contentSha256: hash,
          confirmedAt: null,
          review: [],
          sections: [{ key: "solution", needsConfirmation: true }],
          latestVersion: true,
          currentEvidence: false,
        },
        evidence: [
          { ...ref(company), sourceName: source.name, sectionKey: "solution", state: "matched" },
        ],
        originals: [original],
        owners: [],
        receiptRecordId: null,
      }),
    );
    const before = JSON.stringify([company.agencyRecords, company.applicationEvents]);
    expect(
      rows(company)
        .filter((row) => row.target.kind === "agency" || row.target.kind === "submission")
        .every((row) => row.historical && row.state === "current"),
    ).toBe(true);
    source.originalName = "정정.pdf";
    const originals = rows(company).filter(
      (row) => row.target.kind === "agency" || row.target.partId?.startsWith("original:"),
    );
    expect(originals).toHaveLength(2);
    expect(
      originals.every((row) => row.state === "changed" && row.reasons.includes("METADATA_CHANGED")),
    ).toBe(true);
    expect(JSON.stringify([company.agencyRecords, company.applicationEvents])).toBe(before);
  });
  it("is deterministic and leaves serialized company, judgement and frozen records untouched", () => {
    const company = fixture();
    addAllArtifacts(company);
    company.sources[0].updatedAt = later;
    const before = JSON.stringify(company);
    expect(buildSourceImpact(company)).toEqual(buildSourceImpact(company));
    expect(JSON.stringify(company)).toBe(before);
    expect(company.claimReviews[0].judgement.state).toBe("unreviewed");
    expect(company.plans[0].confirmedAt).toBeNull();
  });
  it("checks destination membership without redirecting a deleted exact record to a later one", () => {
    const company = fixture();
    const before = addClaim(company);
    const destination = claimRow(company).destination;
    expect(sourceImpactDestinationExists(company, destination)).toBe(true);
    company.claimReviews = [{ ...before, id: randomUUID(), version: 2 }];
    expect(sourceImpactDestinationExists(company, destination)).toBe(false);
    expect(sourceImpactDestinationExists(fixture(), destination)).toBe(false);
  });
  it("bounds output, deduplicates identical references and states truncation", () => {
    const company = fixture();
    const section = company.plans[0].content.sections[0];
    section.evidence = Array.from({ length: sourceImpactLimit + 1 }, (_, index) => ({
      sourceId: company.sources[0].id,
      quote,
      locator: `위치 ${index}`,
    }));
    section.evidence.unshift({ ...section.evidence[0] });
    const result = buildSourceImpact(company);
    expect(result.truncated).toBe(true);
    expect(result.counts.unknown).toBe(sourceImpactLimit);
    expect(result.groups[0].rows).toHaveLength(sourceImpactLimit);
  });
  it("bounds displayed quotes and excerpts without truncating the comparison input", () => {
    const company = fixture();
    const record = addClaim(company);
    const text = "가".repeat(600);
    record.references[0].quote = text;
    company.sources[0].text = `${text.slice(0, 599)}나`;
    record.claimQuote = "나".repeat(600);
    const result = claimRow(company);
    expect(result.reasons).toContain("QUOTE_MISSING");
    expect(result.quote.length).toBe(301);
    expect(result.excerpt.length).toBe(301);
    expect(result.key.length).toBeLessThan(30);
  });
});

describe("explicit auxiliary links and navigation binding", () => {
  function bound(kind: "numeric" | "plan-review" = "numeric") {
    const company = fixture();
    addAllArtifacts(company);
    const claim = company.claimReviews[0];
    claim.references = [];
    claim.sourceSnapshots = [];
    const auxiliary =
      kind === "numeric" ? company.numericChecks[0] : company.planReviewDecisions[0];
    const reference = { id: auxiliary.id, version: auxiliary.version };
    if (kind === "numeric") claim.numericReferences = [reference];
    else claim.planReviewReferences = [reference];
    claim.auxiliarySnapshots = [
      {
        kind,
        ...reference,
        inputDigest: auxiliary.inputDigest,
        recordedAt: auxiliary.recordedAt,
        contentSha256: hash,
      },
    ];
    return { company, claim, auxiliary };
  }
  it("follows exact numeric ID/version and shows the source-to-number-to-claim path", () => {
    const { company, auxiliary } = bound();
    expect(claimRow(company)).toMatchObject({
      state: "current",
      via: {
        kind: "numeric",
        id: auxiliary.id,
        version: auxiliary.version,
        partId: company.numericChecks[0].observations[0].id,
      },
    });
    company.sources[0].updatedAt = later;
    expect(claimRow(company)).toMatchObject({ state: "changed", reasons: ["VERSION_CHANGED"] });
    const html = renderToStaticMarkup(
      createElement(SourceImpactPanel, { company, onNavigate: vi.fn() }),
    );
    expect(html).toContain("명시한 보조 기록 경유");
    expect(html).toContain(auxiliary.id);
  });
  it("does not promote ID-only finding sources to versioned claim evidence", () => {
    const { company, auxiliary } = bound("plan-review");
    expect(claimRow(company)).toMatchObject({
      state: "unknown",
      reasons: ["ID_ONLY"],
      via: { kind: "plan-review", id: auxiliary.id },
    });
  });
  it.each(["missing", "duplicate", "version", "digest", "time", "snapshot"])(
    "keeps %s auxiliary links unresolved without inventing source IDs",
    (change) => {
      const { company, claim, auxiliary } = bound();
      if (change === "missing") company.numericChecks = [];
      else if (change === "duplicate")
        company.numericChecks.push(structuredClone(company.numericChecks[0]));
      else if (change === "version") auxiliary.version += 1;
      else if (change === "digest") auxiliary.inputDigest = "b".repeat(64);
      else if (change === "time") auxiliary.recordedAt = later;
      else claim.auxiliarySnapshots = [];
      const result = buildSourceImpact(company);
      expect(result.unresolved).toHaveLength(1);
      expect(result.unresolved[0]).toMatchObject({
        state: "unknown",
        target: { id: claim.id },
        via: { id: auxiliary.id },
      });
      expect(result.unresolved[0]).not.toHaveProperty("sourceId");
      expect(
        result.groups.every((group) => group.rows.every((row) => row.target.kind !== "claim")),
      ).toBe(true);
      expect(sourceImpactDestinationExists(company, result.unresolved[0].destination)).toBe(true);
      const html = renderToStaticMarkup(
        createElement(SourceImpactPanel, { company, onNavigate: vi.fn() }),
      );
      expect(html).toContain("자료를 특정할 수 없는 보조 기록 연결");
    },
  );
  it("does not infer a source through an auxiliary plan quote", () => {
    const { company } = bound();
    company.numericChecks[0].observations[0].reference = {
      kind: "plan",
      planId: company.plans[0].id,
      sectionKey: "solution",
      quote: company.plans[0].content.sections[0].content,
    };
    expect(buildSourceImpact(company).unresolved[0].reason).toBe("AUXILIARY_NO_SOURCE");
  });
  it("checks company, revision and exact target before accepting navigation", () => {
    const company = fixture();
    addClaim(company);
    const input = {
      caseId: company.id,
      revision: company.revision,
      destination: claimRow(company).destination,
    };
    expect(sourceImpactNavigationIsCurrent(company, input)).toBe(true);
    expect(sourceImpactNavigationIsCurrent(company, { ...input, caseId: randomUUID() })).toBe(
      false,
    );
    expect(sourceImpactNavigationIsCurrent(company, { ...input, revision: 0 })).toBe(false);
    expect(
      sourceImpactNavigationIsCurrent(company, {
        ...input,
        destination: {
          ...input.destination,
          target: { ...input.destination.target, id: randomUUID() },
        },
      }),
    ).toBe(false);
  });
});

describe("source impact UI scope", () => {
  it("shows exact changed target, historical preservation and original-check limits without executing callbacks", () => {
    const company = fixture();
    addClaim(company);
    company.sources[0].updatedAt = later;
    const navigate = vi.fn();
    const html = renderToStaticMarkup(
      createElement(SourceImpactPanel, { company, onNavigate: navigate }),
    );
    expect(html).toContain(company.claimReviews[0].id);
    expect(html).toContain("연결 자료 변경 확인");
    expect(html).toContain("SHA는 여기서 재검사하지 않습니다");
    expect(html).toContain("그대로 보존");
    expect(html).toContain("의미상 영향");
    expect(html).not.toContain("다른 본문은 출력 대상이 아님");
    expect(navigate).not.toHaveBeenCalled();
  });
  it("does not present absence of links as absence of impact", () => {
    const company = fixture();
    company.plans = [];
    const html = renderToStaticMarkup(
      createElement(SourceImpactPanel, { company, onNavigate: vi.fn() }),
    );
    expect(html).toContain("연결 없음은 영향 없음이나 검토 완료를 뜻하지 않습니다");
  });
  it("shows a busy navigation block and escapes stored source/target text", () => {
    const company = fixture();
    company.sources[0].name = "<script>합성</script>";
    const html = renderToStaticMarkup(
      createElement(SourceImpactPanel, {
        company,
        onNavigate: vi.fn(),
        blockedReason: "저장 진행 중",
      }),
    );
    expect(html).not.toContain("<script>합성</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>연결 대상 화면에서 재확인/);
  });
});
