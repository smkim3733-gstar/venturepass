import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import { emptyProfile, type StudioCase } from "./studio-schema";
import {
  emptyCompanyContacts,
  type CompanyContactsMutation,
} from "./studio-company-contacts-types";
import { buildLocalDiagnosis, diagnosisInputFingerprint } from "./studio-diagnosis";
import { runLocalPreparation } from "./studio-preparation";
import { buildPreparationPackage } from "./studio-package";
import { withVentureInputCompanyLock } from "./venturein-input-lock";
import { analyzeCompany, generatePlan } from "./studio-engine";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  store: null as StudioStore | null,
  external: vi.fn(),
  aiConstructor: vi.fn(),
  parse: vi.fn(),
}));
vi.mock("@/lib/studio-storage", async (original) => ({
  ...(await original<typeof import("./studio-storage")>()),
  getStudioStore: () => state.store!,
}));
vi.mock("@/lib/venturein-runner", () => ({ stopVentureSession: state.external }));
vi.mock("openai", () => ({
  default: class {
    responses = { parse: state.parse };
    constructor() {
      state.aiConstructor();
    }
  },
}));
import { GET, PATCH } from "@/app/api/studio/cases/[caseId]/route";

let directory: string, company: StudioCase;
const sentinel = "PRIVATE_CONTACT_ONLY_SYNTHETIC_18";
const store = () => state.store!;
function database<T>(action: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(directory, "studio.sqlite"));
  try {
    return action(db);
  } finally {
    db.close();
  }
}
const row = () =>
  database((db) =>
    db
      .prepare("SELECT body,revision,evidence_revision FROM studio_cases WHERE id=?")
      .get(company.id)!,
  );
