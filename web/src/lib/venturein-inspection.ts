import { z } from "zod";

export type VentureCompanyEvidence = {
  kind: "companyName" | "businessNumber";
  label: string;
  value: string;
  source: "input" | "table" | "definition";
};

export type VentureScreenField = {
  key: string;
  kind: "input" | "textarea" | "select" | "file";
  id: string | null;
  name: string | null;
  type: string;
  labels: string[];
  required: boolean;
  maxLength: number | null;
  accept: string | null;
  multiple: boolean;
  disabled: boolean;
  readOnly: boolean;
  options: { label: string; value: string; disabled: boolean }[];
};

export type VentureScreenSnapshot = {
  id: string;
  observedAt: string;
  url: string;
  title: string;
  companyEvidence: VentureCompanyEvidence[];
  fields: VentureScreenField[];
  truncated: boolean;
  warnings: string[];
};

export type VentureCompanyVerification = {
  status: "matched" | "mismatch" | "unverified";
  expectedBusinessNumber: string | null;
  observedBusinessNumbers: string[];
  reason: string;
};

export class VentureInspectionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "VentureInspectionError";
  }
}

const companyLabels = {
  companyName: ["기업명", "업체명", "상호"],
  businessNumber: ["사업자등록번호", "사업자번호"],
} as const;
const inputTypes = [
  "text",
  "search",
  "email",
  "tel",
  "url",
  "number",
  "date",
  "datetime-local",
  "month",
  "week",
  "time",
  "checkbox",
  "radio",
];
const secretPattern =
  /password|passwd|pwd|csrf|xsrf|token|secret|session|captcha|otp|auth|credential|api.?key|cookie|login|sign.?in|user.?id|user.?name|비밀번호|비번|인증번호|인증코드|보안문자|로그인|아이디/i;

