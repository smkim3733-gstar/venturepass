import { z } from "zod";
export const PACKAGE_DOWNLOAD_NAME = "venturepass-preparation-package.zip";

export const packageLimits = {
  files: 10,
  originalBytes: 12 * 1024 * 1024,
  totalOriginalBytes: 24 * 1024 * 1024,
  metadataBytes: 2 * 1024 * 1024,
  zipBytes: 28 * 1024 * 1024,
} as const;
export const packageRequestSchema = z
  .object({
    revision: z.number().int().nonnegative().safe(),
    planId: z.string().uuid(),
    sourceIds: z
      .array(z.string().uuid())
      .max(packageLimits.files)
      .refine((ids) => new Set(ids).size === ids.length, "원본 자료를 중복 선택할 수 없습니다."),
  })
  .strict();
export type PackageRequest = z.infer<typeof packageRequestSchema>;
export type PackageEvidence = {
  sectionKey: string;
  sourceId: string;
  sourceName: string | null;
  sourceUpdatedAt: string | null;
  locator: string;
  quote: string;
  state: "matched" | "missing" | "pending" | "mismatch";
  originalIncluded: boolean;
};
export type PackageOriginal = {
  sourceId: string;
  path: string;
  originalName: string;
  mimeType: string | null;
  sizeBytes: number;
  sha256: string;
  sourceUpdatedAt: string;
  extraction: string;
};
export type PackageManifest = {
  formatVersion: 1;
  scope: "local-preparation-only";
  caseId: string;
  caseRevision: number;
  companyName: string;
  observedAt: string;
  plan: {
    id: string;
    version: number;
    generatedAt: string;
    sourceRevision: number;
    mode: string;
    currentEvidence: boolean;
    latestVersion: boolean;
    confirmedAt: string | null;
    draft: boolean;
    draftReasons: string[];
  };
  originals: PackageOriginal[];
  files: { path: string; sizeBytes: number; sha256: string }[];
  warnings: string[];
};
