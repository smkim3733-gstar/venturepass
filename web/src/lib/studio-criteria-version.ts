// Node-only construction/hash checks. Client consumers use studio-criteria-version-types.
import { createHash } from "node:crypto";
import { z } from "zod";
import { applicationMetadata } from "./studio-application-types";
import { StudioError } from "./studio-http";
import {
  appendCriteriaVersionInputSchema,
  pinApplicationCriteriaInputSchema,
  criteriaVersionMutationSchema,
  criteriaVersionDetailsSchema,
  criteriaVersionSchema,
  applicationCriteriaBindingSchema,
  criteriaVersionLimits,
  criteriaContextReasonLabels,
  latestApplicationCriteriaBinding,
  type AppendCriteriaVersionInput,
  type PinApplicationCriteriaInput,
  type CriteriaVersionDetails,
  type CriteriaVersionState,
  type CriteriaVersion,
  type ApplicationCriteriaBinding,
  type ApplicationCriteriaContext,
  type CriteriaContextReason,
} from "./studio-criteria-version-types";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const metadataSchema = z
  .object({
    id: z.string().uuid(),
    clientRequestId: z.string().uuid(),
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    recordedAt: z.string().datetime(),
  })
  .strict();
export type CriteriaRecordMetadata = z.infer<typeof metadataSchema>;
export function criteriaVersionError(code: string, status = 409): never {
  const messages: Record<string, string> = {
    CRITERIA_NOT_FOUND: "같은 기업의 정확한 기준 버전을 선택해 주세요.",
    CRITERIA_VERSION_STALE: "기준 또는 회차 연결 이력이 바뀌었습니다. 최신 기록을 확인해 주세요.",
    CRITERIA_CONTENT_CHANGED:
      "보관한 기준 내용의 식별값이 다릅니다. 기존 연결을 그대로 보존합니다.",
    CRITERIA_APPLICATION_CHANGED:
      "신청 회차가 바뀌었습니다. 연결할 정확한 회차를 다시 확인해 주세요.",
    CRITERIA_REQUEST_CONFLICT: "같은 요청 식별자에 다른 기준 기록이 사용되었습니다.",
    CRITERIA_LIMIT: "기준 이력의 보관 한도를 초과했습니다. 기존 기록을 보존합니다.",
    CRITERIA_RECORD_INVALID: "기준 기록의 식별정보를 확인할 수 없습니다.",
  };
  throw new StudioError(messages[code] ?? "기준 기록을 다시 확인해 주세요.", status, code);
}
export const criteriaVersionContentSha = (details: CriteriaVersionDetails) =>
  hash(criteriaVersionDetailsSchema.parse(details));
