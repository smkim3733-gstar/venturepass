import { caseSchema, type StudioCase } from "../../src/lib/studio-schema";
import {
  responsePreparationSchema,
  responsePreparationInputSchema,
  type ResponsePreparationInput,
} from "../../src/lib/studio-response-preparation-types";
import { workflowTaskFixture, agencyId } from "./workflow-task-receipt";
export { agencyId };
export function responseReceiptFixture() {
  const company = workflowTaskFixture().company;
  company.profile.companyName = "합성 보완 답변 준비 기업";
  const request = company.agencyRecords
    .filter((r) => r.kind === "request" || r.kind === "request-correction")
    .at(-1)!;
  if (!request || !("requestRecordId" in request)) throw new Error("Expected synthetic request");
  const plan = company.plans.at(-1)!,
    section = plan.content.sections[0];
  const prior = responsePreparationSchema.parse({
    id: agencyId(80),
    preparationId: agencyId(80),
    previousVersionId: null,
    version: 1,
    clientRequestId: agencyId(81),
    inputDigest: "a".repeat(64),
    recordedAt: "2026-10-10T00:00:00.000Z",
    origin: "manual",
    mode: "assisted",
    reviewStatus: "unreviewed",
    requestRecordId: request.requestRecordId,
    requestVersionId: request.id,
    title: "이전 답변 준비",
    items: [
      {
        id: agencyId(82),
        requestQuote: request.body,
        summary: "같은 요약",
        planClaim: null,
        evidence: [],
        gap: "첫 부족 자료",
        draft: "이전 첫 답변",
      },
      {
        id: agencyId(83),
        requestQuote: request.body,
        summary: "같은 요약",
        planClaim: { planId: plan.id, sectionKey: section.key, quote: section.content },
        evidence: [],
        gap: "둘째 부족 자료",
        draft: "이전 둘째 답변",
      },
    ],
    sourceSnapshots: [],
    planSnapshots: [{ planId: plan.id, version: plan.version, contentSha256: "c".repeat(64) }],
  });
  company.responsePreparations = [prior];
  const raw = {
    title: "  새 보완 답변 준비  ",
    summaries: ["  첫 항목 요약  ", "  둘째 항목 요약  "],
    gaps: ["  첫 확보 이유\n다음 줄  ", "  둘째 확보 이유\n다음 줄  "],
    drafts: ["  첫 답변 초안\n둘째 줄  ", "  둘째 답변 초안\n다른 줄  "],
  };
  const input = responsePreparationInputSchema.parse({
    preparationId: prior.preparationId,
    previousVersionId: prior.id,
    requestRecordId: prior.requestRecordId,
    requestVersionId: prior.requestVersionId,
    title: raw.title,
    items: prior.items.map((item, i) => ({
      ...item,
      summary: raw.summaries[i],
      gap: raw.gaps[i],
      draft: raw.drafts[i],
    })),
  });
  return { company: caseSchema.parse(company), raw, input };
}
export function responseReceiptResult(
  base: StudioCase,
  input: ResponsePreparationInput,
  nonce: string,
) {
  const saved = structuredClone(base),
    prior = base.responsePreparations.at(-1)!;
  saved.responsePreparations.push(
    responsePreparationSchema.parse({
      ...prior,
      ...input,
      id: agencyId(90),
      version: prior.version + 1,
      clientRequestId: nonce,
      inputDigest: "b".repeat(64),
      recordedAt: "2026-10-10T12:24:00.000Z",
    }),
  );
  saved.revision++;
  return caseSchema.parse(saved);
}
