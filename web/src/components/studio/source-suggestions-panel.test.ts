import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  caseSchema,
  emptyProfile,
  type StudioCase,
  type SourceDocument,
} from "@/lib/studio-schema";
import { sourceIntakeItemSchema, type SourceIntakeItem } from "@/lib/studio-source-intake-types";
import {
  sourceLocationMetadataSchema,
  type SourceCoordinate,
} from "@/lib/studio-source-location-types";
import {
  sourceSuggestionRuleVersion,
  sourceSuggestionReceiptSchema,
  type SourceSuggestionCandidate,
  type SourceSuggestionsPreview,
  type SourceSuggestionPreviewInput,
} from "@/lib/studio-source-suggestion-types";
import {
  SourceSuggestionChoices,
  SourceSuggestionPosition,
  SourceSuggestionReceiptView,
  SourceSuggestionsPanel,
  suggestionDisplayValue,
} from "./source-suggestions-panel";
import {
  selectedSuggestionInput,
  suggestionAdoptionAcknowledged,
  suggestionBasisOptions,
  suggestionBasisText,
  suggestionRequestCanClose,
  sendSourceSuggestionAdoption,
  SourceSuggestionHttpError,
  validateSourceSuggestions,
  type SuggestionPending,
} from "./source-suggestions-ui";

const id = (value: number) => `${String(value).padStart(8, "0")}-1111-4111-8111-111111111111`;
const now = "2026-09-25T00:00:00.000Z",
  sha = (text: string) => createHash("sha256").update(text).digest("hex");
const text = "재무제표\n회사명: 가상 새 기업\n납입자본금: 0원\n결산월: 12월";
function source(change: Partial<SourceDocument> = {}): SourceDocument {
  return {
    id: id(2),
    name: "가상 시험 자료",
    kind: "technology",
    text,
    originalName: null,
    mimeType: null,
    extraction: "manual",
    warnings: [],
    createdAt: now,
    updatedAt: now,
    ...change,
  };
}
function company(change: Partial<StudioCase> = {}): StudioCase {
  return caseSchema.parse({
    id: id(1),
    profile: { ...emptyProfile(), companyName: "가상 기존 기업" },
    sources: [source()],
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: "preparing",
    revision: 3,
    createdAt: now,
    updatedAt: now,
    ...change,
  });
}
function request(): SourceSuggestionPreviewInput {
  return { revision: 3, sourceId: id(2), basis: { kind: "source-text", sourceUpdatedAt: now } };
}
function candidate(
  target: SourceSuggestionCandidate["target"],
  value: string,
  quote: string,
  currentValue: string,
): SourceSuggestionCandidate {
  const start = text.indexOf(quote);
  return {
    id: sha(target + quote),
    target,
    value,
    currentValue,
    quote,
    start,
    end: start + quote.length,
    lineStart: text.slice(0, start).split("\n").length,
    lineEnd: text.slice(0, start + quote.length).split("\n").length,
    coordinate: null,
  };
}
function preview(): SourceSuggestionsPreview {
  return {
    companyRevision: 3,
    ruleVersion: sourceSuggestionRuleVersion,
    binding: {
      ruleVersion: sourceSuggestionRuleVersion,
      sourceId: id(2),
      sourceUpdatedAt: now,
      basis: request().basis,
      textSha256: sha(text),
      locationsSha256: null,
      original: null,
    },
    identity: { status: "unverified", reason: "원본과 기업을 직접 대조해 주세요." },
    profileAllowed: true,
    blockedTargets: [],
    candidates: [
      candidate("sourceKind", "finance", "재무제표", "technology"),
      candidate("companyName", "가상 새 기업", "회사명: 가상 새 기업", "가상 기존 기업"),
      candidate("paidInCapital", "0", "납입자본금: 0원", ""),
      candidate("closingMonth", "12", "결산월: 12월", ""),
    ],
    unresolved: [],
  };
}
function intake(): SourceIntakeItem {
  return sourceIntakeItemSchema.parse({
    id: id(3),
    batchId: id(4),
    clientFileId: id(5),
    sourceId: id(2),
    version: 4,
    declared: { originalName: "sample.txt", sizeBytes: 3, kind: "technology" },
    original: {
      originalName: "sample.txt",
      sizeBytes: 3,
      mimeType: "text/plain",
      sha256: sha("abc"),
      sourceUpdatedAt: now,
    },
    phase: "awaiting_review",
    attempts: [],
    result: {
      id: id(6),
      attemptId: id(7),
      engine: "local-document",
      generatedAt: now,
      originalSha256: sha("abc"),
      sourceUpdatedAt: now,
      textSha256: sha(text),
      content: { kind: "plain", text },
      warnings: [],
      reviewStatus: "unreviewed",
      discardedAt: null,
    },
    previousResults: [],
    adoption: null,
    requests: [],
    createdAt: now,
    updatedAt: now,
    code: null,
  });
}
function pending(): SuggestionPending {
  const view = preview();
  return {
    companyId: id(1),
    revision: 3,
    clientRequestId: id(8),
    preview: view,
    input: selectedSuggestionInput(company(), view, { companyName: view.candidates[1].id }, true)!,
  };
}
function saved() {
  const value = pending(),
    selected = value.preview.candidates[1];
  const receipt = sourceSuggestionReceiptSchema.parse({
    id: id(9),
    version: 1,
    clientRequestId: value.clientRequestId,
    inputDigest: sha("input"),
    recordedAt: now,
    origin: "manual-local-suggestion",
    binding: value.input.binding,
    identity: value.preview.identity,
    selections: [
      {
        candidateId: selected.id,
        target: selected.target,
        previousValue: selected.currentValue,
        value: selected.value,
        quote: selected.quote,
        start: selected.start,
        end: selected.end,
        lineStart: selected.lineStart,
        lineEnd: selected.lineEnd,
        coordinate: selected.coordinate,
      },
    ],
    reviewed: true,
    profileChanged: true,
    sourceKindChanged: false,
    sourceUpdatedAtAfter: now,
  });
  return company({ revision: 4, sourceSuggestionAdoptions: [receipt] });
}
afterEach(() => vi.unstubAllGlobals());

