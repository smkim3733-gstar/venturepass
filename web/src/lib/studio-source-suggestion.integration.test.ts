import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import { emptyProfile, type SourceDocument, type StudioCase } from "./studio-schema";
import type {
  SourceSuggestionPreviewInput,
  SourceSuggestionsPreview,
  SourceSuggestionTarget,
} from "./studio-source-suggestion-types";
import { buildSourceLocationMetadata, pageSourceLocationSegments } from "./studio-source-location";
import { sourceIntakeResultText } from "./studio-source-intake-types";
import { withVentureInputCompanyLock } from "./venturein-input-lock";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  store: null as StudioStore | null,
  external: vi.fn(() => {
    throw new Error("No external activity in synthetic suggestions tests");
  }),
}));
vi.mock("./studio-storage", async (original) => ({
  ...(await original<typeof import("./studio-storage")>()),
  getStudioStore: () => state.store!,
}));
vi.mock("./venturein-runner", () => ({ stopVentureSession: state.external }));
vi.mock("openai", () => ({
  default: class {
    constructor() {
      state.external();
    }
  },
  toFile: state.external,
}));
import { POST } from "@/app/api/studio/cases/[caseId]/source-suggestions/preview/route";
import { PATCH } from "@/app/api/studio/cases/[caseId]/route";

let directory: string, caseId: string;
const store = () => state.store!;
const current = () => store().get(caseId);
const context = () => ({ params: Promise.resolve({ caseId }) });
const originalText =
  "재무상태표\n회사명: 합성새회사\n사업자등록번호: 123-45-67890\n업종: 소프트웨어 개발\n납입자본금: 123,000원\n결산월: 12월";
