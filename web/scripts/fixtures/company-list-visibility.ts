import { companyListFixture } from "./company-list";
import { summarizeCase } from "../../src/lib/studio-case-summary";
import { taskSchema } from "../../src/lib/studio-schema";
export function companyListVisibilityFixture() {
  const { companies } = companyListFixture();
  companies.forEach((company, index) => {
    company.tasks = [taskSchema.parse({id: index === 0 ? "e0000000-0000-4000-8000-000000000001" : "e0000000-0000-4000-8000-000000000002", title:"합성 목록 필터 업무", category:"other", dueDate:index === 0 ? "2000-01-01" : "", status:"pending", notes:"기한 필터 화면용 합성 기록"})];
  });
  return { companies, response: { cases: companies.map(summarizeCase) } };
}
