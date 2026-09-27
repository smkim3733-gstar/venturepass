import { createHash, randomUUID } from "node:crypto";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPreparationPackage } from "./studio-package";
import { PACKAGE_DOWNLOAD_NAME, packageLimits } from "./studio-package-types";
import {
  caseSchema,
  emptyProfile,
  sectionDefinitions,
  type SourceDocument,
  type StudioCase,
} from "./studio-schema";
import { exportPlanMarkdown } from "./studio-export";
vi.mock("server-only", () => ({}));
vi.mock("openai", () => ({
  default: class {
    constructor() {
      throw new Error("External AI must not run");
    }
  },
}));
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
let record: StudioCase;
let buffers: Map<string, Buffer>;
let currentEvidence: boolean;
let source: SourceDocument;
const fixed = "2026-09-25T01:00:00.000Z";
const sourceFixture = (overrides: Partial<SourceDocument> = {}): SourceDocument => ({
  id: randomUUID(),
  name: "선택한 합성 자료",
  kind: "technology",
  text: "합성 기술 설명을 확인합니다.",
  originalName: "같은이름.pdf",
  mimeType: "application/pdf",
  extraction: "local",
  warnings: [],
  createdAt: fixed,
  updatedAt: fixed,
  ...overrides,
});
const store = {
  get: vi.fn(() => structuredClone(record)),
  isPlanCurrent: vi.fn(() => currentEvidence),
  originalForVentureInput: vi.fn((_caseId: string, sourceId: string) => {
    const selected = record.sources.find((item) => item.id === sourceId)!;
    const buffer = Buffer.from(buffers.get(sourceId)!);
    return { source: structuredClone(selected), buffer, sha256: sha(buffer) };
  }),
};
const request = (sourceIds = [source.id]) => ({
  revision: record.revision,
  planId: record.plans[0].id,
  sourceIds,
});
beforeEach(() => {
  vi.clearAllMocks();
  source = sourceFixture();
  currentEvidence = true;
  buffers = new Map([[source.id, Buffer.from("%PDF synthetic test only")]]);
  record = caseSchema.parse({
    id: randomUUID(),
    profile: {
      ...emptyProfile(),
      companyName: "합성 묶음기업",
      financials: "PRIVATE_UNRELATED_PROFILE",
    },
    sources: [
      source,
      sourceFixture({ name: "PRIVATE_UNRELATED_SOURCE", text: "PRIVATE_UNRELATED_BODY" }),
    ],
    analysis: null,
    selectedCandidateId: "candidate-1",
    tasks: [
      {
        id: randomUUID(),
        title: "PRIVATE_UNRELATED_TASK",
        notes: "PRIVATE_UNRELATED_NOTES",
        category: "payment",
        dueDate: "",
        status: "pending",
      },
    ],
    stage: "drafting",
    revision: 4,
    createdAt: fixed,
    updatedAt: fixed,
    plans: [
      {
        id: randomUUID(),
        version: 1,
        generatedAt: fixed,
        mode: "manual",
        candidateId: "candidate-1",
        sourceRevision: 3,
        confirmedAt: fixed,
        content: {
          title: "합성 원고",
          summary: "현재 내용",
          sections: sectionDefinitions.map((definition) => ({
            ...definition,
            content: "합성 기술 설명을 확인합니다.",
            needsConfirmation: false,
            evidence: [{ sourceId: source.id, quote: source.text, locator: "등록 본문" }],
          })),
          actionItems: ["실제 원본 대조"],
          interviewQuestions: [],
        },
        review: [],
      },
    ],
  });
});
afterEach(() => vi.restoreAllMocks());
describe("preparation package buffers and disclosure boundaries", () => {
  it.each([
    "semantic-evidence",
    "contradiction",
    "timeline",
    "financial-plan",
    "fact-vs-plan",
    "confirmation",
    "custom-error",
  ])(
    "preserves stored %s findings even when current rules and user confirmation are clear",
    async (category) => {
      const finding = {
        id: "stored-review",
        severity: category === "custom-error" ? ("error" as const) : ("warning" as const),
        category,
        message: "STORED_SEMANTIC_REVIEW_MESSAGE",
        action: "원자료와 다시 대조해 주세요.",
        sectionKey: "solution",
        sourceIds: [source.id],
      };
      record.plans[0].review = [finding];
      const result = await buildPreparationPackage(store, record.id, request());
      expect(result.manifest.plan.draft).toBe(true);
      expect(result.manifest.plan.draftReasons).toContain(
        category === "custom-error"
          ? "STORED_REVIEW_ERROR"
          : category === "confirmation"
            ? "STORED_REVIEW_CONFIRMATION"
            : "STORED_SEMANTIC_FINDINGS",
      );
      const zip = await JSZip.loadAsync(result.buffer);
      expect(await zip.file("plan.md")!.async("string")).toContain("DRAFT");
      const review = await zip.file("review.md")!.async("string");
      expect(review).toContain("원고 저장 당시 검토 의견");
      expect(review).toContain(finding.message);
      expect(review).toContain(finding.action);
      expect(record.plans[0].review).toEqual([finding]);
    },
  );
  it("creates readable ZIP entries whose manifest hashes bind exact archived bytes", async () => {
    const result = await buildPreparationPackage(store, record.id, request());
    expect(result.fileName).toBe(PACKAGE_DOWNLOAD_NAME);
    expect(result.manifest.plan).toMatchObject({
      draft: false,
      currentEvidence: true,
      latestVersion: true,
    });
    const zip = await JSZip.loadAsync(result.buffer, { checkCRC32: true });
    expect(Object.keys(zip.files).sort()).toEqual(
      [
        "evidence.json",
        "manifest.json",
        "manifest.md",
        `originals/${source.id}.pdf`,
        "plan.md",
        "review.md",
      ].sort(),
    );
    for (const file of result.manifest.files) {
      const bytes = await zip.file(file.path)!.async("nodebuffer");
      expect(bytes.length).toBe(file.sizeBytes);
      expect(sha(bytes)).toBe(file.sha256);
    }
    const texts = (
      await Promise.all(
        ["plan.md", "review.md", "evidence.json", "manifest.json", "manifest.md"].map((path) =>
          zip.file(path)!.async("string"),
        ),
      )
    ).join("\n");
    expect(texts).not.toContain("PRIVATE_UNRELATED");
    expect(texts).toContain("기관 접수");
    expect(store.originalForVentureInput).toHaveBeenCalledTimes(2);
  });
  it("preserves the legacy Markdown list while the package list is explicitly filtered", () => {
    expect(exportPlanMarkdown(record, record.plans[0], true)).toContain("PRIVATE_UNRELATED_SOURCE");
    const filtered = exportPlanMarkdown(record, record.plans[0], true, { sourceListIds: [] });
    expect(filtered).not.toContain("PRIVATE_UNRELATED_SOURCE");
    expect(filtered).toContain(source.name);
  });
  it.each(["pdf", "exe", "zip"])(
    "uses UUID paths even for duplicate original names with extension %s",
    async (extension) => {
      source.originalName = `같은이름.${extension}`;
      record.sources[0] = structuredClone(source);
      const second = sourceFixture({ originalName: source.originalName });
      record.sources.push(second);
      buffers.set(second.id, Buffer.from("other bytes"));
      const result = await buildPreparationPackage(
        store,
        record.id,
        request([source.id, second.id]),
      );
      expect(new Set(result.manifest.originals.map((item) => item.path)).size).toBe(2);
      expect(
        result.manifest.originals.every((item) =>
          /^originals\/[a-f0-9-]+\.(pdf|bin)$/.test(item.path),
        ),
      ).toBe(true);
    },
  );
  it("marks older versions separately from current evidence, preserving original confirmation metadata", async () => {
    record.plans.push({ ...structuredClone(record.plans[0]), id: randomUUID(), version: 2 });
    const result = await buildPreparationPackage(store, record.id, request([]));
    expect(result.manifest.plan).toMatchObject({
      currentEvidence: true,
      latestVersion: false,
      confirmedAt: fixed,
      draft: true,
      draftReasons: ["OLDER_PLAN_VERSION"],
    });
  });
  it.each(["unreviewed", "stale", "confirmation", "missing", "pending"])(
    "marks draft for %s without changing the stored plan",
    async (condition) => {
      if (condition === "unreviewed") record.plans[0].confirmedAt = null;
      if (condition === "stale") currentEvidence = false;
      if (condition === "confirmation")
        record.plans[0].content.sections[0].needsConfirmation = true;
      if (condition === "missing") record.sources = [];
      if (condition === "pending") {
        record.sources[0].extraction = "pending";
        record.sources[0].text = "";
      }
      const before = structuredClone(record);
      const result = await buildPreparationPackage(store, record.id, request([]));
      expect(result.manifest.plan.draft).toBe(true);
      expect(record).toEqual(before);
    },
  );
  it("rejects too many, duplicate, foreign and non-original selections", async () => {
    await expect(
      buildPreparationPackage(
        store,
        record.id,
        request(Array.from({ length: 11 }, () => randomUUID())),
      ),
    ).rejects.toThrow();
    await expect(
      buildPreparationPackage(store, record.id, request([source.id, source.id])),
    ).rejects.toThrow();
    await expect(
      buildPreparationPackage(store, record.id, request([randomUUID()])),
    ).rejects.toMatchObject({ code: "SOURCE_NOT_FOUND" });
    record.sources[0].originalName = null;
    await expect(buildPreparationPackage(store, record.id, request())).rejects.toMatchObject({
      code: "SOURCE_NOT_FOUND",
    });
  });
  it("enforces individual and total source-byte limits", async () => {
    buffers.set(source.id, Buffer.alloc(packageLimits.originalBytes + 1));
    await expect(buildPreparationPackage(store, record.id, request())).rejects.toMatchObject({
      code: "PACKAGE_ORIGINAL_LIMIT",
      status: 413,
    });
    buffers.set(source.id, Buffer.alloc(packageLimits.originalBytes));
    const two = sourceFixture();
    const three = sourceFixture();
    record.sources.push(two, three);
    buffers.set(two.id, Buffer.alloc(packageLimits.originalBytes));
    buffers.set(three.id, Buffer.alloc(1));
    await expect(
      buildPreparationPackage(store, record.id, request([source.id, two.id, three.id])),
    ).rejects.toMatchObject({ code: "PACKAGE_TOTAL_LIMIT", status: 413 });
  });
  it("rejects metadata above 2 MiB before calling ZIP generation", async () => {
    const generate = vi.spyOn(JSZip.prototype, "generateAsync");
    record.plans[0].content.sections[0].evidence = Array.from({ length: 1600 }, () => ({
      sourceId: source.id,
      quote: "합".repeat(1000),
      locator: "본문",
    }));
    await expect(buildPreparationPackage(store, record.id, request([]))).rejects.toMatchObject({
      code: "PACKAGE_METADATA_LIMIT",
      status: 413,
    });
    expect(generate).not.toHaveBeenCalled();
  });
  it.each(["revision", "plan", "source", "bytes", "currentEvidence"])(
    "discards ZIP when %s changes while ZIP creation awaits",
    async (changed) => {
      const original = JSZip.prototype.generateAsync;
      vi.spyOn(JSZip.prototype, "generateAsync").mockImplementation(async function (
        this: JSZip,
        ...args
      ) {
        const bytes = await original.apply(this, args);
        if (changed === "revision") record.revision++;
        if (changed === "plan") record.plans[0].content.summary += " changed";
        if (changed === "source") record.sources[0].mimeType = "text/plain";
        if (changed === "bytes")
          buffers.set(source.id, Buffer.alloc(buffers.get(source.id)!.length, 65));
        if (changed === "currentEvidence") currentEvidence = false;
        return bytes;
      });
      await expect(buildPreparationPackage(store, record.id, request())).rejects.toMatchObject({
        code: changed === "bytes" ? "PACKAGE_ORIGINAL_CHANGED" : "PACKAGE_SNAPSHOT_CHANGED",
      });
    },
  );
  it("never echoes unsafe-reader exception text and releases the global job", async () => {
    store.originalForVentureInput.mockImplementationOnce(() => {
      throw new Error("PRIVATE_PATH_C:\\secret\\file");
    });
    await expect(buildPreparationPackage(store, record.id, request())).rejects.toMatchObject({
      code: "PACKAGE_ORIGINAL_UNAVAILABLE",
    });
    await expect(buildPreparationPackage(store, record.id, request([]))).resolves.toHaveProperty(
      "buffer",
    );
  });
  it("limits simultaneous ZIP memory and releases the shared lock", async () => {
    const original = JSZip.prototype.generateAsync;
    let release!: () => void;
    const waiting = new Promise<void>((done) => {
      release = done;
    });
    vi.spyOn(JSZip.prototype, "generateAsync").mockImplementationOnce(async function (
      this: JSZip,
      ...args
    ) {
      await waiting;
      return original.apply(this, args);
    });
    const first = buildPreparationPackage(store, record.id, request([]));
    await expect(buildPreparationPackage(store, record.id, request([]))).rejects.toMatchObject({
      code: "PACKAGE_BUSY",
    });
    release();
    await first;
    await expect(buildPreparationPackage(store, record.id, request([]))).resolves.toHaveProperty(
      "buffer",
    );
  });
});
