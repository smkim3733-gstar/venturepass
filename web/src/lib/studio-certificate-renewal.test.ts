import { describe, expect, it } from "vitest";
import type { AgencyNoticeRecord } from "./studio-agency-records";
import { buildCertificateTask, existingCertificateTask } from "./studio-certificate-renewal";
import {
  certificateAttention,
  certificateTaskContext,
  certificateTaskOriginSchema,
  createCertificateTaskMutationSchema,
  latestCertificateNotices,
  type CertificateCompany,
  type CertificateTask,
  type CreateCertificateTask,
} from "./studio-certificate-renewal-types";

const uuid = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
function notice(overrides: Partial<AgencyNoticeRecord> = {}): AgencyNoticeRecord {
  return {
    id: uuid(1),
    noticeRecordId: uuid(1),
    previousVersionId: null,
    version: 1,
    clientRequestId: uuid(2),
    inputDigest: "a".repeat(64),
    kind: "notice",
    origin: "manual",
    recordedAt: "2026-09-25T00:00:00.000Z",
    institution: "합성 기관",
    title: "합성 확인서 통보",
    body: "가상 안내 원문",
    occurredOn: "",
    note: "",
    evidence: [],
    details: {
      category: "certificate",
      certificateNumber: "synthetic-number",
      issuedOn: "2026-09-25",
      validFrom: "2026-09-25",
      validUntil: "2028-09-24",
      statusText: "담당자 입력 상태 · 효력 미확인",
    },
    ...overrides,
  };
}
function company(): CertificateCompany {
  return { agencyRecords: [notice()], tasks: [] };
}
function input(overrides: Partial<CreateCertificateTask> = {}): CreateCertificateTask {
  return {
    action: "create-certificate-task",
    revision: 0,
    noticeRecordId: uuid(1),
    noticeVersionId: uuid(1),
    preparationOn: "2028-08-01",
    ...overrides,
  };
}
function task(c = company()): CertificateTask {
  return buildCertificateTask(c, input(), uuid(3));
}

