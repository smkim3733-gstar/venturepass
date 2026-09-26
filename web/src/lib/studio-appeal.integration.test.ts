import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import {
  emptyProfile,
  originalOnlyWarnings,
  type StudioCase,
  type SourceDocument,
} from "./studio-schema";
import { appealPreparationContext, type AppealPreparationInput } from "./studio-appeal-types";
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
import { PATCH } from "@/app/api/studio/cases/[caseId]/route";

describe("소명 준비 버전 API/실제 임시 SQLite", () => {
  let directory: string;
  let company: StudioCase;
  const store = () => state.store!;
  const read = () => (company = store().get(company.id));
  const mutate = (mutation: Parameters<StudioStore["mutate"]>[1]) => {
    company = store().mutate(company.id, mutation, () => []);
    return company;
  };
  const saveFixture = (next: StudioCase) => {
    const db = new DatabaseSync(join(directory, "studio.sqlite"));
    db.prepare("UPDATE studio_cases SET body = ? WHERE id = ?").run(JSON.stringify(next), next.id);
    db.close();
    read();
  };
  function addNotice(category: "decision" | "receipt" = "decision") {
    mutate({
      action: "append-agency-record",
      revision: company.revision,
      clientRequestId: randomUUID(),
      record: {
        kind: "notice",
        institution: "가상 기관",
        title: "수동 결과 기록",
        body: "시장 검증의 추가 근거가 필요합니다.",
        occurredOn: "",
        note: "",
        sourceIds: [],
        details:
          category === "decision"
            ? {
                category,
                decisionText: "담당자 입력 결과",
                notifiedOn: "",
                reasons: "시장 검증 근거 부족",
              }
            : { category, receiptNumber: "", receivedOn: "", statusText: "" },
      },
    });
    return company.agencyRecords.at(-1)!;
  }
  function input(): AppealPreparationInput {
    const notice = company.agencyRecords.at(-1)!;
    return {
      preparationId: null,
      previousVersionId: null,
      noticeRecordId: notice.id,
      noticeVersionId: notice.id,
      title: "소명 준비 초안",
      intent: "undecided",
      intentNote: "",
      deadlineOn: "",
      deadlineNote: "미확인",
      reasons: [
        {
          id: randomUUID(),
          noticeField: "reasons",
          noticeQuote: "시장 검증 근거 부족",
          claim: "설명은 아직 검토하지 않았습니다.",
          planClaim: null,
          gap: "추가 근거 확인 필요",
          evidence: [],
          additionalEvidence: [],
          draft: "수동으로 작성한 소명 초안",
        },
      ],
      review: { reviewed: false, reviewer: "", note: "" },
    };
  }
  const body = (
    preparation = input(),
    clientRequestId = randomUUID(),
    revision = company.revision,
  ) => ({ action: "append-appeal-preparation", revision, clientRequestId, preparation });
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
        body: JSON.stringify(payload),
      }),
      { params: Promise.resolve({ caseId }) },
    );
  const save = async (preparation = input()) => {
    const response = await patch(body(preparation));
    expect(response.status).toBe(200);
    company = await response.json();
    return company.appealPreparations.at(-1)!;
  };
  const next = (preparation: AppealPreparationInput): AppealPreparationInput => {
    const last = company.appealPreparations.at(-1)!;
    return { ...preparation, preparationId: last.preparationId, previousVersionId: last.id };
  };
  function addSource(original = false, pending = false) {
    const now = new Date().toISOString();
    const source: SourceDocument = {
      id: randomUUID(),
      name: "합성 시장 자료",
      kind: "market",
      text: pending ? "" : "가상 고객이 시제품을 검토했습니다. 미검증 진술입니다.",
      originalName: original ? "synthetic.pdf" : null,
      mimeType: original ? "application/pdf" : null,
      extraction: pending ? "pending" : "manual",
      warnings: pending ? [...originalOnlyWarnings] : [],
      createdAt: now,
      updatedAt: now,
    };
    const bytes = Buffer.from("%PDF-1.7\nsynthetic-original\n%%EOF");
    if (original) company = store().addUpload(company.id, company.revision, source, bytes);
    else mutate({ action: "source", revision: company.revision, source });
    return {
      source: company.sources.find((item) => item.id === source.id)!,
      bytes,
      path: join(directory, "originals", company.id, `${source.id}.bin`),
    };
  }
  const ref = (source: SourceDocument, quote = "가상 고객이 시제품을 검토했습니다.") => ({
    sourceId: source.id,
    sourceUpdatedAt: source.updatedAt,
    quote,
    locator: "등록 본문",
  });
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "venture-appeal-test-"));
    state.store = new StudioStore(directory);
    company = store().create({ ...emptyProfile(), companyName: "합성 소명 시험회사" });
    state.ai.mockClear();
    state.runner.mockClear();
    addNotice();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    store().close();
    const boundary = relative(resolve(tmpdir()), resolve(directory));
    if (!boundary.startsWith("venture-appeal-test-") || boundary.includes(".."))
      throw new Error("Unsafe cleanup");
    rmSync(directory, { recursive: true, force: true });
    expect(state.ai).not.toHaveBeenCalled();
    expect(state.runner).not.toHaveBeenCalled();
  });
  it("appends manual history without changing source, analysis, tasks, stage, or evidence revision", async () => {
    const before = structuredClone(company);
    const record = await save();
    expect(record).toMatchObject({
      version: 1,
      preparationId: record.id,
      origin: "manual",
      review: { reviewedAt: null },
    });
    expect(company.revision).toBe(before.revision + 1);
    for (const key of [
      "sources",
      "analysis",
      "plans",
      "tasks",
      "stage",
      "stageHistory",
      "agencyRecords",
    ] as const)
      expect(company[key]).toEqual(before[key]);
    const db = new DatabaseSync(join(directory, "studio.sqlite"));
    expect(
      db.prepare("SELECT evidence_revision FROM studio_cases WHERE id=?").get(company.id),
    ).toEqual({ evidence_revision: 0 });
    db.close();
  });
  it("keeps explicit internal reviewer and unresolved gaps without implying submission", async () => {
    const value = input();
    value.review = { reviewed: true, reviewer: "가상 담당자", note: "내용만 검토" };
    const record = await save(value);
    expect(record.review.reviewedAt).toBe(record.recordedAt);
    expect(record.reasons[0].gap).not.toBe("");
    expect(company.stage).toBe("preparing");
    expect(appealPreparationContext(company, record).reviewCurrent).toBe(true);
  });
  it("appends a new version while preserving prior draft and review", async () => {
    const value = input();
    value.review = { reviewed: true, reviewer: "가상 담당자", note: "" };
    const first = await save(value);
    const edited = next(value);
    edited.review = { reviewed: false, reviewer: "", note: "" };
    edited.reasons = [{ ...edited.reasons[0], draft: "수정 초안" }];
    const second = await save(edited);
    expect(second).toMatchObject({
      preparationId: first.id,
      previousVersionId: first.id,
      version: 2,
    });
    expect(company.appealPreparations[0]).toEqual(first);
    expect(second.review.reviewedAt).toBeNull();
  });
  it("replays the same canonical input after restart and stale CAS without new writes", async () => {
    const payload = body();
    expect((await patch(payload)).status).toBe(200);
    read();
    const snapshot = structuredClone(company);
    store().close();
    state.store = new StudioStore(directory);
    const response = await patch(payload);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(snapshot);
  });
  it("rejects changed content with the same nonce", async () => {
    const payload = body();
    await patch(payload);
    const before = read();
    payload.preparation.title = "다른 내용";
    expect((await patch(payload)).status).toBe(409);
    expect(read()).toEqual(before);
  });
  it("rejects stale CAS and a stale previous version", async () => {
    const value = input();
    const payload = body(value);
    await save(value);
    expect((await patch({ ...payload, clientRequestId: randomUUID() })).status).toBe(409);
    const version2 = next(value);
    await save(version2);
    const response = await patch(body(version2));
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("APPEAL_VERSION_STALE");
  });
  it("rejects duplicate preparation roots and cross-notice root reassignment", async () => {
    const value = input();
    await save(value);
    expect((await patch(body(value))).status).toBe(409);
    const edited = next(value);
    const other = addNotice();
    edited.noticeRecordId = other.id;
    edited.noticeVersionId = other.id;
    const response = await patch(body(edited));
    expect((await response.json()).code).toBe("APPEAL_ROOT_MISMATCH");
  });
  it("binds latest decision version and marks prior internal review stale after correction", async () => {
    const value = input();
    value.review = { reviewed: true, reviewer: "검토자", note: "" };
    const saved = await save(value);
    const notice = company.agencyRecords[0];
    mutate({
      action: "append-agency-record",
      revision: company.revision,
      clientRequestId: randomUUID(),
      record: {
        kind: "notice-correction",
        noticeRecordId: notice.id,
        previousVersionId: notice.id,
        institution: "가상 기관",
        title: "정정 결과",
        body: "변경 사유",
        occurredOn: "",
        note: "",
        sourceIds: [],
        details: {
          category: "decision",
          decisionText: "",
          notifiedOn: "",
          reasons: "시장 검증 근거 부족 수정",
        },
      },
    });
    expect(appealPreparationContext(company, saved)).toMatchObject({
      state: "stale",
      reviewCurrent: false,
    });
    const edited = next(value);
    expect((await patch(body(edited))).status).toBe(409);
    edited.noticeVersionId = company.agencyRecords.at(-1)!.id;
    expect((await patch(body(edited))).status).toBe(200);
    expect(read().appealPreparations[0]).toEqual(saved);
  });
  it("does not interpret a receipt notice as a decision", async () => {
    addNotice("receipt");
    const response = await patch(body());
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("APPEAL_NOTICE_STALE");
  });
  it("validates exact reasons before saving, without inventing a reason", async () => {
    const value = input();
    value.reasons[0].noticeQuote = "통보에 없는 사유";
    expect((await patch(body(value))).status).toBe(422);
    expect(read().appealPreparations).toEqual([]);
  });
  it("checks company membership for notice, preparation root, source, and plan", async () => {
    const value = input();
    value.noticeRecordId = randomUUID();
    expect((await patch(body(value))).status).toBe(404);
    const other = store().create({ ...emptyProfile(), companyName: "별도 합성회사" });
    expect(
      (await patch(body(input(), randomUUID(), other.revision), "", {}, other.id)).status,
    ).toBe(404);
    const invalidRoot = input();
    invalidRoot.preparationId = randomUUID();
    invalidRoot.previousVersionId = randomUUID();
    expect((await patch(body(invalidRoot))).status).toBe(404);
    const invalidPlan = input();
    invalidPlan.reasons[0].planClaim = { planId: randomUUID(), sectionKey: "market", quote: "x" };
    expect((await patch(body(invalidPlan))).status).toBe(404);
    const invalidSource = input();
    invalidSource.reasons[0].evidence = [
      { sourceId: randomUUID(), sourceUpdatedAt: "now", quote: "x", locator: "" },
    ];
    const reader = vi.spyOn(store(), "originalForVentureInput");
    expect((await patch(body(invalidSource))).status).toBe(404);
    expect(reader).not.toHaveBeenCalled();
  });
  it("captures pending originals only, exact SHA, and preserves pending analysis status", async () => {
    const { source, bytes } = addSource(true, true);
    const value = input();
    value.reasons[0].evidence = [ref(source, "")];
    const record = await save(value);
    expect(record.sourceSnapshots[0].original?.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(record.sourceSnapshots[0].extraction).toBe("pending");
    expect(company.sources[0].text).toBe("");
    expect(JSON.stringify(record)).not.toContain(directory);
    expect(appealPreparationContext(company, record).originalCheck).toBe("saved-only");
  });
  it("rejects a quote from pending or changed registered text", async () => {
    const { source } = addSource(true, true);
    const value = input();
    value.reasons[0].evidence = [ref(source)];
    expect((await patch(body(value))).status).toBe(409);
    const manual = addSource().source;
    value.reasons[0].evidence = [ref(manual, "없는 문장")];
    expect((await patch(body(value))).status).toBe(409);
    value.reasons[0].evidence = [{ ...ref(manual), sourceUpdatedAt: "old" }];
    expect((await patch(body(value))).status).toBe(409);
    value.reasons[0].evidence = [ref(manual, "")];
    expect((await patch(body(value))).status).toBe(409);
  });
  it("preserves linked source and marks user review stale when its registered text changes", async () => {
    const { source } = addSource();
    const value = input();
    value.reasons[0].evidence = [ref(source)];
    value.review = { reviewed: true, reviewer: "검토자", note: "" };
    const record = await save(value);
    expect(
      (await patch({ action: "delete-source", revision: company.revision, sourceId: source.id }))
        .status,
    ).toBe(409);
    mutate({
      action: "source",
      revision: company.revision,
      source: { ...source, text: source.text + " 추가 설명" },
    });
    expect(appealPreparationContext(company, record)).toMatchObject({
      state: "stale",
      reviewCurrent: false,
    });
    expect(company.appealPreparations[0]).toEqual(record);
  });
  it("rejects same-sized changed originals and preserves earlier hashes", async () => {
    const { source, bytes, path } = addSource(true);
    const value = input();
    value.reasons[0].evidence = [ref(source)];
    const first = await save(value);
    const changed = Buffer.from(bytes);
    changed[12] ^= 1;
    writeFileSync(path, changed);
    const response = await patch(body(next(value)));
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("APPEAL_ORIGINAL_CHANGED");
    expect(read().appealPreparations).toEqual([first]);
  });
  it("rechecks all file hashes immediately before commit and rolls back a changed original", async () => {
    const { source, bytes, path } = addSource(true);
    const value = input();
    value.reasons[0].evidence = [ref(source)];
    const actual = store().originalForVentureInput.bind(store());
    let calls = 0;
    vi.spyOn(store(), "originalForVentureInput").mockImplementation((caseId, sourceId) => {
      const result = actual(caseId, sourceId);
      if (++calls === 1) {
        const changed = Buffer.from(bytes);
        changed[12] ^= 1;
        writeFileSync(path, changed);
      }
      return result;
    });
    const before = structuredClone(company);
    expect((await patch(body(value))).status).toBe(409);
    expect(read()).toEqual(before);
  });
  it("pins an older plan version and exact unique section quote without calling it submitted", async () => {
    const plan = {
      id: randomUUID(),
      version: 1,
      candidateId: "candidate",
      generatedAt: new Date().toISOString(),
      mode: "manual" as const,
      sourceRevision: 0,
      content: {
        title: "과거 초안",
        summary: "",
        sections: [
          {
            key: "market",
            title: "시장",
            content: "기존 설명 원문",
            evidence: [],
            needsConfirmation: true,
          },
        ],
        actionItems: [],
        interviewQuestions: [],
      },
      review: [],
      confirmedAt: null,
    };
    company.plans.push(plan);
    saveFixture(company);
    const value = input();
    value.reasons[0].planClaim = { planId: plan.id, sectionKey: "market", quote: "기존 설명" };
    const record = await save(value);
    expect(record.planSnapshots[0]).toMatchObject({ planId: plan.id, version: 1 });
    company.plans.push({ ...plan, id: randomUUID(), version: 2 });
    saveFixture(company);
    expect(appealPreparationContext(company, record).state).toBe("current");
    company.plans[0].content.sections.push({ ...plan.content.sections[0] });
    saveFixture(company);
    expect((await patch(body(next(value)))).status).toBe(422);
  });
  it("loads legacy records with an empty history and rejects forged server metadata", async () => {
    const legacy = { ...company } as Partial<StudioCase>;
    delete legacy.appealPreparations;
    saveFixture(legacy as StudioCase);
    expect(company.appealPreparations).toEqual([]);
    const payload = body();
    expect((await patch({ ...payload, origin: "official" })).status).toBe(400);
    expect(
      (
        await patch({
          ...payload,
          preparation: { ...payload.preparation, recordedAt: new Date().toISOString() },
        })
      ).status,
    ).toBe(400);
  });
  it.each(["?revision=0", "?x=1"])("rejects query parameters %s", async (suffix) => {
    expect((await patch(body(), suffix)).status).toBe(400);
    expect(read().appealPreparations).toEqual([]);
  });
  it("rejects cross-origin writes and company input locks before capture", async () => {
    expect((await patch(body(), "", { origin: "https://other.invalid" })).status).toBe(403);
    const reader = vi.spyOn(store(), "originalForVentureInput");
    await withVentureInputCompanyLock(company.id, async () => {
      expect((await patch(body())).status).toBe(409);
      expect(reader).not.toHaveBeenCalled();
    });
  });
  it("refuses history limits without deleting old versions", async () => {
    const value = input();
    const first = await save(value);
    company.appealPreparations = Array.from({ length: 50 }, (_, index) => ({
      ...first,
      id: index === 0 ? first.id : randomUUID(),
      version: index + 1,
      clientRequestId: randomUUID(),
      previousVersionId: index ? first.id : null,
    }));
    saveFixture(company);
    const before = structuredClone(company);
    const response = await patch(body(next(value)));
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("APPEAL_LIMIT");
    expect(read()).toEqual(before);
  });
  it.each(["original", "plan"])(
    "preserves the immutable %s already recorded in application submission history",
    async (target) => {
      const original = addSource(true);
      const plan = {
        id: randomUUID(),
        version: 1,
        candidateId: "candidate",
        generatedAt: new Date().toISOString(),
        mode: "manual" as const,
        sourceRevision: 0,
        content: {
          title: "제출했다고 기록한 합성 초안",
          summary: "원래 설명",
          sections: [
            {
              key: "market",
              title: "시장",
              content: "기존 주장 원문",
              evidence: [],
              needsConfirmation: true,
            },
          ],
          actionItems: [],
          interviewQuestions: [],
        },
        review: [],
        confirmedAt: null,
      };
      company.plans.push(plan);
      saveFixture(company);
      mutate({
        action: "create-application",
        revision: company.revision,
        clientRequestId: randomUUID(),
        title: "합성 신청 건",
        kind: "new",
        plannedOn: "",
        criteriaNote: "",
        previousApplicationId: null,
      });
      mutate({
        action: "record-application-submission",
        revision: company.revision,
        clientRequestId: randomUUID(),
        applicationId: company.applications[0].id,
        planId: plan.id,
        sourceIds: [original.source.id],
        taskIds: [],
        receiptRecordId: null,
        occurredOn: "2026-09-25",
        recordedBy: "합성 담당자",
        note: "실제 제출 아님",
      });
      const frozen = structuredClone(company.applicationEvents);
      const value = input();
      if (target === "original") {
        value.reasons[0].evidence = [ref(original.source)];
        const changed = Buffer.from(original.bytes);
        changed[12] ^= 1;
        writeFileSync(original.path, changed);
      } else {
        value.reasons[0].planClaim = { planId: plan.id, sectionKey: "market", quote: "기존 주장" };
        company.plans[0].content.summary = "같은 ID에 잘못 덮인 설명";
        saveFixture(company);
      }
      const before = structuredClone(company);
      const response = await patch(body(value));
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe(
        target === "original" ? "APPEAL_ORIGINAL_CHANGED" : "APPEAL_PLAN_CHANGED",
      );
      expect(read()).toEqual(before);
      expect(company.applicationEvents).toEqual(frozen);
    },
  );
}, 20_000);
