import { describe, it, expect } from "vitest";
import { submissionReadCompany } from "../../../scripts/fixtures/guided-submission-read";
import { applicationMutationSchema } from "@/lib/studio-application-types";
import {
  applicationCycleSaveAcknowledged as acknowledged,
  type ApplicationCycleMutation,
} from "./application-cycle-response";
const requestId = "f0000000-0000-4000-8000-000000000001";
const recordId = "e0000000-0000-4000-8000-000000000001";
const otherId = "d0000000-0000-4000-8000-000000000001";
function fixture(action: ApplicationCycleMutation["action"] = "create-application") {
  const company = submissionReadCompany();
  const details = {
    title: "  새 신청 회차  ",
    kind: "renewal" as const,
    plannedOn: "2026-10-11",
    criteriaNote: "  원래 기준 메모\n확인 필요  ",
    previousApplicationId: action === "create-application" ? company.applications[0].id : null,
  };
  const request = applicationMutationSchema.parse({
    action,
    revision: company.revision,
    clientRequestId: requestId,
    ...details,
    ...(action === "correct-application"
      ? { applicationId: company.applications[0].id, previousVersionId: company.applications[0].id }
      : {}),
  }) as ApplicationCycleMutation;
  const actual = { ...details, title: details.title.trim() } as const;
  const base = {
    id: recordId,
    clientRequestId: requestId,
    inputDigest: "a".repeat(64),
    origin: "manual" as const,
    recordedAt: "2026-10-10T00:00:00.000Z",
  };
  const saved = structuredClone(company);
  saved.revision++;
  if (action === "create-application")
    saved.applications.push({
      ...base,
      ...actual,
      companyAtCreation: {
        companyName: company.profile.companyName,
        businessNumber: company.profile.businessNumber,
      },
    });
  else
    saved.applicationEvents.push({
      ...base,
      kind: "cycle-correction",
      applicationId: company.applications[0].id,
      previousVersionId: company.applications[0].id,
      details: actual,
    });
  return { company, request, saved };
}
describe("신청 회차 저장의 원래 요청과 내용 대조", () => {
  for (const action of ["create-application", "correct-application"] as const) {
    it(`${action} 정확한 등록/정정과 같은 revision 재조회만 수락한다`, () => {
      const { company, request, saved } = fixture(action);
      const original = structuredClone(company);
      expect(acknowledged(saved, company, request)).toBe(true);
      expect(acknowledged(saved, saved, { ...request, revision: saved.revision })).toBe(true);
      expect(company).toEqual(original);
    });
    for (const field of [
      "title",
      "kind",
      "plannedOn",
      "criteriaNote",
      "previousApplicationId",
    ] as const)
      it(`${action} 같은 요청 번호라도 다른 ${field} 거절`, () => {
        const { company, request, saved } = fixture(action);
        const event = saved.applicationEvents.at(-1)!;
        if (action === "correct-application" && event.kind !== "cycle-correction")
          throw new Error("정정 시험 자료가 아닙니다.");
        const record =
          action === "create-application"
            ? saved.applications.at(-1)!
            : event.kind === "cycle-correction"
              ? event.details
              : saved.applications[0];
        if (field === "kind") record.kind = "new";
        else if (field === "previousApplicationId") record.previousApplicationId = otherId;
        else record[field] = field === "plannedOn" ? "2026-10-12" : "다른 내용";
        expect(acknowledged(saved, company, request)).toBe(false);
      });
  }
  for (const mismatch of [
    "missing",
    "request",
    "company",
    "revision",
    "history",
    "extra",
    "duplicate-id",
    "duplicate-request",
    "company-snapshot",
    "action",
  ] as const)
    it(`${mismatch} 응답은 원래 회차로 수락하지 않는다`, () => {
      const { company, request, saved } = fixture();
      const record = saved.applications.at(-1)!;
      if (mismatch === "missing") saved.applications.pop();
      if (mismatch === "request") record.clientRequestId = otherId;
      if (mismatch === "company") saved.id = otherId;
      if (mismatch === "revision") saved.revision = company.revision - 1;
      if (mismatch === "history") saved.applications[0].title = "변경된 과거";
      if (mismatch === "extra")
        saved.applications.push({ ...record, id: otherId, clientRequestId: otherId });
      if (mismatch === "duplicate-id") record.id = saved.applications[0].id;
      if (mismatch === "duplicate-request") saved.applications[0].clientRequestId = requestId;
      if (mismatch === "company-snapshot") record.companyAtCreation.companyName = "다른 회사";
      if (mismatch === "action") {
        saved.applications.pop();
        saved.applicationEvents.push({
          ...record,
          kind: "cycle-correction",
          applicationId: company.applications[0].id,
          previousVersionId: company.applications[0].id,
          details: {
            title: request.title,
            kind: request.kind,
            plannedOn: request.plannedOn,
            criteriaNote: request.criteriaNote,
            previousApplicationId: request.previousApplicationId,
          },
        } as never);
      }
      expect(acknowledged(saved, company, request)).toBe(false);
    });
  for (const mismatch of ["target", "parent", "stale-head"] as const)
    it(`정정 ${mismatch} 거절`, () => {
      const { company, request, saved } = fixture("correct-application");
      const record = saved.applicationEvents.at(-1)!;
      if (record.kind !== "cycle-correction") throw Error();
      if (mismatch === "target") record.applicationId = otherId;
      if (mismatch === "parent") record.previousVersionId = otherId;
      if (mismatch === "stale-head")
        (
          request as Extract<ApplicationCycleMutation, { action: "correct-application" }>
        ).previousVersionId = otherId;
      expect(acknowledged(saved, company, request)).toBe(false);
    });
  it("형식 오류와 새 기록이 없는 같은 revision은 거절한다", () => {
    const { company, request, saved } = fixture();
    expect(acknowledged({ bad: true }, company, request)).toBe(false);
    saved.revision = company.revision;
    expect(acknowledged(saved, company, request)).toBe(false);
  });
});
