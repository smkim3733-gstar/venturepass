import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { emptyProfile, type SourceDocument } from "./studio-schema";
import {
  assertDiagnosisAnswers,
  buildLocalDiagnosis,
  diagnosisHistoryCharacters,
  diagnosisInputFingerprint,
  refreshDiagnosisStaleness,
  type DiagnosisInput,
} from "./studio-diagnosis";
import {
  diagnosisAnswersSchema,
  diagnosisCriteriaVersion,
  diagnosisSchema,
  emptyDiagnosisAnswers,
  type Diagnosis,
} from "./studio-diagnosis-types";

function fixture(): DiagnosisInput {
  return {
    profile: { ...emptyProfile(), companyName: "가상 진단기업" },
    sources: [],
    diagnosisAnswers: emptyDiagnosisAnswers(),
  };
}
function source(overrides: Partial<SourceDocument> = {}): SourceDocument {
  return {
    id: randomUUID(),
    name: "시험 문서",
    kind: "other",
    text: "가상 기업의 중소기업 해당 근거입니다.\n실제 영위 업종을 확인한 가상 문서입니다.",
    originalName: "fixture.pdf",
    mimeType: "application/pdf",
    extraction: "local",
    warnings: [],
    createdAt: "2026-09-25T00:00:00.000Z",
    updatedAt: "2026-09-25T00:00:00.000Z",
    ...overrides,
  };
}
function reviewed(): DiagnosisInput {
  const record = fixture();
  const document = source();
  record.sources = [document];
  record.diagnosisAnswers.entityType = "corporate";
  record.diagnosisAnswers.criteriaVersion = diagnosisCriteriaVersion;
  for (const key of ["sme", "industryEligibility"] as const) {
    record.diagnosisAnswers[key] = {
      status: "supported",
      reviewed: true,
      note: "사용자가 원문과 현재 기준을 대조한 시험 기록",
      evidence: [
        {
          sourceId: document.id,
          sourceUpdatedAt: document.updatedAt,
          quote: document.text.split("\n")[key === "sme" ? 0 : 1],
          locator: "원문 첫 페이지",
        },
      ],
    };
  }
  return record;
}
function diagnosis(record: DiagnosisInput): Diagnosis {
  return diagnosisSchema.parse({
    ...buildLocalDiagnosis(record),
    id: randomUUID(),
    clientRequestId: randomUUID(),
    requestDigest: "a".repeat(64),
    version: 1,
    sourceRevision: 3,
    inputFingerprint: diagnosisInputFingerprint(record),
    criteriaVersion: diagnosisCriteriaVersion,
    generatedAt: "2026-09-25T00:00:00.000Z",
  });
}