export function criteriaVersionInputDigest(input: unknown) {
  const parsed = criteriaVersionMutationSchema.parse(input);
  const { revision: _revision, clientRequestId: _nonce, ...body } = parsed;
  void _revision;
  void _nonce;
  return hash(body);
}
export function assertCriteriaVersionCapacity(
  state: Pick<CriteriaVersionState, "criteriaVersions" | "applicationCriteriaBindings">,
) {
  const versions = state.criteriaVersions ?? [],
    bindings = state.applicationCriteriaBindings ?? [];
  if (
    versions.length > criteriaVersionLimits.versions ||
    bindings.length > criteriaVersionLimits.bindings ||
    JSON.stringify({ versions, bindings }).length > criteriaVersionLimits.characters
  )
    criteriaVersionError("CRITERIA_LIMIT", 413);
}
function assertVersion(state: CriteriaVersionState, value: CriteriaVersion) {
  if (!criteriaVersionSchema.safeParse(value).success || value.caseId !== state.id)
    criteriaVersionError("CRITERIA_NOT_FOUND");
  if (criteriaVersionContentSha(value.details) !== value.contentSha256)
    criteriaVersionError("CRITERIA_CONTENT_CHANGED");
  const { title, versionLabel, applicationPath, checkedOn } = value.details;
  for (const binding of state.applicationCriteriaBindings ?? []) {
    if (binding.criteriaVersionId !== value.id) continue;
    if (
      binding.caseId !== state.id ||
      binding.criteriaId !== value.criteriaId ||
      binding.criteriaVersion !== value.version ||
      binding.criteriaContentSha256 !== value.contentSha256 ||
      JSON.stringify(binding.criteriaSummary) !==
        JSON.stringify({ title, versionLabel, applicationPath, checkedOn })
    )
      criteriaVersionError("CRITERIA_CONTENT_CHANGED");
  }
  return value;
}
function exactVersion(state: CriteriaVersionState, id: string) {
  const found = (state.criteriaVersions ?? []).filter((item) => item.id === id);
  if (found.length !== 1) criteriaVersionError("CRITERIA_NOT_FOUND", 404);
  return assertVersion(state, found[0]);
}
function currentApplication(state: CriteriaVersionState, id: string) {
  if (state.applications.filter((item) => item.id === id).length !== 1)
    criteriaVersionError("CRITERIA_APPLICATION_CHANGED", 404);
  const value = applicationMetadata(state, id);
  if (!value) criteriaVersionError("CRITERIA_APPLICATION_CHANGED", 404);
  return value;
}
function applicationSnapshot(state: CriteriaVersionState, id: string) {
  const value = currentApplication(state, id);
  return {
    metadataVersionId: value.metadataVersionId,
    title: value.title,
    kind: value.kind,
    plannedOn: value.plannedOn,
    criteriaNote: value.criteriaNote,
    previousApplicationId: value.previousApplicationId,
  };
}
function assertBinding(state: CriteriaVersionState, binding: ApplicationCriteriaBinding) {
  if (!applicationCriteriaBindingSchema.safeParse(binding).success || binding.caseId !== state.id)
    criteriaVersionError("CRITERIA_RECORD_INVALID");
  const version = exactVersion(state, binding.criteriaVersionId);
  const { title, versionLabel, applicationPath, checkedOn } = version.details;
  if (
    version.criteriaId !== binding.criteriaId ||
    version.version !== binding.criteriaVersion ||
    version.contentSha256 !== binding.criteriaContentSha256 ||
    JSON.stringify(binding.criteriaSummary) !==
      JSON.stringify({ title, versionLabel, applicationPath, checkedOn })
  )
    criteriaVersionError("CRITERIA_CONTENT_CHANGED");
  currentApplication(state, binding.applicationId);
  return version;
}
/** Call from the store's authorized company transaction before CAS; replay never restores an old pin. */
export function isCriteriaVersionReplay(
  state: CriteriaVersionState,
  nonce: string,
  digest: string,
) {
  const versions = (state.criteriaVersions ?? []).filter((item) => item.clientRequestId === nonce),
    bindings = (state.applicationCriteriaBindings ?? []).filter(
      (item) => item.clientRequestId === nonce,
    );
  if (versions.length + bindings.length === 0) return false;
  if (
    versions.length + bindings.length !== 1 ||
    (versions[0] ?? bindings[0]).inputDigest !== digest
  )
    criteriaVersionError("CRITERIA_REQUEST_CONFLICT");
  if (versions[0]) assertVersion(state, versions[0]);
  else assertBinding(state, bindings[0]);
  return true;
}
function metadata(
  state: CriteriaVersionState,
  value: CriteriaRecordMetadata,
  action: "append-criteria-version" | "pin-application-criteria",
  input: AppendCriteriaVersionInput | PinApplicationCriteriaInput,
) {
  const parsed = metadataSchema.parse(value);
  z.string().uuid().parse(state.id);
  if (
    [...(state.criteriaVersions ?? []), ...(state.applicationCriteriaBindings ?? [])].some(
      (item) => item.id === parsed.id || item.clientRequestId === parsed.clientRequestId,
    )
  )
    criteriaVersionError("CRITERIA_REQUEST_CONFLICT");
  if (
    parsed.inputDigest !==
    criteriaVersionInputDigest({
      action,
      revision: state.revision,
      clientRequestId: parsed.clientRequestId,
      ...input,
    })
  )
    criteriaVersionError("CRITERIA_RECORD_INVALID");
  return {
    ...parsed,
    caseId: state.id,
    origin: "manual" as const,
    officialVerification: "unverified" as const,
  };
}
export function buildCriteriaVersion(
  state: CriteriaVersionState,
  raw: AppendCriteriaVersionInput,
  server: CriteriaRecordMetadata,
): CriteriaVersion {
  const input = appendCriteriaVersionInputSchema.parse(raw),
    common = metadata(state, server, "append-criteria-version", input),
    versions = state.criteriaVersions ?? [];
  let previous: CriteriaVersion | null = null;
  if (input.criteriaId) {
    const chain = versions.filter((item) => item.criteriaId === input.criteriaId);
    if (!chain.length) criteriaVersionError("CRITERIA_NOT_FOUND", 404);
    for (const item of chain) assertVersion(state, item);
    previous = chain.at(-1)!;
    if (previous.id !== input.previousVersionId) criteriaVersionError("CRITERIA_VERSION_STALE");
  }
  const record = criteriaVersionSchema.parse({
    ...common,
    ...input,
    criteriaId: previous?.criteriaId ?? common.id,
    previousVersionId: previous?.id ?? null,
    version: (previous?.version ?? 0) + 1,
    contentSha256: criteriaVersionContentSha(input.details),
  });
  assertCriteriaVersionCapacity({ ...state, criteriaVersions: [...versions, record] });
  return record;
}
export function buildApplicationCriteriaBinding(
  state: CriteriaVersionState,
  raw: PinApplicationCriteriaInput,
  server: CriteriaRecordMetadata,
): ApplicationCriteriaBinding {
  const input = pinApplicationCriteriaInputSchema.parse(raw),
    common = metadata(state, server, "pin-application-criteria", input),
    version = exactVersion(state, input.criteriaVersionId);
  if (input.criteriaContentSha256 !== version.contentSha256)
    criteriaVersionError("CRITERIA_CONTENT_CHANGED");
  const snapshot = applicationSnapshot(state, input.applicationId);
  if (snapshot.metadataVersionId !== input.applicationMetadataVersionId)
    criteriaVersionError("CRITERIA_APPLICATION_CHANGED");
  const previous = latestApplicationCriteriaBinding(state, input.applicationId);
  if ((previous?.id ?? null) !== input.previousBindingId)
    criteriaVersionError("CRITERIA_VERSION_STALE");
  if (previous) assertBinding(state, previous);
  const { title, versionLabel, applicationPath, checkedOn } = version.details;
  const binding = applicationCriteriaBindingSchema.parse({
    ...common,
    applicationId: input.applicationId,
    previousBindingId: input.previousBindingId,
    version: (previous?.version ?? 0) + 1,
    criteriaId: version.criteriaId,
    criteriaVersionId: version.id,
    criteriaVersion: version.version,
    criteriaContentSha256: version.contentSha256,
    criteriaSummary: { title, versionLabel, applicationPath, checkedOn },
    applicationSnapshot: snapshot,
    companySnapshot: {
      revision: state.revision,
      companyName: state.profile.companyName,
      businessNumber: state.profile.businessNumber,
    },
    recordedBy: input.recordedBy,
    reason: input.reason,
  });
  assertCriteriaVersionCapacity({
    ...state,
    applicationCriteriaBindings: [...(state.applicationCriteriaBindings ?? []), binding],
  });
  return binding;
}
/** Derived response-only status. Never changes the pin, diagnosis, plans or eligibility. */
export function applicationCriteriaContext(
  state: CriteriaVersionState,
  applicationId: string,
): ApplicationCriteriaContext {
  const binding = latestApplicationCriteriaBinding(state, applicationId);
  return criteriaBindingContext(state, applicationId, binding);
}
function criteriaBindingContext(
  state: CriteriaVersionState,
  applicationId: string,
  binding: ApplicationCriteriaBinding | null,
): ApplicationCriteriaContext {
  const base = {
    bindingId: binding?.id ?? null,
    criteriaVersionId: binding?.criteriaVersionId ?? null,
    officialVerification: "unverified" as const,
  };
  if (!binding) return { ...base, status: "unpinned", reasons: [] };
  const reasons: CriteriaContextReason[] = [];
  let version: CriteriaVersion | null = null;
  try {
    version = assertBinding(state, binding);
  } catch (error) {
    reasons.push(
      error instanceof StudioError && error.code === "CRITERIA_NOT_FOUND"
        ? "criteria-missing"
        : error instanceof StudioError && error.code === "CRITERIA_CONTENT_CHANGED"
          ? "criteria-changed"
          : error instanceof StudioError && error.code === "CRITERIA_APPLICATION_CHANGED"
            ? "application-missing"
            : "binding-invalid",
    );
  }
  if (reasons.length) return { ...base, status: "unresolved", reasons };
  if (
    JSON.stringify(applicationSnapshot(state, applicationId)) !==
    JSON.stringify(binding.applicationSnapshot)
  )
    reasons.push("application-changed");
  if (
    state.profile.companyName !== binding.companySnapshot.companyName ||
    state.profile.businessNumber !== binding.companySnapshot.businessNumber
  )
    reasons.push("company-changed");
  if (
    (state.criteriaVersions ?? []).some(
      (item) =>
        item.caseId === state.id &&
        item.criteriaId === version!.criteriaId &&
        item.version > version!.version,
    )
  )
    reasons.push("newer-criteria-version");
  return { ...base, status: reasons.length ? "needs-review" : "pinned-unverified", reasons };
}