describe("확인서 준비 날짜·업무 계약", () => {
  it.each(["", "2026-02-29", "2026-13-01", "2026-09-31", "2026-1-02", "today"])(
    "rejects an absent or invalid user date %s",
    (preparationOn) => {
      expect(createCertificateTaskMutationSchema.safeParse(input({ preparationOn })).success).toBe(
        false,
      );
    },
  );
  it("accepts an explicit leap-day or past date without inventing a legal deadline", () => {
    expect(
      createCertificateTaskMutationSchema.parse(input({ preparationOn: "2028-02-29" }))
        .preparationOn,
    ).toBe("2028-02-29");
    expect(
      buildCertificateTask(company(), input({ preparationOn: "2020-01-01" }), uuid(3)).dueDate,
    ).toBe("2020-01-01");
  });
  it("does not accept client task IDs, authority claims, or unknown snapshot fields", () => {
    expect(
      createCertificateTaskMutationSchema.safeParse({ ...input(), taskId: uuid(3) }).success,
    ).toBe(false);
    expect(
      createCertificateTaskMutationSchema.safeParse({ ...input(), officialVerified: true }).success,
    ).toBe(false);
    expect(
      certificateTaskOriginSchema.safeParse({ ...task().certificateOrigin, issued: true }).success,
    ).toBe(false);
  });
  it("uses only the manually chosen date and preserves the exact notice snapshot", () => {
    const c = company();
    const before = structuredClone(c);
    const created = task(c);
    expect(created).toMatchObject({
      category: "other",
      status: "pending",
      dueDate: "2028-08-01",
      certificateOrigin: {
        noticeRecordId: uuid(1),
        noticeVersionId: uuid(1),
        category: "certificate",
        validUntil: "2028-09-24",
        preparationOn: "2028-08-01",
      },
    });
    expect(created.owners).toBeUndefined();
    expect(created.processing).toBeUndefined();
    expect(created.notes).toContain("법정 갱신기한을 계산한 결과가 아닙니다");
    expect(c).toEqual(before);
  });
  it("allows unconfirmed expiry and does not infer cancellation or validity from status text", () => {
    const c = company();
    const n = c.agencyRecords[0] as AgencyNoticeRecord;
    if (n.details.category !== "certificate") throw new Error("fixture");
    n.details.validUntil = "";
    n.details.statusText = "취소 여부를 확인하지 못함";
    expect(task(c).certificateOrigin?.validUntil).toBe("");
    expect(task(c).notes).toContain("유효종료일: 미확인");
  });
  it("reuses the same task after lost response without restoring edited dates or completion", () => {
    const c = company();
    const saved = task(c);
    saved.dueDate = "2028-08-15";
    saved.status = "done";
    saved.notes = "담당자 수정";
    c.tasks.push(saved);
    expect(existingCertificateTask(c, input())).toBe(saved);
    expect(buildCertificateTask(c, input(), uuid(9))).toBe(saved);
    expect(saved).toMatchObject({ dueDate: "2028-08-15", status: "done", notes: "담당자 수정" });
  });
  it("refuses another creation date for the same notice version", () => {
    const c = company();
    c.tasks.push(task(c));
    expect(() => existingCertificateTask(c, input({ preparationOn: "2028-08-02" }))).toThrow(
      /기존 업무/,
    );
    expect(c.tasks).toHaveLength(1);
  });
  it("rejects another company's notice and obsolete version", () => {
    expect(() => buildCertificateTask({ agencyRecords: [], tasks: [] }, input(), uuid(3))).toThrow(
      /같은 기업/,
    );
    const c = company();
    c.agencyRecords.push(
      notice({ id: uuid(4), kind: "notice-correction", previousVersionId: uuid(1), version: 2 }),
    );
    expect(() => buildCertificateTask(c, input(), uuid(3))).toThrow(/정정/);
    expect(
      buildCertificateTask(c, input({ noticeVersionId: uuid(4) }), uuid(3)).certificateOrigin
        ?.noticeVersionId,
    ).toBe(uuid(4));
  });
  it("keeps old tasks when a notice is corrected, and flags them for rechecking", () => {
    const c = company();
    c.tasks.push(task(c));
    c.tasks[0].status = "done";
    const correction = notice({
      id: uuid(4),
      kind: "notice-correction",
      previousVersionId: uuid(1),
      version: 2,
    });
    c.agencyRecords.push(correction);
    expect(certificateTaskContext(c, c.tasks[0])?.state).toBe("updated");
    expect(c.tasks[0].status).toBe("done");
    expect(c.tasks[0].dueDate).toBe("2028-08-01");
    expect(certificateAttention(c)).toMatchObject({
      needsPreparationCount: 1,
      changedTaskCount: 1,
    });
  });
  it("does not treat a later non-certificate correction as a certificate", () => {
    const c = company();
    c.tasks.push(task(c));
    c.agencyRecords.push(
      notice({
        id: uuid(4),
        kind: "notice-correction",
        previousVersionId: uuid(1),
        version: 2,
        details: { category: "decision", decisionText: "별도 안내", notifiedOn: "", reasons: "" },
      }),
    );
    expect(latestCertificateNotices(c)).toEqual([]);
    expect(() => buildCertificateTask(c, input({ noticeVersionId: uuid(4) }), uuid(5))).toThrow(
      /분류는 확인서가 아닙니다/,
    );
    expect(certificateTaskContext(c, c.tasks[0])?.state).toBe("updated");
  });
  it("treats missing or duplicated linkage as unverified rather than substituting another record", () => {
    const c = company();
    const saved = task(c);
    expect(certificateTaskContext({ ...c, agencyRecords: [] }, saved)?.state).toBe("missing");
    expect(
      certificateTaskContext({ ...c, agencyRecords: [notice(), notice()] }, saved)?.state,
    ).toBe("missing");
    c.tasks = [saved, { ...saved, id: uuid(4) }];
    expect(() => existingCertificateTask(c, input())).toThrow(/중복/);
  });
  it("refuses changed snapshot metadata even if a persisted notice retained the same ID", () => {
    const c = company();
    c.tasks.push(task(c));
    const changed = notice();
    if (changed.details.category !== "certificate") throw new Error("fixture");
    changed.details.validUntil = "2029-01-01";
    c.agencyRecords = [changed];
    expect(certificateTaskContext(c, c.tasks[0])?.state).toBe("updated");
    expect(() => existingCertificateTask(c, input())).toThrow(/연결 당시/);
  });
  it("refuses task-cap overflow and summarizes no body, certificate number or owner name", () => {
    const c = company();
    c.tasks = Array.from({ length: 200 }, (_, i) => ({
      id: uuid(i + 10),
      title: "합성 업무",
      category: "other",
      dueDate: "",
      status: "pending",
      notes: "",
      owners: { materials: "민감 담당자", writing: "", review: "" },
    }));
    expect(() => task(c)).toThrow(/200개/);
    const summary = certificateAttention(c);
    expect(summary).toEqual({
      recordedUntilDates: ["2028-09-24"],
      missingUntilCount: 0,
      needsPreparationCount: 1,
      changedTaskCount: 0,
    });
    expect(JSON.stringify(summary)).not.toMatch(/synthetic-number|가상 안내|담당자/);
  });
  it("flags undated pending tasks but respects a manually completed preparation", () => {
    const c = company();
    c.tasks.push(task(c));
    c.tasks[0].dueDate = "";
    expect(certificateAttention(c).needsPreparationCount).toBe(1);
    c.tasks[0].status = "done";
    expect(certificateAttention(c).needsPreparationCount).toBe(0);
  });
});
