import {
  caseSchema,
  sourceSchema,
  originalOnlyWarnings,
  type StudioCase,
  type SourceDocument,
} from "../../src/lib/studio-schema";
import { answerWorkflowCompany } from "./guided-answer-workflow";
export const manualId = (n: number) => `${String(n).padStart(8, "0")}-5555-4555-8555-555555555555`;
export function manualSourceFixture() {
  const company = answerWorkflowCompany();
  company.profile.companyName = "합성 직접 자료 저장 기업";
  company.plans[0].confirmedAt = "2026-10-11T00:00:00.000Z";
  const now = "2026-10-11T00:00:00.000Z";
  company.sources = [
    {
      id: manualId(1),
      name: "보관 원본 자료",
      kind: "technology",
      text: "",
      originalName: "synthetic-original.pdf",
      mimeType: "application/pdf",
      extraction: "pending",
      warnings: [...originalOnlyWarnings, "원래 주의 메모"],
      createdAt: now,
      updatedAt: now,
    },
    {
      id: manualId(2),
      name: "기존 자료",
      kind: "other",
      text: "기존 본문",
      originalName: null,
      mimeType: null,
      extraction: "manual",
      warnings: [],
      createdAt: now,
      updatedAt: now,
    },
  ];
  const create = {
    id: manualId(3),
    name: "새 직접 입력 자료",
    kind: "consultation",
    text: "  상담에서 확인한 합성 내용\n추가 증빙은 아직 확인하지 않았습니다.  ",
    originalName: null,
    mimeType: null,
    extraction: "manual",
    warnings: [],
    createdAt: now,
    updatedAt: now,
  } satisfies SourceDocument;
  const edit = {
    ...company.sources[0],
    name: "원본 대조 직접 입력",
    kind: "patent" as const,
    text: "  원본에서 직접 입력한 합성 문장\n신청 여부는 미확인입니다.  ",
    extraction: "manual" as const,
  };
  return { company: caseSchema.parse(company), create, edit };
}
export function manualSourceResult(company: StudioCase, source: SourceDocument) {
  const next = structuredClone(company);
  const input = sourceSchema.parse(source);
  const old = next.sources.find((s) => s.id === source.id);
  const now = new Date(
    Math.max(Date.now(), Date.parse(old?.updatedAt ?? "") + 1 || 0),
  ).toISOString();
  const saved = {
    ...input,
    originalName: old?.originalName ?? null,
    mimeType: old?.mimeType ?? null,
    extraction: "manual" as const,
    warnings:
      old?.extraction === "pending"
        ? old.warnings.filter((w) => !(originalOnlyWarnings as readonly string[]).includes(w))
        : (old?.warnings ?? []),
    createdAt: old?.createdAt ?? now,
    updatedAt: now,
  };
  next.sources = old
    ? next.sources.map((s) => (s.id === source.id ? saved : s))
    : [...next.sources, saved];
  next.revision++;
  next.updatedAt = now;
  next.analysis = null;
  next.selectedCandidateId = null;
  next.plans = next.plans.map((p) => ({ ...p, confirmedAt: null }));
  return caseSchema.parse(next);
}