describe("로컬 사전진단의 검토·인용 경계", () => {
  it("미입력 회사는 점수·자격단정 없이 판단 보류와 구체 질문을 남긴다", () => {
    const result = buildLocalDiagnosis(fixture());
    expect(result.mode).toBe("assisted");
    expect(result.outcome).toBe("insufficient");
    expect(
      result.items
        .filter((item) => item.area === "eligibility")
        .every((item) => item.status === "unknown"),
    ).toBe(true);
    expect(result.questions.length).toBeGreaterThan(0);
    expect(result.actions.every((action) => action.title && action.notes)).toBe(true);
    expect(result).not.toHaveProperty("score");
    expect(result).not.toHaveProperty("probability");
  });
  it("현재 원문을 직접 검토한 기본요건만 사용자 검토의 supported로 기록한다", () => {
    const record = reviewed();
    expect(() => assertDiagnosisAnswers(record, record.diagnosisAnswers)).not.toThrow();
    const result = buildLocalDiagnosis(record);
    const items = result.items.filter((item) => item.area === "eligibility");
    expect(items.map((item) => item.status)).toEqual(["supported", "supported"]);
    expect(
      items.every(
        (item) => item.reason.includes("사용자") && item.reason.includes("기관 판정은 아닙니다"),
      ),
    ).toBe(true);
    expect(items[0].evidence[0]).toMatchObject({
      provenance: "documented",
      sourceId: record.sources[0].id,
      quote: record.diagnosisAnswers.sme.evidence[0].quote,
      locator: "원문 첫 페이지",
    });
    expect(result.outcome).toBe("insufficient");
  });
  it("검토된 미충족 근거는 설명의 분량과 관계없이 요건 문제로 남긴다", () => {
    const record = reviewed();
    record.diagnosisAnswers.sme.status = "contradicted";
    record.profile.technologySummary = "기술 설명".repeat(1000);
    record.profile.customers = "고객 설명".repeat(1000);
    expect(buildLocalDiagnosis(record).outcome).toBe("eligibility_issue");
  });
  it.each([
    "pending",
    "foreign",
    "quote",
    "timestamp",
    "criteria",
    "unreviewed",
    "no-original",
    "consultation",
    "ambiguous",
  ])("%s 근거는 새 저장에서 거부하고 과거 답변 재진단은 unknown으로 내린다", (kind) => {
    const record = reviewed();
    if (kind === "pending") record.sources[0].extraction = "pending";
    if (kind === "foreign") record.diagnosisAnswers.sme.evidence[0].sourceId = randomUUID();
    if (kind === "quote") record.diagnosisAnswers.sme.evidence[0].quote = "원문에 없는 주장";
    if (kind === "timestamp") record.sources[0].updatedAt = "2026-09-26T00:00:00.000Z";
    if (kind === "criteria") record.diagnosisAnswers.criteriaVersion = "old-criteria";
    if (kind === "unreviewed") record.diagnosisAnswers.sme.reviewed = false;
    if (kind === "no-original") record.sources[0].originalName = null;
    if (kind === "consultation") record.sources[0].kind = "consultation";
    if (kind === "ambiguous") record.sources.push({ ...record.sources[0] });
    expect(() => assertDiagnosisAnswers(record, record.diagnosisAnswers)).toThrow();
    expect(
      buildLocalDiagnosis(record).items.find((item) => item.id === "eligibility-sme")?.status,
    ).toBe("unknown");
  });
  it("자료 삭제나 동일 인용을 남긴 다른 부분 수정 후에도 재진단 자체는 가능하다", () => {
    const record = reviewed();
    record.sources[0].text += "\n수정한 다른 부분";
    record.sources[0].updatedAt = "2026-09-25T00:01:00.000Z";
    expect(buildLocalDiagnosis(record).outcome).toBe("insufficient");
    record.sources = [];
    expect(() => buildLocalDiagnosis(record)).not.toThrow();
    expect(buildLocalDiagnosis(record).outcome).toBe("insufficient");
  });
  it("회사명·확인서 파일명·KSIC 숫자만으로 기본요건을 자동 충족시키지 않는다", () => {
    const record = fixture();
    record.profile.industry = "62010";
    record.sources = [
      source({ name: "유효한 중소기업확인서", originalName: "중소기업확인서.pdf", text: "62010" }),
    ];
    expect(
      buildLocalDiagnosis(record)
        .items.filter((item) => item.area === "eligibility")
        .map((item) => item.status),
    ).toEqual(["unknown", "unknown"]);
  });
  it("문서 없는 담당자 진술은 기본요건 확인근거로 승격하지 않는다", () => {
    const record = reviewed();
    record.sources[0].originalName = null;
    const item = buildLocalDiagnosis(record).items[0];
    expect(item.status).toBe("unknown");
    expect(item.evidence[0].provenance).toBe("reported");
  });
  it("판독 검토 저장한 문서도 등록 문서 기재일 뿐 외부 검증으로 표시하지 않는다", () => {
    const record = reviewed();
    record.sources[0].extraction = "manual";
    const result = buildLocalDiagnosis(record);
    expect(result.items[0].evidence[0].provenance).toBe("documented");
    expect(result.warnings.join(" ")).toContain("원본 파일 바이트");
    expect(result.warnings.join(" ")).toContain("진위");
    expect(result.warnings.join(" ")).toContain("독립 확인하지 않았습니다");
  });
});

