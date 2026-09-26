import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { caseSchema, emptyProfile, type StudioCase } from "@/lib/studio-schema";
import {
  applicationEventSchema,
  applicationCycleSchema,
  type ApplicationSubmission,
} from "@/lib/studio-application-types";
import { buildVisitAnswer } from "@/lib/studio-visit-answer";
import type { VisitAnswer } from "@/lib/studio-visit-answer-types";
import { VISIT_PACKAGE_DOWNLOAD_NAME } from "@/lib/studio-visit-package-types";
import { PACKAGE_DOWNLOAD_NAME } from "@/lib/studio-package-types";
import { visitAnswerInputFor } from "./visit-answers";
import { readPackageDownload } from "./package-panel";
import {
  VisitPackagePanel,
  VisitPackageChoices,
  emptyVisitPackageSelection,
  changeVisitPackageBasis,
  resolveVisitPackageBasis,
  selectedVisitPackageAnswers,
  visitPackageSources,
  visitPackageRequestFor,
  visitPackageAnswerEligible,
  type VisitPackageSelection,
} from "./visit-package-panel";
import { WorkflowPanel } from "./workflow-panel";

const id = (number: number) => `${String(number).padStart(8, "0")}-1111-4111-8111-111111111111`;
const now = "2026-09-25T00:00:00.000Z";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function company(): StudioCase {
  return caseSchema.parse({
    id: id(1),
    revision: 3,
    createdAt: now,
    updatedAt: now,
    profile: { ...emptyProfile(), companyName: "현재 합성기업" },
    sources: [4, 5, 6, 7].map((number) => ({
      id: id(number),
      name: `합성 자료 ${number}`,
      kind: "technology",
      text: "",
      originalName: `synthetic-${number}.pdf`,
      mimeType: "application/pdf",
      extraction: "pending",
      warnings: [],
      createdAt: now,
      updatedAt: now,
    })),
    plans: [1, 2].map((version) => ({
      id: id(version + 1),
      version,
      generatedAt: now,
      mode: "manual",
      sourceRevision: 3,
      candidateId: "synthetic",
      content: {
        title: `합성 원고 ${version}`,
        summary: "",
        sections: [
          {
            key: "technology",
            title: "기술",
            content: "검증 10건",
            evidence: [{ sourceId: id(4), quote: "", locator: "합성 위치" }],
            needsConfirmation: true,
          },
        ],
        actionItems: [],
        interviewQuestions: ["검증 상태는?", "검증 상태는?"],
      },
      review: [],
      confirmedAt: null,
    })),
    analysis: null,
    selectedCandidateId: null,
    tasks: [],
    stage: "preparing",
  });
}
function answer(state: StudioCase, number = 10): VisitAnswer {
  const input = visitAnswerInputFor(state.plans[0], 0);
  input.respondentName = "합성 설명 담당자";
  input.answerText = "검증 10건 수행했다는 진술";
  input.pairs = [
    {
      id: id(number + 100),
      answerQuote: "검증 10건",
      planReference: { sectionKey: "technology", quote: "검증 10건" },
      sources: [{ sourceId: id(5), sourceUpdatedAt: now, quote: "", locator: "합성 1쪽" }],
      contextNote: "대상 확인 필요",
    },
  ];
  const bytes = Buffer.from("fake");
  return buildVisitAnswer(
    state,
    input,
    {
      id: id(number),
      clientRequestId: id(number + 200),
      inputDigest: "a".repeat(64),
      recordedAt: now,
    },
    (sourceId) => ({
      source: state.sources.find((source) => source.id === sourceId)!,
      buffer: bytes,
      sha256: hash(bytes.toString()),
    }),
  );
}
function addSubmission(state: StudioCase): ApplicationSubmission {
  state.applications.push(
    applicationCycleSchema.parse({
      id: id(20),
      clientRequestId: id(21),
      inputDigest: "a".repeat(64),
      recordedAt: now,
      origin: "manual",
      title: "합성 신청",
      kind: "new",
      plannedOn: "",
      criteriaNote: "",
      previousApplicationId: null,
      companyAtCreation: { companyName: "당시 합성기업", businessNumber: "" },
    }),
  );
  const plan = state.plans[0];
  const stored = applicationEventSchema.parse({
    kind: "submission-recorded",
    id: id(22),
    applicationId: id(20),
    submissionRecordId: id(22),
    previousVersionId: null,
    version: 1,
    clientRequestId: id(23),
    inputDigest: "b".repeat(64),
    recordedAt: now,
    origin: "manual",
    occurredOn: "2026-09-24",
    recordedBy: "합성 제출 기록자",
    note: "수동 기재",
    claim: "reported-submitted",
    officialVerification: "unverified",
    companySnapshot: {
      caseId: state.id,
      revision: 2,
      companyName: "당시 합성기업",
      businessNumber: "",
    },
    plan: {
      id: plan.id,
      version: plan.version,
      generatedAt: plan.generatedAt,
      mode: plan.mode,
      candidateId: plan.candidateId,
      sourceRevision: plan.sourceRevision,
      contentSha256: hash(JSON.stringify(plan.content)),
      confirmedAt: null,
      review: [],
      sections: [{ key: "technology", needsConfirmation: true }],
      latestVersion: false,
      currentEvidence: false,
    },
    evidence: [],
    owners: [],
    receiptRecordId: null,
    originals: [
      {
        sourceId: id(6),
        sourceName: "당시 제출자료",
        originalName: "synthetic-6.pdf",
        mimeType: "application/pdf",
        sizeBytes: 4,
        sha256: hash("fake"),
        sourceUpdatedAt: now,
      },
    ],
  });
  state.applicationEvents.push(stored);
  return stored as ApplicationSubmission;
}
function draft(): VisitPackageSelection {
  return { ...changeVisitPackageBasis("draft", id(2)), answerVersionIds: [id(10)], sourceIds: [] };
}
function choices(state: StudioCase, selection: VisitPackageSelection, disabled = false) {
  return renderToStaticMarkup(
    createElement(VisitPackageChoices, { company: state, selection, disabled, onChange: vi.fn() }),
  );
}

