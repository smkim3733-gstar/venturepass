import { caseSchema, type StudioCase } from "../../src/lib/studio-schema";
import { applicationMetadata } from "../../src/lib/studio-application-types";
import {
  criteriaVersionMutationSchema,
  criteriaVersionSchema,
  applicationCriteriaBindingSchema,
  latestApplicationCriteriaBinding,
} from "../../src/lib/studio-criteria-version-types";
import type { CriteriaCommand } from "../../src/components/studio/criteria-versions-ui";
import { linkReceiptCompany, linkId } from "./application-link-receipt";
export { linkId };
export async function criteriaReceiptHash(value: unknown) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, "0")).join("");
}
// Synthetic response-only context for this fixture's unchanged applications and company.
function contexts(company: StudioCase) {
  company.applicationCriteriaContexts = company.applications.map((a) => {
    const binding = latestApplicationCriteriaBinding(company, a.id);
    const newer =
      !!binding &&
      company.criteriaVersions.some(
        (v) => v.criteriaId === binding.criteriaId && v.version > binding.criteriaVersion,
      );
    return {
      applicationId: a.id,
      context: {
        bindingId: binding?.id ?? null,
        criteriaVersionId: binding?.criteriaVersionId ?? null,
        officialVerification: "unverified" as const,
        status: !binding
          ? ("unpinned" as const)
          : newer
            ? ("needs-review" as const)
            : ("pinned-unverified" as const),
        reasons: newer ? ["newer-criteria-version" as const] : [],
      },
    };
  });
  return caseSchema.parse(company);
}
export async function criteriaReceiptResult(
  base: StudioCase,
  input: CriteriaCommand,
  nonce: string,
  id = linkId(532),
) {
  const parsed = criteriaVersionMutationSchema.parse({
    ...input,
    revision: base.revision,
    clientRequestId: nonce,
  });
  const { revision, clientRequestId, ...command } = parsed;
  void revision;
  void clientRequestId;
  const company = structuredClone(base);
  const common = {
    id,
    caseId: base.id,
    clientRequestId: nonce,
    inputDigest: await criteriaReceiptHash(command),
    recordedAt: "2026-10-12T04:50:00.000Z",
    origin: "manual",
    officialVerification: "unverified",
  };
  if (command.action === "append-criteria-version") {
    const { action, ...fields } = command;
    void action;
    const previous = base.criteriaVersions.find((v) => v.id === command.previousVersionId);
    company.criteriaVersions.push(
      criteriaVersionSchema.parse({
        ...common,
        ...fields,
        criteriaId: command.criteriaId ?? id,
        version: (previous?.version ?? 0) + 1,
        contentSha256: await criteriaReceiptHash(command.details),
      }),
    );
  } else {
    const v = base.criteriaVersions.find((v) => v.id === command.criteriaVersionId)!;
    const a = applicationMetadata(base, command.applicationId)!;
    const { title, versionLabel, applicationPath, checkedOn } = v.details;
    company.applicationCriteriaBindings.push(
      applicationCriteriaBindingSchema.parse({
        ...common,
        applicationId: a.id,
        previousBindingId: command.previousBindingId,
        version: (latestApplicationCriteriaBinding(base, a.id)?.version ?? 0) + 1,
        criteriaId: v.criteriaId,
        criteriaVersionId: v.id,
        criteriaVersion: v.version,
        criteriaContentSha256: v.contentSha256,
        criteriaSummary: { title, versionLabel, applicationPath, checkedOn },
        applicationSnapshot: {
          metadataVersionId: a.metadataVersionId,
          title: a.title,
          kind: a.kind,
          plannedOn: a.plannedOn,
          criteriaNote: a.criteriaNote,
          previousApplicationId: a.previousApplicationId,
        },
        companySnapshot: {
          revision: base.revision,
          companyName: base.profile.companyName,
          businessNumber: base.profile.businessNumber,
        },
        recordedBy: command.recordedBy,
        reason: command.reason,
      }),
    );
  }
  company.revision++;
  return contexts(company);
}
export function criteriaReceiptPin(
  company: StudioCase,
  criteriaVersionId: string,
): Extract<CriteriaCommand, { action: "pin-application-criteria" }> {
  const a = applicationMetadata(company, company.applications[1].id)!;
  const v = company.criteriaVersions.find((v) => v.id === criteriaVersionId)!;
  return {
    action: "pin-application-criteria",
    applicationId: a.id,
    applicationMetadataVersionId: a.metadataVersionId,
    criteriaVersionId: v.id,
    criteriaContentSha256: v.contentSha256,
    previousBindingId: latestApplicationCriteriaBinding(company, a.id)?.id ?? null,
    recordedBy: "  연결 담당  ",
    reason: "  두 번째 회차에 새 조건 연결\n직접 확인한 수기 기록  ",
  };
}
export async function criteriaReceiptFixture() {
  let company = linkReceiptCompany();
  company.profile.companyName = "합성 기준 버전 기업";
  company.criteriaVersions = [];
  company.applicationCriteriaBindings = [];
  const initial: Extract<CriteriaCommand, { action: "append-criteria-version" }> = {
    action: "append-criteria-version",
    criteriaId: null,
    previousVersionId: null,
    details: {
      title: "이전 참고 기준",
      versionLabel: "초기 수기",
      applicationPath: "이전 경로",
      checkedOn: "2026-10-09",
      sources: [
        {
          title: "이전 출처",
          url: "https://example.invalid/reference",
          quote: "이전 원문 인용",
          note: "이전 확인 메모",
        },
        { title: "두 번째 출처", url: "", quote: "이전 두 번째 인용", note: "" },
      ],
      documents: [
        {
          id: linkId(501),
          name: "첫 번째 서류",
          appliesTo: "이전 대상",
          period: "이전 기간",
          issueDateCondition: "이전 발급 조건",
          alternativeCondition: "이전 대체자료",
          autoLinkGuidance: "이전 연계 안내",
          note: "이전 확인 사항",
        },
        {
          id: linkId(502),
          name: "두 번째 서류",
          appliesTo: "이전 대상2",
          period: "이전 기간2",
          issueDateCondition: "이전 발급2",
          alternativeCondition: "이전 대체2",
          autoLinkGuidance: "이전 연계2",
          note: "이전 메모2",
        },
      ],
    },
    recordedBy: "이전 담당",
    reason: "이전 기준 보존",
  };
  company = await criteriaReceiptResult(
    caseSchema.parse(company),
    initial,
    linkId(510),
    linkId(511),
  );
  company = await criteriaReceiptResult(
    company,
    {
      ...criteriaReceiptPin(company, linkId(511)),
      recordedBy: "이전 연결 담당",
      reason: "이전 연결 보존",
    },
    linkId(512),
    linkId(513),
  );
  const raw = structuredClone(initial);
  raw.criteriaId = linkId(511);
  raw.previousVersionId = linkId(511);
  raw.details.title = "  새 참고 기준  ";
  raw.details.versionLabel = "  변경 수기  ";
  raw.details.applicationPath = "  담당자 입력 경로  ";
  raw.details.checkedOn = "2026-10-12";
  raw.recordedBy = "  기준 담당  ";
  raw.reason = "  조건 변경 사유\n원문 유지  ";
  raw.details.sources = raw.details.sources.map((s, i) => ({
    ...s,
    title: `  출처 ${i + 1} 제목  `,
    url: i ? "" : "  https://example.invalid/new-reference  ",
    quote: `  출처 ${i + 1} 원문\n조건 인용  `,
    note: `  출처 ${i + 1} 메모\n미확인 사항  `,
  }));
  raw.details.documents = raw.details.documents.map((d, i) => ({
    ...d,
    name: `  서류 ${i + 1} 이름  `,
    appliesTo: `  대상 ${i + 1}\n담당자 기록  `,
    period: `  기간 ${i + 1}\n미확인 조건  `,
    issueDateCondition: `  발급 ${i + 1} 조건  `,
    alternativeCondition: `  대체 ${i + 1} 자료\n수기 안내  `,
    autoLinkGuidance: `  연계 ${i + 1} 안내\n실제 수신 아님  `,
    note: `  서류 ${i + 1} 메모\n확인 필요  `,
  }));
  const { revision, clientRequestId, ...input } = criteriaVersionMutationSchema.parse({
    ...raw,
    revision: company.revision,
    clientRequestId: linkId(531),
  });
  void revision;
  void clientRequestId;
  return { company, raw, input, nonce: linkId(531) };
}
