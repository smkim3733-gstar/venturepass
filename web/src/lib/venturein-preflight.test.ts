import { emptyDiagnosisAnswers } from "./studio-diagnosis-types";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { emptyProfile, type StudioCase } from "./studio-schema";
import type { VentureScreenField } from "./venturein-inspection";
import {
  buildVenturePreflight,
  buildVentureInputReadiness,
  ventureFieldSupport,
  ventureSubmissionDraftSchema,
  type VenturePreflightInput,
} from "./venturein-preflight";

const caseId = "11111111-1111-4111-8111-111111111111";
const planId = "22222222-2222-4222-8222-222222222222";
const sourceId = "33333333-3333-4333-8333-333333333333";
const now = "2026-09-25T01:00:00.000Z";
function textField(key: string, required = true): VentureScreenField {
  return {
    key,
    kind: "input",
    id: key,
    name: key,
    type: "text",
    labels: ["공식 테스트 항목"],
    required,
    maxLength: 100,
    accept: null,
    multiple: false,
    disabled: false,
    readOnly: false,
    options: [],
  };
}
function fixture(): VenturePreflightInput {
  const company: StudioCase = {
    id: caseId,
    profile: { ...emptyProfile(), companyName: "가상테스트", businessNumber: "123-45-67890" },
    sources: [
      {
        id: sourceId,
        name: "가상 원본",
        kind: "technology",
        text: "실제 고객 자료가 아닙니다.",
        originalName: "테스트.PDF",
        mimeType: "application/pdf",
        extraction: "local",
        warnings: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    analysis: null,
    selectedCandidateId: "candidate-test",
    tasks: [],
    stage: "drafting",
    stageHistory: [],
    agencyRecords: [],
    sourceOcrReviews: [],
    diagnosisAnswers: emptyDiagnosisAnswers(),
    diagnoses: [],
    preparationRuns: [],
    appealPreparations: [],
    applications: [],
    applicationEvents: [],
    responsePreparations: [],
    visitAnswers: [],
    planReviewDecisions: [],
    numericChecks: [],
    candidateSelections: [],
    companyContacts: [],
    claimReviews: [],
    sourceIntakes: [],
    sourceSuggestionAdoptions: [],
    applicationProcedures: [],
    criteriaVersions: [],
    applicationCriteriaBindings: [],
    preparationAutomation: { caseId: null, settings: [], events: [], batches: [], overflow: null },
    revision: 5,
    createdAt: now,
    updatedAt: now,
    plans: [
      {
        id: planId,
        version: 1,
        generatedAt: now,
        mode: "manual",
        candidateId: "candidate-test",
        sourceRevision: 4,
        confirmedAt: now,
        review: [],
        content: {
          title: "가상 사업계획서",
          summary: "테스트",
          actionItems: [],
          interviewQuestions: [],
          sections: [
            {
              key: "solution",
              title: "해결 기술",
              content: "검증된 가상 내용",
              needsConfirmation: false,
              evidence: [],
            },
          ],
        },
      },
    ],
  };
  return {
    company,
    snapshot: {
      caseId,
      accountRevision: 2,
      sessionStartedAt: now,
      screen: {
        id: "snapshot-test",
        observedAt: now,
        url: "https://www.smes.go.kr/venturein/aply/v2",
        title: "가상 공식 항목",
        truncated: false,
        warnings: [],
        companyEvidence: [
          { kind: "businessNumber", label: "사업자등록번호", value: "1234567890", source: "input" },
        ],
        fields: [
          textField("company"),
          { ...textField("technology"), kind: "textarea", type: "textarea", maxLength: 20 },
          {
            ...textField("document", false),
            kind: "file",
            type: "file",
            maxLength: null,
            accept: ".pdf",
          },
        ],
      },
    },
    draft: {
      caseId,
      snapshotId: "snapshot-test",
      sessionStartedAt: now,
      accountRevision: 2,
      companyRevision: 5,
      planId,
      planVersion: 1,
      textMappings: [
        {
          fieldKey: "company",
          source: { kind: "profile", property: "companyName" },
          confirmed: true,
        },
        {
          fieldKey: "technology",
          source: { kind: "plan-section", sectionKey: "solution" },
          confirmed: true,
        },
      ],
      attachmentMappings: [
        { fieldKey: "document", sourceId, sourceUpdatedAt: now, confirmed: true },
      ],
    },
    session: { state: "connected_unmapped", message: "가상 연결", startedAt: now, updatedAt: now },
    accountRevision: 2,
    planIsCurrent: true,
    originalFiles: [
      {
        sourceId,
        originalName: "테스트.PDF",
        mimeType: "application/pdf",
        sizeBytes: 1234,
        exists: true,
      },
    ],
  };
}
const codes = (input: VenturePreflightInput) =>
  buildVenturePreflight(input).issues.map((issue) => issue.code);

function selectedProfileFixture() {
  const input = fixture();
  input.draft!.textMappings = [input.draft!.textMappings[0]];
  input.draft!.attachmentMappings = [];
  return input;
}

describe("선택한 입력 범위와 전체 제출 준비의 분리", () => {
  it("계획서 없는 profile 입력은 준비하되 전체 제출 준비 오류를 지우지 않는다", () => {
    const input = financialFixture();
    const report = buildVenturePreflight(input);
    expect(report.readyForLocalReview).toBe(false);
    expect(report.automaticSubmissionAvailable).toBe(false);
    expect(report.inputReadiness).toMatchObject({ ready: true, blockingIssues: [] });
    expect(report.inputReadiness.deferredIssues).toContainEqual(
      expect.objectContaining({ code: "PLAN_MISSING", severity: "error" }),
    );
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "PLAN_MISSING", severity: "error" }),
    );
  });

  it("계획서 없는 파일 전용 준비도 기업·원본 검증을 통과한 경우에만 가능하다", () => {
    const input = fixture();
    input.company.plans = [];
    input.draft!.planId = null;
    input.draft!.planVersion = null;
    input.draft!.textMappings = [];
    const report = buildVenturePreflight(input);
    expect(report.inputReadiness.ready).toBe(true);
    expect(report.readyForLocalReview).toBe(false);
    expect(report.attachments).toHaveLength(1);
    expect(report.inputReadiness.deferredIssues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["PLAN_MISSING", "REQUIRED_FIELD_UNMAPPED"]),
    );
  });

  it("미선택 필수·읽기 전용·동의 항목은 별도 보완으로 남기며 자동 완료로 바꾸지 않는다", () => {
    const input = financialFixture();
    input.snapshot!.screen.fields.push(
      textField("other-required"),
      { ...textField("fixed"), readOnly: true },
      { ...textField("agreement", false), type: "checkbox", labels: ["개인정보 동의"] },
    );
    const report = buildVenturePreflight(input);
    expect(report.inputReadiness.ready).toBe(true);
    expect(report.readyForLocalReview).toBe(false);
    expect(report.inputReadiness.deferredIssues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "PLAN_MISSING",
        "REQUIRED_FIELD_UNMAPPED",
        "UNSUPPORTED_FIELD",
        "AGREEMENT_REQUIRES_USER",
      ]),
    );
    expect(
      report.issues.some(
        (issue) => issue.code === "AGREEMENT_REQUIRES_USER" && issue.severity === "error",
      ),
    ).toBe(true);
  });

  it.each([
    "PLAN_MISSING",
    "PLAN_SUPERSEDED",
    "PLAN_STALE",
    "PLAN_UNCONFIRMED",
    "PLAN_REVIEW_ERROR",
    "PLAN_NEEDS_CONFIRMATION",
  ])("%s는 profile-only에만 defer하고 해석 불가능한 원고 선택에도 block한다", (code) => {
    const input = selectedProfileFixture();
    const report = buildVenturePreflight(input);
    const issue = { code, severity: "error" as const, message: "계획서 검토 필요" };
    const context = {
      issues: [issue],
      draft: input.draft,
      screen: input.snapshot!.screen,
      textFields: report.textFields,
      attachments: report.attachments,
    };
    const before = structuredClone(context);
    expect(buildVentureInputReadiness(context)).toEqual({
      ready: true,
      blockingIssues: [],
      deferredIssues: [issue],
    });
    expect(context).toEqual(before);
    input.draft!.textMappings.push({
      fieldKey: "technology",
      source: { kind: "plan-section", sectionKey: "missing-section" },
      confirmed: true,
    });
    expect(buildVentureInputReadiness(context)).toEqual({
      ready: false,
      blockingIssues: [issue],
      deferredIssues: [],
    });
  });

  it.each(["REQUIRED_FIELD_UNMAPPED", "UNSUPPORTED_FIELD", "AGREEMENT_REQUIRES_USER"])(
    "%s는 실제 미선택 field에만 defer하고 같은 field를 선택하면 block한다",
    (code) => {
      const input = selectedProfileFixture();
      const report = buildVenturePreflight(input);
      const issue = {
        code,
        severity: "error" as const,
        message: "직접 확인",
        fieldKey: "technology",
      };
      const context = {
        issues: [issue],
        draft: input.draft,
        screen: input.snapshot!.screen,
        textFields: report.textFields,
        attachments: report.attachments,
      };
      expect(buildVentureInputReadiness(context).ready).toBe(true);
      input.draft!.textMappings.push({
        fieldKey: "technology",
        source: { kind: "profile", property: "technologySummary" },
        confirmed: true,
      });
      expect(buildVentureInputReadiness(context)).toEqual({
        ready: false,
        blockingIssues: [issue],
        deferredIssues: [],
      });
    },
  );

  it.each([undefined, "not-observed"])(
    "defer 대상 코드라도 fieldKey %s는 전역·불명확 오류로 차단한다",
    (fieldKey) => {
      const input = selectedProfileFixture();
      const report = buildVenturePreflight(input);
      const issue = {
        code: "UNSUPPORTED_FIELD",
        severity: "error" as const,
        message: "불명확",
        ...(fieldKey && { fieldKey }),
      };
      expect(
        buildVentureInputReadiness({
          issues: [issue],
          draft: input.draft,
          screen: input.snapshot!.screen,
          textFields: report.textFields,
          attachments: report.attachments,
        }),
      ).toEqual({ ready: false, blockingIssues: [issue], deferredIssues: [] });
    },
  );

  it.each([
    "UNSUPPORTED_REQUIRED_CONTROL",
    "DRAFT_PLAN_STALE",
    "COMPANY_NOT_VERIFIED",
    "SESSION_NOT_CONNECTED",
    "SNAPSHOT_SESSION_MISMATCH",
    "DRAFT_COMPANY_STALE",
    "UNKNOWN_FIELD",
    "FUTURE_UNKNOWN_ERROR",
  ])("%s는 미선택 field에 붙어도 항상 block한다", (code) => {
    const input = selectedProfileFixture();
    const report = buildVenturePreflight(input);
    const issue = {
      code,
      severity: "error" as const,
      message: "검증 실패",
      fieldKey: "technology",
    };
    expect(
      buildVentureInputReadiness({
        issues: [issue],
        draft: input.draft,
        screen: input.snapshot!.screen,
        textFields: report.textFields,
        attachments: report.attachments,
      }),
    ).toEqual({ ready: false, blockingIssues: [issue], deferredIssues: [] });
  });

  it("collector의 fieldKey 없는 필수 선택 경고는 개별 동의 defer와 별개로 계속 차단한다", () => {
    const input = financialFixture();
    input.snapshot!.screen.fields.push({
      ...textField("agreement"),
      type: "checkbox",
      labels: ["약관 동의"],
    });
    input.snapshot!.screen.warnings.push(
      "UNSUPPORTED_REQUIRED_CONTROL: 필수 동의는 별도 확인이 필요합니다.",
    );
    const report = buildVenturePreflight(input);
    expect(report.inputReadiness.ready).toBe(false);
    expect(report.inputReadiness.blockingIssues.map((issue) => issue.code)).toContain(
      "UNSUPPORTED_REQUIRED_CONTROL",
    );
    expect(report.inputReadiness.deferredIssues.map((issue) => issue.code)).toContain(
      "AGREEMENT_REQUIRES_USER",
    );
  });

  it.each([
    "company-missing",
    "company-mismatch",
    "snapshot-session",
    "account",
    "session",
    "draft-company",
    "draft-plan",
    "unknown-target",
    "unconfirmed-text",
    "unconfirmed-file",
    "format",
    "length",
    "missing-original",
    "file-type",
  ])("선택 범위의 %s 검증은 계속 차단한다", (condition) => {
    const input = fixture();
    if (condition === "company-missing") input.snapshot!.screen.companyEvidence = [];
    if (condition === "company-mismatch") input.company.profile.businessNumber = "9999999999";
    if (condition === "snapshot-session")
      input.snapshot!.sessionStartedAt = "2026-09-24T01:00:00.000Z";
    if (condition === "account") input.accountRevision += 1;
    if (condition === "session") input.session.state = "awaiting_auth";
    if (condition === "draft-company") input.draft!.companyRevision -= 1;
    if (condition === "draft-plan") input.draft!.planVersion = 99;
    if (condition === "unknown-target") input.draft!.textMappings[0].fieldKey = "unknown";
    if (condition === "unconfirmed-text") input.draft!.textMappings[0].confirmed = false;
    if (condition === "unconfirmed-file") input.draft!.attachmentMappings[0].confirmed = false;
    if (condition === "format") input.snapshot!.screen.fields[0].type = "number";
    if (condition === "length") input.snapshot!.screen.fields[0].maxLength = 1;
    if (condition === "missing-original") input.originalFiles = [];
    if (condition === "file-type") input.snapshot!.screen.fields[2].accept = ".xlsx";
    const report = buildVenturePreflight(input);
    expect(report.inputReadiness.ready).toBe(false);
    expect(report.inputReadiness.blockingIssues.length).toBeGreaterThan(0);
  });

  it.each(["", "   "])(
    "선택한 optional 값 %j도 실행 준비에서 차단하며 전체 issues는 변경하지 않는다",
    (value) => {
      const input = selectedProfileFixture();
      input.company.profile.companyName = value;
      input.snapshot!.screen.fields.forEach((field) => {
        field.required = false;
      });
      const report = buildVenturePreflight(input);
      expect(report.readyForLocalReview).toBe(true);
      expect(report.issues.every((issue) => issue.severity === "warning")).toBe(true);
      expect(report.inputReadiness.ready).toBe(false);
      expect(report.inputReadiness.blockingIssues).toContainEqual(
        expect.objectContaining({ code: "INPUT_VALUE_EMPTY", fieldKey: "company" }),
      );
    },
  );

  it("선택 mapping이 없으면 전체 검토가 통과해도 실행 준비는 하지 않는다", () => {
    const input = selectedProfileFixture();
    input.draft!.textMappings = [];
    input.snapshot!.screen.fields.forEach((field) => {
      field.required = false;
    });
    const report = buildVenturePreflight(input);
    expect(report.readyForLocalReview).toBe(true);
    expect(report.inputReadiness).toMatchObject({ ready: false, deferredIssues: [] });
    expect(report.inputReadiness.blockingIssues.map((issue) => issue.code)).toContain(
      "INPUT_TARGETS_MISSING",
    );
  });

  it.each(["single-text", "total-text", "targets"])(
    "입력 %s 실행 한도는 전체 제출 판정과 별도로 차단한다",
    (kind) => {
      const input = selectedProfileFixture();
      const count = kind === "targets" ? 51 : kind === "total-text" ? 6 : 1;
      input.company.profile.customers = "x".repeat(
        kind === "single-text" ? 20_001 : kind === "total-text" ? 18_000 : 1,
      );
      input.snapshot!.screen.fields = Array.from({ length: count }, (_, index) => ({
        ...textField(`field-${index}`, false),
        maxLength: null,
      }));
      input.draft!.textMappings = input.snapshot!.screen.fields.map((field) => ({
        fieldKey: field.key,
        source: { kind: "profile" as const, property: "customers" as const },
        confirmed: true,
      }));
      const report = buildVenturePreflight(input);
      expect(report.readyForLocalReview).toBe(true);
      expect(report.inputReadiness.blockingIssues.map((issue) => issue.code)).toContain(
        "INPUT_LIMIT",
      );
    },
  );

  it.each(["single-file", "total-files", "file-count"])(
    "첨부 %s 실행 한도를 준비 단계에서도 차단한다",
    (kind) => {
      const input = fixture();
      input.draft!.textMappings = [];
      input.snapshot!.screen.fields[2].multiple = true;
      const count = kind === "file-count" ? 11 : kind === "total-files" ? 3 : 1;
      const size =
        kind === "single-file"
          ? 12 * 1024 * 1024 + 1
          : kind === "total-files"
            ? 9 * 1024 * 1024
            : 1;
      const source = input.company.sources[0];
      input.company.sources = Array.from({ length: count }, (_, index) => ({
        ...source,
        id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
        originalName: `file-${index}.pdf`,
      }));
      input.originalFiles = input.company.sources.map((source) => ({
        sourceId: source.id,
        originalName: source.originalName!,
        mimeType: source.mimeType,
        sizeBytes: size,
        exists: true,
      }));
      input.draft!.attachmentMappings = input.company.sources.map((source) => ({
        fieldKey: "document",
        sourceId: source.id,
        sourceUpdatedAt: now,
        confirmed: true,
      }));
      const report = buildVenturePreflight(input);
      expect(report.inputReadiness.blockingIssues.map((issue) => issue.code)).toContain(
        "INPUT_FILE_LIMIT",
      );
    },
  );
});