/** Add derived response fields to a copy; never persist them into the history or case JSON. */
export function withApplicationCriteriaContexts<T extends CriteriaVersionState>(state: T) {
  return {
    ...state,
    applicationCriteriaContexts: state.applications.map((application) => ({
      applicationId: application.id,
      context: applicationCriteriaContext(state, application.id),
    })),
  };
}

// Escape text rather than interpreting user URLs/HTML/Markdown as active content.
const display = (value: string) =>
  value.trim()
    ? value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replace(/[\\`*_{}\[\]()#+.!|~-]/g, "\\$&")
        .replaceAll("\r", "")
        .replaceAll("\n", "  \n")
    : "미확인 · 기록 없음";
/** Read-only export for one exact historical binding; never substitutes the latest pin. */
export function renderCriteriaReference(state: CriteriaVersionState, bindingId: string): string {
  z.string().uuid().parse(bindingId);
  const matches = (state.applicationCriteriaBindings ?? []).filter((item) => item.id === bindingId);
  if (matches.length !== 1) criteriaVersionError("CRITERIA_NOT_FOUND", 404);
  const binding = matches[0],
    version = assertBinding(state, binding);
  const context = criteriaBindingContext(state, binding.applicationId, binding);
  const lines = [
    "# 신청 회차에 고정한 수동 참고 기준",
    "",
    "담당자가 기록한 참고자료입니다. 기관 확인·자격 충족·접수 결과가 아닙니다. 앱 내장 사전진단 기준과 별개이며, 출처 URL을 자동 조회하지 않았습니다. 공란은 미확인입니다.",
    "",
    "## 고정 당시 회차와 연결",
    `- 연결 ID: ${binding.id}`,
    `- 연결 버전: ${binding.version}`,
    `- 기록 시각: ${binding.recordedAt}`,
    `- 회차 ID: ${binding.applicationId}`,
    `- 회차 정보 버전: ${binding.applicationSnapshot.metadataVersionId}`,
    `- 당시 제목: ${display(binding.applicationSnapshot.title)}`,
    `- 당시 구분: ${binding.applicationSnapshot.kind === "new" ? "신규" : "갱신"}`,
    `- 당시 예정일: ${display(binding.applicationSnapshot.plannedOn)}`,
    `- 당시 기준 메모: ${display(binding.applicationSnapshot.criteriaNote)}`,
    `- 당시 회사명: ${display(binding.companySnapshot.companyName)}`,
    `- 당시 사업자번호: ${display(binding.companySnapshot.businessNumber)}`,
    `- 기록자: ${display(binding.recordedBy)}`,
    `- 연결 이유: ${display(binding.reason)}`,
    "",
    "## 정확히 고정한 기준 버전",
    `- 기준 ID: ${version.criteriaId}`,
    `- 버전 ID: ${version.id}`,
    `- 버전 번호: ${version.version}`,
    `- 내용 SHA-256: ${version.contentSha256}`,
    `- 제목: ${display(version.details.title)}`,
    `- 버전 표기: ${display(version.details.versionLabel)}`,
    `- 신청 경로 메모: ${display(version.details.applicationPath)}`,
    `- 출처 확인일 기록: ${display(version.details.checkedOn)}`,
    `- 기준 기록자: ${display(version.recordedBy)}`,
    `- 기준 기록 이유: ${display(version.reason)}`,
    "",
    "## 사용자 기록 출처",
  ];
  if (!version.details.sources.length) lines.push("미확인 · 기록 없음");
  version.details.sources.forEach((source, index) =>
    lines.push(
      "",
      `### 출처 ${index + 1}`,
      `- 제목: ${display(source.title)}`,
      `- URL 기록: ${display(source.url)}`,
      `- 인용 기록: ${display(source.quote)}`,
      `- 메모: ${display(source.note)}`,
    ),
  );
  lines.push("", "## 서류 조건 기록");
  if (!version.details.documents.length) lines.push("미확인 · 기록 없음");
  version.details.documents.forEach((document, index) =>
    lines.push(
      "",
      `### 서류 ${index + 1}: ${display(document.name)}`,
      `- 식별자: ${document.id}`,
      `- 적용 대상: ${display(document.appliesTo)}`,
      `- 대상 기간: ${display(document.period)}`,
      `- 발급일 조건: ${display(document.issueDateCondition)}`,
      `- 대체 서류 조건: ${display(document.alternativeCondition)}`,
      `- 자동연계 안내 기록: ${display(document.autoLinkGuidance)}`,
      `- 메모: ${display(document.note)}`,
    ),
  );
  lines.push(
    "",
    "## 출력 시 재확인 안내",
    "과거 기록을 수정하거나 최신 기준으로 교체하지 않았습니다. 안내는 현재 보관 이력과 비교한 결과이며 공식 최신성 검증이 아닙니다.",
  );
  lines.push(
    ...(context.reasons.length
      ? context.reasons.map((reason) => `- ${criteriaContextReasonLabels[reason]}`)
      : ["- 보관 이력 비교에서 변경 사유가 발견되지 않았습니다. 기준 내용은 여전히 미검증입니다."]),
  );
  return `${lines.join("\n")}\n`;
}

export function buildCriteriaReference(
  store: { get(id: string): CriteriaVersionState },
  caseId: string,
  bindingId: string,
) {
  z.string().uuid().parse(caseId);
  const record = store.get(caseId);
  if (record.id !== caseId) criteriaVersionError("CRITERIA_NOT_FOUND", 404);
  const before = JSON.stringify(record),
    markdown = renderCriteriaReference(record, bindingId);
  if (JSON.stringify(store.get(caseId)) !== before)
    throw new StudioError(
      "기업 기록이 바뀌었습니다. 정확한 연결을 다시 선택해 주세요.",
      409,
      "STALE_REVISION",
    );
  return markdown;
}
