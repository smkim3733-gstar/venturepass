import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  VentureExecutionRecord,
  VentureExecutionReview,
  VenturePreparedComparison,
  VenturePreparedPackageBinding,
  VentureRecoveryReview,
} from "@/lib/venturein-execution-schema";
import type { VentureResolvedText, VentureResolvedAttachment } from "@/lib/venturein-preflight";
import {
  validatePreparedComparison,
  validatePreparedExecutionReview,
  validatePreparedExecutionReceipt,
  createPreparedExecutionExpectation,
  validatePreparedExecutionOutcome,
  preparedExecutionDraftReasons,
  validateRecoveryPreparedBinding,
  validateRecoveryPreparedTargets,
  VentureinPreparedComparisonView,
  VentureinPreparedBindingSummary,
} from "./venturein-prepared-execution-ui";
import {
  validateVentureRecoveryReview,
  ventureRecoveryBlockedReason,
  VentureinRecoveryApproval,
} from "./venturein-recovery-panel";

const id = (suffix: number) => `10000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const now = "2026-09-27T01:00:00.000Z";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
    );
  return value;
}
const digest = (value: unknown) => hash(JSON.stringify(sorted(value)));
function fixture() {
  const context = {
    caseId: id(1),
    workflowRevision: 8,
    companyRevision: 4,
    accountRevision: 2,
    snapshotId: "synthetic-screen",
    sessionStartedAt: now,
  };
  const text: VentureResolvedText[] = [
    {
      fieldKey: "industry",
      label: "주업종",
      source: { kind: "profile", property: "industry" },
      value: "광고",
      characterCount: 2,
      maxLength: 100,
      required: true,
      confirmed: true,
    },
    {
      fieldKey: "problem",
      label: "문제",
      source: { kind: "plan-section", sectionKey: "problem" },
      value: "합성 문제 본문",
      characterCount: "합성 문제 본문".length,
      maxLength: null,
      required: true,
      confirmed: true,
    },
  ];
  const files: (VentureResolvedAttachment & { sha256: string })[] = [
    {
      fieldKey: "document",
      label: "합성 증빙",
      sourceId: id(3),
      sourceUpdatedAt: now,
      originalName: "synthetic.pdf",
      mimeType: null,
      sizeBytes: 30,
      accept: null,
      multiple: false,
      confirmed: true,
      sha256: hash("synthetic bytes"),
    },
  ];
  const comparison: VenturePreparedComparison = {
    ...context,
    preparedPackage: {
      id: id(5),
      version: 1,
      caseId: id(1),
      caseRevision: 3,
      clientRequestId: id(6),
      createdAt: now,
      scope: "local-preparation-only",
      planId: id(2),
      planVersion: 2,
      planTitle: "합성 원고",
      planContentSha256: hash("synthetic plan content"),
      sourceIds: [id(3), id(4)],
      zipSha256: hash("synthetic zip"),
      sizeBytes: 200,
      draft: true,
      draftReasons: ["사실·증빙 확인 필요"],
      storedReviewCount: 1,
      currentRuleReviewCount: 1,
      confirmedAt: null,
    },
    result: {
      scope: "selected-prepared-fields",
      matched: true,
      issues: [],
      packageDraft: true,
      companyRevisionChanged: true,
      binding: {
        version: 1,
        scope: "selected-prepared-fields",
        caseId: id(1),
        companyRevision: 4,
        package: {
          id: id(5),
          version: 1,
          caseRevision: 3,
          createdAt: now,
          zipSha256: hash("synthetic zip"),
          zipSizeBytes: 200,
        },
        plan: { id: id(2), version: 2, contentSha256: hash("synthetic plan content") },
        targets: [
          ...text.map((field) => ({
            kind: "text" as const,
            fieldKey: field.fieldKey,
            source: field.source,
            characterCount: field.characterCount,
            valueSha256: hash(field.value),
          })),
          {
            kind: "file",
            fieldKey: "document",
            files: files.map(
              ({ sourceId, sourceUpdatedAt, originalName, mimeType, sizeBytes, sha256 }) => ({
                sourceId,
                sourceUpdatedAt,
                originalName,
                mimeType,
                sizeBytes,
                sha256,
              }),
            ),
          },
        ],
      },
      digest: null,
    },
  };
  comparison.result.digest = digest(comparison.result.binding);
  const prepared: VenturePreparedPackageBinding = {
    binding: comparison.result.binding!,
    digest: comparison.result.digest,
    packageDraft: true,
    companyRevisionChanged: true,
  };
  const review: VentureExecutionReview = {
    scope: "selected-fields",
    submissionReady: false,
    remainingIssues: [
      { code: "AGREEMENT_REQUIRES_USER", message: "공식 동의 확인 필요", severity: "error" },
    ],
    token: id(8),
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    ...context,
    destination: "https://www.smes.go.kr/venturein/synthetic",
    companyName: "합성 기업",
    fieldCount: text.length,
    fields: structuredClone(text),
    attachments: structuredClone(files),
    attachmentCount: files.length,
    totalAttachmentBytes: 30,
    preparedPackage: structuredClone(prepared),
  };
  const fileMetadata = files.map(({ sha256: _sha, ...file }) => {
    void _sha;
    return file;
  });
  return {
    context,
    text,
    files,
    fileMetadata,
    comparison,
    selected: structuredClone(comparison.preparedPackage),
    prepared,
    review,
  };
}
function record(prepared?: VenturePreparedPackageBinding): VentureExecutionRecord {
  const value = fixture();
  const common = {
    ...value.context,
    fingerprint: "a".repeat(64),
    draftFingerprint: "b".repeat(64),
    targets: (prepared?.binding.targets ?? value.prepared.binding.targets).map(
      ({ fieldKey, kind }) => ({ fieldKey, kind }),
    ),
  };
  return {
    id: id(9),
    snapshotId: value.context.snapshotId,
    status: "stopped",
    startedAt: now,
    finishedAt: now,
    completedFieldKeys: ["industry"],
    attachmentFieldKeys: [],
    attemptedFieldKey: "industry",
    code: "TARGET_CHANGED",
    requestedFieldKeys: ["industry", "problem"],
    preservedFieldKeys: [],
    touchedFieldKeys: ["industry"],
    priorExecutionId: null,
    previousAttempts: [],
    manifest: prepared
      ? { version: 2, ...common, preparedPackage: prepared }
      : { version: 1, ...common },
  };
}
function textRecovery() {
  const value = fixture();
  const prepared = structuredClone(value.prepared);
  prepared.binding.targets = prepared.binding.targets.filter((target) => target.kind === "text");
  prepared.digest = digest(prepared.binding);
  const review: VentureRecoveryReview = {
    scope: "text-recovery",
    workflowRevision: value.context.workflowRevision,
    companyRevision: value.context.companyRevision,
    accountRevision: value.context.accountRevision,
    snapshotId: value.context.snapshotId,
    sessionStartedAt: now,
    token: id(10),
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    destination: value.review.destination,
    companyName: "합성 기업",
    fieldCount: 1,
    fields: [value.text[1]],
    protectedFields: [{ fieldKey: "industry", label: "주업종" }],
    priorExecutionId: id(9),
    observedAt: now,
    submissionReady: false,
    remainingIssues: value.review.remainingIssues,
    preparedPackage: prepared,
  };
  const expected = {
    ...value.context,
    priorExecutionId: id(9),
    destination: review.destination,
    preparedPackage: prepared,
  };
  return { ...value, prepared, review, expected };
}

describe("준비본 대조의 브라우저 응답 경계", () => {
  it("보관 검토 사유는 한국어 안내로 바꾸고 알 수 없는 코드·문구는 노출하지 않는다", () => {
    const reasons = [
      "NOT_REVIEWED",
      "UNCONFIRMED_SECTION",
      "REVIEW_ERROR",
      "REVIEW_CONFIRMATION",
      "PLAN_NOT_CURRENT",
      "OLDER_PLAN_VERSION",
      "STORED_REVIEW_ERROR",
      "STORED_REVIEW_CONFIRMATION",
      "STORED_SEMANTIC_FINDINGS",
      "INVALID_REFERENCE",
      "UNKNOWN_REASON",
      "비공개 원문이 들어온 알 수 없는 사유",
      "__proto__",
    ];
    const labels = preparedExecutionDraftReasons(reasons);
    expect(labels).toContain("원고의 내부 검토 완료 기록이 필요합니다.");
    expect(labels).toContain("사실·증빙을 확인해야 할 본문 항목이 남아 있습니다.");
    expect(labels).toContain("현재 원고 검토에서 발견한 오류를 보완해 주세요.");
    expect(labels).toContain("현재 원고 검토에서 추가 사실 확인이 필요합니다.");
    expect(labels.filter((label) => label === "추가 검토가 필요합니다")).toHaveLength(1);
    expect(labels).toHaveLength(11);
    expect(labels.join(" ")).not.toMatch(/[A-Z_]{3,}|비공개 원문|__proto__/);
    expect(reasons[0]).toBe("NOT_REVIEWED");
  });
  it("현재 회사·화면·준비본·선택 text SHA·파일 메타·canonical digest를 검증한다", async () => {
    const f = fixture();
    await expect(
      validatePreparedComparison(f.comparison, f.context, f.selected, f.text, f.fileMetadata),
    ).resolves.toEqual(f.comparison);
  });
  it.each([
    "caseId",
    "workflowRevision",
    "companyRevision",
    "accountRevision",
    "snapshotId",
    "sessionStartedAt",
  ] as const)("%s가 바뀐 뒤 도착한 대조 응답을 거부한다", async (key) => {
    const f = fixture();
    const changed = { ...f.context, [key]: typeof f.context[key] === "number" ? 999 : "changed" };
    await expect(
      validatePreparedComparison(f.comparison, changed, f.selected, f.text, f.fileMetadata),
    ).rejects.toThrow();
  });
  it.each(["id", "zipSha256", "planContentSha256", "draft"] as const)(
    "선택 준비본의 %s와 다른 응답을 거부한다",
    async (key) => {
      const f = fixture();
      Object.assign(f.selected, {
        [key]: key === "draft" ? false : key === "id" ? id(99) : "f".repeat(64),
      });
      await expect(
        validatePreparedComparison(f.comparison, f.context, f.selected, f.text, f.fileMetadata),
      ).rejects.toThrow();
    },
  );
  it("불일치 결과는 binding 없는 보완 결과로만 받는다", async () => {
    const f = fixture();
    f.comparison.result = {
      ...f.comparison.result,
      matched: false,
      binding: null,
      digest: null,
      issues: [{ code: "ATTACHMENT_NOT_PACKAGED", fieldKey: "document", sourceId: id(3) }],
    };
    await expect(
      validatePreparedComparison(f.comparison, f.context, f.selected, f.text, f.fileMetadata),
    ).resolves.toEqual(f.comparison);
    const html = renderToStaticMarkup(
      createElement(VentureinPreparedComparisonView, {
        comparison: f.comparison,
        fieldLabel: () => "합성 증빙",
      }),
    );
    expect(html).toContain("선택 원본이 준비본에 없습니다");
    expect(html).not.toContain("이번 선택 항목 일치");
  });
  it("오류가 있는 응답을 matched:true로 표시하지 못한다", async () => {
    const f = fixture();
    f.comparison.result.issues.push({ code: "PLAN_CONTENT_MISMATCH" });
    await expect(
      validatePreparedComparison(f.comparison, f.context, f.selected, f.text, f.fileMetadata),
    ).rejects.toThrow();
  });
  it.each(["digest", "text", "duplicate", "extra-file", "file-metadata"] as const)(
    "%s 변조를 지문 또는 정확한 선택 항목 비교로 거부한다",
    async (kind) => {
      const f = fixture();
      const binding = f.comparison.result.binding!;
      if (kind === "digest") f.comparison.result.digest = "f".repeat(64);
      if (kind === "text" && binding.targets[0].kind === "text")
        binding.targets[0].valueSha256 = hash("다른 문자열");
      if (kind === "duplicate") binding.targets[1] = structuredClone(binding.targets[0]);
      if (kind === "extra-file")
        binding.targets.push({
          kind: "file",
          fieldKey: "not-selected",
          files: [
            {
              sourceId: id(4),
              sourceUpdatedAt: now,
              originalName: "unselected.pdf",
              mimeType: null,
              sizeBytes: 30,
              sha256: hash("unselected bytes"),
            },
          ],
        });
      if (kind === "file-metadata" && binding.targets[2].kind === "file")
        binding.targets[2].files[0].sizeBytes++;
      if (kind !== "digest") f.comparison.result.digest = digest(binding);
      await expect(
        validatePreparedComparison(f.comparison, f.context, f.selected, f.text, f.fileMetadata),
      ).rejects.toThrow();
    },
  );
  it("현재 입력문자열이 바뀌면 이전 대조 지문으로 준비하지 않는다", async () => {
    const f = fixture();
    f.text[0].value = "다른 업종";
    f.text[0].characterCount = f.text[0].value.length;
    await expect(
      validatePreparedComparison(f.comparison, f.context, f.selected, f.text, f.fileMetadata),
    ).rejects.toThrow();
  });
});

describe("준비본을 고정한 새 검토안과 영속 기록", () => {
  it("전체 제출 보완이 남아도 정확한 선택 범위 검토를 받되 완료로 바꾸지 않는다", async () => {
    const f = fixture();
    await expect(
      validatePreparedExecutionReview(f.review, f.comparison, f.text, f.fileMetadata),
    ).resolves.toBe(f.review);
    expect(f.review.submissionReady).toBe(false);
    expect(f.review.preparedPackage?.packageDraft).toBe(true);
  });
  it.each(["legacy", "package", "digest", "text", "file-sha", "unit", "token", "expired"] as const)(
    "%s가 다른 prepare 응답은 실행 승인으로 표시하지 않는다",
    async (kind) => {
      const f = fixture();
      if (kind === "legacy") delete f.review.preparedPackage;
      if (kind === "package") f.review.preparedPackage!.binding.package.id = id(99);
      if (kind === "digest") f.review.preparedPackage!.digest = "f".repeat(64);
      if (kind === "text") f.review.fields[0].value += " ";
      if (kind === "file-sha") f.review.attachments[0].sha256 = hash("different bytes");
      if (kind === "unit")
        f.review.fields[0].financialContext = { unit: "원", evidenceNote: "다른 메모" };
      if (kind === "token") f.review.token = "not-a-token";
      if (kind === "expired") f.review.expiresAt = "2020-01-01T00:00:00.000Z";
      await expect(
        validatePreparedExecutionReview(f.review, f.comparison, f.text, f.fileMetadata),
      ).rejects.toThrow();
    },
  );
  it("v2 실행 결과를 원래 준비본과 묶고 v1·다른 회사·다른 준비본으로 바꾸지 않는다", () => {
    const f = fixture();
    expect(validatePreparedExecutionReceipt(record(f.prepared), f.prepared, id(1))).toMatchObject({
      manifest: { version: 2 },
    });
    expect(() => validatePreparedExecutionReceipt(record(), f.prepared, id(1))).toThrow();
    expect(() =>
      validatePreparedExecutionReceipt(record(f.prepared), f.prepared, id(99)),
    ).toThrow();
    const changed = structuredClone(f.prepared);
    changed.binding.package.id = id(99);
    expect(() => validatePreparedExecutionReceipt(record(changed), f.prepared, id(1))).toThrow();
  });
  it("v2 preparedPackage 누락을 v1 기록으로 대체하지 않는다", () => {
    const f = fixture();
    const value = record(f.prepared);
    delete (value.manifest as { preparedPackage?: unknown }).preparedPackage;
    expect(() => validatePreparedExecutionReceipt(value, f.prepared, id(1))).toThrow();
    expect(ventureRecoveryBlockedReason(value, f.context, f.text)).toContain(
      "준비본 연결 기록을 확인하지 못했습니다",
    );
  });
  it("v1 복구 기록에 새 준비본 결합을 추가하지 않는다", () => {
    const f = fixture();
    expect(() => validateRecoveryPreparedBinding(undefined, undefined)).not.toThrow();
    expect(() => validateRecoveryPreparedBinding(null, undefined)).toThrow();
    expect(() => validateRecoveryPreparedBinding(f.prepared, undefined)).toThrow();
    expect(() => validatePreparedExecutionReceipt(record(f.prepared), undefined, id(1))).toThrow();
  });
});

describe("응답 유실 뒤 동일 실행 범위의 결과만 확인", () => {
  function normal() {
    const f = fixture();
    const expected = createPreparedExecutionExpectation(id(1), f.review, null);
    const receipt = record(f.prepared);
    receipt.requestedFieldKeys = ["industry", "problem", "document"];
    receipt.attachmentFieldKeys = ["document"];
    return { ...f, expected, receipt };
  }
  it("POST와 GET에 동일 검증을 적용하고 전송 후 UI 변경과 독립적으로 고정한다", () => {
    const f = normal();
    expect(validatePreparedExecutionOutcome(f.receipt, f.expected).settled).toBe(true);
    f.review.preparedPackage!.binding.package.id = id(99);
    f.review.fields[0].fieldKey = "changed-after-request";
    expect(f.expected.preparedPackage!.binding.package.id).toBe(id(5));
    expect(f.expected.requestedFieldKeys).toEqual(["industry", "problem", "document"]);
    expect(validatePreparedExecutionOutcome(f.receipt, f.expected).settled).toBe(true);
  });
  it.each([
    "snapshot",
    "revision",
    "account",
    "company",
    "session",
    "scope",
    "preserved",
    "prior",
  ] as const)("새 ID여도 %s가 다른 최신 실행으로 원래 요청을 확인하지 않는다", (change) => {
    const f = normal();
    if (change === "snapshot") {
      f.receipt.snapshotId = "another-screen";
      f.receipt.manifest!.snapshotId = "another-screen";
    }
    if (change === "revision") f.receipt.manifest!.workflowRevision++;
    if (change === "account") f.receipt.manifest!.accountRevision++;
    if (change === "company") f.receipt.manifest!.companyRevision++;
    if (change === "session") f.receipt.manifest!.sessionStartedAt = "2026-09-27T02:00:00.000Z";
    if (change === "scope") f.receipt.requestedFieldKeys = ["industry"];
    if (change === "preserved") f.receipt.preservedFieldKeys = ["problem"];
    if (change === "prior") f.receipt.priorExecutionId = id(90);
    expect(() => validatePreparedExecutionOutcome(f.receipt, f.expected)).toThrow();
  });
  it("전송 전부터 있던 기록과 기록 없음은 요청 결과로 사용하지 않는다", () => {
    const f = normal();
    const expected = createPreparedExecutionExpectation(id(1), f.review, f.receipt);
    expect(() => validatePreparedExecutionOutcome(f.receipt, expected)).toThrow();
    expect(() => validatePreparedExecutionOutcome(null, f.expected)).toThrow();
  });
  it.each(["running", "unknown"] as const)(
    "동일 범위의 %s 기록을 읽어도 결과 미확인을 유지한다",
    (kind) => {
      const f = normal();
      if (kind === "running") {
        f.receipt.status = "running";
        f.receipt.finishedAt = null;
        f.receipt.code = null;
      } else f.receipt.code = "INPUT_RESULT_UNKNOWN";
      expect(validatePreparedExecutionOutcome(f.receipt, f.expected).settled).toBe(false);
    },
  );
  it("완료 기록도 정확한 요청 항목을 모두 확인했어야 한다", () => {
    const f = normal();
    f.receipt.status = "completed";
    f.receipt.code = null;
    f.receipt.attemptedFieldKey = null;
    expect(() => validatePreparedExecutionOutcome(f.receipt, f.expected)).toThrow();
    f.receipt.touchedFieldKeys = [...f.expected.requestedFieldKeys];
    f.receipt.completedFieldKeys = [...f.expected.requestedFieldKeys];
    expect(validatePreparedExecutionOutcome(f.receipt, f.expected).settled).toBe(true);
  });
  it("복구 결과는 이전 실행 ID·원래 manifest·이번 빈칸/보호 범위를 함께 고정한다", () => {
    const f = textRecovery();
    const original = record(f.prepared);
    const expected = createPreparedExecutionExpectation(id(1), f.review, original);
    const next = structuredClone(original);
    Object.assign(next, {
      id: id(11),
      priorExecutionId: original.id,
      requestedFieldKeys: ["problem"],
      preservedFieldKeys: ["industry"],
      touchedFieldKeys: ["problem"],
      completedFieldKeys: ["problem"],
      attemptedFieldKey: "problem",
    });
    expect(validatePreparedExecutionOutcome(next, expected).settled).toBe(true);
    next.manifest!.fingerprint = "f".repeat(64);
    expect(() => validatePreparedExecutionOutcome(next, expected)).toThrow();
  });
});

describe("복구의 원래 준비본과 이번 입력 범위 구분", () => {
  it("원래 전체 binding은 유지하고 보호 항목을 제외한 새 텍스트만 검토한다", async () => {
    const f = textRecovery();
    await expect(validateRecoveryPreparedTargets(f.prepared, f.text)).resolves.toBeUndefined();
    expect(validateVentureRecoveryReview(f.review, f.expected, f.text, new Set(["industry"]))).toBe(
      f.review,
    );
    await expect(validateRecoveryPreparedTargets(f.prepared, f.review.fields)).rejects.toThrow();
    const execute = vi.fn();
    const html = renderToStaticMarkup(
      createElement(VentureinRecoveryApproval, {
        review: f.review,
        approved: false,
        busy: false,
        describeSource: () => "합성 원고",
        onApprovalChange: vi.fn(),
        onExecute: execute,
      }),
    );
    expect(html).toContain("준비본 연결은 원래 실행 전체 범위로 고정됩니다");
    expect(html).toContain("현재 값 일치 · 입력 제외");
    expect(html).toContain("새로 입력할 미시도 빈 텍스트 1개");
    expect(execute).not.toHaveBeenCalled();
    expect(html).not.toMatch(/<input\b[^>]*\schecked=""/);
  });
  it.each(["missing", "new-package", "digest"] as const)(
    "복구의 %s 결합 변경을 거부한다",
    (kind) => {
      const f = textRecovery();
      const review = structuredClone(f.review);
      if (kind === "missing") delete review.preparedPackage;
      if (kind === "new-package") review.preparedPackage!.binding.package.id = id(99);
      if (kind === "digest") review.preparedPackage!.digest = "f".repeat(64);
      expect(() =>
        validateVentureRecoveryReview(review, f.expected, f.text, new Set(["industry"])),
      ).toThrow();
    },
  );
  it("v1 기록은 준비본 미연결로 표시하고 draft 연결을 검토 완료로 표시하지 않는다", () => {
    const legacy = renderToStaticMarkup(
      createElement(VentureinPreparedBindingSummary, { prepared: undefined, historical: true }),
    );
    expect(legacy).toContain("이전 실행에는 준비본 연결 기록이 없습니다");
    expect(legacy).not.toContain("원고 내용 SHA256");
    const missing = renderToStaticMarkup(
      createElement(VentureinPreparedBindingSummary, {
        prepared: undefined,
        historical: true,
        required: true,
      }),
    );
    expect(missing).toContain("준비본 연결 기록을 확인하지 못했습니다");
    expect(missing).not.toContain("이전 실행에는");
    const f = fixture();
    const html = renderToStaticMarkup(
      createElement(VentureinPreparedBindingSummary, { prepared: f.prepared }),
    );
    expect(html).toContain("보관 당시 확인이 남은 준비본입니다");
    expect(html).toContain("기관 저장·접수 완료를 뜻하지 않습니다");
  });
  it("선택 일치 표시를 기관 화면 확인·접수 완료로 표현하지 않는다", () => {
    const f = fixture();
    const html = renderToStaticMarkup(
      createElement(VentureinPreparedComparisonView, {
        comparison: f.comparison,
        fieldLabel: (key) => key,
      }),
    );
    expect(html).toContain("준비본과 이번 선택 항목 일치");
    expect(html).toContain("기관 화면의 입력 상태나 최종 접수 결과를 확인한 것이 아닙니다");
    expect(html).toContain("보관 이후 기업정보가 변경되었습니다");
  });
});
