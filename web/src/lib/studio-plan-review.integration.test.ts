import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import { emptyProfile, type StudioCase } from "./studio-schema";
import type { PlanReviewDecisionInput } from "./studio-plan-review-types";
import { withVentureInputCompanyLock } from "./venturein-input-lock";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ store: null as StudioStore | null, external: vi.fn() }));
vi.mock("@/lib/studio-storage", async (original) => ({
  ...(await original<typeof import("./studio-storage")>()),
  getStudioStore: () => state.store!,
}));
vi.mock("@/lib/venturein-runner", () => ({ stopVentureSession: state.external }));
vi.mock("openai", () => ({
  default: class {
    constructor() {
      state.external();
    }
  },
}));
import { GET, PATCH } from "@/app/api/studio/cases/[caseId]/route";

let directory: string;
let company: StudioCase;
const store = () => state.store!;
function database<T>(action: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(directory, "studio.sqlite"));
  try {
    return action(db);
  } finally {
    db.close();
  }
}
function savedRow() {
  return database((db) =>
    db
      .prepare("SELECT body,revision,evidence_revision FROM studio_cases WHERE id=?")
      .get(company.id),
  );
}
function mutateFixture(change: (value: StudioCase) => void) {
  const value = structuredClone(company);
  change(value);
  database((db) =>
    db.prepare("UPDATE studio_cases SET body=? WHERE id=?").run(JSON.stringify(value), value.id),
  );
  company = store().get(value.id);
}
function decision(): PlanReviewDecisionInput {
  const plan = company.plans[0];
  const previous = company.planReviewDecisions.at(-1);
  return {
    planId: plan.id,
    planVersion: plan.version,
    findingIndex: 0,
    finding: structuredClone(plan.review[0]),
    previousRecordId: previous?.id ?? null,
    status: "deferred",
    reason: "근거 확인 대기",
    reviewer: "합성 담당자",
  };
}
function request(input = decision(), clientRequestId: string = randomUUID()) {
  return {
    action: "append-plan-review",
    revision: company.revision,
    clientRequestId,
    decision: input,
  };
}
function patch(
  body: unknown,
  options: { caseId?: string; query?: string; headers?: Record<string, string> } = {},
) {
  const caseId = options.caseId ?? company.id;
  return PATCH(
    new Request(`http://localhost:3000/api/studio/cases/${caseId}${options.query ?? ""}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...options.headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ caseId }) },
  );
}
async function save(body = request()) {
  const response = await patch(body);
  expect(response.status).toBe(200);
  company = await response.json();
  return company.planReviewDecisions.at(-1)!;
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "venture-review-test-"));
  state.store = new StudioStore(directory);
  company = store().create({ ...emptyProfile(), companyName: "합성 검토 회사" });
  const now = new Date().toISOString();
  company = store().mutate(
    company.id,
    {
      action: "source",
      revision: company.revision,
      source: {
        id: randomUUID(),
        name: "합성 근거",
        kind: "technology",
        text: "현재 개발 중인 기술입니다.",
        originalName: null,
        mimeType: null,
        extraction: "manual",
        warnings: [],
        createdAt: now,
        updatedAt: now,
      },
    },
    () => [],
  );
  company = store().saveAnalysis(
    company.id,
    company.revision,
    {
      summary: "합성 분석",
      facts: [],
      questions: [],
      warnings: [],
      candidates: [
        {
          id: "candidate",
          title: "후보",
          problem: "문제",
          solution: "해결",
          targetCustomer: "고객",
          differentiation: "미확인",
          stage: "개발 중",
          businessModel: "미확인",
          recommendation: "검토 필요",
          evidence: [],
          gaps: [],
        },
      ],
    },
    "assisted",
  );
  company = store().mutate(
    company.id,
    {
      action: "select-candidate",
      revision: company.revision,
      clientRequestId: randomUUID(),
      candidateId: "candidate",
      analysisGeneratedAt: company.analysis!.generatedAt,
      analysisSourceRevision: company.analysis!.sourceRevision,
      expectedSelectedCandidateId: company.selectedCandidateId,
      reason: "합성 후보 선택 근거",
    },
    () => [],
  );
  company = store().saveGeneratedPlan(
    company.id,
    company.revision,
    "candidate",
    {
      title: "검토 대상 원고",
      summary: "부족한 항목",
      sections: [
        {
          key: "problem",
          title: "문제",
          content: "개발 중입니다.",
          evidence: [
            { sourceId: company.sources[0].id, quote: company.sources[0].text, locator: "본문" },
          ],
          needsConfirmation: true,
        },
      ],
      actionItems: [],
      interviewQuestions: [],
    },
    [
      {
        id: "review-1",
        severity: "error",
        category: "missing-section",
        message: "신청기술 항목이 없습니다.",
        action: "내용 보완",
        sectionKey: "solution",
        sourceIds: [company.sources[0].id],
      },
    ],
    "assisted",
  );
  state.external.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  store().close();
  const boundary = relative(resolve(tmpdir()), resolve(directory));
  if (!/^venture-review-test-[^\\/]+$/.test(boundary)) throw new Error("Unsafe synthetic cleanup");
  rmSync(directory, { recursive: true, force: true });
  expect(state.external).not.toHaveBeenCalled();
});

describe("검토 의견 처리 API / 합성 SQLite", () => {
  it("legacy 기본값과 최초 이력, 정정, 재시작을 보존하며 검토/기관 상태를 바꾸지 않는다", async () => {
    mutateFixture((value) => {
      Reflect.deleteProperty(value, "planReviewDecisions");
    });
    expect(company.planReviewDecisions).toEqual([]);
    const before = structuredClone(company);
    const first = await save();
    expect(first).toMatchObject({ stale: false, status: "deferred", origin: "manual", version: 1 });
    await save(request({ ...decision(), status: "resolved", reason: "원문을 확인했습니다." }));
    expect(company.planReviewDecisions).toHaveLength(2);
    expect(company.planReviewDecisions[0]).toEqual(first);
    expect(company.plans).toEqual(before.plans);
    expect(company.tasks).toEqual(before.tasks);
    expect(company.stage).toBe(before.stage);
    expect(company.agencyRecords).toEqual(before.agencyRecords);
    store().close();
    state.store = new StudioStore(directory);
    expect(store().get(company.id)).toEqual(company);
  });
  it("같은 nonce 응답유실 재시도는 stale revision이어도 무쓰기, 다른 내용은 409", async () => {
    const input = request();
    await save(input);
    const before = savedRow();
    const retry = await patch(input);
    expect(retry.status).toBe(200);
    expect(savedRow()).toEqual(before);
    expect((await retry.json()).planReviewDecisions).toHaveLength(1);
    const conflict = await patch({
      ...input,
      decision: { ...input.decision, reason: "다른 이유" },
    });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe("PLAN_REVIEW_REQUEST_CONFLICT");
    expect(savedRow()).toEqual(before);
  });
  it("새 nonce의 오래된 revision과 같은 체인의 오래된 parent를 거부한다", async () => {
    const old = request();
    await save();
    const before = savedRow();
    expect((await patch(old)).status).toBe(409);
    const result = await patch(request({ ...decision(), previousRecordId: null }));
    expect((await result.json()).code).toBe("PLAN_REVIEW_VERSION_STALE");
    expect(savedRow()).toEqual(before);
  });
  it("다른 회사의 원고/parent와 nonce 교차를 허용하지 않는다", async () => {
    const original = request();
    await save(original);
    const other = store().create({ ...emptyProfile(), companyName: "다른 합성 회사" });
    const result = await patch({ ...original, revision: other.revision }, { caseId: other.id });
    expect(result.status).toBe(404);
    expect(store().get(other.id).planReviewDecisions).toEqual([]);
    expect((await patch(request({ ...decision(), previousRecordId: randomUUID() }))).status).toBe(
      409,
    );
  });
  it("해결 기록은 기존 error / 확인 필요 / confirm-plan guard를 해제하지 않는다", async () => {
    await save(request({ ...decision(), status: "resolved" }));
    const before = savedRow();
    const response = await patch({
      action: "confirm-plan",
      revision: company.revision,
      planId: company.plans[0].id,
    });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("REVIEW_REQUIRED");
    expect(savedRow()).toEqual(before);
    expect(store().get(company.id).plans[0].confirmedAt).toBeNull();
  });
  it("자료 변경 후 현재성만 응답에서 바꾸고 저장된 판단 snapshot은 유지한다", async () => {
    await save(request({ ...decision(), status: "resolved" }));
    const originalHistory = JSON.parse(String(savedRow()!.body)).planReviewDecisions;
    const input = {
      action: "source",
      revision: company.revision,
      source: { ...company.sources[0], text: "내용 변경" },
    };
    const result = await patch(input);
    expect(result.status).toBe(200);
    company = await result.json();
    expect(company.planReviewDecisions[0]).toMatchObject({ status: "resolved", stale: true });
    expect(company.planReviewDecisions[0].staleReasons).toContain("evidence-changed");
    expect(JSON.parse(String(savedRow()!.body)).planReviewDecisions).toEqual(originalHistory);
    const before = savedRow();
    const response = await GET(
      new Request(`http://localhost:3000/api/studio/cases/${company.id}`),
      { params: Promise.resolve({ caseId: company.id }) },
    );
    expect((await response.json()).planReviewDecisions[0].stale).toBe(true);
    expect(savedRow()).toEqual(before);
  });
  it("같은 review ID의 다른 내용과 같은 원고 ID 본문 변경을 거부한다", async () => {
    const old = request();
    mutateFixture((value) => {
      value.plans[0].review[0].action = "다른 처리";
    });
    expect((await patch(old)).status).toBe(409);
    await save();
    mutateFixture((value) => {
      value.plans[0].content.summary = "동일 ID 변조";
    });
    expect(company.planReviewDecisions[0].staleReasons).toContain("plan-changed");
    const before = savedRow();
    const changed = await patch(request());
    expect((await changed.json()).code).toBe("PLAN_REVIEW_PLAN_CHANGED");
    expect(savedRow()).toEqual(before);
  });
  it("새 원고 버전은 과거 해결 판단을 상속하지 않는다", async () => {
    await save(request({ ...decision(), status: "resolved" }));
    const original = structuredClone(company.plans[0]);
    const edited = {
      ...original.content,
      summary: "문서 기재와 담당자 설명을 구분한 새 버전",
      actionItems: ["향후 계획의 비용 점검"],
      interviewQuestions: ["근거가 확인되지 않은 권리는 무엇인가요?"],
      sections: original.content.sections.map((section) => ({
        ...section,
        title: "확인할 항목",
        needsConfirmation: true,
      })),
    };
    const response = await patch({
      action: "save-plan",
      revision: company.revision,
      planId: original.id,
      content: edited,
    });
    expect(response.status).toBe(200);
    company = await response.json();
    expect(company.plans).toHaveLength(2);
    expect(company.plans[1].confirmedAt).toBeNull();
    expect(company.plans[0]).toEqual(original);
    expect(company.plans[1].content).toEqual(edited);
    expect(company.plans[1].mode).toBe("manual");
    expect(company.planReviewDecisions.every((item) => item.planId === original.id)).toBe(true);
  });
  it.each(["review-first", "numeric-first"] as const)(
    "%s: 검토 판단과 수치 대조가 같은 원고의 고정 SHA를 양방향으로 존중한다",
    async (order) => {
      const numeric = () => ({
        action: "append-numeric-check",
        revision: company.revision,
        clientRequestId: randomUUID(),
        check: {
          checkId: null,
          previousVersionId: null,
          title: "합성 원고 수치 확인",
          observations: [
            {
              id: randomUUID(),
              label: "아직 수치 없음",
              valueText: "",
              unit: "unknown",
              customUnit: "",
              period: { kind: "unknown", start: "", end: "" },
              basis: "unknown",
              note: "",
              reference: {
                kind: "plan",
                planId: company.plans[0].id,
                sectionKey: "problem",
                quote: company.plans[0].content.sections[0].content,
              },
            },
          ],
          comparisons: [],
          formulas: [],
          judgement: { state: "unreviewed", reviewer: "", note: "" },
        },
      });
      if (order === "review-first") await save();
      else {
        const created = await patch(numeric());
        expect(created.status).toBe(200);
        company = await created.json();
      }
      mutateFixture((value) => {
        value.plans[0].content.summary = "동일 ID의 변조된 본문";
      });
      const before = savedRow();
      const rejected = await patch(order === "review-first" ? numeric() : request());
      expect(rejected.status).toBe(409);
      expect((await rejected.json()).code).toBe(
        order === "review-first" ? "NUMERIC_PLAN_CHANGED" : "PLAN_REVIEW_PLAN_CHANGED",
      );
      expect(savedRow()).toEqual(before);
    },
  );
  it("공식 입력 회사 잠금은 최초 요청과 replay 모두 차단한다", async () => {
    const input = request();
    await save(input);
    const before = savedRow();
    await withVentureInputCompanyLock(company.id, async () => {
      for (const body of [input, request()]) {
        const response = await patch(body);
        expect(response.status).toBe(409);
        expect((await response.json()).code).toBe("INPUT_IN_PROGRESS");
      }
    });
    expect(savedRow()).toEqual(before);
  });
  it("query / foreign origin / strict 서버 메타 주입은 무쓰기 거부한다", async () => {
    const before = savedRow();
    expect((await patch(request(), { query: "?plan=1" })).status).toBe(400);
    expect((await patch(request(), { headers: { origin: "https://example.com" } })).status).toBe(
      403,
    );
    for (const body of [
      { ...request(), recordedAt: "2026-09-25" },
      request({ ...decision(), stale: false } as PlanReviewDecisionInput),
      request({
        ...decision(),
        finding: { ...decision().finding, resolved: true },
      } as PlanReviewDecisionInput),
    ])
      expect((await patch(body)).status).toBe(400);
    expect(savedRow()).toEqual(before);
  });
  it("보관 한도와 SQL 실패는 전체 저장을 롤백한다", async () => {
    await save();
    mutateFixture((value) => {
      const first = value.planReviewDecisions[0];
      value.planReviewDecisions = Array.from({ length: 200 }, (_, index) => ({
        ...first,
        id: randomUUID(),
        clientRequestId: randomUUID(),
        version: index + 1,
      }));
    });
    const before = savedRow();
    const response = await patch(request());
    expect(response.status).toBe(413);
    expect(savedRow()).toEqual(before);
    mutateFixture((value) => {
      value.planReviewDecisions = [];
    });
    database((db) =>
      db.exec(
        "CREATE TRIGGER reject_review BEFORE UPDATE ON studio_cases BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
      ),
    );
    const beforeFailure = savedRow();
    expect((await patch(request())).status).toBe(500);
    expect(savedRow()).toEqual(beforeFailure);
  });
});