function replace(value: unknown) {
  database((db) =>
    db.prepare("UPDATE studio_cases SET body=? WHERE id=?").run(JSON.stringify(value), company.id),
  );
}
function restart() {
  store().close();
  state.store = new StudioStore(directory);
  company = store().get(company.id);
}
function body(overrides: Partial<CompanyContactsMutation> = {}): CompanyContactsMutation {
  return {
    action: "append-company-contacts",
    revision: company.revision,
    clientRequestId: randomUUID(),
    previousVersionId: company.companyContacts.at(-1)?.id ?? null,
    contacts: {
      ...emptyCompanyContacts(),
      address: sentinel,
      companyContact: "실제 연락처가 아닌 합성 메모",
      note: "연락 가능 여부 미확인",
    },
    ...overrides,
  };
}
function patch(
  input: unknown,
  options: { caseId?: string; headers?: Record<string, string>; query?: string } = {},
) {
  const caseId = options.caseId ?? company.id;
  return PATCH(
    new Request(`http://localhost:3000/api/studio/cases/${caseId}${options.query ?? ""}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...options.headers },
      body: typeof input === "string" ? input : JSON.stringify(input),
    }),
    { params: Promise.resolve({ caseId }) },
  );
}
async function save(input = body()) {
  const response = await patch(input);
  const parsed = await response.json();
  expect(response.status, JSON.stringify(parsed)).toBe(200);
  company = parsed;
  return company.companyContacts.at(-1)!;
}
async function seedPlan() {
  let prepared = await runLocalPreparation(store(), company.id, {
    action: "start",
    revision: company.revision,
    clientRequestId: randomUUID(),
  });
  company = prepared.company;
  const candidate = company.analysis!.candidates[0];
  company = store().mutate(
    company.id,
    {
      action: "select-candidate",
      revision: company.revision,
      clientRequestId: randomUUID(),
      candidateId: candidate.id,
      analysisGeneratedAt: company.analysis!.generatedAt,
      analysisSourceRevision: company.analysis!.sourceRevision,
      expectedSelectedCandidateId: company.selectedCandidateId,
      reason: "합성 기술 구상의 명시적 선택",
    },
    () => [],
  );
  prepared = await runLocalPreparation(store(), company.id, {
    action: "continue",
    revision: company.revision,
    clientRequestId: randomUUID(),
    runId: prepared.run.id,
    candidateId: candidate.id,
    candidateDigest: prepared.run.candidates[0].digest,
  });
  company = prepared.company;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENAI_API_KEY", "");
  directory = mkdtempSync(join(tmpdir(), "venture-contacts-test-"));
  state.store = new StudioStore(directory);
  company = store().create({
    ...emptyProfile(),
    companyName: "합성 연락 메모 회사",
    technologySummary: "합성 기술 개발 구상",
  });
});
afterEach(() => {
  expect(state.external).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  store().close();
  const boundary = relative(resolve(tmpdir()), resolve(directory));
  if (!boundary.startsWith("venture-contacts-test-") || boundary.includes(".."))
    throw new Error("Unsafe synthetic cleanup");
  rmSync(directory, { recursive: true, force: true });
});

describe("기업 연락처 API와 실제 임시 SQLite", () => {
  it("구형 데이터는 가짜 버전 없이 읽고 재시작한다", async () => {
    const old = { ...company } as Partial<StudioCase>;
    delete old.companyContacts;
    replace(old);
    const before = row();
    restart();
    const response = await GET(
      new Request(`http://localhost:3000/api/studio/cases/${company.id}`),
      { params: Promise.resolve({ caseId: company.id }) },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).companyContacts).toEqual([]);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(row()).toEqual(before);
  });
  it("최초·정정·공란 버전을 보존하고 동일 nonce는 재시작 후에도 무쓰기 재사용한다", async () => {
    const firstInput = body(),
      first = await save(firstInput);
    const second = await save(
      body({ contacts: { ...emptyCompanyContacts(), note: "공란으로 명시 정정" } }),
    );
    const saved = row();
    restart();
    expect(company.companyContacts).toEqual([first, second]);
    const response = await patch(firstInput);
    expect(response.status).toBe(200);
    expect((await response.json()).companyContacts).toEqual([first, second]);
    expect(row()).toEqual(saved);
  });
  it("같은 nonce의 정규화 동일 payload만 재사용한다", async () => {
    const input = body();
    await save(input);
    const saved = row();
    expect(
      (
        await patch({
          ...input,
          revision: company.revision,
          contacts: { ...input.contacts, address: `  ${sentinel}  ` },
        })
      ).status,
    ).toBe(200);
    expect(row()).toEqual(saved);
    expect(
      (
        await patch({
          ...input,
          revision: company.revision,
          contacts: { ...input.contacts, note: "다른 정정" },
        })
      ).status,
    ).toBe(409);
    expect(row()).toEqual(saved);
  });
  it.each(["revision", "previous", "foreign"])(
    "오래된·다른 회사 %s 연결은 쓰지 않는다",
    async (kind) => {
      const first = await save();
      const other = store().create({ ...emptyProfile(), companyName: "별도 합성 회사" });
      const before = row(),
        otherBefore = structuredClone(other);
      const request = body(
        kind === "revision"
          ? { revision: company.revision - 1 }
          : {
              previousVersionId: kind === "foreign" ? first.id : randomUUID(),
              ...(kind === "foreign" ? { revision: other.revision } : {}),
            },
      );
      const response = await patch(request, kind === "foreign" ? { caseId: other.id } : {});
      expect(response.status).toBe(409);
      if (kind === "foreign")
        expect(await response.json()).toMatchObject({ code: "COMPANY_CONTACTS_VERSION_STALE" });
      expect(row()).toEqual(before);
      expect(store().get(other.id)).toEqual(otherBefore);
    },
  );
  it("입력 lock 중 변경·replay 모두 차단하고 종료 후 한 번 저장한다", async () => {
    const input = body();
    const before = row();
    await withVentureInputCompanyLock(company.id, async () => {
      const response = await patch(input);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "INPUT_IN_PROGRESS" });
      expect(row()).toEqual(before);
    });
    await save(input);
    const saved = row();
    await withVentureInputCompanyLock(company.id, async () =>
      expect((await patch(input)).status).toBe(409),
    );
    expect(row()).toEqual(saved);
  });
  it("SQL 실패를 롤백하고 같은 요청 번호로만 다시 저장한다", async () => {
    const input = body(),
      before = row();
    database((db) =>
      db.exec(
        "CREATE TRIGGER synthetic_contacts_failure BEFORE UPDATE ON studio_cases BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;",
      ),
    );
    expect((await patch(input)).status).toBe(500);
    expect(row()).toEqual(before);
    database((db) => db.exec("DROP TRIGGER synthetic_contacts_failure"));
    await save(input);
    expect(company.companyContacts).toHaveLength(1);
  });
  it.each(["records", "text"])("%s 한도 초과 시 과거 이력과 회사 상태를 보존한다", async (kind) => {
    const first = await save();
    const contacts =
      kind === "records"
        ? first.contacts
        : {
            address: "x".repeat(500),
            representativeContact: "x".repeat(500),
            companyContact: "x".repeat(500),
            materialsOwner: "x".repeat(100),
            finalReviewOwner: "x".repeat(100),
            paymentOwner: "x".repeat(100),
            note: "x".repeat(2000),
          };
    const count = kind === "records" ? 100 : 50;
    const records = Array.from({ length: count }, (_, index) => ({
      ...first,
      contacts,
      id: randomUUID(),
      version: index + 1,
      clientRequestId: randomUUID(),
    }));
    replace({ ...company, companyContacts: records });
    company = store().get(company.id);
    const before = row();
    const response = await patch(body({ contacts }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "COMPANY_CONTACTS_LIMIT" });
    expect(row()).toEqual(before);
  });
  it.each(["id", "version", "recordedAt", "origin", "inputDigest", "unknown"])(
    "서버 속성 %s 주입을 거부한다",
    async (key) => {
      const before = row();
      expect((await patch({ ...body(), [key]: "forged" })).status).toBe(400);
      expect(row()).toEqual(before);
    },
  );
  it.each(["address", "materialsOwner", "note"])("%s 필드 한도와 누락을 거부한다", async (key) => {
    const before = row(),
      input = body();
    expect(
      (await patch({ ...input, contacts: { ...input.contacts, [key]: "x".repeat(2001) } })).status,
    ).toBe(400);
    expect((await patch({ ...input, contacts: {} })).status).toBe(400);
    expect(row()).toEqual(before);
  });
  it.each(["origin", "query", "size", "nonce", "json", "content-type"])(
    "%s 요청 경계를 지킨다",
    async (kind) => {
      const before = row();
      const payload =
        kind === "json"
          ? "{"
          : kind === "size"
            ? JSON.stringify(body()) + " ".repeat(17000)
            : kind === "nonce"
              ? { ...body(), clientRequestId: "bad" }
              : body();
      const response = await patch(
        payload,
        kind === "origin"
          ? { headers: { origin: "https://example.com" } }
          : kind === "query"
            ? { query: "?ignored=1" }
            : kind === "content-type"
              ? { headers: { "content-type": "text/plain" } }
              : {},
      );
      expect(response.status).toBe(
        kind === "origin" ? 403 : kind === "size" ? 413 : kind === "content-type" ? 415 : 400,
      );
      expect(row()).toEqual(before);
    },
  );
});

