import { z } from "zod";
import { packageLimits, type PackageOriginal } from "./studio-package-types";

export const VISIT_PACKAGE_DOWNLOAD_NAME = "venturepass-visit-package.zip";
export const visitPackageLimits = { ...packageLimits, answers: 20, requestBytes: 8192 } as const;
const uniqueIds = (maximum: number) =>
  z
    .array(z.string().uuid())
    .max(maximum)
    .refine((ids) => new Set(ids).size === ids.length, "같은 버전·자료를 중복 선택할 수 없습니다.");
export const visitPackageRequestSchema = z
  .object({
    revision: z.number().int().nonnegative().safe(),
    mode: z.enum(["draft", "recorded-submission"]),
    planId: z.string().uuid(),
    submissionRecordId: z.string().uuid().nullable(),
    answerVersionIds: uniqueIds(visitPackageLimits.answers),
    sourceIds: uniqueIds(visitPackageLimits.files),
  })
  .strict()
  .refine(
    (input) =>
      input.mode === "draft"
        ? input.submissionRecordId === null
        : input.submissionRecordId !== null,
    "초안은 제출 기록을 비우고, 제출 기록 기준은 정확한 기록을 선택해 주세요.",
  );
export type VisitPackageRequest = z.infer<typeof visitPackageRequestSchema>;
export type VisitPackageManifest = {
  formatVersion: 1;
  scope: "local-visit-preparation-only";
  draft: true;
  caseId: string;
  caseRevision: number;
  observedAt: string;
  mode: VisitPackageRequest["mode"];
  currentCompanyName: string;
  selection: Omit<VisitPackageRequest, "revision" | "mode">;
  plan: {
    id: string;
    version: number;
    title: string;
    contentSha256: string;
    currentEvidence: boolean;
    latestVersion: boolean;
    confirmedAt: string | null;
  };
  submission: {
    id: string;
    applicationId: string;
    version: number;
    occurredOn: string;
    recordedAt: string;
    recordedBy: string;
    note: string;
    recordedCompanyName: string;
    officialVerification: "unverified";
  } | null;
  answers: {
    id: string;
    answerId: string;
    version: number;
    questionIndex: number;
    submissionRecordId: string | null;
    reviewedAt: string | null;
    currentContext: "current" | "stale" | "missing";
  }[];
  originals: (PackageOriginal & { comparison: "saved-reference" | "current-file" })[];
  files: { path: string; sizeBytes: number; sha256: string }[];
  warnings: string[];
};
