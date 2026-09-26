import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import { emptyProfile, type StudioCase, type SourceDocument } from "./studio-schema";
import {
  buildLocalResponseDraft,
  preparedResponseBody,
  type ResponsePreparationInput,
} from "./studio-response-preparation-types";
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
const store = () => state.store!;
const bytes = Buffer.from("%PDF-1.7\nsynthetic-response-original");
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
function fixture(next: StudioCase) {
  const db = new DatabaseSync(join(directory, "studio.sqlite"));
  db.prepare("UPDATE studio_cases SET body=? WHERE id=?").run(JSON.stringify(next), next.id);
  db.close();
  company = store().get(company.id);
}
function source(original = true, pending = false) {
  const now = new Date().toISOString();
  const value: SourceDocument = {
    id: randomUUID(),
    name: "합성 자료",
    kind: "technology",
    text: pending ? "" : "등록된 정확한 문장",
    originalName: original ? "synthetic.pdf" : null,
    mimeType: original ? "application/pdf" : null,
    extraction: pending ? "pending" : "manual",
    warnings: [],
    createdAt: now,
    updatedAt: now,
  };
  company = original
    ? store().addUpload(company.id, company.revision, value, bytes)
    : store().mutate(
        company.id,
        { action: "source", revision: company.revision, source: value },
        () => [],
      );
  return company.sources.at(-1)!;
}
function input(selected?: SourceDocument): ResponsePreparationInput {
  const request = company.agencyRecords[0];
  return {
    preparationId: null,
    previousVersionId: null,
    requestRecordId: request.id,
    requestVersionId: request.id,
    title: "로컬 답변 준비",
    items: [
      {
        id: randomUUID(),
        requestQuote: "기술 근거를 설명해 주세요.",
        summary: "담당자 요약",
        planClaim: null,
        evidence: selected
          ? [
              {
                sourceId: selected.id,
                sourceUpdatedAt: selected.updatedAt,
                quote: selected.text,
                locator: "본문",
              },
            ]
          : [],
        gap: "추가 실험 근거 확보 필요",
        draft: "현재 자료에 기재된 설명이며 추가 확인이 필요합니다.",
      },
    ],
  };
}
const append = (preparation = input(), nonce: string = randomUUID()) => ({
  action: "append-response-preparation",
  revision: company.revision,
  clientRequestId: nonce,
  preparation,
});
function registration(nonce: string = randomUUID()) {
  const preparation = company.responsePreparations.at(-1)!;
  const response = company.agencyRecords.filter((record) => record.kind === "response").at(-1);
  return {
    action: "register-prepared-response",
    revision: company.revision,
    clientRequestId: nonce,
    preparationId: preparation.preparationId,
    preparationVersionId: preparation.id,
    previousResponseId: response?.id ?? null,
  };
}
async function patch(
  body: unknown,
  suffix = "",
  caseId = company.id,
  extraHeaders: Record<string, string> = {},
) {
  return PATCH(
    new Request(`http://localhost:3000/api/studio/cases/${caseId}${suffix}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...extraHeaders },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ caseId }) },
  );
}
async function save(body: unknown) {
  const response = await patch(body);
  expect(response.status).toBe(200);
  company = await response.json();
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "venture-response-test-"));
  state.store = new StudioStore(directory);
  company = store().create({ ...emptyProfile(), companyName: "합성 답변 회사" });
  company = store().mutate(
    company.id,
    {
      action: "append-agency-record",
      revision: company.revision,
      clientRequestId: randomUUID(),
      record: {
        kind: "request",
        institution: "합성 기관",
        title: "보완 요청",
        body: "기술 근거를 설명해 주세요.",
        occurredOn: "",
        dueOn: "",
        dueNote: "미확인",
        note: "",
        sourceIds: [],
      },
    },
    () => [],
  );
  state.external.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  store().close();
  const boundary = relative(resolve(tmpdir()), resolve(directory));
  if (!/^venture-response-test-[^\\/]+$/.test(boundary))
    throw new Error("Unsafe synthetic cleanup");
  rmSync(directory, { recursive: true, force: true });
  expect(state.external).not.toHaveBeenCalled();
});

describe("보완 답변 준비 API/합성 SQLite", () => {
  it("legacy 읽기와 순수 보조는 저장·발송·검토 완료를 만들지 않는다", () => {
    const old = JSON.parse(JSON.stringify(company));
    delete old.responsePreparations;
    fixture(old);
    expect(company.responsePreparations).toEqual([]);
    const before = structuredClone(company);
    const text = buildLocalResponseDraft(input().items[0]);
    expect(text).toContain("미검토 답변 초안");
    expect(text).toContain("근거 자료 미연결");
    expect(store().get(company.id)).toEqual(before);
  });
  it("준비 저장과 기관 답변 등록을 분리하며 정확한 draft와 출처만 저장한다", async () => {
    const selected = source();
    const body = append(input(selected));
    const before = structuredClone(company);
    await save(body);
    const prepared = company.responsePreparations[0];
    expect(prepared.sourceSnapshots[0].original?.sha256).toBe(hash(bytes));
    expect(prepared.reviewStatus).toBe("unreviewed");
    expect(company.agencyRecords).toEqual(before.agencyRecords);
    await save(registration());
    const response = company.agencyRecords.at(-1)!;
    expect(response).toMatchObject({
      kind: "response",
      responseStatus: "draft",
      occurredOn: "",
      body: preparedResponseBody(prepared),
      preparedFrom: { preparationId: prepared.id, preparationVersionId: prepared.id },
    });
    for (const key of ["stage", "stageHistory", "sources", "plans", "tasks", "analysis"] as const)
      expect(company[key]).toEqual(before[key]);
    expect(company.responsePreparations[0]).toEqual(prepared);
  });
  it("재시작·동일 nonce 재생은 중복 기록을 만들지 않고 다른 내용은 거부한다", async () => {
    const body = append();
    await save(body);
    const prepared = structuredClone(company);
    store().close();
    state.store = new StudioStore(directory);
    await save(body);
    expect(company).toEqual(prepared);
    expect(
      (await patch({ ...body, preparation: { ...body.preparation, title: "변경" } })).status,
    ).toBe(409);
    const register = registration();
    await save(register);
    const registered = structuredClone(company);
    store().close();
    state.store = new StudioStore(directory);
    await save(register);
    expect(company).toEqual(registered);
    expect((await patch(registration())).status).toBe(409);
    expect((await patch({ ...register, previousResponseId: randomUUID() })).status).toBe(409);
  });
  it("정정은 이전 본문을 보존하고 최신 준비와 최신 답변 부모만 채택한다", async () => {
    const firstInput = input();
    await save(append(firstInput));
    const first = company.responsePreparations[0];
    await save(registration());
    await save(
      append({
        ...firstInput,
        preparationId: first.id,
        previousVersionId: first.id,
        items: [{ ...firstInput.items[0], draft: "정정한 미검토 설명" }],
      }),
    );
    expect(company.responsePreparations[0]).toEqual(first);
    expect((await patch({ ...registration(), preparationVersionId: first.id })).status).toBe(409);
    expect((await patch({ ...registration(), previousResponseId: null })).status).toBe(409);
    await save(registration());
    expect(company.agencyRecords.filter((record) => record.kind === "response")).toHaveLength(2);
  });
  it.each(["quote", "request", "source", "timestamp", "pending"])(
    "잘못된 %s 연결은 원본을 열기 전에 거부한다",
    async (invalid) => {
      const selected = source(true, invalid === "pending");
      const value = input(selected);
      if (invalid === "quote") value.items[0].requestQuote = "요청에 없는 문장";
      if (invalid === "request") value.requestRecordId = randomUUID();
      if (invalid === "source") value.items[0].evidence[0].sourceId = randomUUID();
      if (invalid === "timestamp") value.items[0].evidence[0].sourceUpdatedAt = "과거";
      if (invalid === "pending") value.items[0].evidence[0].quote = "미추출 주장을 인용";
      const spy = vi.spyOn(store(), "originalForVentureInput");
      const before = structuredClone(company);
      expect((await patch(append(value))).status).toBeGreaterThanOrEqual(400);
      expect(spy).not.toHaveBeenCalled();
      expect(store().get(company.id)).toEqual(before);
    },
  );
  it("미추출 원본은 빈 인용으로 보관하지만 진위·검토 상태를 높이지 않는다", async () => {
    const selected = source(true, true);
    await save(append(input(selected)));
    expect(company.responsePreparations[0].sourceSnapshots[0].extraction).toBe("pending");
    await save(registration());
    expect(company.agencyRecords.at(-1)).toMatchObject({ responseStatus: "draft" });
    expect(company.sources[0].extraction).toBe("pending");
  });
  it.each(["request", "source", "bytes"])(
    "등록 직전 %s 변경은 기관 답변을 만들지 않는다",
    async (changed) => {
      const selected = source();
      await save(append(input(selected)));
      if (changed === "request") {
        const root = company.agencyRecords[0];
        company = store().mutate(
          company.id,
          {
            action: "append-agency-record",
            revision: company.revision,
            clientRequestId: randomUUID(),
            record: {
              kind: "request-correction",
              requestRecordId: root.id,
              previousVersionId: root.id,
              institution: "합성 기관",
              title: "수정 요청",
              body: root.body,
              occurredOn: "",
              dueOn: "",
              dueNote: "",
              note: "",
              sourceIds: [],
            },
          },
          () => [],
        );
      } else if (changed === "source") {
        company = store().mutate(
          company.id,
          {
            action: "source",
            revision: company.revision,
            source: { ...selected, text: `${selected.text} 추가` },
          },
          () => [],
        );
      } else
        writeFileSync(
          join(directory, "originals", company.id, `${selected.id}.bin`),
          Buffer.alloc(bytes.length, 65),
        );
      const before = structuredClone(company);
      expect((await patch(registration())).status).toBe(409);
      expect(store().get(company.id)).toEqual(before);
    },
  );
  it("한 번 고정한 source는 삭제 및 기존 기관 기록 경로의 다른 SHA 재연결을 거부한다", async () => {
    const selected = source();
    await save(append(input(selected)));
    const before = structuredClone(company);
    expect(
      (await patch({ action: "delete-source", revision: company.revision, sourceId: selected.id }))
        .status,
    ).toBe(409);
    writeFileSync(
      join(directory, "originals", company.id, `${selected.id}.bin`),
      Buffer.alloc(bytes.length, 66),
    );
    const response = await patch({
      action: "append-agency-record",
      revision: company.revision,
      clientRequestId: randomUUID(),
      record: {
        kind: "request",
        institution: "합성 기관",
        title: "다른 기록",
        body: "새 요청",
        occurredOn: "",
        dueOn: "",
        dueNote: "",
        note: "",
        sourceIds: [selected.id],
      },
    });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("AGENCY_EVIDENCE_CHANGED");
    expect(store().get(company.id)).toEqual(before);
  });
  it("원본 재확인에서 변조가 발견되면 준비 버전도 저장하지 않는다", async () => {
    const selected = source();
    const reader = store().originalForVentureInput.bind(store());
    let reads = 0;
    vi.spyOn(store(), "originalForVentureInput").mockImplementation((id, sourceId) => {
      const result = reader(id, sourceId);
      if (++reads === 1)
        writeFileSync(
          join(directory, "originals", company.id, `${selected.id}.bin`),
          Buffer.alloc(bytes.length, 67),
        );
      return result;
    });
    const before = structuredClone(company);
    expect((await patch(append(input(selected)))).status).toBe(409);
    expect(store().get(company.id)).toEqual(before);
  });
  it("외부 origin·query·서버필드·발송 주입·회사 격리·CAS·잠금·본문 한도를 거부한다", async () => {
    const selected = source(false);
    const value = append(input(selected));
    const before = structuredClone(company);
    expect((await patch(value, "?extra=1")).status).toBe(400);
    expect((await patch(value, "", company.id, { Origin: "https://foreign.invalid" })).status).toBe(
      403,
    );
    expect(
      (await patch({ ...value, preparation: { ...value.preparation, reviewStatus: "reviewed" } }))
        .status,
    ).toBe(400);
    expect((await patch({ ...value, revision: company.revision + 1 })).status).toBe(409);
    expect((await patch(`${JSON.stringify(value)}${" ".repeat(256 * 1024)}`)).status).toBe(413);
    const other = store().create({ ...emptyProfile(), companyName: "다른 합성 회사" });
    expect((await patch({ ...value, revision: other.revision }, "", other.id)).status).toBe(404);
    await withVentureInputCompanyLock(company.id, async () =>
      expect((await patch(value)).status).toBe(409),
    );
    expect(store().get(company.id)).toEqual(before);
    await save(value);
    expect((await patch({ ...registration(), responseStatus: "reported-sent" })).status).toBe(400);
  });
  it("본문 초과·SQL 저장 실패는 전체 버전과 revision을 되돌린다", async () => {
    const value = input();
    value.items[0].draft = "가".repeat(20_000);
    const before = structuredClone(company);
    expect((await patch(append(value))).status).toBe(413);
    const db = new DatabaseSync(join(directory, "studio.sqlite"));
    db.exec(
      "CREATE TRIGGER synthetic_failure BEFORE UPDATE ON studio_cases BEGIN SELECT RAISE(ABORT,'synthetic'); END",
    );
    expect((await patch(append())).status).toBe(500);
    db.close();
    expect(store().get(company.id)).toEqual(before);
  });
}, 20_000);
