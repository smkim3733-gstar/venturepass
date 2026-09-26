import { z } from "zod";
import type { CompanyProfile, StudioCase } from "./studio-schema";
import type { VentureSessionStatus } from "./venturein-schema";
import {
  verifyVentureCompany,
  type VentureScreenField,
  type VentureScreenSnapshot,
} from "./venturein-inspection";

export const ventureProfileProperties = [
  "companyName",
  "businessNumber",
  "industry",
  "foundedOn",
  "applicationDate",
  "applicationKind",
  "technologySummary",
  "customers",
  "team",
  "financials",
  "paidInCapital",
  "closingMonth",
  "developmentPlan",
  "patents",
] as const satisfies readonly (keyof CompanyProfile)[];

const fieldKey = z.string().min(1).max(256);
const timestamp = z.string().datetime({ offset: true });
export const ventureTextSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("profile"), property: z.enum(ventureProfileProperties) }).strict(),
  z.object({ kind: z.literal("plan-section"), sectionKey: z.string().min(1).max(200) }).strict(),
]);
export const ventureSubmissionDraftSchema = z
  .object({
    caseId: z.string().uuid(),
    snapshotId: z.string().min(1).max(200),
    sessionStartedAt: timestamp,
    accountRevision: z.number().int().nonnegative(),
    companyRevision: z.number().int().nonnegative(),
    planId: z.string().uuid().nullable(),
    planVersion: z.number().int().positive().nullable(),
    textMappings: z
      .array(
        z
          .object({
            fieldKey,
            source: ventureTextSourceSchema,
            confirmed: z.boolean(),
          })
          .strict(),
      )
      .max(200),
    attachmentMappings: z
      .array(
        z
          .object({
            fieldKey,
            sourceId: z.string().uuid(),
            sourceUpdatedAt: timestamp,
            confirmed: z.boolean(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .refine((draft) => (draft.planId === null) === (draft.planVersion === null), {
    message: "작성본 ID와 버전을 함께 지정해 주세요.",
    path: ["planVersion"],
  });

export type VentureSubmissionDraft = z.infer<typeof ventureSubmissionDraftSchema>;
export type VentureTextSource = z.infer<typeof ventureTextSourceSchema>;
/** Binding is assigned by the server after inspecting its current browser session. */
export type VentureBoundSnapshot = {
  screen: VentureScreenSnapshot;
  caseId: string;
  sessionStartedAt: string;
  accountRevision: number;
};
/** Metadata comes from the server's safe storage lookup, never from a draft or browser request. */
export type VentureOriginalMetadata = {
  sourceId: string;
  originalName: string;
  mimeType: string | null;
  sizeBytes: number;
  exists: boolean;
};
export type VenturePreflightIssue = {
  code: string;
  severity: "error" | "warning";
  message: string;
  fieldKey?: string;
  sourceId?: string;
};
export type VentureResolvedText = {
  fieldKey: string;
  label: string;
  source: VentureTextSource;
  value: string;
  characterCount: number;
  maxLength: number | null;
  required: boolean;
  confirmed: boolean;
  financialContext?: { unit: "원" | "월"; evidenceNote: string };
};

/** Company notes provide review context only; they never replace the exact input value. */
export function ventureFinancialContext(
  profile: CompanyProfile,
  source: VentureTextSource,
): VentureResolvedText["financialContext"] {
  if (source.kind !== "profile") return undefined;
  const unit =
    source.property === "paidInCapital"
      ? "원"
      : source.property === "closingMonth"
        ? "월"
        : undefined;
  return unit ? { unit, evidenceNote: profile.financials } : undefined;
}
export type VentureResolvedAttachment = {
  fieldKey: string;
  label: string;
  sourceId: string;
  sourceUpdatedAt: string;
  originalName: string;
  mimeType: string | null;
  sizeBytes: number;
  accept: string | null;
  multiple: boolean;
  confirmed: boolean;
};
export type VenturePreflightReport = {
  scope: "local-preflight";
  caseId: string;
  snapshotId: string | null;
  planId: string | null;
  readyForLocalReview: boolean;
  inputReadiness: VentureInputReadiness;
  automaticSubmissionAvailable: false;
  companyVerification: ReturnType<typeof verifyVentureCompany> | null;
  issues: VenturePreflightIssue[];
  textFields: VentureResolvedText[];
  attachments: VentureResolvedAttachment[];
};
export type VentureInputReadiness = {
  ready: boolean;
  blockingIssues: VenturePreflightIssue[];
  deferredIssues: VenturePreflightIssue[];
};
export type VenturePreflightInput = {
  company: StudioCase;
  snapshot: VentureBoundSnapshot | null;
  draft: VentureSubmissionDraft | null;
  session: VentureSessionStatus;
  accountRevision: number;
  planIsCurrent: boolean;
  originalFiles: VentureOriginalMetadata[];
};

const deferredPlanCodes = new Set([
  "PLAN_MISSING",
  "PLAN_SUPERSEDED",
  "PLAN_STALE",
  "PLAN_UNCONFIRMED",
  "PLAN_REVIEW_ERROR",
  "PLAN_NEEDS_CONFIRMATION",
]);
const deferredUnselectedFieldCodes = new Set([
  "REQUIRED_FIELD_UNMAPPED",
  "UNSUPPORTED_FIELD",
  "AGREEMENT_REQUIRES_USER",
]);

/** Separate one explicitly selected input batch from whole-application readiness. Never erase issues. */
export function buildVentureInputReadiness(input: {
  issues: VenturePreflightIssue[];
  draft: VentureSubmissionDraft | null;
  screen: VentureScreenSnapshot | undefined;
  textFields: VentureResolvedText[];
  attachments: VentureResolvedAttachment[];
}): VentureInputReadiness {
  const selected = new Set([
    ...(input.draft?.textMappings.map((mapping) => mapping.fieldKey) ?? []),
    ...(input.draft?.attachmentMappings.map((mapping) => mapping.fieldKey) ?? []),
  ]);
  const known = new Set(input.screen?.fields.map((field) => field.key) ?? []);
  // Inspect the actual selections, including unresolved sections, rather than only resolved values.
  const usesPlan =
    input.draft?.textMappings.some((mapping) => mapping.source.kind === "plan-section") ?? false;
  const blockingIssues: VenturePreflightIssue[] = [];
  const deferredIssues: VenturePreflightIssue[] = [];
  for (const issue of input.issues) {
    const deferred =
      (!usesPlan && deferredPlanCodes.has(issue.code)) ||
      (Boolean(issue.fieldKey && known.has(issue.fieldKey) && !selected.has(issue.fieldKey)) &&
        deferredUnselectedFieldCodes.has(issue.code));
    if (deferred) deferredIssues.push(issue);
    else if (issue.severity === "error") blockingIssues.push(issue);
  }
  const add = (code: string, message: string, fieldKey?: string) =>
    blockingIssues.push({
      code,
      message,
      severity: "error",
      ...(fieldKey && { fieldKey }),
    });
  if (!selected.size)
    add(
      "INPUT_TARGETS_MISSING",
      "이번에 입력하거나 첨부할 항목을 하나 이상 선택하고 확인해 주세요.",
    );
  const targetCount =
    input.textFields.length + new Set(input.attachments.map((file) => file.fieldKey)).size;
  const resolved = new Set([
    ...input.textFields.map((field) => field.fieldKey),
    ...input.attachments.map((file) => file.fieldKey),
  ]);
  if (!blockingIssues.length && [...selected].some((key) => !known.has(key) || !resolved.has(key)))
    add(
      "INPUT_TARGET_UNRESOLVED",
      "선택한 모든 항목의 현재 화면 정보와 입력값·첨부를 먼저 확인해 주세요.",
    );
  if (
    selected.size > 50 ||
    targetCount > 50 ||
    input.textFields.some((field) => field.value.length > 20_000) ||
    input.textFields.reduce((total, field) => total + field.value.length, 0) > 100_000
  )
    add(
      "INPUT_LIMIT",
      "한 번에 50개 항목, 텍스트당 20,000자, 전체 텍스트 100,000자까지 입력할 수 있습니다.",
    );
  for (const field of input.textFields) {
    if (
      !field.value.trim() &&
      !blockingIssues.some(
        (issue) => issue.code === "REQUIRED_VALUE_EMPTY" && issue.fieldKey === field.fieldKey,
      )
    )
      add(
        "INPUT_VALUE_EMPTY",
        "선택한 입력값이 비어 있습니다. 값을 준비하거나 이번 실행 대상에서 제외해 주세요.",
        field.fieldKey,
      );
    if (
      !field.confirmed &&
      !blockingIssues.some(
        (issue) => issue.code === "MAPPING_UNCONFIRMED" && issue.fieldKey === field.fieldKey,
      )
    )
      add("MAPPING_UNCONFIRMED", "선택한 입력 대응 관계를 직접 확인해 주세요.", field.fieldKey);
  }
  if (
    input.attachments.length > 10 ||
    input.attachments.some(
      (file) =>
        !Number.isSafeInteger(file.sizeBytes) ||
        file.sizeBytes <= 0 ||
        file.sizeBytes > 12 * 1024 * 1024,
    ) ||
    input.attachments.reduce((total, file) => total + file.sizeBytes, 0) > 24 * 1024 * 1024
  )
    add(
      "INPUT_FILE_LIMIT",
      "한 번에 10개 파일, 파일당 12MiB, 합계 24MiB까지 첨부할 수 있습니다. 기관 한도는 별도 확인이 필요합니다.",
    );
  for (const file of input.attachments) {
    if (
      !file.confirmed &&
      !blockingIssues.some(
        (issue) =>
          issue.code === "MAPPING_UNCONFIRMED" &&
          issue.fieldKey === file.fieldKey &&
          issue.sourceId === file.sourceId,
      )
    )
      blockingIssues.push({
        code: "MAPPING_UNCONFIRMED",
        severity: "error",
        message: "선택한 첨부 대응 관계를 직접 확인해 주세요.",
        fieldKey: file.fieldKey,
        sourceId: file.sourceId,
      });
  }
  return { ready: blockingIssues.length === 0, blockingIssues, deferredIssues };
}

const supportedInputTypes = new Set(["text", "search", "tel", "url", "email", "number", "date"]);
/** Supported means local text/file review only; it never enables browser input or submission. */
export function ventureFieldSupport(field: VentureScreenField): "text" | "file" | "unsupported" {
  if (field.disabled || field.readOnly) return "unsupported";
  if (field.kind === "file") return "file";
  if (
    field.kind === "textarea" ||
    (field.kind === "select" && field.type === "select-one" && !field.multiple)
  )
    return "text";
  return field.kind === "input" && supportedInputTypes.has(field.type.toLowerCase())
    ? "text"
    : "unsupported";
}

function fieldLabel(field: VentureScreenField) {
  return field.labels.find((label) => label.trim()) || field.name || field.id || field.key;
}

function basicInputValueValid(field: VentureScreenField, value: string) {
  if (!value || field.kind !== "input") return true;
  if (field.type === "number")
    return (
      /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value))
    );
  if (field.type === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }
  if (field.type === "email") return /^[^\s@]+@[^\s@]+$/.test(value);
  if (field.type === "url") {
    try {
      return value === value.trim() && Boolean(new URL(value).protocol);
    } catch {
      return false;
    }
  }
  return true;
}

function officialScreen(url: string) {
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === "https://www.smes.go.kr" &&
      parsed.pathname.startsWith("/venturein/") &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

function acceptMatch(
  accept: string,
  file: VentureOriginalMetadata,
): "match" | "mismatch" | "unknown" {
  const tokens = accept
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  const name = file.originalName.toLowerCase();
  const mime = file.mimeType?.split(";", 1)[0].trim().toLowerCase();
  let unknown = tokens.length === 0;
  for (const token of tokens) {
    if (/^\.[a-z0-9][a-z0-9._-]*$/i.test(token)) {
      if (name.endsWith(token)) return "match";
    } else if (/^[a-z0-9!#$&^_.+-]+\/(?:[a-z0-9!#$&^_.+-]+|\*)$/i.test(token)) {
      if (!mime) unknown = true;
      else if (token.endsWith("/*") ? mime.startsWith(token.slice(0, -1)) : mime === token)
        return "match";
    } else unknown = true;
  }
  return unknown ? "unknown" : "mismatch";
}

/** Pure local preparation. All external input, upload, agreement and submission stay disabled. */
export function buildVenturePreflight(input: VenturePreflightInput): VenturePreflightReport {
  const { company, snapshot, session } = input;
  const issues: VenturePreflightIssue[] = [];
  const textFields: VentureResolvedText[] = [];
  const attachments: VentureResolvedAttachment[] = [];
  const add = (
    code: string,
    message: string,
    field?: VentureScreenField,
    sourceId?: string,
    severity: VenturePreflightIssue["severity"] = "error",
  ) => {
    issues.push({
      code,
      severity,
      message,
      ...(field && { fieldKey: field.key }),
      ...(sourceId && { sourceId }),
    });
  };
  const parsedDraft = ventureSubmissionDraftSchema.safeParse(input.draft);
  const draft = parsedDraft.success ? parsedDraft.data : null;
  const screen = snapshot?.screen;
  const fields = new Map<string, VentureScreenField>();
  const plan = draft?.planId
    ? company.plans.find((entry) => entry.id === draft.planId)
    : company.plans.at(-1);
  const verification = screen ? verifyVentureCompany(screen, company.profile.businessNumber) : null;
  const report = (): VenturePreflightReport => ({
    scope: "local-preflight",
    caseId: company.id,
    snapshotId: screen?.id ?? null,
    planId: plan?.id ?? null,
    readyForLocalReview: !issues.some((issue) => issue.severity === "error"),
    inputReadiness: buildVentureInputReadiness({ issues, draft, screen, textFields, attachments }),
    automaticSubmissionAvailable: false,
    companyVerification: verification,
    issues,
    textFields,
    attachments,
  });

  add(
    "EXTERNAL_SUBMISSION_DISABLED",
    "이 결과는 로컬 대응표와 사전 점검입니다. 실제 입력·첨부는 값·파일·전송 대상의 별도 검토와 승인이 필요합니다. 저장·동의·최종 제출 버튼은 실행하지 않습니다.",
    undefined,
    undefined,
    "warning",
  );
  if (!plan) add("PLAN_MISSING", "검토할 사업계획서 작성본을 먼저 준비해 주세요.");
  else {
    if (plan.id !== company.plans.at(-1)?.id)
      add(
        "PLAN_SUPERSEDED",
        "더 최근 작성본이 있습니다. 최신 작성본을 선택하고 대응표를 다시 확인해 주세요.",
      );
    if (!input.planIsCurrent)
      add(
        "PLAN_STALE",
        "기업 자료나 아이템이 변경되었습니다. 최신 근거로 작성본을 다시 검토해 주세요.",
      );
    if (!plan.confirmedAt)
      add("PLAN_UNCONFIRMED", "사업계획서 내부 검토 완료를 먼저 기록해 주세요.");
    if (plan.review.some((finding) => finding.severity === "error"))
      add("PLAN_REVIEW_ERROR", "사업계획서의 검토 오류를 먼저 해결해 주세요.");
    if (plan.content.sections.some((section) => section.needsConfirmation))
      add("PLAN_NEEDS_CONFIRMATION", "사업계획서에 사실·증빙 확인이 필요한 항목이 남아 있습니다.");
  }
  if (!screen || !snapshot)
    add("SNAPSHOT_MISSING", "연결된 공식 신청 화면의 항목을 먼저 확인해 주세요.");
  else {
    if (!officialScreen(screen.url))
      add("SNAPSHOT_ORIGIN", "공식 벤처인 화면에서 수집된 항목만 사용할 수 있습니다.");
    if (screen.truncated)
      add(
        "SNAPSHOT_TRUNCATED",
        "화면 항목이 일부만 수집되었습니다. 누락 항목을 확인하고 다시 수집해 주세요.",
      );
    if (screen.fields.length === 0)
      add(
        "SCREEN_FIELDS_MISSING",
        "현재 화면에서 확인할 신청 항목을 찾지 못했습니다. 공식 신청 화면으로 이동한 뒤 다시 확인해 주세요.",
      );
    if (snapshot.caseId !== company.id)
      add(
        "SNAPSHOT_CASE_MISMATCH",
        "다른 기업에 연결된 화면 정보입니다. 현재 기업에서 다시 확인해 주세요.",
      );
    if (
      snapshot.sessionStartedAt !== session.startedAt ||
      snapshot.accountRevision !== input.accountRevision
    ) {
      add(
        "SNAPSHOT_SESSION_MISMATCH",
        "화면 확인 후 로그인 연결 또는 저장 계정이 변경되었습니다. 현재 연결에서 다시 확인해 주세요.",
      );
    }
    if (!verification || verification.status !== "matched")
      add(
        "COMPANY_NOT_VERIFIED",
        "공식 화면과 기업정보의 10자리 사업자등록번호가 정확히 일치해야 합니다. 기업명만으로 일치 처리하지 않습니다.",
      );
    add(
      "CURRENT_SCREEN_ONLY",
      "현재 확인한 화면에 표시된 항목만 점검합니다. 다음 단계·숨김 항목·기관 전체 필수서류를 확인한 결과가 아닙니다.",
      undefined,
      undefined,
      "warning",
    );
    for (const warning of screen.warnings) {
      const requiredUnsupported = warning.startsWith("UNSUPPORTED_REQUIRED_CONTROL:");
      add(
        requiredUnsupported ? "UNSUPPORTED_REQUIRED_CONTROL" : "SCREEN_WARNING",
        warning,
        undefined,
        undefined,
        requiredUnsupported ? "error" : "warning",
      );
    }
    for (const field of screen.fields) {
      if (fields.has(field.key))
        add("DUPLICATE_FIELD_KEY", "화면 항목 식별자가 중복되어 정확히 대응할 수 없습니다.", field);
      else fields.set(field.key, field);
      if (ventureFieldSupport(field) === "unsupported")
        add(
          "UNSUPPORTED_FIELD",
          `‘${fieldLabel(field)}’ 항목은 직접 확인이 필요합니다. 동의·선택 제어·비활성·읽기 전용 항목을 자동 처리하지 않습니다.`,
          field,
          undefined,
          field.required ? "error" : "warning",
        );
      if (
        ["checkbox", "radio"].includes(field.type) &&
        /약관|동의|개인정보|consent|agree|terms|privacy/i.test(
          [field.id, field.name, ...field.labels].join(" "),
        )
      ) {
        add(
          "AGREEMENT_REQUIRES_USER",
          "공식 화면의 약관·동의 항목은 사용자가 직접 확인해야 합니다. 필수 속성이 없어도 동의 완료로 처리하지 않습니다.",
          field,
        );
      }
    }
  }
  if (session.state !== "connected_unmapped" || !session.startedAt)
    add("SESSION_NOT_CONNECTED", "로그인 표시를 확인한 현재 벤처인 연결이 필요합니다.");
  if (!draft)
    add(
      input.draft === null ? "DRAFT_MISSING" : "DRAFT_INVALID",
      input.draft === null
        ? "공식 항목과 회사 자료의 대응표를 직접 선택하고 확인해 주세요."
        : "대응표 형식 또는 필수 확인값이 올바르지 않습니다. 다시 작성해 주세요.",
    );
  if (!draft || !screen || !snapshot) return report();

  if (draft.caseId !== company.id)
    add("DRAFT_CASE_MISMATCH", "대응표의 기업이 현재 기업과 다릅니다.");
  if (draft.snapshotId !== screen.id)
    add(
      "DRAFT_SNAPSHOT_MISMATCH",
      "새 화면을 확인한 뒤 이전 대응표를 재사용할 수 없습니다. 새 항목을 직접 연결해 주세요.",
    );
  if (
    draft.sessionStartedAt !== snapshot.sessionStartedAt ||
    draft.sessionStartedAt !== session.startedAt ||
    draft.accountRevision !== snapshot.accountRevision ||
    draft.accountRevision !== input.accountRevision
  ) {
    add(
      "DRAFT_SESSION_MISMATCH",
      "대응표를 확인한 로그인 연결 또는 저장 계정이 현재 연결과 다릅니다.",
    );
  }
  if (draft.companyRevision !== company.revision)
    add(
      "DRAFT_COMPANY_STALE",
      "기업 자료가 변경되었습니다. 대응표의 값과 파일을 다시 확인해 주세요.",
    );
  if (
    (draft.planId !== null && (!plan || draft.planVersion !== plan.version)) ||
    (draft.planId === null &&
      (Boolean(plan) ||
        draft.textMappings.some((mapping) => mapping.source.kind === "plan-section")))
  )
    add("DRAFT_PLAN_STALE", "대응표의 작성본 ID·버전을 현재 보관된 작성본과 다시 대조해 주세요.");

  // A changed snapshot or binding must never reuse an old confirmation against different fields.
  if (
    issues.some((issue) =>
      [
        "SNAPSHOT_CASE_MISMATCH",
        "SNAPSHOT_SESSION_MISMATCH",
        "DRAFT_CASE_MISMATCH",
        "DRAFT_SNAPSHOT_MISMATCH",
        "DRAFT_SESSION_MISMATCH",
        "DRAFT_COMPANY_STALE",
        "DRAFT_PLAN_STALE",
      ].includes(issue.code),
    )
  )
    return report();
  const textCounts = new Map<string, number>();
  const attachmentCounts = new Map<string, number>();
  for (const mapping of draft.textMappings)
    textCounts.set(mapping.fieldKey, (textCounts.get(mapping.fieldKey) ?? 0) + 1);
  for (const mapping of draft.attachmentMappings)
    attachmentCounts.set(mapping.fieldKey, (attachmentCounts.get(mapping.fieldKey) ?? 0) + 1);
  for (const [key, count] of textCounts) {
    if (count > 1 || attachmentCounts.has(key))
      add("DUPLICATE_MAPPING", "하나의 공식 항목에 텍스트 대응이 중복되었습니다.", fields.get(key));
  }

  for (const mapping of draft.textMappings) {
    const field = fields.get(mapping.fieldKey);
    if (!field) {
      add("UNKNOWN_FIELD", "현재 화면에 없는 텍스트 항목이 대응표에 남아 있습니다.");
      continue;
    }
    if (ventureFieldSupport(field) !== "text") {
      add("TEXT_FIELD_UNSUPPORTED", "텍스트를 연결할 수 없는 공식 항목입니다.", field);
      continue;
    }
    if (!mapping.confirmed)
      add("MAPPING_UNCONFIRMED", "선택한 텍스트 대응 관계를 직접 확인해 주세요.", field);
    let value: string;
    if (mapping.source.kind === "profile") value = company.profile[mapping.source.property] ?? "";
    else {
      const sectionKey = mapping.source.sectionKey;
      const sections = plan?.content.sections.filter((section) => section.key === sectionKey) ?? [];
      if (sections.length !== 1) {
        add("PLAN_SECTION_MISSING", "선택한 작성본 항목이 없거나 식별자가 중복되었습니다.", field);
        continue;
      }
      value = sections[0].content;
    }
    const financialContext = ventureFinancialContext(company.profile, mapping.source);
    textFields.push({
      fieldKey: field.key,
      label: fieldLabel(field),
      source: mapping.source,
      value,
      characterCount: value.length,
      maxLength: field.maxLength,
      required: field.required,
      confirmed: mapping.confirmed,
      ...(financialContext && { financialContext }),
    });
    if (field.required && !value.trim())
      add("REQUIRED_VALUE_EMPTY", "필수 항목에 연결한 내용이 비어 있습니다.", field);
    if (!basicInputValueValid(field, value))
      add(
        "INPUT_TYPE_MISMATCH",
        "연결한 내용이 공식 항목의 기본 입력 형식과 맞지 않습니다. 임의 변환하지 않습니다.",
        field,
      );
    // HTML maxlength measures UTF-16 code units; preserve the exact text without trimming or truncation.
    if (field.maxLength !== null && value.length > field.maxLength)
      add(
        "TEXT_TOO_LONG",
        `연결한 내용 ${value.length}자가 화면의 최대 ${field.maxLength}자를 초과합니다.`,
        field,
      );
    if (
      field.kind === "select" &&
      value &&
      !field.options.some((option) => !option.disabled && option.value === value)
    ) {
      add(
        "SELECT_VALUE_MISMATCH",
        "연결한 값이 공식 선택항목의 값과 정확히 일치하지 않습니다. 임의로 변환하지 않습니다.",
        field,
      );
    }
  }

  const sourcePairs = new Set<string>();
  for (const mapping of draft.attachmentMappings) {
    const field = fields.get(mapping.fieldKey);
    if (!field) {
      add(
        "UNKNOWN_FIELD",
        "현재 화면에 없는 파일 항목이 대응표에 남아 있습니다.",
        undefined,
        mapping.sourceId,
      );
      continue;
    }
    if (ventureFieldSupport(field) !== "file") {
      add(
        "FILE_FIELD_UNSUPPORTED",
        "파일을 연결할 수 없는 공식 항목입니다.",
        field,
        mapping.sourceId,
      );
      continue;
    }
    const pair = `${mapping.fieldKey}\0${mapping.sourceId}`;
    if (sourcePairs.has(pair))
      add(
        "DUPLICATE_ATTACHMENT",
        "같은 파일이 하나의 공식 항목에 중복 연결되었습니다.",
        field,
        mapping.sourceId,
      );
    sourcePairs.add(pair);
    if (!field.multiple && (attachmentCounts.get(field.key) ?? 0) > 1)
      add(
        "FILE_MULTIPLE_NOT_ALLOWED",
        "여러 파일을 받는다고 확인되지 않은 항목에 파일이 중복 연결되었습니다.",
        field,
        mapping.sourceId,
      );
    if (!mapping.confirmed)
      add(
        "MAPPING_UNCONFIRMED",
        "선택한 첨부 대응 관계를 직접 확인해 주세요.",
        field,
        mapping.sourceId,
      );
    const source = company.sources.find((entry) => entry.id === mapping.sourceId);
    if (!source || !source.originalName) {
      add(
        "SOURCE_MISSING",
        "선택한 자료의 원본 파일 정보가 현재 기업에 없습니다.",
        field,
        mapping.sourceId,
      );
      continue;
    }
    if (source.updatedAt !== mapping.sourceUpdatedAt)
      add(
        "SOURCE_STALE",
        "대응표를 확인한 뒤 자료가 변경되었습니다. 파일을 다시 확인해 주세요.",
        field,
        mapping.sourceId,
      );
    const files = input.originalFiles.filter((entry) => entry.sourceId === mapping.sourceId);
    const file = files.length === 1 ? files[0] : undefined;
    if (!file?.exists) {
      add(
        "ORIGINAL_MISSING",
        "원본 저장소에서 파일 존재를 확인하지 못했습니다.",
        field,
        mapping.sourceId,
      );
      continue;
    }
    if (
      file.originalName !== source.originalName ||
      file.mimeType !== source.mimeType ||
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes <= 0
    ) {
      add(
        "ORIGINAL_METADATA_INVALID",
        "보관 파일의 이름·형식·크기를 자료 정보와 다시 확인해 주세요.",
        field,
        mapping.sourceId,
      );
      continue;
    }
    attachments.push({
      fieldKey: field.key,
      label: fieldLabel(field),
      sourceId: source.id,
      sourceUpdatedAt: source.updatedAt,
      originalName: file.originalName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      accept: field.accept,
      multiple: field.multiple,
      confirmed: mapping.confirmed,
    });
    if (field.accept?.trim()) {
      const match = acceptMatch(field.accept, file);
      if (match === "mismatch")
        add(
          "FILE_TYPE_REJECTED",
          "파일의 확장자·형식 정보가 공식 파일 항목에 표시된 허용 형식과 맞지 않습니다.",
          field,
          mapping.sourceId,
        );
      if (match === "unknown")
        add(
          "FILE_TYPE_UNVERIFIED",
          "허용 형식 또는 파일 형식 정보가 불명확하여 일치를 확인할 수 없습니다.",
          field,
          mapping.sourceId,
        );
    } else
      add(
        "FILE_TYPE_LIMIT_UNKNOWN",
        "공식 항목의 허용 파일 형식이 확인되지 않았습니다. 기관 안내를 직접 확인해 주세요.",
        field,
        mapping.sourceId,
        "warning",
      );
    add(
      "FILE_SIZE_LIMIT_UNKNOWN",
      "현재 화면에서 공식 첨부 용량 제한을 확인하지 못했습니다. 파일 크기만 표시하며 임의 한도를 적용하지 않습니다.",
      field,
      mapping.sourceId,
      "warning",
    );
  }

  for (const field of screen.fields) {
    if (!field.required) continue;
    const support = ventureFieldSupport(field);
    if (
      (support === "text" && !textCounts.has(field.key)) ||
      (support === "file" && !attachmentCounts.has(field.key))
    ) {
      add(
        "REQUIRED_FIELD_UNMAPPED",
        "공식 화면의 필수 항목을 아직 자료와 연결하지 않았습니다.",
        field,
      );
    }
  }
  return report();
}
