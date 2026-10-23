import { claimReceiptFixture, agencyId } from "./claim-review-receipt";
import {
  preparedPackageRecordSchema,
  preparedPackageSummary,
} from "../../src/lib/studio-prepared-package-types";
export function preparedDetailsFixture() {
  const company = claimReceiptFixture().company;
  company.profile.companyName = "합성 준비본 보관 내용 기업";
  const sourceId = agencyId(620),
    archiveId = agencyId(621),
    nonce = agencyId(622);
  const time = "2026-10-14T01:00:00.000Z",
    hash = "a".repeat(64);
  const plan = structuredClone(company.plans.at(-1)!);
  plan.content.summary = "  보관 당시 요약\n현재 원고와 다릅니다.  ";
  plan.content.sections[0].content = "  보관 당시 본문\n<script>문자 그대로</script>  ";
  plan.review = [
    {
      id: "historical-review",
      severity: "warning",
      category: "semantic-evidence",
      sectionKey: plan.content.sections[0].key,
      message: "보관 당시 주장 근거 대조 필요",
      action: "시험 자료의 기준일 확인",
      sourceIds: [],
    },
  ];
  const record = preparedPackageRecordSchema.parse({
    id: archiveId,
    version: 1,
    caseId: company.id,
    caseRevision: company.revision,
    clientRequestId: nonce,
    requestDigest: hash,
    input: {
      revision: company.revision,
      planId: plan.id,
      sourceIds: [sourceId],
      clientRequestId: nonce,
    },
    createdAt: time,
    scope: "local-preparation-only",
    company: { profile: company.profile, snapshotSha256: hash },
    plan: { ...plan, contentSha256: hash },
    sourceIds: [sourceId],
    sources: [
      {
        source: {
          id: sourceId,
          name: "보관 당시 기술자료",
          originalName: "보관-원본.pdf",
          kind: "technology",
          mimeType: "application/pdf",
          extraction: "pending",
          warnings: [],
          createdAt: time,
          updatedAt: time,
        },
        sourceSha256: hash,
        textSha256: hash,
        originalSha256: hash,
        originalSizeBytes: 1024,
      },
    ],
    review: {
      storedFindings: plan.review,
      currentRuleFindings: [],
      confirmedAt: plan.confirmedAt,
      unconfirmedSectionKeys: plan.content.sections
        .filter((s) => s.needsConfirmation)
        .map((s) => s.key),
      currentEvidence: false,
      latestPlanVersion: true,
      draft: true,
      draftReasons: ["PLAN_NOT_CURRENT", "NOT_REVIEWED", "constructor"],
    },
    zip: { fileName: "venturepass-preparation-package.zip", sha256: hash, sizeBytes: 100 },
  });
  company.revision++;
  company.sources = [
    {
      ...record.sources[0].source,
      name: "현재 이름으로 바뀐 자료",
      originalName: "현재-다른-원본.pdf",
      text: "현재 본문",
      extraction: "manual",
    },
  ];
  company.plans.at(-1)!.content.sections[0].content = "현재 수정된 원고 본문";
  const emptyRecord = preparedPackageRecordSchema.parse({
    ...record,
    id: agencyId(623),
    version: 2,
    clientRequestId: agencyId(624),
    input: { ...record.input, clientRequestId: agencyId(624), sourceIds: [] },
    sourceIds: [],
    sources: [],
    review: { ...record.review, draftReasons: [], draft: false },
  });
  return {
    company,
    record,
    emptyRecord,
    summaries: [preparedPackageSummary(record), preparedPackageSummary(emptyRecord)],
  };
}
