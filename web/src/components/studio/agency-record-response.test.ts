import { it, expect } from "vitest";
import {
  agencyReceiptFixture,
  agencyReceiptResult,
  agencyId,
} from "../../../scripts/fixtures/agency-record-receipt";
import { agencyRecordSaveAcknowledged as acknowledged } from "./agency-record-response";
import { isAgencyNoticeRecord } from "@/lib/studio-agency-records";
for (const kind of [
  "request",
  "request-correction",
  "response",
  "notice",
  "notice-correction",
] as const) {
  it(`${kind} 원래 본문과 정정/답변 관계만 수락하고 입력을 바꾸지 않는다`, () => {
    const f = agencyReceiptFixture(kind),
      original = structuredClone(f);
    expect(acknowledged(f.saved, f.company, f.request)).toBe(true);
    expect(f).toEqual(original);
  });
  for (const field of ["body", "title", "previousVersionId"] as const)
    it(`${kind} 다른 ${field} 거절`, () => {
      const { company, request, saved } = agencyReceiptFixture(kind);
      saved.agencyRecords.at(-1)![field] =
        field === "previousVersionId" ? agencyId(99) : "다른 내용";
      expect(acknowledged(saved, company, request)).toBe(false);
    });
}
for (const mismatch of [
  "missing",
  "request-id",
  "record-id",
  "duplicate-request",
  "extra",
  "history",
  "company",
  "revision",
  "command-revision",
  "institution",
  "note",
  "date",
  "version",
  "request-root",
  "request-version",
  "due",
  "due-note",
  "response-status",
  "stage",
  "plan",
  "application-history",
  "format",
] as const)
  it(`${mismatch} 불일치 거절`, () => {
    const { company, request, saved } = agencyReceiptFixture();
    const record = saved.agencyRecords.at(-1)!;
    if (isAgencyNoticeRecord(record)) throw Error();
    if (mismatch === "missing") saved.agencyRecords.pop();
    if (mismatch === "request-id") record.clientRequestId = agencyId(99);
    if (mismatch === "record-id") record.id = company.agencyRecords[0].id;
    if (mismatch === "duplicate-request")
      saved.agencyRecords[0].clientRequestId = request.clientRequestId;
    if (mismatch === "extra")
      saved.agencyRecords.push({ ...record, id: agencyId(99), clientRequestId: agencyId(98) });
    if (mismatch === "history") saved.agencyRecords[0].body = "변경된 이력";
    if (mismatch === "company") saved.id = agencyId(99);
    if (mismatch === "revision") saved.revision = company.revision;
    if (mismatch === "command-revision") request.revision--;
    if (mismatch === "institution") record.institution = "다른 기관";
    if (mismatch === "note") record.note = "다른 메모";
    if (mismatch === "date") record.occurredOn = "2026-10-11";
    if (mismatch === "version") record.version++;
    if (mismatch === "request-root") record.requestRecordId = agencyId(99);
    if (mismatch === "request-version") record.requestVersionId = agencyId(99);
    if (mismatch === "due") record.dueOn = "2026-10-21";
    if (mismatch === "due-note") record.dueNote = "다른 기한";
    if (mismatch === "response-status") record.responseStatus = "reported-sent";
    if (mismatch === "stage") saved.stage = "drafting";
    if (mismatch === "plan") saved.plans[0].content.title = "다른 원고";
    if (mismatch === "application-history") saved.applicationEvents = [];
    expect(acknowledged(mismatch === "format" ? { bad: true } : saved, company, request)).toBe(
      false,
    );
  });
it("통보 상세와 답변의 기준 요청 버전 불일치를 거절한다", () => {
  const n = agencyReceiptFixture("notice"),
    r = n.saved.agencyRecords.at(-1)!;
  if (!isAgencyNoticeRecord(r) || r.details.category !== "receipt") throw Error();
  r.details.receiptNumber = "다른 번호";
  expect(acknowledged(n.saved, n.company, n.request)).toBe(false);
  const f = agencyReceiptFixture("response"),
    response = f.saved.agencyRecords.at(-1)!;
  if (isAgencyNoticeRecord(response)) throw Error();
  response.requestVersionId = agencyId(99);
  expect(acknowledged(f.saved, f.company, f.request)).toBe(false);
});
it("기준 이력의 중복 ID와 오래된 정정 부모를 거절한다", () => {
  const f = agencyReceiptFixture("notice-correction");
  if (f.request.record.kind !== "notice-correction") throw Error();
  f.request.record.previousVersionId = f.company.agencyRecords[0].id;
  expect(acknowledged(f.saved, f.company, f.request)).toBe(false);
  const n = agencyReceiptFixture();
  n.company.agencyRecords.push({ ...n.company.agencyRecords[0] });
  n.saved.agencyRecords = [...n.company.agencyRecords, n.saved.agencyRecords.at(-1)!];
  expect(acknowledged(n.saved, n.company, n.request)).toBe(false);
});
it("선택 원본의 등록 메타데이터만 대조하며 누락/중복/다른 원본을 거절한다", () => {
  const { company, request, saved } = agencyReceiptFixture();
  const source = {
    id: agencyId(50),
    name: "합성 원본",
    kind: "other" as const,
    text: "",
    extraction: "pending" as const,
    originalName: "synthetic.pdf",
    mimeType: "application/pdf",
    warnings: [],
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:00.000Z",
  };
  company.sources = [source];
  saved.sources = structuredClone(company.sources);
  request.record.sourceIds = [source.id];
  const record = saved.agencyRecords.at(-1)!;
  record.evidence = [
    {
      sourceId: source.id,
      sourceName: source.name,
      originalName: source.originalName,
      mimeType: source.mimeType,
      sizeBytes: 10,
      sha256: "b".repeat(64),
      capturedAt: record.recordedAt,
      sourceUpdatedAt: source.updatedAt,
    },
  ];
  expect(acknowledged(saved, company, request)).toBe(true);
  for (const field of [
    "sourceName",
    "originalName",
    "mimeType",
    "sourceUpdatedAt",
    "capturedAt",
  ] as const) {
    const wrong = structuredClone(saved);
    wrong.agencyRecords.at(-1)!.evidence[0][field] =
      field === "capturedAt" ? "2026-10-11T00:00:00.000Z" : "다른 값";
    expect(acknowledged(wrong, company, request)).toBe(false);
  }
  const missing = structuredClone(saved);
  missing.agencyRecords.at(-1)!.evidence = [];
  expect(acknowledged(missing, company, request)).toBe(false);
  company.sources.push({ ...source });
  saved.sources = structuredClone(company.sources);
  expect(acknowledged(saved, company, request)).toBe(false);
});
it("새 입력이 원래 요청 번호를 재사용한 응답은 이전 기록으로 수락하지 않는다", () => {
  const f = agencyReceiptFixture();
  expect(acknowledged(f.saved, f.saved, { ...f.request, revision: f.saved.revision })).toBe(false);
  const corrected = agencyReceiptResult(f.company, f.request);
  expect(acknowledged(corrected, f.company, f.request)).toBe(true);
});
