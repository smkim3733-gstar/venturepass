import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { caseSchema, emptyProfile, type StudioCase } from "@/lib/studio-schema";
import {
  answerSuggestionSha as sha,
  buildAnswerSuggestionContext,
  buildLocalAnswerSuggestions,
  validateAiAnswerSuggestions,
} from "@/lib/studio-answer-suggestion";
import { buildAgencyRecord, agencyRecordInputSchema } from "@/lib/studio-agency-records";
import {
  answerSuggestionAiPreviewSchema,
  type AnswerSuggestionAiPreview,
  type AnswerSuggestionCandidate,
} from "@/lib/studio-answer-suggestion-types";
import { sourceLocationMetadataSchema } from "@/lib/studio-source-location-types";
import { sourceIntakeItemSchema } from "@/lib/studio-source-intake-types";
import {
  answerRequestOccurrences,
  answerSuggestionInput,
  validateAnswerSuggestions,
  validateAnswerAiPreview,
  applyResponseAnswerSuggestions,
  applyVisitAnswerSuggestions,
  sendAnswerSuggestion,
  sendApprovedAnswerSuggestion,
  type AnswerSuggestionScope,
} from "./answer-suggestions-ui";
import { AnswerAiPreviewView, AnswerSuggestionsPanel } from "./answer-suggestions-panel";
import {
  newResponseItem,
  ResponseItemEditor,
  responseInputFor,
  responseSuggestionContext,
} from "./response-preparation";
import { visitAnswerInputFor } from "./visit-answers";

