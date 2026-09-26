// Registered text comparison only. No filesystem, database, AI or portal operations.
import { createHash } from "node:crypto";
import type { StudioCase, SourceDocument } from "./studio-schema";
import { StudioError } from "./studio-http";
import { planConflicts } from "./studio-evidence-history";
import { validateSourceLocationMetadata } from "./studio-source-location";
import type { SourceLocationMetadata } from "./studio-source-location-types";
import {
  answerSuggestionAiSelectionSchema,
  answerSuggestionBindingSchema,
  answerSuggestionInputSchema,
  answerSuggestionLimits,
  answerSuggestionRuleVersion,
  answerSuggestionsSchema,
  answerSuggestionTransmissionSchema,
  type AnswerSuggestionBinding,
  type AnswerSuggestionCandidate,
  type AnswerSuggestionInput,
  type AnswerSuggestionTransmission,
  type AnswerSuggestions,
} from "./studio-answer-suggestion-types";

export const answerSuggestionSha = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export function answerSuggestionError(code: string, status = 409): never {
  throw new StudioError(
    "현재 요청·질문과 명시적으로 선택한 자료 본문을 다시 확인해 주세요. 기존 답변은 변경하지 않았습니다.",
    status,
    code,
  );
}
export function answerSuggestionBoundary(text: string, at: number) {
  return !(
    at > 0 &&
    at < text.length &&
    /[\uD800-\uDBFF]/.test(text[at - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[at])
  );
}
function adoptedLocations(company: StudioCase, source: SourceDocument) {
  const candidates: SourceLocationMetadata[] = [];
  for (const item of company.sourceIntakes) {
    const adoption = item.adoption;
    if (
      item.sourceId !== source.id ||
      !adoption ||
      adoption.sourceUpdatedAt !== source.updatedAt ||
      adoption.adoptedTextSha256 !== answerSuggestionSha(source.text)
    )
      continue;
    const results = [...item.previousResults, ...(item.result ? [item.result] : [])].filter(
      (result) => result.id === adoption.resultId,
    );
    if (results.length !== 1) continue;
    const result = results[0];
    if (
      result.textSha256 !== adoption.adoptedTextSha256 ||
      result.textSha256 !== adoption.resultTextSha256 ||
      !result.locations ||
      !validateSourceLocationMetadata(source.text, result.locations)
    )
      continue;
    candidates.push(result.locations);
  }
  return candidates.length === 1 ? candidates[0] : null;
}
export type AnswerSuggestionContext = {
  input: AnswerSuggestionInput;
  binding: AnswerSuggestionBinding;
  transmission: AnswerSuggestionTransmission;
  sources: Array<{ source: SourceDocument; locations: SourceLocationMetadata | null }>;
};
export function buildAnswerSuggestionContext(
  company: StudioCase,
  raw: AnswerSuggestionInput,
): AnswerSuggestionContext {
  const input = answerSuggestionInputSchema.parse(raw);
  if (input.revision !== company.revision) answerSuggestionError("ANSWER_SUGGESTION_STALE");
  const target = input.target;
  let targetText: string, targetSha256: string;
  if (target.kind === "agency-request") {
    const roots = company.agencyRecords.filter(
      (record) => record.kind === "request" && record.id === target.requestRecordId,
    );
    const records = company.agencyRecords.filter(
      (record) =>
        (record.kind === "request" || record.kind === "request-correction") &&
        record.requestRecordId === target.requestRecordId,
    );
    const current = records.at(-1);
    if (
      roots.length !== 1 ||
      !current ||
      current.id !== target.requestVersionId ||
      records.filter((record) => record.id === target.requestVersionId).length !== 1
    )
      answerSuggestionError("ANSWER_SUGGESTION_TARGET_STALE");
    if (
      target.end <= target.start ||
      target.end > current.body.length ||
      current.body.slice(target.start, target.end) !== target.quote ||
      !answerSuggestionBoundary(current.body, target.start) ||
      !answerSuggestionBoundary(current.body, target.end)
    )
      answerSuggestionError("ANSWER_SUGGESTION_QUOTE_INVALID", 422);
    targetText = target.quote;
    targetSha256 = answerSuggestionSha(JSON.stringify(current));
  } else {
    const plans = company.plans.filter((plan) => plan.id === target.planId),
      plan = plans[0];
    if (
      plans.length !== 1 ||
      plan.version !== target.planVersion ||
      plan.content.interviewQuestions[target.questionIndex] !== target.questionText ||
      answerSuggestionSha(target.questionText) !== target.questionSha256
    )
      answerSuggestionError("ANSWER_SUGGESTION_TARGET_STALE");
    const contentSha256 = answerSuggestionSha(JSON.stringify(plan.content));
    if (planConflicts(company, { planId: plan.id, version: plan.version, contentSha256 }))
      answerSuggestionError("ANSWER_SUGGESTION_TARGET_STALE");
    targetText = target.questionText;
    targetSha256 = answerSuggestionSha(
      JSON.stringify({
        id: plan.id,
        version: plan.version,
        contentSha256,
        questionIndex: target.questionIndex,
        questionText: target.questionText,
      }),
    );
  }
  const sources = input.sourceSelections.map((selected) => {
    const matches = company.sources.filter((source) => source.id === selected.sourceId),
      source = matches[0];
    if (
      matches.length !== 1 ||
      source.extraction === "pending" ||
      !source.text.trim() ||
      source.updatedAt !== selected.sourceUpdatedAt ||
      answerSuggestionSha(source.text) !== selected.textSha256
    )
      answerSuggestionError("ANSWER_SUGGESTION_SOURCE_STALE");
    return { source, locations: adoptedLocations(company, source) };
  });
  if (
    sources.reduce((sum, { source }) => sum + source.text.length, 0) >
    answerSuggestionLimits.sourceCharacters
  )
    answerSuggestionError("ANSWER_SUGGESTION_LIMIT", 413);
  const sourceBindings = sources.map(({ source, locations }) => ({
    sourceId: source.id,
    sourceName: source.name,
    sourceUpdatedAt: source.updatedAt,
    textSha256: answerSuggestionSha(source.text),
    characters: source.text.length,
    locationsSha256: locations ? answerSuggestionSha(JSON.stringify(locations)) : null,
  }));
  const base = answerSuggestionBindingSchema.omit({ inputSha256: true }).parse({
    caseId: company.id,
    companyRevision: company.revision,
    target,
    targetSha256,
    sources: sourceBindings,
  });
  return {
    input,
    binding: answerSuggestionBindingSchema.parse({
      ...base,
      inputSha256: answerSuggestionSha(JSON.stringify(base)),
    }),
    sources,
    transmission: answerSuggestionTransmissionSchema.parse({
      targetText,
      sources: sources.map(({ source }) => ({
        sourceId: source.id,
        sourceName: source.name,
        text: source.text,
      })),
    }),
  };
}
function exactCandidate(
  context: AnswerSuggestionContext,
  selected: { sourceId: string; start: number; end: number; quote: string },
): AnswerSuggestionCandidate {
  const match = context.sources.find(({ source }) => source.id === selected.sourceId);
  if (!match) answerSuggestionError("ANSWER_SUGGESTION_OUTPUT_INVALID", 422);
  const { source, locations } = match;
  if (
    selected.end <= selected.start ||
    selected.end > source.text.length ||
    selected.quote.length > answerSuggestionLimits.quote ||
    !selected.quote.trim() ||
    source.text.slice(selected.start, selected.end) !== selected.quote ||
    !answerSuggestionBoundary(source.text, selected.start) ||
    !answerSuggestionBoundary(source.text, selected.end)
  )
    answerSuggestionError("ANSWER_SUGGESTION_OUTPUT_INVALID", 422);
  const segments =
    locations?.segments.filter(
      (segment) => segment.start <= selected.start && segment.end >= selected.end,
    ) ?? [];
  return {
    id: answerSuggestionSha(JSON.stringify({ input: context.binding.inputSha256, ...selected })),
    sourceName: source.name,
    sourceUpdatedAt: source.updatedAt,
    textSha256: answerSuggestionSha(source.text),
    ...selected,
    lineStart: source.text.slice(0, selected.start).split("\n").length,
    lineEnd: source.text.slice(0, selected.end).split("\n").length,
    coordinate: segments.length === 1 ? segments[0].coordinate : null,
  };
}
function result(
  context: AnswerSuggestionContext,
  candidates: AnswerSuggestionCandidate[],
  mode: "assisted" | "ai",
  model: string | null,
): AnswerSuggestions {
  return answerSuggestionsSchema.parse({
    ruleVersion: answerSuggestionRuleVersion,
    mode,
    model,
    binding: context.binding,
    candidates,
    followUpQuestions: candidates.length
      ? [
          "선택한 인용의 대상·기간·단위가 요청 또는 질문과 관련되는지 확인했나요?",
          "원본과 실제 답변을 대조한 뒤 추가로 확보할 자료가 있나요?",
        ]
      : [
          "선택한 본문에서 제안할 인용을 찾지 못했습니다. 직접 관련 구간을 확인하거나 추가 자료를 선택해 주세요.",
        ],
    warnings: [
      mode === "assisted"
        ? "명시된 단어의 일치로 고른 로컬 인용 후보입니다. 의미 적합성이나 사실 일치 판정이 아닙니다."
        : "외부 AI가 선택한 미검토 인용 후보입니다. 서버는 정확한 본문 범위만 대조했으며 의미·사실을 검증하지 않았습니다.",
      "현재 등록된 선택 자료 본문만 대조했습니다. 원본 파일은 읽거나 전송하지 않았습니다.",
      "저장되지 않은 제안입니다. 필요한 인용만 선택해 기존 답변 편집기에 가져온 뒤 직접 검토·저장하세요.",
    ],
    reviewStatus: "unreviewed",
    originalCheck: "not-read",
    databaseChanged: false,
  });
}
export function buildLocalAnswerSuggestions(context: AnswerSuggestionContext) {
  const tokens = [
    ...new Set(context.transmission.targetText.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []),
  ].slice(0, 30);
  const choices: Array<{
    sourceId: string;
    start: number;
    end: number;
    quote: string;
    score: number;
    sourceIndex: number;
  }> = [];
  context.sources.forEach(({ source }, sourceIndex) => {
    for (const match of source.text.matchAll(/[^\r\n]+/g)) {
      const text = match[0];
      if (!text.trim() || text.length > answerSuggestionLimits.quote) continue;
      const score = tokens.filter((token) => text.toLowerCase().includes(token)).length;
      if (score)
        choices.push({
          sourceId: source.id,
          start: match.index,
          end: match.index + text.length,
          quote: text,
          score,
          sourceIndex,
        });
    }
  });
  choices.sort((a, b) => b.score - a.score || a.sourceIndex - b.sourceIndex || a.start - b.start);
  return result(
    context,
    choices
      .slice(0, answerSuggestionLimits.candidates)
      .map(({ score, sourceIndex, ...selection }) => {
        void score;
        void sourceIndex;
        return exactCandidate(context, selection);
      }),
    "assisted",
    null,
  );
}
export function validateAiAnswerSuggestions(
  context: AnswerSuggestionContext,
  raw: unknown,
  model: string,
) {
  const parsed = answerSuggestionAiSelectionSchema.safeParse(raw);
  if (!parsed.success) answerSuggestionError("ANSWER_SUGGESTION_OUTPUT_INVALID", 422);
  const candidates: AnswerSuggestionCandidate[] = [];
  for (const selected of parsed.data.selections) {
    if (
      candidates.some(
        (candidate) =>
          candidate.sourceId === selected.sourceId &&
          selected.start < candidate.end &&
          selected.end > candidate.start,
      )
    )
      answerSuggestionError("ANSWER_SUGGESTION_OUTPUT_INVALID", 422);
    candidates.push(exactCandidate(context, selected));
  }
  return result(context, candidates, "ai", model);
}