function financialFixture() {
  const input = fixture();
  input.company.plans = [];
  input.company.profile.paidInCapital = "5000000";
  input.company.profile.closingMonth = "12";
  input.company.profile.financials = "가상 자료: 전기 재무제표 기준. 현재 변경 여부 확인 필요.";
  input.draft!.planId = null;
  input.draft!.planVersion = null;
  input.draft!.attachmentMappings = [];
  input.draft!.textMappings = [
    {
      fieldKey: "capital",
      source: { kind: "profile", property: "paidInCapital" },
      confirmed: true,
    },
    { fieldKey: "month", source: { kind: "profile", property: "closingMonth" }, confirmed: true },
  ];
  input.snapshot!.screen.fields = [
    { ...textField("capital"), type: "number", labels: ["납입자본금(원)"] },
    {
      ...textField("month"),
      kind: "select",
      type: "select-one",
      labels: ["결산월"],
      options: [{ value: "12", label: "12월", disabled: false }],
    },
  ];
  return input;
}

describe("구조화한 재무 항목의 로컬 검토", () => {
  it("계획서 없이 정확한 입력값과 근거를 미리 보되 제출 준비로 판정하지 않는다", () => {
    const input = financialFixture();
    const result = buildVenturePreflight(input);
    expect(
      result.textFields.map(({ value, financialContext }) => ({ value, financialContext })),
    ).toEqual([
      {
        value: "5000000",
        financialContext: { unit: "원", evidenceNote: input.company.profile.financials },
      },
      {
        value: "12",
        financialContext: { unit: "월", evidenceNote: input.company.profile.financials },
      },
    ]);
    expect(result.issues.map((issue) => issue.code)).toContain("PLAN_MISSING");
    expect(result.issues.map((issue) => issue.code)).not.toContain("DRAFT_PLAN_STALE");
    expect(result.readyForLocalReview).toBe(false);
    expect(result.automaticSubmissionAvailable).toBe(false);
  });

  it.each([
    "empty-capital",
    "empty-month",
    "wrong-option",
    "disabled-option",
    "max-length",
    "unconfirmed",
  ])("계획서 없는 연결에서도 %s 검사를 유지한다", (condition) => {
    const input = financialFixture();
    const expected = {
      "empty-capital": "REQUIRED_VALUE_EMPTY",
      "empty-month": "REQUIRED_VALUE_EMPTY",
      "wrong-option": "SELECT_VALUE_MISMATCH",
      "disabled-option": "SELECT_VALUE_MISMATCH",
      "max-length": "TEXT_TOO_LONG",
      unconfirmed: "MAPPING_UNCONFIRMED",
    }[condition];
    if (condition === "empty-capital") input.company.profile.paidInCapital = "";
    if (condition === "empty-month") input.company.profile.closingMonth = "";
    if (condition === "wrong-option") input.snapshot!.screen.fields[1].options[0].value = "12월";
    if (condition === "disabled-option")
      input.snapshot!.screen.fields[1].options[0].disabled = true;
    if (condition === "max-length") input.snapshot!.screen.fields[0].maxLength = 3;
    if (condition === "unconfirmed") input.draft!.textMappings[0].confirmed = false;
    expect(codes(input)).toContain(expected);
  });

  it.each(["section-without-plan", "missing-plan", "new-plan"])(
    "%s일 때 기존 계획서 연결 검사를 우회하지 않는다",
    (condition) => {
      const input = financialFixture();
      if (condition === "section-without-plan")
        input.draft!.textMappings[0].source = { kind: "plan-section", sectionKey: "solution" };
      if (condition === "missing-plan") {
        input.draft!.planId = planId;
        input.draft!.planVersion = 1;
      }
      if (condition === "new-plan") input.company.plans = fixture().company.plans;
      const result = buildVenturePreflight(input);
      expect(result.issues.map((issue) => issue.code)).toContain("DRAFT_PLAN_STALE");
      expect(result.textFields).toEqual([]);
      expect(result.attachments).toEqual([]);
      expect(result.readyForLocalReview).toBe(false);
    },
  );

  it("금액·근거가 변경되면 이전 확인 표시를 새 값에 적용하지 않는다", () => {
    const input = financialFixture();
    input.company.revision += 1;
    input.company.profile.paidInCapital = "7000000";
    input.company.profile.financials = "변경된 가상 근거";
    const result = buildVenturePreflight(input);
    expect(result.issues.map((issue) => issue.code)).toContain("DRAFT_COMPANY_STALE");
    expect(result.textFields).toEqual([]);
    expect(result.attachments).toEqual([]);
    expect(result.readyForLocalReview).toBe(false);
  });

  it("근거 메모가 비어도 값을 메모에서 추측하거나 단위를 바꾸지 않는다", () => {
    const input = financialFixture();
    input.company.profile.financials = "";
    const result = buildVenturePreflight(input);
    expect(result.textFields[0]).toMatchObject({
      value: "5000000",
      financialContext: { unit: "원", evidenceNote: "" },
    });
  });
});

