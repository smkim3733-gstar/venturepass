import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import {
  emptyProfile,
  originalOnlyWarnings,
  type SourceDocument,
  type StudioCase,
} from "./studio-schema";
import { claimReviewContext, type ClaimReviewInput } from "./studio-claim-review-types";
import { diagnosisInputFingerprint } from "./studio-diagnosis";
import { assertClaimReviewCapacity } from "./studio-claim-review";
import { withVentureInputCompanyLock } from "./venturein-input-lock";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  store: null as StudioStore | null,
  ai: vi.fn(),
  runner: vi.fn(),
}));
vi.mock("@/lib/studio-storage", async (original) => ({
  ...(await original<typeof import("./studio-storage")>()),
  getStudioStore: () => state.store!,
}));
vi.mock("openai", () => ({
  default: class {
    constructor() {
      state.ai();
    }
  },
}));
vi.mock("@/lib/venturein-runner", () => ({ stopVentureSession: state.runner }));
import { GET, PATCH } from "@/app/api/studio/cases/[caseId]/route";

describe("주장 검토 API / 실제 임시 SQLite", () => {
  let directory: string, company: StudioCase;
  const store = () => state.store!;
  const read = () => (company = store().get(company.id));
  const database = <T>(action: (db: DatabaseSync) => T) => {
    const db = new DatabaseSync(join(directory, "studio.sqlite"));
    try {
      return action(db);
    } finally {
      db.close();
    }
  };
  const row = () =>
    database((db) =>
      db
        .prepare("SELECT body,revision,evidence_revision FROM studio_cases WHERE id=?")
        .get(company.id)!,
    );
  const fixtureSave = (value: unknown = company) => {
    database((db) =>
      db
        .prepare("UPDATE studio_cases SET body=? WHERE id=?")
        .run(JSON.stringify(value), company.id),
    );
    read();
  };
  const input = (): ClaimReviewInput => ({
    claimId: null,
    previousVersionId: null,
    planId: company.plans[0].id,
    planVersion: company.plans[0].version,
    sectionKey: "technology",
    claimQuote: "실험 10건",
    nature: "unknown",
    references: [],
    contextNote: "실행 여부 확인 필요",
    owner: "",
    dueOn: "",
    nextCheck: "",
    method: "unreviewed",
    externalCheck: { target: "", content: "", occurredOn: "" },
    judgement: { state: "unreviewed", reviewer: "", reason: "", checkedOn: "" },
    numericReferences: [],
    planReviewReferences: [],
  });
  const body = (claim = input(), clientRequestId = randomUUID(), revision = company.revision) => ({
    action: "append-claim-review",
    revision,
    clientRequestId,
    claim,
  });
  const patch = (
    payload: unknown,
    suffix = "",
    headers: Record<string, string> = {},
    caseId = company.id,
  ) =>
    PATCH(
      new Request(`http://localhost:3000/api/studio/cases/${caseId}${suffix}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...headers },
        body: typeof payload === "string" ? payload : JSON.stringify(payload),
      }),
      { params: Promise.resolve({ caseId }) },
    );
  const save = async (value = input()) => {
    const response = await patch(body(value));
    const json = await response.json();
    expect(response.status, JSON.stringify(json)).toBe(200);
    company = json;
    return company.claimReviews.at(-1)!;
  };
  const addSource = (original = false, pending = false, id = company.id) => {
    const now = new Date().toISOString();
    const source: SourceDocument = {
      id: randomUUID(),
      name: "합성 실험 증빙",
      kind: "technology",
      text: pending ? "" : "실험 10건 기록",
      originalName: original ? "fixture.pdf" : null,
      mimeType: original ? "application/pdf" : null,
      extraction: pending ? "pending" : "manual",
      warnings: pending ? [...originalOnlyWarnings] : [],
      createdAt: now,
      updatedAt: now,
    };
    const bytes = Buffer.from("%PDF-1.7\nfixture-synthetic-original\n%%EOF");
    const target = store().get(id);
    const updated = original
      ? store().addUpload(id, target.revision, source, bytes)
      : store().mutate(id, { action: "source", revision: target.revision, source }, () => []);
    if (id === company.id) company = updated;
    return {
      source: updated.sources.find((s) => s.id === source.id)!,
      bytes,
      path: join(directory, "originals", id, `${source.id}.bin`),
    };
  };
  const bind = (value: ClaimReviewInput, source: SourceDocument, quote = "실험 10건") => ({
    ...value,
    references: [{ sourceId: source.id, sourceUpdatedAt: source.updatedAt, quote, locator: "1쪽" }],
  });
  const agencyBody = (sourceId: string) => ({
    action: "append-agency-record",
    revision: company.revision,
    clientRequestId: randomUUID(),
    record: {
      kind: "request",
      institution: "합성 기관",
      title: "보완 요청",
      body: "합성 내용",
      occurredOn: "2026-09-25",
      dueOn: "",
      dueNote: "",
      note: "수동 기록",
      sourceIds: [sourceId],
    },
  });
  beforeEach(() => {
    vi.clearAllMocks();
    directory = mkdtempSync(join(tmpdir(), "venture-claim-test-"));
    state.store = new StudioStore(directory);
    company = store().create({ ...emptyProfile(), companyName: "합성 주장 회사" });
    const now = new Date().toISOString();
    company.plans.push({
      id: randomUUID(),
      version: 1,
      mode: "manual",
      candidateId: "fixture",
      generatedAt: now,
      sourceRevision: 0,
      confirmedAt: now,
      content: {
        title: "합성 원고",
        summary: "검증 아님",
        sections: [
          {
            key: "technology",
            title: "기술",
            content: "실험 10건, 미확인 주장입니다.",
            evidence: [],
            needsConfirmation: true,
          },
        ],
        actionItems: [],
        interviewQuestions: [],
      },
      review: [],
    });
    fixtureSave();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    store().close();
    const boundary = relative(resolve(tmpdir()), resolve(directory));
    if (!boundary.startsWith("venture-claim-test-") || boundary.includes(".."))
      throw new Error("Unsafe synthetic cleanup");
    rmSync(directory, { recursive: true, force: true });
    expect(state.ai).not.toHaveBeenCalled();
    expect(state.runner).not.toHaveBeenCalled();
  });
  it("구형 자료는 가짜 이력 없이 읽고 재시작하며 GET은 무쓰기다", async () => {
    const old = { ...company } as Partial<StudioCase>;
    delete old.claimReviews;
    fixtureSave(old);
    const before = row();
    store().close();
    state.store = new StudioStore(directory);
    const response = await GET(
      new Request(`http://localhost:3000/api/studio/cases/${company.id}`),
      { params: Promise.resolve({ caseId: company.id }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect((await response.json()).claimReviews).toEqual([]);
    expect(row()).toEqual(before);
  });
  it("검토 기록은 근거revision·진단 fingerprint·원고·분석·준비 상태를 바꾸지 않는다", async () => {
    const before = structuredClone(company),
      prior = row(),
      fingerprint = diagnosisInputFingerprint(company);
    await save();
    expect(row().evidence_revision).toBe(prior.evidence_revision);
    expect(diagnosisInputFingerprint(company)).toBe(fingerprint);
    for (const key of [
      "profile",
      "sources",
      "plans",
      "analysis",
      "tasks",
      "stage",
      "stageHistory",
      "diagnoses",
      "diagnosisAnswers",
      "preparationRuns",
      "agencyRecords",
    ] as const)
      expect(company[key]).toEqual(before[key]);
    expect(company.revision).toBe(before.revision + 1);
  });
  it("같은 nonce는 재시작·옛 revision에도 무쓰기 재사용하고 변경내용은 충돌한다", async () => {
    const request = body();
    let response = await patch(request);
    expect(response.status).toBe(200);
    company = await response.json();
    const before = row();
    store().close();
    state.store = new StudioStore(directory);
    response = await patch(request);
    expect(response.status).toBe(200);
    expect(row()).toEqual(before);
    response = await patch({ ...request, claim: { ...request.claim, contextNote: "다름" } });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("CLAIM_REVIEW_REQUEST_CONFLICT");
    expect(row()).toEqual(before);
  });
  it("후속 판단·새 원고 재연결은 과거 버전을 유지하고 옛 CAS/버전을 거부한다", async () => {
    const first = await save(),
      oldInput = input();
    const plan = { ...structuredClone(company.plans[0]), id: randomUUID(), version: 2 };
    plan.content.sections[0].content = "실험 12건 목표";
    company.plans.push(plan);
    fixtureSave();
    const next = {
      ...oldInput,
      claimId: first.claimId,
      previousVersionId: first.id,
      planId: plan.id,
      planVersion: 2,
      claimQuote: "실험 12건",
    };
    const second = await save(next);
    expect(second.claimId).toBe(first.claimId);
    expect(company.claimReviews[0]).toEqual(first);
    const before = row();
    expect((await patch(body(next))).status).toBe(409);
    expect((await patch(body(input(), randomUUID(), company.revision - 1))).status).toBe(409);
    expect(row()).toEqual(before);
  });
  it.each(["plan", "source", "root", "auxiliary"])("다른 회사 %s 연결은 거부한다", async (kind) => {
    const other = store().create({ ...emptyProfile(), companyName: "다른 합성 회사" });
    const value = input();
    if (kind === "plan") value.planId = randomUUID();
    if (kind === "source") {
      const foreign = addSource(false, false, other.id);
      value.references = [
        {
          sourceId: foreign.source.id,
          sourceUpdatedAt: foreign.source.updatedAt,
          quote: "실험 10건",
          locator: "",
        },
      ];
    }
    if (kind === "root") {
      value.claimId = randomUUID();
      value.previousVersionId = randomUUID();
    }
    if (kind === "auxiliary") value.numericReferences = [{ id: randomUUID(), version: 1 }];
    const before = row();
    expect([404, 422]).toContain((await patch(body(value))).status);
    expect(row()).toEqual(before);
    expect(store().get(other.id).claimReviews).toEqual([]);
  });
  it.each(["origin", "hash", "firstJudgement", "revision", "unknown"])(
    "엄격한 입력 %s 거부",
    async (kind) => {
      const value = body() as Record<string, unknown>;
      const claim = value.claim as ClaimReviewInput & Record<string, unknown>;
      if (kind === "origin") claim.origin = "official";
      if (kind === "hash") claim.planSnapshots = [];
      if (kind === "firstJudgement") {
        claim.method = "document";
        claim.judgement = {
          state: "consistent",
          reviewer: "담당자",
          reason: "임의",
          checkedOn: "2026-09-25",
        };
      }
      if (kind === "revision") value.revision = -1;
      if (kind === "unknown") value.submit = true;
      const before = row();
      expect((await patch(value)).status).toBe(400);
      expect(row()).toEqual(before);
    },
  );
  it("외부 Origin·query·미디어·512KiB 초과를 쓰기 전에 거부한다", async () => {
    const value = body(),
      before = row();
    expect((await patch(value, "?submit=1")).status).toBe(400);
    expect((await patch(value, "", { origin: "https://foreign.invalid" })).status).toBe(403);
    expect((await patch(value, "", { "content-type": "text/plain" })).status).toBe(415);
    expect(
      (await patch({ ...value, claim: { ...value.claim, contextNote: "x".repeat(512 * 1024) } }))
        .status,
    ).toBe(413);
    expect(row()).toEqual(before);
  });
  it("공식 입력 잠금 중 저장하지 않고 해제 후에만 저장한다", async () => {
    const before = row();
    await withVentureInputCompanyLock(company.id, async () =>
      expect((await patch(body())).status).toBe(409),
    );
    expect(row()).toEqual(before);
    expect((await patch(body())).status).toBe(200);
  });
  it("pending 원본은 두 번 안전하게 읽지만 본문·분석·추출 상태를 바꾸지 않는다", async () => {
    const item = addSource(true, true),
      before = structuredClone(item.source);
    const spy = vi.spyOn(store(), "originalForVentureInput");
    const record = await save(bind(input(), item.source, ""));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(record.sourceSnapshots[0]).toMatchObject({
      extraction: "pending",
      original: { sizeBytes: item.bytes.length },
    });
    expect(company.sources[0]).toEqual(before);
    expect(record.judgement.state).toBe("unreviewed");
  });
  it("연결한 자료 삭제는 거부하며 정상 본문 수정은 과거 판단을 덮지 않는다", async () => {
    const item = addSource(true);
    const record = await save(bind(input(), item.source));
    const before = row();
    let response = await patch({
      action: "delete-source",
      revision: company.revision,
      sourceId: item.source.id,
    });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("CLAIM_SOURCE_REFERENCED");
    expect(existsSync(item.path)).toBe(true);
    expect(row()).toEqual(before);
    company = store().mutate(
      company.id,
      {
        action: "source",
        revision: company.revision,
        source: { ...company.sources[0], text: "실험 10건 기록, 추가 수정" },
      },
      () => [],
    );
    expect(claimReviewContext(company, record).state).toBe("stale");
    expect(company.claimReviews[0]).toEqual(record);
    response = await patch(body(bind(input(), item.source)));
    expect(response.status).toBe(409);
  });
  it("저장 사이 같은 크기 원본 변조는 전체 SQL 작업을 롤백한다", async () => {
    const item = addSource(true),
      native = store().originalForVentureInput.bind(store());
    let calls = 0;
    vi.spyOn(store(), "originalForVentureInput").mockImplementation((caseId, sourceId) => {
      calls++;
      if (calls === 2) writeFileSync(item.path, Buffer.alloc(item.bytes.length, 42));
      return native(caseId, sourceId);
    });
    const before = row();
    const response = await patch(body(bind(input(), item.source)));
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("CLAIM_ORIGINAL_CHANGED");
    expect(row()).toEqual(before);
  });
  it("기존 기관 증빙의 원본 변조를 새 주장으로 덮지 않는다", async () => {
    const item = addSource(true);
    const response = await patch(agencyBody(item.source.id));
    expect(response.status).toBe(200);
    company = await response.json();
    const before = row();
    writeFileSync(item.path, Buffer.alloc(item.bytes.length, 43));
    const rejected = await patch(body(bind(input(), item.source)));
    expect(rejected.status).toBe(409);
    expect((await rejected.json()).code).toBe("CLAIM_ORIGINAL_CHANGED");
    expect(row()).toEqual(before);
  });
  it("주장에서 고정한 원본 변조는 후속 기관 증빙 연결도 거부한다", async () => {
    const item = addSource(true);
    await save(bind(input(), item.source));
    const before = row();
    writeFileSync(item.path, Buffer.alloc(item.bytes.length, 44));
    expect((await patch(agencyBody(item.source.id))).status).toBe(409);
    expect(row()).toEqual(before);
  });
  it("같은 ID의 원고 내용 변조는 주장이 남아 있으면 차단한다", async () => {
    await save();
    company.plans[0].content.summary = "변경";
    fixtureSave();
    const before = row();
    const result = await patch(body());
    expect(result.status).toBe(409);
    expect((await result.json()).code).toBe("CLAIM_PLAN_CHANGED");
    expect(row()).toEqual(before);
  });
  it("참고 원고 판단은 저장된 버전만 연결하고 stale 파생값 변경을 변조로 오인하지 않는다", async () => {
    company.plans[0].review = [
      {
        id: "r",
        severity: "warning",
        category: "evidence",
        message: "자료 확인",
        action: "대조",
        sectionKey: "technology",
        sourceIds: [],
      },
    ];
    fixtureSave();
    company = store().mutate(
      company.id,
      {
        action: "append-plan-review",
        revision: company.revision,
        clientRequestId: randomUUID(),
        decision: {
          planId: company.plans[0].id,
          planVersion: 1,
          findingIndex: 0,
          finding: company.plans[0].review[0],
          previousRecordId: null,
          status: "deferred",
          reason: "자료 확인",
          reviewer: "담당자",
        },
      },
      () => [],
    );
    const review = company.planReviewDecisions[0];
    const value = {
      ...input(),
      planReviewReferences: [{ id: review.id, version: review.version }],
    };
    const first = await save(value);
    company = store().mutate(
      company.id,
      {
        action: "profile",
        revision: company.revision,
        profile: { ...company.profile, technologySummary: "새 기술 설명" },
      },
      () => [],
    );
    expect(company.planReviewDecisions[0].stale).toBe(true);
    const second = await save({ ...value, claimId: first.claimId, previousVersionId: first.id });
    expect(second.auxiliarySnapshots).toEqual(first.auxiliarySnapshots);
    expect(claimReviewContext(company, second).state).toBe("stale");
  });
  it("200개 버전 한도는 기존 이력을 잘라내지 않는다", async () => {
    const first = await save();
    company.claimReviews = Array.from({ length: 200 }, () => {
      const id = randomUUID();
      return {
        ...structuredClone(first),
        id,
        claimId: id,
        clientRequestId: randomUUID(),
        contextNote: "",
        owner: "",
        nextCheck: "",
        claimQuote: "실험",
      };
    });
    expect(() => assertClaimReviewCapacity(company.claimReviews)).not.toThrow();
    fixtureSave();
    const before = row();
    const result = await patch(body());
    expect(result.status).toBe(409);
    expect((await result.json()).code).toBe("CLAIM_REVIEW_LIMIT");
    expect(row()).toEqual(before);
  });
  it("문자열 합계 한도는 새 기록 전체를 롤백한다", async () => {
    const first = await save();
    const id = randomUUID();
    const largeRecord = {
      ...structuredClone(first),
      id,
      claimId: id,
      clientRequestId: randomUUID(),
      contextNote: "x".repeat(2000),
      nextCheck: "y".repeat(2000),
      externalCheck: { target: "기관", content: "z".repeat(2000), occurredOn: "2026-09-25" },
      judgement: { ...first.judgement, reason: "r".repeat(2000) },
    };
    company.claimReviews = [];
    while (company.claimReviews.length < 199) {
      const next = randomUUID();
      const candidate = { ...largeRecord, id: next, claimId: next, clientRequestId: randomUUID() };
      try {
        assertClaimReviewCapacity([...company.claimReviews, candidate]);
      } catch {
        break;
      }
      company.claimReviews.push(candidate);
    }
    expect(() => assertClaimReviewCapacity(company.claimReviews)).not.toThrow();
    fixtureSave();
    const before = row();
    const large = {
      ...input(),
      contextNote: "x".repeat(2000),
      nextCheck: "y".repeat(2000),
      externalCheck: { target: "기관", content: "z".repeat(2000), occurredOn: "2026-09-25" },
      judgement: { ...input().judgement, reason: "r".repeat(2000) },
    };
    const result = await patch(body(large));
    expect(result.status).toBe(409);
    expect((await result.json()).code).toBe("CLAIM_REVIEW_LIMIT");
    expect(row()).toEqual(before);
  });
});
