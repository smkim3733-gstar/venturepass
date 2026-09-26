import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { caseSchema, emptyProfile, type StudioCase } from "@/lib/studio-schema";
import type { AgencyRequestRecord } from "@/lib/studio-agency-records";
import {
  preparedResponseBody,
  responsePreparationSchema,
  type ResponsePreparation,
  type ResponsePreparationInput,
} from "@/lib/studio-response-preparation-types";
import {
  latestAgencyResponse,
  latestResponseRequests,
  newResponseItem,
  preparedResponseAlreadyRegistered,
  responseInputFor,
  responsePreparationSaveAcknowledged,
  responseRegistrationAcknowledged,
  ResponseItemEditor,
  ResponsePreparationComparison,
  ResponsePreparationEvidence,
  ResponsePreparations,
} from "./response-preparation";

const uuid = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const now = "2026-09-25T00:00:00.000Z";
const nonce = uuid(40);
function request(overrides: Partial<AgencyRequestRecord> = {}): AgencyRequestRecord {
  return {
    id: uuid(2),
    clientRequestId: uuid(3),
    inputDigest: "b".repeat(64),
    kind: "request",
    requestRecordId: uuid(2),
    requestVersionId: uuid(2),
    previousVersionId: null,
    version: 1,
    origin: "manual",
    recordedAt: now,
    institution: "합성 기관",
    title: "합성 요청",
    body: "기술 근거를 설명해 주세요. <script>request()</script>",
    occurredOn: "",
    dueOn: "",
    dueNote: "",
    note: "",
    responseStatus: null,
    evidence: [],
    ...overrides,
  };
}
function preparation(overrides: Partial<ResponsePreparation> = {}): ResponsePreparation {
  return responsePreparationSchema.parse({
    id: uuid(4),
    preparationId: uuid(4),
    previousVersionId: null,
    version: 1,
    clientRequestId: nonce,
    inputDigest: "c".repeat(64),
    recordedAt: now,
    origin: "manual",
    mode: "assisted",
    reviewStatus: "unreviewed",
    requestRecordId: uuid(2),
    requestVersionId: uuid(2),
    title: "합성 답변 준비",
    items: [
      {
        id: uuid(5),
        requestQuote: "기술 근거를 설명해 주세요.",
        summary: "기술 근거 설명",
        planClaim: null,
        evidence: [],
        gap: "실험 결과 추가 확보 필요",
        draft: "검토할 답변 <script>answer()</script>",
      },
    ],
    sourceSnapshots: [],
    planSnapshots: [],
    ...overrides,
  });
}
function company(overrides: Partial<StudioCase> = {}): StudioCase {
  return caseSchema.parse({
    id: uuid(1),
    profile: { ...emptyProfile(), companyName: "합성 기업" },
    sources: [],
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: "preparing",
    agencyRecords: [request()],
    revision: 3,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}
function inputFor(record = preparation()): ResponsePreparationInput {
  return {
    preparationId: record.previousVersionId ? record.preparationId : null,
    previousVersionId: record.previousVersionId,
    requestRecordId: record.requestRecordId,
    requestVersionId: record.requestVersionId,
    title: record.title,
    items: structuredClone(record.items),
  };
}
function response(
  record = preparation(),
  overrides: Partial<AgencyRequestRecord> = {},
): AgencyRequestRecord {
  return request({
    id: uuid(6),
    kind: "response",
    clientRequestId: nonce,
    title: record.title,
    body: preparedResponseBody(record).trim(),
    responseStatus: "draft",
    preparedFrom: { preparationId: record.preparationId, preparationVersionId: record.id },
    ...overrides,
  });
}
function evidencePreparation(): ResponsePreparation {
  const record = preparation();
  record.items[0].planClaim = {
    planId: uuid(10),
    sectionKey: "technology",
    quote: "저장된 원고 인용",
  };
  record.items[0].evidence = [
    { sourceId: uuid(11), sourceUpdatedAt: now, quote: "", locator: "2쪽 원본" },
    {
      sourceId: uuid(12),
      sourceUpdatedAt: now,
      quote: "저장된 자료 <img onerror=x>",
      locator: "본문 1절",
    },
  ];
  record.sourceSnapshots = [
    {
      sourceId: uuid(11),
      sourceName: "스캔 합성 자료",
      sourceUpdatedAt: now,
      extraction: "pending",
      textSha256: "a".repeat(64),
      original: {
        sourceId: uuid(11),
        sourceName: "스캔 합성 자료",
        originalName: "synthetic-original.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
        sha256: "b".repeat(64),
        capturedAt: now,
        sourceUpdatedAt: now,
      },
    },
    {
      sourceId: uuid(12),
      sourceName: "수동 등록 자료",
      sourceUpdatedAt: now,
      extraction: "manual",
      textSha256: "c".repeat(64),
      original: null,
    },
  ];
  record.planSnapshots = [{ planId: uuid(10), version: 7, contentSha256: "d".repeat(64) }];
  return record;
}

describe("보완 답변 준비의 선택·응답 확인", () => {
  it("starts blank without implicitly choosing evidence, a plan, or an answer", () => {
    const a = newResponseItem();
    const b = newResponseItem();
    expect(a.id).not.toBe(b.id);
    expect(a.planClaim).toBeNull();
    expect(a.evidence).toEqual([]);
    expect(a.draft).toBe("");
    const input = responseInputFor(request());
    expect(input.preparationId).toBeNull();
    expect(input.previousVersionId).toBeNull();
    expect(input.items).toHaveLength(1);
    expect(input.requestVersionId).toBe(uuid(2));
  });
  it("copies prior text without mutating its version or rebinding stale source timestamps", () => {
    const previous = evidencePreparation();
    const correction = request({
      id: uuid(8),
      kind: "request-correction",
      version: 2,
      previousVersionId: uuid(2),
    });
    const input = responseInputFor(correction, previous);
    expect(input.preparationId).toBe(previous.preparationId);
    expect(input.previousVersionId).toBe(previous.id);
    expect(input.requestVersionId).toBe(correction.id);
    expect(input.items[0].evidence[0].sourceUpdatedAt).toBe(now);
    input.items[0].draft = "다음 버전 편집";
    expect(previous.items[0].draft).not.toBe("다음 버전 편집");
  });
  it("chooses latest request versions separately from answers and notices", () => {
    const correction = request({
      id: uuid(8),
      kind: "request-correction",
      version: 2,
      previousVersionId: uuid(2),
    });
    const secondRoot = request({
      id: uuid(9),
      requestRecordId: uuid(9),
      requestVersionId: uuid(9),
    });
    const c = company({ agencyRecords: [request(), secondRoot, correction, response()] });
    expect(latestResponseRequests(c).map((entry) => entry.id)).toEqual([uuid(8), uuid(9)]);
    expect(latestAgencyResponse(c, uuid(2))?.id).toBe(uuid(6));
    expect(latestAgencyResponse(c, uuid(9))).toBeUndefined();
  });
  it("accepts only the exact saved preparation nonce and edited content", () => {
    const record = preparation();
    const input = inputFor(record);
    expect(
      responsePreparationSaveAcknowledged(
        company({ responsePreparations: [record] }),
        uuid(1),
        nonce,
        input,
      ),
    ).toBe(true);
    expect(responsePreparationSaveAcknowledged(null, uuid(1), nonce, input)).toBe(false);
    expect(
      responsePreparationSaveAcknowledged(
        company({ responsePreparations: [record] }),
        uuid(99),
        nonce,
        input,
      ),
    ).toBe(false);
    expect(
      responsePreparationSaveAcknowledged(
        company({ responsePreparations: [record] }),
        uuid(1),
        uuid(99),
        input,
      ),
    ).toBe(false);
    expect(
      responsePreparationSaveAcknowledged(
        company({ responsePreparations: [record, record] }),
        uuid(1),
        nonce,
        input,
      ),
    ).toBe(false);
  });
  it.each(["requestRecordId", "requestVersionId", "previousVersionId", "title", "body"] as const)(
    "rejects saved preparation with changed %s",
    (field) => {
      const record = preparation();
      const input = inputFor(record);
      if (field === "body") record.items[0].draft += " 변경";
      else if (field === "title") record.title += " 변경";
      else record[field] = uuid(99);
      expect(
        responsePreparationSaveAcknowledged(
          company({ responsePreparations: [record] }),
          uuid(1),
          nonce,
          input,
        ),
      ).toBe(false);
    },
  );
  it("checks the root when acknowledging an appended preparation version", () => {
    const record = preparation({ id: uuid(7), previousVersionId: uuid(4), version: 2 });
    const input = inputFor(record);
    expect(
      responsePreparationSaveAcknowledged(
        company({ responsePreparations: [record] }),
        uuid(1),
        nonce,
        input,
      ),
    ).toBe(true);
    record.preparationId = uuid(99);
    expect(
      responsePreparationSaveAcknowledged(
        company({ responsePreparations: [record] }),
        uuid(1),
        nonce,
        input,
      ),
    ).toBe(false);
  });
  it("acknowledges only one draft response from the exact preparation and parent", () => {
    const record = preparation();
    const saved = response(record);
    expect(
      responseRegistrationAcknowledged(
        company({ agencyRecords: [request(), saved] }),
        uuid(1),
        nonce,
        record,
        null,
      ),
    ).toBe(true);
    expect(responseRegistrationAcknowledged(null, uuid(1), nonce, record, null)).toBe(false);
    expect(
      responseRegistrationAcknowledged(
        company({ agencyRecords: [saved] }),
        uuid(99),
        nonce,
        record,
        null,
      ),
    ).toBe(false);
    expect(
      responseRegistrationAcknowledged(
        company({ agencyRecords: [saved, saved] }),
        uuid(1),
        nonce,
        record,
        null,
      ),
    ).toBe(false);
    expect(
      responseRegistrationAcknowledged(
        company({ agencyRecords: [saved] }),
        uuid(1),
        uuid(99),
        record,
        null,
      ),
    ).toBe(false);
  });
  it.each([
    "status",
    "body",
    "request",
    "version",
    "parent",
    "preparationRoot",
    "preparationVersion",
    "kind",
  ] as const)("rejects registration acknowledgment with wrong %s", (field) => {
    const record = preparation();
    const saved = response(record);
    if (field === "status") saved.responseStatus = "reported-sent";
    if (field === "body") saved.body += " 다른 본문";
    if (field === "request") saved.requestRecordId = uuid(99);
    if (field === "version") saved.requestVersionId = uuid(99);
    if (field === "parent") saved.previousVersionId = uuid(99);
    if (field === "preparationRoot") saved.preparedFrom!.preparationId = uuid(99);
    if (field === "preparationVersion") saved.preparedFrom!.preparationVersionId = uuid(99);
    if (field === "kind") saved.kind = "request";
    expect(
      responseRegistrationAcknowledged(
        company({ agencyRecords: [saved] }),
        uuid(1),
        nonce,
        record,
        null,
      ),
    ).toBe(false);
  });
  it("does not mark a new preparation version as already registered from an earlier version", () => {
    const first = preparation();
    const next = preparation({ id: uuid(7), previousVersionId: first.id, version: 2 });
    const c = company({ agencyRecords: [request(), response(first)] });
    expect(preparedResponseAlreadyRegistered(c, first)).toBe(true);
    expect(preparedResponseAlreadyRegistered(c, next)).toBe(false);
  });
});

describe("보완 답변 준비 화면", () => {
  it("shows earlier evidence snapshots even when the latest version no longer uses them", () => {
    const previous = evidencePreparation();
    const latest = preparation({ id: uuid(7), previousVersionId: previous.id, version: 2 });
    const mutate = vi.fn();
    const html = renderToStaticMarkup(
      createElement(ResponsePreparations, {
        company: company({ responsePreparations: [previous, latest] }),
        mutate,
        blockedReason: "",
        onDirtyChange: vi.fn(),
      }),
    );
    expect(html).toContain("이전 답변 준비 1개");
    expect(html).toContain("synthetic-original.pdf");
    expect(html).toContain("저장된 원고 인용");
    expect(html).toContain("저장된 자료 &lt;img onerror=x&gt;");
    expect(html).toContain("b".repeat(64));
    expect(latest.sourceSnapshots).toEqual([]);
    expect(mutate).not.toHaveBeenCalled();
  });
  it("requires a manually recorded request and does not imply AI or agency completion", () => {
    const mutate = vi.fn();
    const html = renderToStaticMarkup(
      createElement(ResponsePreparations, {
        company: company({ agencyRecords: [] }),
        mutate,
        blockedReason: "",
        onDirtyChange: vi.fn(),
      }),
    );
    expect(html).toContain("기관 요청 원문을 먼저 기록");
    expect(html).toContain("준비안은 항상 미검토 초안");
    expect(html).toContain("전송 본문 확인·별도 동의 후 실행");
    expect(html).toContain("기관으로 발송하지 않습니다");
    expect(mutate).not.toHaveBeenCalled();
  });
  it("blocks entry while another local editor is dirty", () => {
    const html = renderToStaticMarkup(
      createElement(ResponsePreparations, {
        company: company(),
        mutate: vi.fn(),
        blockedReason: "업무 편집을 먼저 저장해 주세요.",
        onDirtyChange: vi.fn(),
      }),
    );
    expect(html).toContain("업무 편집을 먼저 저장");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>이 요청의 답변 준비/);
  });
  it("shows frozen original metadata, pending limits, exact saved quotes and gaps", () => {
    const html = renderToStaticMarkup(
      createElement(ResponsePreparationEvidence, { record: evidencePreparation() }),
    );
    for (const text of [
      "synthetic-original.pdf",
      "1,024",
      "application/pdf",
      "b".repeat(64),
      "d".repeat(64),
      "본문 미추출",
      "원본만 연결",
      "첨부할 원본 파일 없음",
      "연결 원고 v7",
      "실험 결과 추가 확보 필요",
      now,
      "기술 근거를 설명해 주세요.",
    ])
      expect(html).toContain(text);
    expect(html).toContain("원본 파일 전송은 실행하지 않습니다");
    expect(html).toContain("&lt;img onerror=x&gt;");
    expect(html).not.toContain("<img ");
    expect(html).toContain("저장된 원고 인용");
  });
  it("preserves the previously registered draft and shows a disabled repeat action", () => {
    const record = preparation();
    const html = renderToStaticMarkup(
      createElement(ResponsePreparations, {
        company: company({
          responsePreparations: [record],
          agencyRecords: [request(), response(record)],
        }),
        mutate: vi.fn(),
        blockedReason: "",
        onDirtyChange: vi.fn(),
      }),
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>이 준비 버전은 답변 초안으로 등록됨/);
    expect(html).toContain("기관 발송 기록으로 변경하지");
    expect(html).toContain("&lt;script&gt;answer()&lt;/script&gt;");
  });
  it("blocks registration after the request has been corrected", () => {
    const record = preparation();
    const correction = request({
      id: uuid(8),
      kind: "request-correction",
      previousVersionId: uuid(2),
      version: 2,
    });
    const html = renderToStaticMarkup(
      createElement(ResponsePreparations, {
        company: company({
          responsePreparations: [record],
          agencyRecords: [request(), correction],
        }),
        mutate: vi.fn(),
        blockedReason: "",
        onDirtyChange: vi.fn(),
      }),
    );
    expect(html).toContain("요청 버전이 변경되었거나 없습니다");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>기관 기록에 답변 초안 등록/);
    expect(html).toContain("합성 요청 · 요청 v2");
  });
  it("compares selected historical text safely and labels reported sending as a manual record", () => {
    const record = preparation({ id: uuid(7), version: 2, previousVersionId: uuid(4) });
    const previous = preparation();
    previous.items[0].draft = "이전 답변";
    const html = renderToStaticMarkup(
      createElement(ResponsePreparationComparison, {
        record,
        previous,
        response: response(previous, { version: 3, responseStatus: "reported-sent" }),
      }),
    );
    expect(html).toContain("이전 준비 v1");
    expect(html).toContain("현재 준비 v2");
    expect(html).toContain("기존 기관 답변 v3 · 담당자 발송 기록");
    expect(html).toContain("변경 부분 · [−] 삭제 / [+] 추가");
    expect(html).toContain("사실 확인·기관 수용 판정");
    expect(html).not.toContain("<script>");
  });
  it("does not invent a previous answer when there is nothing to compare", () => {
    const html = renderToStaticMarkup(
      createElement(ResponsePreparationComparison, { record: preparation() }),
    );
    expect(html).toContain("비교할 이전 답변이나 준비 버전이 없습니다");
    expect(html).not.toContain("본문 동일");
  });
  it("states when changed-part highlighting was skipped for long text", () => {
    const record = preparation();
    const previous = preparation();
    record.items[0].draft = "가".repeat(20000);
    previous.items[0].draft = "나".repeat(20000);
    const html = renderToStaticMarkup(
      createElement(ResponsePreparationComparison, { record, previous }),
    );
    expect(html).toContain("변경 부분 강조는 생략했습니다");
    expect(html).not.toContain("변경 부분 · [−]");
  });
  it("limits an item's source selection to six and preserves stale reference warnings", () => {
    const c = company();
    c.sources = Array.from({ length: 6 }, (_, i) => ({
      id: uuid(20 + i),
      name: `합성 근거 ${i}`,
      kind: "other" as const,
      text: "정확한 문장",
      originalName: null,
      mimeType: null,
      extraction: "manual" as const,
      warnings: [],
      createdAt: now,
      updatedAt: "2026-09-26T00:00:00.000Z",
    }));
    const item = preparation().items[0];
    item.evidence = c.sources.map((source) => ({
      sourceId: source.id,
      sourceUpdatedAt: now,
      quote: source.text,
      locator: "본문",
    }));
    const html = renderToStaticMarkup(
      createElement(ResponseItemEditor, {
        company: c,
        request: request(),
        item,
        index: 0,
        onChange: vi.fn(),
        onRemove: vi.fn(),
      }),
    );
    expect(html).toMatch(/<select[^>]*id="response-item-[^"]+-evidence-add"[^>]*disabled=""/);
    expect(html).toContain("연결 뒤 자료가 변경되었습니다");
    expect(html).toContain("자료 최대 6개");
    expect(html).toContain('maxLength="1500"');
    expect(html).toContain('maxLength="20000"');
    expect(html).toContain("원고 연결 없음");
  });
});
