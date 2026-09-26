import { createHash, randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { caseSchema, emptyProfile, sourceSchema } from "@/lib/studio-schema";
import { buildAgencyRecord } from "@/lib/studio-agency-records";
import { applyApplicationMutation } from "@/lib/studio-applications";
import { applicationMetadata } from "@/lib/studio-application-types";
import { buildApplicationProcedure } from "@/lib/studio-application-procedure";
import type { ApplicationProcedureInput } from "@/lib/studio-application-procedure-types";
import { ApplicationHistory } from "./application-history";
import {
  ApplicationProcedureFields,
  ApplicationProcedures,
  ApplicationProcedureView,
} from "./application-procedures";
import {
  applicationProcedureInputProblem,
  applicationProcedureSaveAcknowledged,
  applicationProcedureUiContext,
  emptyApplicationProcedure,
  latestApplicationProcedures,
  procedureAgencyChoices,
} from "./application-procedures-ui";

const now = "2026-09-25T00:00:00.000Z";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const generated = () => ({ id: randomUUID(), clientRequestId: randomUUID(), recordedAt: now });
const noOriginal = (): never => {
  throw new Error("No source file reads in UI tests");
};
function fixture() {
  const company = caseSchema.parse({
    id: randomUUID(),
    profile: { ...emptyProfile(), companyName: "합성 회사" },
    sources: [],
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: "preparing",
    revision: 3,
    createdAt: now,
    updatedAt: now,
  });
  const context = { evidenceRevision: 0, readOriginal: noOriginal };
  applyApplicationMutation(
    company,
    {
      action: "create-application",
      revision: 3,
      clientRequestId: randomUUID(),
      title: "정확한 신청 회차",
      kind: "new",
      plannedOn: "",
      criteriaNote: "미확인",
      previousApplicationId: null,
    },
    context,
  );
  const request = buildAgencyRecord(
    [],
    {
      kind: "request",
      title: "원래 보완 요청",
      body: "원래 자료 안내",
      institution: "합성 기관",
      occurredOn: "",
      dueOn: "",
      dueNote: "",
      note: "",
      sourceIds: [],
    },
    { ...generated(), inputDigest: "a".repeat(64), evidence: [] },
  );
  company.agencyRecords.push(request);
  applyApplicationMutation(
    company,
    {
      action: "link-application-agency",
      revision: 3,
      clientRequestId: randomUUID(),
      applicationId: company.applications[0].id,
      recordId: request.id,
      note: "합성 귀속",
    },
    context,
  );
  const input: ApplicationProcedureInput = {
    ...emptyApplicationProcedure(),
    applicationId: company.applications[0].id,
    applicationMetadataVersionId: company.applications[0].id,
    agencyVersionId: request.id,
    expectedLinkEventId: company.applicationEvents[0].id,
    title: "서류 대응 기록",
    recordedBy: "합성 기록자",
  };
  const build = (raw = input) =>
    buildApplicationProcedure(company, company.applicationProcedures, raw, generated(), noOriginal);
  const correctAgency = () => {
    const corrected = buildAgencyRecord(
      company.agencyRecords,
      {
        kind: "request-correction",
        requestRecordId: request.id,
        previousVersionId: request.id,
        title: "새로운 기관 원문",
        body: "교체된 자료 안내",
        institution: request.institution,
        occurredOn: "",
        dueOn: "",
        dueNote: "",
        note: "",
        sourceIds: [],
      },
      { ...generated(), inputDigest: "b".repeat(64), evidence: [] },
    );
    company.agencyRecords.push(corrected);
    return corrected;
  };
  return { company, input, build, request, context, correctAgency };
}
function addSource(state: ReturnType<typeof fixture>) {
  const source = sourceSchema.parse({
    id: randomUUID(),
    name: "추가 증빙",
    kind: "other",
    text: "원래 정확한 인용 문장",
    originalName: null,
    mimeType: null,
    extraction: "manual",
    warnings: [],
    createdAt: now,
    updatedAt: now,
  });
  state.company.sources.push(source);
  state.input.evidence = [
    {
      sourceId: source.id,
      sourceUpdatedAt: source.updatedAt,
      quote: "정확한 인용",
      locator: "첫 문단",
    },
  ];
  return source;
}

describe("회차 절차 UI의 정확한 문맥 선택", () => {
  it("새 기록은 모든 날짜/상태/근거/회차를 미확인으로 시작한다", () => {
    const input = emptyApplicationProcedure();
    expect(input).toMatchObject({
      applicationId: "",
      applicationMetadataVersionId: "",
      agencyVersionId: "",
      expectedLinkEventId: "",
      procedureType: "unknown",
      extensionStatus: "unknown",
      status: "unknown",
      recordedBy: "",
      evidence: [],
    });
    for (const key of [
      "requestedOn",
      "dueOn",
      "extensionRequestedOn",
      "extensionDecidedOn",
      "extendedDueOn",
    ] as const)
      expect(input[key]).toBe("");
  });
  it("정정은 기입값만 복사하며 최신 참조/원본을 자동 재선택하지 않는다", () => {
    const state = fixture();
    addSource(state);
    const prior = state.build({
      ...state.input,
      dueOn: "2030-10-01",
      dueBasis: "담당자 안내 메모",
    });
    expect(emptyApplicationProcedure(prior)).toMatchObject({
      procedureId: prior.id,
      previousVersionId: prior.id,
      applicationId: prior.applicationId,
      dueOn: prior.dueOn,
      dueBasis: prior.dueBasis,
      applicationMetadataVersionId: "",
      agencyVersionId: "",
      expectedLinkEventId: "",
      evidence: [],
      recordedBy: "",
    });
  });
  it("회차에 귀속한 최신 기관 버전만 후보로 제공한다", () => {
    const state = fixture(),
      correction = state.correctAgency();
    expect(
      procedureAgencyChoices(state.company, state.input.applicationId).map(
        (value) => value.agency.id,
      ),
    ).toEqual([correction.id]);
    expect(procedureAgencyChoices(state.company, randomUUID())).toEqual([]);
    expect(applicationProcedureInputProblem(state.company, state.input)).toContain("최신 버전");
  });
  it("귀속 해제된 체인과 다른 체인으로의 정정은 선택하지 않는다", () => {
    const state = fixture(),
      record = state.build();
    expect(
      procedureAgencyChoices(state.company, state.input.applicationId, {
        ...record,
        chainRootId: randomUUID(),
      }),
    ).toEqual([]);
    const link = state.company.applicationEvents[0];
    if (link.kind !== "agency-link") throw new Error("fixture");
    state.company.applicationEvents.push({
      ...link,
      id: randomUUID(),
      kind: "agency-link-correction",
      previousLinkEventId: link.id,
      fromApplicationId: link.applicationId,
      applicationId: null,
    });
    expect(procedureAgencyChoices(state.company, state.input.applicationId)).toEqual([]);
  });
  it("중복 회차/기관 ID 후보는 모호하므로 제외한다", () => {
    const state = fixture();
    state.company.applications.push(state.company.applications[0]);
    expect(procedureAgencyChoices(state.company, state.input.applicationId)).toEqual([]);
    state.company.applications.pop();
    state.company.agencyRecords.push(state.request);
    expect(procedureAgencyChoices(state.company, state.input.applicationId)).toEqual([]);
  });
  it("최신 회차 정보와 최신 절차 이전 버전을 요구한다", () => {
    const state = fixture(),
      first = state.build();
    state.company.applicationProcedures.push(first);
    expect(
      applicationProcedureInputProblem(state.company, {
        ...state.input,
        procedureId: first.id,
        previousVersionId: randomUUID(),
      }),
    ).toContain("이전 버전");
    applyApplicationMutation(
      state.company,
      {
        action: "correct-application",
        revision: 3,
        clientRequestId: randomUUID(),
        applicationId: state.input.applicationId,
        previousVersionId: state.input.applicationMetadataVersionId,
        title: "바뀐 회차",
        kind: "new",
        plannedOn: "",
        criteriaNote: "",
        previousApplicationId: null,
      },
      state.context,
    );
    expect(applicationProcedureInputProblem(state.company, state.input)).toContain("최신 정보");
  });
  it("공란 근거·허용 미기록 연장기한은 저장 준비가 되지 않는다", () => {
    const { company, input } = fixture();
    expect(applicationProcedureInputProblem(company, { ...input, dueOn: "2026-10-01" })).toContain(
      "근거",
    );
    expect(
      applicationProcedureInputProblem(company, { ...input, extendedDueOn: "2026-11-01" }),
    ).toContain("연장 허용");
  });
  it.each(["foreign", "updated", "quote", "pending", "blank-no-original"])(
    "추가 증빙 %s는 묵시적으로 재연결하지 않는다",
    (change) => {
      const state = fixture(),
        source = addSource(state);
      if (change === "foreign") state.input.evidence[0].sourceId = randomUUID();
      if (change === "updated") source.updatedAt = "2026-09-26T00:00:00.000Z";
      if (change === "quote") source.text = "다른 문장";
      if (change === "pending") source.extraction = "pending";
      if (change === "blank-no-original") state.input.evidence[0].quote = "";
      expect(applicationProcedureInputProblem(state.company, state.input)).toContain("추가 증빙");
    },
  );
  it("원본만 보관한 자료는 본문 인용 없이 명시 연결할 수 있다", () => {
    const state = fixture(),
      source = addSource(state);
    source.extraction = "pending";
    source.text = "";
    source.originalName = "synthetic.pdf";
    state.input.evidence[0].quote = "";
    expect(applicationProcedureInputProblem(state.company, state.input)).toBe("");
  });
});

describe("절차 과거 기록의 읽기 대조와 저장 ACK", () => {
  it("원본 파일을 읽지 않고 로컬 메타·본문만 대조한다", async () => {
    const state = fixture();
    addSource(state);
    const record = state.build();
    expect(await applicationProcedureUiContext(state.company, record)).toEqual([]);
  });
  it.each(["cycle", "agency", "link", "text", "source-name", "source-time", "source-missing"])(
    "동일 ID라도 %s 변화는 재확인 사유다",
    async (change) => {
      const state = fixture(),
        source = addSource(state),
        record = state.build();
      if (change === "cycle") state.company.applications[0].title = "변경";
      if (change === "agency") state.request.body = "동일 ID 원문 변경";
      if (change === "link") {
        const link = state.company.applicationEvents[0];
        if (link.kind !== "agency-link") throw new Error("fixture");
        link.note = "동일 ID 변경";
      }
      if (change === "text") source.text += " 다른부분추가";
      if (change === "source-name") source.name = "변경";
      if (change === "source-time") source.updatedAt = "2026-09-26T00:00:00.000Z";
      if (change === "source-missing") state.company.sources = [];
      expect((await applicationProcedureUiContext(state.company, record)).length).toBeGreaterThan(
        0,
      );
    },
  );
  it("정확한 nonce·본문·버전 영수증만 저장 성공으로 인정한다", async () => {
    const state = fixture(),
      record = state.build();
    const result = structuredClone(state.company);
    result.applicationProcedures.push(record);
    result.revision++;
    expect(
      await applicationProcedureSaveAcknowledged(
        result,
        state.company,
        record.clientRequestId,
        state.input,
      ),
    ).toBe(true);
    expect(
      await applicationProcedureSaveAcknowledged(result, state.company, randomUUID(), state.input),
    ).toBe(false);
  });
  it.each([
    "company",
    "revision",
    "duplicate",
    "digest",
    "body",
    "link",
    "version",
    "root",
    "official",
  ])("잘못된 저장 ACK %s를 거부한다", async (change) => {
    const state = fixture(),
      record = state.build();
    const result = structuredClone(state.company);
    result.applicationProcedures.push(record);
    result.revision++;
    if (change === "company") result.id = randomUUID();
    if (change === "revision") result.revision = state.company.revision - 1;
    if (change === "duplicate") result.applicationProcedures.push(record);
    if (change === "digest") record.inputDigest = "f".repeat(64);
    if (change === "body") record.note = "다른 기입값";
    if (change === "link") record.linkEventId = randomUUID();
    if (change === "version") record.version = 2;
    if (change === "root") record.procedureId = randomUUID();
    const raw =
      change === "official"
        ? { ...result, applicationProcedures: [{ ...record, officialVerification: "verified" }] }
        : result;
    expect(
      await applicationProcedureSaveAcknowledged(
        raw,
        state.company,
        record.clientRequestId,
        state.input,
      ),
    ).toBe(false);
  });
  it("정정 ACK는 이전 버전을 그대로 유지하고 다음 버전과 정확히 연결한다", async () => {
    const state = fixture(),
      first = state.build();
    state.company.applicationProcedures.push(first);
    const before = structuredClone(first);
    const input = {
        ...state.input,
        procedureId: first.id,
        previousVersionId: first.id,
        note: "후속 확인",
      },
      second = state.build(input);
    const result = structuredClone(state.company);
    result.applicationProcedures.push(second);
    result.revision++;
    expect(
      await applicationProcedureSaveAcknowledged(
        result,
        state.company,
        second.clientRequestId,
        input,
      ),
    ).toBe(true);
    expect(latestApplicationProcedures(result.applicationProcedures)).toEqual([second]);
    expect(first).toEqual(before);
    expect(second.applicationSha256).toBe(
      hash(JSON.stringify(applicationMetadata(state.company, input.applicationId))),
    );
  });
});

describe("절차 기록 SSR 안내와 회차 연결", () => {
  it("미등록 회차는 추가 비활성·선행 단계 안내하며 mutation을 호출하지 않는다", () => {
    const { company } = fixture();
    company.applications = [];
    company.applicationEvents = [];
    const mutate = vi.fn(),
      html = renderToStaticMarkup(
        createElement(ApplicationProcedures, {
          company,
          mutate,
          blockedReason: "",
          onDirtyChange: vi.fn(),
        }),
      );
    expect(html).toContain("먼저 신청 회차를 등록");
    expect(html).toMatch(/disabled=""[^>]*>절차 기록 추가/);
    expect(mutate).not.toHaveBeenCalled();
  });
  it("빈 날짜 5개와 미확인 선택값을 표시하고 오늘 날짜를 삽입하지 않는다", () => {
    const html = renderToStaticMarkup(
      createElement(ApplicationProcedureFields, {
        input: emptyApplicationProcedure(),
        onChange: vi.fn(),
      }),
    );
    expect((html.match(/type="date"/g) ?? []).length).toBe(5);
    expect((html.match(/value="unknown" selected=""/g) ?? []).length).toBe(3);
    expect(html).not.toContain("2026-");
    expect(html).toContain("모르는 날짜는 비워 두세요");
  });
  it("과거 기관 원문을 현재 원문으로 교체하지 않으며 검사 전 성공 표시를 하지 않는다", () => {
    const state = fixture(),
      record = state.build();
    state.correctAgency();
    const html = renderToStaticMarkup(
      createElement(ApplicationProcedureView, { company: state.company, record }),
    );
    expect(html).toContain("원래 자료 안내");
    expect(html).not.toContain("교체된 자료 안내");
    expect(html).toContain("현재 연결 대조 전");
    expect(html).not.toContain("본문과 일치합니다");
    expect(html).toContain("기관 미확인");
    expect(html).toContain("미확인");
  });
  it("과거 정확 인용·원본 해시를 보존하고 사용자 HTML을 실행하지 않는다", () => {
    const state = fixture(),
      source = addSource(state),
      record = state.build();
    source.text = "현재 교체본문";
    record.title = "<script>synthetic()</script>";
    const snapshot = record.sourceSnapshots[0];
    snapshot.extraction = "pending";
    snapshot.original = {
      sourceId: source.id,
      sourceName: source.name,
      sourceUpdatedAt: source.updatedAt,
      originalName: "synthetic.pdf",
      mimeType: "application/pdf",
      sizeBytes: 123,
      sha256: "a".repeat(64),
      capturedAt: now,
    };
    const html = renderToStaticMarkup(
      createElement(ApplicationProcedureView, { company: state.company, record }),
    );
    expect(html).toContain("정확한 인용");
    expect(html).not.toContain("현재 교체본문");
    expect(html).toContain("synthetic.pdf");
    expect(html).toContain("a".repeat(64));
    expect(html).toContain("본문 검토 완료 아님");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
  it("회차 앵커를 정확히 연결하고 다른 폼 편집 중 새 저장 진입을 막는다", () => {
    const state = fixture(),
      props = {
        company: state.company,
        mutate: vi.fn(),
        blockedReason: "다른 폼 편집 중",
        onDirtyChange: vi.fn(),
      };
    const html = renderToStaticMarkup(createElement(ApplicationProcedures, props));
    const history = renderToStaticMarkup(createElement(ApplicationHistory, props));
    expect(html).toContain(`id="application-procedures-${state.input.applicationId}"`);
    expect(html).toContain(`href="#application-cycle-${state.input.applicationId}"`);
    expect(history).toContain(`id="application-cycle-${state.input.applicationId}"`);
    expect(history).toContain(`href="#application-procedures-${state.input.applicationId}"`);
    expect(html).toMatch(/disabled=""[^>]*>절차 기록 추가/);
    expect(html).toContain("다른 폼 편집 중");
  });
  it("지난 절차 버전과 새로운 기한을 동시에 조회하며 회사단계를 변경하지 않는다", () => {
    const state = fixture(),
      first = state.build({ ...state.input, dueOn: "2026-10-01", dueBasis: "첫 안내" });
    state.company.applicationProcedures.push(first);
    const second = state.build({
      ...state.input,
      procedureId: first.id,
      previousVersionId: first.id,
      dueOn: "2026-10-10",
      dueBasis: "정정 안내",
    });
    state.company.applicationProcedures.push(second);
    const before = structuredClone(state.company),
      mutate = vi.fn();
    const html = renderToStaticMarkup(
      createElement(ApplicationProcedures, {
        company: state.company,
        mutate,
        blockedReason: "",
        onDirtyChange: vi.fn(),
      }),
    );
    expect(html).toContain("과거 절차 버전 보기");
    expect(html).toContain("2026-10-01");
    expect(html).toContain("2026-10-10");
    expect(html).toContain("법정기한 계산이나 기관 승인·수신 확인이 아닙니다");
    expect(state.company).toEqual(before);
    expect(mutate).not.toHaveBeenCalled();
  });
});
