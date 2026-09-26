import { z } from "zod";
import { StudioError } from "./studio-http";

export const MAX_AGENCY_RECORDS = 200;
export const MAX_AGENCY_TEXT = 200_000;
export const MAX_AGENCY_EVIDENCE_BYTES = 24 * 1024 * 1024;

const date = z.string().refine((value) => {
  if (value === "") return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "날짜를 YYYY-MM-DD 형식으로 확인해 주세요.");
const commonInput = {
  title: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(20_000),
  occurredOn: date,
  note: z.string().max(2000),
  sourceIds: z
    .array(z.string().uuid())
    .max(10)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "같은 원본을 중복 연결할 수 없습니다.",
    }),
};
const requestInput = {
  ...commonInput,
  institution: z.string().trim().min(1).max(200),
  dueOn: date,
  dueNote: z.string().max(2000),
};
const optionalWon = z
  .string()
  .max(16)
  .refine((value) => {
    if (value === "") return true;
    const amount = Number(value);
    return Number.isSafeInteger(amount) && amount >= 0 && String(amount) === value;
  }, "금액은 쉼표 없는 0 이상의 정수로 입력하거나 미확인이면 비워 주세요.");
export const agencyNoticeDetailsSchema = z.discriminatedUnion("category", [
  z
    .object({
      category: z.literal("payment"),
      amountWon: optionalWon,
      dueOn: date,
      dueNote: z.string().max(2000),
      paidOn: date,
      referenceNumber: z.string().max(200),
      statusText: z.string().max(1000),
    })
    .strict(),
  z
    .object({
      category: z.literal("receipt"),
      receiptNumber: z.string().max(200),
      receivedOn: date,
      statusText: z.string().max(1000),
    })
    .strict(),
  z
    .object({
      category: z.literal("visit"),
      scheduledOn: date,
      timeText: z.string().max(100),
      location: z.string().max(500),
      preparation: z.string().max(2000),
    })
    .strict(),
  z
    .object({
      category: z.literal("decision"),
      decisionText: z.string().max(1000),
      notifiedOn: date,
      reasons: z.string().max(2000),
    })
    .strict(),
  z
    .object({
      category: z.literal("certificate"),
      certificateNumber: z.string().max(200),
      issuedOn: date,
      validFrom: date,
      validUntil: date,
      statusText: z.string().max(1000),
    })
    .strict()
    .refine(
      (details) =>
        !details.validFrom || !details.validUntil || details.validFrom <= details.validUntil,
      {
        message: "유효기간의 시작일과 종료일을 확인해 주세요. 미확인 날짜는 비워둘 수 있습니다.",
        path: ["validUntil"],
      },
    ),
]);
export type AgencyNoticeDetails = z.infer<typeof agencyNoticeDetailsSchema>;
const noticeInput = {
  ...commonInput,
  institution: z.string().trim().min(1).max(200),
  details: agencyNoticeDetailsSchema,
};
export const agencyRecordInputSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("request"), ...requestInput }).strict(),
    z
      .object({
        kind: z.literal("request-correction"),
        requestRecordId: z.string().uuid(),
        previousVersionId: z.string().uuid(),
        ...requestInput,
      })
      .strict(),
    z.object({ kind: z.literal("notice"), ...noticeInput }).strict(),
    z
      .object({
        kind: z.literal("notice-correction"),
        noticeRecordId: z.string().uuid(),
        previousVersionId: z.string().uuid(),
        ...noticeInput,
      })
      .strict(),
    z
      .object({
        kind: z.literal("response"),
        requestRecordId: z.string().uuid(),
        previousVersionId: z.string().uuid().nullable(),
        responseStatus: z.enum(["draft", "reported-sent"]),
        ...commonInput,
      })
      .strict(),
  ])
  .refine(
    (input) =>
      input.kind !== "response" ||
      input.responseStatus !== "reported-sent" ||
      input.occurredOn !== "",
    {
      message: "발송했다고 기록하려면 담당자가 확인한 발송일을 입력해 주세요.",
      path: ["occurredOn"],
    },
  );
export type AgencyRecordInput = z.infer<typeof agencyRecordInputSchema>;

export const agencyAppendMutationSchema = z
  .object({
    action: z.literal("append-agency-record"),
    revision: z.number().int().nonnegative().safe(),
    clientRequestId: z.string().uuid(),
    record: agencyRecordInputSchema,
  })
  .strict();

