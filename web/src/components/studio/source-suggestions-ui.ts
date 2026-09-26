import {
  caseSchema,
  companyProfileSchema,
  sourceKinds,
  type StudioCase,
} from "@/lib/studio-schema";
import { sourceIntakeResultText } from "@/lib/studio-source-intake-types";
import { sourceLocationMetadataSchema } from "@/lib/studio-source-location-types";
import {
  sourceSuggestionAdoptionInputSchema,
  sourceSuggestionReceiptSchema,
  sourceSuggestionsPreviewSchema,
  sourceSuggestionTargets,
  type SourceSuggestionAdoptionInput,
  type SourceSuggestionPreviewInput,
  type SourceSuggestionTarget,
  type SourceSuggestionsPreview,
} from "@/lib/studio-source-suggestion-types";

export type SuggestionChoices = Partial<Record<SourceSuggestionTarget, string>>;
export type SuggestionPending = {
  companyId: string;
  revision: number;
  clientRequestId: string;
  input: SourceSuggestionAdoptionInput;
  preview: SourceSuggestionsPreview;
};
export function suggestionRequestCanClose(
  company: StudioCase,
  pending: SuggestionPending,
  checked: boolean,
  rejected = false,
) {
  return (
    checked &&
    company.id === pending.companyId &&
    company.revision >= pending.revision &&
    (rejected || company.revision > pending.revision) &&
    !company.sourceSuggestionAdoptions.some(
      (receipt) => receipt.clientRequestId === pending.clientRequestId,
    )
  );
}
export class SourceSuggestionHttpError extends Error {
  constructor(
    readonly rejected: boolean,
    readonly code: string,
  ) {
    super(
      rejected
        ? "선택값 채택 요청이 거절되었습니다. 저장된 기록을 먼저 확인해 주세요."
        : "채택 요청 결과를 확인하지 못했습니다. 저장된 기록을 먼저 확인해 주세요.",
    );
  }
}
export async function sendSourceSuggestionAdoption(pending: SuggestionPending): Promise<unknown> {
  const response = await fetch(`/api/studio/cases/${pending.companyId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({
      action: "adopt-source-suggestions",
      revision: pending.revision,
      clientRequestId: pending.clientRequestId,
      ...pending.input,
    }),
  });
  const raw: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const code =
      typeof body.code === "string" && /^[A-Z0-9_]{1,100}$/.test(body.code)
        ? body.code
        : "SUGGESTION_RESPONSE_FAILED";
    throw new SourceSuggestionHttpError(
      [400, 403, 404, 409, 413, 415, 422].includes(response.status),
      code,
    );
  }
  return raw;
}
export function suggestionBasisOptions(company: StudioCase, sourceId: string) {
  const sources = company.sources.filter((source) => source.id === sourceId);
  if (sources.length !== 1) return [];
  const source = sources[0];
  const options: Array<{
    key: string;
    label: string;
    basis: SourceSuggestionPreviewInput["basis"];
  }> = [];
  if (source.extraction !== "pending" && source.text.trim())
    options.push({
      key: "source-text",
      label: "현재 등록 본문 · 담당자 입력 포함",
      basis: { kind: "source-text", sourceUpdatedAt: source.updatedAt },
    });
  for (const item of company.sourceIntakes) {
    if (
      item.sourceId !== sourceId ||
      item.phase !== "awaiting_review" ||
      item.adoption ||
      source.extraction !== "pending" ||
      source.text ||
      !item.result?.content ||
      item.result.discardedAt ||
      item.result.sourceUpdatedAt !== source.updatedAt ||
      item.original?.sha256 !== item.result.originalSha256
    )
      continue;
    options.push({
      key: item.result.id,
      label: `보관 판독 결과 · ${item.result.engine === "windows-ko" ? "Windows OCR" : "로컬 문서"} · ${item.result.generatedAt}`,
      basis: { kind: "intake-result", itemId: item.id, resultId: item.result.id },
    });
  }
  return options;
}
export function suggestionCurrentValue(
  company: StudioCase,
  sourceId: string,
  target: SourceSuggestionTarget,
): string | null {
  if (target !== "sourceKind") return company.profile[target];
  const matches = company.sources.filter((source) => source.id === sourceId);
  return matches.length === 1 ? matches[0].kind : null;
}
export function suggestionBasisText(
  company: StudioCase,
  request: SourceSuggestionPreviewInput,
): string | null {
  const matches = company.sources.filter((source) => source.id === request.sourceId);
  if (matches.length !== 1 || request.revision !== company.revision) return null;
  const source = matches[0];
  if (request.basis.kind === "source-text")
    return source.updatedAt === request.basis.sourceUpdatedAt &&
      source.extraction !== "pending" &&
      source.text.trim()
      ? source.text
      : null;
  const basis = request.basis;
  const items = company.sourceIntakes.filter(
    (item) => item.id === basis.itemId && item.sourceId === source.id,
  );
  const result = items.length === 1 ? items[0].result : null;
  return items[0]?.phase === "awaiting_review" &&
    !items[0].adoption &&
    source.extraction === "pending" &&
    source.text === "" &&
    result?.sourceUpdatedAt === source.updatedAt &&
    items[0].original?.sha256 === result.originalSha256 &&
    result.id === basis.resultId &&
    result.content &&
    !result.discardedAt
    ? sourceIntakeResultText(result.content)
    : null;
}
export async function suggestionTextHash(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function exactPosition(
  text: string,
  position: { start: number; end: number; quote: string; lineStart: number; lineEnd: number },
) {
  return (
    text.slice(position.start, position.end) === position.quote &&
    position.end <= text.length &&
    position.lineStart === text.slice(0, position.start).split("\n").length &&
    position.lineEnd === text.slice(0, position.end).split("\n").length
  );
}
export async function validateSourceSuggestions(
  raw: unknown,
  company: StudioCase,
  request: SourceSuggestionPreviewInput,
): Promise<SourceSuggestionsPreview | null> {
  const parsed = sourceSuggestionsPreviewSchema.safeParse(raw),
    text = suggestionBasisText(company, request);
  if (!parsed.success || text === null) return null;
  const preview = parsed.data,
    source = company.sources.find((entry) => entry.id === request.sourceId)!;
  if (
    preview.companyRevision !== company.revision ||
    preview.binding.sourceId !== source.id ||
    preview.binding.sourceUpdatedAt !== source.updatedAt ||
    JSON.stringify(preview.binding.basis) !== JSON.stringify(request.basis) ||
    preview.ruleVersion !== preview.binding.ruleVersion ||
    (preview.identity.status === "mismatch" && preview.profileAllowed) ||
    new Set(preview.candidates.map((entry) => entry.id)).size !== preview.candidates.length ||
    preview.candidates.some(
      (entry) =>
        !exactPosition(text, entry) ||
        entry.currentValue !== suggestionCurrentValue(company, source.id, entry.target),
    ) ||
    preview.unresolved.some((entry) => !exactPosition(text, entry))
  )
    return null;
  if (
    preview.binding.original &&
    (preview.binding.original.sourceId !== source.id ||
      preview.binding.original.originalName !== source.originalName ||
      preview.binding.original.mimeType !== source.mimeType)
  )
    return null;
  if (preview.binding.textSha256 !== (await suggestionTextHash(text))) return null;
  const positions = [...preview.candidates, ...preview.unresolved];
  if (request.basis.kind === "source-text") {
    if (
      preview.binding.locationsSha256 !== null ||
      positions.some((entry) => entry.coordinate !== null)
    )
      return null;
  } else {
    const basis = request.basis;
    const result = company.sourceIntakes.find((item) => item.id === basis.itemId)?.result;
    if (result?.locations) {
      const locations = sourceLocationMetadataSchema.safeParse(result.locations);
      if (
        !locations.success ||
        locations.data.textSha256 !== preview.binding.textSha256 ||
        preview.binding.locationsSha256 !==
          (await suggestionTextHash(JSON.stringify(locations.data)))
      )
        return null;
      for (const entry of positions) {
        const segments = locations.data.segments.filter(
          (segment) => segment.start <= entry.start && segment.end >= entry.end,
        );
        const coordinate = segments.length === 1 ? segments[0].coordinate : null;
        if (JSON.stringify(entry.coordinate) !== JSON.stringify(coordinate)) return null;
      }
    } else if (
      preview.binding.locationsSha256 !== null ||
      positions.some((entry) => entry.coordinate !== null)
    )
      return null;
  }
  return preview;
}
export function selectedSuggestionInput(
  company: StudioCase,
  preview: SourceSuggestionsPreview,
  choices: SuggestionChoices,
  reviewed: boolean,
): SourceSuggestionAdoptionInput | null {
  if (!reviewed || preview.companyRevision !== company.revision) return null;
  const selections: SourceSuggestionAdoptionInput["selections"] = [];
  const profileValues: Record<string, string> = {};
  for (const target of sourceSuggestionTargets) {
    const candidateId = choices[target];
    if (!candidateId) continue;
    if (preview.blockedTargets.some((entry) => entry.target === target)) return null;
    const matches = preview.candidates.filter(
      (candidate) => candidate.id === candidateId && candidate.target === target,
    );
    if (matches.length !== 1 || (target !== "sourceKind" && !preview.profileAllowed)) return null;
    const candidate = matches[0],
      current = suggestionCurrentValue(company, preview.binding.sourceId, target);
    if (current === null || current !== candidate.currentValue) return null;
    if (target === "sourceKind") {
      if (!(sourceKinds as readonly string[]).includes(candidate.value)) return null;
    } else profileValues[target] = candidate.value;
    selections.push({ candidateId, target, expectedCurrentValue: current });
  }
  if (!companyProfileSchema.safeParse({ ...company.profile, ...profileValues }).success)
    return null;
  const parsed = sourceSuggestionAdoptionInputSchema.safeParse({
    binding: preview.binding,
    selections,
    reviewed: true,
  });
  return parsed.success ? parsed.data : null;
}
export function suggestionAdoptionAcknowledged(
  raw: unknown,
  pending: SuggestionPending,
  minimumRevision = pending.revision,
): StudioCase | null {
  const parsed = caseSchema.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.id !== pending.companyId ||
    parsed.data.revision < minimumRevision
  )
    return null;
  const matches = parsed.data.sourceSuggestionAdoptions.filter(
    (receipt) => receipt.clientRequestId === pending.clientRequestId,
  );
  if (matches.length !== 1) return null;
  const parsedReceipt = sourceSuggestionReceiptSchema.safeParse(matches[0]);
  if (!parsedReceipt.success) return null;
  const receipt = parsedReceipt.data;
  if (
    JSON.stringify(receipt.binding) !== JSON.stringify(pending.input.binding) ||
    JSON.stringify(receipt.identity) !== JSON.stringify(pending.preview.identity) ||
    receipt.selections.length !== pending.input.selections.length
  )
    return null;
  for (const selected of pending.input.selections) {
    const records = receipt.selections.filter(
      (entry) => entry.candidateId === selected.candidateId && entry.target === selected.target,
    );
    const candidates = pending.preview.candidates.filter(
      (entry) => entry.id === selected.candidateId && entry.target === selected.target,
    );
    if (records.length !== 1 || candidates.length !== 1) return null;
    const record = records[0],
      candidate = candidates[0];
    if (
      record.previousValue !== selected.expectedCurrentValue ||
      record.value !== candidate.value ||
      record.quote !== candidate.quote ||
      record.start !== candidate.start ||
      record.end !== candidate.end ||
      record.lineStart !== candidate.lineStart ||
      record.lineEnd !== candidate.lineEnd ||
      JSON.stringify(record.coordinate) !== JSON.stringify(candidate.coordinate)
    )
      return null;
  }
  return parsed.data;
}
