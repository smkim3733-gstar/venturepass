import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { caseSchema, emptyProfile, stageValues, type SourceDocument } from "./studio-schema";
import { buildCandidateSelection } from "./studio-candidate-selection";
import { diagnosisInputFingerprint } from "./studio-diagnosis";
import { diagnosisCriteriaVersion } from "./studio-diagnosis-types";
import { preparationDigest } from "./studio-preparation-state";
import { preparationRunSchema, type PreparationRun } from "./studio-preparation-types";
import type { AgencyRequestRecord } from "./studio-agency-records";
import {
  beginPreparationAutomation,
  collectPreparationAutomationChanges,
  configurePreparationAutomation,
  finishPreparationAutomation,
  preparationAutomationFingerprint,
  type PreparationAutomationCompany,
} from "./studio-preparation-automation";
import {
  canRequestPreparationAutomation,
  currentPreparationAutomationSetting,
  emptyPreparationAutomation,
  preparationAutomationEnabled,
  preparationAutomationLimits,
  preparationAutomationRequestSchema,
  preparationAutomationSettingInputSchema,
  type PreparationAutomationBatch,
  type PreparationAutomationRequest,
} from "./studio-preparation-automation-types";

const at = "2026-09-25T12:00:00.000Z",
  meta = () => ({ id: randomUUID(), at });
function company(): PreparationAutomationCompany {
  return caseSchema.parse({
    id: randomUUID(),
    profile: { ...emptyProfile(), companyName: "가상 기업", technologySummary: "PRIVATE_기술설명" },
    sources: [],
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: stageValues[0],
    revision: 0,
    createdAt: at,
    updatedAt: at,
  });
}
function setting(value: PreparationAutomationCompany, enabled = true) {
  return {
    action: "set-preparation-automation" as const,
    revision: value.revision,
    clientRequestId: randomUUID(),
    expectedSettingVersion:
      currentPreparationAutomationSetting(value.preparationAutomation)?.version ?? 0,
    enabled,
  };
}
function enable(value: PreparationAutomationCompany, enabled = true) {
  const input = setting(value, enabled),
    result = configurePreparationAutomation(value, input, meta());
  value.preparationAutomation = result.state;
  if (result.changed) value.revision++;
  return input;
}
function change(
  value: PreparationAutomationCompany,
  alter: (copy: PreparationAutomationCompany) => void,
) {
  const before = structuredClone(value);
  alter(value);
  value.revision++;
  value.preparationAutomation = collectPreparationAutomationChanges(before, value, at);
  return before;
}
function request(value: PreparationAutomationCompany): PreparationAutomationRequest {
  return {
    action: "run-pending",
    revision: value.revision,
    clientRequestId: randomUUID(),
    expectedSettingVersion:
      currentPreparationAutomationSetting(value.preparationAutomation)?.version ?? 0,
  };
}
function begin(value: PreparationAutomationCompany, input = request(value)) {
  const result = beginPreparationAutomation(value, input, meta());
  value.preparationAutomation = result.state;
  if (!result.replayed) value.revision++;
  return result;
}
function source(pending = false): SourceDocument {
  return {
    id: randomUUID(),
    name: "PRIVATE_원본명",
    kind: "technology",
    text: pending ? "" : "PRIVATE_등록본문",
    extraction: pending ? "pending" : "manual",
    originalName: null,
    mimeType: null,
    warnings: [],
    createdAt: at,
    updatedAt: at,
  };
}
function agency(kind: "request" | "response" = "request"): AgencyRequestRecord {
  const id = randomUUID();
  return {
    id,
    clientRequestId: randomUUID(),
    inputDigest: "a".repeat(64),
    kind,
    requestRecordId: id,
    requestVersionId: id,
    previousVersionId: null,
    version: 1,
    origin: "manual",
    recordedAt: at,
    institution: "PRIVATE_기관",
    title: "PRIVATE_제목",
    body: "PRIVATE_요청본문",
    occurredOn: "",
    dueOn: "",
    dueNote: "",
    note: "",
    responseStatus: kind === "response" ? "draft" : null,
    evidence: [],
  };
}
function pendingBatch() {
  const value = company();
  enable(value);
  change(value, (copy) => {
    copy.profile.customers = "PRIVATE_새고객";
  });
  const input = request(value),
    transition = begin(value, input);
  return { value, input, transition, batch: transition.batch };
}
function run(
  value: PreparationAutomationCompany,
  batch: PreparationAutomationBatch,
  status: PreparationRun["status"] = "awaiting_choice",
) {
  const result = preparationRunSchema.parse({
    id: randomUUID(),
    mode: "assisted",
    inputFingerprint: diagnosisInputFingerprint(value),
    criteriaVersion: diagnosisCriteriaVersion,
    sourceRevision: value.revision,
    createdAt: at,
    updatedAt: at,
    status,
    phase: status === "awaiting_choice" ? "choice" : "diagnosis",
    stale: false,
    code: null,
    diagnosisId: null,
    analysisDigest: value.analysis ? preparationDigest(value.analysis) : null,
    candidates:
      value.analysis?.candidates.map((item) => ({
        id: item.id,
        digest: preparationDigest(item),
      })) ?? [],
    selectedCandidateId: null,
    selectedCandidateDigest: null,
    planId: null,
    planDigest: null,
    steps: [],
    requests: [{ clientRequestId: batch.command!.clientRequestId, digest: "a".repeat(64) }],
  });
  value.preparationRuns.push(result);
  return result;
}
function resume(
  value: PreparationAutomationCompany,
  batch: PreparationAutomationBatch,
): PreparationAutomationRequest {
  return { ...request(value), action: "resume-batch", batchId: batch.id };
}
function selection(value: PreparationAutomationCompany) {
  const candidate = {
    id: "candidate",
    title: "PRIVATE_후보",
    problem: "문제",
    solution: "해결",
    targetCustomer: "고객",
    differentiation: "미확인",
    stage: "구상",
    businessModel: "미확인",
    recommendation: "추천만",
    evidence: [],
    gaps: [],
  };
  value.analysis = {
    mode: "assisted",
    generatedAt: at,
    sourceRevision: value.revision,
    summary: "분석",
    facts: [],
    candidates: [candidate],
    questions: [],
    warnings: [],
  };
  const input = {
    action: "select-candidate" as const,
    revision: value.revision,
    clientRequestId: randomUUID(),
    candidateId: candidate.id,
    analysisGeneratedAt: value.analysis.generatedAt,
    analysisSourceRevision: value.analysis.sourceRevision,
    expectedSelectedCandidateId: value.selectedCandidateId,
    reason: "명시한 선택 이유",
  };
  value.candidateSelections.push(
    buildCandidateSelection(value, input, { id: randomUUID(), recordedAt: at }),
  );
  value.selectedCandidateId = candidate.id;
  return candidate;
}

