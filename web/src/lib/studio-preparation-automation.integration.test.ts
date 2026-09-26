import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
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
import * as engine from "./studio-engine";
import { preparationDigest } from "./studio-preparation-state";
import { withVentureInputCompanyLock } from "./venturein-input-lock";
import {
  currentPreparationAutomationSetting,
  preparationAutomationLimits,
  type PreparationAutomationBatch,
} from "./studio-preparation-automation-types";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ store: null as StudioStore | null, external: vi.fn() }));
vi.mock("@/lib/studio-storage", async (original) => ({
  ...(await original<typeof import("./studio-storage")>()),
  getStudioStore: () => state.store!,
}));
vi.mock("openai", () => ({
  default: class {
    constructor() {
      state.external();
    }
  },
}));
vi.mock("@/lib/venturein-runner", () => ({ stopVentureSession: state.external }));
import { GET, POST } from "@/app/api/studio/cases/[caseId]/preparation-automation/route";
import { PATCH } from "@/app/api/studio/cases/[caseId]/route";

let directory: string, company: StudioCase;
const store = () => state.store!;
const context = (caseId = company.id) => ({ params: Promise.resolve({ caseId }) });
function db<T>(action: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(join(directory, "studio.sqlite"));
  try {
    return action(database);
  } finally {
    database.close();
  }
}
const row = () =>
  db((database) => database.prepare("SELECT * FROM studio_cases WHERE id=?").get(company.id)!);
