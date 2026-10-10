import { caseSchema, type StudioCase } from "../../src/lib/studio-schema";
import { agencyReceiptFixture, agencyId } from "./agency-record-receipt";
export { agencyId };
export function agencyTaskFixture() {
  const company = agencyReceiptFixture("request-correction").saved;
  company.profile.companyName = "합성 기관 업무 저장 기업";
  company.tasks.push({
    id: agencyId(50),
    title: "이전 요청의 담당자 수정 업무",
    category: "supplement",
    dueDate: "2026-10-19",
    status: "done",
    notes: "담당자가 보관한 이전 업무",
    owners: { materials: "자료 담당자", writing: "작성 담당자", review: "검토 담당자" },
    agencyOrigin: { requestRecordId: agencyId(1), requestVersionId: agencyId(1) },
  });
  const request = {
    action: "create-agency-task" as const,
    revision: company.revision,
    requestRecordId: agencyId(1),
    requestVersionId: agencyId(3),
  };
  return { company: caseSchema.parse(company), request, saved: agencyTaskResult(company) };
}
// Fixed memory response based on the existing creation contract; no storage or writer import.
export function agencyTaskResult(base: StudioCase) {
  const saved = structuredClone(base);
  saved.tasks.push({
    id: agencyId(51),
    title: "기관 요청 대응: 원래 기록 제목",
    category: "supplement",
    dueDate: "2026-10-20",
    status: "pending",
    notes:
      "기관 요청 v2에 연결한 업무입니다.\n기관: 합성 기관\n기록된 요청 기한: 2026-10-20\n기한 근거: 원래 기한 근거\n요청 원문과 연결 증빙은 위 기관 요청 기록에서 확인하세요. 업무 완료는 기관 발송·접수 확인이 아닙니다.",
    agencyOrigin: { requestRecordId: agencyId(1), requestVersionId: agencyId(3) },
  });
  saved.revision++;
  return caseSchema.parse(saved);
}