describe("로컬 준비 자동연결 독립 코어", () => {
  it("legacy 기본 off, 켜기는 현재 baseline만 기록하고 과거 사건/준비를 만들지 않는다", () => {
    const value = company(),
      old = structuredClone(value);
    expect(preparationAutomationEnabled(value.preparationAutomation)).toBe(false);
    enable(value);
    expect(value.preparationAutomation?.settings[0].baselineFingerprint).toBe(
      preparationAutomationFingerprint(value),
    );
    expect(value.preparationAutomation?.events).toEqual([]);
    expect(value.preparationAutomation?.batches).toEqual([]);
    expect(value.plans).toEqual(old.plans);
    expect(() => begin(value)).toThrow(expect.objectContaining({ code: "AUTOMATION_NO_CHANGES" }));
  });
  it("설정 nonce 재전송은 현재 off를 과거 on으로 복원하지 않는다", () => {
    const value = company(),
      original = enable(value);
    enable(value, false);
    const before = structuredClone(value),
      result = configurePreparationAutomation(value, original, meta());
    expect(result.replayed).toBe(true);
    expect(preparationAutomationEnabled(result.state)).toBe(false);
    expect(value).toEqual(before);
    expect(() =>
      configurePreparationAutomation(value, { ...original, enabled: false }, meta()),
    ).toThrow(expect.objectContaining({ code: "AUTOMATION_REQUEST_CONFLICT" }));
  });
  it("off 상태 변경은 기록하지 않고 다시 켜도 과거 사건을 소급 실행하지 않는다", () => {
    const value = company();
    change(value, (copy) => {
      copy.profile.customers = "과거";
    });
    enable(value);
    expect(value.preparationAutomation?.events).toEqual([]);
    change(value, (copy) => {
      copy.profile.customers = "허용중";
    });
    enable(value, false);
    enable(value);
    expect(value.preparationAutomation?.events).toHaveLength(1);
    expect(() => begin(value)).toThrow(expect.objectContaining({ code: "AUTOMATION_NO_CHANGES" }));
  });
  it("실제 프로필/자료 변경만 해시로 기록하고 같은 트랜잭션 재생성은 중복하지 않는다", () => {
    const value = company();
    enable(value);
    const before = change(value, (copy) => {
      copy.profile.customers = "PRIVATE_고객";
      copy.sources.push(source());
    });
    expect(value.preparationAutomation?.events).toHaveLength(2);
    const saved = structuredClone(value.preparationAutomation);
    expect(collectPreparationAutomationChanges(before, value, at)).toEqual(saved);
    expect(JSON.stringify(saved)).not.toContain("PRIVATE_");
  });
  it("자료 updatedAt만 변경하거나 분석/원고/업무/단계가 바뀌면 재귀 사건을 생성하지 않는다", () => {
    const value = company();
    value.sources.push(source());
    enable(value);
    change(value, (copy) => {
      copy.sources[0].updatedAt = "2026-09-25T13:00:00.000Z";
      copy.stage = stageValues[1];
      copy.selectedCandidateId = "arbitrary";
    });
    expect(value.preparationAutomation?.events).toEqual([]);
  });
  it("본문 종류 변경·삭제도 별개 사건이며 동일 값으로 되돌려도 다른 revision 사건은 남긴다", () => {
    const value = company();
    value.sources.push(source());
    enable(value);
    change(value, (copy) => {
      copy.sources[0].kind = "finance";
    });
    change(value, (copy) => {
      copy.sources[0].kind = "technology";
    });
    change(value, (copy) => {
      copy.sources = [];
    });
    expect(value.preparationAutomation?.events.map((event) => event.change)).toEqual([
      "updated",
      "updated",
      "removed",
    ]);
    expect(
      new Set(value.preparationAutomation?.events.map((event) => event.changeDigest)).size,
    ).toBe(3);
  });
  it("여러 변경을 최신 한 묶음으로 고정하고 기존 preparation용 서버 nonce를 따로 만든다", () => {
    const value = company();
    enable(value);
    change(value, (copy) => {
      copy.profile.customers = "고객 변경";
    });
    change(value, (copy) => {
      copy.sources.push(source());
    });
    const input = request(value),
      old = structuredClone(value),
      result = begin(value, input);
    expect(result.batch.eventIds).toHaveLength(2);
    expect(result.command?.action).toBe("start");
    expect(result.command?.clientRequestId).not.toBe(input.clientRequestId);
    expect(value.plans).toEqual(old.plans);
    expect(value.analysis).toEqual(old.analysis);
    expect(value.selectedCandidateId).toBeNull();
    expect(JSON.stringify(result.batch)).not.toContain("PRIVATE_");
  });
  it("pending 원본만은 본문 검토 대기, 본문 채택은 새 사건이다", () => {
    const value = company();
    enable(value);
    change(value, (copy) => {
      copy.sources.push(source(true));
    });
    const waiting = begin(value);
    expect(waiting.command).toBeNull();
    expect(waiting.batch.status).toBe("source-review");
    change(value, (copy) => {
      copy.sources[0].text = "교정 후 채택";
      copy.sources[0].extraction = "manual";
    });
    const next = begin(value);
    expect(next.command?.action).toBe("start");
    expect(next.batch.eventIds).toHaveLength(1);
    expect(value.preparationAutomation?.events).toHaveLength(2);
  });
  it.each(["request", "response"] as const)(
    "기관 %s만 바뀌면 기존 검토로 연결하며 분석/원고 명령은 없다",
    (kind) => {
      const value = company();
      enable(value);
      change(value, (copy) => {
        copy.agencyRecords.push(agency(kind));
      });
      const before = structuredClone(value),
        result = begin(value);
      expect(result.command).toBeNull();
      expect(result.batch.status).toBe("request-review");
      expect(result.batch.agencyRecordIds).toEqual([value.agencyRecords[0].id]);
      expect(value.plans).toEqual(before.plans);
      expect(value.analysis).toEqual(before.analysis);
    },
  );
  it("자료 충분성은 기존 준비 결과를 따르고 pending 원문을 별도 입력으로 복제하지 않는다", () => {
    const value = company();
    value.profile.technologySummary = "";
    value.sources.push(source(true));
    enable(value);
    change(value, (copy) => {
      copy.profile.industry = "업종 메모";
    });
    const result = begin(value);
    expect(result.command?.action).toBe("start");
    const saved = run(value, result.batch, "awaiting_materials");
    expect(finishPreparationAutomation(value, result.batch.id, saved.id, at).batch.status).toBe(
      "awaiting_materials",
    );
    expect(JSON.stringify(result.batch)).not.toContain("PRIVATE_");
  });
  it("같은 실행 요청 replay는 명령0이며 다른 의미 nonce·새 CAS·허용버전 오류를 거부한다", () => {
    const { value, input } = pendingBatch(),
      before = structuredClone(value);
    expect(beginPreparationAutomation(value, input, meta())).toMatchObject({
      replayed: true,
      command: null,
    });
    expect(value).toEqual(before);
    expect(() =>
      beginPreparationAutomation(value, { ...input, expectedSettingVersion: 0 }, meta()),
    ).toThrow(expect.objectContaining({ code: "AUTOMATION_REQUEST_CONFLICT" }));
    expect(() =>
      beginPreparationAutomation(value, { ...input, clientRequestId: randomUUID() }, meta()),
    ).toThrow(expect.objectContaining({ code: "STALE_REVISION" }));
    expect(() =>
      beginPreparationAutomation(value, { ...request(value), expectedSettingVersion: 0 }, meta()),
    ).toThrow(expect.objectContaining({ code: "AUTOMATION_PERMISSION_CHANGED" }));
  });
  it("처리 중 다른 묶음을 중복 시작하지 않는다", () => {
    const { value } = pendingBatch();
    expect(() => begin(value)).toThrow(expect.objectContaining({ code: "AUTOMATION_BUSY" }));
  });
  it("준비 시작 전 crash 재개는 같은 서버 nonce를 재사용한다", () => {
    const { value, batch } = pendingBatch(),
      previous = batch.command;
    const result = begin(value, resume(value, batch));
    expect(result.command).toEqual(previous);
    expect(result.batch.requests).toHaveLength(2);
  });
  it("준비 완료 응답 유실 후 resume는 보관 run을 찾고 새 원고 명령을 만들지 않는다", () => {
    const { value, batch } = pendingBatch(),
      saved = run(value, batch, "awaiting_review");
    const result = begin(value, resume(value, batch));
    expect(result.command).toBeNull();
    expect(result.batch.preparationRunId).toBe(saved.id);
    expect(result.batch.status).toBe("awaiting_review");
    expect(() => begin(value, resume(value, result.batch))).toThrow(
      expect.objectContaining({ code: "AUTOMATION_CONFIRMATION_REQUIRED" }),
    );
  });
  it("실패 준비 resume checkpoint 이후 crash도 마지막 미처리 명령 nonce를 재사용한다", () => {
    const { value, batch } = pendingBatch(),
      saved = run(value, batch, "failed");
    const first = begin(value, resume(value, batch));
    expect(first.command).toMatchObject({ action: "resume", runId: saved.id });
    const second = begin(value, resume(value, first.batch));
    expect(second.command).toEqual(first.command);
    expect(value.preparationRuns).toHaveLength(1);
  });
  it("후보 자동 선택은 없고 이유·현재 분석·정확 digest 있는 명시 continue만 허용한다", () => {
    const { value, batch } = pendingBatch(),
      candidate = selection(value),
      saved = run(value, batch);
    value.preparationAutomation = finishPreparationAutomation(value, batch.id, saved.id, at).state;
    const input: PreparationAutomationRequest = {
      ...request(value),
      action: "continue-batch",
      batchId: batch.id,
      candidateId: candidate.id,
      candidateDigest: preparationDigest(candidate),
    };
    const without = structuredClone(value);
    without.candidateSelections = [];
    expect(() => begin(without, input)).toThrow(
      expect.objectContaining({ code: "AUTOMATION_SELECTION_REQUIRED" }),
    );
    expect(() => begin(value, { ...input, candidateDigest: "0".repeat(64) })).toThrow(
      expect.objectContaining({ code: "AUTOMATION_SELECTION_REQUIRED" }),
    );
    const result = begin(value, input);
    expect(result.command).toMatchObject({
      action: "continue",
      runId: saved.id,
      candidateId: candidate.id,
    });
    const recovery = begin(value, resume(value, result.batch));
    expect(recovery.command).toEqual(result.command);
  });
  it("새 사건이 생기면 이전 완료로 덮지 않고 superseded 기록과 미처리 사건을 유지한다", () => {
    const { value, batch } = pendingBatch(),
      saved = run(value, batch, "awaiting_review");
    change(value, (copy) => {
      copy.profile.customers = "추가 변경";
    });
    const result = finishPreparationAutomation(value, batch.id, saved.id, at);
    value.preparationAutomation = result.state;
    expect(result.batch.status).toBe("superseded");
    expect(value.preparationAutomation.events).toHaveLength(2);
    const next = begin(value);
    expect(next.batch.eventIds).toEqual([value.preparationAutomation.events[1].id]);
    expect(value.preparationRuns).toHaveLength(1);
  });
  it("실행 중 off는 산출물을 보존하고 후속 명령을 막는다", () => {
    const { value, batch } = pendingBatch(),
      saved = run(value, batch, "awaiting_review");
    enable(value, false);
    const before = structuredClone(value.preparationRuns),
      result = finishPreparationAutomation(value, batch.id, saved.id, at);
    expect(result.batch).toMatchObject({ status: "blocked", code: "AUTOMATION_DISABLED" });
    expect(value.preparationRuns).toEqual(before);
    expect(() => begin(value)).toThrow(expect.objectContaining({ code: "AUTOMATION_DISABLED" }));
  });
  it("변경 후 restart resume는 오래된 묶음을 끝내고 명령을 실행하지 않는다", () => {
    const { value, batch } = pendingBatch();
    change(value, (copy) => {
      copy.profile.team = "변경";
    });
    const result = begin(value, resume(value, batch));
    expect(result.batch.status).toBe("superseded");
    expect(result.command).toBeNull();
  });
  it("다른 run ID·중복 준비 nonce는 완료 근거로 사용할 수 없다", () => {
    const { value, batch } = pendingBatch(),
      saved = run(value, batch);
    expect(() => finishPreparationAutomation(value, batch.id, randomUUID(), at)).toThrow(
      expect.objectContaining({ code: "AUTOMATION_RECORD_INVALID" }),
    );
    value.preparationRuns.push({ ...saved, id: randomUUID() });
    expect(() => finishPreparationAutomation(value, batch.id, saved.id, at)).toThrow(
      expect.objectContaining({ code: "AUTOMATION_RECORD_INVALID" }),
    );
  });
  it("사건 한도면 자료 변경은 반환하되 자동연결 overflow를 명시하고 이력을 자르지 않는다", () => {
    const value = company();
    enable(value);
    change(value, (copy) => {
      copy.profile.team = "첫 변경";
    });
    const sample = value.preparationAutomation!.events[0];
    value.preparationAutomation!.events = Array.from(
      { length: preparationAutomationLimits.events },
      (_, index) => ({
        ...sample,
        id: randomUUID(),
        changeDigest: index.toString(16).padStart(64, "0"),
      }),
    );
    const old = structuredClone(value.preparationAutomation!.events);
    change(value, (copy) => {
      copy.profile.team = "PRIVATE_한도후변경";
    });
    expect(value.preparationAutomation!.events).toEqual(old);
    expect(value.preparationAutomation!.overflow).not.toBeNull();
    expect(JSON.stringify(value.preparationAutomation!.overflow)).not.toContain("PRIVATE_");
    expect(() => begin(value)).toThrow(expect.objectContaining({ code: "AUTOMATION_LIMIT" }));
    enable(value, false);
    expect(preparationAutomationEnabled(value.preparationAutomation)).toBe(false);
  });
  it("설정 일반50개 한도에서도 마지막 disable 하나는 보존한다", () => {
    const value = company();
    enable(value);
    const sample = value.preparationAutomation!.settings[0];
    value.preparationAutomation!.settings = Array.from({ length: 50 }, (_, index) => ({
      ...sample,
      id: randomUUID(),
      clientRequestId: randomUUID(),
      version: index + 1,
    }));
    enable(value, false);
    expect(value.preparationAutomation!.settings).toHaveLength(51);
    expect(preparationAutomationEnabled(value.preparationAutomation)).toBe(false);
    expect(() => enable(value)).toThrow(expect.objectContaining({ code: "AUTOMATION_LIMIT" }));
  });
  it("묶음·재개 요청 한도는 기존 기록을 줄이지 않는다", () => {
    const { value, batch } = pendingBatch();
    value.preparationAutomation!.batches[0].requests = Array.from({ length: 20 }, () => ({
      clientRequestId: randomUUID(),
      digest: "a".repeat(64),
      preparationRequestId: batch.command!.clientRequestId,
    }));
    const before = structuredClone(value);
    expect(() => begin(value, resume(value, batch))).toThrow(
      expect.objectContaining({ code: "AUTOMATION_LIMIT" }),
    );
    expect(value).toEqual(before);
  });
  it("다른 기업·revision 비약·임의 모드/확인·원문 주입을 거부한다", () => {
    const left = company(),
      right = company();
    expect(() => collectPreparationAutomationChanges(left, right, at)).toThrow();
    right.id = left.id;
    right.revision = 20;
    expect(() => collectPreparationAutomationChanges(left, right, at)).toThrow();
    for (const extra of [
      { mode: "ai" },
      { confirmed: true },
      { text: "PRIVATE_본문" },
      { automaticSubmit: true },
    ])
      expect(
        preparationAutomationRequestSchema.safeParse({ ...request(left), ...extra }).success,
      ).toBe(false);
    expect(
      preparationAutomationSettingInputSchema.safeParse({ ...setting(left), provider: "external" })
        .success,
    ).toBe(false);
  });
  it("다른 기업에 복사한 자동준비 허용/사건 기록은 실행할 수 없다", () => {
    const { value } = pendingBatch(),
      other = company();
    other.preparationAutomation = structuredClone(value.preparationAutomation);
    expect(() => begin(other)).toThrow(
      expect.objectContaining({ code: "AUTOMATION_RECORD_INVALID" }),
    );
    expect(() => configurePreparationAutomation(other, setting(other, false), meta())).toThrow(
      expect.objectContaining({ code: "AUTOMATION_RECORD_INVALID" }),
    );
  });
  it.each(["dirty", "busy", "officialInput"] as const)(
    "UI %s 때 자동 요청을 허용하지 않는다",
    (key) => {
      const input = {
        enabled: true,
        overflow: false,
        sameCompanyRevision: true,
        visible: true,
        dirty: false,
        busy: false,
        officialInput: false,
      };
      expect(canRequestPreparationAutomation(input)).toBe(true);
      expect(canRequestPreparationAutomation({ ...input, [key]: true })).toBe(false);
      expect(canRequestPreparationAutomation({ ...input, visible: false })).toBe(false);
      expect(canRequestPreparationAutomation({ ...input, sameCompanyRevision: false })).toBe(false);
    },
  );
  it("상태 기본값은 호출마다 독립적이다", () => {
    const left = emptyPreparationAutomation(),
      right = emptyPreparationAutomation();
    expect(left).toEqual(right);
    expect(left.events).not.toBe(right.events);
  });
});
