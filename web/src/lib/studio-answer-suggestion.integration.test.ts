import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import { emptyProfile, type StudioCase } from "./studio-schema";
import { answerSuggestionSha as sha } from "./studio-answer-suggestion";
import { withVentureInputCompanyLock } from "./venturein-input-lock";
import type {
  AnswerSuggestionAiPreview,
  AnswerSuggestionCommand,
  AnswerSuggestionInput,
} from "./studio-answer-suggestion-types";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  store: null as StudioStore | null,
  sdk: vi.fn(),
  options: vi.fn(),
}));
vi.mock("./studio-storage", async (original) => ({
  ...(await original<typeof import("./studio-storage")>()),
  getStudioStore: () => state.store!,
}));
vi.mock("openai", () => ({
  default: class {
    constructor(options: unknown) {
      state.options(options);
    }
    responses = { parse: state.sdk };
  },
}));
import { POST } from "@/app/api/studio/cases/[caseId]/answer-suggestions/route";

let directory: string, company: StudioCase, input: AnswerSuggestionInput;
const store = () => state.store!;
const processState = globalThis as typeof globalThis & {
  __venturepassAnswerSuggestionApprovals?: Map<
    string,
    { approval: AnswerSuggestionAiPreview["approval"]; used: boolean }
  >;
  __venturepassAnswerSuggestionJobs?: Set<string>;
};
function dbRead() {
  const db = new DatabaseSync(join(directory, "studio.sqlite"));
  try {
    return ["studio_cases", "venture_accounts", "venture_workflows"].map((name) =>
      db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all(),
    );
  } finally {
    db.close();
  }
}
function replace(change: (record: StudioCase) => void) {
  const record = store().get(company.id);
  change(record);
  const db = new DatabaseSync(join(directory, "studio.sqlite"));
  try {
    db.prepare("UPDATE studio_cases SET body=?, revision=? WHERE id=?").run(
      JSON.stringify(record),
      record.revision,
      record.id,
    );
  } finally {
    db.close();
  }
}
function request(body: unknown, suffix = "", headers: Record<string, string> = {}) {
  return new Request(
    `http://localhost:3000/api/studio/cases/${company.id}/answer-suggestions${suffix}`,
    {
      method: "POST",
      headers: { origin: "http://localhost:3000", "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
}
const context = () => ({ params: Promise.resolve({ caseId: company.id }) });
const post = (command: unknown) => POST(request(command), context());
const select = () => ({
  sourceId: company.sources[0].id,
  start: 0,
  end: company.sources[0].text.length,
  quote: company.sources[0].text,
});
async function preview() {
  const response = await post({ action: "prepare-ai", input });
  expect(response.status).toBe(200);
  return (await response.json()) as AnswerSuggestionAiPreview;
}
async function command(): Promise<Extract<AnswerSuggestionCommand, { action: "run-ai" }>> {
  return { action: "run-ai", input, approval: (await preview()).approval, approved: true };
}
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "venture-answer-suggestion-test-"));
  state.store = new StudioStore(directory);
});
beforeEach(() => {
  vi.clearAllMocks();
  state.options.mockReset();
  state.sdk.mockReset();
  vi.stubEnv("OPENAI_API_KEY", "synthetic-mock-only");
  vi.stubEnv("OPENAI_MODEL", "synthetic-answer-model");
  processState.__venturepassAnswerSuggestionApprovals?.clear();
  processState.__venturepassAnswerSuggestionJobs?.clear();
  company = store().create({
    ...emptyProfile(),
    companyName: "합성 답변 제안",
    financials: "PRIVATE_PROFILE_ONLY",
  });
  replace((record) => {
    record.sources.push({
      id: randomUUID(),
      name: "합성 등록 녹취",
      kind: "consultation",
      text: "검증 상태는 개발 중입니다.",
      extraction: "manual",
      originalName: null,
      mimeType: null,
      warnings: [],
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
    record.sources.push({
      ...record.sources[0],
      id: randomUUID(),
      name: "비선택 자료",
      text: "PRIVATE_UNSELECTED_SOURCE",
    });
    record.plans.push({
      id: randomUUID(),
      version: 1,
      mode: "manual",
      candidateId: "fixture",
      sourceRevision: 0,
      generatedAt: record.createdAt,
      content: {
        title: "합성 원고",
        summary: "PRIVATE_PLAN_SUMMARY",
        sections: [
          {
            key: "technology",
            title: "기술",
            content: "선택하지 않은 원고",
            evidence: [],
            needsConfirmation: true,
          },
        ],
        actionItems: [],
        interviewQuestions: ["검증 상태는 무엇인가요?"],
      },
      review: [],
      confirmedAt: null,
    });
  });
  company = store().get(company.id);
  const question = company.plans[0].content.interviewQuestions[0];
  input = {
    revision: company.revision,
    target: {
      kind: "visit-question",
      planId: company.plans[0].id,
      planVersion: 1,
      questionIndex: 0,
      questionText: question,
      questionSha256: sha(question),
    },
    sourceSelections: [
      {
        sourceId: company.sources[0].id,
        sourceUpdatedAt: company.sources[0].updatedAt,
        textSha256: sha(company.sources[0].text),
      },
    ],
  };
  state.sdk.mockResolvedValue({ status: "completed", output_parsed: { selections: [select()] } });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(() => {
  state.store?.close();
  const delta = relative(resolve(tmpdir()), resolve(directory));
  if (
    isAbsolute(delta) ||
    delta.startsWith("..") ||
    !delta.startsWith("venture-answer-suggestion-test-")
  )
    throw new Error("Unsafe synthetic cleanup");
  rmSync(directory, { recursive: true, force: true });
});

describe("답변 제안 실제 SQLite/API · OpenAI SDK 모의만", () => {
  it("local works without a key, never reads originals or changes any DB table", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const original = vi.spyOn(store(), "originalForVentureInput").mockImplementation(() => {
      throw new Error("Unexpected original read");
    });
    const before = dbRead(),
      response = await post({ action: "local", input });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({
      mode: "assisted",
      originalCheck: "not-read",
      databaseChanged: false,
    });
    expect(dbRead()).toEqual(before);
    expect(state.options).not.toHaveBeenCalled();
    expect(original).not.toHaveBeenCalled();
  });
  it("preview exposes the full exact transmission for approval but sends and saves nothing", async () => {
    const before = dbRead(),
      value = await preview();
    expect(value.approval).toMatchObject({
      provider: "openai",
      destination: "https://api.openai.com/v1/responses",
      model: "synthetic-answer-model",
    });
    expect(value.transmission.sources).toEqual([
      {
        sourceId: company.sources[0].id,
        sourceName: company.sources[0].name,
        text: company.sources[0].text,
      },
    ]);
    const serialized = JSON.stringify(value.transmission);
    for (const forbidden of [
      "PRIVATE_PROFILE_ONLY",
      "PRIVATE_UNSELECTED_SOURCE",
      "PRIVATE_PLAN_SUMMARY",
    ])
      expect(serialized).not.toContain(forbidden);
    expect(dbRead()).toEqual(before);
    expect(state.options).not.toHaveBeenCalled();
    expect(value.externalTransmissionPerformed).toBe(false);
  });
  it("one explicit token permits exactly one fixed-destination/store:false/no-retry request", async () => {
    const action = await command(),
      before = dbRead();
    const response = await post(action);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      mode: "ai",
      reviewStatus: "unreviewed",
      databaseChanged: false,
    });
    expect(state.options).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://api.openai.com/v1",
        maxRetries: 0,
        timeout: 90_000,
      }),
    );
    const payload = state.sdk.mock.calls[0][0];
    expect(payload).toMatchObject({ model: "synthetic-answer-model", store: false });
    expect(JSON.parse(payload.input[0].content).sources).toHaveLength(1);
    expect(payload.instructions).toContain("untrusted evidence");
    expect((await post(action)).status).toBe(409);
    expect(state.sdk).toHaveBeenCalledTimes(1);
    expect(dbRead()).toEqual(before);
  });
  it.each(["문", "\u0001"])(
    "maximum question and six source names fit an approved request (%s)",
    async (unit) => {
      replace((record) => {
        record.plans[0].content.interviewQuestions[0] = unit.repeat(3000);
        record.sources = Array.from({ length: 6 }, () => ({
          ...record.sources[0],
          id: randomUUID(),
          name: unit.repeat(200),
        }));
      });
      company = store().get(company.id);
      if (input.target.kind !== "visit-question") throw new Error("Invalid fixture");
      input.target.questionText = company.plans[0].content.interviewQuestions[0];
      input.target.questionSha256 = sha(input.target.questionText);
      input.sourceSelections = company.sources.map((source) => ({
        sourceId: source.id,
        sourceUpdatedAt: source.updatedAt,
        textSha256: sha(source.text),
      }));
      const action = await command();
      expect(Buffer.byteLength(JSON.stringify(action))).toBeLessThanOrEqual(64 * 1024);
      state.sdk.mockResolvedValue({ status: "completed", output_parsed: { selections: [] } });
      expect((await post(action)).status).toBe(200);
    },
  );
  it("an absent key and constructor failure never consume approval or send content", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    expect((await post({ action: "prepare-ai", input })).status).toBe(503);
    vi.stubEnv("OPENAI_API_KEY", "synthetic-mock-only");
    const action = await command();
    state.options.mockImplementation(() => {
      throw new Error("SECRET_CONFIGURATION");
    });
    const response = await post(action),
      body = await response.json();
    expect(response.status).toBe(502);
    expect(body.code).toBe("ANSWER_SUGGESTION_AI_NOT_STARTED");
    expect(JSON.stringify(body)).not.toContain("SECRET_CONFIGURATION");
    expect(
      processState.__venturepassAnswerSuggestionApprovals?.get(action.approval.token)?.used,
    ).toBe(false);
    expect(state.sdk).not.toHaveBeenCalled();
  });
  it.each([
    "expired",
    "restart",
    "model",
    "revision",
    "source",
    "question",
    "name",
    "wrong-token",
    "unapproved",
    "destination",
  ])("rejects %s before SDK transmission", async (kind) => {
    const action = await command();
    if (kind === "expired")
      vi.spyOn(Date, "now").mockReturnValue(Date.parse(action.approval.expiresAt) + 1);
    if (kind === "restart") processState.__venturepassAnswerSuggestionApprovals?.clear();
    if (kind === "model") vi.stubEnv("OPENAI_MODEL", "different-model");
    if (kind === "revision")
      replace((record) => {
        record.revision++;
      });
    if (kind === "source")
      replace((record) => {
        record.sources[0].text = "변경된 본문";
      });
    if (kind === "name")
      replace((record) => {
        record.sources[0].name = "바뀐 이름";
      });
    if (kind === "question")
      replace((record) => {
        record.plans[0].content.interviewQuestions[0] = "다른 질문";
      });
    if (kind === "wrong-token") action.approval.token = randomUUID();
    const body =
      kind === "unapproved"
        ? { ...action, approved: false }
        : kind === "destination"
          ? { ...action, approval: { ...action.approval, destination: "https://invalid.example" } }
          : action;
    expect((await post(body)).status).toBeGreaterThanOrEqual(400);
    expect(state.sdk).not.toHaveBeenCalled();
  });
  it("rechecks source context inside beforeRequest after SDK setup", async () => {
    const action = await command();
    state.options.mockImplementation(() =>
      replace((record) => {
        record.sources[0].text = "constructor race";
      }),
    );
    expect((await post(action)).status).toBe(409);
    expect(state.sdk).not.toHaveBeenCalled();
    expect(
      processState.__venturepassAnswerSuggestionApprovals?.get(action.approval.token)?.used,
    ).toBe(false);
  });
  it("discards a received answer after a concurrent company change, and consumes its token", async () => {
    const action = await command();
    state.sdk.mockImplementation(async () => {
      replace((record) => {
        record.revision++;
      });
      return { status: "completed", output_parsed: { selections: [select()] } };
    });
    expect((await post(action)).status).toBe(409);
    expect(state.sdk).toHaveBeenCalledTimes(1);
    expect(
      processState.__venturepassAnswerSuggestionApprovals?.get(action.approval.token)?.used,
    ).toBe(true);
  });
  it.each(["throw", "incomplete", "authored-fact"])(
    "unknown %s has a fixed cost warning, no secret leakage or automatic retry",
    async (kind) => {
      const action = await command(),
        before = dbRead();
      if (kind === "throw") state.sdk.mockRejectedValue(new Error("SECRET_RAW_PROVIDER_INPUT"));
      if (kind === "incomplete")
        state.sdk.mockResolvedValue({ status: "incomplete", output_parsed: null });
      if (kind === "authored-fact")
        state.sdk.mockResolvedValue({
          status: "completed",
          output_parsed: { selections: [], answer: "성공은 검증됨" },
        });
      const response = await post(action),
        body = await response.json();
      expect(response.status).toBe(502);
      expect(body.code).toBe("ANSWER_SUGGESTION_AI_UNKNOWN");
      expect(body.error).toContain("비용");
      expect(JSON.stringify(body)).not.toContain("SECRET_RAW_PROVIDER_INPUT");
      expect((await post(action)).status).toBe(409);
      expect(state.sdk).toHaveBeenCalledTimes(1);
      expect(dbRead()).toEqual(before);
    },
  );
  it("rejects a structurally valid but invented quote after one request", async () => {
    const action = await command();
    state.sdk.mockResolvedValue({
      status: "completed",
      output_parsed: { selections: [{ ...select(), quote: "거짓 인용" }] },
    });
    const response = await post(action);
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe("ANSWER_SUGGESTION_OUTPUT_INVALID");
    expect((await post(action)).status).toBe(409);
    expect(state.sdk).toHaveBeenCalledTimes(1);
  });
  it("rejects the company input lock before local or external work", async () => {
    const action = await command();
    await withVentureInputCompanyLock(company.id, async () => {
      expect((await post({ action: "local", input })).status).toBe(409);
      expect((await post(action)).status).toBe(409);
    });
    expect(state.sdk).not.toHaveBeenCalled();
  });
  it("serializes jobs for one company, clears the lock after failure, and never retries a token", async () => {
    const action = await command();
    let release!: () => void;
    state.sdk.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ status: "completed", output_parsed: { selections: [] } });
        }),
    );
    const pending = post(action);
    await vi.waitFor(() => expect(state.sdk).toHaveBeenCalledTimes(1));
    expect((await post({ action: "local", input })).status).toBe(409);
    release();
    expect((await pending).status).toBe(200);
    expect((await post({ action: "local", input })).status).toBe(200);
  });
  it("caps in-memory previews and removes expired approvals without touching the DB", async () => {
    const before = dbRead();
    for (let index = 0; index < 20; index++) await preview();
    expect((await post({ action: "prepare-ai", input })).status).toBe(429);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_001);
    expect((await post({ action: "prepare-ai", input })).status).toBe(200);
    expect(dbRead()).toEqual(before);
  });
  it.each([
    "query",
    "origin",
    "json-type",
    "extra",
    "body-limit",
    "foreign-source",
    "foreign-target",
  ])("strict API rejects %s without provider calls or DB writes", async (kind) => {
    const before = dbRead(),
      current = structuredClone(input);
    if (kind === "foreign-source") current.sourceSelections[0].sourceId = randomUUID();
    if (kind === "foreign-target" && current.target.kind === "visit-question")
      current.target.planId = randomUUID();
    const body =
      kind === "body-limit"
        ? JSON.stringify({ text: "x".repeat(65_537) })
        : { action: "local", input: current, ...(kind === "extra" ? { extra: true } : {}) };
    const response = await POST(
      request(
        body,
        kind === "query" ? "?unexpected=1" : "",
        kind === "origin"
          ? { origin: "https://foreign.example" }
          : kind === "json-type"
            ? { "content-type": "text/plain" }
            : {},
      ),
      context(),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(state.sdk).not.toHaveBeenCalled();
    expect(dbRead()).toEqual(before);
  });
});
