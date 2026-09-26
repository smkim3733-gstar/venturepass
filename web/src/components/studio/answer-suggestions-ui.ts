import type { StudioCase, SourceDocument } from "@/lib/studio-schema";
import {
  sourceLocationMetadataSchema,
  type SourceLocationMetadata,
} from "@/lib/studio-source-location-types";
import {
  answerSuggestionAiPreviewSchema,
  answerSuggestionInputSchema,
  answerSuggestionLimits,
  answerSuggestionsSchema,
  answerSuggestionDraft,
  type AnswerSuggestionTarget,
  type AnswerSuggestionInput,
  type AnswerSuggestionBinding,
  type AnswerSuggestionCandidate,
  type AnswerSuggestions,
  type AnswerSuggestionAiPreview,
  type AnswerSuggestionCommand,
} from "@/lib/studio-answer-suggestion-types";
import type { ResponsePreparationItem } from "@/lib/studio-response-preparation-types";
import type { VisitAnswerInput } from "@/lib/studio-visit-answer-types";
import { suggestionTextHash as sha } from "./source-suggestions-ui";

export type AnswerSuggestionScope =
  | { kind: "agency-request"; requestRecordId: string; requestVersionId: string; quote: string }
  | {
      kind: "visit-question";
      planId: string;
      planVersion: number;
      questionIndex: number;
      questionText: string;
    };
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const boundary = (text: string, at: number) =>
  !(
    at > 0 &&
    at < text.length &&
    /[\uD800-\uDBFF]/.test(text[at - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[at])
  );
export function answerRequestOccurrences(
  company: StudioCase,
  scope: AnswerSuggestionScope,
): number[] {
  if (scope.kind !== "agency-request" || !scope.quote.trim() || scope.quote.length > 1500)
    return [];
  const records = company.agencyRecords.filter(
    (record) =>
      (record.kind === "request" || record.kind === "request-correction") &&
      record.requestRecordId === scope.requestRecordId,
  );
  const record = records.at(-1);
  if (
    !record ||
    record.id !== scope.requestVersionId ||
    records.filter((entry) => entry.id === record.id).length !== 1
  )
    return [];
  const positions: number[] = [];
  let start = record.body.indexOf(scope.quote);
  while (start >= 0) {
    if (boundary(record.body, start) && boundary(record.body, start + scope.quote.length))
      positions.push(start);
    start = record.body.indexOf(scope.quote, start + 1);
  }
  return positions;
}
export async function answerSuggestionInput(
  company: StudioCase,
  scope: AnswerSuggestionScope,
  sourceIds: string[],
  occurrence: number | null,
): Promise<AnswerSuggestionInput | null> {
  let target: AnswerSuggestionTarget;
  if (scope.kind === "agency-request") {
    const positions = answerRequestOccurrences(company, scope);
    const start = positions.length === 1 ? positions[0] : occurrence;
    if (start === null || !positions.includes(start)) return null;
    target = { ...scope, start, end: start + scope.quote.length };
  } else {
    const plans = company.plans.filter((plan) => plan.id === scope.planId);
    if (
      plans.length !== 1 ||
      plans[0].version !== scope.planVersion ||
      plans[0].content.interviewQuestions[scope.questionIndex] !== scope.questionText
    )
      return null;
    target = { ...scope, questionSha256: await sha(scope.questionText) };
  }
  if (!sourceIds.length || sourceIds.length > 6 || new Set(sourceIds).size !== sourceIds.length)
    return null;
  const sources = sourceIds.map((sourceId) =>
    company.sources.filter((source) => source.id === sourceId),
  );
  if (
    sources.some(
      (matches) =>
        matches.length !== 1 || matches[0].extraction === "pending" || !matches[0].text.trim(),
    ) ||
    sources.reduce((sum, matches) => sum + (matches[0]?.text.length ?? 0), 0) > 60_000
  )
    return null;
  const parsed = answerSuggestionInputSchema.safeParse({
    revision: company.revision,
    target,
    sourceSelections: await Promise.all(
      sources.map(async ([source]) => ({
        sourceId: source.id,
        sourceUpdatedAt: source.updatedAt,
        textSha256: await sha(source.text),
      })),
    ),
  });
  return parsed.success ? parsed.data : null;
}
async function sourceLocations(
  company: StudioCase,
  source: SourceDocument,
): Promise<SourceLocationMetadata | null> {
  const textSha256 = await sha(source.text);
  const results: SourceLocationMetadata[] = [];
  for (const item of company.sourceIntakes) {
    const adoption = item.adoption;
    if (
      item.sourceId !== source.id ||
      !adoption ||
      adoption.sourceUpdatedAt !== source.updatedAt ||
      adoption.adoptedTextSha256 !== textSha256
    )
      continue;
    const matches = [...item.previousResults, ...(item.result ? [item.result] : [])].filter(
      (result) => result.id === adoption.resultId,
    );
    if (
      matches.length !== 1 ||
      matches[0].textSha256 !== textSha256 ||
      matches[0].textSha256 !== adoption.resultTextSha256
    )
      continue;
    const parsed = sourceLocationMetadataSchema.safeParse(matches[0].locations);
    if (
      !parsed.success ||
      parsed.data.textSha256 !== textSha256 ||
      parsed.data.segments.some(
        (segment) =>
          segment.end > source.text.length ||
          !boundary(source.text, segment.start) ||
          !boundary(source.text, segment.end),
      )
    )
      continue;
    results.push(parsed.data);
  }
  return results.length === 1 ? results[0] : null;
}
async function validateBinding(
  company: StudioCase,
  input: AnswerSuggestionInput,
  binding: AnswerSuggestionBinding,
): Promise<boolean> {
  if (
    binding.caseId !== company.id ||
    binding.companyRevision !== company.revision ||
    input.revision !== company.revision ||
    !equal(binding.target, input.target) ||
    binding.sources.length !== input.sourceSelections.length
  )
    return false;
  const target = input.target;
  let targetSha256: string;
  if (target.kind === "agency-request") {
    const records = company.agencyRecords.filter(
      (record) =>
        (record.kind === "request" || record.kind === "request-correction") &&
        record.requestRecordId === target.requestRecordId,
    );
    const record = records.at(-1);
    if (
      !record ||
      record.id !== target.requestVersionId ||
      records.filter((entry) => entry.id === record.id).length !== 1 ||
      record.body.slice(target.start, target.end) !== target.quote ||
      !answerRequestOccurrences(company, target).includes(target.start)
    )
      return false;
    targetSha256 = await sha(JSON.stringify(record));
  } else {
    const plans = company.plans.filter((plan) => plan.id === target.planId);
    if (
      plans.length !== 1 ||
      plans[0].version !== target.planVersion ||
      plans[0].content.interviewQuestions[target.questionIndex] !== target.questionText ||
      (await sha(target.questionText)) !== target.questionSha256
    )
      return false;
    targetSha256 = await sha(
      JSON.stringify({
        id: plans[0].id,
        version: plans[0].version,
        contentSha256: await sha(JSON.stringify(plans[0].content)),
        questionIndex: target.questionIndex,
        questionText: target.questionText,
      }),
    );
  }
  if (targetSha256 !== binding.targetSha256) return false;
  let total = 0;
  for (const [index, selection] of input.sourceSelections.entries()) {
    const sources = company.sources.filter((source) => source.id === selection.sourceId);
    if (sources.length !== 1) return false;
    const source = sources[0];
    total += source.text.length;
    if (
      source.extraction === "pending" ||
      !source.text.trim() ||
      source.updatedAt !== selection.sourceUpdatedAt ||
      (await sha(source.text)) !== selection.textSha256
    )
      return false;
    const locations = await sourceLocations(company, source);
    if (
      !equal(binding.sources[index], {
        ...selection,
        sourceName: source.name,
        characters: source.text.length,
        locationsSha256: locations ? await sha(JSON.stringify(locations)) : null,
      })
    )
      return false;
  }
  const { inputSha256, ...base } = binding;
  return total <= 60_000 && inputSha256 === (await sha(JSON.stringify(base)));
}
export async function validateAnswerSuggestions(
  value: unknown,
  company: StudioCase,
  input: AnswerSuggestionInput,
  mode: "assisted" | "ai",
  model: string | null = null,
): Promise<AnswerSuggestions | null> {
  const parsed = answerSuggestionsSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.mode !== mode ||
    parsed.data.model !== model ||
    !(await validateBinding(company, input, parsed.data.binding))
  )
    return null;
  const result = parsed.data;
  if (new Set(result.candidates.map((candidate) => candidate.id)).size !== result.candidates.length)
    return null;
  for (const candidate of result.candidates) {
    const source = company.sources.find((entry) => entry.id === candidate.sourceId);
    if (
      !source ||
      !input.sourceSelections.some((entry) => entry.sourceId === candidate.sourceId) ||
      source.name !== candidate.sourceName ||
      source.updatedAt !== candidate.sourceUpdatedAt ||
      (await sha(source.text)) !== candidate.textSha256 ||
      source.text.slice(candidate.start, candidate.end) !== candidate.quote ||
      !boundary(source.text, candidate.start) ||
      !boundary(source.text, candidate.end) ||
      candidate.lineStart !== source.text.slice(0, candidate.start).split("\n").length ||
      candidate.lineEnd !== source.text.slice(0, candidate.end).split("\n").length
    )
      return null;
    const selected = {
      sourceId: candidate.sourceId,
      start: candidate.start,
      end: candidate.end,
      quote: candidate.quote,
    };
    if (
      candidate.id !==
      (await sha(JSON.stringify({ input: result.binding.inputSha256, ...selected })))
    )
      return null;
    const locations = await sourceLocations(company, source);
    const matches =
      locations?.segments.filter(
        (segment) => segment.start <= candidate.start && segment.end >= candidate.end,
      ) ?? [];
    if (!equal(candidate.coordinate, matches.length === 1 ? matches[0].coordinate : null))
      return null;
    if (
      result.candidates.some(
        (other) =>
          other.id !== candidate.id &&
          other.sourceId === candidate.sourceId &&
          other.start < candidate.end &&
          other.end > candidate.start,
      )
    )
      return null;
  }
  return result;
}
export async function validateAnswerAiPreview(
  value: unknown,
  company: StudioCase,
  input: AnswerSuggestionInput,
  now = Date.now(),
): Promise<AnswerSuggestionAiPreview | null> {
  const parsed = answerSuggestionAiPreviewSchema.safeParse(value);
  if (!parsed.success) return null;
  const preview = parsed.data;
  if (
    Date.parse(preview.approval.expiresAt) <= now ||
    Date.parse(preview.approval.expiresAt) > now + answerSuggestionLimits.approvalMs + 1000 ||
    !(await validateBinding(company, input, preview.approval.binding))
  )
    return null;
  const expected = {
    targetText:
      input.target.kind === "agency-request" ? input.target.quote : input.target.questionText,
    sources: input.sourceSelections.map((selection) => {
      const source = company.sources.find((entry) => entry.id === selection.sourceId)!;
      return { sourceId: source.id, sourceName: source.name, text: source.text };
    }),
  };
  return equal(preview.transmission, expected) &&
    preview.approval.payloadSha256 === (await sha(JSON.stringify(expected)))
    ? preview
    : null;
}
export async function sendAnswerSuggestion(
  caseId: string,
  command: AnswerSuggestionCommand,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(`/api/studio/cases/${caseId}/answer-suggestions`, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const value: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      "제안을 확인하지 못했습니다. 기존 답변은 유지합니다. 외부 요청을 실행했다면 처리·비용이 발생했을 수 있으며 자동 재전송하지 않습니다.",
    );
  return value;
}
export async function sendApprovedAnswerSuggestion(
  company: StudioCase,
  input: AnswerSuggestionInput,
  preview: AnswerSuggestionAiPreview,
  isCurrent: () => boolean,
  fetcher: typeof fetch = fetch,
) {
  if (!isCurrent()) return null;
  const verified = await validateAnswerAiPreview(preview, company, input);
  if (!isCurrent()) return null;
  if (!verified || Date.parse(verified.approval.expiresAt) <= Date.now())
    throw new Error("전송 미리보기가 바뀌거나 만료되었습니다. 새로 확인해 주세요.");
  return sendAnswerSuggestion(
    company.id,
    { action: "run-ai", input, approval: verified.approval, approved: true },
    fetcher,
  );
}
export function answerSuggestionLocator(candidate: AnswerSuggestionCandidate) {
  return `등록 본문 ${candidate.lineStart}~${candidate.lineEnd}행 · 문자 ${candidate.start}~${candidate.end}`;
}
export function applyResponseAnswerSuggestions(
  item: ResponsePreparationItem,
  target: AnswerSuggestionTarget,
  candidates: AnswerSuggestionCandidate[],
  replace: boolean,
): { value?: ResponsePreparationItem; error?: string } {
  if (target.kind !== "agency-request" || item.requestQuote !== target.quote || !candidates.length)
    return { error: "현재 요청 인용과 선택한 후보를 다시 확인해 주세요." };
  if (new Set(candidates.map((candidate) => candidate.sourceId)).size !== candidates.length)
    return { error: "답변 준비 항목은 같은 자료의 인용을 하나만 선택해 주세요." };
  if ((item.draft || item.evidence.length) && !replace)
    return { error: "기존 초안과 해당 자료 인용을 바꾸는 데 먼저 동의해 주세요." };
  const evidence = [
    ...item.evidence.filter(
      (ref) => !candidates.some((candidate) => candidate.sourceId === ref.sourceId),
    ),
    ...candidates.map((candidate) => ({
      sourceId: candidate.sourceId,
      sourceUpdatedAt: candidate.sourceUpdatedAt,
      quote: candidate.quote,
      locator: answerSuggestionLocator(candidate),
    })),
  ];
  const draft = answerSuggestionDraft(target, candidates);
  if (evidence.length > 6 || draft.length > 20_000)
    return {
      error:
        "항목당 근거 6개·초안 20,000자 한도를 넘습니다. 선택을 줄여 주세요. 기존 내용은 유지합니다.",
    };
  return { value: { ...item, evidence, draft } };
}
export function applyVisitAnswerSuggestions(
  input: VisitAnswerInput,
  target: AnswerSuggestionTarget,
  candidates: AnswerSuggestionCandidate[],
  replace: boolean,
): { value?: VisitAnswerInput; error?: string } {
  if (
    target.kind !== "visit-question" ||
    input.planId !== target.planId ||
    input.questionIndex !== target.questionIndex ||
    input.questionText !== target.questionText ||
    !candidates.length
  )
    return { error: "현재 원고·질문과 후보를 다시 확인해 주세요." };
  if ((input.answerText || input.pairs.length) && !replace)
    return { error: "기존 답변과 인용 대조를 바꾸는 데 먼저 동의해 주세요." };
  const answerText = answerSuggestionDraft(target, candidates);
  const unique = candidates.filter(
    (candidate, index) =>
      candidates.findIndex(
        (other) => other.sourceId === candidate.sourceId && other.quote === candidate.quote,
      ) === index,
  );
  if (answerText.length > 10_000 || unique.length > 10)
    return {
      error:
        "모의 답변 10,000자·인용 대조 10개 한도를 넘습니다. 선택을 줄여 주세요. 자동으로 자르지 않습니다.",
    };
  const pairs = unique.map((candidate) => ({
    id: crypto.randomUUID(),
    answerQuote: candidate.quote,
    planReference: null,
    sources: [
      {
        sourceId: candidate.sourceId,
        sourceUpdatedAt: candidate.sourceUpdatedAt,
        quote: candidate.quote,
        locator: answerSuggestionLocator(candidate),
      },
    ],
    contextNote: "제안에서 선택한 등록 본문 인용 · 기간·단위·대상 직접 확인 필요",
  }));
  return {
    value: { ...input, answerText, pairs, review: { reviewed: false, reviewer: "", note: "" } },
  };
}
