import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import { emptyProfile, type StudioCase } from "./studio-schema";
import {
  candidateSelectionLimits,
  type CandidateSelectionInput,
} from "./studio-candidate-selection-types";
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
function sql<T>(action: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(directory, "studio.sqlite"));
  try {
    return action(db);
  } finally {
    db.close();
  }
}
function row() {
  return sql((db) =>
    db
      .prepare("SELECT body,revision,evidence_revision FROM studio_cases WHERE id=?")
      .get(company.id),
  );
}
function replaceFixture(change: (record: StudioCase) => void) {
  const record = structuredClone(company);
  change(record);
  sql((db) =>
    db.prepare("UPDATE studio_cases SET body=? WHERE id=?").run(JSON.stringify(record), record.id),
  );
  company = store().get(record.id);
}
function input(candidateId = "a"): CandidateSelectionInput {
  return {
    action: "select-candidate",
    revision: company.revision,
    clientRequestId: randomUUID(),
    candidateId,
    analysisGeneratedAt: company.analysis!.generatedAt,
    analysisSourceRevision: company.analysis!.sourceRevision,
    expectedSelectedCandidateId: company.selectedCandidateId,
    reason: "실제 개발 범위와 고객을 검토했습니다.",
  };
}
function patch(
  body: unknown,
  options: { caseId?: string; query?: string; headers?: Record<string, string> } = {},
) {
  const id = options.caseId ?? company.id;
  return PATCH(
    new Request(`http://localhost:3000/api/studio/cases/${id}${options.query ?? ""}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...options.headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ caseId: id }) },
  );
}
async function save(body = input()) {
  const response = await patch(body);
  expect(response.status).toBe(200);
  company = await response.json();
  return company.candidateSelections.at(-1)!;
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "venture-candidate-history-"));
  state.store = new StudioStore(directory);
  company = store().create({ ...emptyProfile(), companyName: "합성 회사" });
  company = store().saveAnalysis(
    company.id,
    company.revision,
    {
      summary: "합성 분석",
      facts: [],
      questions: [],
      warnings: [],
      candidates: ["a", "b"].map((id) => ({
        id,
        title: `후보 ${id}`,
        problem: "문제",
        solution: "해결",
        targetCustomer: "고객",
        differentiation: "미확인",
        stage: "개발 중",
        businessModel: "미확인",
        recommendation: "추천 설명",
        evidence: [],
        gaps: [],
      })),
    },
    "assisted",
  );
  state.external.mockClear();
});
afterEach(() => {
  expect(state.external).not.toHaveBeenCalled();
  state.store?.close();
  const target = resolve(directory);
  const inside = relative(resolve(tmpdir()), target);
  if (!inside.startsWith("..") && !inside.includes(":"))
    rmSync(target, { recursive: true, force: true });
});
describe("candidate selection API and SQLite", () => {
  it("records immutable choices and reason corrections without changing company evidence or stages", async () => {
    const initial = company;
    const first = await save();
    const firstSnapshot = structuredClone(first);
    const second = await save(input("b"));
    const third = await save({ ...input("b"), reason: "동일 후보의 선택 이유 보완" });
    expect([first.event, second.event, third.event]).toEqual([
      "selection",
      "selection",
      "reason-recorded",
    ]);
    expect(second.previousCandidate?.id).toBe("a");
    expect(second.previousRecordId).toBe(first.id);
    expect(company.candidateSelections[0]).toEqual(firstSnapshot);
    expect(company.selectedCandidateId).toBe("b");
    expect(company.analysis).toEqual(initial.analysis);
    expect(company.stage).toBe(initial.stage);
    expect(company.stageHistory).toEqual(initial.stageHistory);
    expect(row()!.evidence_revision).toBe(initial.revision);
    store().close();
    state.store = new StudioStore(directory);
    expect(store().get(company.id).candidateSelections).toEqual(company.candidateSelections);
  });
  it("keeps legacy selection readable and records its reason only after explicit action", async () => {
    replaceFixture((record) => {
      record.selectedCandidateId = "a";
      delete (record as Partial<StudioCase>).candidateSelections;
    });
    expect(company.candidateSelections).toEqual([]);
    const saved = await save();
    expect(saved.event).toBe("reason-recorded");
    expect(saved.previousCandidate?.id).toBe("a");
  });
  it("replays identical nonce before stale CAS with zero writes but rejects changed payload", async () => {
    const request = input();
    await save(request);
    const saved = row();
    expect((await patch({ ...request, revision: 0 })).status).toBe(200);
    expect(row()).toEqual(saved);
    const response = await patch({ ...request, reason: "변경된 이유" });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("CANDIDATE_SELECTION_CONFLICT");
    expect(row()).toEqual(saved);
  });
  it("does not restore old choices by replay after another selection", async () => {
    const old = input();
    await save(old);
    await save(input("b"));
    const saved = row();
    expect((await patch(old)).status).toBe(409);
    expect(row()).toEqual(saved);
  });
  it.each([
    "revision",
    "analysisGeneratedAt",
    "analysisSourceRevision",
    "expectedSelectedCandidateId",
    "candidateId",
  ] as const)("rejects stale/foreign %s without writes", async (key) => {
    const request = input();
    if (key === "revision") request.revision--;
    else if (key === "analysisSourceRevision") request.analysisSourceRevision++;
    else request[key] = "different";
    const saved = row();
    expect((await patch(request)).status).toBeGreaterThanOrEqual(400);
    expect(row()).toEqual(saved);
  });
  it("rejects duplicate candidate identifiers", async () => {
    replaceFixture((record) =>
      record.analysis!.candidates.push(structuredClone(record.analysis!.candidates[0])),
    );
    const saved = row();
    expect((await patch(input())).status).toBe(400);
    expect(row()).toEqual(saved);
  });
  it("rejects cross-company requests rather than copying a candidate snapshot", async () => {
    const other = store().create({ ...emptyProfile(), companyName: "다른 합성 회사" });
    const saved = store().get(other.id);
    expect(
      (await patch({ ...input(), revision: other.revision }, { caseId: other.id })).status,
    ).toBe(409);
    expect(store().get(other.id)).toEqual(saved);
  });
  it("preserves choices through new analysis but refuses old nonce acknowledgement", async () => {
    const old = input();
    await save(old);
    const history = structuredClone(company.candidateSelections);
    company = store().saveAnalysis(
      company.id,
      company.revision,
      { ...company.analysis!, summary: "새 분석" },
      "assisted",
    );
    expect(company.selectedCandidateId).toBeNull();
    expect(company.candidateSelections).toEqual(history);
    expect((await patch(old)).status).toBe(409);
  });
  it("detects same-id analysis content changes even when public timestamps remain unchanged", async () => {
    const old = input();
    await save(old);
    replaceFixture((record) => {
      record.analysis!.summary = "바뀐 전체 분석";
    });
    expect((await patch(old)).status).toBe(409);
  });
  it("releases no history or selection after SQL failure", async () => {
    const saved = row();
    sql((db) =>
      db.exec(
        "CREATE TRIGGER reject_candidate_update BEFORE UPDATE ON studio_cases BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
      ),
    );
    expect((await patch(input())).status).toBe(500);
    expect(row()).toEqual(saved);
    sql((db) => db.exec("DROP TRIGGER reject_candidate_update"));
    await save();
  });
  it("respects the official input company lock", async () => {
    const saved = row();
    await withVentureInputCompanyLock(company.id, async () => {
      expect((await patch(input())).status).toBe(409);
    });
    expect(row()).toEqual(saved);
  });
  it.each(["record-count", "characters"])("rolls back history %s overflow", async (kind) => {
    await save();
    const basis = structuredClone(company.candidateSelections[0]);
    replaceFixture((record) => {
      record.candidateSelections = Array.from(
        { length: kind === "record-count" ? candidateSelectionLimits.records : 10 },
        (_, index) => ({
          ...basis,
          id: randomUUID(),
          clientRequestId: randomUUID(),
          reason: String(index),
          candidate:
            kind === "characters"
              ? { ...basis.candidate, gaps: Array.from({ length: 10 }, () => "x".repeat(1900)) }
              : basis.candidate,
        }),
      );
    });
    const saved = row();
    expect((await patch(input("b"))).status).toBe(409);
    expect(row()).toEqual(saved);
  });
  it("preserves all plan bytes but invalidates all confirmations only for a changed choice", async () => {
    await save();
    const content = {
      title: "합성 원고",
      summary: "요약",
      sections: [],
      actionItems: [],
      interviewQuestions: [],
    };
    company = store().saveGeneratedPlan(company.id, company.revision, "a", content, [], "assisted");
    replaceFixture((record) => {
      record.plans[0].confirmedAt = "2026-09-25T00:00:00.000Z";
    });
    const savedPlan = structuredClone(company.plans[0]);
    await save();
    expect(company.plans[0]).toEqual(savedPlan);
    await save(input("b"));
    expect(company.plans[0]).toEqual({ ...savedPlan, confirmedAt: null });
  });
  it.each([
    { body: { action: "select-candidate", revision: 1, candidateId: "a" } },
    { extra: { reason: "  " } },
    { extra: { recordedAt: "forged" } },
    { query: "?override=1" },
    { headers: { origin: "https://foreign.invalid" } },
  ])("strictly rejects unsafe requests", async (options) => {
    const saved = row();
    const response = await patch(options.body ?? { ...input(), ...options.extra }, options);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(row()).toEqual(saved);
  });
  it("limits request bytes and returns history through the ordinary case GET", async () => {
    const request = input();
    expect((await patch(" ".repeat(16384) + JSON.stringify(request))).status).toBe(413);
    await save(request);
    const response = await GET(
      new Request(`http://localhost:3000/api/studio/cases/${company.id}`),
      { params: Promise.resolve({ caseId: company.id }) },
    );
    expect((await response.json()).candidateSelections).toEqual(company.candidateSelections);
  });
});
