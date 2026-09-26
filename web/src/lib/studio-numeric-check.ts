// Node-side immutable capture. Decimal arithmetic itself is pure and has no external calls.
import { createHash } from "node:crypto";
import { StudioError } from "./studio-http";
import { originalConflicts, planConflicts } from "./studio-evidence-history";
import type { SourceDocument, StudioCase } from "./studio-schema";
import {
  evaluateNumericCheck,
  numericCheckLimits,
  numericCheckSchema,
  numericLiteralOccurs,
  type NumericCheck,
  type NumericCheckInput,
} from "./studio-numeric-check-types";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const numericCheckInputDigest = (input: NumericCheckInput) => hash(JSON.stringify(input));
function fail(message: string, code: string, status = 409): never {
  throw new StudioError(message, status, code);
}
export function assertNumericCheckCapacity(records: NumericCheck[]) {
  const count = (value: unknown): number =>
    typeof value === "string"
      ? value.length
      : Array.isArray(value)
        ? value.reduce((sum, item) => sum + count(item), 0)
        : value && typeof value === "object"
          ? Object.values(value).reduce<number>((sum, item) => sum + count(item), 0)
          : 0;
  if (
    records.length > numericCheckLimits.versions ||
    count(records) > numericCheckLimits.characters
  )
    fail(
      "수치 대조 이력의 보관 한도에 도달했습니다. 기존 기록을 보존하며 새 버전은 저장하지 않았습니다.",
      "NUMERIC_CHECK_LIMIT",
    );
}
export function isNumericCheckReplay(
  records: NumericCheck[],
  clientRequestId: string,
  inputDigest: string,
) {
  const matches = records.filter((record) => record.clientRequestId === clientRequestId);
  if (!matches.length) return false;
  if (matches.length !== 1 || matches[0].inputDigest !== inputDigest)
    fail(
      "같은 저장 요청의 수치 대조 내용이 다릅니다. 최신 내용을 확인해 주세요.",
      "NUMERIC_CHECK_REQUEST_CONFLICT",
    );
  return true;
}
type NumericCompany = StudioCase & { numericChecks: NumericCheck[] };
type OriginalReader = (sourceId: string) => {
  source: SourceDocument;
  buffer: Buffer;
  sha256: string;
};
type Generated = Pick<NumericCheck, "id" | "clientRequestId" | "inputDigest" | "recordedAt">;

