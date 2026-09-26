import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { caseSchema, emptyProfile, type SourceDocument } from "./studio-schema";
import { buildAgencyRecord } from "./studio-agency-records";
import { applyApplicationMutation } from "./studio-applications";
import { applicationMetadata } from "./studio-application-types";
import {
  applicationProcedureInputSchema,
  type ApplicationProcedureInput,
} from "./studio-application-procedure-types";
import {
  applicationProcedureContext,
  applicationProcedureDigest,
  assertApplicationProcedureCapacity,
  buildApplicationProcedure,
  isApplicationProcedureReplay,
} from "./studio-application-procedure";
const now = "2026-09-25T00:00:00.000Z";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const generated = () => ({ id: randomUUID(), clientRequestId: randomUUID(), recordedAt: now });
const noOriginal = vi.fn((): never => {
  throw new Error("No original expected");
});
function fixture() {
  const company = caseSchema.parse({
    id: randomUUID(),
    profile: { ...emptyProfile(), companyName: "합성 회차 절차" },
    sources: [],
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: "preparing",
    revision: 0,
    createdAt: now,
    updatedAt: now,
  });
  const context = { evidenceRevision: 0, readOriginal: noOriginal };
  applyApplicationMutation(
    company,
    {
      action: "create-application",
      revision: 0,
      clientRequestId: randomUUID(),
      title: "합성 신청 회차",
      kind: "new",
      plannedOn: "",
      criteriaNote: "미확인",
      previousApplicationId: null,
    },
    context,
  );
  company.agencyRecords.push(
    buildAgencyRecord(
      [],
      {
        kind: "request",
        title: "합성 보완 요청",
        body: "자료를 확인해 주세요.",
        institution: "합성 기관",
        occurredOn: "",
        dueOn: "",
        dueNote: "",
        note: "",
        sourceIds: [],
      },
      { ...generated(), inputDigest: "a".repeat(64), evidence: [] },
    ),
  );
  applyApplicationMutation(
    company,
    {
      action: "link-application-agency",
      revision: 0,
      clientRequestId: randomUUID(),
      applicationId: company.applications[0].id,
      recordId: company.agencyRecords[0].id,
      note: "합성 귀속",
    },
    context,
  );
  const input: ApplicationProcedureInput = {
    procedureId: null,
    previousVersionId: null,
    applicationId: company.applications[0].id,
    applicationMetadataVersionId: company.applications[0].id,
    agencyVersionId: company.agencyRecords[0].id,
    expectedLinkEventId: company.applicationEvents[0].id,
    title: "합성 서류 확인",
    procedureType: "document",
    requester: "합성 담당자",
    requestedOn: "",
    dueOn: "",
    dueBasis: "",
    extensionStatus: "unknown",
    extensionRequestedOn: "",
    extensionDecidedOn: "",
    extendedDueOn: "",
    extensionBasis: "",
    status: "unknown",
    statusBasis: "",
    completionBasis: "",
    recordedBy: "합성 기록자",
    note: "",
    evidence: [],
  };
  const build = (raw = input) =>
    buildApplicationProcedure(company, [], raw, generated(), noOriginal);
  return { company, input, context, build };
}
describe("회차별 절차 수동 기록의 독립 builder", () => {
  it("정확한 회차·귀속·기관 버전을 묶고 회사·업무·기관 상태를 바꾸지 않는다", () => {
    const { company, input, build } = fixture(),
      before = structuredClone(company);
    const record = build();
    expect(record.applicationId).toBe(input.applicationId);
    expect(record.agencySnapshot).toEqual(company.agencyRecords[0]);
    expect(record.origin).toBe("manual");
    expect(record.officialVerification).toBe("unverified");
    expect(record.dueOn).toBe("");
    expect(applicationProcedureContext(company, record)).toEqual([]);
    expect(company).toEqual(before);
  });
  it.each([
    { dueOn: "2026-02-30", dueBasis: "원문" },
    { dueOn: "2026-10-01" },
    { extensionStatus: "reported_allowed" },
    { extendedDueOn: "2026-11-01" },
    {
      extensionRequestedOn: "2026-10-03",
      extensionDecidedOn: "2026-10-01",
      extensionBasis: "원문",
    },
    { status: "reported_completed", statusBasis: "확인했다고 기록" },
    { officialVerification: "verified" },
    { previousVersionId: randomUUID() },
  ])("불명확·잘못된 입력과 서버 메타 삽입을 거부한다: %o", (changes) => {
    expect(
      applicationProcedureInputSchema.safeParse({ ...fixture().input, ...changes }).success,
    ).toBe(false);
  });
  it("미래 안내기한과 수동 연장 기재도 공식 승인으로 승격하지 않는다", () => {
    const { input, build } = fixture();
    const record = build({
      ...input,
      dueOn: "2030-10-01",
      dueBasis: "합성 안내",
      extensionStatus: "reported_allowed",
      extensionBasis: "담당자 메모, 실제 승인 확인 아님",
      extendedDueOn: "2030-11-01",
    });
    expect(record.officialVerification).toBe("unverified");
    expect(record.extendedDueOn).toBe("2030-11-01");
  });
  it.each([
    "applicationId",
    "applicationMetadataVersionId",
    "agencyVersionId",
    "expectedLinkEventId",
  ] as const)("다른/지난 참조 %s는 저장할 수 없다", (field) => {
    const { input, build } = fixture();
    expect(() => build({ ...input, [field]: randomUUID() })).toThrow();
  });
  it("nonce 재전송은 무변경, 다른 내용과 중복 영수증은 거부한다", () => {
    const { input, build } = fixture(),
      record = build();
    expect(
      isApplicationProcedureReplay(
        [record],
        record.clientRequestId,
        applicationProcedureDigest(input),
      ),
    ).toBe(true);
    expect(() =>
      isApplicationProcedureReplay(
        [record],
        record.clientRequestId,
        applicationProcedureDigest({ ...input, note: "다름" }),
      ),
    ).toThrow(expect.objectContaining({ code: "PROCEDURE_REQUEST_CONFLICT" }));
    expect(() =>
      isApplicationProcedureReplay([record, record], record.clientRequestId, record.inputDigest),
    ).toThrow();
  });
  it("정정은 과거 기록을 보존하고 정확한 마지막 버전에서만 이어진다", () => {
    const { company, input, build } = fixture(),
      first = build(),
      before = structuredClone(first);
    const correction = {
      ...input,
      procedureId: first.id,
      previousVersionId: first.id,
      note: "추가 확인",
    };
    const second = buildApplicationProcedure(company, [first], correction, generated(), noOriginal);
    expect(second.version).toBe(2);
    expect(second.procedureId).toBe(first.id);
    expect(first).toEqual(before);
    expect(() =>
      buildApplicationProcedure(company, [first, second], correction, generated(), noOriginal),
    ).toThrow(expect.objectContaining({ code: "PROCEDURE_VERSION_STALE" }));
  });
  it("기관 정정과 회차 귀속 변경은 과거 기록의 재확인 사유다", () => {
    const { company, input, build, context } = fixture(),
      record = build();
    const previous = company.agencyRecords[0];
    company.agencyRecords.push(
      buildAgencyRecord(
        company.agencyRecords,
        {
          kind: "request-correction",
          requestRecordId: previous.id,
          previousVersionId: previous.id,
          title: "정정 요청",
          body: "다른 자료를 확인해 주세요.",
          institution: "합성 기관",
          occurredOn: "",
          dueOn: "",
          dueNote: "",
          note: "",
          sourceIds: [],
        },
        { ...generated(), inputDigest: "b".repeat(64), evidence: [] },
      ),
    );
    expect(applicationProcedureContext(company, record)).toContain(
      "기관 요청·통보가 정정되었거나 없습니다.",
    );
    expect(() => build()).toThrow(expect.objectContaining({ code: "PROCEDURE_AGENCY_STALE" }));
    applyApplicationMutation(
      company,
      {
        action: "correct-application-agency-link",
        revision: 0,
        clientRequestId: randomUUID(),
        previousLinkEventId: input.expectedLinkEventId,
        fromApplicationId: input.applicationId,
        toApplicationId: null,
        recordId: previous.id,
        note: "미귀속 정정",
      },
      context,
    );
    expect(applicationProcedureContext(company, record)).toContain(
      "기관 기록의 회차 귀속이 바뀌었거나 없습니다.",
    );
  });
  it("같은 기관 버전 ID의 본문 변경도 다른 수동 기록으로 재사용하지 못한다", () => {
    const { company, input, build } = fixture(),
      record = build();
    company.agencyRecords[0].body = "같은 ID의 다른 내용";
    expect(() =>
      buildApplicationProcedure(company, [record], input, generated(), noOriginal),
    ).toThrow(expect.objectContaining({ code: "PROCEDURE_AGENCY_CHANGED" }));
  });
  it("자료의 정확 인용·수정시각·원본 해시를 보존하고 두 번째 읽기 변경을 거부한다", () => {
    const { company, input } = fixture();
    const source: SourceDocument = {
      id: randomUUID(),
      name: "추가 근거",
      kind: "other",
      text: "합성 추가 설명",
      originalName: "synthetic.txt",
      mimeType: "text/plain",
      extraction: "manual",
      warnings: [],
      createdAt: now,
      updatedAt: now,
    };
    company.sources.push(source);
    const raw = {
      ...input,
      evidence: [{ sourceId: source.id, sourceUpdatedAt: now, quote: "합성 추가", locator: "1행" }],
    };
    const buffer = Buffer.from("synthetic bytes");
    const reader = vi.fn(() => ({ source, buffer, sha256: hash(buffer) }));
    const record = buildApplicationProcedure(company, [], raw, generated(), reader);
    expect(reader).toHaveBeenCalledTimes(2);
    expect(record.sourceSnapshots[0].original?.sha256).toBe(hash(buffer));
    const changed = Buffer.from("changed bytes!");
    const unstable = vi
      .fn()
      .mockReturnValueOnce({ source, buffer, sha256: hash(buffer) })
      .mockReturnValue({ source, buffer: changed, sha256: hash(changed) });
    expect(() => buildApplicationProcedure(company, [], raw, generated(), unstable)).toThrow(
      expect.objectContaining({ code: "PROCEDURE_ORIGINAL_CHANGED" }),
    );
    source.text = "인용 없는 정정";
    expect(applicationProcedureContext(company, record)).toContain(
      "연결한 추가 증빙을 다시 확인해 주세요.",
    );
    expect(() => buildApplicationProcedure(company, [], raw, generated(), reader)).toThrow(
      expect.objectContaining({ code: "PROCEDURE_SOURCE_STALE" }),
    );
  });
  it("과거 절차에 고정한 원본과 같은 크기 다른 파일을 새 버전으로 연결하지 않는다", () => {
    const { company, input } = fixture();
    const source: SourceDocument = {
      id: randomUUID(),
      name: "원본 근거",
      kind: "other",
      text: "",
      originalName: "fixture.txt",
      mimeType: "text/plain",
      extraction: "pending",
      warnings: [],
      createdAt: now,
      updatedAt: now,
    };
    company.sources.push(source);
    const raw = {
      ...input,
      evidence: [{ sourceId: source.id, sourceUpdatedAt: now, quote: "", locator: "본문 미확인" }],
    };
    const readA = () => ({ source, buffer: Buffer.from("aaaa"), sha256: hash("aaaa") });
    const record = buildApplicationProcedure(company, [], raw, generated(), readA);
    expect(() =>
      buildApplicationProcedure(
        company,
        [record],
        { ...raw, procedureId: record.id, previousVersionId: record.id },
        generated(),
        () => ({ source, buffer: Buffer.from("bbbb"), sha256: hash("bbbb") }),
      ),
    ).toThrow(expect.objectContaining({ code: "PROCEDURE_ORIGINAL_CHANGED" }));
    expect(source.extraction).toBe("pending");
  });
  it("기록 한도와 회차 메타 변경을 확인한다", () => {
    const { company, input, build, context } = fixture(),
      record = build();
    expect(() => assertApplicationProcedureCapacity(Array(101).fill(record))).toThrow(
      expect.objectContaining({ code: "PROCEDURE_HISTORY_LIMIT" }),
    );
    applyApplicationMutation(
      company,
      {
        action: "correct-application",
        revision: 0,
        clientRequestId: randomUUID(),
        applicationId: input.applicationId,
        previousVersionId: input.applicationMetadataVersionId,
        title: "정정 제목",
        kind: "renewal",
        plannedOn: "",
        criteriaNote: "",
        previousApplicationId: null,
      },
      context,
    );
    expect(applicationMetadata(company, input.applicationId)?.metadataVersionId).not.toBe(
      input.applicationMetadataVersionId,
    );
    expect(applicationProcedureContext(company, record)).toContain(
      "신청 회차 정보가 바뀌었거나 없습니다.",
    );
  });
});
