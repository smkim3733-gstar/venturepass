import { caseSchema, originalOnlyWarnings, type StudioCase } from "../../src/lib/studio-schema";
import {
  localOcrReviewedWarning,
  reviewLocalOcrMutationSchema,
} from "../../src/lib/studio-ocr-review";
import type { LocalOcrPreview } from "../../src/lib/studio-local-ocr-types";
import { answerWorkflowCompany } from "./guided-answer-workflow";
export const ocrId = (n: number) => `${String(n).padStart(8, "0")}-4444-4444-8444-444444444444`;
export async function ocrHash(text: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
export async function ocrReceiptResult(company: StudioCase, mutation: unknown) {
  const command = reviewLocalOcrMutationSchema.parse(mutation);
  const next = structuredClone(company);
  next.revision++;
  next.updatedAt = "2026-10-12T05:15:00.000Z";
  const source = next.sources.find((s) => s.id === command.sourceId)!;
  source.text = command.text;
  source.extraction = "manual";
  source.updatedAt = "2026-10-12T05:15:00.001Z";
  source.warnings = [
    ...new Set([
      ...source.warnings.filter((w) => !(originalOnlyWarnings as readonly string[]).includes(w)),
      localOcrReviewedWarning,
    ]),
  ];
  const input = {
    action: command.action,
    sourceId: command.sourceId,
    sourceUpdatedAt: command.sourceUpdatedAt,
    originalSha256: command.originalSha256,
    text: command.text,
    reviewed: command.reviewed,
  };
  next.sourceOcrReviews.push({
    id: ocrId(10),
    clientRequestId: command.clientRequestId,
    inputDigest: await ocrHash(JSON.stringify(input)),
    sourceId: source.id,
    originalSha256: command.originalSha256,
    textSha256: await ocrHash(command.text),
    reviewedAt: "2026-10-12T05:15:00.000Z",
    sourceUpdatedAt: source.updatedAt,
  });
  next.analysis = null;
  next.selectedCandidateId = null;
  next.plans = next.plans.map((p) => ({ ...p, confirmedAt: null }));
  return caseSchema.parse(next);
}
export async function ocrReceiptFixture() {
  const company = answerWorkflowCompany();
  company.profile.companyName = "합성 글자 교정 저장 기업";
  company.plans[0].confirmedAt = "2026-10-11T00:00:00.000Z";
  const now = "2026-10-11T00:00:00.000Z";
  company.sources = [
    {
      id: ocrId(1),
      name: "두 페이지 합성 원본",
      kind: "technology",
      text: "",
      originalName: "synthetic-two-pages.pdf",
      mimeType: "application/pdf",
      extraction: "pending",
      warnings: [...originalOnlyWarnings, "담당자가 보관한 주의 메모"],
      createdAt: now,
      updatedAt: now,
    },
    {
      id: ocrId(2),
      name: "기존 직접 입력 자료",
      kind: "other",
      text: "기존 자료 본문을 그대로 보존합니다.",
      originalName: null,
      mimeType: null,
      extraction: "manual",
      warnings: [],
      createdAt: now,
      updatedAt: now,
    },
  ];
  company.sourceOcrReviews = [
    {
      id: ocrId(8),
      clientRequestId: ocrId(9),
      inputDigest: "a".repeat(64),
      sourceId: ocrId(2),
      originalSha256: "b".repeat(64),
      textSha256: await ocrHash(company.sources[1].text),
      reviewedAt: now,
      sourceUpdatedAt: now,
    },
  ];
  const pages = [
    { pageNumber: 1, text: "합성 판독 초안 첫 페이지 1,2OO개" },
    { pageNumber: 2, text: "합성 판독 초안 두 번째 페이지 확인 필요" },
  ];
  const preview: LocalOcrPreview = {
    caseRevision: company.revision,
    sourceId: ocrId(1),
    sourceUpdatedAt: now,
    original: {
      originalName: "synthetic-two-pages.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1200,
      sha256: "c".repeat(64),
    },
    engine: "windows-ko",
    observedAt: "2026-10-12T05:10:00.000Z",
    pages,
    text: pages.map((p) => `[페이지 ${p.pageNumber}]\n${p.text}`).join("\n\n"),
    warnings: ["합성 미검토 초안"],
    reviewStatus: "unreviewed",
    sourceChanged: false,
    externalTransmission: false,
  };
  const raw =
    "  [페이지 1]\n합성 교정 수량은 1,200개입니다.\n\n[페이지 2]\n추가 시험 여부는 미확인입니다.  ";
  const command = {
    action: "review-local-ocr" as const,
    revision: company.revision,
    clientRequestId: ocrId(11),
    sourceId: ocrId(1),
    sourceUpdatedAt: now,
    originalSha256: preview.original.sha256,
    text: raw,
    reviewed: true as const,
  };
  return {
    company: caseSchema.parse(company),
    preview,
    raw,
    command,
    result: await ocrReceiptResult(company, command),
  };
}
