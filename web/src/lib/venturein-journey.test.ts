import { describe, expect, it } from "vitest";
import {
  appendVentureJourney,
  buildVentureJourney,
  ventureJourneyEntrySchema,
  ventureJourneyHistorySchema,
} from "./venturein-journey";
import type { VentureExecutionRecord } from "./venturein-execution-schema";
import type { VentureScreenField } from "./venturein-inspection";
import type { VentureBoundSnapshot } from "./venturein-preflight";
import type { VentureSessionState } from "./venturein-schema";

const now = "2026-09-25T01:00:00.000Z";
const caseId = "11111111-1111-4111-8111-111111111111";
const executionId = "22222222-2222-4222-8222-222222222222";
type JourneyInput = Parameters<typeof buildVentureJourney>[0];

function field(key: string, kind: VentureScreenField["kind"] = "input"): VentureScreenField {
  return {
    key,
    kind,
    id: key,
    name: key,
    type: kind === "input" ? "text" : kind,
    labels: ["가상 항목"],
    required: true,
    maxLength: null,
    accept: kind === "file" ? ".pdf" : null,
    multiple: kind === "file",
    disabled: false,
    readOnly: false,
    options: [],
  };
}

function snapshot(index = 0): VentureBoundSnapshot {
  return {
    caseId,
    accountRevision: 2,
    sessionStartedAt: now,
    screen: {
      id: `screen-${index}`,
      observedAt: new Date(Date.parse(now) + index * 60_000).toISOString(),
      url: "https://www.smes.go.kr/venturein/aply/v2",
      title: `가상 신청 화면 ${index}`,
      companyEvidence: [
        {
          kind: "companyName",
          label: "기업명",
          value: "이력에 넣지 않는 가상 기업명",
          source: "table",
        },
      ],
      fields: [field("company"), field("description", "textarea"), field("evidence", "file")],
      truncated: false,
      warnings: ["이력에 넣지 않는 가상 문서 메모"],
    },
  };
}

function receipt(overrides: Partial<VentureExecutionRecord> = {}): VentureExecutionRecord {
  return {
    id: executionId,
    snapshotId: "screen-0",
    status: "completed",
    startedAt: now,
    finishedAt: "2026-09-25T01:00:01.000Z",
    completedFieldKeys: ["company", "description", "evidence"],
    attachmentFieldKeys: ["evidence"],
    attemptedFieldKey: null,
    code: null,
    ...overrides,
  };
}

function fixture(): JourneyInput {
  return {
    history: [],
    snapshot: snapshot(),
    execution: null,
    session: { state: "connected_unmapped", message: "가상 연결", startedAt: now, updatedAt: now },
    companyRevision: 4,
    accountRevision: 2,
    draft: {
      caseId,
      snapshotId: "screen-0",
      companyRevision: 4,
      accountRevision: 2,
      sessionStartedAt: now,
      planId: null,
      planVersion: null,
      textMappings: [
        {
          fieldKey: "company",
          source: { kind: "profile", property: "companyName" },
          confirmed: true,
        },
      ],
      attachmentMappings: [],
    },
    report: {
      scope: "local-preflight",
      caseId,
      snapshotId: "screen-0",
      planId: null,
      readyForLocalReview: true,
      inputReadiness: { ready: true, blockingIssues: [], deferredIssues: [] },
      automaticSubmissionAvailable: false,
      companyVerification: {
        status: "matched",
        expectedBusinessNumber: "1234567890",
        observedBusinessNumbers: ["1234567890"],
        reason: "가상 기업 번호 일치",
      },
      issues: [],
      textFields: [],
      attachments: [],
    },
  };
}

