import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { caseSchema, emptyProfile, type StudioCase, type WorkflowTask } from "./studio-schema";
import type { AgencyNoticeRecord, AgencyRequestRecord } from "./studio-agency-records";
import { applyApplicationMutation } from "./studio-applications";
import { buildApplicationProcedure } from "./studio-application-procedure";
import {
  deriveGuidedFollowup,
  validateGuidedWorkflowTarget,
  type GuidedWorkflowTarget,
} from "./studio-guided-followup";

const now = "2026-09-27T01:00:00.000Z";
const today = "2026-09-27";
const hash = "a".repeat(64);
function company(): StudioCase {
  return caseSchema.parse({
    id: randomUUID(),
    profile: { ...emptyProfile(), companyName: "합성 후속 안내 회사" },
    sources: [],
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: "preparing",
    revision: 8,
    createdAt: now,
    updatedAt: now,
  });
}
function request(): AgencyRequestRecord {
  const id = randomUUID();
  return {
    id,
    clientRequestId: randomUUID(),
    inputDigest: hash,
    kind: "request",
    requestRecordId: id,
    requestVersionId: id,
    previousVersionId: null,
    version: 1,
    origin: "manual",
    recordedAt: now,
    institution: "합성 기관",
    title: "합성 보완 요청",
    body: "합성 원문",
    occurredOn: today,
    dueOn: "2026-10-01",
    dueNote: "합성 안내문 기한",
    note: "",
    responseStatus: null,
    evidence: [],
  };
}
function response(
  root: AgencyRequestRecord,
  status: "draft" | "reported-sent" = "reported-sent",
): AgencyRequestRecord {
  return {
    ...root,
    id: randomUUID(),
    clientRequestId: randomUUID(),
    kind: "response",
    responseStatus: status,
    version: 1,
    requestRecordId: root.requestRecordId,
    requestVersionId: root.id,
    previousVersionId: null,
  };
}
function correction(root: AgencyRequestRecord): AgencyRequestRecord {
  const id = randomUUID();
  return {
    ...root,
    id,
    clientRequestId: randomUUID(),
    kind: "request-correction",
    requestVersionId: id,
    previousVersionId: root.id,
    version: root.version + 1,
    recordedAt: "2026-09-26T23:00:00.000Z",
  };
}
function notice(
  category: AgencyNoticeRecord["details"]["category"] = "certificate",
): AgencyNoticeRecord {
  const id = randomUUID();
  const details: AgencyNoticeRecord["details"] =
    category === "certificate"
      ? {
          category,
          certificateNumber: "SYNTHETIC",
          issuedOn: today,
          validFrom: today,
          validUntil: "2027-09-27",
          statusText: "사용자 기록",
        }
      : category === "payment"
        ? {
            category,
            amountWon: "",
            dueOn: "2026-10-01",
            dueNote: "합성 기한",
            paidOn: "",
            referenceNumber: "",
            statusText: "",
          }
        : category === "receipt"
          ? { category, receiptNumber: "SYNTHETIC", receivedOn: today, statusText: "사용자 기록" }
          : category === "visit"
            ? {
                category,
                scheduledOn: "2026-10-01",
                timeText: "10시",
                location: "합성 장소",
                preparation: "합성 준비",
              }
            : { category, decisionText: "합성 통보", notifiedOn: today, reasons: "" };
  return {
    id,
    clientRequestId: randomUUID(),
    inputDigest: hash,
    kind: "notice",
    noticeRecordId: id,
    previousVersionId: null,
    version: 1,
    origin: "manual",
    recordedAt: now,
    institution: "합성 기관",
    title: "합성 통보",
    body: "합성 원문",
    occurredOn: today,
    note: "",
    details,
    evidence: [],
  };
}
function task(): WorkflowTask {
  return {
    id: randomUUID(),
    title: "합성 업무",
    category: "supplement",
    status: "pending",
    dueDate: "2026-10-01",
    notes: "",
  };
}
const derive = (value: StudioCase) => deriveGuidedFollowup(value, { today });

