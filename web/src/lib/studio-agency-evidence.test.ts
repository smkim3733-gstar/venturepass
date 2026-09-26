import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyProfile, type SourceDocument, type StudioCase } from "./studio-schema";
import { StudioStore } from "./studio-storage";
import { inspectAgencyEvidence } from "./studio-agency-evidence";

vi.mock("server-only", () => ({}));
const holder = vi.hoisted(() => ({ store: undefined as StudioStore | undefined }));
vi.mock("./studio-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./studio-storage")>()),
  getStudioStore: () => holder.store!,
}));
import { GET } from "@/app/api/studio/cases/[caseId]/agency-records/evidence/route";
import { GET as downloadOriginal } from "@/app/api/studio/cases/[caseId]/sources/[sourceId]/route";

describe("기관 기록의 원본 현재 상태 — 독립 저장소", () => {
  let directory: string;
  let store: StudioStore;
  let company: StudioCase;
  let source: SourceDocument;
  let recordId: string;
  const bytes = Buffer.from("synthetic agency evidence");
  const file = () => join(directory, "originals", company.id, `${source.id}.bin`);
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "venture-agency-evidence-test-"));
    store = new StudioStore(directory);
    holder.store = store;
    company = store.create({ ...emptyProfile(), companyName: "기관 증빙 시험기업" });
    const now = new Date().toISOString();
    source = {
      id: randomUUID(),
      name: "원문 보관 자료",
      kind: "other",
      text: "",
      originalName: "notice.pdf",
      mimeType: "application/pdf",
      extraction: "pending",
      warnings: [],
      createdAt: now,
      updatedAt: now,
    };
    company = store.addUpload(company.id, company.revision, source, bytes);
    recordId = randomUUID();
    // Set up a historical receipt; creation/ownership is tested separately through the mutation API.
    const historical = {
      id: recordId,
      clientRequestId: randomUUID(),
      inputDigest: "1".repeat(64),
      kind: "request",
      requestRecordId: recordId,
      requestVersionId: recordId,
      previousVersionId: null,
      version: 1,
      origin: "manual",
      recordedAt: now,
      institution: "가상 기관",
      title: "가상 보완 요청",
      body: "서류 내용을 직접 확인해 기록한 합성 문구",
      occurredOn: "2026-09-25",
      dueOn: "2026-10-02",
      dueNote: "시험 통보의 기한",
      note: "",
      responseStatus: null,
      evidence: [
        {
          sourceId: source.id,
          sourceName: source.name,
          originalName: source.originalName,
          mimeType: source.mimeType,
          sizeBytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          capturedAt: now,
          sourceUpdatedAt: now,
        },
      ],
    };
    const db = new DatabaseSync(join(directory, "studio.sqlite"));
    try {
      db.prepare("UPDATE studio_cases SET body = ? WHERE id = ?").run(
        JSON.stringify({ ...company, agencyRecords: [historical] }),
        company.id,
      );
    } finally {
      db.close();
    }
    company = store.get(company.id);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    holder.store = undefined;
    store.close();
    const target = resolve(directory);
    const boundary = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(boundary) ||
      boundary.startsWith("..") ||
      !basename(target).startsWith("venture-agency-evidence-test-")
    )
      throw new Error("Unsafe cleanup");
    rmSync(target, { recursive: true, force: true });
  });
  const inspect = () => inspectAgencyEvidence(store, company.id, recordId, company.revision);
  const request = (
    query = `recordId=${recordId}&revision=${company.revision}`,
    headers: Record<string, string> = {},
  ) =>
    GET(
      new Request(
        `http://127.0.0.1:3000/api/studio/cases/${company.id}/agency-records/evidence?${query}`,
        { headers },
      ),
      { params: Promise.resolve({ caseId: company.id }) },
    );

  it("pending 원본의 동일성만 확인하고 기록·분석·단계를 변경하지 않는다", async () => {
    const before = store.get(company.id);
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const result = await response.json();
    expect(result).toEqual({
      caseRevision: company.revision,
      recordId,
      observedAt: expect.any(String),
      evidence: [{ sourceId: source.id, state: "matched" }],
    });
    expect(Number.isFinite(Date.parse(result.observedAt))).toBe(true);
    expect(store.get(company.id)).toEqual(before);
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      source.originalName!,
      source.name,
      bytes.toString(),
      directory,
      "sha256",
      "buffer",
    ])
      expect(serialized).not.toContain(forbidden);
  });

  it("현재 원본 다운로드도 안전한 reader를 사용하며 내용·다운로드 헤더를 유지한다", async () => {
    const response = await downloadOriginal(
      new Request(`http://127.0.0.1:3000/api/studio/cases/${company.id}/sources/${source.id}`),
      { params: Promise.resolve({ caseId: company.id, sourceId: source.id }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });

  it("미확인 확인서 통보의 증빙 일치는 발급·유효기간이나 단계를 확정하지 않는다", async () => {
    const before = store.get(company.id);
    company = store.mutate(
      company.id,
      {
        action: "append-agency-record",
        revision: company.revision,
        clientRequestId: randomUUID(),
        record: {
          kind: "notice",
          institution: "가상 기관",
          title: "담당자가 기록한 확인서 안내",
          body: "확인서 관련 안내를 수동 전사한 합성 기록",
          occurredOn: "",
          note: "",
          sourceIds: [source.id],
          details: {
            category: "certificate",
            certificateNumber: "",
            issuedOn: "",
            validFrom: "",
            validUntil: "",
            statusText: "",
          },
        },
      },
      () => [],
    );
    const notice = company.agencyRecords.at(-1)!;
    recordId = notice.id;
    const snapshot = structuredClone(company);
    const result = await request();
    expect(result.status).toBe(200);
    expect((await result.json()).evidence).toEqual([{ sourceId: source.id, state: "matched" }]);
    expect(store.get(company.id)).toEqual(snapshot);
    expect(notice).not.toHaveProperty("requestRecordId");
    expect(notice).toMatchObject({
      occurredOn: "",
      details: { certificateNumber: "", issuedOn: "", validFrom: "", validUntil: "" },
    });
    expect(company.agencyRecords[0]).toEqual(before.agencyRecords[0]);
    expect(company.stage).toBe(before.stage);
    expect(company.stageHistory).toEqual(before.stageHistory);
    expect(company.plans).toEqual(before.plans);
  });

  it("통보 정정 전후의 증빙을 각각 확인하고 원본 변경 뒤에도 과거 기록을 보존한다", () => {
    const notice = {
      institution: "가상 기관",
      title: "결과 안내",
      body: "합성 통보 원문",
      occurredOn: "",
      note: "",
      sourceIds: [source.id],
      details: { category: "decision" as const, decisionText: "", notifiedOn: "", reasons: "" },
    };
    company = store.mutate(
      company.id,
      {
        action: "append-agency-record",
        revision: company.revision,
        clientRequestId: randomUUID(),
        record: { kind: "notice", ...notice },
      },
      () => [],
    );
    const firstId = company.agencyRecords.at(-1)!.id;
    company = store.mutate(
      company.id,
      {
        action: "append-agency-record",
        revision: company.revision,
        clientRequestId: randomUUID(),
        record: {
          kind: "notice-correction",
          ...notice,
          noticeRecordId: firstId,
          previousVersionId: firstId,
          note: "담당자 메모만 정정",
        },
      },
      () => [],
    );
    const saved = structuredClone(company);
    const ids = [firstId, company.agencyRecords.at(-1)!.id];
    for (const id of ids)
      expect(inspectAgencyEvidence(store, company.id, id, company.revision).evidence).toEqual([
        { sourceId: source.id, state: "matched" },
      ]);
    writeFileSync(file(), Buffer.alloc(bytes.length, 120));
    for (const id of ids)
      expect(inspectAgencyEvidence(store, company.id, id, company.revision).evidence).toEqual([
        { sourceId: source.id, state: "changed" },
      ]);
    expect(store.get(company.id)).toEqual(saved);
    // Multiple Windows path/link inspections for two immutable versions can exceed Vitest's 5s default.
  }, 20_000);

  it("다운로드는 증빙 확인 후 연결된 hardlink도 거부하며 원본 바이트를 반환하지 않는다", async () => {
    expect(inspect().evidence[0].state).toBe("matched");
    linkSync(file(), join(directory, "linked-after-check.bin"));
    const response = await downloadOriginal(
      new Request(`http://127.0.0.1:3000/api/studio/cases/${company.id}/sources/${source.id}`),
      { params: Promise.resolve({ caseId: company.id, sourceId: source.id }) },
    );
    expect(response.status).toBe(409);
    const output = await response.text();
    expect(output).toContain("UNSAFE_ORIGINAL_PATH");
    expect(output).not.toContain(directory);
    expect(output).not.toContain(bytes.toString());
  });

  it("동일 크기 바이트 교체를 changed로 표시하고 과거 SHA를 보존한다", () => {
    const saved = structuredClone(company.agencyRecords);
    writeFileSync(file(), Buffer.alloc(bytes.length, 97));
    expect(inspect().evidence).toEqual([{ sourceId: source.id, state: "changed" }]);
    expect(store.get(company.id).agencyRecords).toEqual(saved);
  });

  it("자료 이름·본문을 수정하면 원본 스냅샷의 메타데이터 변경을 표시한다", () => {
    company = store.mutate(
      company.id,
      {
        action: "source",
        revision: company.revision,
        source: { ...source, name: "메모 수정 자료", text: "직접 확인한 내용" },
      },
      () => [],
    );
    expect(inspect().evidence[0].state).toBe("changed");
    expect(company.agencyRecords[0].evidence[0].sourceName).toBe(source.name);
  });

  it.each(["missing", "hardlink"])(
    "%s 원본은 unavailable로 처리하고 실패 경로를 노출하지 않는다",
    async (kind) => {
      if (kind === "missing") unlinkSync(file());
      else linkSync(file(), join(directory, "shared.bin"));
      const response = await request();
      expect(response.status).toBe(200);
      expect((await response.json()).evidence).toEqual([
        { sourceId: source.id, state: "unavailable" },
      ]);
    },
  );

  it("다른 회사의 기록 ID로는 원본을 읽지 않는다", () => {
    const other = store.create({ ...emptyProfile(), companyName: "다른 시험기업" });
    const reader = vi.spyOn(store, "originalForVentureInput");
    expect(() => inspectAgencyEvidence(store, other.id, recordId, other.revision)).toThrow(
      "기관 기록을 찾을 수 없습니다",
    );
    expect(reader).not.toHaveBeenCalled();
  });

  it("오래된 요청은 원본을 읽기 전에 409로 거부한다", async () => {
    const reader = vi.spyOn(store, "originalForVentureInput");
    expect((await request(`recordId=${recordId}&revision=0`)).status).toBe(409);
    expect(reader).not.toHaveBeenCalled();
  });

  it("읽는 동안 회사 버전이 변하면 혼합 결과 대신 전체 관측을 거부한다", async () => {
    const read = store.originalForVentureInput.bind(store);
    vi.spyOn(store, "originalForVentureInput").mockImplementationOnce((caseId, sourceId) => {
      const original = read(caseId, sourceId);
      store.mutate(
        company.id,
        { action: "stage", revision: company.revision, stage: "drafting" },
        () => [],
      );
      return original;
    });
    const response = await request();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "STALE_REVISION" });
  });

  it.each([
    "",
    "recordId=bad&revision=1",
    "recordId=ID&revision=-1",
    "recordId=ID&revision=1e0",
    "recordId=ID&revision=01",
    "recordId=ID&revision=9007199254740992",
    "recordId=ID&revision=1&revision=1",
    "recordId=ID&revision=1&sourceId=bad",
  ])("잘못되거나 주입된 query 거부: %s", async (query) => {
    const reader = vi.spyOn(store, "originalForVentureInput");
    expect((await request(query.replaceAll("ID", recordId))).status).toBe(400);
    expect(reader).not.toHaveBeenCalled();
  });

  it("외부 Origin과 외부 사이트 요청은 내용을 읽기 전 거부한다", async () => {
    const reader = vi.spyOn(store, "originalForVentureInput");
    expect((await request(undefined, { origin: "https://untrusted.example" })).status).toBe(403);
    expect((await request(undefined, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(reader).not.toHaveBeenCalled();
  });
});