describe("exact visit package selection", () => {
  it("begins without mode, manuscript, answer or source and clears subordinate selections on basis changes", () => {
    expect(emptyVisitPackageSelection()).toEqual({
      mode: "",
      basisId: "",
      answerVersionIds: [],
      sourceIds: [],
    });
    expect(changeVisitPackageBasis("recorded-submission", id(22))).toEqual({
      mode: "recorded-submission",
      basisId: id(22),
      answerVersionIds: [],
      sourceIds: [],
    });
    expect(visitPackageRequestFor(company(), emptyVisitPackageSelection())).toBeNull();
  });
  it("chooses an exact old draft and supports question-only output", () => {
    const state = company();
    const selection = changeVisitPackageBasis("draft", id(2));
    expect(resolveVisitPackageBasis(state, selection)?.plan.version).toBe(1);
    expect(visitPackageRequestFor(state, selection)).toEqual({
      revision: 3,
      mode: "draft",
      planId: id(2),
      submissionRecordId: null,
      answerVersionIds: [],
      sourceIds: [],
    });
  });
  it("binds a historical submission to its exact company and manuscript version", () => {
    const state = company(),
      submission = addSubmission(state);
    const selection = changeVisitPackageBasis("recorded-submission", submission.id);
    const basis = resolveVisitPackageBasis(state, selection)!;
    expect(basis.plan.version).toBe(1);
    expect(basis.submission?.companySnapshot.companyName).toBe("당시 합성기업");
    expect(visitPackageRequestFor(state, selection)?.submissionRecordId).toBe(submission.id);
  });
  it.each([
    "missing",
    "duplicate-plan",
    "duplicate-submission",
    "foreign-company",
    "foreign-cycle",
    "version",
  ])("rejects ambiguous or foreign submission basis: %s", (kind) => {
    const state = company(),
      submission = addSubmission(state);
    if (kind === "missing") state.plans = [];
    if (kind === "duplicate-plan") state.plans.push(structuredClone(state.plans[0]));
    if (kind === "duplicate-submission") state.applicationEvents.push(structuredClone(submission));
    if (kind === "foreign-company") submission.companySnapshot.caseId = id(30);
    if (kind === "foreign-cycle") state.applications = [];
    if (kind === "version") submission.plan.version = 999;
    expect(
      resolveVisitPackageBasis(
        state,
        changeVisitPackageBasis("recorded-submission", submission.id),
      ),
    ).toBeNull();
  });
  it("allows one exact answer version per root and never substitutes latest", () => {
    const state = company(),
      old = answer(state),
      next = {
        ...old,
        id: id(11),
        previousVersionId: old.id,
        version: 2,
        answerText: "후속 변경 답변",
      };
    state.visitAnswers = [old, next];
    const basis = resolveVisitPackageBasis(state, draft())!;
    expect(selectedVisitPackageAnswers(state, basis, [old.id])?.[0].answerText).toBe(
      old.answerText,
    );
    expect(selectedVisitPackageAnswers(state, basis, [old.id, next.id])).toBeNull();
    expect(selectedVisitPackageAnswers(state, basis, [old.id, old.id])).toBeNull();
    expect(selectedVisitPackageAnswers(state, basis, [id(99)])).toBeNull();
  });
  it.each(["plan", "question", "index", "snapshot-version", "duplicate-id"])(
    "rejects changed exact answer binding: %s",
    (kind) => {
      const state = company(),
        stored = answer(state);
      state.visitAnswers = [stored];
      if (kind === "plan") stored.planId = id(3);
      if (kind === "question") stored.questionText = "변경된 질문";
      if (kind === "index") stored.questionIndex = 1;
      if (kind === "snapshot-version") stored.questionSnapshot.planVersion = 2;
      if (kind === "duplicate-id") state.visitAnswers.push(structuredClone(stored));
      expect(visitPackageRequestFor(state, draft())).toBeNull();
    },
  );
  it("permits unlinked answers for recorded mode without retroactive affiliation, rejects other submission roots", () => {
    const state = company(),
      stored = answer(state),
      submission = addSubmission(state);
    state.visitAnswers = [stored];
    const basis = resolveVisitPackageBasis(
      state,
      changeVisitPackageBasis("recorded-submission", submission.id),
    )!;
    expect(visitPackageAnswerEligible(state, basis, stored)).toBe(true);
    stored.submissionRecordId = submission.id;
    stored.submissionSnapshot = {
      id: submission.id,
      applicationId: submission.applicationId,
      version: submission.version,
      recordedAt: now,
      planContentSha256: submission.plan.contentSha256,
    };
    expect(visitPackageAnswerEligible(state, basis, stored)).toBe(true);
    expect(
      visitPackageAnswerEligible(state, resolveVisitPackageBasis(state, draft())!, stored),
    ).toBe(false);
    stored.submissionRecordId = id(88);
    expect(visitPackageAnswerEligible(state, basis, stored)).toBe(false);
  });
  it("offers only union of selected-answer, plan-evidence and submission originals", () => {
    const state = company(),
      stored = answer(state),
      submission = addSubmission(state);
    state.visitAnswers = [stored];
    const basis = resolveVisitPackageBasis(
      state,
      changeVisitPackageBasis("recorded-submission", submission.id),
    )!;
    expect(
      visitPackageSources(state, basis, [stored]).map(({ source, historical }) => [
        source.id,
        historical,
      ]),
    ).toEqual([
      [id(4), false],
      [id(5), true],
      [id(6), true],
    ]);
    expect(visitPackageSources(state, basis, []).map(({ source }) => source.id)).toEqual([
      id(4),
      id(6),
    ]);
    expect(visitPackageRequestFor(state, { ...draft(), sourceIds: [id(7)] })).toBeNull();
    expect(visitPackageRequestFor(state, { ...draft(), sourceIds: [id(5)] })?.sourceIds).toEqual([
      id(5),
    ]);
  });
  it("rejects duplicate originals or originals without a current unique file while preserving metadata-only output", () => {
    const state = company(),
      stored = answer(state);
    state.visitAnswers = [stored];
    expect(visitPackageRequestFor(state, { ...draft(), sourceIds: [id(5), id(5)] })).toBeNull();
    state.sources = state.sources.filter((source) => source.id !== id(5));
    expect(visitPackageRequestFor(state, { ...draft(), sourceIds: [id(5)] })).toBeNull();
    expect(visitPackageRequestFor(state, draft())).not.toBeNull();
    state.sources.push(structuredClone(state.sources[0]));
    expect(visitPackageRequestFor(state, { ...draft(), sourceIds: [id(4)] })).toBeNull();
  });
  it("caps explicit answer selections at 20", () => {
    const state = company();
    state.visitAnswers = Array.from({ length: 21 }, (_, index) => answer(state, 1000 + index));
    const basis = resolveVisitPackageBasis(state, draft())!;
    expect(
      selectedVisitPackageAnswers(
        state,
        basis,
        state.visitAnswers.map((stored) => stored.id),
      ),
    ).toBeNull();
  });
});