describe("현재 요청 버전과 단일 후속 행동", () => {
  it("자료 준비 단계는 기록이 없으면 후속 단계로 승격하지 않는다", () => {
    expect(derive(company())).toMatchObject({
      state: "none",
      action: null,
      primary: null,
      lastRecordedAt: null,
      lastCheckedAt: null,
      provenance: "none",
    });
  });
  it("최초 요청 자체를 최신 version으로 연결한다", () => {
    const value = company(),
      root = request();
    value.agencyRecords = [root];
    expect(derive(value)).toMatchObject({
      state: "action-required",
      action: {
        label: "답변 준비하기",
        target: {
          caseId: value.id,
          companyRevision: 8,
          kind: "response",
          requestRecordId: root.id,
          requestVersionId: root.id,
        },
      },
      primary: { dueOn: root.dueOn, dueNote: root.dueNote, version: 1, provenance: "manual" },
    });
  });
  it("정확한 최신 요청에 발송 기록이 있으면 주 실행 버튼 없이 기다린다", () => {
    const value = company(),
      root = request();
    value.agencyRecords = [root, response(root)];
    expect(derive(value)).toMatchObject({ state: "waiting", action: null, lastCheckedAt: null });
    expect(derive(value).primary?.description).toContain("발송했다고 기록");
    expect(derive(value).primary?.description).toContain(
      "기관 수신·검토 결과는 아직 확인되지 않았습니다",
    );
  });
  it("이전 요청용 답변은 정정 요청 v2를 대기로 만들지 않는다", () => {
    const value = company(),
      root = request(),
      next = correction(root),
      sent = response(root);
    value.agencyRecords = [root, sent, next];
    expect(derive(value).action?.target).toMatchObject({
      requestRecordId: root.id,
      requestVersionId: next.id,
    });
    expect(derive(value).primary?.version).toBe(2);
  });
  it("옛 sent 이후 새 draft는 기록시각 역행이어도 현재 할 일로 남는다", () => {
    const value = company(),
      root = request(),
      sent = response(root),
      draft = response(root, "draft");
    draft.recordedAt = "2026-09-25T01:00:00.000Z";
    draft.previousVersionId = sent.id;
    draft.version = sent.version + 1;
    value.agencyRecords = [root, sent, draft];
    expect(derive(value).state).toBe("action-required");
  });
  it("다른 요청의 발송 기록은 현재 요청을 해결하지 않는다", () => {
    const value = company(),
      one = request(),
      two = request();
    value.agencyRecords = [one, two, response(two)];
    expect(derive(value).action?.target).toMatchObject({ requestRecordId: one.id });
  });
  it("과거 업무 완료는 정정된 요청의 답변 완료로 쓰지 않는다", () => {
    const value = company(),
      root = request(),
      next = correction(root),
      work = task();
    work.status = "done";
    work.agencyOrigin = { requestRecordId: root.id, requestVersionId: root.id };
    value.tasks = [work];
    value.agencyRecords = [root, response(root), next];
    expect(derive(value).action?.target).toMatchObject({ requestVersionId: next.id });
  });
  it("기한이 지난 업무를 더 늦은 요청보다 우선하고 하나의 action만 반환한다", () => {
    const value = company(),
      root = request(),
      work = task();
    work.dueDate = "2026-09-25";
    value.tasks = [work];
    value.agencyRecords = [root];
    expect(derive(value)).toMatchObject({
      action: { target: { kind: "task", taskId: work.id } },
      primary: { deadlineStatus: "overdue" },
    });
  });
  it.each([
    ["", "unknown"],
    ["2026-02-30", "unknown"],
    ["2026-09-26", "overdue"],
    [today, "today"],
    ["2026-09-28", "upcoming"],
  ])("기한 %s는 %s로 구분하며 비어도 완료 처리하지 않는다", (due, status) => {
    const value = company(),
      root = request();
    root.dueOn = due;
    value.agencyRecords = [root];
    expect(derive(value).primary?.deadlineStatus).toBe(status);
    expect(derive(value).action).not.toBeNull();
  });
  it("today가 없으면 서버 시계나 timezone을 추측하지 않는다", () => {
    const value = company();
    value.agencyRecords = [request()];
    expect(deriveGuidedFollowup(value).primary?.deadlineStatus).toBe("unknown");
  });
});

