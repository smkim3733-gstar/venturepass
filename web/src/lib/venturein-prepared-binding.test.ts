import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { emptyProfile, type BusinessPlan } from "./studio-schema";
import {
  preparedPackageRecordSchema,
  type PreparedPackageRecord,
} from "./studio-prepared-package-types";
import type { VentureResolvedAttachment } from "./venturein-preflight";

vi.mock("server-only", () => ({}));
import {
  compareVenturePreparedBinding,
  type VenturePreparedBindingInput,
  type VenturePreparedBindingIssueCode,
} from "./venturein-prepared-binding";

const id = (suffix: number) => `10000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const now = "2026-09-26T12:00:00.000Z";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** Entirely synthetic in-memory input. No store, original files, browser or AI is used. */
function fixture(): VenturePreparedBindingInput {
  const profile = {
    ...emptyProfile(),
    companyName: "합성 준비본 기업",
    industry: "광고",
    team: "미선택 인력 메모",
  };
  const plan: BusinessPlan = {
    id: id(2),
    version: 2,
    generatedAt: now,
    mode: "assisted",
    candidateId: "synthetic",
    sourceRevision: 3,
    content: {
      title: "합성 원고",
      summary: "합성 요약",
      sections: [
        {
          key: "problem",
          title: "문제",
          content: "합성 문제를 확인 중입니다.\n계획과 실적을 구분합니다.",
          evidence: [],
          needsConfirmation: true,
        },
        {
          key: "solution",
          title: "해결",
          content: "선택하지 않은 합성 본문",
          evidence: [],
          needsConfirmation: true,
        },
      ],
      actionItems: ["증빙 검토 필요"],
      interviewQuestions: ["실적 근거가 있나요?"],
    },
    review: [],
    confirmedAt: null,
  };
  const sources: PreparedPackageRecord["sources"] = [3, 4].map((suffix) => ({
    source: {
      id: id(suffix),
      name: `합성 원본 ${suffix}`,
      kind: "technology",
      originalName: `synthetic-${suffix}.pdf`,
      mimeType: "application/pdf",
      extraction: "local",
      warnings: [],
      createdAt: now,
      updatedAt: now,
    },
    sourceSha256: sha(`synthetic source ${suffix}`),
    textSha256: sha(`synthetic text ${suffix}`),
    originalSha256: sha(`synthetic original ${suffix}`),
    originalSizeBytes: 30,
  }));
  const preparedPackage: PreparedPackageRecord = {
    id: id(5),
    version: 1,
    caseId: id(1),
    caseRevision: 7,
    clientRequestId: id(6),
    requestDigest: sha("synthetic request"),
    input: {
      revision: 7,
      planId: plan.id,
      sourceIds: sources.map((item) => item.source.id),
      clientRequestId: id(6),
    },
    createdAt: now,
    scope: "local-preparation-only",
    company: { profile: structuredClone(profile), snapshotSha256: sha("synthetic case") },
    plan: { ...structuredClone(plan), contentSha256: sha(JSON.stringify(plan.content)) },
    sourceIds: sources.map((item) => item.source.id),
    sources,
    review: {
      storedFindings: [],
      currentRuleFindings: [],
      confirmedAt: null,
      unconfirmedSectionKeys: ["problem", "solution"],
      currentEvidence: false,
      latestPlanVersion: true,
      draft: true,
      draftReasons: ["사실·증빙 검토 필요"],
    },
    zip: {
      fileName: "venturepass-preparation-package.zip",
      sha256: sha("synthetic archive"),
      sizeBytes: 200,
    },
  };
  preparedPackageRecordSchema.parse(preparedPackage);
  return {
    caseId: id(1),
    companyRevision: 7,
    profile,
    plan,
    preparedPackage,
    archive: {
      packageId: preparedPackage.id,
      sha256: preparedPackage.zip.sha256,
      sizeBytes: preparedPackage.zip.sizeBytes,
      verified: true,
    },
    selection: {
      planId: plan.id,
      planVersion: plan.version,
      textFields: [
        {
          fieldKey: "industry",
          label: "업종",
          source: { kind: "profile", property: "industry" },
          value: profile.industry,
          characterCount: profile.industry.length,
          maxLength: 100,
          required: true,
          confirmed: true,
        },
        {
          fieldKey: "problem",
          label: "문제",
          source: { kind: "plan-section", sectionKey: "problem" },
          value: plan.content.sections[0].content,
          characterCount: plan.content.sections[0].content.length,
          maxLength: null,
          required: true,
          confirmed: true,
        },
      ],
      attachments: [attachment(sources[0])],
    },
  };
}
function attachment(
  source: PreparedPackageRecord["sources"][number],
  fieldKey = "document",
): VentureResolvedAttachment & { sha256: string } {
  return {
    fieldKey,
    label: "선택 증빙",
    sourceId: source.source.id,
    sourceUpdatedAt: source.source.updatedAt,
    originalName: source.source.originalName!,
    mimeType: source.source.mimeType,
    sizeBytes: source.originalSizeBytes,
    accept: ".pdf",
    multiple: false,
    confirmed: true,
    sha256: source.originalSha256,
  };
}
function rejects(input: VenturePreparedBindingInput, code: VenturePreparedBindingIssueCode) {
  const result = compareVenturePreparedBinding(input);
  expect(result.matched).toBe(false);
  expect(result.binding).toBeNull();
  expect(result.digest).toBeNull();
  expect(result.issues.map((issue) => issue.code)).toContain(code);
  return result;
}
function pinChangedPlan(input: VenturePreparedBindingInput) {
  input.preparedPackage.plan = {
    ...structuredClone(input.plan!),
    contentSha256: sha(JSON.stringify(input.plan!.content)),
  };
}
function deepFreeze(value: unknown): void {
  if (!value || typeof value !== "object") return;
  Object.values(value).forEach(deepFreeze);
  Object.freeze(value);
}

describe("준비본과 선택 입력 범위의 순수 대조", () => {
  it("정확한 선택 문자열·현재 원본 SHA·서버 검증 ZIP만 묶고 원문은 기록하지 않는다", () => {
    const input = fixture();
    input.selection.textFields[0].financialContext = {
      unit: "원",
      evidenceNote: "기록에 복사하면 안 되는 합성 메모",
    };
    const result = compareVenturePreparedBinding(input);
    expect(result).toMatchObject({
      scope: "selected-prepared-fields",
      matched: true,
      issues: [],
      companyRevisionChanged: false,
      packageDraft: true,
    });
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.binding?.targets).toHaveLength(3);
    expect(result.binding?.targets[0]).toEqual({
      kind: "text",
      fieldKey: "industry",
      source: { kind: "profile", property: "industry" },
      valueSha256: sha("광고"),
      characterCount: 2,
    });
    const output = JSON.stringify(result);
    expect(output).not.toContain(input.plan!.content.sections[0].content);
    expect(output).not.toContain("기록에 복사하면 안 되는 합성 메모");
    expect(output).not.toContain(input.profile.companyName);
    expect(result.binding).not.toHaveProperty("approved");
    expect(result).not.toHaveProperty("submissionReady");
  });

  it("비선택 프로필 변경은 무관하지만 현재 회사 revision은 별도 표시하고 지문에 묶는다", () => {
    const input = fixture();
    const before = compareVenturePreparedBinding(input);
    input.profile.team = "달라진 미선택 인력 메모";
    expect(compareVenturePreparedBinding(input).digest).toBe(before.digest);
    input.companyRevision++;
    const after = compareVenturePreparedBinding(input);
    expect(after.matched).toBe(true);
    expect(after.companyRevisionChanged).toBe(true);
    expect(after.digest).not.toBe(before.digest);
  });

  it("준비본의 미선택 원본을 실행 범위에 추가하지 않는다", () => {
    const input = fixture();
    const result = compareVenturePreparedBinding(input);
    expect(JSON.stringify(result.binding)).not.toContain(id(4));
    input.selection.attachments = [];
    expect(
      compareVenturePreparedBinding(input).binding?.targets.every(
        (target) => target.kind === "text",
      ),
    ).toBe(true);
  });

  it("전체 원고를 고정하므로 미선택 본문 변경도 같은 ID의 원고로 통과시키지 않는다", () => {
    const input = fixture();
    input.plan!.content.sections[1].content += " 변경";
    rejects(input, "PLAN_CONTENT_MISMATCH");
  });

  it.each([
    [
      "회사",
      (input: VenturePreparedBindingInput) => {
        input.caseId = id(90);
      },
      "PACKAGE_COMPANY_MISMATCH",
    ],
    [
      "현재 원고 ID",
      (input: VenturePreparedBindingInput) => {
        input.plan!.id = id(90);
      },
      "PLAN_BINDING_MISMATCH",
    ],
    [
      "현재 원고 버전",
      (input: VenturePreparedBindingInput) => {
        input.plan!.version++;
      },
      "PLAN_BINDING_MISMATCH",
    ],
    [
      "선택 대응표의 원고 ID",
      (input: VenturePreparedBindingInput) => {
        input.selection.planId = id(90);
      },
      "PLAN_BINDING_MISMATCH",
    ],
    [
      "선택 대응표의 원고 버전",
      (input: VenturePreparedBindingInput) => {
        input.selection.planVersion = 1;
      },
      "PLAN_BINDING_MISMATCH",
    ],
    [
      "현재 원고 누락",
      (input: VenturePreparedBindingInput) => {
        input.plan = null;
      },
      "PLAN_BINDING_MISMATCH",
    ],
    [
      "원고 연결 누락",
      (input: VenturePreparedBindingInput) => {
        input.selection.planId = null;
        input.selection.planVersion = null;
      },
      "PLAN_BINDING_MISMATCH",
    ],
    [
      "요약 변경",
      (input: VenturePreparedBindingInput) => {
        input.plan!.content.summary += " 변경";
      },
      "PLAN_CONTENT_MISMATCH",
    ],
    [
      "질문 변경",
      (input: VenturePreparedBindingInput) => {
        input.plan!.content.interviewQuestions.push("새 질문");
      },
      "PLAN_CONTENT_MISMATCH",
    ],
    [
      "저장 본문 SHA 위조",
      (input: VenturePreparedBindingInput) => {
        input.preparedPackage.plan.content.sections[0].content += " 변경";
      },
      "PACKAGE_METADATA_INCONSISTENT",
    ],
  ] as const)("%s 불일치는 고정 binding을 만들지 않는다", (_label, change, code) => {
    const input = fixture();
    change(input);
    rejects(input, code);
  });

  it.each([
    [
      "검증 결과 없음",
      (input: VenturePreparedBindingInput) => {
        input.archive = null;
      },
      "PACKAGE_ARCHIVE_UNVERIFIED",
    ],
    [
      "검증 미완료",
      (input: VenturePreparedBindingInput) => {
        input.archive!.verified = false;
      },
      "PACKAGE_ARCHIVE_UNVERIFIED",
    ],
    [
      "다른 준비본 검증 결과",
      (input: VenturePreparedBindingInput) => {
        input.archive!.packageId = id(90);
      },
      "PACKAGE_ARCHIVE_MISMATCH",
    ],
    [
      "다른 ZIP SHA",
      (input: VenturePreparedBindingInput) => {
        input.archive!.sha256 = sha("different archive");
      },
      "PACKAGE_ARCHIVE_MISMATCH",
    ],
    [
      "다른 ZIP 크기",
      (input: VenturePreparedBindingInput) => {
        input.archive!.sizeBytes++;
      },
      "PACKAGE_ARCHIVE_MISMATCH",
    ],
  ] as const)("%s이면 ZIP 일치로 추정하지 않는다", (_label, change, code) => {
    const input = fixture();
    change(input);
    rejects(input, code);
  });

  it.each(["광고 ", " 광고", "광고\n", "광 고", "廣告"])(
    "프로필 문자열 %j를 임의 정규화하지 않는다",
    (value) => {
      const input = fixture();
      input.profile.industry = value;
      input.selection.textFields[0].value = value;
      input.selection.textFields[0].characterCount = value.length;
      rejects(input, "PROFILE_VALUE_MISMATCH");
    },
  );

  it("현재 프로필과 다른 과거 입력 문자열은 준비본과 같아도 거부한다", () => {
    const input = fixture();
    input.profile.industry = "다른 업종";
    rejects(input, "TEXT_CURRENT_MISMATCH");
  });

  it("schema가 trim을 지원하는 기업명도 저장된 정확한 원문 문자열로 비교한다", () => {
    const input = fixture();
    input.profile.companyName = " 합성 기업 ";
    input.preparedPackage.company.profile.companyName = input.profile.companyName;
    Object.assign(input.selection.textFields[0], {
      source: { kind: "profile", property: "companyName" },
      value: input.profile.companyName,
      characterCount: input.profile.companyName.length,
    });
    expect(compareVenturePreparedBinding(input).matched).toBe(true);
    input.profile.companyName = input.profile.companyName.trim();
    rejects(input, "TEXT_CURRENT_MISMATCH");
  });

  it.each(["누락", "중복"])("선택 본문 key %s을 다른 본문으로 대체하지 않는다", (kind) => {
    const input = fixture();
    if (kind === "누락") input.plan!.content.sections = input.plan!.content.sections.slice(1);
    else input.plan!.content.sections.push(structuredClone(input.plan!.content.sections[0]));
    pinChangedPlan(input);
    rejects(input, "PLAN_SECTION_AMBIGUOUS");
  });

  it("공백만 입력·문자수 조작·maxlength 초과를 거부한다", () => {
    for (const mode of ["empty", "count", "length"]) {
      const input = fixture();
      if (mode === "empty") {
        input.selection.textFields[0].value = " ";
        input.selection.textFields[0].characterCount = 1;
      }
      if (mode === "count") input.selection.textFields[0].characterCount++;
      if (mode === "length") input.selection.textFields[0].maxLength = 1;
      rejects(input, "TEXT_VALUE_INVALID");
    }
  });

  it("선택 항목이 없으면 빈 범위를 일치로 기록하지 않는다", () => {
    const input = fixture();
    input.selection.textFields = [];
    input.selection.attachments = [];
    rejects(input, "SELECTION_EMPTY");
  });

  it("미확인 텍스트·첨부를 확인된 항목으로 바꾸지 않는다", () => {
    for (const kind of ["text", "file"]) {
      const input = fixture();
      (kind === "text" ? input.selection.textFields[0] : input.selection.attachments[0]).confirmed =
        false;
      rejects(input, "TARGET_UNCONFIRMED");
    }
  });

  it("동일 텍스트 target 및 텍스트/파일 target 충돌은 거부한다", () => {
    const input = fixture();
    input.selection.textFields = [
      ...input.selection.textFields,
      structuredClone(input.selection.textFields[0]),
    ];
    rejects(input, "TARGET_DUPLICATE");
    const collision = fixture();
    collision.selection.attachments[0].fieldKey = "industry";
    rejects(collision, "TARGET_DUPLICATE");
    rejects(collision, "ATTACHMENT_TARGET_INVALID");
  });

  it("같은 대상에 같은 원본을 중복 추가하지 않는다", () => {
    const input = fixture();
    input.selection.attachments = [
      input.selection.attachments[0],
      { ...input.selection.attachments[0] },
    ];
    rejects(input, "ATTACHMENT_SOURCE_DUPLICATE");
  });

  it("서로 다른 공식 대상에 명시 선택한 같은 원본은 기존 preflight처럼 각각 보존한다", () => {
    const input = fixture();
    input.selection.attachments = [
      input.selection.attachments[0],
      { ...input.selection.attachments[0], fieldKey: "another-document" },
    ];
    const result = compareVenturePreparedBinding(input);
    expect(result.matched).toBe(true);
    expect(
      result.binding?.targets
        .filter((target) => target.kind === "file")
        .map((target) => target.fieldKey),
    ).toEqual(["document", "another-document"]);
  });

  it("accept 속성과 MIME이 없는 원본도 현재 메타와 정확히 일치하면 대조한다", () => {
    const input = fixture();
    input.selection.attachments[0].accept = null;
    input.selection.attachments[0].mimeType = null;
    input.preparedPackage.sources[0].source.mimeType = null;
    expect(compareVenturePreparedBinding(input).matched).toBe(true);
  });

  it("multiple 대상의 서로 다른 선택 원본만 순서대로 묶는다", () => {
    const input = fixture();
    input.selection.attachments = input.preparedPackage.sources.map((source) => ({
      ...attachment(source),
      multiple: true,
    }));
    const first = compareVenturePreparedBinding(input);
    expect(first.matched).toBe(true);
    expect(first.binding?.targets.filter((target) => target.kind === "file")).toHaveLength(1);
    input.selection.attachments = [...input.selection.attachments].reverse();
    const second = compareVenturePreparedBinding(input);
    expect(second.matched).toBe(true);
    expect(second.digest).not.toBe(first.digest);
  });

  it("단일 파일 대상의 다중 첨부와 같은 대상의 상충하는 속성을 거부한다", () => {
    const input = fixture();
    input.selection.attachments = input.preparedPackage.sources.map((source) => attachment(source));
    rejects(input, "ATTACHMENT_TARGET_INVALID");
    input.selection.attachments = input.selection.attachments.map((file) => ({
      ...file,
      multiple: true,
    }));
    input.selection.attachments[1].accept = ".png";
    rejects(input, "ATTACHMENT_TARGET_INVALID");
  });

  it("현재 연결 원본이 준비본에 없으면 다른 원본으로 대신하지 않는다", () => {
    const input = fixture();
    input.selection.attachments[0].sourceId = id(90);
    rejects(input, "ATTACHMENT_NOT_PACKAGED");
  });

  it.each([
    [
      "파일명",
      (file: VentureResolvedAttachment) => {
        file.originalName = "renamed.pdf";
      },
    ],
    [
      "MIME",
      (file: VentureResolvedAttachment) => {
        file.mimeType = "application/PDF";
      },
    ],
    [
      "크기",
      (file: VentureResolvedAttachment) => {
        file.sizeBytes++;
      },
    ],
    [
      "변경시각",
      (file: VentureResolvedAttachment) => {
        file.sourceUpdatedAt = "2026-09-27T12:00:00.000Z";
      },
    ],
  ] as const)("선택 원본 %s 불일치를 거부한다", (_label, change) => {
    const input = fixture();
    change(input.selection.attachments[0]);
    rejects(input, "ATTACHMENT_METADATA_MISMATCH");
  });

  it("같은 파일명·크기라도 실제 원본 SHA가 다르면 거부한다", () => {
    const input = fixture();
    input.selection.attachments[0].sha256 = sha("same-size different content");
    rejects(input, "ATTACHMENT_CONTENT_MISMATCH");
  });

  it.each([
    [
      "없는 SHA",
      (input: VenturePreparedBindingInput) => {
        input.selection.attachments[0].sha256 = "";
      },
    ],
    [
      "0바이트",
      (input: VenturePreparedBindingInput) => {
        input.selection.attachments[0].sizeBytes = 0;
      },
    ],
    [
      "파일당 한도",
      (input: VenturePreparedBindingInput) => {
        input.selection.attachments[0].sizeBytes = 12 * 1024 * 1024 + 1;
      },
    ],
    [
      "음수 revision",
      (input: VenturePreparedBindingInput) => {
        input.companyRevision = -1;
      },
    ],
    [
      "필드당 한도",
      (input: VenturePreparedBindingInput) => {
        input.selection.textFields[0].value = "x".repeat(20_001);
      },
    ],
  ] as const)("%s 같은 불가능한 입력은 안전하게 거부한다", (_label, change) => {
    const input = fixture();
    change(input);
    rejects(input, "INVALID_INPUT");
  });

  it("총 50개 target 한도를 텍스트와 파일 target 합계로 검사한다", () => {
    const input = fixture();
    input.selection.textFields = Array.from({ length: 50 }, (_, index) => ({
      ...input.selection.textFields[0],
      fieldKey: `field-${index}`,
    }));
    rejects(input, "SELECTION_LIMIT");
  });

  it("총 텍스트 100000자 한도를 검사한다", () => {
    const input = fixture();
    const value = "가".repeat(10_000);
    input.profile.technologySummary = value;
    input.preparedPackage.company.profile.technologySummary = value;
    input.selection.textFields = Array.from({ length: 11 }, (_, index) => ({
      ...input.selection.textFields[0],
      source: { kind: "profile", property: "technologySummary" },
      fieldKey: `field-${index}`,
      value,
      characterCount: value.length,
      maxLength: null,
    }));
    rejects(input, "SELECTION_LIMIT");
  });

  it("총 원본 24MiB 한도를 검사한다", () => {
    const input = fixture();
    const third = structuredClone(input.preparedPackage.sources[0]);
    third.source.id = id(99);
    input.preparedPackage.sources.push(third);
    input.preparedPackage.sourceIds.push(id(99));
    input.preparedPackage.input.sourceIds.push(id(99));
    input.preparedPackage.sources.forEach((source) => {
      source.originalSizeBytes = 12 * 1024 * 1024;
    });
    input.selection.attachments = input.preparedPackage.sources.map((source, index) =>
      attachment(source, `document-${index}`),
    );
    rejects(input, "SELECTION_LIMIT");
  });

  it("준비본 메타의 중복 원본·원본 목록 불일치도 거부한다", () => {
    const duplicate = fixture();
    duplicate.preparedPackage.sources[1] = structuredClone(duplicate.preparedPackage.sources[0]);
    rejects(duplicate, "PACKAGE_METADATA_INCONSISTENT");
    const mismatch = fixture();
    mismatch.preparedPackage.sourceIds.reverse();
    rejects(mismatch, "PACKAGE_METADATA_INCONSISTENT");
  });

  it("객체 key 순서·표시 문구는 지문에 영향을 주지 않고 실행 target 순서는 보존한다", () => {
    const input = fixture();
    const first = compareVenturePreparedBinding(input);
    input.selection.textFields[0].source = { property: "industry", kind: "profile" };
    input.selection.textFields[0].label = "화면의 다른 표시 문구";
    expect(compareVenturePreparedBinding(input).digest).toBe(first.digest);
    input.selection.textFields = [...input.selection.textFields].reverse();
    expect(compareVenturePreparedBinding(input).digest).not.toBe(first.digest);
  });

  it("원고 SHA와 선택 문자열·선택 파일 SHA는 각각 지문에 포함된다", () => {
    const original = compareVenturePreparedBinding(fixture()).digest;
    const plan = fixture();
    plan.plan!.content.summary += " 바뀐 원고";
    pinChangedPlan(plan);
    expect(compareVenturePreparedBinding(plan).digest).not.toBe(original);
    const text = fixture();
    text.profile.industry = "정보서비스";
    text.preparedPackage.company.profile.industry = text.profile.industry;
    text.selection.textFields[0].value = text.profile.industry;
    text.selection.textFields[0].characterCount = text.profile.industry.length;
    expect(compareVenturePreparedBinding(text).digest).not.toBe(original);
    const file = fixture();
    file.selection.attachments[0].sha256 = sha("new synthetic bytes");
    file.preparedPackage.sources[0].originalSha256 = file.selection.attachments[0].sha256;
    expect(compareVenturePreparedBinding(file).digest).not.toBe(original);
  });

  it("동결한 입력을 변경하지 않고 검토·승인 상태도 만들어내지 않는다", () => {
    const input = fixture();
    const before = structuredClone(input);
    deepFreeze(input);
    const result = compareVenturePreparedBinding(input);
    expect(result.matched).toBe(true);
    expect(input).toEqual(before);
    expect(input.plan!.confirmedAt).toBeNull();
    expect(input.preparedPackage.review.currentEvidence).toBe(false);
    expect(result.packageDraft).toBe(true);
    expect(result).not.toHaveProperty("officialStatus");
    expect(result).not.toHaveProperty("readyForExecution");
    const target = result.binding!.targets[0];
    if (target.kind === "text" && target.source.kind === "profile") target.source.property = "team";
    expect(input.selection.textFields[0].source).toEqual(before.selection.textFields[0].source);
  });
});
