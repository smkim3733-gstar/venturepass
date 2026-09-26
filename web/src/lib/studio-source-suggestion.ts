import { createHash } from "node:crypto";
import { StudioError } from "./studio-http";
import {
  companyProfileSchema,
  sourceKinds,
  type SourceDocument,
  type StudioCase,
} from "./studio-schema";
import { sourceIntakeResultText } from "./studio-source-intake-types";
import {
  sourceLocationMetadataSchema,
  type SourceCoordinate,
  type SourceLocationMetadata,
} from "./studio-source-location-types";
import { validateSourceLocationMetadata } from "./studio-source-location";
import { originalConflicts } from "./studio-evidence-history";
import {
  sourceSuggestionAdoptionInputSchema,
  sourceSuggestionLimits,
  sourceSuggestionPreviewInputSchema,
  sourceSuggestionRuleVersion,
  sourceSuggestionsPreviewSchema,
  sourceSuggestionReceiptSchema,
  type SourceSuggestionAdoptionInput,
  type SourceSuggestionBinding,
  type SourceSuggestionCandidate,
  type SourceSuggestionPreviewInput,
  type SourceSuggestionReceipt,
  type SourceSuggestionsPreview,
  type SourceSuggestionTarget,
} from "./studio-source-suggestion-types";
import type { StudioStore } from "./studio-storage";

