import { caseSchema } from "../../src/lib/studio-schema";
import {
  applicationCycleSchema,
  applicationEventSchema,
} from "../../src/lib/studio-application-types";
import { answerWorkflowCompany } from "./guided-answer-workflow";
const id = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const now = "2026-10-10T00:00:00.000Z";
const record = (n: number) => ({
  id: id(n),
  clientRequestId: id(n + 100),
  inputDigest: "a".repeat(64),
  recordedAt: now,
  origin: "manual" as const,
});
export function submissionReadCompany() {
  const company = answerWorkflowCompany();
  company.profile.companyName = "합성 제출 기록 읽기 기업";
  company.stage = "submitted";
  company.plans[0].version = 3;
  company.applications = [
    applicationCycleSchema.parse({
      ...record(1),
      title: "합성 첫 신청",
      kind: "new",
      plannedOn: "",
      criteriaNote: "",
      previousApplicationId: null,
      companyAtCreation: { companyName: "당시 회사", businessNumber: "" },
    }),
  ];
  const submission = applicationEventSchema.parse({
    ...record(2),
    kind: "submission-recorded",
    applicationId: id(1),
    submissionRecordId: id(2),
    previousVersionId: null,
    version: 1,
    occurredOn: "2026-09-01",
    recordedBy: "당시 기록자",
    note: "정정 전 메모",
    claim: "reported-submitted",
    officialVerification: "unverified",
    companySnapshot: {
      caseId: company.id,
      revision: 2,
      companyName: "당시 회사",
      businessNumber: "",
    },
    plan: {
      id: id(9),
      version: 1,
      generatedAt: now,
      mode: "manual",
      candidateId: "synthetic",
      sourceRevision: 1,
      contentSha256: "b".repeat(64),
      confirmedAt: null,
      review: [
        {
          id: "saved-review",
          severity: "warning",
          category: "confirmation",
          message: "당시 남은 확인 사항",
          action: "원문 직접 확인",
          sectionKey: null,
          sourceIds: [],
        },
      ],
      sections: [{ key: "problem", needsConfirmation: true }],
      latestVersion: false,
      currentEvidence: false,
    },
    evidence: [
      {
        sectionKey: "problem",
        sourceId: id(8),
        sourceName: "당시 인용 자료",
        sourceUpdatedAt: now,
        quote: "  당시 인용 첫 문장\n<img src=x onerror=alert(1)> 합성 문구  ",
        locator: "첫 문단",
        state: "mismatch",
      },
    ],
    originals: [
      {
        sourceId: id(8),
        sourceName: "당시 원본",
        originalName: "synthetic-original.pdf",
        mimeType: "application/pdf",
        sizeBytes: 123,
        sha256: "c".repeat(64),
        sourceUpdatedAt: now,
      },
    ],
    owners: [
      {
        taskId: id(7),
        title: "당시 담당 업무",
        agencyOrigin: null,
        owners: { materials: "당시 준비자", writing: "당시 작성자", review: "" },
      },
    ],
    receiptRecordId: id(4),
  });
  company.applicationEvents = [
    submission,
    applicationEventSchema.parse({
      ...submission,
      ...record(3),
      kind: "submission-correction",
      previousVersionId: id(2),
      version: 2,
      note: "  정정한 메모\n원문 보존  ",
    }),
  ];
  company.agencyRecords = [
    {
      ...record(4),
      kind: "notice",
      noticeRecordId: id(4),
      previousVersionId: null,
      version: 1,
      institution: "합성 기관",
      title: "접수 안내 원문",
      body: "  당시 접수 안내\n담당자가 보관한 문장  ",
      occurredOn: "",
      note: "",
      evidence: [],
      details: {
        category: "receipt",
        receiptNumber: "원래-접수번호",
        receivedOn: "2026-09-02",
        statusText: "당시 안내",
      },
    },
  ];
  const originalReceipt = company.agencyRecords[0];
  if (originalReceipt.kind !== "notice") throw Error("Synthetic receipt required");
  company.agencyRecords.push({
    ...originalReceipt,
    ...record(5),
    kind: "notice-correction",
    previousVersionId: id(4),
    version: 2,
    body: "후속 접수 안내로 바꾸지 않음",
    details: {
      category: "receipt",
      receiptNumber: "다른-최신번호",
      receivedOn: "",
      statusText: "후속 안내",
    },
  });
  return caseSchema.parse(company);
}