describe("공식 화면별 다음 행동 안내", () => {
  it.each<VentureSessionState>([
    "idle",
    "starting",
    "awaiting_setup",
    "awaiting_login",
    "awaiting_auth",
    "login_failed",
    "stopped",
  ])("이전 완료 기록이 있어도 현재 로그인 미완료면 연결을 안내한다: %s", (state) => {
    const input = fixture();
    input.session.state = state;
    input.execution = receipt();
    const journey = buildVentureJourney(input);
    expect(journey.phase).toBe("connect");
    expect(journey.entries[0].execution?.status).toBe("completed");
    expect(journey.message).toContain("새 연결의 입력 승인으로 재사용하지 않습니다");
  });

  it("연결 상태만 있고 세션 시작 시각이 없으면 기존 실행을 승인으로 사용하지 않는다", () => {
    const input = fixture();
    input.session.startedAt = null;
    input.execution = receipt();
    expect(buildVentureJourney(input).phase).toBe("connect");
  });

  it.each(["missing", "session", "account"] as const)(
    "기록한 화면이 없거나 현재 로그인·계정과 다르면 화면 읽기가 우선이다: %s",
    (mismatch) => {
      const input = fixture();
      input.execution = receipt();
      if (mismatch === "missing") input.snapshot = null;
      if (mismatch === "session") input.snapshot!.sessionStartedAt = "2026-09-24T01:00:00.000Z";
      if (mismatch === "account") input.snapshot!.accountRevision = 1;
      expect(buildVentureJourney(input).phase).toBe("inspect");
    },
  );

  it.each(["missing", "company", "snapshot", "account", "session"] as const)(
    "점검 보고서가 준비됨이어도 새 자료·화면의 연결을 다시 요구한다: %s",
    (mismatch) => {
      const input = fixture();
      if (mismatch === "missing") input.draft = null;
      if (mismatch === "company") input.draft!.companyRevision = 3;
      if (mismatch === "snapshot") input.draft!.snapshotId = "previous-screen";
      if (mismatch === "account") input.draft!.accountRevision = 1;
      if (mismatch === "session") input.draft!.sessionStartedAt = "2026-09-24T01:00:00.000Z";
      expect(buildVentureJourney(input).phase).toBe("map");
    },
  );

  it("현재 연결이 있어도 필수자료 보완이 남으면 전송 승인을 안내하지 않는다", () => {
    const input = fixture();
    input.report.readyForLocalReview = false;
    input.report.inputReadiness.ready = false;
    input.report.issues = [
      { code: "REQUIRED_MAPPING_MISSING", severity: "error", message: "필수 첨부 연결 필요" },
    ];
    const journey = buildVentureJourney(input);
    expect(journey.phase).toBe("review");
    expect(journey.message).toContain("보완사항을 해결하세요");
    expect(journey.entries[0].execution).toBeNull();
  });

  it("현재 연결과 점검이 준비됐으면 값·파일 검토 후 명시 승인을 안내한다", () => {
    const journey = buildVentureJourney(fixture());
    expect(journey.phase).toBe("execute");
    expect(journey.message).toContain("값·파일·공식 주소를 확인한 뒤");
    expect(journey.message).toContain("승인할 수 있습니다");
    expect(journey.entries[0].execution).toBeNull();
  });

  it("선택한 항목이 준비돼도 전체 제출 미완료 상태를 숨기지 않는다", () => {
    const input = fixture();
    input.report.readyForLocalReview = false;
    input.report.inputReadiness.deferredIssues = [
      { code: "PLAN_MISSING", severity: "error", message: "계획서 작성 필요" },
    ];
    const journey = buildVentureJourney(input);
    expect(journey.phase).toBe("execute");
    expect(journey.message).toContain("전체 제출 준비는 별도로");
    expect(input.report.readyForLocalReview).toBe(false);
  });

  it("이전 응답에 선택 항목 준비 상태가 없으면 전체 준비 true여도 실행 안내를 차단한다", () => {
    const input = fixture();
    Reflect.deleteProperty(input.report, "inputReadiness");
    expect(buildVentureJourney(input).phase).toBe("review");
  });

  it.each([
    { status: "running" as const, code: null, finishedAt: null },
    { status: "stopped" as const, code: "FIELD_NOT_EMPTY" },
    { status: "stopped" as const, code: "INPUT_RESULT_UNKNOWN" },
    { status: "completed" as const, code: "INPUT_RESULT_UNKNOWN" },
  ])("진행 중·중단·결과 불명확은 다음 화면 완료로 안내하지 않는다: %j", (outcome) => {
    const input = fixture();
    input.execution = receipt({
      ...outcome,
      completedFieldKeys: [],
      attemptedFieldKey: "evidence",
    });
    const journey = buildVentureJourney(input);
    expect(journey.phase).toBe("verify");
    expect(journey.message).toContain("같은 화면 기록으로 재실행하지 않습니다");
    expect(journey.entries[0].execution).toEqual(input.execution);
  });

  it("현재 화면의 값·첨부 확인 완료는 직접 다음 동작을 확인하도록 안내하며 접수로 가장하지 않는다", () => {
    const input = fixture();
    input.execution = receipt();
    const journey = buildVentureJourney(input);
    expect(journey.phase).toBe("handoff");
    expect(journey.message).toContain("공식 사이트에서 다음 동작을 확인해 이동한 뒤");
    expect(journey.message).toContain("저장·동의·제출·접수 완료를 뜻하지 않습니다");
  });

  it("이전 화면 완료는 보존하되 현재 화면을 완료 처리하지 않는다", () => {
    const input = fixture();
    const previous = snapshot(1);
    const completed = receipt({ snapshotId: previous.screen.id });
    input.history = appendVentureJourney([], previous, completed);
    input.execution = completed;
    const journey = buildVentureJourney(input);
    expect(journey.phase).toBe("execute");
    expect(journey.entries).toHaveLength(2);
    expect(journey.entries[0].execution).toEqual(completed);
    expect(journey.entries[1]).toMatchObject({ snapshotId: "screen-0", execution: null });
  });
});

