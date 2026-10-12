import {
  caseSchema,
  sourceSchema,
  originalOnlyWarnings,
  type StudioCase,
  type SourceDocument,
} from "../../src/lib/studio-schema";
import { manualSourceFixture, manualId } from "./manual-source-receipt";
export { manualId };
export function uploadReceiptFixture() {
  const company = manualSourceFixture().company;
  company.profile.companyName = "합성 파일 추가 확인 기업";
  return { company: caseSchema.parse(company) };
}
export function uploadReceiptResult(
  base: StudioCase,
  phase: "original" | "extract",
  name: string,
  kind: SourceDocument["kind"],
) {
  const saved = structuredClone(base);
  const now = "2026-10-12T07:11:00.000Z";
  saved.sources.push(
    sourceSchema.parse({
      id: manualId(phase === "original" ? 20 : 21),
      name,
      originalName: name,
      mimeType: phase === "original" ? "image/png" : "text/plain",
      kind,
      text: phase === "original" ? "" : "합성 파일의 추출 본문\n추가 확인은 미완료입니다.",
      extraction: phase === "original" ? "pending" : "local",
      warnings: phase === "original" ? [...originalOnlyWarnings] : [],
      createdAt: now,
      updatedAt: now,
    }),
  );
  saved.revision++;
  saved.updatedAt = now;
  saved.analysis = null;
  saved.selectedCandidateId = null;
  saved.plans = saved.plans.map((plan) => ({ ...plan, confirmedAt: null }));
  return caseSchema.parse(saved);
}
