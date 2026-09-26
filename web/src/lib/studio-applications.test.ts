import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { caseSchema, emptyProfile } from "./studio-schema";
import {
  applicationMetadata,
  applicationMutationSchema,
  type ApplicationMutation,
} from "./studio-application-types";
import {
  applicationInputDigest,
  applyApplicationMutation,
  isApplicationReplay,
} from "./studio-applications";

function company() {
  return caseSchema.parse({
    id: randomUUID(),
    profile: { ...emptyProfile(), companyName: "합성 회사" },
    sources: [],
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: "preparing",
    revision: 0,
    createdAt: "2026-09-25T00:00:00.000Z",
    updatedAt: "2026-09-25T00:00:00.000Z",
  });
}
const create = (): ApplicationMutation => ({
  action: "create-application",
  revision: 0,
  clientRequestId: randomUUID(),
  title: "최초 회차",
  kind: "new",
  plannedOn: "",
  criteriaNote: "기준 확인 필요",
  previousApplicationId: null,
});
const context = {
  evidenceRevision: 0,
  readOriginal: () => {
    throw new Error("No original read expected");
  },
};
describe("신청회차 순수 계약과 귀속 규칙", () => {
  it("legacy는 회차를 만들지 않고 빈 이력으로 읽는다", () => {
    const value = company();
    expect(value.applications).toEqual([]);
    expect(value.applicationEvents).toEqual([]);
    expect(applicationMetadata(value, randomUUID())).toBeNull();
  });
  it("strict 요청은 서버 메타와 잘못된 날짜·중복 ID를 거부한다", () => {
    for (const extra of [
      { recordedAt: "now" },
      { officialVerification: "verified" },
      { plannedOn: "2026-02-30" },
    ])
      expect(applicationMutationSchema.safeParse({ ...create(), ...extra }).success).toBe(false);
    const id = randomUUID();
    expect(
      applicationMutationSchema.safeParse({
        action: "record-application-submission",
        revision: 0,
        clientRequestId: id,
        applicationId: id,
        planId: id,
        sourceIds: [id, id],
        taskIds: [],
        receiptRecordId: null,
        occurredOn: "2026-09-25",
        recordedBy: "담당자",
        note: "",
      }).success,
    ).toBe(false);
  });
  it("nonce digest는 정규 입력으로 만들고 재시도 revision과 관계없다", () => {
    const input = create();
    expect(applicationInputDigest(input)).toBe(applicationInputDigest({ ...input, revision: 100 }));
    expect(applicationInputDigest(input)).not.toBe(
      applicationInputDigest({ ...input, title: "다른 회차" } as ApplicationMutation),
    );
    const value = company();
    applyApplicationMutation(value, input, context);
    expect(isApplicationReplay(value, { ...input, revision: 100 })).toBe(true);
    expect(() =>
      isApplicationReplay(value, { ...input, title: "다른 회차" } as ApplicationMutation),
    ).toThrow(expect.objectContaining({ code: "APPLICATION_REQUEST_CONFLICT" }));
  });
  it("메타 정정은 최초 정보를 보존하고 최신 부모가 아니면 거부한다", () => {
    const value = company();
    applyApplicationMutation(value, create(), context);
    const cycle = structuredClone(value.applications[0]);
    const correction: ApplicationMutation = {
      action: "correct-application",
      revision: 0,
      clientRequestId: randomUUID(),
      applicationId: cycle.id,
      previousVersionId: cycle.id,
      title: "정정 회차",
      kind: "renewal",
      plannedOn: "2026-10-01",
      criteriaNote: "담당자 기준",
      previousApplicationId: null,
    };
    applyApplicationMutation(value, correction, context);
    expect(value.applications[0]).toEqual(cycle);
    expect(applicationMetadata(value, cycle.id)?.title).toBe("정정 회차");
    expect(() =>
      applyApplicationMutation(value, { ...correction, clientRequestId: randomUUID() }, context),
    ).toThrow(expect.objectContaining({ code: "APPLICATION_VERSION_STALE" }));
  });
  it("회차 전후 연결의 자기참조와 순환을 거부한다", () => {
    const value = company();
    applyApplicationMutation(value, create(), context);
    const first = value.applications[0];
    applyApplicationMutation(
      value,
      { ...create(), previousApplicationId: first.id } as ApplicationMutation,
      context,
    );
    const second = value.applications[1];
    const input: ApplicationMutation = {
      action: "correct-application",
      revision: 0,
      clientRequestId: randomUUID(),
      applicationId: first.id,
      previousVersionId: first.id,
      title: first.title,
      kind: first.kind,
      plannedOn: "",
      criteriaNote: "",
      previousApplicationId: second.id,
    };
    expect(() => applyApplicationMutation(value, input, context)).toThrow(
      expect.objectContaining({ code: "APPLICATION_CYCLE_REFERENCE" }),
    );
    expect(() =>
      applyApplicationMutation(value, { ...input, previousApplicationId: first.id }, context),
    ).toThrow(expect.objectContaining({ code: "APPLICATION_CYCLE_REFERENCE" }));
    expect(value.applicationEvents).toEqual([]);
  });
});
