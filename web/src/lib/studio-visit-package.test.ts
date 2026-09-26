import { createHash, randomUUID } from "node:crypto";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { caseSchema, emptyProfile, type SourceDocument } from "./studio-schema";
import { buildVisitPackage } from "./studio-visit-package";
import {
  VISIT_PACKAGE_DOWNLOAD_NAME,
  visitPackageLimits,
  visitPackageRequestSchema,
  type VisitPackageRequest,
} from "./studio-visit-package-types";
import { buildVisitAnswer, visitAnswerInputDigest } from "./studio-visit-answer";
import { visitAnswerInputSchema, type VisitAnswerInput } from "./studio-visit-answer-types";
import { applyApplicationMutation } from "./studio-applications";
import { isApplicationSubmission } from "./studio-application-types";
import { buildPreparationPackage } from "./studio-package";
import { emptyCompanyContacts } from "./studio-company-contacts-types";
vi.mock("server-only", () => ({}));
vi.mock("openai", () => ({
  default: class {
    constructor() {
      throw new Error("External AI prohibited");
    }
  },
}));
const now = "2026-09-25T00:00:00.000Z";
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const source: SourceDocument = {
    id: randomUUID(),
    name: "선택한 합성 근거",
    kind: "technology",
    text: "실험 10건 기록",
    originalName: "fixture.pdf",
    mimeType: "application/pdf",
    extraction: "local",
    warnings: [],
    createdAt: now,
    updatedAt: now,
  };
  const unrelated = {
    ...source,
    id: randomUUID(),
    name: "PRIVATE_UNSELECTED_SOURCE",
    text: "PRIVATE_UNSELECTED_BODY",
  };
  const buffers = new Map([
    [source.id, Buffer.from("synthetic selected original")],
    [unrelated.id, Buffer.from("PRIVATE_UNSELECTED_BYTES")],
  ]);
  const company = caseSchema.parse({
    id: randomUUID(),
    profile: {
      ...emptyProfile(),
      companyName: "현재 합성 회사명",
      financials: "PRIVATE_PROFILE_BODY",
    },
    sources: [source, unrelated],
    analysis: null,
    selectedCandidateId: null,
    tasks: [],
    stage: "preparing",
    revision: 4,
    createdAt: now,
    updatedAt: now,
    companyContacts: [
      {
        id: randomUUID(),
        previousVersionId: null,
        version: 1,
        clientRequestId: randomUUID(),
        inputDigest: "a".repeat(64),
        origin: "manual",
        recordedAt: now,
        contacts: { ...emptyCompanyContacts(), note: "PRIVATE_CONTACT_NOTE" },
      },
    ],
    plans: [
      {
        id: randomUUID(),
        version: 1,
        generatedAt: now,
        mode: "manual",
        candidateId: "fixture",
        sourceRevision: 0,
        confirmedAt: null,
        content: {
          title: "합성 원고",
          summary: "원고 개요",
          sections: [
            {
              key: "technology",
              title: "기술",
              content: "실험 10건이라고 기재했습니다.",
              needsConfirmation: true,
              evidence: [{ sourceId: source.id, quote: "실험 10건", locator: "자료 1쪽" }],
            },
          ],
          actionItems: [],
          interviewQuestions: ["실험 근거는 무엇입니까?", "다음 개발 계획은 무엇입니까?"],
        },
        review: [],
      },
    ],
  });
  let currentEvidence = true;
  const store = {
    get: vi.fn(() => structuredClone(company)),
    isPlanCurrent: vi.fn(() => currentEvidence),
    originalForVentureInput: vi.fn((_caseId: string, id: string) => {
      const src = company.sources.find((item) => item.id === id)!;
      const buffer = Buffer.from(buffers.get(id)!);
      return { source: structuredClone(src), buffer, sha256: sha(buffer) };
    }),
  };
  const answerInput = (overrides: Partial<VisitAnswerInput> = {}) =>
    visitAnswerInputSchema.parse({
      answerId: null,
      previousVersionId: null,
      planId: company.plans[0].id,
      questionIndex: 0,
      questionText: company.plans[0].content.interviewQuestions[0],
      submissionRecordId: null,
      respondentRole: "technical",
      respondentName: "합성 응답자",
      answerText: "실험 10건이라고 기록했습니다.",
      pairs: [
        {
          id: randomUUID(),
          answerQuote: "실험 10건",
          planReference: { sectionKey: "technology", quote: "실험 10건" },
          sources: [
            {
              sourceId: source.id,
              sourceUpdatedAt: source.updatedAt,
              quote: "실험 10건",
              locator: "1쪽",
            },
          ],
          contextNote: "실행 여부 미확인",
        },
      ],
      followUpNote: "원문 대조 필요",
      review: { reviewed: false, reviewer: "", note: "" },
      ...overrides,
    });
  const append = (value = answerInput()) => {
    const record = buildVisitAnswer(
      company,
      value,
      {
        id: randomUUID(),
        clientRequestId: randomUUID(),
        inputDigest: visitAnswerInputDigest(value),
        recordedAt: now,
      },
      (id) => store.originalForVentureInput(company.id, id),
    );
    company.visitAnswers.push(record);
    return record;
  };
  const selected = append();
  append(
    answerInput({
      questionIndex: 1,
      questionText: company.plans[0].content.interviewQuestions[1],
      answerText: "PRIVATE_UNSELECTED_ANSWER",
      pairs: [],
      followUpNote: "PRIVATE_UNSELECTED_REPLY_NOTE",
    }),
  );
  store.originalForVentureInput.mockClear();
  const request = (overrides: Partial<VisitPackageRequest> = {}): VisitPackageRequest => ({
    revision: company.revision,
    mode: "draft",
    planId: company.plans[0].id,
    submissionRecordId: null,
    answerVersionIds: [selected.id],
    sourceIds: [source.id],
    ...overrides,
  });
  const build = (overrides: Partial<VisitPackageRequest> = {}) =>
    buildVisitPackage(store, company.id, request(overrides));
  const submission = () => {
    const context = {
      evidenceRevision: 0,
      readOriginal: (id: string) => store.originalForVentureInput(company.id, id),
    };
    applyApplicationMutation(
      company,
      {
        action: "create-application",
        revision: company.revision,
        clientRequestId: randomUUID(),
        title: "합성 회차",
        kind: "new",
        plannedOn: "",
        criteriaNote: "",
        previousApplicationId: null,
      },
      context,
    );
    applyApplicationMutation(
      company,
      {
        action: "record-application-submission",
        revision: company.revision,
        clientRequestId: randomUUID(),
        applicationId: company.applications.at(-1)!.id,
        planId: company.plans[0].id,
        sourceIds: [source.id],
        taskIds: [],
        receiptRecordId: null,
        occurredOn: "2026-09-25",
        recordedBy: "합성 기록자",
        note: "수동 제출 주장",
      },
      context,
    );
    const record = company.applicationEvents.at(-1)!;
    if (!isApplicationSubmission(record)) throw new Error("Bad fixture");
    return record;
  };
  return {
    company,
    source,
    unrelated,
    buffers,
    store,
    selected,
    request,
    build,
    append,
    answerInput,
    submission,
    setCurrent: (value: boolean) => (currentEvidence = value),
  };
}
afterEach(() => vi.restoreAllMocks());
const texts = async (buffer: Buffer) => {
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
  return {
    zip,
    text: (
      await Promise.all(
        Object.keys(zip.files)
          .filter((path) => !path.startsWith("originals/"))
          .map((path) => zip.file(path)!.async("string")),
      )
    ).join("\n"),
  };
};
describe("실사 질문·답변 출력 묶음", () => {
  it("선택 원고·답변·증빙과 SHA 목록만 보존하고 다른 자료·연락처를 제외한다", async () => {
    const f = fixture(),
      before = structuredClone(f.company),
      result = await f.build();
    expect(result.fileName).toBe(VISIT_PACKAGE_DOWNLOAD_NAME);
    expect(result.manifest).toMatchObject({
      draft: true,
      scope: "local-visit-preparation-only",
      mode: "draft",
      originals: [{ comparison: "saved-reference" }],
    });
    const { zip, text } = await texts(result.buffer);
    expect(Object.keys(zip.files).sort()).toEqual(
      [
        "README.md",
        "plan.json",
        "plan.md",
        "answers.json",
        "answers.md",
        "pending.md",
        "manifest.json",
        "manifest.md",
        `originals/${f.source.id}.pdf`,
      ].sort(),
    );
    for (const file of result.manifest.files) {
      const bytes = await zip.file(file.path)!.async("nodebuffer");
      expect(file).toMatchObject({ sizeBytes: bytes.length, sha256: sha(bytes) });
    }
    expect(text).not.toContain("PRIVATE_");
    expect(text).not.toContain(f.selected.clientRequestId);
    expect(text).not.toContain("clientRequestId");
    expect(text).toContain("DRAFT");
    expect(text).toContain("미검토");
    expect(text).toContain("제출 기록 미연결");
    expect(f.company).toEqual(before);
    expect(f.store.originalForVentureInput).toHaveBeenCalledTimes(2);
  });
  it("답변·원본 0개는 질문과 선택 답변 없음만 출력하고 원본을 읽지 않는다", async () => {
    const f = fixture(),
      result = await f.build({ answerVersionIds: [], sourceIds: [] });
    const { text } = await texts(result.buffer);
    expect(result.manifest.answers).toEqual([]);
    expect(result.manifest.originals).toEqual([]);
    expect(text).toContain("선택 답변 없음");
    expect(text).not.toContain("합성 응답자");
    expect(f.store.originalForVentureInput).not.toHaveBeenCalled();
  });
  it("원고 근거만 선택한 현재 파일은 과거 파일 일치로 표시하지 않는다", async () => {
    const f = fixture();
    f.company.visitAnswers = [];
    const result = await f.build({ answerVersionIds: [] });
    expect(result.manifest.originals[0].comparison).toBe("current-file");
    expect((await texts(result.buffer)).text).toContain(
      "과거 제출·답변 당시 파일임을 보장하지 않습니다",
    );
  });
  it("과거 원본이 달라져도 미선택이면 저장 메타만 출력하고 현재 본문으로 바꾸지 않는다", async () => {
    const f = fixture();
    f.buffers.set(f.source.id, Buffer.from("CHANGED_ORIGINAL_BYTES"));
    f.company.sources[0].text = "PRIVATE_CURRENT_REPLACEMENT_BODY";
    f.company.sources[0].updatedAt = "2026-09-26T00:00:00.000Z";
    const result = await f.build({ sourceIds: [] });
    expect(result.manifest.answers[0].currentContext).toBe("stale");
    const { text } = await texts(result.buffer);
    expect(text).toContain(f.selected.sourceSnapshots[0].original!.sha256);
    expect(text).toContain("원본 미포함");
    expect(text).not.toContain("PRIVATE_CURRENT_REPLACEMENT_BODY");
    expect(f.store.originalForVentureInput).not.toHaveBeenCalled();
  });
  it("동일 크기라도 과거 저장 SHA와 다른 원본은 포함하지 않는다", async () => {
    const f = fixture();
    f.buffers.set(f.source.id, Buffer.alloc(f.buffers.get(f.source.id)!.length, 33));
    await expect(f.build()).rejects.toMatchObject({
      code: "VISIT_PACKAGE_HISTORICAL_ORIGINAL_CHANGED",
    });
  });
  it("답변은 최신 버전으로 대체하지 않고 명시한 예전 버전을 출력한다", async () => {
    const f = fixture();
    const newer = f.append(
      f.answerInput({
        answerId: f.selected.answerId,
        previousVersionId: f.selected.id,
        followUpNote: "PRIVATE_NEWER_ANSWER_NOTE",
      }),
    );
    const result = await f.build();
    expect(result.manifest.answers.map((answer) => answer.id)).toEqual([f.selected.id]);
    expect((await texts(result.buffer)).text).not.toContain("PRIVATE_NEWER_ANSWER_NOTE");
    await expect(f.build({ answerVersionIds: [f.selected.id, newer.id] })).rejects.toMatchObject({
      code: "VISIT_PACKAGE_ANSWER_ROOT_DUPLICATE",
    });
  });
  it("수동 제출 당시 회사명과 현재 회사명을 분리하고 미연결 답변을 소급 귀속하지 않는다", async () => {
    const f = fixture(),
      submission = f.submission();
    f.company.profile.companyName = "이름 변경 뒤 현재회사";
    f.store.originalForVentureInput.mockClear();
    const result = await f.build({
      mode: "recorded-submission",
      submissionRecordId: submission.id,
    });
    expect(result.manifest.submission).toMatchObject({
      id: submission.id,
      recordedCompanyName: "현재 합성 회사명",
      officialVerification: "unverified",
    });
    expect(result.manifest.currentCompanyName).toBe("이름 변경 뒤 현재회사");
    expect(result.manifest.answers[0].submissionRecordId).toBeNull();
    expect((await texts(result.buffer)).text).toContain("소급 귀속하지 않음");
  });
  it("제출 귀속 답변은 exact 기록 모드에서만 출력하고 draft·다른 기록은 거부한다", async () => {
    const f = fixture(),
      submission = f.submission();
    const linked = f.append(
      f.answerInput({
        answerId: f.selected.answerId,
        previousVersionId: f.selected.id,
        submissionRecordId: submission.id,
      }),
    );
    await expect(f.build({ answerVersionIds: [linked.id] })).rejects.toMatchObject({
      code: "VISIT_PACKAGE_SUBMISSION_MISMATCH",
    });
    const result = await f.build({
      mode: "recorded-submission",
      submissionRecordId: submission.id,
      answerVersionIds: [linked.id],
    });
    expect(result.manifest.answers[0].submissionRecordId).toBe(submission.id);
    const other = f.submission();
    await expect(
      f.build({
        mode: "recorded-submission",
        submissionRecordId: other.id,
        answerVersionIds: [linked.id],
      }),
    ).rejects.toMatchObject({ code: "VISIT_PACKAGE_SUBMISSION_MISMATCH" });
  });
  it.each(["planId", "index", "text", "questionHash", "planHash", "title"])(
    "질문 연결 %s 변조를 거부한다",
    async (kind) => {
      const f = fixture(),
        record = f.company.visitAnswers[0];
      if (kind === "planId") record.planId = randomUUID();
      if (kind === "index") record.questionIndex = 1;
      if (kind === "text") record.questionText = "다른 질문";
      if (kind === "questionHash") record.questionSnapshot.questionSha256 = "b".repeat(64);
      if (kind === "planHash") record.questionSnapshot.planContentSha256 = "b".repeat(64);
      if (kind === "title") record.questionSnapshot.planTitle = "바뀐 제목";
      await expect(f.build()).rejects.toMatchObject({
        code: kind === "planHash" ? "VISIT_PACKAGE_PLAN_CHANGED" : "VISIT_PACKAGE_QUESTION_CHANGED",
      });
      expect(f.store.originalForVentureInput).not.toHaveBeenCalled();
    },
  );
  it.each(["answerText", "followUpNote", "respondentName"] as const)(
    "동일 버전의 %s 내용 변경은 input digest로 거부한다",
    async (key) => {
      const f = fixture();
      f.company.visitAnswers[0][key] += " 바뀜";
      await expect(f.build()).rejects.toMatchObject({ code: "VISIT_PACKAGE_ANSWER_CHANGED" });
    },
  );
  it("선택 원고·답변·원본의 외국 ID와 중복 ID를 원본 읽기 전 거부한다", async () => {
    const f = fixture();
    await expect(f.build({ planId: randomUUID() })).rejects.toMatchObject({
      code: "PLAN_NOT_FOUND",
    });
    await expect(f.build({ answerVersionIds: [randomUUID()] })).rejects.toMatchObject({
      code: "VISIT_PACKAGE_ANSWER_NOT_FOUND",
    });
    await expect(f.build({ sourceIds: [f.unrelated.id] })).rejects.toMatchObject({
      code: "VISIT_PACKAGE_SOURCE_NOT_SELECTED",
    });
    await expect(f.build({ sourceIds: [f.source.id, f.source.id] })).rejects.toThrow();
    expect(f.store.originalForVentureInput).not.toHaveBeenCalled();
  });
  it("제출 기록 정정 후에도 선택한 원래 기록의 버전·시각을 유지한다", async () => {
    const f = fixture(),
      first = f.submission();
    applyApplicationMutation(
      f.company,
      {
        action: "correct-application-submission",
        revision: f.company.revision,
        clientRequestId: randomUUID(),
        applicationId: first.applicationId,
        submissionRecordId: first.submissionRecordId,
        previousVersionId: first.id,
        planId: f.company.plans[0].id,
        sourceIds: [],
        taskIds: [],
        receiptRecordId: null,
        occurredOn: "2026-09-26",
        recordedBy: "다른 수동 담당자",
        note: "PRIVATE_LATER_SUBMISSION_NOTE",
      },
      {
        evidenceRevision: 0,
        readOriginal: (id) => f.store.originalForVentureInput(f.company.id, id),
      },
    );
    const result = await f.build({ mode: "recorded-submission", submissionRecordId: first.id });
    expect(result.manifest.submission).toMatchObject({
      id: first.id,
      version: 1,
      occurredOn: first.occurredOn,
    });
    expect((await texts(result.buffer)).text).not.toContain("PRIVATE_LATER_SUBMISSION_NOTE");
  });
  it("사용자 Markdown·HTML·닫는 fence는 코드 영역 안의 문자로 출력한다", async () => {
    const f = fixture();
    f.company.visitAnswers = [];
    f.company.plans[0].content.summary =
      "```\n![외부](https://example.invalid/x)\n<script>bad()</script>\n```";
    const result = await f.build({ answerVersionIds: [], sourceIds: [] });
    const zip = await JSZip.loadAsync(result.buffer);
    const text = await zip.file("plan.md")!.async("string");
    expect(text).toContain("````text\n```\n![외부]");
    expect(text).toContain("</script>\n```\n````");
  });
  it("원본명은 ZIP 경로가 되지 않으며 비지원 확장자는 bin이다", async () => {
    const f = fixture();
    f.company.visitAnswers = [];
    f.company.sources[0].originalName = "합성.실행.exe";
    const result = await f.build({ answerVersionIds: [] });
    expect(result.manifest.originals[0].path).toBe(`originals/${f.source.id}.bin`);
  });
  it("개별·합계 원본 한도를 ZIP 생성 전에 차단한다", async () => {
    const f = fixture();
    f.company.visitAnswers = [];
    f.buffers.set(f.source.id, Buffer.alloc(visitPackageLimits.originalBytes + 1));
    await expect(f.build({ answerVersionIds: [] })).rejects.toMatchObject({
      code: "PACKAGE_ORIGINAL_LIMIT",
      status: 413,
    });
    f.buffers.set(f.source.id, Buffer.alloc(12 * 1024 * 1024));
    const more = [1, 2].map((index) => ({ ...f.source, id: randomUUID(), name: `합성 ${index}` }));
    f.company.sources.push(...more);
    for (const source of more) {
      f.company.plans[0].content.sections[0].evidence.push({
        sourceId: source.id,
        quote: "실험 10건",
        locator: "",
      });
      f.buffers.set(source.id, Buffer.alloc(7 * 1024 * 1024));
    }
    await expect(
      f.build({ answerVersionIds: [], sourceIds: [f.source.id, ...more.map((item) => item.id)] }),
    ).rejects.toMatchObject({ code: "PACKAGE_ORIGINAL_LIMIT", status: 413 });
  });
  it("메타데이터 한도와 ZIP 최종 용량 한도를 검사한다", async () => {
    const f = fixture();
    f.company.visitAnswers = [];
    f.company.plans[0].content.summary = "가".repeat(500000);
    const spy = vi.spyOn(JSZip.prototype, "generateAsync");
    await expect(f.build({ answerVersionIds: [], sourceIds: [] })).rejects.toMatchObject({
      code: "PACKAGE_METADATA_LIMIT",
      status: 413,
    });
    expect(spy).not.toHaveBeenCalled();
    f.company.plans[0].content.summary = "정상";
    spy.mockResolvedValueOnce(Buffer.alloc(visitPackageLimits.zipBytes + 1));
    await expect(f.build({ answerVersionIds: [], sourceIds: [] })).rejects.toMatchObject({
      code: "PACKAGE_ZIP_LIMIT",
      status: 413,
    });
  });
  it.each(["revision", "plan", "answer", "contacts", "bytes", "currentEvidence"])(
    "압축 대기 중 %s 변경은 결과 전체를 폐기한다",
    async (kind) => {
      const f = fixture(),
        generate = JSZip.prototype.generateAsync;
      vi.spyOn(JSZip.prototype, "generateAsync").mockImplementationOnce(async function (
        this: JSZip,
        ...args
      ) {
        const bytes = await generate.apply(this, args);
        if (kind === "revision") f.company.revision++;
        if (kind === "plan") f.company.plans[0].content.summary = "변경";
        if (kind === "answer") f.company.visitAnswers[0].followUpNote = "변경";
        if (kind === "contacts") f.company.companyContacts[0].contacts.note = "변경";
        if (kind === "bytes")
          f.buffers.set(f.source.id, Buffer.alloc(f.buffers.get(f.source.id)!.length, 34));
        if (kind === "currentEvidence") f.setCurrent(false);
        return bytes;
      });
      await expect(f.build()).rejects.toMatchObject({
        code: kind === "bytes" ? "PACKAGE_ORIGINAL_CHANGED" : "VISIT_PACKAGE_SNAPSHOT_CHANGED",
      });
    },
  );
  it("안전 원본 reader 오류의 경로를 노출하지 않고 busy를 해제한다", async () => {
    const f = fixture();
    f.store.originalForVentureInput.mockImplementationOnce(() => {
      throw new Error("PRIVATE_LOCAL_PATH_OR_SECRET");
    });
    await expect(f.build()).rejects.toMatchObject({
      code: "PACKAGE_ORIGINAL_UNAVAILABLE",
      message: expect.not.stringContaining("PRIVATE_"),
    });
    await expect(f.build({ sourceIds: [] })).resolves.toHaveProperty("buffer");
  });
  it("기존 준비 ZIP과 새 실사 ZIP이 같은 작업 잠금을 사용한다", async () => {
    const f = fixture(),
      generate = JSZip.prototype.generateAsync;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(JSZip.prototype, "generateAsync").mockImplementationOnce(async function (
      this: JSZip,
      ...args
    ) {
      await waiting;
      return generate.apply(this, args);
    });
    const pending = f.build({ sourceIds: [] });
    try {
      await expect(
        buildPreparationPackage(f.store, f.company.id, {
          revision: f.company.revision,
          planId: f.company.plans[0].id,
          sourceIds: [],
        }),
      ).rejects.toMatchObject({ code: "PACKAGE_BUSY" });
      await expect(f.build()).rejects.toMatchObject({ code: "PACKAGE_BUSY" });
    } finally {
      release();
      await pending;
    }
    await expect(f.build({ sourceIds: [] })).resolves.toHaveProperty("buffer");
  });
  it("엄격한 모드·선택수·중복·원본경로 입력을 거부한다", () => {
    const f = fixture();
    for (const value of [
      { ...f.request(), path: "C:/private" },
      { ...f.request(), mode: "recorded-submission" },
      { ...f.request(), submissionRecordId: randomUUID() },
      { ...f.request(), answerVersionIds: Array.from({ length: 21 }, () => randomUUID()) },
      { ...f.request(), sourceIds: Array.from({ length: 11 }, () => randomUUID()) },
      { ...f.request(), answerVersionIds: [f.selected.id, f.selected.id] },
    ])
      expect(visitPackageRequestSchema.safeParse(value).success).toBe(false);
  });
});