export function buildNumericCheck(
  company: NumericCompany,
  input: NumericCheckInput,
  generated: Generated,
  readOriginal: OriginalReader,
): NumericCheck {
  if (company.numericChecks.length >= numericCheckLimits.versions)
    fail("수치 대조 이력의 보관 한도에 도달했습니다.", "NUMERIC_CHECK_LIMIT");
  let previous: NumericCheck | undefined;
  if (input.checkId) {
    const roots = company.numericChecks.filter(
      (record) => record.id === input.checkId && record.previousVersionId === null,
    );
    if (roots.length !== 1)
      fail("이 기업의 수치 대조 이력을 찾을 수 없습니다.", "NUMERIC_CHECK_NOT_FOUND", 404);
    previous = company.numericChecks.filter((record) => record.checkId === roots[0].id).at(-1)!;
    if (previous.id !== input.previousVersionId)
      fail(
        "수치 대조의 최신 버전이 변경되었습니다. 다시 불러와 주세요.",
        "NUMERIC_CHECK_VERSION_STALE",
      );
  }
  if (input.judgement.state !== "unreviewed" && (!previous || !input.judgement.reviewer.trim()))
    fail(
      "최초 수치 대조는 미검토로 저장합니다. 후속 판단에는 담당자를 입력해 주세요.",
      "NUMERIC_JUDGEMENT_INVALID",
      422,
    );
  const sourceIds = [
    ...new Set(
      input.observations.flatMap((value) =>
        value.reference?.kind === "source" ? [value.reference.sourceId] : [],
      ),
    ),
  ];
  const planIds = [
    ...new Set(
      input.observations.flatMap((value) =>
        value.reference?.kind === "plan" ? [value.reference.planId] : [],
      ),
    ),
  ];
  if (sourceIds.length > numericCheckLimits.sources || planIds.length > numericCheckLimits.plans)
    fail(
      "한 수치 대조에는 서로 다른 자료와 원고를 각각 10개까지 연결할 수 있습니다.",
      "NUMERIC_REFERENCE_LIMIT",
      413,
    );
  const planSnapshots: NumericCheck["planSnapshots"] = [];
  // Resolve all references and numeric boundaries before opening even one original.
  for (const observation of input.observations) {
    const reference = observation.reference;
    if (!reference) continue;
    let text: string;
    if (reference.kind === "source") {
      const sources = company.sources.filter((source) => source.id === reference.sourceId);
      if (sources.length !== 1)
        fail("이 기업의 고유한 자료를 선택해 주세요.", "NUMERIC_SOURCE_NOT_FOUND", 404);
      const source = sources[0];
      if (source.updatedAt !== reference.sourceUpdatedAt || source.extraction === "pending")
        fail(
          "자료가 변경되었거나 본문이 미추출 상태입니다. 수치 대조는 확인할 수 있는 현재 본문을 연결해 주세요.",
          "NUMERIC_SOURCE_STALE",
        );
      text = source.text;
    } else {
      const plans = company.plans.filter((plan) => plan.id === reference.planId);
      if (plans.length !== 1)
        fail("이 기업의 고유한 원고 버전을 선택해 주세요.", "NUMERIC_PLAN_NOT_FOUND", 404);
      const plan = plans[0];
      const sections = plan.content.sections.filter(
        (section) => section.key === reference.sectionKey,
      );
      if (sections.length !== 1)
        fail("원고의 고유한 항목을 선택해 주세요.", "NUMERIC_PLAN_SECTION_INVALID", 422);
      text = sections[0].content;
      if (!planSnapshots.some((snapshot) => snapshot.planId === plan.id)) {
        const snapshot = {
          planId: plan.id,
          version: plan.version,
          contentSha256: hash(JSON.stringify(plan.content)),
        };
        if (planConflicts(company, snapshot))
          fail(
            "이미 고정한 원고 버전의 내용이 변경되었습니다. 기존 이력을 보존하고 새 원고 버전을 사용해 주세요.",
            "NUMERIC_PLAN_CHANGED",
          );
        planSnapshots.push(snapshot);
      }
    }
    if (!text.includes(reference.quote))
      fail("선택한 원문의 정확한 문장을 인용해 주세요.", "NUMERIC_QUOTE_INVALID", 422);
    if (
      observation.valueText !== "" &&
      !numericLiteralOccurs(text, reference.quote, observation.valueText)
    )
      fail(
        "입력한 수치의 부호·쉼표·소수와 원문의 완전한 숫자 표기를 대조해 주세요. 숫자의 일부만 인용할 수 없습니다.",
        "NUMERIC_VALUE_UNBOUND",
        422,
      );
  }
  const sourceSnapshots: NumericCheck["sourceSnapshots"] = [];
  let totalBytes = 0;
  for (const sourceId of sourceIds) {
    const source = company.sources.find((item) => item.id === sourceId)!;
    let original: NumericCheck["sourceSnapshots"][number]["original"] = null;
    if (source.originalName) {
      const read = readOriginal(sourceId);
      if (
        JSON.stringify(read.source) !== JSON.stringify(source) ||
        hash(read.buffer) !== read.sha256
      )
        fail("자료·원본이 변경되었습니다. 다시 불러와 주세요.", "NUMERIC_SOURCE_STALE");
      totalBytes += read.buffer.length;
      if (
        read.buffer.length > numericCheckLimits.originalBytes ||
        totalBytes > numericCheckLimits.totalOriginalBytes
      )
        fail(
          "원본은 파일별 12MiB, 합계 24MiB 이내로 연결해 주세요.",
          "NUMERIC_ORIGINAL_LIMIT",
          413,
        );
      original = {
        sourceId,
        sourceName: source.name,
        originalName: source.originalName,
        mimeType: source.mimeType,
        sizeBytes: read.buffer.length,
        sha256: read.sha256,
        capturedAt: generated.recordedAt,
        sourceUpdatedAt: source.updatedAt,
      };
      if (originalConflicts(company, original))
        fail(
          "이전에 고정한 원본과 현재 파일이 다릅니다. 새 원본을 별도 자료로 등록해 주세요.",
          "NUMERIC_ORIGINAL_CHANGED",
        );
    }
    sourceSnapshots.push({
      sourceId,
      sourceName: source.name,
      sourceUpdatedAt: source.updatedAt,
      extraction: source.extraction,
      textSha256: hash(source.text),
      original,
    });
  }
  const record = numericCheckSchema.parse({
    ...generated,
    ...input,
    checkId: input.checkId ?? generated.id,
    previousVersionId: previous?.id ?? null,
    version: (previous?.version ?? 0) + 1,
    origin: "manual",
    sourceSnapshots,
    planSnapshots,
    evaluation: evaluateNumericCheck(input),
    judgement: {
      ...input.judgement,
      recordedAt: input.judgement.state === "unreviewed" ? null : generated.recordedAt,
    },
  });
  assertNumericCheckCapacity([...company.numericChecks, record]);
  for (const snapshot of sourceSnapshots) {
    if (!snapshot.original) continue;
    const read = readOriginal(snapshot.sourceId);
    const source = company.sources.find((item) => item.id === snapshot.sourceId)!;
    if (
      JSON.stringify(read.source) !== JSON.stringify(source) ||
      read.sha256 !== snapshot.original.sha256 ||
      hash(read.buffer) !== snapshot.original.sha256 ||
      read.buffer.length !== snapshot.original.sizeBytes
    )
      fail(
        "저장 중 원본이 변경되었습니다. 이 수치 대조 버전은 저장하지 않았습니다.",
        "NUMERIC_ORIGINAL_CHANGED",
      );
  }
  return record;
}