export function sanitizeVentureInspectionUrl(value: string) {
  try {
    const url = new URL(value);
    if (
      url.origin !== "https://www.smes.go.kr" ||
      !url.pathname.startsWith("/venturein/") ||
      url.username ||
      url.password ||
      /^\/venturein\/(?:auth(?:\/|$)|resources\/raonnx(?:\/|$))/i.test(url.pathname)
    )
      return null;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

const optionSchema = z
  .object({ label: z.string().max(300), value: z.string().max(300), disabled: z.boolean() })
  .strict();
const fieldSchema = z
  .object({
    key: z.string().min(1).max(100),
    kind: z.enum(["input", "textarea", "select", "file"]),
    id: z.string().max(200).nullable(),
    name: z.string().max(200).nullable(),
    type: z.string().max(40),
    labels: z.array(z.string().max(300)).max(8),
    required: z.boolean(),
    maxLength: z.number().int().min(0).max(100_000_000).nullable(),
    accept: z.string().max(500).nullable(),
    multiple: z.boolean(),
    disabled: z.boolean(),
    readOnly: z.boolean(),
    options: z.array(optionSchema).max(100),
  })
  .strict()
  .superRefine((field, context) => {
    if (secretPattern.test([field.id, field.name, ...field.labels].join(" ")))
      context.addIssue({ code: "custom", message: "Secret-related control" });
    const validType =
      field.kind === "input"
        ? inputTypes.includes(field.type)
        : field.kind === "file"
          ? field.type === "file"
          : field.kind === "textarea"
            ? field.type === "textarea"
            : ["select-one", "select-multiple"].includes(field.type);
    if (
      !validType ||
      (field.kind !== "select" && field.options.length) ||
      (field.kind !== "file" && field.accept !== null)
    )
      context.addIssue({ code: "custom", message: "Unsupported control metadata" });
  });
const evidenceSchema = z
  .object({
    kind: z.enum(["companyName", "businessNumber"]),
    label: z.string().max(300),
    value: z.string().min(1).max(200),
    source: z.enum(["input", "table", "definition"]),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (!(companyLabels[evidence.kind] as readonly string[]).includes(evidence.label))
      context.addIssue({ code: "custom", message: "Unrecognized company label" });
  });
const snapshotSchema = z
  .object({
    id: z.string().min(1).max(100),
    observedAt: z.string().datetime(),
    url: z.string().max(2000),
    title: z.string().max(200),
    companyEvidence: z.array(evidenceSchema).max(20),
    fields: z.array(fieldSchema).max(150),
    truncated: z.boolean(),
    warnings: z.array(z.string().max(300)).max(10),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (sanitizeVentureInspectionUrl(snapshot.url) !== snapshot.url)
      context.addIssue({ code: "custom", message: "Unverified or unsanitized URL" });
    if (new Set(snapshot.fields.map((field) => field.key)).size !== snapshot.fields.length)
      context.addIssue({ code: "custom", message: "Ambiguous field keys" });
    if (snapshot.fields.reduce((total, field) => total + field.options.length, 0) > 500)
      context.addIssue({ code: "custom", message: "Option observation limit exceeded" });
  });

/** Reject unexpected properties rather than accidentally retaining values or authentication data. */
export function validateVentureScreenSnapshot(value: unknown): VentureScreenSnapshot {
  const result = snapshotSchema.safeParse(value);
  if (!result.success)
    throw new VentureInspectionError(
      "INVALID_SCREEN",
      "공식 화면 확인 자료의 형식이나 수집 범위를 확인하지 못했습니다. 화면을 다시 확인해 주세요.",
    );
  return result.data;
}

export function normalizeVentureBusinessNumber(value: string): string | null {
  const trimmed = value.trim();
  if (!/^[\d\s-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/[\s-]/g, "");
  return /^\d{10}$/.test(digits) ? digits : null;
}

export function verifyVentureCompany(
  snapshot: VentureScreenSnapshot,
  expectedBusinessNumber: string,
): VentureCompanyVerification {
  const expected = normalizeVentureBusinessNumber(expectedBusinessNumber);
  const base = { expectedBusinessNumber: expected, observedBusinessNumbers: [] as string[] };
  let valid: VentureScreenSnapshot;
  try {
    valid = validateVentureScreenSnapshot(snapshot);
  } catch {
    return { ...base, status: "unverified", reason: "화면 확인 자료가 유효하지 않습니다." };
  }
  if (!expected)
    return {
      ...base,
      status: "unverified",
      reason: "앱 기업정보에 정확한 10자리 사업자등록번호가 필요합니다.",
    };
  if (valid.truncated)
    return {
      ...base,
      status: "unverified",
      reason: "화면 수집 한도를 초과하여 기업 일치를 확정할 수 없습니다.",
    };
  const evidence = valid.companyEvidence.filter((item) => item.kind === "businessNumber");
  if (!evidence.length)
    return {
      ...base,
      status: "unverified",
      reason: "현재 공식 화면에서 명시적인 사업자등록번호를 확인하지 못했습니다.",
    };
  const normalized = evidence.map((item) => normalizeVentureBusinessNumber(item.value));
  const numbers = [...new Set(normalized.filter((item): item is string => item !== null))];
  if (normalized.some((item) => item === null) || numbers.length !== 1)
    return {
      ...base,
      observedBusinessNumbers: numbers,
      status: "unverified",
      reason: "번호가 가려져 있거나 서로 다른 기업 번호가 표시되어 기업 일치를 확정할 수 없습니다.",
    };
  return {
    ...base,
    observedBusinessNumbers: numbers,
    status: numbers[0] === expected ? "matched" : "mismatch",
    reason:
      numbers[0] === expected
        ? "공식 화면의 사업자등록번호가 앱 기업정보와 정확히 일치합니다. 계정 소유권이나 제출 가능 여부를 확인한 것은 아닙니다."
        : "공식 화면의 사업자등록번호가 앱 기업정보와 다릅니다.",
  };
}

export const ventureInspectionRules = {
  companyLabels,
  inputTypes,
  secretPatternSource: secretPattern.source,
};