describe("연락 메모의 분석·근거·출력 격리", () => {
  it("연락 메모 변경은 근거 revision·진단·준비·원고·확인 표시를 바꾸지 않는다", async () => {
    await seedPlan();
    company.plans[0].confirmedAt = "2026-09-25T12:00:00.000Z";
    replace(company);
    company = store().get(company.id);
    const before = structuredClone(company),
      priorRow = row();
    const diagnosis = buildLocalDiagnosis(before),
      fingerprint = diagnosisInputFingerprint(before);
    await save();
    expect({
      ...company,
      companyContacts: [],
      revision: before.revision,
      updatedAt: before.updatedAt,
    }).toEqual(before);
    expect(row().evidence_revision).toBe(priorRow.evidence_revision);
    expect(diagnosisInputFingerprint(company)).toBe(fingerprint);
    expect(buildLocalDiagnosis(company)).toEqual(diagnosis);
    expect(store().isPlanCurrent(company.id, company.plans[0])).toBe(true);
    expect(state.aiConstructor).not.toHaveBeenCalled();
  });
  it("선택 원고·자료 ZIP에는 연락 메모와 담당 역할을 자동 포함하지 않는다", async () => {
    await seedPlan();
    const planId = company.plans[0].id;
    const before = await buildPreparationPackage(store(), company.id, {
      revision: company.revision,
      planId,
      sourceIds: [],
    });
    await save(
      body({
        contacts: Object.fromEntries(
          Object.keys(emptyCompanyContacts()).map((key) => [key, sentinel]),
        ) as ReturnType<typeof emptyCompanyContacts>,
      }),
    );
    const after = await buildPreparationPackage(store(), company.id, {
      revision: company.revision,
      planId,
      sourceIds: [],
    });
    const firstZip = await JSZip.loadAsync(before.buffer),
      nextZip = await JSZip.loadAsync(after.buffer);
    for (const name of ["plan.md", "review.md", "evidence.json"])
      expect(await nextZip.file(name)!.async("string")).toBe(
        await firstZip.file(name)!.async("string"),
      );
    for (const file of Object.values(nextZip.files))
      expect(await file.async("string")).not.toContain(sentinel);
  });
  it("AI 분석·원고·독립검토의 mock 요청 입력은 연락 메모 저장 전후 동일하다", async () => {
    await seedPlan();
    const before = structuredClone(company);
    await save();
    vi.stubEnv("OPENAI_API_KEY", "synthetic-mock-only-key");
    const analysis = {
      summary: before.analysis!.summary,
      facts: before.analysis!.facts,
      candidates: before.analysis!.candidates,
      questions: before.analysis!.questions,
      warnings: before.analysis!.warnings,
    };
    for (const current of [before, company]) {
      state.parse.mockResolvedValueOnce({
        status: "completed",
        output_parsed: structuredClone(analysis),
      });
      await analyzeCompany(current, "ai");
      state.parse.mockResolvedValueOnce({
        status: "completed",
        output_parsed: structuredClone(before.plans[0].content),
      });
      state.parse.mockResolvedValueOnce({ status: "completed", output_parsed: { findings: [] } });
      await generatePlan(current, current.analysis!.candidates[0], "ai");
    }
    expect(state.parse).toHaveBeenCalledTimes(6);
    const requests = state.parse.mock.calls.map((args) => args[0]);
    for (let index = 0; index < 3; index++)
      expect(requests[index].input).toEqual(requests[index + 3].input);
    expect(JSON.stringify(requests)).not.toContain(sentinel);
    expect(JSON.stringify(requests)).not.toContain("companyContacts");
  });
});