vi.mock("server-only", () => ({}));
const now = "2026-09-26T00:00:00.000Z";
function fixture() {
  const sourceId = randomUUID();
  const company: StudioCase = caseSchema.parse({
    id: randomUUID(),
    revision: 1,
    profile: {
      ...emptyProfile(),
      companyName: "합성 제안 기업",
      financials: "선택하지 않은 비공개 영역",
    },
    sources: [
      {
        id: sourceId,
        name: "합성 자료",
        kind: "technology",
        text: "앞 인사\n검증 상태는 개발 중입니다.\n아직 매출은 확인하지 않았습니다.",
        extraction: "manual",
        originalName: null,
        mimeType: null,
        warnings: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    analysis: null,
    selectedCandidateId: null,
    plans: [
      {
        id: randomUUID(),
        version: 1,
        generatedAt: now,
        mode: "manual",
        candidateId: "fixture",
        sourceRevision: 0,
        content: {
          title: "합성 계획",
          summary: "요약",
          sections: [
            {
              key: "tech",
              title: "기술",
              content: "비공개 원고",
              evidence: [],
              needsConfirmation: true,
            },
          ],
          actionItems: [],
          interviewQuestions: ["검증 상태는 무엇인가요?"],
        },
        review: [],
        confirmedAt: null,
      },
    ],
    tasks: [],
    stage: "preparing",
    createdAt: now,
    updatedAt: now,
  });
  const request = buildAgencyRecord(
    [],
    agencyRecordInputSchema.parse({
      kind: "request",
      title: "합성 요청",
      institution: "합성 기관",
      body: "첫 부분\n검증 상태를 알려 주세요.\n다음 부분",
      occurredOn: "",
      note: "전송하지 않는 메모",
      dueOn: "",
      dueNote: "",
      sourceIds: [],
    }),
    {
      id: randomUUID(),
      clientRequestId: randomUUID(),
      inputDigest: sha("synthetic"),
      recordedAt: now,
      evidence: [],
    },
  );
  if (request.kind !== "request") throw new Error("fixture");
  company.agencyRecords = [request];
  const plan = company.plans[0];
  const scope: AnswerSuggestionScope = {
    kind: "visit-question",
    planId: plan.id,
    planVersion: 1,
    questionIndex: 0,
    questionText: plan.content.interviewQuestions[0],
  };
  const requestScope: AnswerSuggestionScope = {
    kind: "agency-request",
    requestRecordId: request.id,
    requestVersionId: request.id,
    quote: "검증 상태를 알려 주세요.",
  };
  return { company, source: company.sources[0], plan, request, scope, requestScope };
}
async function context(f = fixture(), scope: AnswerSuggestionScope = f.scope) {
  const input = (await answerSuggestionInput(f.company, scope, [f.source.id], null))!;
  const context = buildAnswerSuggestionContext(f.company, input);
  const result = buildLocalAnswerSuggestions(context);
  const preview = answerSuggestionAiPreviewSchema.parse({
    approval: {
      token: randomUUID(),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      binding: context.binding,
      provider: "openai",
      destination: "https://api.openai.com/v1/responses",
      purpose: "select-exact-answer-excerpts",
      model: "synthetic-model",
      payloadSha256: sha(JSON.stringify(context.transmission)),
    },
    transmission: context.transmission,
    externalTransmissionPerformed: false,
  });
  return { ...f, input, result, preview, context };
}

describe("exact current target and selected adopted text", () => {
  it("creates a server-compatible visit target without transmitting unselected content", async () => {
    const f = await context();
    expect(await validateAnswerSuggestions(f.result, f.company, f.input, "assisted")).toEqual(
      f.result,
    );
    expect(JSON.stringify(f.input)).not.toContain("선택하지 않은 비공개");
    expect(JSON.stringify(f.input)).not.toContain(f.source.text);
  });
  it("locates a unique exact request excerpt", async () => {
    const f = fixture();
    const input = await answerSuggestionInput(f.company, f.requestScope, [f.source.id], null);
    expect(input?.target.kind).toBe("agency-request");
    expect(answerRequestOccurrences(f.company, f.requestScope)).toEqual([5]);
    const value = await context(f, f.requestScope);
    expect(
      await validateAnswerSuggestions(value.result, value.company, value.input, "assisted"),
    ).not.toBeNull();
  });
  it("requires explicit location for repeated request text", async () => {
    const f = fixture();
    f.request.body += "\n검증 상태를 알려 주세요.";
    const occurrences = answerRequestOccurrences(f.company, f.requestScope);
    expect(occurrences).toHaveLength(2);
    expect(await answerSuggestionInput(f.company, f.requestScope, [f.source.id], null)).toBeNull();
    expect(
      (await answerSuggestionInput(f.company, f.requestScope, [f.source.id], occurrences[1]))
        ?.target,
    ).toMatchObject({ start: occurrences[1] });
  });
  it.each(["pending", "empty", "duplicate", "foreign", "oversize"])(
    "rejects %s source selection",
    async (mode) => {
      const f = fixture();
      let ids = [f.source.id];
      if (mode === "pending") f.source.extraction = "pending";
      if (mode === "empty") f.source.text = " ";
      if (mode === "duplicate") ids.push(f.source.id);
      if (mode === "foreign") ids = [randomUUID()];
      if (mode === "oversize") f.source.text = "가".repeat(60_001);
      expect(await answerSuggestionInput(f.company, f.scope, ids, null)).toBeNull();
    },
  );
  it.each(["old-version", "wrong-question", "duplicate-plan", "changed-request"])(
    "rejects %s target",
    async (mode) => {
      const f = fixture();
      let scope: AnswerSuggestionScope = f.scope;
      if (mode === "old-version") f.plan.version++;
      if (mode === "wrong-question") f.plan.content.interviewQuestions[0] += "변경";
      if (mode === "duplicate-plan") f.company.plans.push(f.plan);
      if (mode === "changed-request") {
        f.request.body = "다른 요청";
        scope = f.requestScope;
      }
      expect(await answerSuggestionInput(f.company, scope, [f.source.id], null)).toBeNull();
    },
  );
  it.each([
    "case",
    "revision",
    "source-body",
    "source-time",
    "source-name",
    "target",
    "mode",
    "model",
    "quote",
    "offset",
    "line",
    "coordinate",
    "candidate-id",
    "duplicate",
  ])("rejects %s result changes", async (mode) => {
    const f = await context();
    const value = structuredClone(f.result);
    if (mode === "case") value.binding.caseId = randomUUID();
    if (mode === "revision") f.company.revision++;
    if (mode === "source-body") f.source.text += "변경";
    if (mode === "source-time") f.source.updatedAt = "2026-09-27T00:00:00.000Z";
    if (mode === "source-name") f.source.name += "변경";
    if (mode === "target") f.plan.content.interviewQuestions[0] += "변경";
    if (mode === "mode") value.mode = "ai";
    if (mode === "model") value.model = "other-model";
    if (mode === "quote") value.candidates[0].quote = "허위 결과";
    if (mode === "offset") value.candidates[0].start++;
    if (mode === "line") value.candidates[0].lineStart++;
    if (mode === "coordinate") value.candidates[0].coordinate = { kind: "pdf-page", pageNumber: 1 };
    if (mode === "candidate-id") value.candidates[0].id = "b".repeat(64);
    if (mode === "duplicate") value.candidates.push(value.candidates[0]);
    expect(await validateAnswerSuggestions(value, f.company, f.input, "assisted")).toBeNull();
  });
  it("validates same original adopted coordinates and drops fabricated legacy page claims", async () => {
    const f = fixture();
    const resultId = randomUUID();
    const textSha256 = sha(f.source.text);
    const locations = sourceLocationMetadataSchema.parse({
      version: 1,
      textSha256,
      coverage: "complete",
      segments: [
        { start: 0, end: f.source.text.length, coordinate: { kind: "ocr-page", pageNumber: 1 } },
      ],
    });
    f.company.sourceIntakes = [
      sourceIntakeItemSchema.parse({
        id: randomUUID(),
        batchId: randomUUID(),
        clientFileId: randomUUID(),
        sourceId: f.source.id,
        version: 1,
        declared: { originalName: "synthetic.pdf", sizeBytes: 10, kind: "technology" },
        phase: "adopted",
        original: null,
        attempts: [],
        result: {
          id: resultId,
          attemptId: randomUUID(),
          engine: "windows-ko",
          generatedAt: now,
          originalSha256: sha("file"),
          sourceUpdatedAt: now,
          textSha256,
          content: { kind: "plain", text: f.source.text },
          warnings: [],
          reviewStatus: "unreviewed",
          discardedAt: null,
          locations,
        },
        previousResults: [],
        adoption: {
          id: randomUUID(),
          clientRequestId: randomUUID(),
          inputDigest: sha("adoption"),
          resultId,
          resultTextSha256: textSha256,
          adoptedTextSha256: textSha256,
          sourceUpdatedAt: now,
          adoptedAt: now,
        },
        requests: [],
        createdAt: now,
        updatedAt: now,
        code: null,
      }),
    ];
    const value = await context(f);
    expect(value.result.candidates[0].coordinate).toEqual({ kind: "ocr-page", pageNumber: 1 });
    expect(
      await validateAnswerSuggestions(value.result, f.company, value.input, "assisted"),
    ).not.toBeNull();
  });
});

describe("exact single-use AI review boundary", () => {
  it("accepts exact AI excerpts only for the individually approved model", async () => {
    const f = await context();
    const result = validateAiAnswerSuggestions(
      f.context,
      {
        selections: f.result.candidates.map(({ sourceId, start, end, quote }) => ({
          sourceId,
          start,
          end,
          quote,
        })),
      },
      "synthetic-model",
    );
    expect(
      await validateAnswerSuggestions(result, f.company, f.input, "ai", "synthetic-model"),
    ).toEqual(result);
    expect(
      await validateAnswerSuggestions(result, f.company, f.input, "ai", "other-model"),
    ).toBeNull();
  });
  it("reproduces binding and payload hashes from normalized schemas", async () => {
    const f = await context();
    expect(await validateAnswerAiPreview(f.preview, f.company, f.input)).toEqual(f.preview);
  });
  it.each([
    "expired",
    "long-expiry",
    "payload",
    "source-text",
    "target-text",
    "model",
    "destination",
    "extra",
  ])("rejects %s approval", async (mode) => {
    const f = await context();
    const value: AnswerSuggestionAiPreview & { extra?: string } = structuredClone(f.preview);
    if (mode === "expired") value.approval.expiresAt = new Date(Date.now() - 1).toISOString();
    if (mode === "long-expiry")
      value.approval.expiresAt = new Date(Date.now() + 999999).toISOString();
    if (mode === "payload") value.approval.payloadSha256 = "b".repeat(64);
    if (mode === "source-text") value.transmission.sources[0].text += "추가";
    if (mode === "target-text") value.transmission.targetText += "추가";
    if (mode === "model") value.approval.model = "bad model";
    if (mode === "destination")
      (value.approval as unknown as { destination: string }).destination =
        "https://example.invalid";
    if (mode === "extra") value.extra = "unexpected";
    expect(await validateAnswerAiPreview(value, f.company, f.input)).toBeNull();
  });
  it("does not retry an unknown AI transport", async () => {
    const f = await context();
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error("lost"));
    await expect(
      sendApprovedAnswerSuggestion(f.company, f.input, f.preview, () => true, transport),
    ).rejects.toThrow("lost");
    expect(transport).toHaveBeenCalledTimes(1);
    const body = JSON.parse(transport.mock.calls[0][1]!.body as string);
    expect(body.action).toBe("run-ai");
    expect(body.approved).toBe(true);
    expect(body.approval.token).toBe(f.preview.approval.token);
  });
  it("checks context after asynchronous approval hashing before transmission", async () => {
    const f = await context();
    let current = true;
    let resolve!: () => void;
    const gate = new Promise<void>((done) => {
      resolve = done;
    });
    const original = crypto.subtle.digest.bind(crypto.subtle);
    const digest = vi
      .spyOn(crypto.subtle, "digest")
      .mockImplementationOnce(async (algorithm, data) => {
        await gate;
        return original(algorithm, data);
      });
    const transport = vi.fn<typeof fetch>();
    const pending = sendApprovedAnswerSuggestion(
      f.company,
      f.input,
      f.preview,
      () => current,
      transport,
    );
    current = false;
    resolve();
    expect(await pending).toBeNull();
    expect(transport).not.toHaveBeenCalled();
    digest.mockRestore();
  });
  it("local request has no approval and reads only selected source bindings", async () => {
    const f = await context();
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(f.result));
    await sendAnswerSuggestion(f.company.id, { action: "local", input: f.input }, transport);
    const body = JSON.parse(transport.mock.calls[0][1]!.body as string);
    expect(body.action).toBe("local");
    expect(body.approval).toBeUndefined();
    expect(body.input.sourceSelections).toHaveLength(1);
  });
});

