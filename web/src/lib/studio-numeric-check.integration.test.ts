import { randomUUID } from "node:crypto";
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
import {
  numericCheckContext,
  type NumericCheckInput,
  type NumericObservation,
} from "./studio-numeric-check-types";
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

describe("수치 대조 API / 실제 임시 SQLite", () => {
  let directory: string, company: StudioCase;
  const store = () => state.store!;
  const read = () => (company = store().get(company.id));
  const mutate = (value: Parameters<StudioStore["mutate"]>[1]) =>
    (company = store().mutate(company.id, value, () => []));
  const fixtureSave = (value: unknown = company) => {
    const db = new DatabaseSync(join(directory, "studio.sqlite"));
    db.prepare("UPDATE studio_cases SET body=? WHERE id=?").run(JSON.stringify(value), company.id);
    db.close();
    read();
  };
  const input = (): NumericCheckInput => {
    const observations: NumericObservation[] = ["10", "20", "30"].map((valueText) => ({
      id: randomUUID(),
      label: `가상 값 ${valueText}`,
      valueText,
      unit: "item",
      customUnit: "",
      period: { kind: "range", start: "2025-01-01", end: "2025-12-31" },
      basis: "reported",
      reference: {
        kind: "plan",
        planId: company.plans[0].id,
        sectionKey: "technology",
        quote: `${valueText}개`,
      },
      note: "전사 확인 필요",
    }));
    return {
      checkId: null,
      previousVersionId: null,
      title: "합성 수치 점검",
      observations,
      comparisons: [{ id: randomUUID(), leftId: observations[0].id, rightId: observations[1].id }],
      formulas: [
        {
          id: randomUUID(),
          operation: "sum",
          operandIds: observations.slice(0, 2).map((value) => value.id),
          expectedId: observations[2].id,
        },
      ],
      judgement: { state: "unreviewed", reviewer: "", note: "" },
    };
  };
  const body = (check = input(), clientRequestId = randomUUID(), revision = company.revision) => ({
    action: "append-numeric-check",
    revision,
    clientRequestId,
    check,
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
        body: JSON.stringify(payload),
      }),
      { params: Promise.resolve({ caseId }) },
    );
  const save = async (value = input()) => {
    const result = await patch(body(value));
    expect(result.status).toBe(200);
    company = await result.json();
    return company.numericChecks.at(-1)!;
  };
  const next = (value: NumericCheckInput): NumericCheckInput => ({
    ...structuredClone(value),
    checkId: company.numericChecks.at(-1)!.checkId,
    previousVersionId: company.numericChecks.at(-1)!.id,
  });
  const addSource = (original = false, pending = false) => {
    const now = new Date().toISOString();
    const source: SourceDocument = {
      id: randomUUID(),
      name: "합성 수량표",
      kind: "finance",
      text: pending ? "" : "수량 10개입니다.",
      originalName: original ? "fixture.pdf" : null,
      mimeType: original ? "application/pdf" : null,
      extraction: pending ? "pending" : "manual",
      warnings: pending ? [...originalOnlyWarnings] : [],
      createdAt: now,
      updatedAt: now,
    };
    const bytes = Buffer.from("%PDF-1.7\nsynthetic fixture original\n%%EOF");
    if (original) company = store().addUpload(company.id, company.revision, source, bytes);
    else mutate({ action: "source", revision: company.revision, source });
    return {
      source: company.sources.find((entry) => entry.id === source.id)!,
      bytes,
      path: join(directory, "originals", company.id, `${source.id}.bin`),
    };
  };
  const bind = (value: NumericCheckInput, source: SourceDocument, quote = "10개") => {
    value.observations[0].reference = {
      kind: "source",
      sourceId: source.id,
      sourceUpdatedAt: source.updatedAt,
      quote,
      locator: "1쪽",
    };
    return value;
  };
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "venture-numeric-test-"));
    state.store = new StudioStore(directory);
    company = store().create({ ...emptyProfile(), companyName: "합성 수치 회사" });
    company.plans.push({
      id: randomUUID(),
      version: 1,
      generatedAt: new Date().toISOString(),
      mode: "manual",
      candidateId: "fixture",
      sourceRevision: 0,
      content: {
        title: "합성 계획",
        summary: "대조용",
        sections: [
          {
            key: "technology",
            title: "수량",
            content: "수량 10개, 20개, 합계 30개입니다.",
            evidence: [],
            needsConfirmation: true,
          },
        ],
        actionItems: [],
        interviewQuestions: [],
      },
      review: [],
      confirmedAt: null,
    });
    fixtureSave();
    state.ai.mockClear();
    state.runner.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    store().close();
    const boundary = relative(resolve(tmpdir()), resolve(directory));
    if (!boundary.startsWith("venture-numeric-test-") || boundary.includes(".."))
      throw new Error("Unsafe cleanup");
    rmSync(directory, { recursive: true, force: true });
    expect(state.ai).not.toHaveBeenCalled();
    expect(state.runner).not.toHaveBeenCalled();
  });
  it("stores numeric-only results without altering workflow or factual review", async () => {
    const before = structuredClone(company);
    const record = await save();
    expect(record).toMatchObject({
      checkId: record.id,
      version: 1,
      judgement: { state: "unreviewed", recordedAt: null },
      evaluation: {
        factVerification: "not-performed",
        formulas: [{ state: "arithmetic-equal", result: { decimal: "30" } }],
        comparisons: [{ state: "numeric-difference" }],
      },
    });
    for (const key of [
      "sources",
      "analysis",
      "plans",
      "stage",
      "stageHistory",
      "tasks",
      "agencyRecords",
      "visitAnswers",
      "responsePreparations",
      "planReviewDecisions",
    ] as const)
      expect(company[key]).toEqual(before[key]);
    const db = new DatabaseSync(join(directory, "studio.sqlite"));
    expect(
      db.prepare("SELECT evidence_revision FROM studio_cases WHERE id=?").get(company.id),
    ).toEqual({ evidence_revision: 0 });
    db.close();
  });
  it("keeps explicit unknown inputs and incompatible contexts not comparable", async () => {
    const value = input();
    value.observations[0] = {
      ...value.observations[0],
      valueText: "",
      unit: "unknown",
      period: { kind: "unknown", start: "", end: "" },
      basis: "unknown",
      reference: null,
    };
    const record = await save(value);
    expect(record.evaluation.formulas[0].state).toBe("not-comparable");
    expect(record.evaluation.comparisons[0].state).toBe("not-comparable");
    expect(record.evaluation.unresolved[0].reasons).toHaveLength(5);
  });
  it("appends latest-only human judgement without resolving differences automatically", async () => {
    const value = input();
    const first = await save(value);
    const updated = next(value);
    updated.judgement = {
      state: "reviewed",
      reviewer: "담당자",
      note: "전사와 산술 검토이며 사실 확인은 별도",
    };
    const second = await save(updated);
    expect(second.judgement.recordedAt).not.toBeNull();
    expect(second.evaluation.comparisons[0].state).toBe("numeric-difference");
    expect(company.numericChecks[0]).toEqual(first);
    const before = structuredClone(company);
    expect((await patch(body(updated))).status).toBe(409);
    expect(read()).toEqual(before);
  });
  it("replays the same nonce before stale CAS across restart with no extra records", async () => {
    const request = body();
    expect((await patch(request)).status).toBe(200);
    const before = structuredClone(read());
    store().close();
    state.store = new StudioStore(directory);
    expect((await patch(request)).status).toBe(200);
    expect(read()).toEqual(before);
    request.check.title += "변경";
    expect((await patch(request)).status).toBe(409);
    expect(read()).toEqual(before);
  });
  it("rejects stale CAS and foreign roots with rollback", async () => {
    const value = input();
    const revision = company.revision;
    await save(value);
    const before = structuredClone(company);
    expect((await patch(body(next(value), randomUUID(), revision))).status).toBe(409);
    expect(
      await patch(body({ ...value, checkId: randomUUID(), previousVersionId: randomUUID() })),
    ).toMatchObject({ status: 404 });
    expect(read()).toEqual(before);
  });
  it.each([
    "first-judgement",
    "empty-reviewer",
    "unknown-key",
    "formula-code",
    "foreign-operand",
    "invalid-period",
    "invalid-literal",
  ])("rejects strict %s", async (kind) => {
    const value = input();
    const request: Record<string, unknown> = body(value);
    if (kind === "first-judgement")
      value.judgement = { state: "reviewed", reviewer: "담당자", note: "" };
    if (kind === "empty-reviewer") {
      value.checkId = randomUUID();
      value.previousVersionId = randomUUID();
      value.judgement.state = "needs-work";
    }
    if (kind === "unknown-key") request.factVerified = true;
    if (kind === "formula-code")
      (value.formulas[0] as unknown as { expression: string }).expression = "process.exit()";
    if (kind === "foreign-operand") value.formulas[0].operandIds[0] = randomUUID();
    if (kind === "invalid-period") value.observations[0].period.start = "2025-02-30";
    if (kind === "invalid-literal") value.observations[0].valueText = "1e3";
    const before = structuredClone(company);
    expect((await patch(request)).status).toBe(400);
    expect(read()).toEqual(before);
  });
  it("rejects query/origin/body-size and preserves DB", async () => {
    const request = body(),
      before = structuredClone(company);
    expect((await patch(request, "?auto=true")).status).toBe(400);
    expect((await patch(request, "", { origin: "https://foreign.invalid" })).status).toBe(403);
    expect(
      (await patch({ ...request, check: { ...request.check, title: "x".repeat(512 * 1024) } }))
        .status,
    ).toBe(413);
    expect(read()).toEqual(before);
  });
  it("respects company input locks and releases them afterward", async () => {
    const before = structuredClone(company);
    await withVentureInputCompanyLock(company.id, async () =>
      expect((await patch(body())).status).toBe(409),
    );
    expect(read()).toEqual(before);
    expect((await patch(body())).status).toBe(200);
  });
  it.each(["foreign-source", "foreign-plan", "stale-source", "pending", "cropped-token"])(
    "refuses unsafe reference %s before any file reads",
    async (kind) => {
      const item = addSource(true, kind === "pending");
      const value = bind(input(), item.source);
      const ref = value.observations[0].reference!;
      if (kind === "foreign-source" && ref.kind === "source") ref.sourceId = randomUUID();
      if (kind === "foreign-plan")
        value.observations[1].reference = {
          kind: "plan",
          planId: randomUUID(),
          sectionKey: "technology",
          quote: "20개",
        };
      if (kind === "stale-source" && ref.kind === "source") ref.sourceUpdatedAt = "old";
      if (kind === "cropped-token") {
        mutate({
          action: "source",
          revision: company.revision,
          source: { ...item.source, text: "수량 100개" },
        });
        bind(value, company.sources[0], "10");
      }
      const before = structuredClone(company),
        spy = vi.spyOn(store(), "originalForVentureInput");
      const result = await patch(body(value));
      expect([404, 409, 422]).toContain(result.status);
      expect(spy).not.toHaveBeenCalled();
      expect(read()).toEqual(before);
    },
  );
  it("captures source and original hashes, protects deletion, and preserves stale history", async () => {
    const item = addSource(true),
      value = bind(input(), item.source);
    const spy = vi.spyOn(store(), "originalForVentureInput");
    const saved = await save(value);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(saved.sourceSnapshots[0].original?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(
      (
        await patch({
          action: "delete-source",
          revision: company.revision,
          sourceId: item.source.id,
        })
      ).status,
    ).toBe(409);
    mutate({
      action: "source",
      revision: company.revision,
      source: { ...item.source, text: `${item.source.text} 추가 주석` },
    });
    expect(numericCheckContext(company, saved).state).toBe("stale");
    expect(company.numericChecks[0]).toEqual(saved);
  });
  it("rejects same-size file mutation between capture reads atomically", async () => {
    const item = addSource(true),
      value = bind(input(), item.source),
      before = structuredClone(company);
    const actual = store().originalForVentureInput.bind(store());
    let reads = 0;
    vi.spyOn(store(), "originalForVentureInput").mockImplementation((caseId, sourceId) => {
      const result = actual(caseId, sourceId);
      if (++reads === 1) {
        const changed = Buffer.from(item.bytes);
        changed[12] ^= 1;
        writeFileSync(item.path, changed);
      }
      return result;
    });
    expect((await patch(body(value))).status).toBe(409);
    expect(read()).toEqual(before);
  });
  it("rejects later agency references that would rewrite a frozen numeric original", async () => {
    const item = addSource(true),
      value = bind(input(), item.source);
    await save(value);
    const before = structuredClone(company),
      changed = Buffer.from(item.bytes);
    changed[12] ^= 1;
    writeFileSync(item.path, changed);
    const response = await patch({
      action: "append-agency-record",
      revision: company.revision,
      clientRequestId: randomUUID(),
      record: {
        kind: "request",
        institution: "가상 기관",
        title: "수량 확인",
        body: "원문",
        occurredOn: "",
        dueOn: "",
        dueNote: "",
        note: "",
        sourceIds: [item.source.id],
      },
    });
    expect(response.status).toBe(409);
    expect(read()).toEqual(before);
  });
  it("rejects prior agency original conflicts when recording a numeric check", async () => {
    const item = addSource(true);
    mutate({
      action: "append-agency-record",
      revision: company.revision,
      clientRequestId: randomUUID(),
      record: {
        kind: "request",
        institution: "가상 기관",
        title: "수량 확인",
        body: "원문",
        occurredOn: "",
        dueOn: "",
        dueNote: "",
        note: "",
        sourceIds: [item.source.id],
      },
    });
    const before = structuredClone(company),
      changed = Buffer.from(item.bytes);
    changed[12] ^= 1;
    writeFileSync(item.path, changed);
    expect((await patch(body(bind(input(), item.source)))).status).toBe(409);
    expect(read()).toEqual(before);
  });
  it("rejects fixed plan mutation in numeric and other historical paths", async () => {
    const value = input();
    const first = await save(value);
    company.plans[0].content.summary += "바뀜";
    fixtureSave();
    const before = structuredClone(company);
    expect((await patch(body(next(value)))).status).toBe(409);
    expect(read()).toEqual(before);
    expect(company.numericChecks[0]).toEqual(first);
  });
  it("defaults legacy records to [] and preserves saved checks on restart", async () => {
    const legacy = { ...company } as Partial<StudioCase>;
    delete legacy.numericChecks;
    fixtureSave(legacy);
    expect(company.numericChecks).toEqual([]);
    const first = await save();
    store().close();
    state.store = new StudioStore(directory);
    expect(read().numericChecks).toEqual([first]);
  });
  it("refuses 101st version without trimming saved history", async () => {
    const first = await save();
    company.numericChecks = Array.from({ length: 100 }, () => ({
      ...first,
      id: randomUUID(),
      checkId: randomUUID(),
      clientRequestId: randomUUID(),
      observations: [first.observations[0]],
      comparisons: [],
      formulas: [],
    }));
    fixtureSave();
    const before = structuredClone(company);
    expect((await patch(body())).status).toBe(409);
    expect(read()).toEqual(before);
  });
  it("refuses aggregate text overflow and rolls back all writes", async () => {
    const first = await save();
    const count = (value: unknown): number =>
      typeof value === "string"
        ? value.length
        : Array.isArray(value)
          ? value.reduce((sum, item) => sum + count(item), 0)
          : value && typeof value === "object"
            ? Object.values(value).reduce<number>((sum, item) => sum + count(item), 0)
            : 0;
    const template = { ...first, judgement: { ...first.judgement, note: "x".repeat(3000) } };
    company.numericChecks = [];
    while (count(company.numericChecks) + count(template) < 198000)
      company.numericChecks.push({
        ...template,
        id: randomUUID(),
        checkId: randomUUID(),
        clientRequestId: randomUUID(),
      });
    expect(count(company.numericChecks)).toBeLessThan(200000);
    fixtureSave();
    const before = structuredClone(company);
    const value = input();
    value.observations.forEach((item) => {
      item.note = "x".repeat(2000);
    });
    value.judgement.note = "x".repeat(3000);
    expect((await patch(body(value))).status).toBe(409);
    expect(read()).toEqual(before);
  });
  it.each([
    ["비율 1/2", "1"],
    ["비율 1/2", "2"],
    ["비율 1 / - 2", "1"],
    ["비율 1 / (2)", "1"],
    ["차감 △10원", "10"],
    ["차감 ▲ ₩10원", "10"],
  ])("refuses unsupported full-token context %s", async (text, valueText) => {
    const item = addSource();
    mutate({ action: "source", revision: company.revision, source: { ...item.source, text } });
    const value = bind(input(), company.sources[0], text);
    value.observations[0].valueText = valueText;
    const before = structuredClone(company);
    const response = await patch(body(value));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "NUMERIC_VALUE_UNBOUND" });
    expect(read()).toEqual(before);
  });
}, 20_000);