describe("통보·확인서·수기 근거", () => {
  it("접수 수기 기록만 있으면 대기하며 공식 확인시각을 만들지 않는다", () => {
    const value = company();
    value.agencyRecords = [notice("receipt")];
    value.updatedAt = "2026-10-01T00:00:00.000Z";
    expect(derive(value)).toMatchObject({
      state: "waiting",
      action: null,
      provenance: "manual",
      lastRecordedAt: now,
      lastCheckedAt: null,
    });
  });
  it("납부일 미기록은 미납으로 단정하지 않는다", () => {
    const value = company();
    value.agencyRecords = [notice("payment")];
    const result = derive(value);
    expect(result.action?.target.kind).toBe("notice");
    expect(result.description).toContain("납부했다고 기록한 날짜가 없습니다");
    expect(result.description).not.toContain("미납");
    expect(result.description).not.toContain("0원");
  });
  it("납부일을 기록하면 추가 실행 버튼을 만들지 않는다", () => {
    const value = company(),
      saved = notice("payment");
    if (saved.details.category === "payment") saved.details.paidOn = today;
    value.agencyRecords = [saved];
    expect(derive(value)).toMatchObject({ state: "waiting", action: null });
  });
  it("확인서에는 정확한 최신 통보와 입력된 유효기간을 연결한다", () => {
    const value = company(),
      saved = notice();
    value.agencyRecords = [saved];
    expect(derive(value)).toMatchObject({
      action: {
        target: { kind: "certificate", noticeRecordId: saved.id, noticeVersionId: saved.id },
      },
      primary: { dueOn: "2027-09-27", dueNote: "사용자가 기록한 확인서 유효기간 종료일" },
    });
  });
  it("확인서가 결정 통보로 정정되면 옛 확인서를 다시 꺼내지 않는다", () => {
    const value = company(),
      saved = notice(),
      changed = notice("decision");
    changed.kind = "notice-correction";
    changed.noticeRecordId = saved.id;
    changed.previousVersionId = saved.id;
    changed.version = 2;
    value.agencyRecords = [saved, changed];
    expect(derive(value).items.map((item) => item.kind)).toEqual(["notice"]);
    expect(derive(value).action).toBeNull();
  });
  it("사용자가 정한 미래 준비일까지는 기다리며 당일에는 정확한 업무로 연결한다", () => {
    const value = company(),
      saved = notice(),
      work = task();
    work.dueDate = "2026-10-01";
    work.certificateOrigin = {
      noticeRecordId: saved.id,
      noticeVersionId: saved.id,
      category: "certificate",
      validUntil: "2027-09-27",
      preparationOn: work.dueDate,
    };
    value.agencyRecords = [saved];
    value.tasks = [work];
    expect(derive(value)).toMatchObject({ state: "waiting", action: null });
    expect(deriveGuidedFollowup(value, { today: work.dueDate }).action?.target).toMatchObject({
      kind: "task",
      taskId: work.id,
    });
  });
  it("옛 확인서의 미래 준비 업무는 정정된 최신 확인서 준비를 대신하지 않는다", () => {
    const value = company(),
      saved = notice(),
      next = {
        ...saved,
        id: randomUUID(),
        kind: "notice-correction" as const,
        noticeRecordId: saved.id,
        previousVersionId: saved.id,
        version: 2,
      },
      work = task();
    work.certificateOrigin = {
      noticeRecordId: saved.id,
      noticeVersionId: saved.id,
      category: "certificate",
      validUntil: "2027-09-27",
      preparationOn: work.dueDate,
    };
    value.agencyRecords = [saved, next];
    value.tasks = [work];
    expect(
      derive(value).items.find((item) => item.kind === "certificate")?.actionLabel,
    ).not.toBeNull();
    expect(derive(value).items.find((item) => item.kind === "task")?.description).toContain("정정");
  });
  it("입력 전체를 변경하지 않고 이력·완료·원문을 그대로 보존한다", () => {
    const value = company();
    value.agencyRecords = [request(), notice()];
    value.tasks = [task()];
    const before = structuredClone(value);
    derive(value);
    expect(value).toEqual(before);
  });
  it.each(["current", "reassigned", "notice-version", "metadata-version", "new-preparing"])(
    "실사 완료 수기 절차 %s 문맥만 반복 행동에서 제외한다",
    (change) => {
      const value = company(),
        saved = notice("visit");
      value.agencyRecords = [saved];
      const context = {
        evidenceRevision: 0,
        readOriginal: (): never => {
          throw new Error("No real original");
        },
      };
      applyApplicationMutation(
        value,
        {
          action: "create-application",
          revision: value.revision,
          clientRequestId: randomUUID(),
          title: "합성 회차",
          kind: "new",
          plannedOn: "",
          criteriaNote: "",
          previousApplicationId: null,
        },
        context,
      );
      const applicationId = value.applications[0].id;
      applyApplicationMutation(
        value,
        {
          action: "link-application-agency",
          revision: value.revision,
          clientRequestId: randomUUID(),
          applicationId,
          recordId: saved.id,
          note: "합성 귀속",
        },
        context,
      );
      const completed = buildApplicationProcedure(
        value,
        [],
        {
          procedureId: null,
          previousVersionId: null,
          applicationId,
          applicationMetadataVersionId: applicationId,
          agencyVersionId: saved.id,
          expectedLinkEventId: value.applicationEvents[0].id,
          title: "합성 실사 기록",
          procedureType: "evaluation",
          requester: "합성 담당자",
          requestedOn: "",
          dueOn: "",
          dueBasis: "",
          extensionStatus: "unknown",
          extensionRequestedOn: "",
          extensionDecidedOn: "",
          extendedDueOn: "",
          extensionBasis: "",
          status: "reported_completed",
          statusBasis: "담당자가 확인했다고 기록",
          completionBasis: "담당자의 수기 완료 근거",
          recordedBy: "합성 사용자",
          note: "",
          evidence: [],
        },
        { id: randomUUID(), clientRequestId: randomUUID(), recordedAt: now },
        context.readOriginal,
      );
      value.applicationProcedures = [completed];
      if (change === "reassigned")
        applyApplicationMutation(
          value,
          {
            action: "correct-application-agency-link",
            revision: value.revision,
            clientRequestId: randomUUID(),
            previousLinkEventId: value.applicationEvents[0].id,
            fromApplicationId: applicationId,
            toApplicationId: null,
            recordId: saved.id,
            note: "회차 미지정",
          },
          context,
        );
      if (change === "notice-version")
        value.agencyRecords.push({
          ...saved,
          id: randomUUID(),
          version: 2,
          kind: "notice-correction",
          previousVersionId: saved.id,
        });
      if (change === "metadata-version")
        applyApplicationMutation(
          value,
          {
            action: "correct-application",
            revision: value.revision,
            clientRequestId: randomUUID(),
            applicationId,
            previousVersionId: applicationId,
            title: "정정된 합성 회차",
            kind: "new",
            plannedOn: "",
            criteriaNote: "",
            previousApplicationId: null,
          },
          context,
        );
      if (change === "new-preparing")
        value.applicationProcedures.push({
          ...completed,
          id: randomUUID(),
          version: 2,
          previousVersionId: completed.id,
          status: "preparing",
          completionBasis: "",
        });
      if (change === "current") {
        completed.recordedAt = "2026-09-27T18:00:00.000Z";
        expect(derive(value).action).toBeNull();
        expect(derive(value).primary?.description).toContain("완료했다고 기록");
        expect(derive(value).lastCheckedAt).toBeNull();
        expect(derive(value).lastRecordedAt).toBe(completed.recordedAt);
      } else expect(derive(value).action?.target.kind).toBe("notice");
    },
  );
});