describe("explicit unreviewed editor application", () => {
  it("invalidates a response item's proposal when its title or sibling item changes", () => {
    const f = fixture();
    const input = responseInputFor(f.request);
    input.items.push(newResponseItem());
    const originalItem = input.items[0];
    const before = responseSuggestionContext(f.company, input);
    const changedTitle = { ...input, title: "새 제목" };
    expect(changedTitle.items[0]).toBe(originalItem);
    expect(responseSuggestionContext(f.company, changedTitle)).not.toBe(before);
    const changedSibling = {
      ...input,
      items: [originalItem, { ...input.items[1], draft: "보존해야 할 새 편집" }],
    };
    expect(responseSuggestionContext(f.company, changedSibling)).not.toBe(before);
    expect(responseSuggestionContext({ ...f.company, revision: 2 }, input)).not.toBe(before);
  });
  it("requires replacement acknowledgement and preserves unrelated response fields", async () => {
    const base = fixture();
    const f = await context(base, base.requestScope);
    const item = {
      ...newResponseItem(),
      requestQuote: base.requestScope.kind === "agency-request" ? base.requestScope.quote : "",
      summary: "담당자 요약",
      gap: "추가 확인",
      draft: "기존 답변",
    };
    expect(
      applyResponseAnswerSuggestions(item, f.input.target, f.result.candidates, false).error,
    ).toBeTruthy();
    const next = applyResponseAnswerSuggestions(
      item,
      f.input.target,
      f.result.candidates,
      true,
    ).value!;
    expect(next.summary).toBe(item.summary);
    expect(next.gap).toBe(item.gap);
    expect(next.draft).toContain("미검토");
    expect(next.evidence).toHaveLength(1);
    expect(item.draft).toBe("기존 답변");
    expect(
      applyResponseAnswerSuggestions(next, f.input.target, f.result.candidates, true).value!
        .evidence,
    ).toHaveLength(1);
  });
  it("rejects multiple quotes for a single response source", async () => {
    const base = fixture();
    const f = await context(base, base.requestScope);
    const item = {
      ...newResponseItem(),
      requestQuote: f.input.target.kind === "agency-request" ? f.input.target.quote : "",
    };
    expect(
      applyResponseAnswerSuggestions(
        item,
        f.input.target,
        [f.result.candidates[0], { ...f.result.candidates[0], id: "b".repeat(64) }],
        false,
      ).error,
    ).toContain("하나만");
  });
  it("refuses adding a seventh response source without dropping existing evidence", async () => {
    const base = fixture();
    const f = await context(base, base.requestScope);
    const item = {
      ...newResponseItem(),
      requestQuote: f.input.target.kind === "agency-request" ? f.input.target.quote : "",
      evidence: Array.from({ length: 6 }, () => ({
        sourceId: randomUUID(),
        sourceUpdatedAt: now,
        quote: "기존 근거",
        locator: "수동 위치",
      })),
    };
    expect(
      applyResponseAnswerSuggestions(item, f.input.target, f.result.candidates, true).error,
    ).toContain("6개");
    expect(item.evidence).toHaveLength(6);
  });
  it("visit application resets review and deduplicates exact quote/source pairs", async () => {
    const f = await context();
    const input = visitAnswerInputFor(f.plan, 0);
    input.answerText = "기존 답변";
    input.followUpNote = "담당자 메모";
    input.review = { reviewed: true, reviewer: "합성 검토자", note: "이전 검토" };
    expect(
      applyVisitAnswerSuggestions(input, f.input.target, f.result.candidates, false).error,
    ).toBeTruthy();
    const next = applyVisitAnswerSuggestions(
      input,
      f.input.target,
      [f.result.candidates[0], { ...f.result.candidates[0], id: "b".repeat(64) }],
      true,
    ).value!;
    expect(next.review).toEqual({ reviewed: false, reviewer: "", note: "" });
    expect(next.pairs).toHaveLength(1);
    expect(next.followUpNote).toBe(input.followUpNote);
    expect(next.answerText).toContain("실제 발언·기관 발송·사실 확인 아님");
    expect(input.review.reviewed).toBe(true);
  });
  it("rejects overlong visit text without trimming or losing existing draft", async () => {
    const f = await context();
    const input = visitAnswerInputFor(f.plan, 0);
    input.answerText = "보존 원문";
    const candidates: AnswerSuggestionCandidate[] = Array.from({ length: 10 }, (_, i) => ({
      ...f.result.candidates[0],
      id: sha(String(i)),
      sourceId: randomUUID(),
      quote: "가".repeat(1500),
    }));
    expect(applyVisitAnswerSuggestions(input, f.input.target, candidates, true).error).toContain(
      "10,000",
    );
    expect(input.answerText).toBe("보존 원문");
  });
  it("refuses mismatched target application", async () => {
    const f = await context();
    const input = visitAnswerInputFor(f.plan, 0);
    input.questionText = "다른 질문";
    expect(
      applyVisitAnswerSuggestions(input, f.input.target, f.result.candidates, false).error,
    ).toBeTruthy();
  });
});

