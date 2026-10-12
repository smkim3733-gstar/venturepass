import { caseSchema, type StudioCase } from "../../src/lib/studio-schema";
import { manualSourceFixture, manualId } from "./manual-source-receipt";

export function sourceDeleteFixture() {
  const { company } = manualSourceFixture();
  company.profile.companyName = "합성 자료 삭제 확인 기업";
  company.sources[1].name = "같은 제목 자료";
  company.sources[1].text = "삭제할 직접 입력 본문";
  company.sources.push({ ...company.sources[1], id: manualId(3), text: "남겨 둘 같은 제목 본문" });
  return { company: caseSchema.parse(company), sourceId: company.sources[1].id };
}
export function sourceDeleteResult(company: StudioCase, sourceId: string) {
  const next = structuredClone(company);
  next.sources = next.sources.filter((source) => source.id !== sourceId);
  next.revision++;
  next.updatedAt = new Date().toISOString();
  next.analysis = null;
  next.selectedCandidateId = null;
  next.plans = next.plans.map((plan) => ({ ...plan, confirmedAt: null }));
  return caseSchema.parse(next);
}