describe("visit package UI boundaries", () => {
  it("does not select or download anything on render", () => {
    const busy = vi.fn(),
      state = company();
    const html = renderToStaticMarkup(
      createElement(VisitPackagePanel, { company: state, onBusyChange: busy }),
    );
    expect(html).toContain("DRAFT · 로컬 실사 준비");
    expect(html).toContain("최신 버전·답변·원본을 자동 선택하지 않습니다");
    expect(html).not.toContain('checked=""');
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>[^<]*<svg[\s\S]*선택한 실사 준비 ZIP 내려받기/,
    );
    expect(busy).not.toHaveBeenCalled();
    expect(html).toContain("다운로드 성공·실패 후 옵션은 유지");
  });
  it("honors sibling edits and mounts through workflow without registering manual submissions", () => {
    const state = company();
    const html = renderToStaticMarkup(
      createElement(VisitPackagePanel, {
        company: state,
        blockedReason: "답변 편집 먼저 저장",
        onBusyChange: vi.fn(),
      }),
    );
    expect(html).toContain('<fieldset disabled=""');
    expect(html).toContain("답변 편집 먼저 저장");
    const mutate = vi.fn();
    const workflow = renderToStaticMarkup(
      createElement(WorkflowPanel, { company: state, mutate, setDirty: vi.fn() }),
    );
    expect(workflow).toContain("실사 질문·답변 출력 묶음");
    expect(mutate).not.toHaveBeenCalled();
  });
  it("displays exact old answer and same-root restriction with no approval claims", () => {
    const state = company(),
      old = answer(state);
    state.visitAnswers = [old, { ...old, id: id(11), previousVersionId: old.id, version: 2 }];
    const html = choices(state, draft());
    expect(html).toContain("선택 원고 v1");
    expect(html).toContain("답변 v1");
    expect(html).toContain("미검토 답변");
    expect(html).toContain("다른 버전을 이미 선택했습니다");
    expect(html).toContain("제출 기록 미연결 · 이번 선택으로 소급 귀속하지 않음");
    expect(html).toContain("선택된 작성 답변이 없는 질문: 1개");
    expect(html).toContain("현재 원고 근거 파일 별도 선택 · 과거 원본 일치 미보장");
    expect(html).toContain("저장 당시 원본 식별값 있음 · 생성 시 SHA 대조");
  });
  it("separates current company from manually recorded historical submission context", () => {
    const state = company(),
      submission = addSubmission(state);
    const html = choices(state, changeVisitPackageBasis("recorded-submission", submission.id));
    expect(html).toContain("당시 기업명: 당시 합성기업 · 현재 기업명: 현재 합성기업");
    expect(html).toContain("공식 제출·기관 수신 미확인");
    expect(html).toContain("수동 제출 기록 v1");
  });
  it("preserves historical source names and exact answer text while flagging changed current context", () => {
    const state = company(),
      stored = answer(state);
    state.visitAnswers = [stored];
    state.sources.find((source) => source.id === id(5))!.name = "새 자료 이름";
    state.sources.find((source) => source.id === id(5))!.updatedAt = "2026-09-26T00:00:00.000Z";
    stored.answerText = "<script>synthetic()</script>";
    const html = choices(state, draft());
    expect(html).toContain("합성 자료 5 · 저장 기준");
    expect(html).toContain("현재 연결 재확인 필요");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("원본만 보관 · 본문 확인 필요");
  });
  it("supports no manuscript/no answer/no original without inventing content", () => {
    const state = company();
    state.sources = [];
    let html = choices(state, changeVisitPackageBasis("draft", id(2)));
    expect(html).toContain("질문·미응답 안내만 출력할 수 있습니다");
    expect(html).toContain("원본 미포함으로 출력할 수 있습니다");
    state.plans = [];
    html = choices(state, changeVisitPackageBasis("draft", id(2)));
    expect(html).toContain("고유하게 찾을 수 없습니다");
    expect(html).not.toContain("선택 원고 v1");
  });
});

