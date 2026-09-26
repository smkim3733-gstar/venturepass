import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildLocalResponseDraft,
  preparedResponseBody,
  responsePreparationInputSchema,
  registerPreparedResponseMutationSchema,
  type ResponsePreparationInput,
} from "./studio-response-preparation-types";
import {
  isResponsePreparationReplay,
  responsePreparationDigest,
  assertResponsePreparationCapacity,
} from "./studio-response-preparation";
import { originalConflicts, planConflicts } from "./studio-evidence-history";
import { caseSchema, emptyProfile } from "./studio-schema";

const input = (): ResponsePreparationInput => ({
  preparationId: null,
  previousVersionId: null,
  requestRecordId: randomUUID(),
  requestVersionId: randomUUID(),
  title: "합성 답변 준비",
  items: [
    {
      id: randomUUID(),
      requestQuote: "  정확한 요청\n🙂",
      summary: "수기 요약",
      planClaim: null,
      evidence: [],
      gap: "근거 부족",
      draft: "미검토 설명",
    },
  ],
});
describe("로컬 보완 답변 순수 계약", () => {
  it("원문 공백·HTML 모양 문자열을 보존하며 없는 근거는 확인 필요로 남긴다", () => {
    const item = input().items[0];
    item.requestQuote = "  <script>합성</script>\n🙂";
    const draft = buildLocalResponseDraft(item);
    expect(draft).toContain(item.requestQuote);
    expect(draft).toContain("미검토");
    expect(draft).toContain("근거 자료 미연결");
    expect(draft).not.toContain("검증 완료");
    expect(item.draft).toBe("미검토 설명");
  });
  it("선택한 인용만 서식화하며 초안을 임의 생성·정규화하지 않는다", () => {
    const value = input();
    value.items[0].draft = "  수기 문장\n🙂  ";
    expect(preparedResponseBody(value)).toBe("1. 수기 요약\n  수기 문장\n🙂  ");
    value.items[0].draft = "";
    expect(preparedResponseBody(value)).toContain("답변 미작성");
  });
  it("strict 입력은 서버 확인필드·반쪽 부모·중복 항목·source 중복을 거부한다", () => {
    const value = input();
    expect(
      responsePreparationInputSchema.safeParse({ ...value, reviewStatus: "reviewed" }).success,
    ).toBe(false);
    expect(
      responsePreparationInputSchema.safeParse({ ...value, preparationId: randomUUID() }).success,
    ).toBe(false);
    expect(
      responsePreparationInputSchema.safeParse({
        ...value,
        items: [value.items[0], value.items[0]],
      }).success,
    ).toBe(false);
    const ref = { sourceId: randomUUID(), sourceUpdatedAt: "now", quote: "본문", locator: "위치" };
    value.items[0].evidence = [ref, ref];
    expect(responsePreparationInputSchema.safeParse(value).success).toBe(false);
  });
  it("기관 등록 요청은 임의 본문·발송상태·서버 출처 메타를 받지 않는다", () => {
    const value = {
      action: "register-prepared-response",
      revision: 1,
      clientRequestId: randomUUID(),
      preparationId: randomUUID(),
      preparationVersionId: randomUUID(),
      previousResponseId: null,
    };
    expect(registerPreparedResponseMutationSchema.safeParse(value).success).toBe(true);
    for (const field of ["body", "responseStatus", "recordedAt", "preparedFrom"])
      expect(
        registerPreparedResponseMutationSchema.safeParse({ ...value, [field]: "forged" }).success,
      ).toBe(false);
  });
  it("단회 입력 해시는 동일 입력을 재생하고 다른 준비 내용을 충돌시킨다", () => {
    const value = input();
    const digest = responsePreparationDigest(value);
    const clientRequestId = randomUUID();
    const record = {
      ...value,
      id: randomUUID(),
      preparationId: randomUUID(),
      previousVersionId: null,
      version: 1,
      clientRequestId,
      inputDigest: digest,
      recordedAt: new Date().toISOString(),
      origin: "manual" as const,
      mode: "assisted" as const,
      reviewStatus: "unreviewed" as const,
      sourceSnapshots: [],
      planSnapshots: [],
    };
    expect(isResponsePreparationReplay([record], clientRequestId, digest)).toBe(true);
    expect(() =>
      isResponsePreparationReplay(
        [record],
        clientRequestId,
        responsePreparationDigest({ ...value, title: "다른 제목" }),
      ),
    ).toThrow();
    expect(() =>
      assertResponsePreparationCapacity(Array.from({ length: 51 }, () => record)),
    ).toThrow();
  });
  it("공통 불변 guard는 새 응답 준비와 실사 답변도 포함한다", () => {
    const company = caseSchema.parse({
      id: randomUUID(),
      profile: { ...emptyProfile(), companyName: "합성 공통 근거 회사" },
      sources: [],
      analysis: null,
      selectedCandidateId: null,
      plans: [],
      tasks: [],
      stage: "preparing",
      revision: 0,
      createdAt: "now",
      updatedAt: "now",
    });
    const original = {
      sourceId: randomUUID(),
      originalName: "synthetic.pdf",
      mimeType: "application/pdf",
      sizeBytes: 12,
      sha256: "a".repeat(64),
    };
    const plan = { planId: randomUUID(), version: 1, contentSha256: "b".repeat(64) };
    const history = {
      ...company,
      responsePreparations: [{ sourceSnapshots: [{ original }], planSnapshots: [plan] }],
      visitAnswers: [
        {
          sourceSnapshots: [{ original }],
          questionSnapshot: {
            planId: plan.planId,
            planVersion: 1,
            planContentSha256: plan.contentSha256,
          },
        },
      ],
    };
    expect(originalConflicts(history, original)).toBe(false);
    expect(originalConflicts(history, { ...original, sha256: "c".repeat(64) })).toBe(true);
    expect(planConflicts(history, plan)).toBe(false);
    expect(planConflicts(history, { ...plan, contentSha256: "d".repeat(64) })).toBe(true);
  });
});
