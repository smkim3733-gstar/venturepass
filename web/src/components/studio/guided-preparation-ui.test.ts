import { describe, expect, it } from "vitest";
import { caseSchema, emptyProfile, type StudioCase } from "@/lib/studio-schema";
import type {
  GuidedPreparationApproval,
  GuidedPreparationRequest,
  GuidedPreparationRun,
} from "@/lib/studio-guided-preparation-types";
import {
  guidedPreparationResponse,
  guidedPreparationSnapshot,
  guidedRequestRejected,
} from "./guided-preparation-ui";

const companyId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const otherId = "44444444-4444-4444-8444-444444444444";
const now = "2026-09-26T00:00:00.000Z";
const hash = "a".repeat(64);

function company(change: Partial<StudioCase> = {}): StudioCase {
  return caseSchema.parse({
    id: companyId,
    profile: { ...emptyProfile(), companyName: "가상 응답 검증 기업" },
    sources: [],
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: "preparing",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    ...change,
  });
}

function approval(change: Partial<GuidedPreparationApproval> = {}): GuidedPreparationApproval {
  return {
    caseId: companyId,
    revision: 1,
    provider: "OpenAI",
    model: "synthetic-model-never-called",
    inputFingerprint: hash,
    sourceIds: [],
    sourceNames: [],
    profileIncluded: true,
    businessNumberIncluded: false,
    originalFilesIncluded: false,
    derivedDraftIncluded: true,
    purpose: "analysis-plan-review",
    ...change,
  };
}

function start(): Extract<GuidedPreparationRequest, { action: "start" }> {
  return {
    action: "start",
    revision: 1,
    clientRequestId: requestId,
    approval: approval(),
    approved: true,
  };
}

function run(change: Partial<GuidedPreparationRun> = {}): GuidedPreparationRun {
  return {
    id: runId,
    mode: "ai",
    approval: approval(),
    approvedAt: now,
    status: "awaiting_choice",
    phase: "analysis",
    analysisDigest: hash,
    candidateId: null,
    candidateDigest: null,
    planId: null,
    code: null,
    requests: [{ clientRequestId: requestId, digest: hash }],
    createdAt: now,
    updatedAt: now,
    ...change,
  };
}

function response(savedRun = run()) {
  return {
    company: company({ revision: 3, guidedPreparationRuns: [structuredClone(savedRun)] }),
    run: structuredClone(savedRun),
  };
}

function snapshot() {
  return {
    company: company({ revision: 3 }),
    approval: approval({ revision: 3 }),
    active: false,
    aiConfigured: true,
  };
}

describe("자동 준비 상태 조회의 회사·자료 버전 바인딩", () => {
  it("같거나 최신 revision과 명시적인 실행 상태를 수락한다", () => {
    const value = snapshot();
    expect(guidedPreparationSnapshot(value, company())?.company.revision).toBe(3);
    expect(
      guidedPreparationSnapshot({ ...value, active: true }, company({ revision: 3 }))?.active,
    ).toBe(true);
    expect(
      guidedPreparationSnapshot({ ...value, aiConfigured: false }, company())?.aiConfigured,
    ).toBe(false);
  });

  it("준비 이력이 아직 없는 기존 기업도 읽을 수 있다", () => {
    const value = snapshot();
    delete value.company.guidedPreparationRuns;
    expect(guidedPreparationSnapshot(value, company())?.company.id).toBe(companyId);
  });

  it("다른 회사의 응답은 승인표가 일치해도 수락하지 않는다", () => {
    const value = snapshot();
    value.company.id = otherId;
    value.approval.caseId = otherId;
    expect(guidedPreparationSnapshot(value, company())).toBeNull();
  });

  it("현재 화면보다 오래된 회사 자료로 되돌리지 않는다", () => {
    expect(guidedPreparationSnapshot(snapshot(), company({ revision: 4 }))).toBeNull();
  });

  it.each([
    ["다른 회사", { caseId: otherId }],
    ["이전 자료 버전", { revision: 2 }],
    ["응답보다 미래 자료 버전", { revision: 4 }],
  ] satisfies [string, Partial<GuidedPreparationApproval>][])(
    "%s의 승인표를 거부한다",
    (_label, change) => {
      const value = snapshot();
      Object.assign(value.approval, change);
      expect(guidedPreparationSnapshot(value, company())).toBeNull();
    },
  );

  it.each([
    ["active", undefined],
    ["active", "false"],
    ["aiConfigured", undefined],
    ["aiConfigured", 1],
  ])("%s의 누락·잘못된 타입을 추정해 수락하지 않는다", (key, value) => {
    expect(
      guidedPreparationSnapshot({ ...snapshot(), [key as string]: value }, company()),
    ).toBeNull();
  });
});