describe("공식 화면 관찰 이력 보존", () => {
  it("일반 항목·첨부란 개수만 요약하며 기업 근거·입력 메타데이터·문서 메모를 이력에 넣지 않는다", () => {
    const current = snapshot();
    const [entry] = appendVentureJourney([], current, receipt());
    expect(entry).toMatchObject({
      fieldCount: 2,
      attachmentCount: 1,
      snapshotId: current.screen.id,
    });
    expect(Object.keys(entry).sort()).toEqual([
      "attachmentCount",
      "execution",
      "fieldCount",
      "id",
      "observedAt",
      "snapshotId",
      "title",
      "url",
    ]);
    expect(JSON.stringify(entry)).not.toContain("이력에 넣지 않는");
    expect(entry).not.toHaveProperty("fields");
    expect(entry).not.toHaveProperty("companyEvidence");
  });

  it("같은 화면의 실행 결과는 중복 없이 갱신하고 기존 배열·다른 화면을 변경하지 않는다", () => {
    const initial = appendVentureJourney([], snapshot(), null);
    const history = appendVentureJourney(initial, snapshot(1), null);
    const preserved = structuredClone(history);
    const next = appendVentureJourney(history, snapshot(), receipt());
    expect(next).toHaveLength(2);
    expect(next.map((entry) => entry.snapshotId)).toEqual(["screen-0", "screen-1"]);
    expect(next[0].execution).toEqual(receipt());
    expect(next[1]).toEqual(history[1]);
    expect(history).toEqual(preserved);
    expect(next).not.toBe(history);
  });

  it("오래된 화면만 제거하고 최근 12개를 보존한다", () => {
    let history: ReturnType<typeof appendVentureJourney> = [];
    for (let index = 0; index < 15; index++)
      history = appendVentureJourney(history, snapshot(index), null);
    expect(history.map((entry) => entry.snapshotId)).toEqual(
      Array.from({ length: 12 }, (_, index) => `screen-${index + 3}`),
    );
    expect(ventureJourneyHistorySchema.safeParse(history).success).toBe(true);
    expect(
      ventureJourneyHistorySchema.safeParse([...history, { ...history[0], id: "extra" }]).success,
    ).toBe(false);
  });

  it("현재 화면이 없으면 이전 이력을 지우거나 임의 화면을 추가하지 않는다", () => {
    const history = appendVentureJourney([], snapshot(1), null);
    expect(appendVentureJourney(history, null, receipt())).toEqual(history);
  });

  it("다른 화면 실행 영수증을 현재 화면에 붙이지 않으며 저장 이력의 위조 결합도 거부한다", () => {
    const wrongReceipt = receipt({ snapshotId: "another-screen" });
    const [entry] = appendVentureJourney([], snapshot(), wrongReceipt);
    expect(entry.execution).toBeNull();
    expect(ventureJourneyEntrySchema.safeParse({ ...entry, execution: wrongReceipt }).success).toBe(
      false,
    );
  });

  it("첨부 분류 필드가 없는 이전 텍스트 실행 이력을 복구할 때 빈 배열로 보완한다", () => {
    const legacyReceipt: Record<string, unknown> = {
      ...receipt({ completedFieldKeys: ["company"] }),
    };
    delete legacyReceipt.attachmentFieldKeys;
    const [entry] = appendVentureJourney([], snapshot(), null);
    const stored = JSON.stringify([{ ...entry, execution: legacyReceipt }]);
    const [restored] = ventureJourneyHistorySchema.parse(JSON.parse(stored));
    expect(restored.execution).toMatchObject({
      status: "completed",
      completedFieldKeys: ["company"],
      attachmentFieldKeys: [],
    });
    expect(legacyReceipt).not.toHaveProperty("attachmentFieldKeys");
  });

  it.each([
    "https://www.smes.go.kr/venturein/aply/v2?session=synthetic-private-query",
    "https://www.smes.go.kr/venturein/aply/v2#synthetic-private-fragment",
    "https://other.example/venturein/aply/v2",
    "https://www.smes.go.kr/venturein/auth/viewLogin",
  ])("공식 신청 화면 경로 외 주소·쿼리·인증 경로를 저장 이력에 허용하지 않는다: %s", (url) => {
    const [entry] = appendVentureJourney([], snapshot(), null);
    expect(ventureJourneyEntrySchema.safeParse({ ...entry, url }).success).toBe(false);
  });
});