describe("벤처인 로컬 대응표와 사전 점검", () => {
  it("확인한 대응 관계만 그대로 미리 보며 외부 제출은 항상 비활성이다", () => {
    const input = fixture();
    const before = JSON.stringify(input);
    const result = buildVenturePreflight(input);
    expect(result.readyForLocalReview).toBe(true);
    expect(result.automaticSubmissionAvailable).toBe(false);
    expect(result.companyVerification?.status).toBe("matched");
    expect(result.textFields.map((field) => field.value)).toEqual([
      "가상테스트",
      "검증된 가상 내용",
    ]);
    expect(result.attachments[0]).toMatchObject({
      sourceId,
      originalName: "테스트.PDF",
      sizeBytes: 1234,
    });
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "EXTERNAL_SUBMISSION_DISABLED",
        "CURRENT_SCREEN_ONLY",
        "FILE_SIZE_LIMIT_UNKNOWN",
      ]),
    );
    expect(JSON.stringify(input)).toBe(before);
  });

  it("초기 상태에서 화면·대응표·계획서·연결 누락을 구분한다", () => {
    const input = fixture();
    input.snapshot = null;
    input.draft = null;
    input.company.plans = [];
    input.session = { state: "idle", startedAt: null, updatedAt: null, message: "가상 연결 전" };
    const result = buildVenturePreflight(input);
    expect(result.readyForLocalReview).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "SNAPSHOT_MISSING",
        "DRAFT_MISSING",
        "PLAN_MISSING",
        "SESSION_NOT_CONNECTED",
      ]),
    );
  });

  it.each(["name-only", "masked", "different", "ambiguous", "local-number-invalid"])(
    "사업자번호를 정확히 확인하지 못하면 기업명을 근거로 승인하지 않는다: %s",
    (condition) => {
      const input = fixture();
      const screen = input.snapshot!.screen;
      if (condition === "name-only")
        screen.companyEvidence = [
          {
            kind: "companyName",
            label: "기업명",
            value: input.company.profile.companyName,
            source: "table",
          },
        ];
      if (condition === "masked") screen.companyEvidence[0].value = "123-45-*****";
      if (condition === "different") screen.companyEvidence[0].value = "9999999999";
      if (condition === "ambiguous")
        screen.companyEvidence.push({ ...screen.companyEvidence[0], value: "9999999999" });
      if (condition === "local-number-invalid")
        input.company.profile.businessNumber = "1234567890extra";
      expect(codes(input)).toContain("COMPANY_NOT_VERIFIED");
      expect(buildVenturePreflight(input).readyForLocalReview).toBe(false);
    },
  );

  it.each(["http", "lookalike", "auth", "truncated"])(
    "공식 확인이 불완전한 화면을 승인하지 않는다: %s",
    (condition) => {
      const input = fixture();
      if (condition === "http")
        input.snapshot!.screen.url = "http://www.smes.go.kr/venturein/aply/v2";
      if (condition === "lookalike")
        input.snapshot!.screen.url = "https://www.smes.go.kr.attacker.test/venturein/aply/v2";
      if (condition === "auth")
        input.snapshot!.screen.url = "https://www.smes.go.kr/venturein/auth/viewLogin";
      if (condition === "truncated") input.snapshot!.screen.truncated = true;
      expect(buildVenturePreflight(input).readyForLocalReview).toBe(false);
      expect(codes(input)).toContain("COMPANY_NOT_VERIFIED");
    },
  );

  it.each([
    "snapshot-replaced",
    "snapshot-case",
    "snapshot-session",
    "account",
    "draft-case",
    "draft-session",
  ])("기업·화면·세션 바인딩이 바뀌면 이전 대응표의 내용도 재사용하지 않는다: %s", (condition) => {
    const input = fixture();
    const later = "2026-09-25T02:00:00.000Z";
    if (condition === "snapshot-replaced") input.snapshot!.screen.id = "snapshot-new";
    if (condition === "snapshot-case") input.snapshot!.caseId = planId;
    if (condition === "snapshot-session") input.snapshot!.sessionStartedAt = later;
    if (condition === "account") input.accountRevision++;
    if (condition === "draft-case") input.draft!.caseId = planId;
    if (condition === "draft-session") input.draft!.sessionStartedAt = later;
    const result = buildVenturePreflight(input);
    expect(result.readyForLocalReview).toBe(false);
    expect(result.textFields).toEqual([]);
    expect(result.attachments).toEqual([]);
  });

  it("기업 revision과 작성본 버전 변경을 각각 보고한다", () => {
    const input = fixture();
    input.company.revision++;
    expect(codes(input)).toContain("DRAFT_COMPANY_STALE");
    input.company.plans[0].version++;
    expect(codes(input)).toContain("DRAFT_PLAN_STALE");
    expect(buildVenturePreflight(input).textFields).toEqual([]);
  });

  it("오래된 근거·미검토·검토 오류·확인 필요 문단을 모두 차단한다", () => {
    const input = fixture();
    input.planIsCurrent = false;
    const plan = input.company.plans[0];
    plan.confirmedAt = null;
    plan.content.sections[0].needsConfirmation = true;
    plan.review.push({
      id: "error",
      severity: "error",
      category: "test",
      message: "테스트 오류",
      action: "확인",
      sectionKey: null,
      sourceIds: [],
    });
    expect(codes(input)).toEqual(
      expect.arrayContaining([
        "PLAN_STALE",
        "PLAN_UNCONFIRMED",
        "PLAN_REVIEW_ERROR",
        "PLAN_NEEDS_CONFIRMATION",
      ]),
    );
  });

  it("수동 확인하지 않은 대응표를 임의 승인하지 않는다", () => {
    const input = fixture();
    input.draft!.textMappings[0].confirmed = false;
    input.draft!.attachmentMappings[0].confirmed = false;
    const result = buildVenturePreflight(input);
    expect(result.issues.filter((issue) => issue.code === "MAPPING_UNCONFIRMED")).toHaveLength(2);
    expect(result.readyForLocalReview).toBe(false);
  });

  it("필수 항목 미연결·빈 값·UTF-16 길이 초과를 구분하며 원문을 자르지 않는다", () => {
    const input = fixture();
    input.company.profile.companyName = " ";
    input.company.plans[0].content.sections[0].content = "가😀";
    input.snapshot!.screen.fields[1].maxLength = 2;
    input.snapshot!.screen.fields.push(textField("missing"));
    const result = buildVenturePreflight(input);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["REQUIRED_VALUE_EMPTY", "TEXT_TOO_LONG", "REQUIRED_FIELD_UNMAPPED"]),
    );
    expect(result.textFields[1]).toMatchObject({ value: "가😀", characterCount: 3 });
  });

  it("누락·중복 작성본 항목과 공식 항목 식별자를 거부한다", () => {
    const input = fixture();
    input.company.plans[0].content.sections.push({ ...input.company.plans[0].content.sections[0] });
    input.snapshot!.screen.fields.push({ ...input.snapshot!.screen.fields[0] });
    expect(codes(input)).toEqual(
      expect.arrayContaining(["PLAN_SECTION_MISSING", "DUPLICATE_FIELD_KEY"]),
    );
    input.company.plans[0].content.sections = [];
    expect(codes(input)).toContain("PLAN_SECTION_MISSING");
  });

  it("중복 텍스트 대응과 사라진 공식 항목을 차단한다", () => {
    const input = fixture();
    input.draft!.textMappings.push({ ...input.draft!.textMappings[0] });
    input.draft!.textMappings.push({ ...input.draft!.textMappings[0], fieldKey: "removed" });
    expect(codes(input)).toEqual(expect.arrayContaining(["DUPLICATE_MAPPING", "UNKNOWN_FIELD"]));
  });

  it("선택항목의 표시 이름을 공식 값으로 추측해서 변환하지 않는다", () => {
    const input = fixture();
    input.snapshot!.screen.fields[0] = {
      ...textField("company"),
      kind: "select",
      type: "select-one",
      options: [{ label: "가상테스트", value: "01", disabled: false }],
    };
    expect(codes(input)).toContain("SELECT_VALUE_MISMATCH");
    input.company.profile.companyName = "01";
    expect(codes(input)).not.toContain("SELECT_VALUE_MISMATCH");
    input.snapshot!.screen.fields[0].options[0].disabled = true;
    expect(codes(input)).toContain("SELECT_VALUE_MISMATCH");
  });

  it("필수 지원불가 항목과 수집기가 알린 필수 동의 항목을 임의 완료하지 않는다", () => {
    const input = fixture();
    input.snapshot!.screen.fields[0].readOnly = true;
    input.snapshot!.screen.warnings.push(
      "UNSUPPORTED_REQUIRED_CONTROL: 필수 선택·동의 항목은 별도 확인이 필요합니다.",
    );
    expect(codes(input)).toEqual(
      expect.arrayContaining([
        "UNSUPPORTED_FIELD",
        "UNSUPPORTED_REQUIRED_CONTROL",
        "TEXT_FIELD_UNSUPPORTED",
      ]),
    );
    input.draft = null;
    expect(codes(input)).toContain("UNSUPPORTED_REQUIRED_CONTROL");
  });

  it("현재 원본 메타데이터가 없는 자료·수정된 자료·파일 누락을 각각 차단한다", () => {
    const input = fixture();
    input.company.sources[0].updatedAt = "2026-09-25T03:00:00.000Z";
    expect(codes(input)).toContain("SOURCE_STALE");
    input.originalFiles[0].exists = false;
    expect(codes(input)).toContain("ORIGINAL_MISSING");
    input.company.sources = [];
    expect(codes(input)).toContain("SOURCE_MISSING");
  });

  it.each(["name", "mime", "zero-size", "invalid-size", "duplicate-metadata"])(
    "신뢰할 수 없는 원본 메타데이터를 거부한다: %s",
    (condition) => {
      const input = fixture();
      if (condition === "name") input.originalFiles[0].originalName = "another.pdf";
      if (condition === "mime") input.originalFiles[0].mimeType = "image/png";
      if (condition === "zero-size") input.originalFiles[0].sizeBytes = 0;
      if (condition === "invalid-size") input.originalFiles[0].sizeBytes = NaN;
      if (condition === "duplicate-metadata")
        input.originalFiles.push({ ...input.originalFiles[0] });
      expect(buildVenturePreflight(input).readyForLocalReview).toBe(false);
      expect(buildVenturePreflight(input).attachments).toEqual([]);
    },
  );

  it("같은 원본을 중복 연결하거나 단일 파일 항목에 여러 원본을 넣을 수 없다", () => {
    const input = fixture();
    input.draft!.attachmentMappings.push({ ...input.draft!.attachmentMappings[0] });
    expect(codes(input)).toEqual(
      expect.arrayContaining(["DUPLICATE_ATTACHMENT", "FILE_MULTIPLE_NOT_ALLOWED"]),
    );
    input.snapshot!.screen.fields[2].multiple = true;
    expect(codes(input)).not.toContain("FILE_MULTIPLE_NOT_ALLOWED");
    expect(codes(input)).toContain("DUPLICATE_ATTACHMENT");
  });

  it("다중 파일 항목은 서로 다른 원본을 명시적으로 연결한 경우만 허용한다", () => {
    const input = fixture();
    const otherSourceId = "44444444-4444-4444-8444-444444444444";
    input.snapshot!.screen.fields[2].multiple = true;
    input.company.sources.push({ ...input.company.sources[0], id: otherSourceId });
    input.originalFiles.push({ ...input.originalFiles[0], sourceId: otherSourceId });
    input.draft!.attachmentMappings.push({
      ...input.draft!.attachmentMappings[0],
      sourceId: otherSourceId,
    });
    const result = buildVenturePreflight(input);
    expect(result.readyForLocalReview).toBe(true);
    expect(result.attachments).toHaveLength(2);
  });

  it.each([
    [".pdf", true],
    [".PDF", true],
    ["application/pdf", true],
    ["application/*", true],
    ["image/*,.pdf", true],
    [".png", false],
    ["image/png", false],
    ["image/*", false],
  ])("공식 accept 제약을 확장자·MIME OR 조건으로 확인한다: %s", (accept, matches) => {
    const input = fixture();
    input.snapshot!.screen.fields[2].accept = accept;
    expect(buildVenturePreflight(input).readyForLocalReview).toBe(matches);
    expect(codes(input).includes("FILE_TYPE_REJECTED")).toBe(!matches);
  });

  it("형식 미지정·공식 용량 미지정은 한도를 지어내지 않고 경고한다", () => {
    const input = fixture();
    input.snapshot!.screen.fields[2].accept = null;
    input.originalFiles[0].sizeBytes = Number.MAX_SAFE_INTEGER;
    const result = buildVenturePreflight(input);
    expect(result.readyForLocalReview).toBe(true);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["FILE_TYPE_LIMIT_UNKNOWN", "FILE_SIZE_LIMIT_UNKNOWN"]),
    );
    expect(result.attachments[0].sizeBytes).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("알 수 없는 accept 토큰과 부족한 MIME 정보는 승인하지 않는다", () => {
    const input = fixture();
    input.snapshot!.screen.fields[2].accept = "pdf-only";
    expect(codes(input)).toContain("FILE_TYPE_UNVERIFIED");
    input.snapshot!.screen.fields[2].accept = "application/pdf";
    input.originalFiles[0].mimeType = null;
    input.company.sources[0].mimeType = null;
    expect(codes(input)).toContain("FILE_TYPE_UNVERIFIED");
  });

  it("텍스트를 파일 항목에 연결하거나 반대로 연결하면 거부한다", () => {
    const input = fixture();
    input.draft!.textMappings[0].fieldKey = "document";
    input.draft!.attachmentMappings[0].fieldKey = "company";
    expect(codes(input)).toEqual(
      expect.arrayContaining([
        "TEXT_FIELD_UNSUPPORTED",
        "FILE_FIELD_UNSUPPORTED",
        "REQUIRED_FIELD_UNMAPPED",
      ]),
    );
    input.draft!.attachmentMappings[0].fieldKey = "document";
    expect(codes(input)).toContain("DUPLICATE_MAPPING");
  });

  it("더 최근 작성본이 있으면 예전 검토본에 current 플래그가 있어도 차단한다", () => {
    const input = fixture();
    input.company.plans.push({ ...input.company.plans[0], id: sourceId, version: 2 });
    expect(codes(input)).toContain("PLAN_SUPERSEDED");
    expect(buildVenturePreflight(input).readyForLocalReview).toBe(false);
  });

  it("HOME에서 기업번호만 보이고 신청 항목이 없으면 로컬 준비 완료로 표시하지 않는다", () => {
    const input = fixture();
    input.snapshot!.screen.fields = [];
    input.draft!.textMappings = [];
    input.draft!.attachmentMappings = [];
    expect(codes(input)).toContain("SCREEN_FIELDS_MISSING");
    expect(buildVenturePreflight(input).readyForLocalReview).toBe(false);
  });

  it("약관 동의는 required 속성이 없어도 사용자가 직접 확인해야 한다", () => {
    const input = fixture();
    input.snapshot!.screen.fields.push({
      ...textField("terms", false),
      type: "checkbox",
      labels: ["이용약관 동의"],
    });
    const result = buildVenturePreflight(input);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "AGREEMENT_REQUIRES_USER",
        severity: "error",
        fieldKey: "terms",
      }),
    );
    expect(result.readyForLocalReview).toBe(false);
  });

  it.each([
    ["number", "12백만원", false],
    ["number", "1.25e3", true],
    ["number", "1e999", false],
    ["date", "2026-02-30", false],
    ["date", "2024-02-29", true],
    ["email", "회사 메일", false],
    ["email", "local@example.test", true],
    ["url", "/relative", false],
    ["url", "https://example.test", true],
  ])("%s 필드의 기본 문자열 형식을 검사하되 변환하지 않는다: %s", (type, value, valid) => {
    const input = fixture();
    input.snapshot!.screen.fields[0].type = type;
    input.company.profile.companyName = value;
    const result = buildVenturePreflight(input);
    expect(result.issues.some((issue) => issue.code === "INPUT_TYPE_MISMATCH")).toBe(!valid);
    expect(result.textFields[0].value).toBe(value);
  });

  it("원본 매핑이 없는 필수 파일만 누락으로 보고하며 서류 목록을 지어내지 않는다", () => {
    const input = fixture();
    input.snapshot!.screen.fields[2].required = true;
    input.draft!.attachmentMappings = [];
    const result = buildVenturePreflight(input);
    expect(result.issues.filter((issue) => issue.code === "REQUIRED_FIELD_UNMAPPED")).toMatchObject(
      [{ fieldKey: "document" }],
    );
    expect(result.attachments).toEqual([]);
  });

  it("지원 범위는 복수선택·동의·숨김·비밀번호·비활성 항목을 제외한다", () => {
    for (const type of ["checkbox", "radio", "hidden", "password", "submit"]) {
      expect(ventureFieldSupport({ ...textField("unsupported"), type })).toBe("unsupported");
    }
    expect(ventureFieldSupport({ ...textField("unsupported"), disabled: true })).toBe(
      "unsupported",
    );
    expect(
      ventureFieldSupport({
        ...textField("unsupported"),
        kind: "select",
        type: "select-multiple",
        multiple: true,
      }),
    ).toBe("unsupported");
  });
});