const review = () => [];
function database<T>(read: (db: DatabaseSync) => T) {
  const db = new DatabaseSync(join(directory, "studio.sqlite"));
  try {
    return read(db);
  } finally {
    db.close();
  }
}
function row() {
  return database((db) =>
    db.prepare("SELECT body, revision, evidence_revision FROM studio_cases WHERE id=?").get(caseId),
  );
}
function replace(company: StudioCase) {
  database((db) =>
    db.prepare("UPDATE studio_cases SET body=? WHERE id=?").run(JSON.stringify(company), caseId),
  );
}
function source(text = originalText): SourceDocument {
  const now = new Date().toISOString();
  const entry: SourceDocument = {
    id: randomUUID(),
    name: "합성 자료",
    kind: "other",
    text,
    originalName: null,
    mimeType: null,
    extraction: "manual",
    warnings: [],
    createdAt: now,
    updatedAt: now,
  };
  store().mutate(caseId, { action: "source", revision: current().revision, source: entry }, review);
  return current().sources.find((item) => item.id === entry.id)!;
}
function request(
  input: unknown,
  options: {
    headers?: Record<string, string>;
    query?: string;
    method?: string;
    path?: string;
  } = {},
) {
  return new Request(
    `http://localhost:3000/api/studio/cases/${caseId}${options.path ?? "/source-suggestions/preview"}${options.query ?? ""}`,
    {
      method: options.method ?? "POST",
      headers: {
        origin: "http://localhost:3000",
        "content-type": "application/json",
        ...options.headers,
      },
      body: typeof input === "string" ? input : JSON.stringify(input),
    },
  );
}
function previewInput(entry: SourceDocument): SourceSuggestionPreviewInput {
  return {
    revision: current().revision,
    sourceId: entry.id,
    basis: { kind: "source-text", sourceUpdatedAt: entry.updatedAt },
  };
}
async function preview(input: SourceSuggestionPreviewInput) {
  const response = await POST(request(input), context());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  return response.json() as Promise<SourceSuggestionsPreview>;
}
function adoption(
  value: SourceSuggestionsPreview,
  targets: SourceSuggestionTarget[] = ["companyName"],
) {
  return {
    action: "adopt-source-suggestions" as const,
    revision: current().revision,
    clientRequestId: randomUUID(),
    binding: value.binding,
    reviewed: true as const,
    selections: targets.map((target) => {
      const candidate = value.candidates.find((item) => item.target === target)!;
      return { candidateId: candidate.id, target, expectedCurrentValue: candidate.currentValue };
    }),
  };
}
function patch(input: unknown, options: Parameters<typeof request>[1] = {}) {
  return PATCH(request(input, { method: "PATCH", path: "", ...options }), context());
}
function locatedIntake() {
  let response = store().createSourceIntakeBatch(caseId, {
    action: "create",
    revision: current().revision,
    clientRequestId: randomUUID(),
    files: [
      {
        clientFileId: randomUUID(),
        originalName: "synthetic.txt",
        sizeBytes: Buffer.byteLength(originalText),
        kind: "other",
      },
    ],
  });
  let item = response.company.sourceIntakes.at(-1)!;
  response = store().storeSourceIntakeOriginal(
    caseId,
    item.id,
    {
      revision: current().revision,
      clientRequestId: randomUUID(),
      expectedItemVersion: item.version,
    },
    { name: "synthetic.txt", mimeType: "text/plain", buffer: Buffer.from(originalText) },
  );
  item = response.item!;
  const begun = store().beginSourceIntakeAttempt(
    caseId,
    {
      action: "run-next",
      revision: current().revision,
      clientRequestId: randomUUID(),
      itemId: item.id,
      expectedItemVersion: item.version,
      engine: "local-document",
    },
    "local-document",
  );
  const running = begun.response.item!;
  const content = { kind: "pages" as const, pages: [{ pageNumber: 1, text: originalText }] };
  const text = sourceIntakeResultText(content);
  response = store().finishSourceIntakeAttempt(
    caseId,
    {
      revision: begun.response.company.revision,
      itemId: running.id,
      itemVersion: running.version,
      attemptId: begun.attemptId!,
    },
    {
      status: "completed",
      content,
      warnings: [],
      locations: buildSourceLocationMetadata(
        text,
        pageSourceLocationSegments(content.pages, "pdf-page"),
      ),
    },
  );
  item = response.item!;
  return {
    item,
    input: {
      revision: current().revision,
      sourceId: item.sourceId,
      basis: { kind: "intake-result" as const, itemId: item.id, resultId: item.result!.id },
    },
  };
}
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "venture-source-suggestions-test-"));
  state.store = new StudioStore(directory);
});
beforeEach(() => {
  vi.clearAllMocks();
  caseId = store().create({
    ...emptyProfile(),
    companyName: "합성 기존회사",
    businessNumber: "1234567890",
  }).id;
});
afterEach(() => {
  expect(state.external).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
afterAll(() => {
  state.store?.close();
  const delta = relative(resolve(tmpdir()), resolve(directory));
  if (
    isAbsolute(delta) ||
    delta.startsWith("..") ||
    !delta.startsWith("venture-source-suggestions-test-")
  )
    throw new Error("Unsafe synthetic cleanup");
  rmSync(directory, { recursive: true, force: true });
});

describe("자료 제안 실제 SQLite/API의 읽기와 명시 채택", { timeout: 60_000 }, () => {
  it("조회는 DB에 쓰지 않고 정확 구간만 반환하며 수기 페이지를 구조 좌표로 승격하지 않는다", async () => {
    const entry = source(`[페이지 9]\n${originalText}`),
      before = row();
    const result = await preview(previewInput(entry));
    expect(row()).toEqual(before);
    expect(result.identity.status).toBe("matched");
    expect(result.candidates.length).toBeGreaterThan(4);
    for (const candidate of result.candidates) {
      expect(entry.text.slice(candidate.start, candidate.end)).toBe(candidate.quote);
      expect(candidate.coordinate).toBeNull();
    }
    expect(result.binding.locationsSha256).toBeNull();
  });
  it("사용자가 선택한 값만 채택하고 원고/단계/기관 결과를 생성하지 않는다", async () => {
    const entry = source(),
      value = await preview(previewInput(entry)),
      before = current();
    const response = await patch(adoption(value, ["companyName", "sourceKind"]));
    expect(response.status).toBe(200);
    const saved = current();
    expect(saved.profile.companyName).toBe("합성새회사");
    expect(saved.profile.paidInCapital).toBe(before.profile.paidInCapital);
    expect(saved.sources[0]).toMatchObject({
      kind: "finance",
      text: entry.text,
      extraction: "manual",
    });
    expect(saved.sourceSuggestionAdoptions).toHaveLength(1);
    expect(saved.sourceSuggestionAdoptions[0].selections.map((item) => item.target)).toEqual([
      "companyName",
      "sourceKind",
    ]);
    expect(saved.stage).toBe(before.stage);
    expect(saved.stageHistory).toEqual(before.stageHistory);
    expect(saved.plans).toEqual(before.plans);
    expect(saved.agencyRecords).toEqual(before.agencyRecords);
  });
  it("응답 유실과 재시작 후 같은 nonce는 중복 저장하지 않으며 다른 payload는 거부한다", async () => {
    const entry = source(),
      value = await preview(previewInput(entry)),
      input = adoption(value);
    expect((await patch(input)).status).toBe(200);
    const saved = row();
    store().close();
    state.store = new StudioStore(directory);
    expect((await patch(input)).status).toBe(200);
    expect(row()).toEqual(saved);
    expect(
      (
        await patch({
          ...input,
          selections: [{ ...input.selections[0], expectedCurrentValue: "다른값" }],
        })
      ).status,
    ).toBe(409);
    expect(row()).toEqual(saved);
  });
  it("외부 회사 sourceId와 basis를 현재 회사에 사용할 수 없다", async () => {
    const foreign = source(),
      foreignId = caseId;
    caseId = store().create({ ...emptyProfile(), companyName: "다른 합성회사" }).id;
    const before = row();
    expect(
      (await POST(request({ ...previewInput(foreign), revision: current().revision }), context()))
        .status,
    ).toBe(404);
    expect(row()).toEqual(before);
    expect(store().get(foreignId).sourceSuggestionAdoptions).toEqual([]);
  });
  it("pending 등록자료는 본문 근거가 아니며 explicit result 경로를 요구한다", async () => {
    const entry = source();
    const company = current();
    company.sources[0] = { ...entry, text: "", extraction: "pending" };
    replace(company);
    expect((await POST(request(previewInput(company.sources[0])), context())).status).toBe(409);
  });
  it("기업 번호 불일치는 기업정보 채택을 차단하지만 자료 종류의 명시 채택은 분리한다", async () => {
    const entry = source(originalText.replace("123-45-67890", "987-65-43210")),
      value = await preview(previewInput(entry));
    expect(value.profileAllowed).toBe(false);
    expect(value.identity.status).toBe("mismatch");
    const before = row();
    expect((await patch(adoption(value))).status).toBe(409);
    expect(row()).toEqual(before);
    expect((await patch(adoption(value, ["sourceKind"]))).status).toBe(200);
    expect(current().profile.companyName).toBe("합성 기존회사");
  });
  it("같은 revision의 원문 변조도 SHA binding으로 채택 전체를 거부한다", async () => {
    const entry = source(),
      value = await preview(previewInput(entry)),
      input = adoption(value);
    const company = current();
    company.sources[0].text = entry.text.replace("합성새회사", "합성다회사");
    replace(company);
    const before = row();
    expect((await patch(input)).status).toBe(409);
    expect(row()).toEqual(before);
  });
  it("현재 profile 값 변경·stale revision·공식 입력 회사 잠금을 모두 보존한다", async () => {
    const entry = source(),
      value = await preview(previewInput(entry)),
      input = adoption(value),
      before = row();
    await withVentureInputCompanyLock(caseId, async () => {
      expect((await patch(input)).status).toBe(409);
    });
    expect(row()).toEqual(before);
    store().mutate(
      caseId,
      {
        action: "profile",
        revision: current().revision,
        profile: { ...current().profile, companyName: "다른 현재값" },
      },
      review,
    );
    const changed = row();
    expect((await patch(input)).status).toBe(409);
    expect((await patch({ ...input, revision: current().revision })).status).toBe(409);
    expect(row()).toEqual(changed);
  });
  it("정확 미검토 result 페이지를 연결하되 기업정보만 채택해도 본문 검토는 완료되지 않는다", async () => {
    const { item, input } = locatedIntake(),
      before = row();
    const value = await preview(input);
    expect(row()).toEqual(before);
    expect(value.binding.locationsSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(value.candidates.every((candidate) => candidate.coordinate?.kind === "pdf-page")).toBe(
      true,
    );
    expect((await patch(adoption(value))).status).toBe(200);
    const saved = current();
    expect(saved.sources.find((entry) => entry.id === item.sourceId)).toMatchObject({
      extraction: "pending",
      text: "",
    });
    expect(saved.sourceIntakes[0]).toMatchObject({
      phase: "awaiting_review",
      adoption: null,
      result: { reviewStatus: "unreviewed" },
    });
    expect(saved.analysis).toBeNull();
    expect(saved.plans).toEqual([]);
    expect(saved.sourceSuggestionAdoptions[0].selections[0].coordinate).toEqual({
      kind: "pdf-page",
      pageNumber: 1,
    });
  });
  it("동일 크기 원본 변조를 preview 이후 채택 전에 거부한다", async () => {
    const { item, input } = locatedIntake(),
      value = await preview(input),
      requestBody = adoption(value),
      before = row();
    const file = join(directory, "originals", caseId, `${item.sourceId}.bin`);
    const bytes = Buffer.from(originalText);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(file, bytes);
    expect((await patch(requestBody)).status).toBe(409);
    expect(row()).toEqual(before);
  });
  it("같은 result ID의 위치 메타 변경도 새 제안 없이 채택하지 않는다", async () => {
    const { input } = locatedIntake(),
      value = await preview(input),
      body = adoption(value);
    const company = current();
    company.sourceIntakes[0].result!.locations!.coverage = "partial";
    replace(company);
    const before = row();
    expect((await patch(body)).status).toBe(409);
    expect(row()).toEqual(before);
  });
  it.each([
    ["Origin", { origin: "https://outside.invalid" }, "", 403],
    ["query", {}, "?source=other", 400],
    ["MIME", { "content-type": "text/plain" }, "", 415],
    ["size", { "content-length": "8193" }, "", 413],
  ] as Array<[string, Record<string, string>, string, number]>)(
    "preview %s 경계를 거부하고 저장하지 않는다",
    async (_, headers, query, expected) => {
      const entry = source(),
        before = row();
      expect((await POST(request(previewInput(entry), { headers, query }), context())).status).toBe(
        expected,
      );
      expect(row()).toEqual(before);
    },
  );
  it("preview streamed 8KiB·server metadata·직접본문·잘못된 JSON/UUID를 거부한다", async () => {
    const entry = source(),
      input = previewInput(entry),
      before = row();
    for (const invalid of [
      { ...input, text: "사용자 바꾼본문" },
      { ...input, basis: { ...input.basis, locations: [] } },
      { ...input, sourceId: "invalid" },
    ])
      expect((await POST(request(invalid), context())).status).toBe(400);
    expect((await POST(request("{"), context())).status).toBe(400);
    expect((await POST(request(JSON.stringify(input) + " ".repeat(8192)), context())).status).toBe(
      413,
    );
    expect(row()).toEqual(before);
  });
  it("채택은 명시 확인·정확 candidate·단일 target·엄격 schema를 요구한다", async () => {
    const entry = source(),
      value = await preview(previewInput(entry)),
      input = adoption(value),
      before = row();
    for (const bad of [
      { ...input, reviewed: false },
      { ...input, recordedAt: new Date().toISOString() },
      { ...input, selections: [...input.selections, ...input.selections] },
      { ...input, selections: [] },
    ])
      expect((await patch(bad)).status).toBe(400);
    expect(
      (
        await patch({
          ...input,
          selections: [{ ...input.selections[0], candidateId: "0".repeat(64) }],
        })
      ).status,
    ).toBe(409);
    expect((await patch(input, { query: "?force=1" })).status).toBe(400);
    expect(row()).toEqual(before);
  });
});
