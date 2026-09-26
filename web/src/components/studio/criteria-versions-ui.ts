import { caseSchema, type StudioCase } from "@/lib/studio-schema";
import { applicationMetadata } from "@/lib/studio-application-types";
import {
  applicationCriteriaContextSchema,
  criteriaVersionMutationSchema,
  criteriaVersionDetailsSchema,
  latestApplicationCriteriaBinding,
  type CriteriaVersion,
  type CriteriaVersionMutation,
  type CriteriaVersionDetails,
} from "@/lib/studio-criteria-version-types";

export type CriteriaCommand = CriteriaVersionMutation extends infer Mutation
  ? Mutation extends CriteriaVersionMutation
    ? Omit<Mutation, "revision" | "clientRequestId">
    : never
  : never;
export function emptyCriteriaVersion(previous?: CriteriaVersion): CriteriaCommand {
  return {
    action: "append-criteria-version",
    criteriaId: previous?.criteriaId ?? null,
    previousVersionId: previous?.id ?? null,
    details: previous
      ? { ...structuredClone(previous.details), checkedOn: "" }
      : {
          title: "",
          versionLabel: "",
          applicationPath: "",
          checkedOn: "",
          sources: [],
          documents: [],
        },
    recordedBy: "",
    reason: "",
  };
}
export function emptyCriteriaPin(): CriteriaCommand {
  return {
    action: "pin-application-criteria",
    applicationId: "",
    applicationMetadataVersionId: "",
    criteriaVersionId: "",
    criteriaContentSha256: "",
    previousBindingId: null,
    recordedBy: "",
    reason: "",
  };
}
export function latestCriteriaVersions(company: StudioCase) {
  const records = new Map<string, CriteriaVersion>();
  for (const record of company.criteriaVersions ?? [])
    if (record.caseId === company.id) records.set(record.criteriaId, record);
  return [...records.values()];
}
export function criteriaApplicationUiContext(company: StudioCase, applicationId: string) {
  const binding = latestApplicationCriteriaBinding(company, applicationId);
  const contexts = (company.applicationCriteriaContexts ?? []).filter(
    (item) => item.applicationId === applicationId,
  );
  if (contexts.length !== 1) return { binding, context: null };
  const parsed = applicationCriteriaContextSchema.safeParse(contexts[0].context);
  if (
    !parsed.success ||
    parsed.data.bindingId !== (binding?.id ?? null) ||
    parsed.data.criteriaVersionId !== (binding?.criteriaVersionId ?? null) ||
    (!binding && parsed.data.status !== "unpinned") ||
    (binding && parsed.data.status === "unpinned") ||
    (parsed.data.status === "pinned-unverified" && parsed.data.reasons.length > 0)
  )
    return { binding, context: null };
  return { binding, context: parsed.data };
}
async function sha(value: unknown) {
  const result = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function criteriaCommandProblem(company: StudioCase, input: CriteriaCommand) {
  const parsed = criteriaVersionMutationSchema.safeParse({
    ...input,
    revision: company.revision,
    clientRequestId: "00000000-0000-4000-8000-000000000001",
  });
  if (!parsed.success)
    return (
      parsed.error.issues.find((issue) => issue.code === "custom")?.message ??
      "필수 항목과 입력 형식을 확인해 주세요."
    );
  if (input.action === "append-criteria-version") {
    if (input.criteriaId) {
      const previous = latestCriteriaVersions(company).find(
        (item) => item.criteriaId === input.criteriaId,
      );
      if (
        !previous ||
        previous.id !== input.previousVersionId ||
        (await sha(criteriaVersionDetailsSchema.parse(previous.details))) !== previous.contentSha256
      )
        return "정정할 기준의 최신 버전과 내용을 다시 확인해 주세요.";
    }
  } else {
    const matches = (company.criteriaVersions ?? []).filter(
        (item) => item.caseId === company.id && item.id === input.criteriaVersionId,
      ),
      record = matches.length === 1 ? matches[0] : null;
    if (
      !record ||
      record.contentSha256 !== input.criteriaContentSha256 ||
      (await sha(criteriaVersionDetailsSchema.parse(record.details))) !==
        input.criteriaContentSha256
    )
      return "같은 회사의 정확한 기준 버전을 다시 선택해 주세요.";
    const application = applicationMetadata(company, input.applicationId);
    if (
      company.applications.filter((item) => item.id === input.applicationId).length !== 1 ||
      !application ||
      application.metadataVersionId !== input.applicationMetadataVersionId
    )
      return "연결할 신청 회차의 현재 정보를 다시 선택해 주세요.";
    if (
      (latestApplicationCriteriaBinding(company, input.applicationId)?.id ?? null) !==
      input.previousBindingId
    )
      return "회차의 기준 연결 이력이 바뀌었습니다. 최신 연결을 확인해 주세요.";
  }
  return "";
}
export async function criteriaSaveAcknowledged(
  raw: unknown,
  company: StudioCase,
  nonce: string,
  input: CriteriaCommand,
) {
  const saved = caseSchema.safeParse(raw),
    parsed = criteriaVersionMutationSchema.safeParse({
      ...input,
      revision: company.revision,
      clientRequestId: nonce,
    });
  if (
    !saved.success ||
    !parsed.success ||
    saved.data.id !== company.id ||
    saved.data.revision < company.revision
  )
    return false;
  const records = [
    ...saved.data.criteriaVersions,
    ...saved.data.applicationCriteriaBindings,
  ].filter((record) => record.clientRequestId === nonce);
  if (records.length !== 1 || records[0].caseId !== company.id) return false;
  const { revision: ignoredRevision, clientRequestId: ignoredNonce, ...canonical } = parsed.data;
  void ignoredRevision;
  void ignoredNonce;
  const record = records[0];
  if (record.inputDigest !== (await sha(canonical))) return false;
  if (input.action === "append-criteria-version") {
    if (!("details" in record)) return false;
    const previous = input.criteriaId
      ? latestCriteriaVersions(company).find((item) => item.criteriaId === input.criteriaId)
      : null;
    const command = canonical as Extract<CriteriaCommand, { action: "append-criteria-version" }>;
    return (
      record.criteriaId === (command.criteriaId ?? record.id) &&
      record.previousVersionId === command.previousVersionId &&
      record.version === (previous?.version ?? 0) + 1 &&
      record.recordedBy === command.recordedBy &&
      record.reason === command.reason &&
      JSON.stringify(record.details) === JSON.stringify(command.details) &&
      record.contentSha256 === (await sha(command.details))
    );
  }
  if (!("applicationId" in record)) return false;
  const application = applicationMetadata(company, input.applicationId),
    criteria = company.criteriaVersions.find(
      (item) => item.id === input.criteriaVersionId && item.caseId === company.id,
    );
  if (!application || !criteria) return false;
  const expectedSnapshot = {
    metadataVersionId: application.metadataVersionId,
    title: application.title,
    kind: application.kind,
    plannedOn: application.plannedOn,
    criteriaNote: application.criteriaNote,
    previousApplicationId: application.previousApplicationId,
  };
  const command = canonical as Extract<CriteriaCommand, { action: "pin-application-criteria" }>;
  const { title, versionLabel, applicationPath, checkedOn } = criteria.details;
  return (
    record.applicationId === command.applicationId &&
    record.criteriaVersionId === command.criteriaVersionId &&
    record.criteriaContentSha256 === command.criteriaContentSha256 &&
    record.previousBindingId === command.previousBindingId &&
    record.version ===
      (latestApplicationCriteriaBinding(company, input.applicationId)?.version ?? 0) + 1 &&
    record.criteriaId === criteria.criteriaId &&
    record.criteriaVersion === criteria.version &&
    record.recordedBy === command.recordedBy &&
    record.reason === command.reason &&
    JSON.stringify(record.criteriaSummary) ===
      JSON.stringify({ title, versionLabel, applicationPath, checkedOn }) &&
    JSON.stringify(record.applicationSnapshot) === JSON.stringify(expectedSnapshot) &&
    record.companySnapshot.revision === company.revision &&
    record.companySnapshot.companyName === company.profile.companyName &&
    record.companySnapshot.businessNumber === company.profile.businessNumber
  );
}
export function newCriteriaDocument(): CriteriaVersionDetails["documents"][number] {
  return {
    id: crypto.randomUUID(),
    name: "",
    appliesTo: "",
    period: "",
    issueDateCondition: "",
    alternativeCondition: "",
    autoLinkGuidance: "",
    note: "",
  };
}