describe("상세 이동 대상 고정", () => {
  it.each(["company", "revision", "request-version", "root", "duplicate", "orphan"])(
    "%s가 달라지면 응답 준비 대상을 새 기록으로 대체하지 않는다",
    (change) => {
      const value = company(),
        root = request();
      value.agencyRecords = [root];
      const target = derive(value).action!.target;
      if (change === "company") value.id = randomUUID();
      if (change === "revision") value.revision += 1;
      if (change === "request-version") value.agencyRecords.push(correction(root));
      if (change === "root") value.agencyRecords[0] = request();
      if (change === "duplicate") value.agencyRecords.push(structuredClone(root));
      if (change === "orphan") value.agencyRecords = [correction(root)];
      expect(validateGuidedWorkflowTarget(value, target).valid).toBe(false);
    },
  );
  it("task와 notice 대상은 존재하는 정확한 기업·현재 버전만 허용한다", () => {
    const value = company(),
      work = task(),
      saved = notice();
    value.tasks = [work];
    value.agencyRecords = [saved];
    const targets: GuidedWorkflowTarget[] = [
      { caseId: value.id, companyRevision: value.revision, kind: "task", taskId: work.id },
      {
        caseId: value.id,
        companyRevision: value.revision,
        kind: "certificate",
        noticeRecordId: saved.id,
        noticeVersionId: saved.id,
      },
    ];
    for (const target of targets)
      expect(validateGuidedWorkflowTarget(value, target)).toEqual({ valid: true });
    value.tasks = [];
    value.agencyRecords = [];
    for (const target of targets)
      expect(validateGuidedWorkflowTarget(value, target).valid).toBe(false);
  });
  it("orphan 기관 기록을 새 회사 준비 완료 또는 안전한 편집 대상으로 추정하지 않는다", () => {
    const value = company();
    value.agencyRecords = [correction(request())];
    expect(derive(value)).toMatchObject({
      state: "action-required",
      action: null,
      provenance: "manual",
    });
    expect(derive(value).description).toContain("이전 버전 연결");
  });
  it.each([
    "duplicate-response",
    "wrong-response-previous",
    "wrong-response-version",
    "wrong-request-previous",
    "response-before-request",
    "wrong-response-request",
  ])("%s 이력으로 발송 완료나 현재 편집 대상을 확정하지 않는다", (change) => {
    const value = company(),
      root = request(),
      next = correction(root),
      sent = response(next);
    value.agencyRecords = [root, next, sent];
    const target: GuidedWorkflowTarget = {
      caseId: value.id,
      companyRevision: value.revision,
      kind: "response",
      requestRecordId: root.id,
      requestVersionId: next.id,
    };
    if (change === "duplicate-response") value.agencyRecords.push(structuredClone(sent));
    if (change === "wrong-response-previous") sent.previousVersionId = root.id;
    if (change === "wrong-response-version") sent.version = 99;
    if (change === "wrong-request-previous") next.previousVersionId = randomUUID();
    if (change === "response-before-request") value.agencyRecords = [sent, root, next];
    if (change === "wrong-response-request") sent.requestVersionId = root.id;
    expect(derive(value)).toMatchObject({ state: "action-required", action: null });
    expect(validateGuidedWorkflowTarget(value, target).valid).toBe(false);
  });
  it("깨진 확인서 정정 체인도 옛 확인서나 임의 최신 통보로 대체하지 않는다", () => {
    const value = company(),
      root = notice(),
      next = {
        ...root,
        id: randomUUID(),
        version: 2,
        kind: "notice-correction" as const,
        previousVersionId: randomUUID(),
      };
    value.agencyRecords = [root, next];
    expect(derive(value)).toMatchObject({ state: "action-required", action: null, items: [] });
    expect(
      validateGuidedWorkflowTarget(value, {
        caseId: value.id,
        companyRevision: value.revision,
        kind: "certificate",
        noticeRecordId: root.id,
        noticeVersionId: next.id,
      }).valid,
    ).toBe(false);
  });
});