describe("proposal UI read-only defaults and explicit transmission display", () => {
  it("initial selection and transmission approval are empty; SSR performs no calls", () => {
    const f = fixture();
    const transport = vi.spyOn(globalThis, "fetch");
    const apply = vi.fn();
    const busy = vi.fn();
    const html = renderToStaticMarkup(
      createElement(AnswerSuggestionsPanel, {
        company: f.company,
        scope: f.scope,
        contextFingerprint: "synthetic",
        disabled: false,
        hasExistingContent: false,
        onePerSource: false,
        onBusyChange: busy,
        onApply: apply,
      }),
    );
    expect(html).toContain("이 PC에서 근거 제안");
    expect(html).toContain("AI 전송 내용 먼저 확인");
    expect(html).not.toContain('checked=""');
    expect(html).not.toContain("선택하지 않은 비공개 영역");
    expect(transport).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(busy).not.toHaveBeenCalled();
    transport.mockRestore();
  });
  it("shows exact full payload, provider, model, purpose and SHA escaped", async () => {
    const f = await context();
    f.preview.transmission.sources[0].text = "<script>synthetic</script> 전체 본문";
    const html = renderToStaticMarkup(createElement(AnswerAiPreviewView, { preview: f.preview }));
    expect(html).toContain("https://api.openai.com/v1/responses");
    expect(html).toContain("synthetic-model");
    expect(html).toContain(f.preview.approval.payloadSha256);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("처리 비용");
  });
  it("response editor exposes local proposal only after exact request text", () => {
    const f = fixture();
    const html = renderToStaticMarkup(
      createElement(ResponseItemEditor, {
        company: f.company,
        request: f.request,
        item: newResponseItem(),
        index: 0,
        onChange: vi.fn(),
        onRemove: vi.fn(),
      }),
    );
    expect(html).toContain("최신 요청의 정확한 부분을 먼저 인용");
    expect(html).toContain("선택 자료에서 미검토 답변 근거 제안");
  });
});