type OriginalReader = (sourceId: string) => {
  source: SourceDocument;
  buffer: Buffer;
  sha256: string;
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function sourceSuggestionError(code: string, status = 409): never {
  const messages: Record<string, string> = {
    SUGGESTION_STALE: "자료·판독 결과 또는 현재 값이 변경되었습니다. 제안을 다시 확인해 주세요.",
    SUGGESTION_SOURCE_UNAVAILABLE:
      "명시적으로 선택한 자료 본문 또는 미검토 판독 결과를 확인해 주세요.",
    SUGGESTION_COMPANY_MISMATCH:
      "자료의 사업자등록번호가 현재 기업과 다릅니다. 기업정보는 채택하지 않았습니다.",
    SUGGESTION_SELECTION_INVALID: "현재 제안에서 항목별로 하나씩 선택해 주세요.",
    SUGGESTION_NONCE_CONFLICT: "같은 요청 식별자에 다른 채택 내용이 사용되었습니다.",
    SUGGESTION_LIMIT: "제안 채택 이력의 보관 한도에 도달했습니다. 기존 이력을 보존합니다.",
    SUGGESTION_ORIGINAL_CHANGED: "현재 원본이 보관된 근거와 다릅니다. 제안을 채택하지 않았습니다.",
  };
  throw new StudioError(messages[code] ?? "자료 제안의 근거를 다시 확인해 주세요.", status, code);
}
export function sourceSuggestionInputDigest(input: SourceSuggestionAdoptionInput) {
  return hash(JSON.stringify(sourceSuggestionAdoptionInputSchema.parse(input)));
}
export function isSourceSuggestionReplay(
  records: SourceSuggestionReceipt[],
  nonce: string,
  digest: string,
) {
  const matches = records.filter((entry) => entry.clientRequestId === nonce);
  if (matches.length > 1 || (matches.length === 1 && matches[0].inputDigest !== digest))
    sourceSuggestionError("SUGGESTION_NONCE_CONFLICT");
  return matches.length === 1;
}
export function assertSourceSuggestionCapacity(records: SourceSuggestionReceipt[]) {
  if (
    records.length > sourceSuggestionLimits.receipts ||
    JSON.stringify(records).length > sourceSuggestionLimits.characters
  )
    sourceSuggestionError("SUGGESTION_LIMIT", 413);
}
function sourceFor(company: StudioCase, sourceId: string) {
  const sources = company.sources.filter((source) => source.id === sourceId);
  if (sources.length !== 1) sourceSuggestionError("SUGGESTION_SOURCE_UNAVAILABLE", 404);
  return sources[0];
}
function originalBinding(
  company: StudioCase,
  source: SourceDocument,
  readOriginal: OriginalReader,
): SourceSuggestionBinding["original"] {
  if (!source.originalName) return null;
  const current = readOriginal(source.id);
  if (JSON.stringify(current.source) !== JSON.stringify(source))
    sourceSuggestionError("SUGGESTION_STALE");
  const original = {
    sourceId: source.id,
    sha256: current.sha256,
    sizeBytes: current.buffer.length,
    originalName: source.originalName,
    mimeType: source.mimeType,
  };
  if (originalConflicts(company, original)) sourceSuggestionError("SUGGESTION_ORIGINAL_CHANGED");
  return original;
}
function selectedText(company: StudioCase, input: SourceSuggestionPreviewInput) {
  const source = sourceFor(company, input.sourceId);
  let text: string,
    locations: SourceLocationMetadata | null = null;
  if (input.basis.kind === "source-text") {
    if (
      source.extraction === "pending" ||
      source.updatedAt !== input.basis.sourceUpdatedAt ||
      !source.text.trim()
    )
      sourceSuggestionError("SUGGESTION_SOURCE_UNAVAILABLE");
    text = source.text;
  } else {
    const basis = input.basis;
    const matches = company.sourceIntakes.filter(
      (item) => item.id === basis.itemId && item.sourceId === source.id,
    );
    const item = matches.length === 1 ? matches[0] : null,
      result = item?.result;
    if (
      !item ||
      item.phase !== "awaiting_review" ||
      item.adoption ||
      !result?.content ||
      result.id !== basis.resultId ||
      source.extraction !== "pending" ||
      source.text ||
      result.sourceUpdatedAt !== source.updatedAt ||
      result.originalSha256 !== item.original?.sha256
    )
      sourceSuggestionError("SUGGESTION_SOURCE_UNAVAILABLE");
    text = sourceIntakeResultText(result.content);
    if (hash(text) !== result.textSha256) sourceSuggestionError("SUGGESTION_STALE");
    if (result.locations !== undefined) {
      if (!validateSourceLocationMetadata(text, result.locations))
        sourceSuggestionError("SUGGESTION_STALE");
      locations = sourceLocationMetadataSchema.parse(result.locations);
    }
  }
  if (!text.trim() || text.length > 100000) sourceSuggestionError("SUGGESTION_SOURCE_UNAVAILABLE");
  return { source, text, locations };
}
export function sourceSuggestionCurrentValue(
  company: StudioCase,
  sourceId: string,
  target: SourceSuggestionTarget,
) {
  return target === "sourceKind" ? sourceFor(company, sourceId).kind : company.profile[target];
}
function coordinateAt(
  locations: SourceLocationMetadata | null,
  start: number,
  end: number,
): SourceCoordinate | null {
  const segments = locations?.segments ?? [];
  let low = 0,
    high = segments.length - 1,
    found = -1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (segments[middle].start <= start) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found >= 0 && segments[found].end >= end ? segments[found].coordinate : null;
}
const cleanBusinessNumber = (value: string) => {
  const normalized = value.replace(/-/g, "");
  return /^\d{10}$/.test(normalized) ? normalized : null;
};
function exactDate(value: string): string | null {
  const match =
    /^(\d{4})(?:-(\d{2})-(\d{2})|\.(\d{1,2})\.(\d{1,2})\.?|년\s*(\d{1,2})월\s*(\d{1,2})일)$/.exec(
      value,
    );
  if (!match) return null;
  const result = `${match[1]}-${(match[2] ?? match[4] ?? match[6]).padStart(2, "0")}-${(match[3] ?? match[5] ?? match[7]).padStart(2, "0")}`;
  const date = new Date(`${result}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === result &&
    +match[1] >= 1900 &&
    +match[1] <= 2200
    ? result
    : null;
}
/** Rules recognize explicit labels, never filename clues or semantic facts. */
export function buildSourceSuggestions(
  company: StudioCase,
  rawInput: SourceSuggestionPreviewInput,
  readOriginal: OriginalReader,
): SourceSuggestionsPreview {
  const input = sourceSuggestionPreviewInputSchema.parse(rawInput);
  if (company.revision !== input.revision) sourceSuggestionError("SUGGESTION_STALE");
  const { source, text, locations } = selectedText(company, input);
  const original = originalBinding(company, source, readOriginal);
  const binding: SourceSuggestionBinding = {
    ruleVersion: sourceSuggestionRuleVersion,
    sourceId: source.id,
    sourceUpdatedAt: source.updatedAt,
    basis: input.basis,
    textSha256: hash(text),
    locationsSha256: locations ? hash(JSON.stringify(locations)) : null,
    original,
  };
  const candidates: SourceSuggestionCandidate[] = [],
    unresolved: SourceSuggestionsPreview["unresolved"] = [];
  const numberValues = new Set<string>();
  const units: Array<{ rawLine: string; offset: number }> = [];
  const addLines = (fragment: string, base: number) => {
    let offset = base;
    for (const rawLine of fragment.split("\n")) {
      units.push({ rawLine, offset });
      offset += rawLine.length + 1;
    }
  };
  addLines(text, 0);
  const lineStarts = units.map((unit) => unit.offset);
  for (const segment of locations?.segments ?? [])
    if (segment.coordinate.kind === "spreadsheet-cell")
      addLines(text.slice(segment.start, segment.end), segment.start);
  const lineAt = (offset: number) => {
    let low = 0,
      high = lineStarts.length - 1,
      found = 0;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      if (lineStarts[middle] <= offset) {
        found = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    return found + 1;
  };
  const titles: Array<[RegExp, string]> = [
    [
      /^(?:사업자등록증|사업자등록증명|법인등기사항전부증명서|등기사항전부증명서)(?:\s*\([^\r\n]{1,50}\))?$/,
      "other",
    ],
    [/^(?:표준재무제표증명|재무상태표|손익계산서|재무제표)$/, "finance"],
    [/^(?:특허증|특허명세서|특허 명세서)$/, "patent"],
    [/^(?:기술개발계획서|기술개발 계획서|기술 설명서|연구개발계획서)$/, "technology"],
    [/^(?:시장조사보고서|시장조사 보고서)$/, "market"],
  ];
  for (const { rawLine, offset } of units) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const leading = line.length - line.trimStart().length,
      quote = line.trim();
    const start = offset + leading,
      end = start + quote.length;
    const position = {
      quote,
      start,
      end,
      lineStart: lineAt(start),
      lineEnd: lineAt(end),
      coordinate: coordinateAt(locations, start, end),
    };
    if (!quote || quote.length > 1000) continue;
    const unresolvedAt = (code: string, message: string) => {
      if (
        unresolved.length < sourceSuggestionLimits.candidates &&
        !unresolved.some(
          (entry) => entry.code === code && entry.start === start && entry.end === end,
        )
      )
        unresolved.push({ code, message, ...position });
    };
    const add = (target: SourceSuggestionTarget, value: string) => {
      if (!value || value.length > 100) {
        unresolvedAt("INVALID_VALUE", "기존 기업정보 필드에 그대로 넣을 수 없는 값입니다.");
        return;
      }
      if (candidates.length >= sourceSuggestionLimits.candidates) {
        unresolvedAt("CANDIDATE_LIMIT", "제안 한도 이후의 표기는 별도로 확인해 주세요.");
        return;
      }
      const id = hash(JSON.stringify({ binding, target, value, start, end }));
      if (candidates.some((candidate) => candidate.id === id)) return;
      candidates.push({
        id,
        target,
        value,
        currentValue: sourceSuggestionCurrentValue(company, source.id, target),
        ...position,
      });
    };
    const title = titles.find(([pattern]) => pattern.test(quote));
    if (title) add("sourceKind", title[1]);
    const match =
      /^(상호\s*\(법인명\)|법인명|회사명|상호|사업자등록번호|사업자 번호|법인설립일|설립일|회사성립연월일|개업연월일|개업일|설립\/개업일|업종|주업종|납입자본금(?:\s*\(원\))?|자본금(?:\s*\(원\))?|자본총계|매출액|결산월)(?:\s*[:：]\s*|\s+)(.+)$/.exec(
        quote,
      );
    if (!match) continue;
    const label = match[1],
      value = match[2].trim();
    if (/^상호\s*\(법인명\)$/.test(label) || ["법인명", "회사명", "상호"].includes(label))
      add("companyName", value);
    else if (["사업자등록번호", "사업자 번호"].includes(label)) {
      const identityNumber = /^(?:\d{3}-\d{2}-\d{5}|\d{10})(?![\d-])/.exec(value);
      if (identityNumber) numberValues.add(identityNumber[0].replace(/-/g, ""));
      const number = /^(?:\d{3}-\d{2}-\d{5}|\d{10})$/.test(value)
        ? cleanBusinessNumber(value)
        : null;
      if (number) {
        numberValues.add(number);
        add("businessNumber", number);
      } else
        unresolvedAt(
          "INVALID_BUSINESS_NUMBER",
          "사업자등록번호의 정확한 10자리 표기를 확인해 주세요.",
        );
    } else if (["법인설립일", "설립일", "회사성립연월일"].includes(label)) {
      const date = exactDate(value);
      if (date) add("foundedOn", date);
      else unresolvedAt("AMBIGUOUS_DATE", "설립일 표기의 날짜 형식을 원본에서 확인해 주세요.");
    } else if (["개업연월일", "개업일", "설립/개업일"].includes(label))
      unresolvedAt(
        "AMBIGUOUS_DATE",
        "개업일이나 혼합 표기를 법인 설립일로 바꾸지 않습니다. 별도 확인이 필요합니다.",
      );
    else if (["업종", "주업종"].includes(label)) {
      if (/^\d[\d\s.,/-]*$/.test(value) || /KSIC|업종코드|분류코드/i.test(value))
        unresolvedAt(
          "AMBIGUOUS_INDUSTRY",
          "업종 코드를 다른 분류체계로 변환하지 않습니다. 원문 업종을 확인해 주세요.",
        );
      else add("industry", value);
    } else if (label.startsWith("납입자본금") || label.startsWith("자본금")) {
      const amount =
        /^(0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)\s*원$/.exec(value) ??
        (/\(원\)$/.test(label) ? /^(0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.exec(value) : null);
      const canonical = amount?.[1].replace(/,/g, "");
      if (
        canonical &&
        Number.isSafeInteger(Number(canonical)) &&
        String(Number(canonical)) === canonical &&
        canonical.length <= 16
      )
        add("paidInCapital", canonical);
      else
        unresolvedAt(
          "AMBIGUOUS_CAPITAL",
          "원 단위의 명시 자본금만 제안합니다. 금액·단위·자본금 여부를 확인해 주세요.",
        );
    } else if (["자본총계", "매출액"].includes(label))
      unresolvedAt("NOT_PAID_IN_CAPITAL", "자본총계나 매출액을 납입자본금으로 옮기지 않습니다.");
    else if (label === "결산월") {
      const month = /^(0?[1-9]|1[0-2])월$/.exec(value);
      if (month) add("closingMonth", String(Number(month[1])));
      else unresolvedAt("INVALID_CLOSING_MONTH", "명시된 결산월(1~12월)을 원본에서 확인해 주세요.");
    }
  }
  const currentNumber = cleanBusinessNumber(company.profile.businessNumber);
  const mismatch =
    currentNumber !== null && [...numberValues].some((number) => number !== currentNumber);
  const matched =
    currentNumber !== null && numberValues.size === 1 && numberValues.has(currentNumber);
  const identity: SourceSuggestionsPreview["identity"] = mismatch
    ? {
        status: "mismatch",
        reason:
          "명시 사업자등록번호가 현재 기업과 다릅니다. 자료 종류 외 기업정보는 채택할 수 없습니다.",
      }
    : matched
      ? {
          status: "matched",
          reason:
            "명시 사업자등록번호의 숫자 표기가 현재 기업과 일치합니다. 문서 진위·최신성을 확인한 것은 아닙니다.",
        }
      : {
          status: "unverified",
          reason:
            "사업자등록번호로 회사 일치를 확인하지 못했습니다. 원본과 해당 기업을 직접 대조해 주세요.",
        };
  if (JSON.stringify(originalBinding(company, source, readOriginal)) !== JSON.stringify(original))
    sourceSuggestionError("SUGGESTION_ORIGINAL_CHANGED");
  return sourceSuggestionsPreviewSchema.parse({
    companyRevision: company.revision,
    ruleVersion: sourceSuggestionRuleVersion,
    binding,
    identity,
    profileAllowed: !mismatch,
    blockedTargets:
      input.basis.kind === "intake-result"
        ? [
            {
              target: "sourceKind",
              code: "SUGGESTION_KIND_REQUIRES_BODY",
              reason:
                "먼저 판독문을 검토하여 본문으로 채택한 뒤 자료 종류를 선택해 주세요. 미검토 결과의 자료 종류는 지금 채택하지 않습니다.",
            },
          ]
        : [],
    candidates,
    unresolved,
  });
}
export function previewSourceSuggestions(
  store: Pick<StudioStore, "get" | "originalForVentureInput">,
  caseId: string,
  input: SourceSuggestionPreviewInput,
) {
  const company = store.get(caseId);
  const preview = buildSourceSuggestions(company, input, (sourceId) =>
    store.originalForVentureInput(caseId, sourceId),
  );
  const latest = store.get(caseId);
  if (latest.revision !== company.revision || JSON.stringify(latest) !== JSON.stringify(company))
    sourceSuggestionError("SUGGESTION_STALE");
  return preview;
}
export function buildSourceSuggestionAdoption(
  company: StudioCase,
  rawInput: SourceSuggestionAdoptionInput,
  metadata: { id: string; clientRequestId: string; inputDigest: string; recordedAt: string },
  readOriginal: OriginalReader,
) {
  const input = sourceSuggestionAdoptionInputSchema.parse(rawInput);
  const preview = buildSourceSuggestions(
    company,
    { revision: company.revision, sourceId: input.binding.sourceId, basis: input.binding.basis },
    readOriginal,
  );
  if (JSON.stringify(input.binding) !== JSON.stringify(preview.binding))
    sourceSuggestionError("SUGGESTION_STALE");
  if (
    !preview.profileAllowed &&
    input.selections.some((selection) => selection.target !== "sourceKind")
  )
    sourceSuggestionError("SUGGESTION_COMPANY_MISMATCH");
  if (
    input.selections.some((selection) =>
      preview.blockedTargets.some((blocked) => blocked.target === selection.target),
    )
  )
    throw new StudioError(
      "먼저 판독문 본문을 검토·채택한 뒤 자료 종류를 선택해 주세요.",
      409,
      "SUGGESTION_KIND_REQUIRES_BODY",
    );
  const source = sourceFor(company, input.binding.sourceId);
  let profile = { ...company.profile },
    sourceKind = source.kind;
  const selections: SourceSuggestionReceipt["selections"] = [];
  for (const selected of input.selections) {
    const matches = preview.candidates.filter(
      (candidate) => candidate.id === selected.candidateId && candidate.target === selected.target,
    );
    if (matches.length !== 1) sourceSuggestionError("SUGGESTION_SELECTION_INVALID");
    const candidate = matches[0];
    if (candidate.currentValue !== selected.expectedCurrentValue)
      sourceSuggestionError("SUGGESTION_STALE");
    if (candidate.target === "sourceKind") {
      if (!(sourceKinds as readonly string[]).includes(candidate.value))
        sourceSuggestionError("SUGGESTION_SELECTION_INVALID");
      sourceKind = candidate.value as typeof sourceKind;
    } else profile = { ...profile, [candidate.target]: candidate.value };
    const { id, currentValue, ...rest } = candidate;
    selections.push({ candidateId: id, previousValue: currentValue, ...rest });
  }
  profile = companyProfileSchema.parse(profile);
  const receipt = sourceSuggestionReceiptSchema.parse({
    ...metadata,
    version: company.sourceSuggestionAdoptions.length + 1,
    origin: "manual-local-suggestion",
    binding: input.binding,
    identity: preview.identity,
    selections,
    reviewed: true,
    profileChanged: JSON.stringify(profile) !== JSON.stringify(company.profile),
    sourceKindChanged: sourceKind !== source.kind,
    sourceUpdatedAtAfter: source.updatedAt,
  });
  assertSourceSuggestionCapacity([...company.sourceSuggestionAdoptions, receipt]);
  return { receipt, profile, sourceKind };
}
