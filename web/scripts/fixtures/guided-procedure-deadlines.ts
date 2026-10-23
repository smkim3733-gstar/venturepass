import {
  procedureReceiptFixture,
  procedureReceiptResult,
  linkId,
} from "./application-procedure-receipt";
import { caseSchema } from "../../src/lib/studio-schema";

export async function guidedDeadlineFixture() {
  const prepared = await procedureReceiptFixture();
  const base = prepared.company;
  base.profile.companyName = "합성 기한 연장 기업";
  base.stage = "evaluating";
  base.tasks = [];
  base.agencyRecords = base.agencyRecords.filter(
    (r) => r.kind === "request" || r.kind === "request-correction",
  );
  const request = base.agencyRecords.find((r) => r.id === prepared.input.agencyVersionId)!;
  if (request.kind !== "request" && request.kind !== "request-correction")
    throw Error("Synthetic request required");
  request.dueOn = "2026-10-13";
  request.dueNote = "합성 요청 원문의 기한";
  const input = {
    ...prepared.input,
    dueOn: "2026-10-13",
    dueBasis: "합성 담당자의 안내",
    extendedDueOn: "2026-11-03",
    extensionBasis: "합성 연장 허용 메모",
  };
  const company = await procedureReceiptResult(base, input, linkId(431));
  return { company: caseSchema.parse(company), base, input };
}