describe("로컬 대응표 입력 경계", () => {
  it("명시적 확인값·알려진 기업 속성·작성본 바인딩만 받는다", () => {
    const draft = fixture().draft!;
    expect(ventureSubmissionDraftSchema.safeParse(draft).success).toBe(true);
    expect(ventureSubmissionDraftSchema.safeParse({ ...draft, externalSubmit: true }).success).toBe(
      false,
    );
    expect(ventureSubmissionDraftSchema.safeParse({ ...draft, planVersion: null }).success).toBe(
      false,
    );
    expect(
      ventureSubmissionDraftSchema.safeParse({
        ...draft,
        textMappings: [
          {
            fieldKey: "company",
            source: { kind: "profile", property: "password" },
            confirmed: true,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      ventureSubmissionDraftSchema.safeParse({
        ...draft,
        textMappings: [
          { fieldKey: "company", source: { kind: "profile", property: "companyName" } },
        ],
      }).success,
    ).toBe(false);
    expect(
      ventureSubmissionDraftSchema.safeParse({
        ...draft,
        textMappings: [{ ...draft.textMappings[0], value: "arbitrary" }],
      }).success,
    ).toBe(false);
  });

  it("개수·키 길이·revision·날짜 제한을 적용한다", () => {
    const draft = fixture().draft!;
    expect(
      ventureSubmissionDraftSchema.safeParse({
        ...draft,
        textMappings: Array(201).fill(draft.textMappings[0]),
      }).success,
    ).toBe(false);
    expect(
      ventureSubmissionDraftSchema.safeParse({
        ...draft,
        attachmentMappings: Array(101).fill(draft.attachmentMappings[0]),
      }).success,
    ).toBe(false);
    expect(ventureSubmissionDraftSchema.safeParse({ ...draft, accountRevision: -1 }).success).toBe(
      false,
    );
    expect(
      ventureSubmissionDraftSchema.safeParse({ ...draft, sessionStartedAt: "now" }).success,
    ).toBe(false);
    expect(
      ventureSubmissionDraftSchema.safeParse({
        ...draft,
        textMappings: [{ ...draft.textMappings[0], fieldKey: "x".repeat(257) }],
      }).success,
    ).toBe(false);
  });

  it("오염된 저장 대응표도 예외 없이 로컬 차단 결과로 반환한다", () => {
    const input = fixture();
    Object.assign(input.draft!, { unexpected: "not allowed" });
    expect(codes(input)).toContain("DRAFT_INVALID");
    expect(buildVenturePreflight(input).readyForLocalReview).toBe(false);
  });
});
