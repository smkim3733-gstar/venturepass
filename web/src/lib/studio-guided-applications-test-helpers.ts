import { randomUUID } from "node:crypto";
import { applyApplicationMutation } from "./studio-applications";
import { publicEvidenceExportFixture } from "./studio-public-evidence-export-test-helpers";
import type { ApplicationMutation } from "./studio-application-types";
export function guidedApplicationsFixture() {
  const { record: company } = publicEvidenceExportFixture();
  company.profile.companyName = "합성 신청 기록 회사";
  company.stage = "evaluating";
  const apply = (
    input: Omit<ApplicationMutation, "revision" | "clientRequestId"> | Record<string, unknown>,
  ) => {
    applyApplicationMutation(
      company,
      {
        ...input,
        revision: company.revision,
        clientRequestId: randomUUID(),
      } as ApplicationMutation,
      {
        evidenceRevision: company.revision,
        readOriginal: () => {
          throw Error("No original read expected");
        },
      },
    );
  };
  apply({
    action: "create-application",
    title: "합성 첫 신청",
    kind: "new",
    plannedOn: "2026-09-01",
    criteriaNote: "",
    previousApplicationId: null,
  });
  apply({
    action: "record-application-submission",
    applicationId: company.applications[0].id,
    planId: company.plans[0].id,
    sourceIds: [],
    taskIds: [],
    receiptRecordId: null,
    occurredOn: "2026-09-02",
    recordedBy: "합성 담당자",
    note: "수동 제출 진술",
  });
  apply({
    action: "create-application",
    title: "합성 재확인 신청",
    kind: "renewal",
    plannedOn: "",
    criteriaNote: "",
    previousApplicationId: company.applications[0].id,
  });
  return { company, apply };
}
