import { it, expect } from "vitest";
import {
  linkReceiptCompany,
  linkReceiptResult,
  linkId,
} from "../../../scripts/fixtures/application-link-receipt";
import { applicationMutationSchema, isApplicationLink } from "@/lib/studio-application-types";
import {
  applicationLinkSaveAcknowledged as acknowledged,
  type ApplicationLinkMutation,
} from "./application-link-response";
function fixture(correction = false) {
  let company = linkReceiptCompany();
  let request = applicationMutationSchema.parse({
    action: "link-application-agency",
    revision: company.revision,
    clientRequestId: linkId(10),
    applicationId: company.applications[0].id,
    recordId: company.agencyRecords[0].id,
    note: "  원래 메모\n둘째 줄  ",
  }) as ApplicationLinkMutation;
  if (correction) {
    company = linkReceiptResult(company, request);
    request = applicationMutationSchema.parse({
      action: "correct-application-agency-link",
      revision: company.revision,
      clientRequestId: linkId(11),
      previousLinkEventId: linkId(3),
      fromApplicationId: company.applications[0].id,
      toApplicationId: null,
      recordId: company.agencyRecords[1].id,
      note: "  원래 정정 사유\n둘째 줄  ",
    }) as ApplicationLinkMutation;
  }
  const saved = linkReceiptResult(company, request, correction ? linkId(4) : linkId(3));
  const record = saved.applicationEvents.at(-1)!;
  if (!isApplicationLink(record)) throw Error("Fixture link required");
  return { company, request, saved, record };
}
for (const correction of [false, true]) {
  it(`${correction} 원래 기록 버전과 회차/해제 및 공백 계약을 대조하고 원본을 보존한다`, () => {
    const { company, request, saved } = fixture(correction),
      original = structuredClone({ company, request, saved });
    expect(acknowledged(saved, company, request)).toBe(true);
    expect({ company, request, saved }).toEqual(original);
  });
  for (const field of [
    "applicationId",
    "fromApplicationId",
    "previousLinkEventId",
    "chainRootId",
    "chainKind",
    "recordVersionId",
    "note",
    "kind",
    "clientRequestId",
  ] as const)
    it(`${correction} 다른 ${field} 거절`, () => {
      const { company, request, saved, record } = fixture(correction);
      if (field === "chainKind") record.chainKind = "request";
      else if (field === "kind")
        record.kind = correction ? "agency-link" : "agency-link-correction";
      else record[field] = field === "note" ? "다른 메모" : linkId(99);
      expect(acknowledged(saved, company, request)).toBe(false);
    });
}
for (const mismatch of [
  "company",
  "old-revision",
  "same-revision",
  "command-revision",
  "missing",
  "duplicate-id",
  "duplicate-request",
  "extra",
  "history",
  "agency",
  "plans",
  "tasks",
  "sources",
  "stage",
  "selected-missing",
  "selected-duplicate",
  "root-missing",
  "root-duplicate",
  "root-kind",
  "cycle-missing",
  "cycle-duplicate",
] as const)
  it(`${mismatch} 응답/기준은 수락하지 않는다`, () => {
    const { company, request, saved, record } = fixture();
    if (mismatch === "company") saved.id = linkId(99);
    if (mismatch === "old-revision") saved.revision = company.revision - 1;
    if (mismatch === "same-revision") saved.revision = company.revision;
    if (mismatch === "command-revision") request.revision--;
    if (mismatch === "missing") saved.applicationEvents.pop();
    if (mismatch === "duplicate-id") record.id = company.applications[0].id;
    if (mismatch === "duplicate-request")
      saved.applications[0].clientRequestId = request.clientRequestId;
    if (mismatch === "extra")
      saved.applicationEvents.push({ ...record, id: linkId(90), clientRequestId: linkId(91) });
    if (mismatch === "history") saved.applicationEvents.shift();
    if (mismatch === "agency") saved.agencyRecords[0].body = "다른 기관 기록";
    if (mismatch === "plans") saved.plans[0].content.title = "다른 원고";
    if (mismatch === "tasks") saved.tasks = [];
    if (mismatch === "sources") saved.sources = [{ bad: true } as never];
    if (mismatch === "stage") saved.stage = "drafting";
    if (mismatch === "selected-missing") request.recordId = linkId(99);
    if (mismatch === "selected-duplicate") {
      company.agencyRecords.push({ ...company.agencyRecords[0] });
      saved.agencyRecords = structuredClone(company.agencyRecords);
    }
    if (mismatch.startsWith("root-")) {
      request.recordId = company.agencyRecords[1].id;
      record.recordVersionId = request.recordId;
      if (mismatch === "root-missing") company.agencyRecords.shift();
      if (mismatch === "root-duplicate")
        company.agencyRecords.push({ ...company.agencyRecords[0] });
      if (mismatch === "root-kind")
        company.agencyRecords[0] = { ...company.agencyRecords[1], id: company.agencyRecords[0].id };
      saved.agencyRecords = structuredClone(company.agencyRecords);
    }
    if (mismatch === "cycle-missing" && request.action === "link-application-agency")
      request.applicationId = linkId(99);
    if (mismatch === "cycle-duplicate") {
      company.applications.push({ ...company.applications[0] });
      saved.applications = structuredClone(company.applications);
    }
    expect(acknowledged(saved, company, request)).toBe(false);
  });