describe("제안에 사용할 정확한 자료 버전", () => {
  it("source-text를 명시 선택하며 미추출 원본에 본문을 만들어내지 않는다", () => {
    expect(suggestionBasisOptions(company(), id(2))).toHaveLength(1);
    expect(suggestionBasisText(company(), request())).toBe(text);
    const waiting = company({ sources: [source({ text: "", extraction: "pending" })] });
    expect(suggestionBasisOptions(waiting, id(2))).toEqual([]);
    expect(suggestionBasisText(waiting, request())).toBeNull();
  });
  it("보관 미검토 결과는 정확 item/result를 고르며 폐기·이미 채택·오래된 결과는 제외한다", () => {
    const entry = intake(),
      state = company({
        sources: [
          source({
            text: "",
            extraction: "pending",
            originalName: "sample.txt",
            mimeType: "text/plain",
          }),
        ],
        sourceIntakes: [entry],
      });
    const choices = suggestionBasisOptions(state, id(2));
    expect(choices).toHaveLength(1);
    expect(choices[0].basis).toEqual({ kind: "intake-result", itemId: id(3), resultId: id(6) });
    expect(suggestionBasisText(state, { ...request(), basis: choices[0].basis })).toBe(text);
    entry.phase = "adopted";
    expect(suggestionBasisOptions({ ...state, sourceIntakes: [entry] }, id(2))).toEqual([]);
    entry.phase = "awaiting_review";
    entry.result!.sourceUpdatedAt = "2026-09-26T00:00:00.000Z";
    expect(suggestionBasisOptions({ ...state, sourceIntakes: [entry] }, id(2))).toEqual([]);
    entry.result!.sourceUpdatedAt = now;
    entry.result!.content = null;
    entry.result!.discardedAt = now;
    expect(suggestionBasisOptions({ ...state, sourceIntakes: [entry] }, id(2))).toEqual([]);
  });
  it("같은 자료 ID 중복·다른 기업 자료·오래된 revision은 판독하지 않는다", () => {
    expect(suggestionBasisOptions(company(), id(90))).toEqual([]);
    expect(suggestionBasisOptions(company({ sources: [source(), source()] }), id(2))).toEqual([]);
    expect(suggestionBasisText(company(), { ...request(), revision: 2 })).toBeNull();
    expect(
      suggestionBasisText(company(), {
        ...request(),
        basis: { kind: "source-text", sourceUpdatedAt: "old" },
      }),
    ).toBeNull();
  });
});
describe("제안 응답과 원문 위치 검증", () => {
  it("정확 본문 SHA·원문 구간·줄·현재값이 모두 일치한 제안만 표시한다", async () => {
    expect(await validateSourceSuggestions(preview(), company(), request())).toEqual(preview());
  });
  it.each([
    "revision",
    "source",
    "updatedAt",
    "basis",
    "textSha",
    "quote",
    "offset",
    "line",
    "current",
    "duplicate",
    "profileMismatch",
  ])("변조된 %s 제안은 폐기한다", async (change) => {
    const view = preview();
    if (change === "revision") view.companyRevision++;
    if (change === "source") view.binding.sourceId = id(90);
    if (change === "updatedAt") view.binding.sourceUpdatedAt = "old";
    if (change === "basis") view.binding.basis = { kind: "source-text", sourceUpdatedAt: "old" };
    if (change === "textSha") view.binding.textSha256 = sha("other");
    if (change === "quote") view.candidates[1].quote = "회사의: 가상 새 기업";
    if (change === "offset") {
      view.candidates[1].start++;
      view.candidates[1].end++;
    }
    if (change === "line") {
      view.candidates[1].lineStart++;
      view.candidates[1].lineEnd++;
    }
    if (change === "current") view.candidates[1].currentValue = "다른 현재값";
    if (change === "duplicate") view.candidates.push({ ...view.candidates[1] });
    if (change === "profileMismatch") view.identity.status = "mismatch";
    expect(await validateSourceSuggestions(view, company(), request())).toBeNull();
  });
  it("수기 본문의 페이지 표시는 구조좌표로 취급하지 않는다", async () => {
    const view = preview();
    view.candidates[0].coordinate = { kind: "pdf-page", pageNumber: 12 };
    expect(await validateSourceSuggestions(view, company(), request())).toBeNull();
    view.candidates[0].coordinate = null;
    view.binding.locationsSha256 = sha("fake");
    expect(await validateSourceSuggestions(view, company(), request())).toBeNull();
  });
  it("미검토 결과의 실제 좌표는 metadata SHA와 포함 구간이 일치해야 한다", async () => {
    const entry = intake(),
      state = company({
        sources: [
          source({
            text: "",
            extraction: "pending",
            originalName: "sample.txt",
            mimeType: "text/plain",
          }),
        ],
        sourceIntakes: [entry],
      });
    const view = preview(),
      metadata = sourceLocationMetadataSchema.parse({
        version: 1,
        textSha256: sha(text),
        coverage: "complete",
        segments: [{ start: 0, end: text.length, coordinate: { kind: "ocr-page", pageNumber: 1 } }],
      });
    entry.result!.locations = metadata;
    view.binding.basis = { kind: "intake-result", itemId: id(3), resultId: id(6) };
    view.binding.locationsSha256 = sha(JSON.stringify(metadata));
    view.binding.original = { sourceId: id(2), ...entry.original! };
    delete (view.binding.original as unknown as Record<string, unknown>).sourceUpdatedAt;
    view.candidates.forEach((value) => {
      value.coordinate = { kind: "ocr-page", pageNumber: 1 };
    });
    const bound = { ...request(), basis: view.binding.basis };
    expect(
      await validateSourceSuggestions(view, { ...state, sourceIntakes: [entry] }, bound),
    ).not.toBeNull();
    view.candidates[0].coordinate = { kind: "ocr-page", pageNumber: 2 };
    expect(
      await validateSourceSuggestions(view, { ...state, sourceIntakes: [entry] }, bound),
    ).toBeNull();
    view.candidates[0].coordinate = { kind: "ocr-page", pageNumber: 1 };
    view.binding.locationsSha256 = sha("changed");
    expect(
      await validateSourceSuggestions(view, { ...state, sourceIntakes: [entry] }, bound),
    ).toBeNull();
  });
  it("위치 정보를 주지 않은 legacy 판독 결과에는 실제 페이지를 덧붙이지 않는다", async () => {
    const entry = intake(),
      state = company({
        sources: [source({ text: "", extraction: "pending" })],
        sourceIntakes: [entry],
      });
    const view = preview();
    view.binding.basis = { kind: "intake-result", itemId: id(3), resultId: id(6) };
    expect(
      await validateSourceSuggestions(view, state, { ...request(), basis: view.binding.basis }),
    ).not.toBeNull();
    view.candidates[0].coordinate = { kind: "ocr-page", pageNumber: 1 };
    expect(
      await validateSourceSuggestions(view, state, { ...request(), basis: view.binding.basis }),
    ).toBeNull();
  });
});
describe("선택·채택 확인 경계", () => {
  it("4xx 확정 거절도 GET 없이 닫지 않으며 동일 nonce 기록이 있으면 결과 대조를 유지한다", () => {
    expect(suggestionRequestCanClose(company(), pending(), false, true)).toBe(false);
    expect(suggestionRequestCanClose(company(), pending(), true, true)).toBe(true);
    expect(suggestionRequestCanClose(saved(), pending(), true, true)).toBe(false);
  });
  it("선택한 설립일이 기존 신청예정일을 넘는 등 프로필 검증을 어기면 채택하지 않는다", () => {
    const state = company();
    state.profile.applicationDate = "2026-01-01";
    const view = preview();
    const base = view.candidates[1];
    view.candidates.push({
      ...base,
      id: sha("date"),
      target: "foundedOn",
      value: "2026-02-01",
      currentValue: "",
    });
    expect(selectedSuggestionInput(state, view, { foundedOn: sha("date") }, true)).toBeNull();
  });
  it("불확실 채택은 GET 전 또는 같은 revision에서 폐기하지 않으며, 새 revision의 정확한 미기록 상태만 닫을 수 있다", () => {
    expect(suggestionRequestCanClose(company({ revision: 4 }), pending(), false)).toBe(false);
    expect(suggestionRequestCanClose(company(), pending(), true)).toBe(false);
    expect(suggestionRequestCanClose(company({ revision: 4 }), pending(), true)).toBe(true);
    expect(suggestionRequestCanClose(saved(), pending(), true)).toBe(false);
    expect(suggestionRequestCanClose(company({ id: id(90), revision: 4 }), pending(), true)).toBe(
      false,
    );
  });
  it("미검토 판독문 종류 변경은 차단하되 기업정보 선택은 별도 검증한다", () => {
    const view = preview();
    view.blockedTargets = [
      {
        target: "sourceKind",
        code: "SUGGESTION_KIND_REQUIRES_BODY",
        reason: "먼저 판독문을 검토하여 본문으로 채택해 주세요.",
      },
    ];
    expect(
      selectedSuggestionInput(company(), view, { sourceKind: view.candidates[0].id }, true),
    ).toBeNull();
    expect(
      selectedSuggestionInput(company(), view, { companyName: view.candidates[1].id }, true),
    ).not.toBeNull();
    const html = renderToStaticMarkup(
      createElement(SourceSuggestionChoices, {
        company: company(),
        preview: view,
        choices: {},
        reviewed: false,
        disabled: false,
        onSelect: vi.fn(),
        onReviewed: vi.fn(),
      }),
    );
    expect(html).toContain("먼저 판독문을 검토하여 본문으로 채택해 주세요");
    expect(html).toMatch(/<fieldset disabled=""[^>]*><legend[^>]*>자료 종류/);
  });
  it("기본 선택 없음·확인 없음은 채택 요청을 만들지 않는다", () => {
    const view = preview();
    expect(selectedSuggestionInput(company(), view, {}, true)).toBeNull();
    expect(
      selectedSuggestionInput(company(), view, { companyName: view.candidates[1].id }, false),
    ).toBeNull();
    expect(
      selectedSuggestionInput(company(), view, { companyName: view.candidates[1].id }, true)
        ?.selections,
    ).toEqual([
      {
        candidateId: view.candidates[1].id,
        target: "companyName",
        expectedCurrentValue: "가상 기존 기업",
      },
    ]);
  });
  it("회사번호 불일치가 있으면 자료 종류만 선택할 수 있다", () => {
    const view = preview();
    view.identity.status = "mismatch";
    view.profileAllowed = false;
    expect(
      selectedSuggestionInput(company(), view, { companyName: view.candidates[1].id }, true),
    ).toBeNull();
    expect(
      selectedSuggestionInput(company(), view, { sourceKind: view.candidates[0].id }, true),
    ).not.toBeNull();
  });
  it("다른 target의 후보·변경된 현재값·stale revision은 저장하지 않는다", () => {
    const view = preview();
    expect(
      selectedSuggestionInput(company(), view, { industry: view.candidates[1].id }, true),
    ).toBeNull();
    const changed = company();
    changed.profile.companyName = "이미 바뀜";
    expect(
      selectedSuggestionInput(changed, view, { companyName: view.candidates[1].id }, true),
    ).toBeNull();
    expect(
      selectedSuggestionInput(
        company({ revision: 4 }),
        view,
        { companyName: view.candidates[1].id },
        true,
      ),
    ).toBeNull();
  });
  it("일치하는 nonce·당시 이전값·선택값·인용이 있어야 저장을 확인한다", () => {
    expect(suggestionAdoptionAcknowledged(saved(), pending())).not.toBeNull();
  });
  it.each([
    "company",
    "revision",
    "nonce",
    "binding",
    "old",
    "value",
    "quote",
    "position",
    "count",
    "duplicate",
  ])("채택 기록의 %s 불일치는 성공으로 표시하지 않는다", (change) => {
    const state = saved(),
      record = state.sourceSuggestionAdoptions[0];
    if (change === "company") state.id = id(99);
    if (change === "revision") state.revision = 2;
    if (change === "nonce") record.clientRequestId = id(90);
    if (change === "binding") record.binding.textSha256 = sha("other");
    if (change === "old") record.selections[0].previousValue = "다른 이전값";
    if (change === "value") record.selections[0].value = "다른 채택값";
    if (change === "quote") record.selections[0].quote = "가짜 원문";
    if (change === "position") {
      record.selections[0].start++;
      record.selections[0].end++;
    }
    if (change === "count")
      record.selections.push({ ...record.selections[0], candidateId: sha("extra") });
    if (change === "duplicate") state.sourceSuggestionAdoptions.push({ ...record, id: id(10) });
    expect(suggestionAdoptionAcknowledged(state, pending())).toBeNull();
  });
  it("후속 수동 정정이 있어도 정확 nonce의 과거 채택 기록은 확인할 수 있다", () => {
    const state = saved();
    state.profile.companyName = "후속 수동 정정";
    state.revision = 6;
    expect(suggestionAdoptionAcknowledged(state, pending(), 6)).not.toBeNull();
    expect(suggestionAdoptionAcknowledged(state, pending(), 7)).toBeNull();
  });
});
describe("제안 채택 전송과 불확실성", () => {
  it("정확히 선택한 값과 원래 revision·nonce만 PATCH하며 같은 요청 재확인에도 유지한다", async () => {
    const fetcher = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify(saved()), { status: 200 })),
      );
    vi.stubGlobal("fetch", fetcher);
    const value = pending();
    await sendSourceSuggestionAdoption(value);
    await sendSourceSuggestionAdoption(value);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const options = fetcher.mock.calls[0][1] as RequestInit,
      body = JSON.parse(options.body as string);
    expect(fetcher.mock.calls[0][0]).toBe(`/api/studio/cases/${id(1)}`);
    expect(options.method).toBe("PATCH");
    expect(body).toEqual({
      action: "adopt-source-suggestions",
      revision: 3,
      clientRequestId: id(8),
      ...value.input,
    });
    expect(fetcher.mock.calls[1][1].body).toBe(options.body);
    expect(body).not.toHaveProperty("allowAi");
    expect(body).not.toHaveProperty("profile");
  });
  it.each([400, 403, 404, 409, 413, 415, 422])(
    "확정 거절 HTTP %s는 내용 노출 없이 분류하되 자동 재전송하지 않는다",
    async (status) => {
      const fetcher = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "PRIVATE-DOCUMENT", code: "SUGGESTION_STALE" }), {
          status,
        }),
      );
      vi.stubGlobal("fetch", fetcher);
      const caught = await sendSourceSuggestionAdoption(pending()).catch((value) => value);
      expect(caught).toBeInstanceOf(SourceSuggestionHttpError);
      if (!(caught instanceof SourceSuggestionHttpError)) throw new Error("error type");
      expect(caught.rejected).toBe(true);
      expect(caught.message).not.toContain("PRIVATE");
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it.each([500, 502, 503])("HTTP %s는 저장되지 않았다고 추정하지 않는다", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status })));
    const caught = await sendSourceSuggestionAdoption(pending()).catch((value) => value);
    if (!(caught instanceof SourceSuggestionHttpError)) throw new Error("error type");
    expect(caught.rejected).toBe(false);
    expect(suggestionRequestCanClose(company(), pending(), true, caught.rejected)).toBe(false);
  });
  it("네트워크 실패 뒤 자동 재시도하거나 새 nonce를 만들지 않는다", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("network"));
    vi.stubGlobal("fetch", fetcher);
    const value = pending(),
      before = JSON.stringify(value);
    await expect(sendSourceSuggestionAdoption(value)).rejects.toThrow("network");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(value)).toBe(before);
  });
});
describe("자료 제안 화면", () => {
  it("최초 렌더는 자료·버전을 자동 선택하거나 preview·채택을 실행하지 않는다", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const html = renderToStaticMarkup(
      createElement(SourceSuggestionsPanel, {
        company: company(),

        busy: false,
        onDirtyChange: vi.fn(),
        onBusyChange: vi.fn(),
        onCompany: vi.fn(),
      }),
    );
    expect(html).toContain("자료 직접 선택");
    expect(html).toContain("사용할 버전 직접 선택");
    expect(html).toContain("아직 적용하지 않음");
    expect(html).toContain("외부 AI 전송·자동 적용·사실 확정을 하지 않습니다");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("후보는 기본 선택 안함이고 현재값·제안값·원문·미확인 위치를 함께 표시한다", () => {
    const html = renderToStaticMarkup(
      createElement(SourceSuggestionChoices, {
        company: company(),
        preview: preview(),
        choices: {},
        reviewed: false,
        disabled: false,
        onSelect: vi.fn(),
        onReviewed: vi.fn(),
      }),
    );
    expect(html).toContain("가상 기존 기업");
    expect(html).toContain("가상 새 기업");
    expect(html).toContain("회사명: 가상 새 기업");
    expect(html).toContain("페이지·시트·시간 좌표 미확인");
    expect(html).toContain("0원");
    expect(html).toContain("12월");
    const radios = html.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
    expect(radios.filter((value) => value.includes('checked=""'))).toHaveLength(4);
    expect(html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0]).not.toContain('checked=""');
  });
  it("번호 불일치와 stale 제안은 별도 사유로 표시하고 확인을 승계하지 않는다", () => {
    const view = preview();
    view.identity.status = "mismatch";
    view.profileAllowed = false;
    const html = renderToStaticMarkup(
      createElement(SourceSuggestionChoices, {
        company: company({ revision: 4 }),
        preview: view,
        choices: { companyName: view.candidates[1].id },
        reviewed: true,
        disabled: false,
        onSelect: vi.fn(),
        onReviewed: vi.fn(),
      }),
    );
    expect(html).toMatch(/^<fieldset[^>]*disabled=""/);
    expect(html).toContain("기업정보 후보는 채택할 수 없습니다");
    expect(html).toContain("기업 자료가 바뀌어");
    expect(html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0]).not.toContain('checked=""');
  });
  it.each<SourceCoordinate>([
    { kind: "pdf-page", pageNumber: 2 },
    { kind: "ocr-page", pageNumber: 3 },
    {
      kind: "spreadsheet-cell",
      sheetIndex: 1,
      sheetName: "가상 시트",
      row: 5,
      column: 2,
      address: "B5",
    },
    {
      kind: "subtitle-cue",
      format: "srt",
      startMs: 1000,
      endMs: 2000,
      startLabel: "00:00:01,000",
      endLabel: "00:00:02,000",
      cueId: "7",
    },
  ])("실제 구조좌표 %s를 해당 형식으로 표시한다", (coordinate) => {
    const html = renderToStaticMarkup(
      createElement(SourceSuggestionPosition, {
        position: { start: 0, end: 10, lineStart: 1, lineEnd: 1, coordinate },
      }),
    );
    expect(html).not.toContain("좌표 미확인");
    expect(html).toContain("UTF-16");
    if (coordinate.kind === "spreadsheet-cell") expect(html).toContain("B5");
    else if (coordinate.kind === "subtitle-cue") expect(html).toContain("00:00:01,000");
    else expect(html).toContain(`${coordinate.pageNumber}페이지`);
  });
  it("과거 채택 이력은 당시 인용·이전값·값을 escaped 텍스트로 보존한다", () => {
    const record = saved().sourceSuggestionAdoptions[0];
    record.selections[0].quote = "<script>원문</script>";
    const html = renderToStaticMarkup(
      createElement(SourceSuggestionReceiptView, { receipt: record }),
    );
    expect(html).toContain("가상 기존 기업");
    expect(html).toContain("가상 새 기업");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("현재 값·원본의 최신성이나 사실 검증 완료를 뜻하지");
    expect(html).toContain(record.binding.textSha256);
  });
  it("자료 편집·접수 중이면 제안 준비 입력을 잠근다", () => {
    const html = renderToStaticMarkup(
      createElement(SourceSuggestionsPanel, {
        company: company(),

        busy: false,
        blockedReason: "접수 또는 교정을 먼저 마쳐 주세요.",
        onDirtyChange: vi.fn(),
        onBusyChange: vi.fn(),
        onCompany: vi.fn(),
      }),
    );
    expect(html).toContain("접수 또는 교정을 먼저 마쳐 주세요");
    expect(html).toMatch(/<fieldset[^>]*disabled=""/);
  });
  it("빈 값과 0을 구별하며 임의 금액 환산을 하지 않는다", () => {
    expect(suggestionDisplayValue("paidInCapital", "")).toBe("미기록");
    expect(suggestionDisplayValue("paidInCapital", "0")).toBe("0원");
    expect(suggestionDisplayValue("paidInCapital", "1234567")).toBe("1234567원");
  });
});