describe("자동 준비 쓰기 응답의 저장된 요청 바인딩", () => {
  it("저장된 실행과 정확한 요청 nonce가 포함된 응답만 수락한다", () => {
    const value = response();
    expect(guidedPreparationResponse(value, company(), start())).toMatchObject({
      company: { id: companyId, revision: 3 },
      run: { id: runId },
    });
  });

  it("같은 요청 nonce의 재응답은 상태를 바꾸지 않고 다시 수락한다", () => {
    const value = response();
    const before = structuredClone(value);
    const request = start();
    const first = guidedPreparationResponse(value, company(), request);
    const replay = guidedPreparationResponse(value, company({ revision: 3 }), request);
    expect(first).not.toBeNull();
    expect(replay).toEqual(first);
    expect(value).toEqual(before);
    expect(value.run.requests).toHaveLength(1);
  });

  it("재응답이라도 현재 화면보다 오래된 결과는 수락하지 않는다", () => {
    expect(guidedPreparationResponse(response(), company({ revision: 4 }), start())).toBeNull();
  });

  it("다른 회사 결과는 회사·승인표가 함께 바뀌어도 수락하지 않는다", () => {
    const value = response(run({ approval: approval({ caseId: otherId }) }));
    value.company.id = otherId;
    expect(guidedPreparationResponse(value, company(), start())).toBeNull();
  });

  it.each([
    ["회사", { caseId: otherId }],
    ["revision", { revision: 2 }],
    ["모델", { model: "other-synthetic-model" }],
    ["자료 지문", { inputFingerprint: "b".repeat(64) }],
    ["자료 목록", { sourceIds: [otherId], sourceNames: ["가상 추가자료.txt"] }],
  ] satisfies [string, Partial<GuidedPreparationApproval>][])(
    "요청한 %s 승인 범위와 다른 실행을 거부한다",
    (_label, change) => {
      expect(
        guidedPreparationResponse(
          response(run({ approval: approval(change) })),
          company(),
          start(),
        ),
      ).toBeNull();
    },
  );

  it("승인표의 값이 같으면 JSON 객체 키 순서에 관계없이 수락한다", () => {
    const request = start();
    request.approval = Object.fromEntries(
      Object.entries(request.approval).reverse(),
    ) as GuidedPreparationApproval;
    expect(guidedPreparationResponse(response(), company(), request)?.run.id).toBe(runId);
  });

  it.each(["누락", "빈 목록", "저장 내용 변경"])(
    "저장된 실행 이력 %s을 성공 표시로 대신하지 않는다",
    (mode) => {
      const value = response();
      if (mode === "누락") delete value.company.guidedPreparationRuns;
      if (mode === "빈 목록") value.company.guidedPreparationRuns = [];
      if (mode === "저장 내용 변경") value.run.status = "failed";
      expect(guidedPreparationResponse({ ...value, success: true }, company(), start())).toBeNull();
    },
  );

  it("응답 실행과 저장 이력에서 요청 nonce가 빠지면 거부한다", () => {
    const value = response(run({ requests: [{ clientRequestId: otherId, digest: hash }] }));
    expect(guidedPreparationResponse(value, company(), start())).toBeNull();
  });

  it("이전 nonce의 결과를 새 요청에 재사용하지 않는다", () => {
    expect(
      guidedPreparationResponse(response(), company(), { ...start(), clientRequestId: otherId }),
    ).toBeNull();
  });

  it("이어가기 요청은 요청한 실행 ID와 일치해야 한다", () => {
    const request: GuidedPreparationRequest = {
      action: "continue",
      revision: 2,
      clientRequestId: requestId,
      runId,
    };
    expect(guidedPreparationResponse(response(), company(), request)?.run.id).toBe(runId);
    expect(
      guidedPreparationResponse(response(), company(), { ...request, runId: otherId }),
    ).toBeNull();
  });

  it("동일 실행 ID가 중복된 저장 이력은 어느 기록도 승인 근거로 삼지 않는다", () => {
    const value = response();
    value.company.guidedPreparationRuns!.push(structuredClone(value.run));
    expect(guidedPreparationResponse(value, company(), start())).toBeNull();
  });

  it.each(["같은 실행", "다른 실행"])("%s의 중복 nonce는 모호한 응답으로 거부한다", (mode) => {
    const value = response();
    if (mode === "같은 실행") {
      value.run.requests.push({ clientRequestId: requestId, digest: "b".repeat(64) });
      value.company.guidedPreparationRuns = [structuredClone(value.run)];
    } else {
      value.company.guidedPreparationRuns!.push(run({ id: otherId }));
    }
    expect(guidedPreparationResponse(value, company(), start())).toBeNull();
  });
});