describe("설명 존재와 준비 완료의 구분", () => {
  it("기본요건 검토와 핵심 설명은 미확인 초안의 시작 안내만 제공한다", () => {
    const record = reviewed();
    record.profile.technologySummary = "담당자가 설명한 제품 구조";
    record.profile.customers = "담당자가 설명한 고객 문제";
    const result = buildLocalDiagnosis(record);
    expect(result.outcome).toBe("draft_recommended");
    expect(
      result.items
        .filter((item) => ["technology", "growth"].includes(item.area))
        .every((item) => item.status !== "supported"),
    ).toBe(true);
    expect(result.items.find((item) => item.id === "technology-difference")?.status).toBe(
      "unknown",
    );
    expect(result.actions.some((item) => item.id === "action-technology-difference")).toBe(true);
    expect(result.warnings.join(" ")).toContain("전체 제출 준비 완료가 아닙니다");
  });
  it("차별·시험·매출 단어 추가만으로 대표 결과나 기술 판정을 상향하지 않는다", () => {
    const record = reviewed();
    record.profile.technologySummary = "담당자 기술 설명";
    record.profile.customers = "담당자 고객 설명";
    const before = buildLocalDiagnosis(record);
    record.sources.push(
      source({ kind: "technology", text: "비교 시험 차별 시장 매출 자금 개발 연구 외주" }),
    );
    const after = buildLocalDiagnosis(record);
    expect(after.outcome).toBe(before.outcome);
    expect(after.items.find((item) => item.id === "technology-difference")?.status).toBe(
      "needs_work",
    );
    expect(
      after.items
        .filter((item) => ["technology", "growth"].includes(item.area))
        .every((item) => item.status !== "supported"),
    ).toBe(true);
  });
  it("한 단어와 긴 설명 모두 정확성·충분성은 추가 검토 상태다", () => {
    const record = fixture();
    for (const text of ["기술", "기술 설명".repeat(1600)]) {
      record.profile.technologySummary = text;
      const item = buildLocalDiagnosis(record).items.find(
        (item) => item.id === "technology-description",
      )!;
      expect(item.status).toBe("needs_work");
      expect(item.evidence[0].quote.length).toBeLessThanOrEqual(1500);
      expect(record.profile.technologySummary).toContain(item.evidence[0].quote);
    }
  });
  it("특허·매출·연구조직 자료가 없다는 이유만으로 요건 미충족으로 처리하지 않는다", () => {
    const result = buildLocalDiagnosis(fixture());
    expect(result.outcome).not.toBe("eligibility_issue");
    expect(result.items.some((item) => item.status === "contradicted")).toBe(false);
  });
  it("pending 원문은 기술 설명에서 제외하고 미추출 신뢰성 항목에만 남긴다", () => {
    const record = fixture();
    record.sources.push(
      source({
        kind: "technology",
        extraction: "pending",
        text: "기술 개발 완료라는 잘못 주입한 값",
      }),
    );
    const result = buildLocalDiagnosis(record);
    expect(result.items.flatMap((item) => item.evidence)).toEqual([]);
    expect(result.items.find((item) => item.id === "reliability-context")?.reason).toContain(
      "미추출 원본 1건",
    );
    expect(JSON.stringify(result)).not.toContain("잘못 주입한 값");
  });
  it("출처 위치와 인용을 보존하되 새 페이지 번호나 검증 실적을 만들지 않는다", () => {
    const record = fixture();
    const document = source({
      name: "기술 상담 원문",
      kind: "consultation",
      text: "  기술 작동 범위를 논의했습니다.  \n다른 설명",
    });
    record.sources.push(document);
    const evidence = buildLocalDiagnosis(record).items.find(
      (item) => item.id === "technology-description",
    )!.evidence[0];
    expect(evidence).toMatchObject({
      sourceId: document.id,
      quote: "기술 작동 범위를 논의했습니다.",
      locator: document.name,
      provenance: "reported",
    });
    expect(document.text).toContain(evidence.quote);
  });
  it("보강 업무는 항목별 고정 ID와 실제 확인 지시를 가지며 중복하지 않는다", () => {
    const result = buildLocalDiagnosis(fixture());
    expect(new Set(result.items.map((item) => item.id)).size).toBe(result.items.length);
    expect(new Set(result.actions.map((item) => item.id)).size).toBe(result.actions.length);
    expect(
      result.questions.every((question) =>
        result.items.some((item) => item.id === question.itemId),
      ),
    ).toBe(true);
    expect(
      result.actions.every((action) =>
        action.notes.includes("업무 완료 체크만으로 근거가 보강되지 않습니다"),
      ),
    ).toBe(true);
  });
});

