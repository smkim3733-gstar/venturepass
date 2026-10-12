import { companyCreateFixture } from "./company-create-receipt";
import { summarizeCase } from "../../src/lib/studio-case-summary";
export function companyListFixture() {
  const first = companyCreateFixture().existing;
  first.profile.companyName = "합성 기술 기업";
  first.profile.industry = "정밀 제조";
  const second = structuredClone(first);
  second.id = "d0000000-0000-4000-8000-000000000010";
  second.profile.companyName = "합성 자료 기업";
  second.profile.industry = "소프트웨어";
  const companies = [first, second];
  return { companies, response: { cases: companies.map(summarizeCase) } };
}