const refresh = () => (company = store().get(company.id));
function replace(alter: (value: StudioCase) => void) {
  const value = structuredClone(company);
  alter(value);
  delete value.applicationCriteriaContexts;
  db((database) =>
    database
      .prepare("UPDATE studio_cases SET body=? WHERE id=?")
      .run(JSON.stringify(value), company.id),
  );
  refresh();
}
function mutate(input: CaseMutation) {
  company = store().mutate(company.id, input, engine.reviewPlan);
  return company;
}
function setting(enabled = true) {
  return {
    action: "set-preparation-automation" as const,
    revision: company.revision,
    clientRequestId: randomUUID(),
    expectedSettingVersion:
      currentPreparationAutomationSetting(company.preparationAutomation)?.version ?? 0,
    enabled,
  };
}
function enable(enabled = true) {
  const input = setting(enabled);
  mutate(input);
  return input;
}
function profile(technologySummary = "합성 기술은 입력 데이터를 처리합니다.") {
  mutate({
    action: "profile",
    revision: company.revision,
    profile: { ...company.profile, technologySummary },
  });
}
function source(pending = false) {
  const at = new Date().toISOString();
  const item: SourceDocument = {
    id: randomUUID(),
    name: "합성 기술자료",
    kind: "technology",
    text: pending ? "" : "합성 본문 근거",
    originalName: pending ? "synthetic.txt" : null,
    mimeType: pending ? "text/plain" : null,
    extraction: pending ? "pending" : "manual",
    warnings: [],
    createdAt: at,
    updatedAt: at,
  };
  if (pending)
    company = store().addUpload(
      company.id,
      company.revision,
      item,
      Buffer.from("synthetic-original"),
    );
  else mutate({ action: "source", revision: company.revision, source: item });
  return company.sources.find((entry) => entry.id === item.id)!;
}
function request(body: unknown, method = "POST", query = "", headers: Record<string, string> = {}) {
  return new Request(
    `http://localhost:3000/api/studio/cases/${company.id}/preparation-automation${query}`,
    {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
  );
}
function command(action = "run-pending", rest: Record<string, unknown> = {}) {
  return {
    action,
    revision: company.revision,
    clientRequestId: randomUUID(),
    expectedSettingVersion:
      currentPreparationAutomationSetting(company.preparationAutomation)?.version ?? 0,
    ...rest,
  };
}
async function result(body = command()) {
  const response = await POST(request(body), context());
  const payload = await response.json();
  expect(response.status, JSON.stringify(payload)).toBe(200);
  company = payload.company;
  return payload.batch as PreparationAutomationBatch;
}
function restart() {
  store().close();
  state.store = new StudioStore(directory);
  refresh();
}
function choose(batch: PreparationAutomationBatch) {
  const candidate = company.analysis!.candidates[0];
  mutate({
    action: "select-candidate",
    revision: company.revision,
    clientRequestId: randomUUID(),
    candidateId: candidate.id,
    analysisGeneratedAt: company.analysis!.generatedAt,
    analysisSourceRevision: company.analysis!.sourceRevision,
    expectedSelectedCandidateId: company.selectedCandidateId,
    reason: "합성 근거와 보완점을 확인한 선택",
  });
  return command("continue-batch", {
    batchId: batch.id,
    candidateId: candidate.id,
    candidateDigest: preparationDigest(candidate),
  });
}
beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  directory = mkdtempSync(join(tmpdir(), "venture-automation-test-"));
  state.store = new StudioStore(directory);
  company = store().create({ ...emptyProfile(), companyName: "합성 자동연결 기업" });
  vi.stubEnv("OPENAI_API_KEY", "synthetic-never-send");
});
afterEach(() => {
  expect(state.external).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  store().close();
  const boundary = relative(resolve(tmpdir()), resolve(directory));
  if (!boundary.startsWith("venture-automation-test-") || boundary.includes(".."))
    throw new Error("Unsafe fixture cleanup");
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("자료 변경 로컬 준비 연결 — 실제 임시 SQLite/API", () => {
  it("구형 기업은 기본 off이며 GET은 DB를 쓰지 않는다", async () => {
    replace((value) => {
      delete (value as Partial<StudioCase>).preparationAutomation;
    });
    const before = row();
    restart();
    expect(company.preparationAutomation.settings).toEqual([]);
    const response = await GET(
      new Request(`http://localhost:3000/api/studio/cases/${company.id}/preparation-automation`),
      context(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({ active: false });
    expect(row()).toEqual(before);
  });
  it("활성화는 현재 기준만 고정하고 과거 자료를 사건으로 만들지 않는다", () => {
    profile();
    source();
    const before = row();
    enable();
    expect(company.preparationAutomation.events).toEqual([]);
    expect(company.preparationRuns).toEqual([]);
    expect(row().evidence_revision).toBe(before.evidence_revision);
  });
  it("실제 프로필·본문 변경만 같은 거래에 사건으로 저장하고 timestamp-only는 제외한다", () => {
    enable();
    profile();
    const item = source();
    expect(company.preparationAutomation.events.map((event) => event.kind)).toEqual([
      "profile",
      "source",
    ]);
    const before = company.preparationAutomation.events;
    mutate({ action: "source", revision: company.revision, source: { ...item } });
    expect(company.preparationAutomation.events).toEqual(before);
    expect(JSON.stringify(before)).not.toContain("합성 본문 근거");
    expect(before.every((event) => event.companyRevision <= company.revision)).toBe(true);
    restart();
    expect(company.preparationAutomation.events).toEqual(before);
  });
  it("업무·단계·분석·준비 checkpoint는 변경 사건을 재귀 생성하지 않는다", async () => {
    enable();
    profile();
    const events = structuredClone(company.preparationAutomation.events);
    const batch = await result();
    expect(batch.status).toBe("awaiting_choice");
    expect(company.analysis?.candidates).toHaveLength(1);
    expect(company.preparationAutomation.events).toEqual(events);
    mutate({
      action: "stage",
      revision: company.revision,
      stage: "preparing",
      note: "합성 단계 메모",
    });
    expect(company.preparationAutomation.events).toEqual(events);
  });
  it("미검토 원본만 추가되면 판독을 호출하지 않고 본문 검토에서 기다린다", async () => {
    enable();
    const item = source(true);
    const batch = await result();
    expect(batch).toMatchObject({
      status: "source-review",
      pendingSourceIds: [item.id],
      command: null,
    });
    expect(company.analysis).toBeNull();
    expect(company.preparationRuns).toEqual([]);
    mutate({
      action: "source",
      revision: company.revision,
      source: { ...item, text: "직접 대조한 합성 본문", extraction: "manual" },
    });
    expect(company.preparationAutomation.events.at(-1)).toMatchObject({
      kind: "source",
      sourceReadiness: "ready",
    });
    expect(company.preparationAutomation.batches[0]).toEqual(batch);
  });
  it("기관 요청·답변만 바뀌면 기존 검토 화면으로 연결하고 새 초안이나 업무를 만들지 않는다", async () => {
    enable();
    mutate({
      action: "append-agency-record",
      revision: company.revision,
      clientRequestId: randomUUID(),
      record: {
        kind: "request",
        title: "합성 자료 요청",
        body: "합성 보완 내용",
        occurredOn: "",
        note: "",
        sourceIds: [],
        institution: "합성 기관",
        dueOn: "",
        dueNote: "",
      },
    });
    const batch = await result();
    expect(batch.status).toBe("request-review");
    expect(batch.agencyRecordIds).toEqual([company.agencyRecords[0].id]);
    expect(company.preparationRuns).toEqual([]);
    expect(company.tasks).toEqual([]);
    expect(company.plans).toEqual([]);
  });
  it("같은 요청 재전송·재시작은 준비·진단·후보를 중복 생성하지 않는다", async () => {
    enable();
    profile();
    const input = command();
    const batch = await result(input);
    const before = row();
    restart();
    expect(await result(input)).toEqual(batch);
    expect(row()).toEqual(before);
    expect(company.preparationRuns).toHaveLength(1);
    expect(company.diagnoses).toHaveLength(1);
    expect(company.preparationAutomation.events).toHaveLength(1);
  });
  it("후보 선택 이유를 명시 저장한 뒤에만 원고를 만들고 이후 replay는 버전을 늘리지 않는다", async () => {
    enable();
    profile();
    const batch = await result();
    const candidate = company.analysis!.candidates[0];
    const rejected = await POST(
      request(
        command("continue-batch", {
          batchId: batch.id,
          candidateId: candidate.id,
          candidateDigest: preparationDigest(candidate),
        }),
      ),
      context(),
    );
    expect(rejected.status).toBe(409);
    expect(company.plans).toEqual([]);
    const input = choose(batch);
    const finished = await result(input);
    expect(finished.status).toBe("awaiting_review");
    expect(company.plans).toHaveLength(1);
    expect(company.plans[0].confirmedAt).toBeNull();
    expect(company.plans[0].content.sections.every((section) => section.needsConfirmation)).toBe(
      true,
    );
    const before = row();
    restart();
    await result(input);
    expect(row()).toEqual(before);
  });
  it("명시적인 기존 원고 수정을 덮어쓰지 않고 과거 버전을 보존한다", async () => {
    enable();
    profile();
    const batch = await result();
    await result(choose(batch));
    const old = structuredClone(company.plans[0]);
    profile("새 합성 기술 변경");
    const next = await result();
    expect(next.status).toBe("awaiting_choice");
    expect(company.plans[0].content.sections).toEqual(old.content.sections);
    expect(company.plans[0].id).toBe(old.id);
    expect(company.plans).toHaveLength(1);
  });
  it("batch만 저장된 중단은 재시작 후 기록한 같은 내부 요청 번호로 재개한다", async () => {
    enable();
    profile();
    const begun = store().beginPreparationAutomation(
      company.id,
      command() as Parameters<StudioStore["beginPreparationAutomation"]>[1],
    );
    company = begun.company;
    const internalNonce = begun.command!.clientRequestId;
    restart();
    const finished = await result(command("resume-batch", { batchId: begun.batch.id }));
    expect(finished.status).toBe("awaiting_choice");
    expect(company.preparationRuns[0].requests[0].clientRequestId).toBe(internalNonce);
  });
  it("준비 산출물 저장 뒤 묶음 응답이 유실돼도 명시 재개는 산출물을 재생성하지 않는다", async () => {
    enable();
    profile();
    const finish = vi.spyOn(store(), "finishPreparationAutomation").mockImplementationOnce(() => {
      throw new Error("synthetic lost finish");
    });
    const response = await POST(request(command()), context());
    expect(response.status).toBe(500);
    finish.mockRestore();
    refresh();
    expect(company.preparationAutomation.batches[0].status).toBe("running");
    const runs = structuredClone(company.preparationRuns);
    const diagnoses = structuredClone(company.diagnoses);
    restart();
    const batch = await result(
      command("resume-batch", { batchId: company.preparationAutomation.batches[0].id }),
    );
    expect(batch.status).toBe("awaiting_choice");
    expect(company.preparationRuns).toEqual(runs);
    expect(company.diagnoses).toEqual(diagnoses);
  });
  it("자료 변경과 off/on 뒤 예전 running 묶음은 명시 재개로 superseded하고 새 사건을 남긴다", async () => {
    enable();
    profile();
    const begun = store().beginPreparationAutomation(
      company.id,
      command() as Parameters<StudioStore["beginPreparationAutomation"]>[1],
    );
    company = begun.company;
    enable(false);
    enable();
    profile("합성 새 설정의 기술 변경");
    const response = await POST(request(command()), context());
    expect(response.status).toBe(409);
    const old = await result(command("resume-batch", { batchId: begun.batch.id }));
    expect(old.status).toBe("superseded");
    const next = await result();
    expect(next.id).not.toBe(old.id);
    expect(next.eventIds).not.toEqual(old.eventIds);
  });
  it("설정의 과거 nonce 재생은 현재 off를 다시 켜지 않으며 내용 충돌은 거부한다", async () => {
    const on = enable();
    enable(false);
    const before = row();
    const response = await PATCH(request(on, "PATCH"), context());
    expect(response.status).toBe(200);
    expect(row()).toEqual(before);
    const conflict = await PATCH(request({ ...on, enabled: false }, "PATCH"), context());
    expect(conflict.status).toBe(409);
    expect(row()).toEqual(before);
  });
  it("회사·permission·revision 변경과 공식 입력 잠금은 새 실행 전에 거부한다", async () => {
    enable();
    profile();
    const input = command();
    const wrong = store().create({ ...emptyProfile(), companyName: "다른 합성 기업" });
    expect((await POST(request(input), context(wrong.id))).status).toBe(409);
    expect((await POST(request({ ...input, expectedSettingVersion: 0 }), context())).status).toBe(
      409,
    );
    expect((await POST(request({ ...input, revision: 0 }), context())).status).toBe(409);
    await withVentureInputCompanyLock(company.id, async () => {
      expect((await POST(request(input), context())).status).toBe(409);
      expect((await PATCH(request(setting(false), "PATCH"), context())).status).toBe(409);
    });
    expect(refresh().preparationRuns).toEqual([]);
  });
  it("SQL 실패는 프로필과 사건·revision을 함께 rollback한다", () => {
    enable();
    const before = row();
    db((database) =>
      database.exec(
        "CREATE TRIGGER synthetic_reject BEFORE UPDATE ON studio_cases BEGIN SELECT RAISE(ABORT,'synthetic reject'); END",
      ),
    );
    expect(() => profile()).toThrow();
    expect(row()).toEqual(before);
    db((database) => database.exec("DROP TRIGGER synthetic_reject"));
    refresh();
    profile();
    expect(company.preparationAutomation.events).toHaveLength(1);
  });
  it("사건 한도는 회사 자료 저장을 막지 않고 자동 연결만 보류한다", async () => {
    enable();
    profile();
    replace((value) => {
      const event = value.preparationAutomation.events[0];
      value.preparationAutomation.events = Array.from(
        { length: preparationAutomationLimits.events },
        (_, index) => ({
          ...event,
          id: randomUUID(),
          changeDigest: index.toString(16).padStart(64, "0"),
        }),
      );
    });
    const events = structuredClone(company.preparationAutomation.events);
    profile("합성 한도 이후 자료 변경");
    expect(company.profile.technologySummary).toBe("합성 한도 이후 자료 변경");
    expect(company.preparationAutomation.events).toEqual(events);
    expect(company.preparationAutomation.overflow).not.toBeNull();
    expect((await POST(request(command()), context())).status).toBe(409);
    enable(false);
    expect(currentPreparationAutomationSetting(company.preparationAutomation)?.enabled).toBe(false);
  });
  it("정규 설정 한도 이후에도 최종 중지는 저장할 수 있다", () => {
    enable();
    replace((value) => {
      const first = value.preparationAutomation.settings[0];
      value.preparationAutomation.settings = Array.from(
        { length: preparationAutomationLimits.settings },
        (_, index) => ({
          ...first,
          id: randomUUID(),
          clientRequestId: randomUUID(),
          version: index + 1,
        }),
      );
    });
    enable(false);
    expect(company.preparationAutomation.settings).toHaveLength(51);
    profile();
    expect(currentPreparationAutomationSetting(company.preparationAutomation)?.enabled).toBe(false);
    expect(() => enable()).toThrow();
  });
  it("실행 중 새 프로필 저장은 늦은 결과를 덮어쓰지 않고 기존 batch를 복구 대기로 보존한다", async () => {
    enable();
    profile();
    const original = engine.analyzeCompany;
    vi.spyOn(engine, "analyzeCompany").mockImplementationOnce(async (...args) => {
      refresh();
      profile("분석 대기 중 변경한 합성 기술");
      return original(...args);
    });
    const response = await POST(request(command()), context());
    expect(response.status).toBe(409);
    refresh();
    expect(company.profile.technologySummary).toBe("분석 대기 중 변경한 합성 기술");
    expect(company.analysis).toBeNull();
    expect(company.preparationAutomation.batches[0].status).toBe("running");
    const batch = await result(
      command("resume-batch", { batchId: company.preparationAutomation.batches[0].id }),
    );
    expect(batch.status).toBe("superseded");
  });
  it("strict API는 서버 상태·mode 주입, query, 외부 Origin과 과대 요청을 거부한다", async () => {
    enable();
    profile();
    const before = row();
    for (const body of [
      { ...command(), mode: "ai" },
      { ...command(), batch: {} },
      { ...setting(false), events: [] },
    ]) {
      const response =
        "events" in body
          ? await PATCH(request(body, "PATCH"), context())
          : await POST(request(body), context());
      expect(response.status).toBe(400);
    }
    expect((await POST(request(command(), "POST", "?x=1"), context())).status).toBe(400);
    expect((await PATCH(request(setting(false), "PATCH", "?x=1"), context())).status).toBe(400);
    expect(
      (await POST(request(command(), "POST", "", { origin: "https://example.invalid" }), context()))
        .status,
    ).toBe(403);
    expect(
      (await POST(request(command(), "POST", "", { "content-length": "8193" }), context())).status,
    ).toBe(413);
    expect(row()).toEqual(before);
  });
});