export const agencyEvidenceSnapshotSchema = z
  .object({
    sourceId: z.string().uuid(),
    sourceName: z.string().min(1).max(200),
    originalName: z.string().min(1).max(200),
    mimeType: z.string().max(150).nullable(),
    sizeBytes: z
      .number()
      .int()
      .nonnegative()
      .max(12 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    capturedAt: z.string().datetime(),
    sourceUpdatedAt: z.string().max(100),
  })
  .strict();
export type AgencyEvidenceSnapshot = z.infer<typeof agencyEvidenceSnapshotSchema>;

const agencyRequestRecordSchema = z
  .object({
    id: z.string().uuid(),
    clientRequestId: z.string().uuid(),
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.enum(["request", "request-correction", "response"]),
    requestRecordId: z.string().uuid(),
    requestVersionId: z.string().uuid(),
    previousVersionId: z.string().uuid().nullable(),
    version: z.number().int().positive().max(MAX_AGENCY_RECORDS),
    origin: z.literal("manual"),
    recordedAt: z.string().datetime(),
    institution: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(300),
    body: z.string().trim().min(1).max(20_000),
    occurredOn: date,
    dueOn: date,
    dueNote: z.string().max(2000),
    note: z.string().max(2000),
    responseStatus: z.enum(["draft", "reported-sent"]).nullable(),
    preparedFrom: z
      .object({ preparationId: z.string().uuid(), preparationVersionId: z.string().uuid() })
      .strict()
      .optional(),
    evidence: z.array(agencyEvidenceSnapshotSchema).max(10),
  })
  .strict();
export type AgencyRequestRecord = z.infer<typeof agencyRequestRecordSchema>;
const agencyNoticeRecordSchema = z
  .object({
    id: z.string().uuid(),
    clientRequestId: z.string().uuid(),
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.enum(["notice", "notice-correction"]),
    noticeRecordId: z.string().uuid(),
    previousVersionId: z.string().uuid().nullable(),
    version: z.number().int().positive().max(MAX_AGENCY_RECORDS),
    origin: z.literal("manual"),
    recordedAt: z.string().datetime(),
    institution: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(300),
    body: z.string().trim().min(1).max(20_000),
    occurredOn: date,
    note: z.string().max(2000),
    details: agencyNoticeDetailsSchema,
    evidence: z.array(agencyEvidenceSnapshotSchema).max(10),
  })
  .strict();
export type AgencyNoticeRecord = z.infer<typeof agencyNoticeRecordSchema>;
export const agencyRecordSchema = z.discriminatedUnion("kind", [
  agencyRequestRecordSchema,
  agencyNoticeRecordSchema,
]);
export type AgencyRecord = z.infer<typeof agencyRecordSchema>;
export function isAgencyNoticeRecord(record: AgencyRecord): record is AgencyNoticeRecord {
  return record.kind === "notice" || record.kind === "notice-correction";
}

export function assertAgencyCapacity(records: AgencyRecord[]) {
  const characters = records.reduce(
    (sum, record) =>
      sum +
      record.institution.length +
      record.title.length +
      record.body.length +
      record.note.length +
      (isAgencyNoticeRecord(record)
        ? record.occurredOn.length +
          Object.values(record.details).reduce((total, value) => total + value.length, 0)
        : record.dueNote.length),
    0,
  );
  if (records.length > MAX_AGENCY_RECORDS || characters > MAX_AGENCY_TEXT)
    throw new StudioError(
      "기관 기록 보관 한도에 도달했습니다. 기존 기록을 보존하며 새 기록은 저장하지 않았습니다.",
      409,
      "AGENCY_RECORD_LIMIT",
    );
}

/** A nonce is scoped to one company and one canonical input; replay never rewrites history. */
export function isAgencyRecordReplay(
  records: AgencyRecord[],
  clientRequestId: string,
  inputDigest: string,
) {
  const matches = records.filter((record) => record.clientRequestId === clientRequestId);
  if (!matches.length) return false;
  if (matches.length !== 1 || matches[0].inputDigest !== inputDigest)
    throw new StudioError(
      "같은 저장 요청에 다른 내용이 포함되어 있습니다. 새 기록으로 다시 준비해 주세요.",
      409,
      "AGENCY_REQUEST_CONFLICT",
    );
  return true;
}

/** Build one local manual record; never infer receipt, delivery, review completion, or a stage. */
export function buildAgencyRecord(
  records: AgencyRecord[],
  input: AgencyRecordInput,
  generated: Pick<
    AgencyRecord,
    "id" | "clientRequestId" | "inputDigest" | "recordedAt" | "evidence"
  >,
): AgencyRecord {
  if (records.length >= MAX_AGENCY_RECORDS)
    throw new StudioError(
      "기관 기록 보관 한도에 도달했습니다. 기존 기록을 보존하며 새 기록은 저장하지 않았습니다.",
      409,
      "AGENCY_RECORD_LIMIT",
    );
  let previousVersionId: string | null = null;
  let version = 1;
  let institution: string;
  let linkage: { noticeRecordId: string } | { requestRecordId: string; requestVersionId: string };
  if (input.kind === "notice" || input.kind === "notice-correction") {
    institution = input.institution;
    let noticeRecordId = generated.id;
    if (input.kind === "notice-correction") {
      const notices = records.filter(isAgencyNoticeRecord);
      const first = notices.find(
        (record) => record.id === input.noticeRecordId && record.kind === "notice",
      );
      if (!first)
        throw new StudioError(
          "이 기업의 최초 통보 기록을 찾을 수 없습니다.",
          404,
          "AGENCY_NOTICE_NOT_FOUND",
        );
      const latest = notices.filter((record) => record.noticeRecordId === first.id).at(-1)!;
      if (input.previousVersionId !== latest.id)
        throw new StudioError(
          "통보의 최신 버전이 변경되었습니다. 다시 불러온 뒤 정정 기록을 남겨 주세요.",
          409,
          "AGENCY_VERSION_STALE",
        );
      noticeRecordId = first.id;
      previousVersionId = latest.id;
      version = latest.version + 1;
    }
    linkage = { noticeRecordId };
  } else {
    let requestRecordId = generated.id;
    let requestVersionId = generated.id;
    if (input.kind === "request") institution = input.institution;
    else {
      const requests = records.filter(
        (record): record is AgencyRequestRecord => !isAgencyNoticeRecord(record),
      );
      const first = requests.find(
        (record) => record.id === input.requestRecordId && record.kind === "request",
      );
      if (!first)
        throw new StudioError(
          "이 기업의 최초 요청 기록을 찾을 수 없습니다.",
          404,
          "AGENCY_REQUEST_NOT_FOUND",
        );
      requestRecordId = first.id;
      const latestRequest = requests
        .filter((record) => record.requestRecordId === first.id && record.kind !== "response")
        .at(-1)!;
      const previous =
        input.kind === "request-correction"
          ? latestRequest
          : requests
              .filter((record) => record.requestRecordId === first.id && record.kind === "response")
              .at(-1);
      if (input.previousVersionId !== (previous?.id ?? null))
        throw new StudioError(
          "요청 또는 답변의 최신 버전이 변경되었습니다. 다시 불러온 뒤 새 버전을 기록해 주세요.",
          409,
          "AGENCY_VERSION_STALE",
        );
      previousVersionId = previous?.id ?? null;
      version = (previous?.version ?? 0) + 1;
      institution =
        input.kind === "request-correction" ? input.institution : latestRequest.institution;
      if (input.kind === "response") requestVersionId = latestRequest.id;
    }
    linkage = { requestRecordId, requestVersionId };
  }
  if (
    generated.evidence.length !== input.sourceIds.length ||
    generated.evidence.some((item, index) => item.sourceId !== input.sourceIds[index])
  )
    throw new StudioError(
      "선택한 원본과 증빙 기록이 일치하지 않습니다.",
      409,
      "AGENCY_EVIDENCE_CHANGED",
    );
  for (const evidence of generated.evidence) {
    const previous = records
      .flatMap((record) => record.evidence)
      .filter((item) => item.sourceId === evidence.sourceId);
    if (
      previous.some(
        (item) =>
          item.sha256 !== evidence.sha256 ||
          item.sizeBytes !== evidence.sizeBytes ||
          item.originalName !== evidence.originalName ||
          item.mimeType !== evidence.mimeType,
      )
    )
      throw new StudioError(
        "이미 연결한 원본의 내용 또는 파일 정보가 변경되었습니다. 기존 기록을 유지하고 새 원본을 별도 등록해 주세요.",
        409,
        "AGENCY_EVIDENCE_CHANGED",
      );
  }
  if (generated.evidence.reduce((sum, item) => sum + item.sizeBytes, 0) > MAX_AGENCY_EVIDENCE_BYTES)
    throw new StudioError(
      "한 기록의 원본 합계는 24MiB 이하여야 합니다.",
      413,
      "AGENCY_EVIDENCE_LIMIT",
    );
  const record = agencyRecordSchema.parse({
    ...generated,
    kind: input.kind,
    ...linkage,
    previousVersionId,
    version,
    origin: "manual",
    institution,
    title: input.title,
    body: input.body,
    occurredOn: input.occurredOn,
    note: input.note,
    ...("details" in input
      ? { details: input.details }
      : {
          dueOn: input.kind === "response" ? "" : input.dueOn,
          dueNote: input.kind === "response" ? "" : input.dueNote,
          responseStatus: input.kind === "response" ? input.responseStatus : null,
        }),
  });
  assertAgencyCapacity([...records, record]);
  return record;
}
