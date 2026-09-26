import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import {
  emptyProfile,
  originalOnlyWarnings,
  type StudioCase,
  type SourceDocument,
} from "./studio-schema";
import type { AgencyRecord, AgencyRecordInput } from "./studio-agency-records";
import { withVentureInputCompanyLock } from "./venturein-input-lock";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  store: null as StudioStore | null,
  aiConstructor: vi.fn(),
  aiParse: vi.fn(),
}));
vi.mock("@/lib/studio-storage", async (original) => ({
  ...(await original<typeof import("./studio-storage")>()),
  getStudioStore: () => state.store!,
}));
vi.mock("openai", () => ({
  default: class {
    responses = { parse: state.aiParse };
    constructor() {
      state.aiConstructor();
    }
  },
}));
vi.mock("@/lib/venturein-runner", () => ({ stopVentureSession: vi.fn() }));
import { PATCH, GET } from "@/app/api/studio/cases/[caseId]/route";
import { analyzeCompany, reviewPlan } from "./studio-engine";

describe("기관 요청·답변 로컬 기록 저장/API", () => {
  let directory: string;
  let company: StudioCase;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "venture-agency-record-test-"));
    state.store = new StudioStore(directory);
    company = state.store.create({ ...emptyProfile(), companyName: "기관기록 시험기업" });
    state.aiConstructor.mockReset();
    state.aiParse.mockReset();
    vi.stubEnv("OPENAI_API_KEY", "");
  });
  afterEach(() => {
    state.store!.close();
    const boundary = relative(resolve(tmpdir()), resolve(directory));
    if (!boundary.startsWith("venture-agency-record-test-") || boundary.includes(".."))
      throw new Error("Unsafe cleanup");
    rmSync(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  const request = (body: unknown, headers: Record<string, string> = {}) =>
    new Request("http://localhost:3000/api/studio/cases/fixture", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const context = (id = company.id) => ({ params: Promise.resolve({ caseId: id }) });
  const input = (
    overrides: Partial<Extract<AgencyRecordInput, { kind: "request" }>> = {},
  ): Extract<AgencyRecordInput, { kind: "request" }> => ({
    kind: "request",
    institution: "가상 확인기관",
    title: "보완 자료 요청",
    body: "시험 요청 내용입니다.",
    occurredOn: "2026-09-25",
    dueOn: "2026-10-01",
    dueNote: "담당자 확인 예정",
    note: "사용자 수동 기록",
    sourceIds: [],
    ...overrides,
  });
  const body = (
    record: AgencyRecordInput = input(),
    clientRequestId: string = randomUUID(),
    revision = company.revision,
  ) => ({
    action: "append-agency-record",
    revision,
    clientRequestId,
    record,
  });
  const patch = (payload: unknown, id = company.id) => PATCH(request(payload), context(id));
  const save = async (record: AgencyRecordInput = input()) => {
    const response = await patch(body(record));
    expect(response.status).toBe(200);
    company = await response.json();
    return company.agencyRecords.at(-1)!;
  };
  const originalPath = (sourceId: string, id = company.id) =>
    join(directory, "originals", id, `${sourceId}.bin`);
  const addOriginal = (
    bytes = Buffer.from("%PDF-1.7\nsynthetic-source\n%%EOF"),
    id = company.id,
  ) => {
    const now = new Date().toISOString();
    const source: SourceDocument = {
      id: randomUUID(),
      name: "가상 요청 원문",
      kind: "other",
      text: "",
      originalName: "fixture.pdf",
      mimeType: "application/pdf",
      extraction: "pending",
      warnings: [...originalOnlyWarnings],
      createdAt: now,
      updatedAt: now,
    };
    const current = state.store!.get(id);
    const result = state.store!.addUpload(id, current.revision, source, bytes);
    if (id === company.id) company = result;
    return { source, bytes, path: originalPath(source.id, id) };
  };
  const replaceBody = (value: unknown) => {
    const db = new DatabaseSync(join(directory, "studio.sqlite"));
    try {
      db.prepare("UPDATE studio_cases SET body = ? WHERE id = ?").run(
        JSON.stringify(value),
        company.id,
      );
    } finally {
      db.close();
    }
  };
  const responseInput = (
    requestRecordId: string,
    previousVersionId: string | null = null,
    overrides: Record<string, unknown> = {},
  ): AgencyRecordInput =>
    ({
      kind: "response",
      requestRecordId,
      previousVersionId,
      title: "보완 답변 초안",
      body: "아직 기관에 보내지 않은 초안입니다.",
      occurredOn: "",
      note: "검토 중",
      sourceIds: [],
      responseStatus: "draft",
      ...overrides,
    }) as AgencyRecordInput;

  it("legacy 기업은 빈 목록으로 읽으며 기존 데이터를 임의 수정하지 않는다", async () => {
    const legacy = { ...company } as Record<string, unknown>;
    delete legacy.agencyRecords;
    replaceBody(legacy);
    const response = await GET(new Request("http://localhost:3000/api/studio"), context());
    expect(response.status).toBe(200);
    const restored = await response.json();
    expect(restored.agencyRecords).toEqual([]);
    expect(restored.revision).toBe(company.revision);
    const saved = await save();
    expect(saved.origin).toBe("manual");
    expect(company.agencyRecords).toHaveLength(1);
  });
  it("요청 원본의 실제 SHA256·파일 메타를 서버에서 읽어 보존하고 재시작 후 복원한다", async () => {
    const file = addOriginal();
    const before = company;
    const saved = await save(input({ sourceIds: [file.source.id] }));
    expect(saved).toMatchObject({
      kind: "request",
      version: 1,
      origin: "manual",
      responseStatus: null,
      evidence: [
        {
          sourceId: file.source.id,
          sourceName: file.source.name,
          originalName: "fixture.pdf",
          mimeType: "application/pdf",
          sizeBytes: file.bytes.length,
          sha256: createHash("sha256").update(file.bytes).digest("hex"),
          sourceUpdatedAt: file.source.updatedAt,
        },
      ],
    });
    expect(Number.isFinite(Date.parse(saved.recordedAt))).toBe(true);
    expect(Number.isFinite(Date.parse(saved.evidence[0].capturedAt))).toBe(true);
    expect(saved.inputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(saved)).not.toContain(directory);
    expect(JSON.stringify(saved)).not.toContain(file.bytes.toString());
    expect(company.sources).toEqual(before.sources);
    state.store!.close();
    state.store = new StudioStore(directory);
    expect(state.store.get(company.id)).toEqual(company);
  });
  it("같은 크기의 원본 변경을 SHA로 차단하고 이미 기록한 과거 해시를 갱신하지 않는다", async () => {
    const file = addOriginal();
    const first = await save(input({ sourceIds: [file.source.id] }));
    const before = company;
    writeFileSync(file.path, Buffer.alloc(file.bytes.length, 65));
    const response = await patch(
      body(input({ title: "두 번째 연결", sourceIds: [file.source.id] })),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "AGENCY_EVIDENCE_CHANGED" });
    expect(state.store!.get(company.id)).toEqual(before);
    expect(state.store!.get(company.id).agencyRecords[0].evidence[0].sha256).toBe(
      first.evidence[0].sha256,
    );
  });
  it("기록 후 원본 이름·MIME 변경도 새 연결에서 차단한다", async () => {
    const file = addOriginal();
    await save(input({ sourceIds: [file.source.id] }));
    const tampered = structuredClone(company);
    tampered.sources[0].originalName = "changed.pdf";
    replaceBody(tampered);
    const response = await patch(body(input({ sourceIds: [file.source.id] })));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "AGENCY_EVIDENCE_CHANGED" });
    expect(state.store!.get(company.id).agencyRecords).toEqual(company.agencyRecords);
  });
  it("자료 본문·표시명 메모 수정은 허용하되 과거 캡처메타와 원본해시는 그대로 보존한다", async () => {
    const file = addOriginal();
    const first = await save(input({ sourceIds: [file.source.id] }));
    company = state.store!.mutate(
      company.id,
      {
        action: "source",
        revision: company.revision,
        source: {
          ...file.source,
          name: "수동 대조 이름",
          text: "직접 확인한 원문 내용",
          extraction: "manual",
        },
      },
      () => [],
    );
    const second = await save(input({ title: "같은 원본 재연결", sourceIds: [file.source.id] }));
    expect(second.evidence[0].sha256).toBe(first.evidence[0].sha256);
    expect(second.evidence[0].sourceName).toBe("수동 대조 이름");
    expect(company.agencyRecords[0]).toEqual(first);
  });
  it("참조한 원본 자료 삭제는 409로 막고 원본파일과 회사 상태를 모두 보존한다", async () => {
    const file = addOriginal();
    await save(input({ sourceIds: [file.source.id] }));
    const before = company;
    const response = await patch({
      action: "delete-source",
      revision: company.revision,
      sourceId: file.source.id,
    });
    expect(response.status).toBe(409);
    expect(state.store!.get(company.id)).toEqual(before);
    expect(existsSync(file.path)).toBe(true);
    expect(state.store!.original(company.id, file.source.id).buffer).toEqual(file.bytes);
  });
  it("참조하지 않은 원본은 기존 삭제 경로로 삭제할 수 있다", async () => {
    const kept = addOriginal();
    const unused = addOriginal();
    await save(input({ sourceIds: [kept.source.id] }));
    const response = await patch({
      action: "delete-source",
      revision: company.revision,
      sourceId: unused.source.id,
    });
    expect(response.status).toBe(200);
    expect(existsSync(unused.path)).toBe(false);
    expect(existsSync(kept.path)).toBe(true);
    expect(state.store!.get(company.id).agencyRecords).toEqual(company.agencyRecords);
  });
  it("다른 기업의 sourceId를 원본 증거로 연결할 수 없다", async () => {
    const other = state.store!.create({ ...emptyProfile(), companyName: "다른 시험기업" });
    const file = addOriginal(undefined, other.id);
    const before = company;
    const response = await patch(body(input({ sourceIds: [file.source.id] })));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(state.store!.get(company.id)).toEqual(before);
    expect(state.store!.get(other.id).agencyRecords).toEqual([]);
    expect(await response.text()).not.toContain("다른 시험기업");
  });
  it("본문만 있는 자료·원본파일 누락은 원본 증거로 승격하지 않는다", async () => {
    const file = addOriginal();
    rmSync(file.path);
    const response = await patch(body(input({ sourceIds: [file.source.id] })));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(state.store!.get(company.id).agencyRecords).toEqual([]);
    company = state.store!.mutate(
      company.id,
      {
        action: "source",
        revision: company.revision,
        source: {
          ...file.source,
          id: randomUUID(),
          originalName: null,
          mimeType: null,
          extraction: "manual",
          text: "본문만 있음",
        },
      },
      () => [],
    );
    const textOnly = company.sources.at(-1)!;
    expect((await patch(body(input({ sourceIds: [textOnly.id] })))).status).toBeGreaterThanOrEqual(
      400,
    );
    expect(state.store!.get(company.id).agencyRecords).toEqual([]);
  });
  it("답변 버전과 요청 정정은 이전 원문을 덮지 않고 각각 최신 버전 뒤에 추가한다", async () => {
    const first = await save();
    const draft = await save(responseInput(first.id));
    const sent = await save(
      responseInput(first.id, draft.id, {
        body: "담당자가 발송했다고 기록한 본문",
        responseStatus: "reported-sent",
        occurredOn: "2026-09-25",
      }),
    );
    expect(sent).toMatchObject({
      version: 2,
      previousVersionId: draft.id,
      responseStatus: "reported-sent",
      origin: "manual",
    });
    const corrected = await save({
      ...input({ title: "요청사항 정정", body: "원문 오기 정정" }),
      kind: "request-correction",
      requestRecordId: first.id,
      previousVersionId: first.id,
    });
    expect(corrected).toMatchObject({
      version: 2,
      requestRecordId: first.id,
      previousVersionId: first.id,
    });
    expect(company.agencyRecords.slice(0, 3)).toEqual([first, draft, sent]);
    const answer = await save(
      responseInput(first.id, sent.id, { body: "정정된 요청에 대한 새 초안" }),
    );
    expect(answer.version).toBe(3);
    expect(answer).toMatchObject({ requestVersionId: corrected.id });
  });
  it("다른 회사 요청 ID에 답변·정정을 연결할 수 없다", async () => {
    const first = await save();
    const other = state.store!.create({ ...emptyProfile(), companyName: "다른 시험기업" });
    const before = state.store!.get(other.id);
    for (const record of [
      responseInput(first.id),
      {
        ...input(),
        kind: "request-correction",
        requestRecordId: first.id,
        previousVersionId: first.id,
      },
    ]) {
      const response = await patch(
        { action: "append-agency-record", revision: 0, clientRequestId: randomUUID(), record },
        other.id,
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "AGENCY_REQUEST_NOT_FOUND" });
      expect(state.store!.get(other.id)).toEqual(before);
    }
  });
  it("이전 버전·답변 ID를 요청의 최신 버전으로 오용하면 추가 없이 거부한다", async () => {
    const first = await save();
    const response = await save(responseInput(first.id));
    const second = await save(responseInput(first.id, response.id));
    const before = company;
    expect((await patch(body(responseInput(first.id, response.id)))).status).toBe(409);
    expect((await patch(body(responseInput(response.id, second.id)))).status).toBe(404);
    expect(
      (
        await patch(
          body({
            ...input(),
            kind: "request-correction",
            requestRecordId: first.id,
            previousVersionId: response.id,
          }),
        )
      ).status,
    ).toBe(409);
    expect(state.store!.get(company.id)).toEqual(before);
  });
  it("같은 nonce·같은 정규화 입력 재전송은 stale revision이어도 추가하지 않고 저장본을 반환한다", async () => {
    const file = addOriginal();
    const payload = body(input({ sourceIds: [file.source.id] }));
    const first = await patch(payload);
    expect(first.status).toBe(200);
    company = await first.json();
    const before = company;
    writeFileSync(file.path, Buffer.alloc(file.bytes.length, 66));
    const reader = vi.spyOn(state.store!, "originalForVentureInput");
    const again = await patch(payload);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(before);
    const trimmedReplay = await patch({
      ...payload,
      record: {
        ...payload.record,
        title: ` ${payload.record.title} `,
        body: `\n${payload.record.body}\n`,
      },
    });
    expect(trimmedReplay.status).toBe(200);
    expect(await trimmedReplay.json()).toEqual(before);
    expect(reader).not.toHaveBeenCalled();
    expect(state.store!.get(company.id)).toEqual(before);
  });
  it("같은 nonce의 다른 내용과 다른 nonce의 stale CAS는 모두409이며 원래 기록을 보존한다", async () => {
    const payload = body();
    const first = await patch(payload);
    company = await first.json();
    const before = company;
    expect(
      (await patch({ ...payload, record: { ...payload.record, body: "바뀐 본문" } })).status,
    ).toBe(409);
    expect((await patch({ ...payload, clientRequestId: randomUUID() })).status).toBe(409);
    expect(state.store!.get(company.id)).toEqual(before);
  });
  it.each([
    { id: randomUUID() },
    { origin: "agency-verified" },
    { version: 99 },
    { recordedAt: "2020-01-01T00:00:00.000Z" },
    { evidence: [] },
    { inputDigest: "a".repeat(64) },
    { sourceIds: [], sha256: "a".repeat(64) },
  ])("클라이언트 서버 메타 주입은400으로 거부한다: %j", async (forged) => {
    const before = company;
    const response = await patch({ ...body(), record: { ...input(), ...forged } });
    expect(response.status).toBe(400);
    expect(state.store!.get(company.id)).toEqual(before);
  });
  it.each([
    { body: " " },
    { body: "x".repeat(20001) },
    { occurredOn: "2026-02-30" },
    { dueOn: "2026-02-30" },
    { sourceIds: Array.from({ length: 11 }, () => randomUUID()) },
    { sourceIds: ["bad-id"] },
  ])("본문·날짜·근거한도 위반은 기록과 revision 모두 롤백한다: %j", async (invalid) => {
    const before = company;
    const response = await patch(body(input(invalid)));
    expect(response.status).toBe(400);
    expect(state.store!.get(company.id)).toEqual(before);
  });
  it("중복 sourceId와 날짜 없는 발송주장은 거부한다", async () => {
    const file = addOriginal();
    expect((await patch(body(input({ sourceIds: [file.source.id, file.source.id] })))).status).toBe(
      400,
    );
    const first = await save();
    const before = company;
    expect(
      (
        await patch(
          body(responseInput(first.id, null, { responseStatus: "reported-sent", occurredOn: "" })),
        )
      ).status,
    ).toBe(400);
    expect(state.store!.get(company.id)).toEqual(before);
  });
  it("회사 입력 잠금 중 기관 기록 추가도 차단하며 잠금 해제 뒤 정상 저장한다", async () => {
    const payload = body();
    await withVentureInputCompanyLock(company.id, async () => {
      expect((await patch(payload)).status).toBe(409);
      expect(state.store!.get(company.id)).toEqual(company);
    });
    expect((await patch(payload)).status).toBe(200);
  });
  it("외부 origin·메타 최상위 주입을 거부하고 응답을 캐시하지 않는다", async () => {
    expect(
      (await PATCH(request(body(), { origin: "https://outside.example" }), context())).status,
    ).toBe(403);
    expect((await patch({ ...body(), agencyRecords: [] })).status).toBe(400);
    const response = await patch(body());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("기관 기록이 제출·확인 단계나 기존 AI 분석·작성본을 자동 변경하지 않는다", async () => {
    const before = company;
    const first = await save(input({ body: "AGENCY_ONLY_CLAIM 기관 확인 완료·매출 999억원" }));
    await save(
      responseInput(first.id, null, {
        body: "AGENCY_ONLY_RESPONSE 발송 완료 주장",
        responseStatus: "reported-sent",
        occurredOn: "2026-09-25",
      }),
    );
    expect(company.stage).toBe(before.stage);
    expect(company.stageHistory).toEqual(before.stageHistory);
    expect(company.analysis).toEqual(before.analysis);
    expect(company.plans).toEqual(before.plans);
    expect(company.sources).toEqual(before.sources);
    expect(state.aiConstructor).not.toHaveBeenCalled();
    const analysis = await analyzeCompany(company, "assisted");
    expect(JSON.stringify(analysis)).not.toContain("AGENCY_ONLY");
    expect(analysis.facts).toEqual([]);
    expect(analysis.candidates).toEqual([]);
    expect(
      reviewPlan(company, {
        title: "검토 초안",
        summary: "검토 중",
        sections: [
          {
            key: "solution",
            title: "기술",
            content: first.body,
            needsConfirmation: false,
            evidence: [{ sourceId: first.id, quote: first.body, locator: first.title }],
          },
        ],
        actionItems: [],
        interviewQuestions: [],
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "invalid-reference", severity: "error" }),
      ]),
    );
  });
  it("명시적 AI 분석에서도 수동 기관기록 원문·증거 해시는 전달하지 않는다", async () => {
    const file = addOriginal();
    const first = await save(input({ body: "AGENCY_PRIVATE_BODY", sourceIds: [file.source.id] }));
    vi.stubEnv("OPENAI_API_KEY", "mock-only-key");
    state.aiParse.mockResolvedValue({
      status: "completed",
      output_parsed: {
        summary: "자료 부족",
        facts: [],
        candidates: [],
        questions: [],
        warnings: [],
      },
    });
    await analyzeCompany(company, "ai");
    expect(state.aiParse).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(state.aiParse.mock.calls[0][0]);
    expect(sent).not.toContain(first.body);
    expect(sent).not.toContain(first.id);
    expect(sent).not.toContain(first.evidence[0].sha256);
  });
  it("기관 기록은 기존 분석·확인된 계획서와 evidence revision을 무효화하지 않는다", async () => {
    company = state.store!.saveAnalysis(
      company.id,
      company.revision,
      {
        summary: "기존 분석",
        facts: [],
        questions: [],
        warnings: [],
        candidates: [
          {
            id: "sample",
            title: "가상 기술",
            problem: "문제",
            solution: "해결",
            targetCustomer: "대상",
            differentiation: "차별",
            stage: "개발",
            businessModel: "판매",
            recommendation: "추천",
            evidence: [],
            gaps: [],
          },
        ],
      },
      "assisted",
    );
    company = state.store!.mutate(
      company.id,
      {
        action: "select-candidate",
        revision: company.revision,
        clientRequestId: randomUUID(),
        candidateId: "sample",
        analysisGeneratedAt: company.analysis!.generatedAt,
        analysisSourceRevision: company.analysis!.sourceRevision,
        expectedSelectedCandidateId: company.selectedCandidateId,
        reason: "합성 후보 선택 근거",
      },
      () => [],
    );
    company = state.store!.saveGeneratedPlan(
      company.id,
      company.revision,
      "sample",
      {
        title: "기존 작성본",
        summary: "요약",
        sections: [
          {
            key: "solution",
            title: "기술",
            content: "기존 기술 설명",
            needsConfirmation: false,
            evidence: [],
          },
        ],
        actionItems: [],
        interviewQuestions: [],
      },
      [],
      "assisted",
    );
    company = state.store!.mutate(
      company.id,
      { action: "confirm-plan", revision: company.revision, planId: company.plans[0].id },
      () => [],
    );
    const before = company;
    expect(state.store!.isPlanCurrent(company.id, before.plans[0])).toBe(true);
    const first = await save();
    await save(responseInput(first.id));
    expect(company.analysis).toEqual(before.analysis);
    expect(company.plans).toEqual(before.plans);
    expect(company.stage).toBe(before.stage);
    expect(company.stageHistory).toEqual(before.stageHistory);
    expect(company.selectedCandidateId).toBe(before.selectedCandidateId);
    expect(state.store!.isPlanCurrent(company.id, company.plans[0])).toBe(true);
    expect(state.aiConstructor).not.toHaveBeenCalled();
  });
  it("기록 200개 한도에서는 과거 이력을 자르지 않고 요청과 revision을 롤백한다", async () => {
    const first = await save();
    const records = Array.from({ length: 200 }, (_, index) => {
      if (index === 0) return first;
      const id = randomUUID();
      return {
        ...first,
        id,
        requestRecordId: id,
        requestVersionId: id,
        clientRequestId: randomUUID(),
      };
    });
    const before = { ...company, agencyRecords: records };
    replaceBody(before);
    const result = await patch(body());
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ code: "AGENCY_RECORD_LIMIT" });
    expect(state.store!.get(company.id)).toEqual(before);
    const replay = await patch(body(input(), first.clientRequestId));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(before);
  });
  it("저널 전체 20만자 초과는 본문과 revision을 모두 롤백한다", async () => {
    const first = await save(input({ body: "x".repeat(19000) }));
    const records = Array.from({ length: 10 }, (_, index) => {
      if (index === 0) return first;
      const id = randomUUID();
      return {
        ...first,
        id,
        requestRecordId: id,
        requestVersionId: id,
        clientRequestId: randomUUID(),
      };
    });
    const before = { ...company, agencyRecords: records };
    replaceBody(before);
    const result = await patch(body(input({ body: "y".repeat(20000) })));
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ code: "AGENCY_RECORD_LIMIT" });
    expect(state.store!.get(company.id)).toEqual(before);
  });
  it("원본 개당 12MiB 초과는 파일을 손대지 않고 기록만 거부한다", async () => {
    const file = addOriginal(Buffer.alloc(12 * 1024 * 1024 + 1, 65));
    const before = company;
    const result = await patch(body(input({ sourceIds: [file.source.id] })));
    expect(result.status).toBe(413);
    expect(state.store!.get(company.id)).toEqual(before);
    expect(existsSync(file.path)).toBe(true);
  });
  it("기록당 원본 합계 24MiB 초과는 부분 증거 목록을 저장하지 않는다", async () => {
    const files = Array.from({ length: 3 }, () => addOriginal(Buffer.alloc(9 * 1024 * 1024, 65)));
    const before = company;
    const result = await patch(body(input({ sourceIds: files.map(({ source }) => source.id) })));
    expect(result.status).toBe(413);
    expect(await result.json()).toMatchObject({ code: "AGENCY_EVIDENCE_LIMIT" });
    expect(state.store!.get(company.id)).toEqual(before);
    expect(files.every(({ path }) => existsSync(path))).toBe(true);
  }, 15000);

  type NoticeInput = Extract<AgencyRecordInput, { kind: "notice" }>;
  const notices: NoticeInput["details"][] = [
    {
      category: "payment",
      amountWon: "1234500",
      dueOn: "2026-10-01",
      dueNote: "담당자 확인한 안내 원문",
      paidOn: "",
      referenceNumber: "PAY-TEST",
      statusText: "납부 요청 통보",
    },
    {
      category: "receipt",
      receiptNumber: "RECEIPT-TEST",
      receivedOn: "2026-09-25",
      statusText: "담당자 수신 내용",
    },
    {
      category: "visit",
      scheduledOn: "2026-10-07",
      timeText: "오후 2시 예정",
      location: "가상 시험장",
      preparation: "원문 기재 준비사항",
    },
    {
      category: "decision",
      decisionText: "담당자가 전사한 결과",
      notifiedOn: "2026-09-25",
      reasons: "원문 기재 사유",
    },
    {
      category: "certificate",
      certificateNumber: "CERT-TEST",
      issuedOn: "2026-09-25",
      validFrom: "2026-09-25",
      validUntil: "2027-09-24",
      statusText: "담당자 확인 예정",
    },
  ];
  const noticeInput = (
    details: NoticeInput["details"] = notices[1],
    overrides: Partial<Omit<NoticeInput, "details">> = {},
  ): NoticeInput => ({
    kind: "notice",
    institution: "가상 통보기관",
    title: "기관 통보 수동 기록",
    body: "관측하지 않은 공식 상태를 증명하지 않는 시험 전사입니다.",
    occurredOn: "2026-09-25",
    note: "직접 확인 필요",
    sourceIds: [],
    ...overrides,
    details,
  });
  const asNotice = (record: AgencyRecord) => {
    if (record.kind !== "notice" && record.kind !== "notice-correction")
      throw new Error("Notice fixture expected");
    return record;
  };
  const correction = (
    noticeRecordId: string,
    previousVersionId: string,
    details = notices[1],
  ): AgencyRecordInput => ({
    ...noticeInput(details),
    kind: "notice-correction",
    noticeRecordId,
    previousVersionId,
  });

  it.each(notices)(
    "$category 통보는 별도 최초 ID와 수동 출처로 보관하고 단계·분석을 승격하지 않는다",
    async (details) => {
      const before = company;
      const saved = asNotice(await save(noticeInput(details)));
      expect(saved).toMatchObject({
        kind: "notice",
        noticeRecordId: saved.id,
        previousVersionId: null,
        version: 1,
        origin: "manual",
        details,
      });
      for (const key of [
        "requestRecordId",
        "requestVersionId",
        "dueOn",
        "dueNote",
        "responseStatus",
      ])
        expect(saved).not.toHaveProperty(key);
      expect(saved.inputDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(company.stage).toBe(before.stage);
      expect(company.stageHistory).toEqual(before.stageHistory);
      expect(company.analysis).toEqual(before.analysis);
      expect(company.plans).toEqual(before.plans);
      expect(company.sources).toEqual(before.sources);
      expect(state.aiConstructor).not.toHaveBeenCalled();
      expect(JSON.stringify(await analyzeCompany(company, "assisted"))).not.toContain(saved.body);
    },
  );
  it("같은 분류 통보도 별도 최초 ID이며 정정은 지정한 한 이력만 추가한다", async () => {
    const first = asNotice(await save(noticeInput()));
    const other = asNotice(await save(noticeInput()));
    const second = asNotice(await save(correction(first.id, first.id)));
    const third = asNotice(await save(correction(first.id, second.id, notices[0])));
    expect(second).toMatchObject({
      noticeRecordId: first.id,
      previousVersionId: first.id,
      version: 2,
    });
    expect(third).toMatchObject({
      noticeRecordId: first.id,
      previousVersionId: second.id,
      version: 3,
      details: { category: "payment" },
    });
    expect(company.agencyRecords.slice(0, 2)).toEqual([first, other]);
    expect(other.noticeRecordId).toBe(other.id);
    expect(other.id).not.toBe(first.id);
    state.store!.close();
    state.store = new StudioStore(directory);
    expect(state.store.get(company.id)).toEqual(company);
  });
  it("통보 정정은 다른 root·낡은 버전·최초 아닌 ID를 참조할 수 없다", async () => {
    const first = asNotice(await save(noticeInput()));
    const other = asNotice(await save(noticeInput()));
    const second = asNotice(await save(correction(first.id, first.id)));
    const before = company;
    for (const record of [correction(first.id, first.id), correction(first.id, other.id)]) {
      const response = await patch(body(record));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "AGENCY_VERSION_STALE" });
    }
    const response = await patch(body(correction(second.id, second.id)));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "AGENCY_NOTICE_NOT_FOUND" });
    expect(state.store!.get(company.id)).toEqual(before);
  });
  it("통보와 기존 요청의 답변·정정 chain을 서로 혼용하지 않는다", async () => {
    const requestRoot = await save();
    const noticeRoot = asNotice(await save(noticeInput()));
    const before = company;
    const unsupported = [
      { record: responseInput(noticeRoot.id), code: "AGENCY_REQUEST_NOT_FOUND" },
      {
        record: {
          ...input(),
          kind: "request-correction" as const,
          requestRecordId: noticeRoot.id,
          previousVersionId: noticeRoot.id,
        },
        code: "AGENCY_REQUEST_NOT_FOUND",
      },
      { record: correction(requestRoot.id, requestRoot.id), code: "AGENCY_NOTICE_NOT_FOUND" },
    ];
    for (const { record, code } of unsupported) {
      const response = await patch(body(record));
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code });
      expect(state.store!.get(company.id)).toEqual(before);
    }
  });
  it("다른 기업의 최초 통보 ID·증빙 ID는 정정·원본 연결에 쓰지 못한다", async () => {
    const original = addOriginal();
    const first = asNotice(
      await save(noticeInput(notices[1], { sourceIds: [original.source.id] })),
    );
    const other = state.store!.create({ ...emptyProfile(), companyName: "분리된 통보 시험기업" });
    for (const record of [
      correction(first.id, first.id),
      noticeInput(notices[1], { sourceIds: [original.source.id] }),
    ]) {
      const response = await patch({ ...body(record), revision: other.revision }, other.id);
      expect(response.status).toBe(404);
      expect(state.store!.get(other.id)).toEqual(other);
      expect(state.store!.get(company.id)).toEqual(company);
    }
  });
  it("통보 nonce는 동일 정규화 입력만 재생하며 종류별 세부내용 변경과 stale CAS를 차단한다", async () => {
    const payload = body(noticeInput());
    const first = await patch(payload);
    expect(first.status).toBe(200);
    company = await first.json();
    const before = company;
    const replay = await patch({
      ...payload,
      record: { ...payload.record, title: ` ${payload.record.title} ` },
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(before);
    const different = await patch({ ...payload, record: noticeInput(notices[0]) });
    expect(different.status).toBe(409);
    expect(await different.json()).toMatchObject({ code: "AGENCY_REQUEST_CONFLICT" });
    const stale = await patch({ ...payload, clientRequestId: randomUUID() });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "STALE_REVISION" });
    expect(state.store!.get(company.id)).toEqual(before);
  });
  it("정정 nonce 재생은 버전을 다시 올리지 않고 이전 통보 내용을 보존한다", async () => {
    const first = asNotice(await save(noticeInput()));
    const payload = body(correction(first.id, first.id));
    const saved = await patch(payload);
    expect(saved.status).toBe(200);
    company = await saved.json();
    const before = company;
    const replay = await patch(payload);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(before);
    expect(company.agencyRecords).toHaveLength(2);
    expect(company.agencyRecords[0]).toEqual(first);
    expect(asNotice(company.agencyRecords[1]).version).toBe(2);
  });
  it("기존 요청·답변 JSON과 nonce는 신규 통보 스키마에서도 바뀌지 않는다", async () => {
    const originalInput = input();
    const payload = body(originalInput);
    const response = await patch(payload);
    expect(response.status).toBe(200);
    company = await response.json();
    const first = company.agencyRecords[0];
    await save(responseInput(first.id));
    await save({
      ...input(),
      kind: "request-correction",
      requestRecordId: first.id,
      previousVersionId: first.id,
    });
    const originalRecords = structuredClone(company.agencyRecords);
    const previous = company;
    replaceBody(JSON.parse(JSON.stringify(previous)));
    state.store!.close();
    state.store = new StudioStore(directory);
    expect(state.store.get(company.id)).toEqual(previous);
    const replay = await patch(payload);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(previous);
    await save(noticeInput());
    expect(company.agencyRecords.slice(0, 3)).toEqual(originalRecords);
    const oldCanonicalInput = {
      kind: "request",
      title: originalInput.title,
      body: originalInput.body,
      occurredOn: originalInput.occurredOn,
      note: originalInput.note,
      sourceIds: originalInput.sourceIds,
      institution: originalInput.institution,
      dueOn: originalInput.dueOn,
      dueNote: originalInput.dueNote,
    };
    expect(first.inputDigest).toBe(
      createHash("sha256").update(JSON.stringify(oldCanonicalInput)).digest("hex"),
    );
    for (const record of originalRecords) {
      expect(record).not.toHaveProperty("details");
      expect(record).not.toHaveProperty("noticeRecordId");
    }
  });
  it("통보 증빙은 실제 SHA를 보관하고 정정 뒤에도 최초 참조 원본 삭제를 차단한다", async () => {
    const file = addOriginal();
    const first = asNotice(await save(noticeInput(notices[4], { sourceIds: [file.source.id] })));
    expect(first.evidence[0].sha256).toBe(createHash("sha256").update(file.bytes).digest("hex"));
    await save(correction(first.id, first.id));
    const before = company;
    const response = await patch({
      action: "delete-source",
      revision: company.revision,
      sourceId: file.source.id,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "AGENCY_SOURCE_REFERENCED" });
    expect(state.store!.get(company.id)).toEqual(before);
    expect(existsSync(file.path)).toBe(true);
  });
  it("새 통보에 같은 크기로 바뀐 원본을 재연결하면 과거 SHA를 유지하며 거부한다", async () => {
    const file = addOriginal();
    const first = asNotice(await save(noticeInput(notices[1], { sourceIds: [file.source.id] })));
    writeFileSync(file.path, Buffer.alloc(file.bytes.length, 88));
    const before = company;
    const result = await patch(
      body({ ...correction(first.id, first.id), sourceIds: [file.source.id] }),
    );
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ code: "AGENCY_EVIDENCE_CHANGED" });
    expect(state.store!.get(company.id)).toEqual(before);
    expect(company.agencyRecords[0].evidence).toEqual(first.evidence);
  });
  it.each([
    { noticeRecordId: randomUUID() },
    { requestRecordId: randomUUID() },
    { requestVersionId: randomUUID() },
    { responseStatus: "reported-sent" },
    { version: 8 },
    {
      details: {
        category: "receipt",
        receiptNumber: "X",
        receivedOn: "",
        statusText: "",
        verified: true,
      },
    },
  ])("통보에 서버·다른 종류 메타를 주입하면 저장하지 않는다: %j", async (forged) => {
    const before = company;
    const response = await patch({ ...body(), record: { ...noticeInput(), ...forged } });
    expect(response.status).toBe(400);
    expect(state.store!.get(company.id)).toEqual(before);
  });
  it.each(["01", "1,000", "1e3", "-1", "9007199254740992"])(
    "납부 금액 %s는 모호한 변환 없이 거부한다",
    async (amountWon) => {
      const record = noticeInput({ ...notices[0], amountWon } as NoticeInput["details"]);
      const response = await patch(body(record));
      expect(response.status).toBe(400);
      expect(state.store!.get(company.id)).toEqual(company);
    },
  );
  it.each(["", "0", "9007199254740991"])(
    "납부 금액 %j는 원문 정수·미확인 값을 그대로 보존한다",
    async (amountWon) => {
      const record = asNotice(
        await save(noticeInput({ ...notices[0], amountWon } as NoticeInput["details"])),
      );
      expect(record.details).toMatchObject({ amountWon });
    },
  );
  it.each([
    { ...notices[1], receivedOn: "2026-02-30" },
    { ...notices[2], scheduledOn: "2026-13-01" },
    { ...notices[3], notifiedOn: "tomorrow" },
    { ...notices[4], validFrom: "2027-01-01", validUntil: "2026-01-01" },
    { ...notices[4], issuedOn: "2026-02-30" },
  ])("통보 종류별 날짜·유효기간이 모순되면 전체 변경을 거부한다: %j", async (details) => {
    const response = await patch(body(noticeInput(details as NoticeInput["details"])));
    expect(response.status).toBe(400);
    expect(state.store!.get(company.id)).toEqual(company);
  });
  it.each(notices)(
    "$category의 빈 선택값은 미확인으로 보존하며 값을 만들어내지 않는다",
    async (details) => {
      const blank = Object.fromEntries(
        Object.keys(details).map((key) => [key, key === "category" ? details.category : ""]),
      ) as NoticeInput["details"];
      const saved = asNotice(await save(noticeInput(blank, { occurredOn: "" })));
      expect(saved.details).toEqual(blank);
      expect(saved.occurredOn).toBe("");
      expect(company.stage).toBe("preparing");
    },
  );
  it("새 통보 세부 문자열과 발생일도 기존 20만자 보관 한도에 합산한다", async () => {
    const first = asNotice(
      await save(
        noticeInput(
          {
            category: "decision",
            decisionText: "R".repeat(1000),
            reasons: "S".repeat(2000),
            notifiedOn: "2026-09-25",
          },
          {
            institution: "I",
            title: "T",
            body: "B".repeat(15000),
            note: "",
            occurredOn: "2026-09-25",
          },
        ),
      ),
    );
    const records = Array.from({ length: 11 }, (_, index) => {
      if (index === 0) return first;
      const id = randomUUID();
      return { ...first, id, noticeRecordId: id, clientRequestId: randomUUID() };
    });
    const before = { ...company, agencyRecords: records };
    replaceBody(before);
    const payload = noticeInput(
      {
        category: "visit",
        scheduledOn: "",
        timeText: "",
        location: "",
        preparation: "A".repeat(2000),
      },
      {
        institution: "I",
        title: "T",
        body: "B",
        note: "",
        occurredOn: "",
      },
    );
    const response = await patch(body(payload));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "AGENCY_RECORD_LIMIT" });
    expect(state.store!.get(company.id)).toEqual(before);
  });
});