describe("명시적인 다시 준비 응답은 이전 시도와 새 승인에 연결됨", () => {
  function restart(): Extract<GuidedPreparationRequest, { action: "restart" }> {
    return {
      ...start(),
      action: "restart",
      previousRunId: otherId,
      acknowledgedPreviousAttempt: true,
    };
  }

  function restartedResponse() {
    const value = response(run({ retryOfId: otherId }));
    value.company.guidedPreparationRuns!.unshift(
      run({
        id: otherId,
        status: "failed",
        code: "GUIDED_FAILED",
        requests: [
          {
            clientRequestId: "55555555-5555-4555-8555-555555555555",
            digest: "b".repeat(64),
          },
        ],
      }),
    );
    return value;
  }

  it("이전 실패 기록과 연결된 새 실행을 수락하고 이전 기록을 보존한다", () => {
    const value = restartedResponse();
    const before = structuredClone(value);
    const result = guidedPreparationResponse(value, company(), restart());
    expect(result?.run).toMatchObject({ id: runId, retryOfId: otherId });
    expect(result?.company.guidedPreparationRuns).toHaveLength(2);
    expect(value).toEqual(before);
  });

  it.each([undefined, null, runId])(
    "요청한 이전 실행과 retryOfId=%s가 다르면 거부한다",
    (retryOfId) => {
      const value = response(run({ retryOfId }));
      expect(guidedPreparationResponse(value, company(), restart())).toBeNull();
    },
  );

  it("같은 이전 시도라도 새로 확인한 승인 범위가 다르면 거부한다", () => {
    const value = response(
      run({ retryOfId: otherId, approval: approval({ inputFingerprint: "b".repeat(64) }) }),
    );
    expect(guidedPreparationResponse(value, company(), restart())).toBeNull();
  });

  it("다시 준비 승인도 객체 키 순서가 아닌 값으로 대조한다", () => {
    const request = restart();
    request.approval = Object.fromEntries(
      Object.entries(request.approval).reverse(),
    ) as GuidedPreparationApproval;
    expect(guidedPreparationResponse(restartedResponse(), company(), request)?.run.id).toBe(runId);
  });

  it("다시 준비의 같은 nonce 재응답은 새 시도를 추가하지 않는다", () => {
    const value = restartedResponse();
    const request = restart();
    const accepted = guidedPreparationResponse(value, company(), request);
    expect(accepted).not.toBeNull();
    expect(guidedPreparationResponse(value, company({ revision: 3 }), request)).toEqual(accepted);
    expect(value.company.guidedPreparationRuns).toHaveLength(2);
  });
});

describe("모호한 응답은 새 요청 허용으로 바꾸지 않음", () => {
  it.each([400, 403, 409, 413, 415, 422, 500])(
    "HTTP %s라도 accepted:true이면 저장 가능성이 남으므로 거부 확정이 아니다",
    (status) => {
      expect(guidedRequestRejected(status, { accepted: true, code: "GUIDED_FAILED" })).toBe(false);
    },
  );

  it.each([400, 403, 409, 413, 415, 422, 500])(
    "HTTP %s에서 명시적인 accepted:false는 미수락으로 구분한다",
    (status) => {
      expect(guidedRequestRejected(status, { accepted: false, code: "GUIDED_REJECTED" })).toBe(
        true,
      );
    },
  );

  it.each([409, 429, 500, 502, 503])(
    "HTTP %s의 불명확한 오류에는 새 요청을 허용하지 않는다",
    (status) => {
      expect(guidedRequestRejected(status, { code: "UNKNOWN_RESULT" })).toBe(false);
    },
  );

  it.each([400, 403, 413, 415, 422])("HTTP %s의 입력 거부 응답을 구분한다", (status) => {
    expect(guidedRequestRejected(status, { code: "INVALID_INPUT" })).toBe(true);
  });

  it.each([null, undefined, "error", 0, true])(
    "해석할 수 없는 응답 %s를 거부 확정하지 않는다",
    (value) => {
      expect(guidedRequestRejected(400, value)).toBe(false);
      expect(guidedPreparationSnapshot(value, company())).toBeNull();
      expect(guidedPreparationResponse(value, company(), start())).toBeNull();
    },
  );
});