describe("사전진단의 증거 fingerprint와 과거 이력", () => {
  it("같은 자료는 결정적 결과와 fingerprint를 만든다", () => {
    const record = reviewed();
    expect(buildLocalDiagnosis(structuredClone(record))).toEqual(buildLocalDiagnosis(record));
    expect(diagnosisInputFingerprint(structuredClone(record))).toBe(
      diagnosisInputFingerprint(record),
    );
    expect(diagnosisInputFingerprint(record)).toMatch(/^[a-f0-9]{64}$/);
  });
  it("객체 속성 순서와 자료 나열 순서는 fingerprint를 바꾸지 않는다", () => {
    const record = reviewed();
    record.sources.push(source({ text: "다른 가상 문서" }));
    const before = diagnosisInputFingerprint(record);
    record.profile = Object.fromEntries(
      Object.entries(record.profile).reverse(),
    ) as typeof record.profile;
    record.sources.reverse();
    expect(diagnosisInputFingerprint(record)).toBe(before);
  });
  it.each(["profile", "source-text", "source-time", "source-meta", "source-delete", "answer"])(
    "%s 변경은 stale로 표시하며 과거 판단·인용·시각은 유지한다",
    (kind) => {
      const record = reviewed();
      const history = diagnosis(record);
      const before = structuredClone(history);
      const current = { ...record, diagnoses: [history] };
      refreshDiagnosisStaleness(current);
      expect(history.stale).toBe(false);
      if (kind === "profile") record.profile.industry = "변경 업종";
      if (kind === "source-text") record.sources[0].text += " 추가";
      if (kind === "source-time") record.sources[0].updatedAt = "changed";
      if (kind === "source-meta") record.sources[0].name = "변경된 이름";
      if (kind === "source-delete") current.sources = [];
      if (kind === "answer") record.diagnosisAnswers.sme.note = "다른 검토 메모";
      refreshDiagnosisStaleness(current);
      expect(history).toEqual({ ...before, stale: true });
    },
  );
  it("회사 revision·재분석·원고표현·업무완료·단계는 자료 fingerprint를 바꾸지 않는다", () => {
    const record = reviewed();
    const before = diagnosisInputFingerprint(record);
    const current = {
      ...record,
      diagnoses: [diagnosis(record)],
      revision: 999,
      analysis: { summary: "새 표현" },
      plans: [{ content: "바꾼 글" }],
      tasks: [{ status: "done" }],
      stage: "confirmed",
    };
    expect(diagnosisInputFingerprint(current)).toBe(before);
    refreshDiagnosisStaleness(current);
    expect(current.diagnoses[0].stale).toBe(false);
  });
  it("기준 버전 변경은 같은 자료의 과거 결과를 stale로 만든다", () => {
    const record = reviewed();
    const old = diagnosis(record);
    old.criteriaVersion = "old-version";
    refreshDiagnosisStaleness({ ...record, diagnoses: [old] });
    expect(old.stale).toBe(true);
  });
  it("legacy stale 누락은 서버 재평가 전까지 보수적으로 true다", () => {
    const item = diagnosis(reviewed());
    expect(item.stale).toBe(true);
  });
  it("이력 본문 한도 계산은 인용·질문·업무·경고도 포함하며 임의 절삭하지 않는다", () => {
    const item = diagnosis(reviewed());
    const before = diagnosisHistoryCharacters([item]);
    item.items[0].evidence[0].quote += "abc";
    item.actions[0].notes += "defg";
    item.warnings.push("hij");
    expect(diagnosisHistoryCharacters([item])).toBe(before + 10);
  });
});

describe("사전진단 입력 schema", () => {
  it("기본 상태는 법인·개인과 모든 기본요건이 미확인이다", () => {
    expect(diagnosisAnswersSchema.parse(emptyDiagnosisAnswers())).toMatchObject({
      entityType: "unknown",
      criteriaVersion: null,
      sme: { status: "unknown", reviewed: false, evidence: [] },
    });
  });
  it.each([
    "no-review",
    "no-evidence",
    "missing-timestamp",
    "quote-limit",
    "note-limit",
    "extra-field",
  ])("%s 입력은 검토 근거로 저장할 수 없다", (kind) => {
    const answers = reviewed().diagnosisAnswers;
    if (kind === "no-review") answers.sme.reviewed = false;
    if (kind === "no-evidence") answers.sme.evidence = [];
    if (kind === "missing-timestamp") answers.sme.evidence[0].sourceUpdatedAt = "";
    if (kind === "quote-limit") answers.sme.evidence[0].quote = "a".repeat(1501);
    if (kind === "note-limit") answers.sme.note = "a".repeat(2001);
    const input = kind === "extra-field" ? { ...answers, verifiedByAgency: true } : answers;
    expect(diagnosisAnswersSchema.safeParse(input).success).toBe(false);
  });
});