it("정정의 원래 부모/귀속이 바뀌거나 현재 끝이 아니면 거절한다", () => {
  for (const field of ["previousLinkEventId", "fromApplicationId"] as const) {
    const { company, request, saved } = fixture(true);
    if (request.action !== "correct-application-agency-link") throw Error();
    request[field] = linkId(99);
    expect(acknowledged(saved, company, request)).toBe(false);
  }
  const { company, request, saved, record } = fixture(true);
  company.applicationEvents.push({ ...record, id: linkId(90), clientRequestId: linkId(91) });
  saved.applicationEvents = [...company.applicationEvents, record];
  expect(acknowledged(saved, company, request)).toBe(false);
});
it("기존 연결을 새 등록으로 대체하지 않고 다른 회차로의 명시 정정은 수락한다", () => {
  const { company, request } = fixture(true);
  if (request.action !== "correct-application-agency-link") throw Error();
  request.toApplicationId = company.applications[1].id;
  expect(acknowledged(linkReceiptResult(company, request, linkId(4)), company, request)).toBe(true);
  const initial = {
    action: "link-application-agency",
    revision: company.revision,
    clientRequestId: linkId(12),
    applicationId: company.applications[1].id,
    recordId: request.recordId,
    note: "",
  } as const;
  expect(acknowledged(linkReceiptResult(company, initial, linkId(4)), company, initial)).toBe(
    false,
  );
});
it("형식 오류와 이미 기준에 존재하는 요청을 새 저장으로 수락하지 않는다", () => {
  const { company, request, saved } = fixture();
  expect(acknowledged({ bad: true }, company, request)).toBe(false);
  expect(acknowledged(saved, saved, { ...request, revision: saved.revision })).toBe(false);
});

for (const kind of ["request", "request-correction", "response"] as const)
  it(`${kind} 원래 요청 체인의 정확한 선택 버전을 수락한다`, () => {
    const { company, request } = fixture();
    const root = {
      id: linkId(30),
      clientRequestId: linkId(31),
      inputDigest: "b".repeat(64),
      kind: "request" as const,
      requestRecordId: linkId(30),
      requestVersionId: linkId(30),
      previousVersionId: null,
      version: 1,
      origin: "manual" as const,
      recordedAt: "2026-10-10T00:00:00.000Z",
      institution: "합성 기관",
      title: "원래 요청",
      body: "합성 요청 본문",
      occurredOn: "",
      dueOn: "",
      dueNote: "",
      note: "",
      responseStatus: null,
      evidence: [],
    };
    company.agencyRecords = [root];
    if (kind !== "request")
      company.agencyRecords.push({
        ...root,
        id: linkId(32),
        clientRequestId: linkId(33),
        kind,
        previousVersionId: root.id,
        version: 2,
      });
    request.recordId = company.agencyRecords.at(-1)!.id;
    expect(acknowledged(linkReceiptResult(company, request), company, request)).toBe(true);
  });
