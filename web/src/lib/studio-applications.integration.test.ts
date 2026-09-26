import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import {
  emptyProfile,
  type CaseMutation,
  type SourceDocument,
  type StudioCase,
} from "./studio-schema";
import {
  applicationMetadata,
  currentApplicationLinks,
  latestApplicationSubmissions,
} from "./studio-application-types";
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
import { PATCH } from "@/app/api/studio/cases/[caseId]/route";

let directory: string;
let company: StudioCase;
const bytes = Buffer.from("%PDF-1.7\nSYNTHETIC ORIGINAL");
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const store = () => state.store!;
function mutate(input: CaseMutation) {
  company = store().mutate(company.id, input, () => []);
  return company;
}
function createInput(overrides: Record<string, unknown> = {}) {
  return {
    action: "create-application",
    revision: company.revision,
    clientRequestId: randomUUID(),
    title: "합성 신청회차",
    kind: "new",
    plannedOn: "",
    criteriaNote: "미확인 기준",
    previousApplicationId: null,
    ...overrides,
  };
}
async function patch(
  body: unknown,
  id = company.id,
  query = "",
  headers: Record<string, string> = {},
) {
  return PATCH(
    new Request(`http://localhost:3000/api/studio/cases/${id}${query}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ caseId: id }) },
  );
}
async function save(body: unknown) {
  const response = await patch(body);
  expect(response.status).toBe(200);
  company = await response.json();
  return company;
}
async function cycle(previousApplicationId: string | null = null) {
  await save(createInput({ previousApplicationId }));
  return company.applications.at(-1)!;
}
function original(name = "합성 자료") {
  const now = new Date().toISOString();
  const source: SourceDocument = {
    id: randomUUID(),
    name,
    kind: "technology",
    text: "정확한 합성 인용",
    originalName: "synthetic.pdf",
    mimeType: "application/pdf",
    extraction: "local",
    warnings: [],
    createdAt: now,
    updatedAt: now,
  };
  company = store().addUpload(company.id, company.revision, source, bytes);
  return company.sources.at(-1)!;
}
function plan(source: SourceDocument) {
  const candidate = {
    id: "synthetic-candidate",
    title: "합성 아이템",
    problem: "문제",
    solution: "해결",
    targetCustomer: "고객",
    differentiation: "미확인",
    stage: "구상",
    businessModel: "미확인",
    recommendation: "검토 필요",
    evidence: [],
    gaps: [],
  };
  company = store().saveAnalysis(
    company.id,
    company.revision,
    { summary: "합성 분석", facts: [], candidates: [candidate], questions: [], warnings: [] },
    "assisted",
  );
  mutate({
    action: "select-candidate",
    revision: company.revision,
    clientRequestId: randomUUID(),
    candidateId: candidate.id,
    analysisGeneratedAt: company.analysis!.generatedAt,
    analysisSourceRevision: company.analysis!.sourceRevision,
    expectedSelectedCandidateId: company.selectedCandidateId,
    reason: "합성 후보 선택 근거",
  });
  company = store().saveGeneratedPlan(
    company.id,
    company.revision,
    candidate.id,
    {
      title: "합성 원고",
      summary: "초안",
      sections: [
        {
          key: "solution",
          title: "기술",
          content: "합성 기술 설명",
          evidence: [{ sourceId: source.id, quote: source.text, locator: "본문" }],
          needsConfirmation: false,
        },
      ],
      actionItems: [],
      interviewQuestions: [],
    },
    [],
    "assisted",
  );
  mutate({ action: "confirm-plan", revision: company.revision, planId: company.plans.at(-1)!.id });
  return company.plans.at(-1)!;
}
function submission(
  applicationId: string,
  planId: string,
  sourceIds: string[],
  overrides: Record<string, unknown> = {},
) {
  return {
    action: "record-application-submission",
    revision: company.revision,
    clientRequestId: randomUUID(),
    applicationId,
    planId,
    sourceIds,
    taskIds: [],
    receiptRecordId: null,
    occurredOn: "2026-09-25",
    recordedBy: "합성 담당자",
    note: "담당자 제출 기록이며 기관 접수 미검증",
    ...overrides,
  };
}
function request(previous?: string) {
  mutate({
    action: "append-agency-record",
    revision: company.revision,
    clientRequestId: randomUUID(),
    record: {
      ...(previous
        ? {
            kind: "request-correction" as const,
            requestRecordId: company.agencyRecords.find((item) => item.kind === "request")!.id,
            previousVersionId: previous,
          }
        : { kind: "request" as const }),
      institution: "합성 기관",
      title: "자료 요청",
      body: "가상 요청",
      occurredOn: "",
      dueOn: "",
      dueNote: "",
      note: "",
      sourceIds: [],
    },
  });
  return company.agencyRecords.at(-1)!;
}
function notice(category: "receipt" | "decision" = "receipt") {
  mutate({
    action: "append-agency-record",
    revision: company.revision,
    clientRequestId: randomUUID(),
    record: {
      kind: "notice",
      institution: "합성 기관",
      title: "수동 통보",
      body: "합성 통보",
      occurredOn: "",
      note: "",
      sourceIds: [],
      details:
        category === "receipt"
          ? { category, receiptNumber: "수기 번호", receivedOn: "", statusText: "미확인" }
          : { category, decisionText: "담당자 결과 기록", notifiedOn: "", reasons: "" },
    },
  });
  return company.agencyRecords.at(-1)!;
}
function appeal(source: SourceDocument, planId: string) {
  const decision = notice("decision");
  mutate({
    action: "append-appeal-preparation",
    revision: company.revision,
    clientRequestId: randomUUID(),
    preparation: {
      preparationId: null,
      previousVersionId: null,
      noticeRecordId: decision.id,
      noticeVersionId: decision.id,
      title: "합성 소명 준비",
      intent: "undecided",
      intentNote: "",
      deadlineOn: "",
      deadlineNote: "미확인",
      reasons: [
        {
          id: randomUUID(),
          noticeField: "body",
          noticeQuote: "합성 통보",
          claim: "미검토 주장",
          planClaim: { planId, sectionKey: "solution", quote: "합성 기술 설명" },
          gap: "검토 필요",
          evidence: [
            {
              sourceId: source.id,
              sourceUpdatedAt: source.updatedAt,
              quote: source.text,
              locator: "등록 본문",
            },
          ],
          additionalEvidence: [],
          draft: "미검토 소명 초안",
        },
      ],
      review: { reviewed: false, reviewer: "", note: "" },
    },
  });
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "venture-applications-test-"));
  state.store = new StudioStore(directory);
  company = store().create({ ...emptyProfile(), companyName: "합성 회차 검증 회사" });
  state.external.mockClear();
});
afterEach(() => {
  state.store!.close();
  const boundary = relative(resolve(tmpdir()), resolve(directory));
  if (!/^venture-applications-test-[^\\/]+$/.test(boundary))
    throw new Error("Unsafe synthetic cleanup");
  rmSync(directory, { recursive: true, force: true });
  expect(state.external).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe("신청회차 API/실제 합성 SQLite", () => {
  it("회차 등록·다음 회차 연결·응답유실 재시도는 기존 회사/단계를 바꾸지 않는다", async () => {
    const before = structuredClone(company);
    const input = createInput();
    await save(input);
    const first = company.applications[0];
    const revision = company.revision;
    await save(input);
    expect(company.revision).toBe(revision);
    expect(company.applications).toHaveLength(1);
    const second = await cycle(first.id);
    expect(second.previousApplicationId).toBe(first.id);
    expect(company.profile).toEqual(before.profile);
    expect(company.stage).toBe(before.stage);
    expect(company.stageHistory).toEqual([]);
    expect(company.agencyRecords).toEqual([]);
    expect((await patch({ ...input, title: "변경" })).status).toBe(409);
  });
  it("메타 정정과 재시작은 원래 회차·부모 이력을 보존한다", async () => {
    const first = await cycle();
    await save({
      action: "correct-application",
      revision: company.revision,
      clientRequestId: randomUUID(),
      applicationId: first.id,
      previousVersionId: first.id,
      title: "정정한 회차",
      kind: "renewal",
      plannedOn: "2026-10-01",
      criteriaNote: "사람 확인 필요",
      previousApplicationId: null,
    });
    const saved = structuredClone(company);
    store().close();
    state.store = new StudioStore(directory);
    company = store().get(company.id);
    expect(company).toEqual(saved);
    expect(company.applications[0]).toEqual(first);
    expect(applicationMetadata(company, first.id)?.title).toBe("정정한 회차");
  });
  it("구형 DB는 회차를 자동 이관하거나 submitted를 추정하지 않는다", () => {
    const db = new DatabaseSync(join(directory, "studio.sqlite"));
    const legacy: Record<string, unknown> = { ...company, stage: "submitted" };
    delete legacy.applications;
    delete legacy.applicationEvents;
    db.prepare("UPDATE studio_cases SET body=? WHERE id=?").run(JSON.stringify(legacy), company.id);
    db.close();
    const read = store().get(company.id);
    expect(read.applications).toEqual([]);
    expect(read.applicationEvents).toEqual([]);
    expect(read.stage).toBe("submitted");
    expect(read.revision).toBe(company.revision);
  });
  it("제출 당시 원고/검토/원본/담당자 메타는 회사 수정 후에도 고정된다", async () => {
    const source = original();
    const selected = plan(source);
    const first = await cycle();
    const task = {
      id: randomUUID(),
      title: "기존 담당 업무",
      category: "evidence" as const,
      dueDate: "",
      status: "pending" as const,
      notes: "",
      owners: { materials: "원자료 담당자", writing: "원작성자", review: "원확인자" },
    };
    mutate({ action: "task", revision: company.revision, task });
    await save(submission(first.id, selected.id, [source.id], { taskIds: [task.id] }));
    const fixed = structuredClone(latestApplicationSubmissions(company, first.id)[0]);
    expect(fixed.plan.contentSha256).toBe(hash(JSON.stringify(selected.content)));
    expect(fixed.plan.confirmedAt).not.toBeNull();
    expect(fixed.originals[0].sha256).toBe(hash(bytes));
    expect(fixed.owners[0].owners).toEqual(task.owners);
    expect(fixed.evidence[0].state).toBe("matched");
    mutate({
      action: "profile",
      revision: company.revision,
      profile: { ...company.profile, companyName: "수정한 합성 회사" },
    });
    mutate({
      action: "task",
      revision: company.revision,
      task: { ...task, owners: { materials: "새 담당자", writing: "", review: "" } },
    });
    expect(company.plans[0].confirmedAt).toBeNull();
    expect(latestApplicationSubmissions(company, first.id)[0]).toEqual(fixed);
    expect(fixed.claim).toBe("reported-submitted");
    expect(fixed.officialVerification).toBe("unverified");
    expect(company.stage).toBe("drafting");
  });
  it("과거 초안도 사실 신고로 기록하되 확인 상태를 만들지 않고 정정은 append-only다", async () => {
    const source = original();
    const selected = plan(source);
    const first = await cycle();
    mutate({
      action: "save-plan",
      revision: company.revision,
      planId: selected.id,
      content: {
        ...selected.content,
        summary: "새 초안",
        sections: selected.content.sections.map((item) => ({ ...item, needsConfirmation: true })),
      },
    });
    const draft = company.plans.at(-1)!;
    await save(submission(first.id, selected.id, []));
    const before = structuredClone(latestApplicationSubmissions(company, first.id)[0]);
    expect(before.plan.latestVersion).toBe(false);
    await save(
      submission(first.id, draft.id, [], {
        action: "correct-application-submission",
        submissionRecordId: before.id,
        previousVersionId: before.id,
      }),
    );
    const corrected = latestApplicationSubmissions(company, first.id)[0];
    expect(corrected.version).toBe(2);
    expect(corrected.plan.confirmedAt).toBeNull();
    expect(corrected.plan.sections[0].needsConfirmation).toBe(true);
    expect(company.applicationEvents.find((item) => item.id === before.id)).toEqual(before);
  });
  it("기관 루트 전체는 단일 회차에 귀속하며 재귀속/해제/재연결 이력을 보존한다", async () => {
    const first = await cycle();
    const second = await cycle(first.id);
    const root = request();
    await save({
      action: "link-application-agency",
      revision: company.revision,
      clientRequestId: randomUUID(),
      applicationId: first.id,
      recordId: root.id,
      note: "첫 연결",
    });
    const initial = currentApplicationLinks(company)[0];
    const corrected = request(root.id);
    expect(currentApplicationLinks(company)[0].recordVersionId).toBe(root.id);
    expect(
      (
        await patch({
          action: "link-application-agency",
          revision: company.revision,
          clientRequestId: randomUUID(),
          applicationId: second.id,
          recordId: corrected.id,
          note: "",
        })
      ).status,
    ).toBe(409);
    for (const target of [second.id, null, first.id]) {
      const previous = currentApplicationLinks(company)[0];
      await save({
        action: "correct-application-agency-link",
        revision: company.revision,
        clientRequestId: randomUUID(),
        previousLinkEventId: previous.id,
        fromApplicationId: previous.applicationId,
        toApplicationId: target,
        recordId: corrected.id,
        note: "귀속을 정정함",
      });
      expect(currentApplicationLinks(company)).toHaveLength(1);
      expect(currentApplicationLinks(company)[0].applicationId).toBe(target);
    }
    expect(company.applicationEvents.find((item) => item.id === initial.id)).toEqual(initial);
    expect(company.agencyRecords).toHaveLength(2);
    expect(company.stage).toBe("preparing");
  });
  it("잘못된 체인/이전 귀속 버전·현재 회차·다른 기관 루트로 정정할 수 없다", async () => {
    const first = await cycle();
    const root = request();
    await save({
      action: "link-application-agency",
      revision: company.revision,
      clientRequestId: randomUUID(),
      applicationId: first.id,
      recordId: root.id,
      note: "",
    });
    const link = currentApplicationLinks(company)[0];
    const other = notice();
    const input = {
      action: "correct-application-agency-link",
      revision: company.revision,
      clientRequestId: randomUUID(),
      previousLinkEventId: link.id,
      fromApplicationId: first.id,
      toApplicationId: null,
      recordId: root.id,
      note: "정정",
    };
    const before = structuredClone(company);
    for (const change of [
      { previousLinkEventId: randomUUID() },
      { fromApplicationId: null },
      { recordId: other.id },
    ])
      expect((await patch({ ...input, ...change })).status).toBe(409);
    expect(store().get(company.id)).toEqual(before);
  });
  it("접수 근거는 같은 회차에 귀속된 정확한 접수 통보만 연결한다", async () => {
    const source = original();
    const selected = plan(source);
    const first = await cycle();
    const receipt = notice();
    const decision = notice("decision");
    expect(
      (await patch(submission(first.id, selected.id, [], { receiptRecordId: receipt.id }))).status,
    ).toBe(409);
    await save({
      action: "link-application-agency",
      revision: company.revision,
      clientRequestId: randomUUID(),
      applicationId: first.id,
      recordId: receipt.id,
      note: "",
    });
    expect(
      (await patch(submission(first.id, selected.id, [], { receiptRecordId: decision.id }))).status,
    ).toBe(409);
    await save(submission(first.id, selected.id, [], { receiptRecordId: receipt.id }));
    expect(latestApplicationSubmissions(company, first.id)[0].receiptRecordId).toBe(receipt.id);
    expect(latestApplicationSubmissions(company, first.id)[0].officialVerification).toBe(
      "unverified",
    );
  });
  it("선택 원본은 삭제/같은 크기 변조를 거부하고 이전 SHA는 유지한다", async () => {
    const source = original();
    const selected = plan(source);
    const first = await cycle();
    await save(submission(first.id, selected.id, [source.id]));
    const before = structuredClone(company);
    const deleted = await patch({
      action: "delete-source",
      revision: company.revision,
      sourceId: source.id,
    });
    expect(deleted.status).toBe(409);
    expect((await deleted.json()).code).toBe("APPLICATION_SOURCE_REFERENCED");
    writeFileSync(
      join(directory, "originals", company.id, `${source.id}.bin`),
      Buffer.alloc(bytes.length, 65),
    );
    const changed = await patch(submission(first.id, selected.id, [source.id]));
    expect(changed.status).toBe(409);
    expect((await changed.json()).code).toBe("APPLICATION_ORIGINAL_CHANGED");
    expect(store().get(company.id)).toEqual(before);
  });
  it("여러 파일 수집 중 먼저 읽은 원본이 변하면 전체 제출 기록을 버린다", async () => {
    const one = original();
    const selected = plan(one);
    const two = original("두 번째 자료");
    const first = await cycle();
    const before = structuredClone(company);
    const reader = store().originalForVentureInput.bind(store());
    let changed = false;
    vi.spyOn(store(), "originalForVentureInput").mockImplementation((id, sourceId) => {
      const result = reader(id, sourceId);
      if (sourceId === two.id && !changed) {
        changed = true;
        writeFileSync(
          join(directory, "originals", company.id, `${one.id}.bin`),
          Buffer.alloc(bytes.length, 66),
        );
      }
      return result;
    });
    expect((await patch(submission(first.id, selected.id, [one.id, two.id]))).status).toBe(409);
    expect(store().get(company.id)).toEqual(before);
  });
  it.each(["original", "plan"] as const)(
    "소명에 고정된 %s 변조는 제출 기록에서 거부한다",
    async (target) => {
      const source = original();
      const selected = plan(source);
      appeal(source, selected.id);
      const first = await cycle();
      const history = structuredClone(company.appealPreparations);
      if (target === "original") {
        writeFileSync(
          join(directory, "originals", company.id, `${source.id}.bin`),
          Buffer.alloc(bytes.length, 67),
        );
      } else {
        company.plans[0].content.summary = "같은 ID에서 변조한 내용";
        const db = new DatabaseSync(join(directory, "studio.sqlite"));
        db.prepare("UPDATE studio_cases SET body=? WHERE id=?").run(
          JSON.stringify(company),
          company.id,
        );
        db.close();
      }
      const before = store().get(company.id);
      const response = await patch(submission(first.id, selected.id, [source.id]));
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe(
        target === "original" ? "APPLICATION_ORIGINAL_CHANGED" : "APPLICATION_PLAN_CHANGED",
      );
      expect(store().get(company.id)).toEqual(before);
      expect(store().get(company.id).appealPreparations).toEqual(history);
    },
  );
  it.each(["application", "appeal"] as const)(
    "%s에서 고정한 원본은 기관 기록 경로로도 변조를 우회할 수 없다",
    async (origin) => {
      const source = original();
      const selected = plan(source);
      if (origin === "application") {
        const first = await cycle();
        await save(submission(first.id, selected.id, [source.id]));
      } else appeal(source, selected.id);
      const before = structuredClone(company);
      writeFileSync(
        join(directory, "originals", company.id, `${source.id}.bin`),
        Buffer.alloc(bytes.length, 68),
      );
      const response = await patch({
        action: "append-agency-record",
        revision: company.revision,
        clientRequestId: randomUUID(),
        record: {
          kind: "request",
          institution: "합성 기관",
          title: "추가 요청",
          body: "미검증 수기 요청",
          occurredOn: "",
          dueOn: "",
          dueNote: "",
          note: "",
          sourceIds: [source.id],
        },
      });
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("AGENCY_EVIDENCE_CHANGED");
      expect(store().get(company.id)).toEqual(before);
    },
  );
  it("다른 회사 ID는 안전 원본 reader를 호출하기 전에 거부한다", async () => {
    const source = original();
    const selected = plan(source);
    const first = await cycle();
    const other = store().create({ ...emptyProfile(), companyName: "다른 합성 회사" });
    const spy = vi.spyOn(store(), "originalForVentureInput");
    expect(
      (
        await patch(
          submission(first.id, selected.id, [source.id], { revision: other.revision }),
          other.id,
        )
      ).status,
    ).toBe(404);
    expect((await patch(submission(first.id, randomUUID(), [source.id]))).status).toBe(404);
    expect((await patch(submission(first.id, selected.id, [source.id, randomUUID()]))).status).toBe(
      404,
    );
    expect(spy).not.toHaveBeenCalled();
  });
  it("origin/query/서버필드/본문한도/회사 잠금/stale CAS 모두 저장 전 거부한다", async () => {
    const input = createInput();
    const before = structuredClone(company);
    expect(
      (await patch(input, company.id, "", { Origin: "https://external.invalid" })).status,
    ).toBe(403);
    expect((await patch(input, company.id, "?extra=1")).status).toBe(400);
    expect((await patch({ ...input, recordedAt: "forged" })).status).toBe(400);
    expect((await patch(`${JSON.stringify(input)}${" ".repeat(65536)}`)).status).toBe(413);
    expect((await patch({ ...input, revision: company.revision + 1 })).status).toBe(409);
    await withVentureInputCompanyLock(company.id, async () => {
      expect((await patch(input)).status).toBe(409);
    });
    expect(store().get(company.id)).toEqual(before);
  });
  it("회차 한도와 SQL 저장 실패는 기존 기록 전체를 rollback한다", async () => {
    await cycle();
    const db = new DatabaseSync(join(directory, "studio.sqlite"));
    const expanded = {
      ...company,
      applications: Array.from({ length: 30 }, () => ({
        ...company.applications[0],
        id: randomUUID(),
        clientRequestId: randomUUID(),
      })),
    };
    db.prepare("UPDATE studio_cases SET body=? WHERE id=?").run(
      JSON.stringify(expanded),
      company.id,
    );
    company = store().get(company.id);
    expect((await patch(createInput())).status).toBe(413);
    expect(store().get(company.id)).toEqual(company);
    const initial = { ...company, applications: company.applications.slice(0, 1) };
    db.prepare("UPDATE studio_cases SET body=? WHERE id=?").run(
      JSON.stringify(initial),
      company.id,
    );
    company = store().get(company.id);
    db.exec(
      "CREATE TRIGGER synthetic_failure BEFORE UPDATE ON studio_cases BEGIN SELECT RAISE(ABORT,'synthetic'); END",
    );
    expect((await patch(createInput())).status).toBe(500);
    expect(store().get(company.id)).toEqual(company);
    db.close();
  });
});
