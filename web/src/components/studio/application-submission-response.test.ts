import { describe, it, expect, vi } from "vitest";
import {
  submissionReceiptCompany,
  submissionReceiptResult,
} from "../../../scripts/fixtures/application-submission-receipt";
import { applicationMutationSchema, isApplicationSubmission } from "@/lib/studio-application-types";
import {
  applicationSubmissionAcknowledged as ack,
  type SubmissionMutation,
} from "./application-submission-response";
const id = "f0000000-0000-4000-8000-000000000001",
  other = "e0000000-0000-4000-8000-000000000001";
async function fixture(action: SubmissionMutation["action"] = "record-application-submission") {
  const company = submissionReceiptCompany(),
    prior = company.applicationEvents.filter(isApplicationSubmission).at(-1)!;
  const command = applicationMutationSchema.parse({
    action,
    revision: company.revision,
    clientRequestId: id,
    applicationId: company.applications[0].id,
    planId: company.plans[0].id,
    sourceIds: [],
    taskIds: [company.tasks[0].id],
    receiptRecordId: null,
    occurredOn: "2026-10-10",
    recordedBy: "  원래 기록자  ",
    note: "  원래 메모\n다음 줄  ",
    ...(action === "correct-application-submission"
      ? { submissionRecordId: prior.submissionRecordId, previousVersionId: prior.id }
      : {}),
  }) as SubmissionMutation;
  const hash = [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(company.plans[0].content)),
      ),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const saved = submissionReceiptResult(company, command, other, hash),
    event = saved.applicationEvents.at(-1)!;
  if (!isApplicationSubmission(event)) throw Error();
  return { company, command, saved, event };
}
describe("제출 당시 기록의 원래 요청 대조", () => {
  for (const action of [
    "record-application-submission",
    "correct-application-submission",
  ] as const) {
    it(`${action} 원래 기록을 수락하고 입력을 바꾸지 않는다`, async () => {
      const f = await fixture(action);
      const original = structuredClone(f);
      expect(await ack(f.saved, f.company, f.command)).toBe(true);
      expect(f).toEqual(original);
    });
    for (const field of [
      "applicationId",
      "occurredOn",
      "recordedBy",
      "note",
      "receiptRecordId",
      "clientRequestId",
    ] as const)
      it(`${action} 다른 ${field} 거절`, async () => {
        const f = await fixture(action);
        f.event[field] =
          field === "occurredOn"
            ? "2026-10-11"
            : field === "note" || field === "recordedBy"
              ? "다른 내용"
              : other;
        expect(await ack(f.saved, f.company, f.command)).toBe(false);
      });
  }
  for (const field of [
    "id",
    "version",
    "generatedAt",
    "candidateId",
    "sourceRevision",
    "confirmedAt",
    "contentSha256",
    "review",
    "sections",
    "latestVersion",
  ] as const)
    it(`다른 원고 ${field} 거절`, async () => {
      const f = await fixture();
      const p = f.event.plan;
      if (field === "version" || field === "sourceRevision") p[field]++;
      else if (field === "review")
        p.review = [
          {
            id: "wrong",
            severity: "error",
            category: "confirmation",
            message: "다른 의견",
            action: "확인",
            sectionKey: null,
            sourceIds: [],
          },
        ];
      else if (field === "sections")
        p.sections[0].needsConfirmation = !p.sections[0].needsConfirmation;
      else if (field === "latestVersion") p.latestVersion = !p.latestVersion;
      else
        p[field] = field === "id" ? other : field === "contentSha256" ? "d".repeat(64) : "다른 값";
      expect(await ack(f.saved, f.company, f.command)).toBe(false);
    });
  for (const kind of [
    "missing",
    "history",
    "duplicate",
    "extra",
    "company",
    "revision",
    "context",
    "owners",
    "task-id",
    "source-id",
    "plan-body",
    "plan-duplicate",
  ] as const)
    it(`${kind} 불일치는 미확인으로 남긴다`, async () => {
      const f = await fixture();
      if (kind === "missing") f.saved.applicationEvents.pop();
      if (kind === "history") f.saved.applications[0].title = "다른 회차";
      if (kind === "duplicate") f.event.id = f.saved.applicationEvents[0].id;
      if (kind === "extra")
        f.saved.applicationEvents.push({
          ...f.event,
          id: crypto.randomUUID(),
          clientRequestId: crypto.randomUUID(),
        });
      if (kind === "company") f.saved.id = other;
      if (kind === "revision") f.saved.revision = f.company.revision;
      if (kind === "context") f.event.companySnapshot.revision++;
      if (kind === "owners") f.event.owners[0].owners.writing = "다른 담당자";
      if (kind === "task-id") f.event.owners = [];
      if (kind === "source-id") f.command.sourceIds = [other];
      if (kind === "plan-body") f.saved.plans[0].content.summary = "바뀐 원고";
      if (kind === "plan-duplicate") f.company.plans.push(structuredClone(f.company.plans[0]));
      expect(await ack(f.saved, f.company, f.command)).toBe(false);
    });
  for (const field of ["submissionRecordId", "previousVersionId", "version"] as const)
    it(`정정 ${field} 대조`, async () => {
      const f = await fixture("correct-application-submission");
      if (field === "version") f.event.version++;
      else f.event[field] = other;
      expect(await ack(f.saved, f.company, f.command)).toBe(false);
    });
  it("잘못된 형식과 해시 기능 오류를 성공으로 취급하지 않는다", async () => {
    const f = await fixture();
    expect(await ack({}, f.company, f.command)).toBe(false);
    const mock = vi
      .spyOn(crypto.subtle, "digest")
      .mockRejectedValue(new Error("synthetic unavailable"));
    try {
      expect(await ack(f.saved, f.company, f.command)).toBe(false);
    } finally {
      mock.mockRestore();
    }
  });
  it("선택 원본의 등록 메타데이터를 대조하고 파일명 변경·중복 자료를 거절한다", async () => {
    const f = await fixture();
    const source = {
      id: other,
      name: "합성 원본",
      kind: "other" as const,
      text: "합성 본문",
      originalName: "synthetic.txt",
      mimeType: "text/plain",
      extraction: "manual" as const,
      warnings: [],
      createdAt: "2026-10-10",
      updatedAt: "2026-10-10",
    };
    f.company.sources = [source];
    f.saved.sources = structuredClone(f.company.sources);
    f.command.sourceIds = [other];
    f.event.originals = [
      {
        sourceId: other,
        sourceName: source.name,
        originalName: source.originalName,
        mimeType: source.mimeType,
        sizeBytes: 3,
        sha256: "c".repeat(64),
        sourceUpdatedAt: source.updatedAt,
      },
    ];
    expect(await ack(f.saved, f.company, f.command)).toBe(true);
    f.event.originals[0].originalName = "wrong.txt";
    expect(await ack(f.saved, f.company, f.command)).toBe(false);
    f.event.originals[0].originalName = source.originalName;
    f.company.sources.push(structuredClone(source));
    expect(await ack(f.saved, f.company, f.command)).toBe(false);
  });
  it("지정한 접수 통보를 대조하고 없는 기록이나 중복 접수 기록을 거절한다", async () => {
    const f = await fixture();
    const receipt = f.company.agencyRecords[0];
    f.command.receiptRecordId = receipt.id;
    f.event.receiptRecordId = receipt.id;
    expect(await ack(f.saved, f.company, f.command)).toBe(true);
    f.company.agencyRecords = [];
    expect(await ack(f.saved, f.company, f.command)).toBe(false);
    f.company.agencyRecords = [receipt, structuredClone(receipt)];
    expect(await ack(f.saved, f.company, f.command)).toBe(false);
  });
});
