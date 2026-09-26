import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { caseSchema, emptyProfile, type StudioCase } from "@/lib/studio-schema";
import type { PreparationRequest, PreparationRun } from "@/lib/studio-preparation-types";
import {
  preparationAction,
  preparationWasRejected,
  PreparationPanel,
  PreparationRunView,
  validatePreparationResponse,
  validatePreparationSnapshot,
} from "./preparation-panel";

const companyId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const now = "2026-09-25T00:00:00.000Z";
const hash = "a".repeat(64);
function company(change: Partial<StudioCase> = {}): StudioCase {
  return caseSchema.parse({
    id: companyId,
    profile: { ...emptyProfile(), companyName: "가상 준비 기업" },
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
function run(change: Partial<PreparationRun> = {}): PreparationRun {
  return {
    id: runId,
    mode: "assisted",
    inputFingerprint: hash,
    criteriaVersion: "test-criteria",
    sourceRevision: 1,
    createdAt: now,
    updatedAt: now,
    status: "awaiting_choice",
    phase: "choice",
    stale: false,
    code: null,
    diagnosisId: null,
    analysisDigest: hash,
    candidates: [{ id: "candidate-1", digest: hash }],
    selectedCandidateId: null,
    selectedCandidateDigest: null,
    planId: null,
    planDigest: null,
    steps: [{ phase: "analysis", state: "reused", artifactId: null, at: now }],
    requests: [{ clientRequestId: requestId, digest: hash }],
    ...change,
  };
}
function selectedCompany() {
  const record = company({
    selectedCandidateId: "candidate-1",
    analysis: {
      summary: "가상 기술 정리",
      generatedAt: now,
      sourceRevision: 1,
      mode: "assisted",
      facts: [],
      questions: [],
      warnings: [],
      candidates: [
        {
          id: "candidate-1",
          title: "가상 아이템",
          problem: "문제",
          solution: "해결",
          targetCustomer: "고객",
          differentiation: "추가 확인",
          stage: "개발 중",
          businessModel: "자료 필요",
          recommendation: "담당자 선택 필요",
          evidence: [],
          gaps: [],
        },
      ],
    },
  });
  record.candidateSelections = [
    {
      id: "44444444-4444-4444-8444-444444444444",
      clientRequestId: requestId,
      inputDigest: hash,
      recordedAt: now,
      origin: "manual",
      event: "selection",
      reason: "가상 근거를 대조해 직접 선택",
      previousCandidateId: null,
      candidateId: "candidate-1",
      analysisGeneratedAt: now,
      analysisSourceRevision: 1,
      analysisMode: "assisted",
      analysisDigest: hash,
      candidateDigest: hash,
      candidate: structuredClone(record.analysis!.candidates[0]),
      previousCandidate: null,
      previousContext: "none",
      previousRecordId: null,
    },
  ];
  return record;
}
function panel(record = company(), dirty = false, busy = false) {
  const onBusyChange = vi.fn(),
    onCompany = vi.fn(),
    goTo = vi.fn();
  const html = renderToStaticMarkup(
    createElement(PreparationPanel, {
      company: record,
      dirty,
      busy,
      onBusyChange,
      onCompany,
      goTo,
    }),
  );
  return { html, onBusyChange, onCompany, goTo };
}

describe("local preparation action boundaries", () => {
  it("starts only from no run or an explicitly stale historical run", () => {
    expect(preparationAction(company(), null)).toEqual({ action: "start" });
    expect(preparationAction(company(), run({ stale: true }))).toEqual({ action: "start" });
  });
  it("never chooses the single candidate automatically", () => {
    expect(preparationAction(company(), run())).toBeNull();
  });
  it("continues with the explicitly selected current candidate and stored digest", () => {
    expect(preparationAction(selectedCompany(), run())).toEqual({
      action: "continue",
      runId,
      candidateId: "candidate-1",
      candidateDigest: hash,
    });
  });
  it("does not continue a legacy selection without an explicit reason record", () => {
    const record = selectedCompany();
    record.candidateSelections = [];
    expect(preparationAction(record, run())).toBeNull();
  });
  it("does not reuse a reason after analysis time or selected candidate content changes", () => {
    const newer = selectedCompany();
    newer.analysis!.generatedAt = "2026-09-26T00:00:00.000Z";
    expect(preparationAction(newer, run())).toBeNull();
    const changed = selectedCompany();
    changed.analysis!.candidates[0].solution = "같은 ID의 다른 해결방법";
    expect(preparationAction(changed, run())).toBeNull();
  });
  it("rejects a candidate absent from either current analysis or the checkpoint", () => {
    expect(preparationAction(selectedCompany(), run({ candidates: [] }))).toBeNull();
    expect(preparationAction(company({ selectedCandidateId: "candidate-1" }), run())).toBeNull();
  });
  it.each(["running", "failed"] as const)("allows explicit resume of %s", (status) => {
    expect(preparationAction(company(), run({ status }))).toEqual({ action: "resume", runId });
  });
  it.each(["blocked", "awaiting_review", "awaiting_materials"] as const)(
    "does not start another run for unchanged %s",
    (status) => expect(preparationAction(company(), run({ status }))).toBeNull(),
  );
});

describe("preparation response binding", () => {
  it("distinguishes authoritative rejection from possible checkpoint writes", () => {
    expect(preparationWasRejected(409, { accepted: false, code: "STALE_REVISION" })).toBe(true);
    expect(preparationWasRejected(400, { code: "INVALID_INPUT" })).toBe(true);
    expect(preparationWasRejected(409, { accepted: true, code: "STALE_REVISION" })).toBe(false);
    expect(preparationWasRejected(400, { accepted: true, code: "INVALID_INPUT" })).toBe(false);
    expect(preparationWasRejected(500, { code: "INTERNAL_ERROR" })).toBe(false);
    expect(preparationWasRejected(400, null)).toBe(false);
  });
  const request: PreparationRequest = { action: "start", revision: 1, clientRequestId: requestId };
  function response() {
    return { company: company({ revision: 3, preparationRuns: [run()] }), run: run() };
  }
  it("accepts a matching saved checkpoint and request nonce", () => {
    expect(validatePreparationResponse(response(), company(), request)?.company.revision).toBe(3);
  });
  it("rejects another company, a regressed revision, and malformed data", () => {
    const other = response();
    other.company.id = runId;
    expect(validatePreparationResponse(other, company(), request)).toBeNull();
    const older = response();
    older.company.revision = 0;
    expect(validatePreparationResponse(older, company(), request)).toBeNull();
    expect(validatePreparationResponse({}, company(), request)).toBeNull();
  });
  it("rejects missing or different persisted run data and unknown request nonce", () => {
    const missing = response();
    missing.company.preparationRuns = [];
    expect(validatePreparationResponse(missing, company(), request)).toBeNull();
    const changed = response();
    changed.run.status = "failed";
    expect(validatePreparationResponse(changed, company(), request)).toBeNull();
    expect(
      validatePreparationResponse(response(), company(), { ...request, clientRequestId: runId }),
    ).toBeNull();
  });
  it("requires the requested resume run and rejects duplicate checkpoint identifiers", () => {
    expect(
      validatePreparationResponse(response(), company(), {
        ...request,
        action: "resume",
        runId: requestId,
      }),
    ).toBeNull();
    const duplicate = response();
    duplicate.company.preparationRuns.push(run());
    expect(validatePreparationResponse(duplicate, company(), request)).toBeNull();
  });
});

describe("read-only preparation snapshot", () => {
  function snapshot() {
    return { companyRevision: 3, running: false, runs: [run()] };
  }
  function saved() {
    return company({ revision: 3, preparationRuns: [run()] });
  }
  it("accepts consistent current status including an active server request", () => {
    expect(validatePreparationSnapshot(snapshot(), saved(), company())?.running).toBe(false);
    expect(
      validatePreparationSnapshot({ ...snapshot(), running: true }, saved(), company())?.running,
    ).toBe(true);
  });
  it("rejects a company revision changing between the two GET requests", () => {
    const changed = saved();
    changed.revision = 4;
    expect(validatePreparationSnapshot(snapshot(), changed, company())).toBeNull();
    expect(validatePreparationSnapshot(snapshot(), saved(), company({ revision: 4 }))).toBeNull();
  });
  it("rejects another company and legacy status without an active-request indicator", () => {
    expect(
      validatePreparationSnapshot(snapshot(), { ...saved(), id: runId }, company()),
    ).toBeNull();
    expect(
      validatePreparationSnapshot({ companyRevision: 3, runs: [run()] }, saved(), company()),
    ).toBeNull();
  });
  it("rejects changed checkpoints and ambiguous duplicate nonce or run bindings", () => {
    expect(validatePreparationSnapshot({ ...snapshot(), runs: [] }, saved(), company())).toBeNull();
    const duplicate = saved();
    duplicate.preparationRuns.push(run());
    expect(
      validatePreparationSnapshot(
        { ...snapshot(), runs: duplicate.preparationRuns },
        duplicate,
        company(),
      ),
    ).toBeNull();
    duplicate.preparationRuns[1] = run({ id: requestId });
    expect(
      validatePreparationSnapshot(
        { ...snapshot(), runs: duplicate.preparationRuns },
        duplicate,
        company(),
      ),
    ).toBeNull();
  });
});

describe("preparation user guidance", () => {
  it("directs a legacy selection to reason entry without inventing approval", () => {
    const record = selectedCompany();
    record.candidateSelections = [];
    record.preparationRuns = [run()];
    const output = panel(record);
    expect(output.html).toContain("현재 분석의 아이템 선택 이유를 먼저 기록");
    expect(output.html).toContain("아이템 근거·선택 이유 기록");
    expect(output.onCompany).not.toHaveBeenCalled();
  });
  it("renders local-only boundaries without invoking mutations", () => {
    const output = panel();
    expect(output.html).toContain("외부 AI로 전송하지 않습니다");
    expect(output.html).toContain("실제 자료 검토, 내부 검토 완료 표시");
    expect(output.html).toContain("벤처인 입력·동의·제출은 이 동작에 포함되지 않습니다");
    expect(output.onCompany).not.toHaveBeenCalled();
    expect(output.onBusyChange).not.toHaveBeenCalled();
  });
  it("disables requests while editing or another task is busy", () => {
    for (const html of [panel(company(), true).html, panel(company(), false, true).html]) {
      const buttons = html.match(/<button\b[^>]*>/g) ?? [];
      expect(buttons.length).toBeGreaterThan(0);
      expect(buttons.every((button) => button.includes('disabled=""'))).toBe(true);
    }
    expect(panel(company(), true).html).toContain("편집 중인 내용을 먼저 저장하거나 취소");
  });
  it("shows manual candidate selection even for a single candidate", () => {
    const html = panel(company({ preparationRuns: [run()] })).html;
    expect(html).toContain("후보가 하나여도 자동 선택하지 않습니다");
    expect(html).toContain("아이템 근거·선택 이유 기록");
    expect(html).not.toContain("선택한 아이템으로 이어가기");
  });
  it("shows an explicit continue label after saved selection", () => {
    const selected = selectedCompany();
    selected.preparationRuns = [run()];
    expect(panel(selected).html).toContain("선택한 아이템으로 이어가기");
  });
  it("labels an unreviewed draft without asserting internal review or submission readiness", () => {
    const html = renderToStaticMarkup(
      createElement(PreparationRunView, {
        run: run({ status: "awaiting_review", phase: "review" }),
      }),
    );
    expect(html).toContain("담당자 검토 필요");
    expect(html).toContain("기관 제출 준비 완료를 뜻하지 않습니다");
    expect(html).toContain("기존 결과 사용");
  });
  it("shows materials and old records without presenting them as current preparation", () => {
    const html = panel(
      company({
        preparationRuns: [run(), run({ id: requestId, stale: true, status: "awaiting_materials" })],
      }),
    ).html;
    expect(html).toContain("기업정보 보강");
    expect(html).toContain("자료함 확인");
    expect(html).toContain("과거 자료·선택 기준");
    expect(html).toContain("이전 준비 기록 1개");
  });
  it("keeps original-only materials outside reviewed analysis", () => {
    const html = panel(
      company({
        sources: [
          {
            id: requestId,
            name: "가상 원본",
            kind: "technology",
            text: "",
            originalName: "scan.pdf",
            mimeType: "application/pdf",
            extraction: "pending",
            warnings: [],
            createdAt: now,
            updatedAt: now,
          },
        ],
      }),
    ).html;
    expect(html).toContain("원본만 보관한 자료 1건은 본문 확인 전까지 분석 근거에서 제외");
    expect(html).toContain("본문 검토도 자동 완료하지 않습니다");
  });
  it("renders stored codes as escaped text", () => {
    const html = renderToStaticMarkup(
      createElement(PreparationRunView, {
        run: run({ status: "blocked", code: "<script>not-executable</script>" }),
      }),
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
  it("identifies the recorded plan version when the editor will open a newer version", () => {
    const first = {
      id: requestId,
      version: 1,
      generatedAt: now,
      mode: "assisted" as const,
      candidateId: "candidate-1",
      sourceRevision: 1,
      content: {
        title: "가상 초안",
        summary: "원문 검토 필요",
        sections: [],
        actionItems: [],
        interviewQuestions: [],
      },
      review: [],
      confirmedAt: null,
    };
    const html = panel(
      company({
        plans: [first, { ...first, id: runId, version: 2 }],
        preparationRuns: [
          run({ planId: requestId }),
          run({ id: requestId, planId: runId, status: "awaiting_review", phase: "review" }),
        ],
      }),
    ).html;
    expect(html).toContain("이 준비 기록의 원고 v1");
    expect(html).toContain("현재 최신 원고는 v2");
    expect(html).toContain("이 준비 기록의 원고 v2");
    expect(html).toContain("원고 화면에서 해당 버전을 선택해 확인");
    expect(html).toContain("원고 버전·검토 의견 확인");
    expect(html).not.toContain(requestId);
  });
  it("does not substitute the latest version for a missing recorded plan", () => {
    const html = renderToStaticMarkup(
      createElement(PreparationRunView, {
        run: run({ planId: requestId }),
        plans: [],
      }),
    );
    expect(html).toContain("이 준비 기록의 원고 버전을 확인하지 못했습니다");
    expect(html).not.toContain("원고 v");
  });
});
