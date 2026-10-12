import { caseSchema, type StudioCase } from "../../src/lib/studio-schema";
import {
  numericCheckInputSchema,
  numericCheckSchema,
  evaluateNumericCheck,
  type NumericCheckInput,
} from "../../src/lib/studio-numeric-check-types";
import { workflowTaskFixture, agencyId } from "./workflow-task-receipt";
export { agencyId };
export function numericReceiptResult(
  base: StudioCase,
  raw: NumericCheckInput,
  nonce: string,
  id = agencyId(211),
) {
  const input = numericCheckInputSchema.parse(raw),
    company = structuredClone(base);
  const previous = company.numericChecks.find((r) => r.id === input.previousVersionId);
  const recordedAt = "2026-10-12T04:00:00.000Z";
  const planIds = [
    ...new Set(
      input.observations.flatMap((r) => (r.reference?.kind === "plan" ? [r.reference.planId] : [])),
    ),
  ];
  company.numericChecks.push(
    numericCheckSchema.parse({
      ...input,
      id,
      checkId: input.checkId ?? id,
      version: (previous?.version ?? 0) + 1,
      clientRequestId: nonce,
      inputDigest: "a".repeat(64),
      origin: "manual",
      recordedAt,
      sourceSnapshots: [],
      planSnapshots: planIds.map((planId) => ({
        planId,
        version: company.plans.find((p) => p.id === planId)!.version,
        contentSha256: "b".repeat(64),
      })),
      evaluation: evaluateNumericCheck(input),
      judgement: {
        ...input.judgement,
        recordedAt: input.judgement.state === "unreviewed" ? null : recordedAt,
      },
    }),
  );
  company.revision++;
  return caseSchema.parse(company);
}
export function numericReceiptFixture() {
  let company = workflowTaskFixture().company;
  company.profile.companyName = "합성 수치 대조 저장 기업";
  company.numericChecks = [];
  const plan = structuredClone(company.plans.at(-1)!);
  plan.id = agencyId(200);
  plan.version++;
  plan.content.title = "합성 수치 원고";
  plan.content.sections[0].content =
    "이전 수량 10개, 20개, 합계 30개. 새 수량 1,200.50개, 2,300.25개, 합계 3,500.75개.";
  company.plans.push(plan);
  const initial = numericCheckInputSchema.parse({
    checkId: null,
    previousVersionId: null,
    title: "이전 수치 대조",
    observations: ["10", "20", "30"].map((valueText, i) => ({
      id: agencyId(201 + i),
      label: `이전 수치 ${i + 1}`,
      valueText,
      unit: "item",
      customUnit: "",
      period: { kind: "range", start: "2025-01-01", end: "2025-12-31" },
      basis: "reported",
      reference: {
        kind: "plan",
        planId: plan.id,
        sectionKey: plan.content.sections[0].key,
        quote: `${valueText}개`,
      },
      note: "이전 범위 메모",
    })),
    comparisons: [{ id: agencyId(204), leftId: agencyId(201), rightId: agencyId(202) }],
    formulas: [
      {
        id: agencyId(205),
        operation: "sum",
        operandIds: [agencyId(201), agencyId(202)],
        expectedId: agencyId(203),
      },
    ],
    judgement: { state: "unreviewed", reviewer: "", note: "" },
  });
  company = numericReceiptResult(company, initial, agencyId(207), agencyId(206));
  const raw = {
    title: "  새 수치 대조  ",
    reviewer: "  수치 담당자  ",
    reviewNote: "  대조 범위 확인\n추가 검토 메모  ",
    observations: ["1,200.50", "2,300.25", "3,500.75"].map((valueText, i) => ({
      label: `  새 수치 ${i + 1}  `,
      valueText,
      note: `  수치 ${i + 1} 범위\n가정 메모  `,
      quote: `${valueText}개`,
    })),
  };
  const input = numericCheckInputSchema.parse({
    ...initial,
    checkId: agencyId(206),
    previousVersionId: agencyId(206),
    title: raw.title,
    observations: initial.observations.map((o, i) => ({
      ...o,
      label: raw.observations[i].label,
      valueText: raw.observations[i].valueText,
      note: raw.observations[i].note,
      reference: { ...o.reference, quote: raw.observations[i].quote },
    })),
    judgement: { state: "needs-work", reviewer: raw.reviewer, note: raw.reviewNote },
  });
  const nonce = agencyId(210);
  return {
    company: caseSchema.parse(company),
    raw,
    input,
    nonce,
    saved: numericReceiptResult(company, input, nonce),
  };
}