describe("shared bounded ZIP reader fixed-name contract", () => {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]);
  function response(name: string, type = "application/zip", size = "5") {
    return new Response(bytes, {
      headers: {
        "Content-Type": type,
        "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "Content-Length": size,
      },
    });
  }
  it("accepts visit ZIP only when caller expects its exact fixed name", async () => {
    expect(
      (
        await readPackageDownload(
          response(VISIT_PACKAGE_DOWNLOAD_NAME),
          VISIT_PACKAGE_DOWNLOAD_NAME,
        )
      ).filename,
    ).toBe(VISIT_PACKAGE_DOWNLOAD_NAME);
    await expect(readPackageDownload(response(VISIT_PACKAGE_DOWNLOAD_NAME))).rejects.toThrow(
      "파일 이름",
    );
    await expect(
      readPackageDownload(response(PACKAGE_DOWNLOAD_NAME), VISIT_PACKAGE_DOWNLOAD_NAME),
    ).rejects.toThrow("파일 이름");
    expect((await readPackageDownload(response(PACKAGE_DOWNLOAD_NAME))).filename).toBe(
      PACKAGE_DOWNLOAD_NAME,
    );
  });
  it("retains content type and declared length safeguards for the new archive", async () => {
    await expect(
      readPackageDownload(
        response(VISIT_PACKAGE_DOWNLOAD_NAME, "text/html"),
        VISIT_PACKAGE_DOWNLOAD_NAME,
      ),
    ).rejects.toThrow("ZIP 형식");
    await expect(
      readPackageDownload(
        response(VISIT_PACKAGE_DOWNLOAD_NAME, "application/zip", "6"),
        VISIT_PACKAGE_DOWNLOAD_NAME,
      ),
    ).rejects.toThrow("완전하지");
  });
  it("rejects unsafe caller configuration before allowing any download", async () => {
    await expect(
      readPackageDownload(response(VISIT_PACKAGE_DOWNLOAD_NAME), "../outside.zip"),
    ).rejects.toThrow("설정");
  });
});
