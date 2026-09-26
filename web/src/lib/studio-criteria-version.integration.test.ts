import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import { emptyProfile, type CaseMutation, type StudioCase } from "./studio-schema";
import { criteriaVersionContentSha } from "./studio-criteria-version";
import {
  type CriteriaVersionDetails,
  criteriaVersionLimits,
} from "./studio-criteria-version-types";
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
import { GET as EXPORT } from "@/app/api/studio/cases/[caseId]/criteria-bindings/[bindingId]/export/route";

let directory: string, company: StudioCase;
const store = () => state.store!;
function dbAction<T>(action: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(directory, "studio.sqlite"));
  try {
    return action(db);
  } finally {
    db.close();
  }
}
function row() {
  return dbAction((db) => db.prepare("SELECT * FROM studio_cases WHERE id=?").get(company.id)!);
}
function replaceBody(change: (value: StudioCase) => void) {
  const value = store().get(company.id);
  change(value);
  delete value.applicationCriteriaContexts;
  dbAction((db) =>
    db.prepare("UPDATE studio_cases SET body=? WHERE id=?").run(JSON.stringify(value), company.id),
  );
  company = store().get(company.id);
}
function mutate(input: CaseMutation) {
  company = store().mutate(company.id, input, () => []);
  return company;
}
function application() {
  mutate({
    action: "create-application",
    revision: company.revision,
    clientRequestId: randomUUID(),
    title: "합성 회차",
    kind: "new",
    plannedOn: "",
    criteriaNote: "수동 참고",
    previousApplicationId: null,
  });
  return company.applications.at(-1)!;
}
function details(): CriteriaVersionDetails {
  return {
    title: "합성 기준",
    versionLabel: "합성 1",
    applicationPath: "담당자 경로 메모",
    checkedOn: "2026-09-25",
    sources: [
      {
        title: "합성 출처",
        url: "https://example.invalid/reference",
        quote: "합성 인용",
        note: "실제 규정 아님",
      },
    ],
    documents: [
      {
        id: randomUUID(),
        name: "합성 서류",
        appliesTo: "",
        period: "",
        issueDateCondition: "",
        alternativeCondition: "",
        autoLinkGuidance: "미확인",
        note: "",
      },
    ],
  };
}
function append(overrides: Record<string, unknown> = {}) {
  return {
    action: "append-criteria-version",
    revision: company.revision,
    clientRequestId: randomUUID(),
    criteriaId: null,
    previousVersionId: null,
    details: details(),
    recordedBy: "합성 담당자",
    reason: "출처 확인 필요",
    ...overrides,
  };
}
function pin(overrides: Record<string, unknown> = {}) {
  const version = company.criteriaVersions[0],
    cycle = company.applications[0];
  return {
    action: "pin-application-criteria",
    revision: company.revision,
    clientRequestId: randomUUID(),
    applicationId: cycle.id,
    applicationMetadataVersionId: cycle.id,
    criteriaVersionId: version.id,
    criteriaContentSha256: version.contentSha256,
    previousBindingId: null,
    recordedBy: "합성 담당자",
    reason: "담당자가 명시한 버전",
    ...overrides,
  };
}
function patch(input: unknown, id = company.id, query = "", headers: Record<string, string> = {}) {
  return PATCH(
    new Request(`http://localhost:3000/api/studio/cases/${id}${query}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...headers },
      body: typeof input === "string" ? input : JSON.stringify(input),
    }),
    { params: Promise.resolve({ caseId: id }) },
  );
}
async function save(input: unknown) {
  const response = await patch(input);
  expect(response.status).toBe(200);
  company = await response.json();
  return company;
}
function download(
  bindingId = company.applicationCriteriaBindings[0].id,
  id = company.id,
  query = "",
  headers: Record<string, string> = {},
) {
  return EXPORT(
    new Request(
      `http://localhost:3000/api/studio/cases/${id}/criteria-bindings/${bindingId}/export${query}`,
      { headers },
    ),
    { params: Promise.resolve({ caseId: id, bindingId }) },
  );
}
async function setup() {
  application();
  await save(append());
  await save(pin());
}
function seedReviewedWork() {
  mutate({ action: "diagnose", revision: company.revision, clientRequestId: randomUUID() });
  const candidate = {
    id: "synthetic",
    title: "합성 후보",
    problem: "문제",
    solution: "설명",
    targetCustomer: "고객",
    differentiation: "미확인",
    stage: "구상",
    businessModel: "미확인",
    recommendation: "검토",
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
    expectedSelectedCandidateId: null,
    reason: "명시한 합성 선택",
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
          content: "합성 기재",
          evidence: [],
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
}

describe("수동 기준과 회차 pin SQLite/API", () => {
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "venture-criteria-api-"));
    state.store = new StudioStore(directory);
    company = store().create({ ...emptyProfile(), companyName: "합성 기준 기업" });
    state.external.mockClear();
  });
  afterEach(() => {
    expect(state.external).not.toHaveBeenCalled();
    store().close();
    const boundary = relative(resolve(tmpdir()), resolve(directory));
    if (
      !boundary.startsWith("venture-criteria-api-") ||
      boundary.startsWith("..") ||
      isAbsolute(boundary)
    )
      throw new Error("Unsafe fixture cleanup");
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  it("legacy 배열 기본값 및 파생 상태는 조회/재시작 때 DB를 변경하지 않는다", async () => {
    const old = { ...company } as Partial<StudioCase>;
    delete old.criteriaVersions;
    delete old.applicationCriteriaBindings;
    delete old.applicationCriteriaContexts;
    dbAction((db) =>
      db.prepare("UPDATE studio_cases SET body=? WHERE id=?").run(JSON.stringify(old), company.id),
    );
    const before = row();
    store().close();
    state.store = new StudioStore(directory);
    const response = await GET(
      new Request(`http://localhost:3000/api/studio/cases/${company.id}`),
      { params: Promise.resolve({ caseId: company.id }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      criteriaVersions: [],
      applicationCriteriaBindings: [],
      applicationCriteriaContexts: [],
    });
    expect(row()).toEqual(before);
  });
  it("기준·핀 추가가 현재 분석·선택·확인 원고·진단·근거 revision을 변경하지 않는다", async () => {
    seedReviewedWork();
    const before = structuredClone(company),
      stored = row();
    await setup();
    for (const key of [
      "profile",
      "sources",
      "analysis",
      "selectedCandidateId",
      "candidateSelections",
      "plans",
      "diagnoses",
      "tasks",
      "stage",
      "agencyRecords",
      "preparationRuns",
    ] as const)
      expect(company[key]).toEqual(before[key]);
    expect(row().evidence_revision).toBe(stored.evidence_revision);
    expect(company.plans[0].confirmedAt).not.toBeNull();
    expect(company.applicationCriteriaContexts?.[0].context.status).toBe("pinned-unverified");
    expect(JSON.parse(String(row().body))).not.toHaveProperty("applicationCriteriaContexts");
  });
  it("정정과 다시 연결은 append-only, 새 기준은 과거 pin의 재확인 안내만 바꾼다", async () => {
    await setup();
    const first = structuredClone(company.criteriaVersions[0]),
      oldPin = structuredClone(company.applicationCriteriaBindings[0]);
    await save(
      append({
        criteriaId: first.criteriaId,
        previousVersionId: first.id,
        details: { ...first.details, title: "새 합성 기준" },
      }),
    );
    expect(company.applicationCriteriaContexts?.[0].context).toMatchObject({
      status: "needs-review",
      reasons: ["newer-criteria-version"],
    });
    expect(company.criteriaVersions[0]).toEqual(first);
    expect(company.applicationCriteriaBindings[0]).toEqual(oldPin);
    const next = company.criteriaVersions[1];
    await save(
      pin({
        previousBindingId: oldPin.id,
        criteriaVersionId: next.id,
        criteriaContentSha256: next.contentSha256,
      }),
    );
    expect(company.applicationCriteriaBindings[1]).toMatchObject({
      version: 2,
      previousBindingId: oldPin.id,
      criteriaVersionId: next.id,
    });
    expect(company.applicationCriteriaContexts?.[0].context.status).toBe("pinned-unverified");
  });
  it("동일 nonce 재전송은 stale revision이어도 무쓰기, 다른 payload와 새 stale 요청은 거부한다", async () => {
    application();
    const first = append();
    await save(first);
    const firstPin = pin();
    await save(firstPin);
    const before = row();
    await save(first);
    await save(firstPin);
    expect(row()).toEqual(before);
    expect((await patch({ ...first, reason: "다른 이유" })).status).toBe(409);
    expect((await patch({ ...first, clientRequestId: randomUUID() })).status).toBe(409);
    expect(row()).toEqual(before);
  });
  it("과거 pin 재전송은 현재 연결을 복원하지 않고 재시작 후에도 정확히 유지한다", async () => {
    application();
    await save(append());
    const original = pin();
    await save(original);
    const old = company.applicationCriteriaBindings[0];
    await save(pin({ previousBindingId: old.id, reason: "같은 기준 재확인" }));
    const latest = company.applicationCriteriaBindings[1],
      before = row();
    store().close();
    state.store = new StudioStore(directory);
    await save(original);
    expect(company.applicationCriteriaContexts?.[0].context.bindingId).toBe(latest.id);
    expect(row()).toEqual(before);
  });
  it("회차·회사 변경은 과거 snapshot 불변과 응답 재확인만 만든다", async () => {
    await setup();
    const cycle = company.applications[0],
      frozen = structuredClone(company.applicationCriteriaBindings[0]);
    mutate({
      action: "correct-application",
      revision: company.revision,
      clientRequestId: randomUUID(),
      applicationId: cycle.id,
      previousVersionId: cycle.id,
      title: "바뀐 회차",
      kind: "new",
      plannedOn: "",
      criteriaNote: "정정",
      previousApplicationId: null,
    });
    mutate({
      action: "profile",
      revision: company.revision,
      profile: { ...company.profile, companyName: "바뀐 회사" },
    });
    expect(company.applicationCriteriaBindings[0]).toEqual(frozen);
    expect(company.applicationCriteriaContexts?.[0].context.reasons).toEqual([
      "application-changed",
      "company-changed",
    ]);
    const before = row();
    expect((await patch(pin({ previousBindingId: frozen.id }))).status).toBe(409);
    expect(row()).toEqual(before);
  });
  it("다른 회사 기준/회차/핀 및 존재하지 않는 ID를 섞을 수 없다", async () => {
    await setup();
    const foreign = store().create({ ...emptyProfile(), companyName: "다른 합성 회사" }),
      before = row();
    expect((await patch(pin({ applicationId: randomUUID() }))).status).toBe(404);
    expect((await patch(pin({ criteriaVersionId: randomUUID() }))).status).toBe(404);
    expect((await patch({ ...pin(), revision: foreign.revision }, foreign.id)).status).toBe(404);
    expect((await download(company.applicationCriteriaBindings[0].id, foreign.id)).status).toBe(
      404,
    );
    expect(row()).toEqual(before);
  });
  it("같은 버전 ID 내용과 자체 hash 동시변조도 다른 회차 최초 pin·replay·export를 막는다", async () => {
    await setup();
    const cycle = application();
    replaceBody((value) => {
      value.criteriaVersions[0].details.title = "동일 ID 변조";
      value.criteriaVersions[0].contentSha256 = criteriaVersionContentSha(
        value.criteriaVersions[0].details,
      );
    });
    const before = row(),
      response = await patch(
        pin({ applicationId: cycle.id, applicationMetadataVersionId: cycle.id }),
      );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "CRITERIA_CONTENT_CHANGED" });
    expect((await download()).status).toBe(409);
    expect(row()).toEqual(before);
  });
  it("회사 입력 잠금은 기존 nonce replay를 포함해 기준 변경을 거부한다", async () => {
    const input = append();
    await save(input);
    const before = row();
    await withVentureInputCompanyLock(company.id, async () => {
      const response = await patch(input);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "INPUT_IN_PROGRESS" });
    });
    expect(row()).toEqual(before);
  });
  it("기준 개수 상한과 DB 쓰기 오류는 전체 rollback한다", async () => {
    await save(append());
    const first = company.criteriaVersions[0];
    replaceBody((value) => {
      value.criteriaVersions = Array.from({ length: criteriaVersionLimits.versions }, () => {
        const id = randomUUID();
        return { ...structuredClone(first), id, criteriaId: id, clientRequestId: randomUUID() };
      });
    });
    const before = row();
    expect((await patch(append())).status).toBe(413);
    expect(row()).toEqual(before);
    replaceBody((value) => {
      value.criteriaVersions = [];
    });
    const second = row();
    dbAction((db) =>
      db.exec(
        "CREATE TRIGGER criteria_test_rollback BEFORE UPDATE ON studio_cases BEGIN SELECT RAISE(ABORT, 'synthetic'); END;",
      ),
    );
    expect((await patch(append())).status).toBe(500);
    expect(row()).toEqual(second);
    dbAction((db) => db.exec("DROP TRIGGER criteria_test_rollback"));
    await save(append());
    expect(company.criteriaVersions).toHaveLength(1);
  });
  it.each([
    { officialVerification: "verified" },
    { caseId: randomUUID() },
    { contentSha256: "a".repeat(64) },
    { recordedAt: "2026-09-25T00:00:00.000Z" },
  ])("서버 metadata 주입을 거부한다 %j", async (extra) => {
    const before = row();
    expect((await patch({ ...append(), ...extra })).status).toBe(400);
    expect(row()).toEqual(before);
  });
  it("잘못된 날짜/중복서류/root짝/query/origin/content-type을 거부한다", async () => {
    const before = row(),
      original = details();
    for (const input of [
      append({ details: { ...original, checkedOn: "2026-02-30" } }),
      append({
        details: { ...original, documents: [original.documents[0], original.documents[0]] },
      }),
      append({ criteriaId: randomUUID() }),
    ])
      expect((await patch(input)).status).toBe(400);
    expect((await patch(append(), company.id, "?extra=1")).status).toBe(400);
    expect(
      (await patch(append(), company.id, "", { origin: "https://example.invalid" })).status,
    ).toBe(403);
    expect((await patch(append(), company.id, "", { "content-type": "text/plain" })).status).toBe(
      415,
    );
    expect(row()).toEqual(before);
  });
  it("128KiB 요청과 누적 본문 한도를 지키며 기존 이력을 자르지 않는다", async () => {
    const input = append(),
      before = row();
    expect(
      (await patch(`${JSON.stringify(input)}${" ".repeat(criteriaVersionLimits.requestBytes)}`))
        .status,
    ).toBe(413);
    expect(row()).toEqual(before);
    await save(input);
    const entry = company.criteriaVersions[0];
    replaceBody((value) => {
      const large = {
        ...entry.details.documents[0],
        note: "x".repeat(2000),
        period: "x".repeat(2000),
        appliesTo: "x".repeat(2000),
        issueDateCondition: "x".repeat(2000),
        alternativeCondition: "x".repeat(2000),
        autoLinkGuidance: "x".repeat(2000),
      };
      value.criteriaVersions[0].details.documents = Array.from({ length: 40 }, () => ({
        ...large,
        id: randomUUID(),
      }));
      value.criteriaVersions[0].contentSha256 = criteriaVersionContentSha(
        value.criteriaVersions[0].details,
      );
    });
    const near = row();
    const medium = details();
    medium.documents = Array.from({ length: 20 }, () => ({
      ...medium.documents[0],
      id: randomUUID(),
      note: "x".repeat(2000),
    }));
    expect((await patch(append({ details: medium }))).status).toBe(413);
    expect(row()).toEqual(near);
  });
  it("정확 과거 pin Markdown은 no-store/고정파일명이며 최신 내용·다른 자료 없이 DB 무변경이다", async () => {
    await setup();
    const first = company.criteriaVersions[0],
      binding = company.applicationCriteriaBindings[0];
    await save(
      append({
        criteriaId: first.criteriaId,
        previousVersionId: first.id,
        details: { ...first.details, title: "최신 전용 비포함 표지" },
      }),
    );
    const newest = company.criteriaVersions[1];
    await save(
      pin({
        previousBindingId: binding.id,
        criteriaVersionId: newest.id,
        criteriaContentSha256: newest.contentSha256,
      }),
    );
    const before = row(),
      response = await download(binding.id),
      output = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-disposition")).toContain(
      "venturepass-criteria-reference.md",
    );
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(output).toContain(first.id);
    expect(output).toContain(first.contentSha256);
    expect(output).toContain("새 기준 버전");
    expect(output).not.toContain("최신 전용 비포함 표지");
    expect(output).toContain("미확인 · 기록 없음");
    expect(output).toContain("기관 확인·자격 충족·접수 결과가 아닙니다");
    expect(Buffer.byteLength(output)).toBe(Number(response.headers.get("content-length")));
    expect(row()).toEqual(before);
  });
  it("export도 query/origin/invalidUUID/없는 pin을 거부하고 응답에 raw body를 노출하지 않는다", async () => {
    await setup();
    const before = row();
    expect((await download(undefined, company.id, "?latest=1")).status).toBe(400);
    expect(
      (await download(undefined, company.id, "", { origin: "https://example.invalid" })).status,
    ).toBe(403);
    expect((await download("not-uuid")).status).toBe(400);
    expect((await download(randomUUID())).status).toBe(404);
    expect(row()).toEqual(before);
  });
});
