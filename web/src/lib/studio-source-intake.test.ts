import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  linkSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import { caseSchema, emptyProfile, type StudioCase } from "./studio-schema";
import {
  assertIntakeCapacity,
  intakeDigest,
  intakeRetainedCharacters,
  newSourceIntakeBatch,
} from "./studio-source-intake";
import {
  createSourceIntakeSchema,
  sourceIntakeCommandSchema,
  sourceIntakeLimits,
  sourceIntakeResultText,
  type CreateSourceIntakeCommand,
  type SourceIntakeAttemptBinding,
  type SourceIntakeResponse,
} from "./studio-source-intake-types";
import { withVentureInputCompanyLock } from "./venturein-input-lock";
import { frozenOriginals } from "./studio-evidence-history";

function command(revision = 0, count = 1): CreateSourceIntakeCommand {
  return {
    action: "create",
    revision,
    clientRequestId: randomUUID(),
    files: Array.from({ length: count }, () => ({
      clientFileId: randomUUID(),
      originalName: "sample.txt",
      kind: "technology",
      sizeBytes: 3,
    })),
  };
}
describe("durable source intake schema and limits", () => {
  it("strict inputs, unique local IDs, exact declared bytes and supported names", () => {
    const valid = command();
    expect(createSourceIntakeSchema.parse(valid)).toEqual(valid);
    for (const originalName of [
      "../a.txt",
      "a/b.txt",
      "C:a.txt",
      "CON.txt",
      "a.txt ",
      "a.exe",
      "a\0.txt",
    ])
      expect(
        createSourceIntakeSchema.safeParse({
          ...valid,
          files: [{ ...valid.files[0], originalName }],
        }).success,
      ).toBe(false);
    expect(
      createSourceIntakeSchema.safeParse({ ...valid, files: [valid.files[0], valid.files[0]] })
        .success,
    ).toBe(false);
    expect(
      createSourceIntakeSchema.safeParse({
        ...valid,
        files: Array.from({ length: 3 }, () => ({
          ...valid.files[0],
          clientFileId: randomUUID(),
          sizeBytes: sourceIntakeLimits.fileBytes,
        })),
      }).success,
    ).toBe(false);
    expect(sourceIntakeCommandSchema.safeParse({ ...valid, path: "private" }).success).toBe(false);
    expect(
      sourceIntakeCommandSchema.safeParse({ ...valid, action: "approve-external" }).success,
    ).toBe(false);
  });
  it("server-owned IDs, one batch receipt, no source body and canonical replay digest", () => {
    const input = command(0, 3),
      items = newSourceIntakeBatch(input);
    expect(new Set(items.map((item) => item.sourceId)).size).toBe(3);
    expect(new Set(items.map((item) => item.batchId)).size).toBe(1);
    expect(items.flatMap((item) => item.requests)).toHaveLength(1);
    expect(items.every((item) => item.original === null && item.result === null)).toBe(true);
    expect(intakeDigest(input)).toBe(intakeDigest({ ...input, revision: 88 }));
    expect(intakeDigest(input)).not.toBe(
      intakeDigest({ ...input, files: [...input.files].reverse() }),
    );
  });
  it("page positions remain explicit without invented data", () => {
    expect(
      sourceIntakeResultText({
        kind: "pages",
        pages: [
          { pageNumber: 1, text: "a" },
          { pageNumber: 2, text: "b" },
        ],
      }),
    ).toBe("[페이지 1]\na\n\n[페이지 2]\nb");
  });
});

describe("durable source intake store", { timeout: 60_000 }, () => {
  let root: string, store: StudioStore, company: StudioCase;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "venture-intake-store-"));
    store = new StudioStore(root);
    company = store.create({ ...emptyProfile(), companyName: "합성 접수 검사" });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    const path = resolve(root),
      boundary = relative(resolve(tmpdir()), path);
    if (
      !boundary.startsWith("venture-intake-store-") ||
      boundary.startsWith("..") ||
      isAbsolute(boundary)
    )
      throw new Error("Unsafe fixture cleanup");
    rmSync(path, { recursive: true, force: true });
  });
  const file = (response: SourceIntakeResponse) =>
    join(root, "originals", company.id, `${response.item!.sourceId}.bin`);
  function create() {
    const response = store.createSourceIntakeBatch(company.id, command(company.revision));
    return { ...response, item: response.company.sourceIntakes.at(-1)! };
  }
  function upload() {
    const created = create();
    return store.storeSourceIntakeOriginal(
      company.id,
      created.item.id,
      {
        revision: created.company.revision,
        expectedItemVersion: created.item.version,
        clientRequestId: randomUUID(),
      },
      { name: "sample.txt", mimeType: "text/plain", buffer: Buffer.from("abc") },
    );
  }
  function begin(response: SourceIntakeResponse) {
    const input = {
      action: "run-next" as const,
      revision: response.company.revision,
      itemId: response.item!.id,
      expectedItemVersion: response.item!.version,
      clientRequestId: randomUUID(),
      engine: "local-document" as const,
    };
    const result = store.beginSourceIntakeAttempt(company.id, input, "local-document");
    return {
      ...result,
      input,
      binding: {
        revision: result.response.company.revision,
        itemId: result.response.item!.id,
        itemVersion: result.response.item!.version,
        attemptId: result.attemptId!,
      } satisfies SourceIntakeAttemptBinding,
    };
  }
  function complete() {
    const running = begin(upload());
    const response = store.finishSourceIntakeAttempt(company.id, running.binding, {
      status: "completed",
      content: { kind: "plain", text: "unreviewed text" },
      warnings: [],
    });
    return { response, running };
  }
  function replace(record: StudioCase) {
    const db = new DatabaseSync(join(root, "studio.sqlite"));
    try {
      db.prepare("UPDATE studio_cases SET body=? WHERE id=?").run(
        JSON.stringify(record),
        company.id,
      );
    } finally {
      db.close();
    }
  }
  it("create replay survives restart; conflicting nonce and stale CAS make no write", () => {
    const input = command(),
      response = store.createSourceIntakeBatch(company.id, input);
    store.close();
    store = new StudioStore(root);
    expect(store.createSourceIntakeBatch(company.id, input)).toEqual(response);
    expect(() =>
      store.createSourceIntakeBatch(company.id, {
        ...input,
        files: [{ ...input.files[0], originalName: "changed.txt" }],
      }),
    ).toThrow(expect.objectContaining({ code: "INTAKE_NONCE_CONFLICT" }));
    expect(() => store.createSourceIntakeBatch(company.id, command(0))).toThrow(
      expect.objectContaining({ code: "STALE_REVISION" }),
    );
    expect(store.get(company.id).revision).toBe(response.company.revision);
    expect(store.get(company.id).sources).toEqual([]);
  });
  it("registers pending original only; upload replay checks actual content SHA", () => {
    const created = create(),
      input = {
        revision: created.company.revision,
        expectedItemVersion: created.item.version,
        clientRequestId: randomUUID(),
      },
      payload = { name: "sample.txt", mimeType: "text/plain", buffer: Buffer.from("abc") };
    const saved = store.storeSourceIntakeOriginal(company.id, created.item.id, input, payload);
    expect(saved.item?.phase).toBe("original_stored");
    expect(saved.company.sources[0]).toMatchObject({
      extraction: "pending",
      text: "",
      originalName: "sample.txt",
    });
    expect(readFileSync(file(saved))).toEqual(payload.buffer);
    expect(store.storeSourceIntakeOriginal(company.id, created.item.id, input, payload)).toEqual(
      saved,
    );
    expect(() =>
      store.storeSourceIntakeOriginal(company.id, created.item.id, input, {
        ...payload,
        buffer: Buffer.from("xyz"),
      }),
    ).toThrow(expect.objectContaining({ code: "INTAKE_NONCE_CONFLICT" }));
  });
  it("retains durable ownership after missing-file interruption and resets only to reupload", () => {
    const created = create();
    const spy = vi
      .spyOn(store as unknown as { writeIntakeOriginal: () => void }, "writeIntakeOriginal")
      .mockImplementation(() => {
        throw new Error("synthetic crash");
      });
    expect(() =>
      store.storeSourceIntakeOriginal(
        company.id,
        created.item.id,
        {
          revision: created.company.revision,
          expectedItemVersion: 1,
          clientRequestId: randomUUID(),
        },
        { name: "sample.txt", mimeType: null, buffer: Buffer.from("abc") },
      ),
    ).toThrow();
    spy.mockRestore();
    const checkpoint = store.get(company.id),
      item = checkpoint.sourceIntakes[0];
    expect(item.phase).toBe("storing_original");
    expect(checkpoint.sources).toEqual([]);
    expect(() => store.delete(company.id, checkpoint.revision)).toThrow(
      expect.objectContaining({ code: "INTAKE_RECOVERY_REQUIRED" }),
    );
    store.close();
    store = new StudioStore(root);
    const resumed = store.resumeSourceIntakeOriginal(company.id, {
      action: "resume",
      revision: checkpoint.revision,
      itemId: item.id,
      expectedItemVersion: item.version,
      clientRequestId: randomUUID(),
    });
    expect(resumed.item?.phase).toBe("awaiting_original");
    expect(resumed.item?.original).toBeNull();
    expect(resumed.company.sources).toEqual([]);
  });
  it("recovers exact written bytes after interruption before pending registration", () => {
    const created = create();
    const spy = vi
      .spyOn(store as unknown as { readIntakeCheckpoint: () => never }, "readIntakeCheckpoint")
      .mockImplementation(() => {
        throw new Error("synthetic commit interruption");
      });
    expect(() =>
      store.storeSourceIntakeOriginal(
        company.id,
        created.item.id,
        {
          revision: created.company.revision,
          expectedItemVersion: 1,
          clientRequestId: randomUUID(),
        },
        { name: "sample.txt", mimeType: "text/plain", buffer: Buffer.from("abc") },
      ),
    ).toThrow();
    spy.mockRestore();
    const checkpoint = store.get(company.id),
      item = checkpoint.sourceIntakes[0];
    expect(existsSync(join(root, "originals", company.id, `${item.sourceId}.bin`))).toBe(true);
    store.close();
    store = new StudioStore(root);
    const response = store.resumeSourceIntakeOriginal(company.id, {
      action: "resume",
      revision: checkpoint.revision,
      itemId: item.id,
      expectedItemVersion: item.version,
      clientRequestId: randomUUID(),
    });
    expect(response.item?.phase).toBe("original_stored");
    expect(response.company.sources).toHaveLength(1);
  });
  it("keeps original and result unreviewed; exact adoption is manual and replay-safe", () => {
    const { response, running } = complete();
    expect(response.company.sources[0].text).toBe("");
    expect(response.item?.result?.reviewStatus).toBe("unreviewed");
    expect(
      store.beginSourceIntakeAttempt(company.id, running.input, "local-document"),
    ).toMatchObject({ started: false });
    const item = response.item!,
      input = {
        action: "adopt" as const,
        revision: response.company.revision,
        clientRequestId: randomUUID(),
        itemId: item.id,
        expectedItemVersion: item.version,
        resultId: item.result!.id,
        originalSha256: item.original!.sha256,
        sourceUpdatedAt: item.original!.sourceUpdatedAt,
        text: "사용자 대조 후 교정 본문",
        reviewed: true as const,
      };
    const adopted = store.adoptSourceIntakeResult(company.id, input);
    expect(adopted.company.sources[0]).toMatchObject({
      text: input.text,
      extraction: "manual",
      originalName: "sample.txt",
    });
    expect(adopted.item?.result?.content).toEqual({ kind: "plain", text: "unreviewed text" });
    expect(adopted.item?.adoption?.resultTextSha256).not.toBe(
      adopted.item?.adoption?.adoptedTextSha256,
    );
    expect(store.originalForVentureInput(company.id, item.sourceId).sha256).toBe(
      item.original!.sha256,
    );
    expect(store.adoptSourceIntakeResult(company.id, input)).toEqual(adopted);
    expect(() =>
      store.mutate(
        company.id,
        { action: "delete-source", revision: adopted.company.revision, sourceId: item.sourceId },
        () => [],
      ),
    ).toThrow(expect.objectContaining({ code: "INTAKE_SOURCE_REFERENCED" }));
  });
  it("rejects stale finish and late attempt; explicit resume appends and cannot accept old result", () => {
    const first = begin(upload());
    const resumed = store.beginSourceIntakeAttempt(
      company.id,
      {
        action: "resume",
        revision: first.response.company.revision,
        itemId: first.binding.itemId,
        expectedItemVersion: first.binding.itemVersion,
        clientRequestId: randomUUID(),
      },
      "local-document",
    );
    expect(resumed.response.item?.attempts[0]).toMatchObject({
      status: "failed",
      code: "INTAKE_INTERRUPTED",
    });
    expect(() =>
      store.finishSourceIntakeAttempt(
        company.id,
        { ...first.binding, revision: resumed.response.company.revision },
        { status: "completed", content: { kind: "plain", text: "late" }, warnings: [] },
      ),
    ).toThrow(expect.objectContaining({ code: "INTAKE_STALE" }));
    expect(resumed.response.item?.attempts).toHaveLength(2);
  });
  it("same-size bytes changed while extracting cannot become a result", () => {
    const running = begin(upload());
    writeFileSync(file(running.response), "xyz");
    expect(() =>
      store.finishSourceIntakeAttempt(company.id, running.binding, {
        status: "completed",
        content: { kind: "plain", text: "old bytes" },
        warnings: [],
      }),
    ).toThrow(expect.objectContaining({ code: "INTAKE_ORIGINAL_CHANGED" }));
    expect(store.get(company.id).sourceIntakes[0].result).toBeNull();
  });
  it("intake hash prevents changed bytes becoming the first agency evidence", () => {
    const response = upload(),
      item = response.item!;
    expect(response.company.agencyRecords).toEqual([]);
    writeFileSync(file(response), "xyz");
    expect(() =>
      store.mutate(
        company.id,
        {
          action: "append-agency-record",
          revision: response.company.revision,
          clientRequestId: randomUUID(),
          record: {
            kind: "request",
            title: "합성 요청",
            institution: "가상기관",
            body: "변조된 원본 연결 거부",
            occurredOn: "",
            dueOn: "",
            dueNote: "",
            note: "",
            sourceIds: [item.sourceId],
          },
        },
        () => [],
      ),
    ).toThrow(expect.objectContaining({ code: "INTAKE_ORIGINAL_CHANGED" }));
    const latest = store.get(company.id);
    expect(latest.revision).toBe(response.company.revision);
    expect(latest.agencyRecords).toEqual([]);
    expect(latest.sourceIntakes[0].original?.sha256).toBe(item.original!.sha256);
  });
  it("original projection retains adopted/discarded intake identity and ignores empty cancellations", () => {
    const response = upload(),
      record = response.company,
      item = record.sourceIntakes[0];
    item.phase = "adopted";
    const cancelled = newSourceIntakeBatch(command())[0];
    cancelled.phase = "cancelled";
    record.sourceIntakes.push(cancelled);
    expect(frozenOriginals(record)).toEqual([
      expect.objectContaining({
        sourceId: item.sourceId,
        sha256: item.original!.sha256,
        sizeBytes: 3,
        originalName: "sample.txt",
        mimeType: "text/plain",
      }),
    ]);
  });
  it("manual source edits while result waits cannot be overwritten by adoption", () => {
    const { response } = complete(),
      item = response.item!;
    const edited = store.mutate(
      company.id,
      {
        action: "source",
        revision: response.company.revision,
        source: {
          ...response.company.sources[0],
          id: item.sourceId,
          name: "수동본문",
          kind: "other",
          text: "기존 본문",
        },
      },
      () => [],
    );
    expect(() =>
      store.adoptSourceIntakeResult(company.id, {
        action: "adopt",
        revision: edited.revision,
        clientRequestId: randomUUID(),
        itemId: item.id,
        expectedItemVersion: item.version,
        resultId: item.result!.id,
        originalSha256: item.original!.sha256,
        sourceUpdatedAt: item.original!.sourceUpdatedAt,
        text: "덮기",
        reviewed: true,
      }),
    ).toThrow();
    expect(store.get(company.id).sources[0].text).toBe("기존 본문");
  });
  it("explicit discard retains result hashes and history across next attempt", () => {
    const { response } = complete(),
      item = response.item!,
      digest = item.result!.textSha256;
    const discarded = store.discardSourceIntakeResult(company.id, {
      action: "discard-result",
      revision: response.company.revision,
      itemId: item.id,
      expectedItemVersion: item.version,
      clientRequestId: randomUUID(),
      resultId: item.result!.id,
      confirmed: true,
    });
    expect(discarded.item?.result).toMatchObject({ content: null, textSha256: digest });
    const next = begin(discarded);
    expect(next.response.item?.previousResults).toHaveLength(1);
    expect(next.response.item?.previousResults[0].textSha256).toBe(digest);
    expect(intakeRetainedCharacters(next.response.company.sourceIntakes)).toBe(0);
  });
  it("source reservations and history limits roll back without dropping records", () => {
    const record = store.get(company.id);
    record.sourceIntakes = Array.from({ length: 4 }, () =>
      newSourceIntakeBatch(command(0, 10)),
    ).flat();
    replace(record);
    expect(() => store.createSourceIntakeBatch(company.id, command())).toThrow(
      expect.objectContaining({ code: "SOURCE_LIMIT" }),
    );
    expect(store.get(company.id).sourceIntakes).toHaveLength(40);
    expect(() =>
      store.mutate(
        company.id,
        {
          action: "source",
          revision: 0,
          source: {
            id: record.sourceIntakes[0].sourceId,
            name: "우회",
            kind: "other",
            text: "우회",
            originalName: null,
            mimeType: null,
            extraction: "manual",
            warnings: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        },
        () => [],
      ),
    ).toThrow(expect.objectContaining({ code: "INTAKE_SOURCE_RESERVED" }));
    const over = {
      ...record,
      sourceIntakes: Array.from({ length: 101 }, () => newSourceIntakeBatch(command())[0]),
    };
    expect(() => assertIntakeCapacity(over)).toThrow(
      expect.objectContaining({ code: "INTAKE_LIMIT" }),
    );
  });
  it("legacy records obtain empty intake array without rewriting prior body", () => {
    const value = { ...company } as Partial<StudioCase>;
    delete value.sourceIntakes;
    expect(caseSchema.parse(value).sourceIntakes).toEqual([]);
  });
  it("cancels only never-uploaded reservations and keeps replay/history", () => {
    const created = create(),
      item = created.item;
    const input = {
      action: "cancel-awaiting-original" as const,
      revision: created.company.revision,
      clientRequestId: randomUUID(),
      itemId: item.id,
      expectedItemVersion: item.version,
      confirmed: true as const,
    };
    const cancelled = store.cancelSourceIntakeItem(company.id, input);
    expect(cancelled.item?.phase).toBe("cancelled");
    expect(cancelled.company.sourceIntakes).toHaveLength(1);
    expect(store.cancelSourceIntakeItem(company.id, input)).toEqual(cancelled);
    expect(() =>
      store.storeSourceIntakeOriginal(
        company.id,
        item.id,
        {
          revision: cancelled.company.revision,
          clientRequestId: randomUUID(),
          expectedItemVersion: cancelled.item!.version,
        },
        { name: "sample.txt", mimeType: null, buffer: Buffer.from("abc") },
      ),
    ).toThrow(expect.objectContaining({ code: "INTAKE_PHASE_INVALID" }));
    const synthetic = cancelled.company;
    synthetic.sourceIntakes.push(
      ...Array.from({ length: 4 }, () => newSourceIntakeBatch(command(0, 10))).flat(),
    );
    expect(() => assertIntakeCapacity(synthetic)).not.toThrow();
  });
  it("cannot cancel a reservation with bytes already on disk", () => {
    const created = create(),
      path = file(created);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, "abc");
    expect(() =>
      store.cancelSourceIntakeItem(company.id, {
        action: "cancel-awaiting-original",
        revision: created.company.revision,
        itemId: created.item.id,
        expectedItemVersion: created.item.version,
        clientRequestId: randomUUID(),
        confirmed: true,
      }),
    ).toThrow(expect.objectContaining({ code: "INTAKE_RECOVERY_REQUIRED" }));
    expect(store.get(company.id).sourceIntakes[0].phase).toBe("awaiting_original");
    expect(readFileSync(path, "utf8")).toBe("abc");
  });
  it("attempt and request limits refuse without trimming completed history", () => {
    const uploaded = upload(),
      record = uploaded.company,
      item = record.sourceIntakes[0],
      now = new Date().toISOString();
    item.attempts = Array.from({ length: 10 }, () => ({
      id: randomUUID(),
      engine: "local-document",
      startedAt: now,
      finishedAt: now,
      originalSha256: item.original!.sha256,
      sourceUpdatedAt: item.original!.sourceUpdatedAt,
      externalRequestStarted: false,
      status: "failed",
      code: "INTAKE_EXTRACTION_FAILED",
      resultId: null,
    }));
    item.phase = "retryable_failure";
    replace(record);
    expect(() => begin({ ...uploaded, company: record, item })).toThrow(
      expect.objectContaining({ code: "INTAKE_LIMIT" }),
    );
    expect(store.get(company.id).sourceIntakes[0].attempts).toHaveLength(10);
    item.attempts = [];
    item.requests = Array.from({ length: 20 }, () => ({
      clientRequestId: randomUUID(),
      inputDigest: "a".repeat(64),
      action: "resume",
    }));
    replace(record);
    expect(() => begin({ ...uploaded, company: record, item })).toThrow(
      expect.objectContaining({ code: "INTAKE_LIMIT" }),
    );
    expect(store.get(company.id).sourceIntakes[0].requests).toHaveLength(20);
  });
  it("aggregate result capacity leaves original and marks awaiting capacity without truncation", () => {
    const running = begin(upload()),
      record = running.response.company,
      current = record.sourceIntakes[0];
    for (let index = 0; index < 5; index++) {
      const dummy = newSourceIntakeBatch(command())[0];
      dummy.phase = "awaiting_review";
      dummy.result = {
        id: randomUUID(),
        attemptId: randomUUID(),
        engine: "local-document",
        generatedAt: new Date().toISOString(),
        originalSha256: "b".repeat(64),
        sourceUpdatedAt: new Date().toISOString(),
        textSha256: "c".repeat(64),
        content: { kind: "plain", text: "x".repeat(100000) },
        warnings: [],
        reviewStatus: "unreviewed",
        discardedAt: null,
      };
      record.sourceIntakes.push(dummy);
    }
    replace(record);
    const ended = store.finishSourceIntakeAttempt(company.id, running.binding, {
      status: "completed",
      content: { kind: "plain", text: "capacity overflow" },
      warnings: [],
    });
    expect(ended.item).toMatchObject({
      phase: "awaiting_capacity",
      result: null,
      code: "INTAKE_RESULT_LIMIT",
    });
    expect(intakeRetainedCharacters(ended.company.sourceIntakes)).toBe(500000);
    expect(ended.company.sources.find((source) => source.id === current.sourceId)?.text).toBe("");
    expect(readFileSync(file(ended), "utf8")).toBe("abc");
  });
  it("company input lock rejects intake checkpoints", async () => {
    await withVentureInputCompanyLock(company.id, async () => {
      expect(() => store.createSourceIntakeBatch(company.id, command())).toThrow(
        expect.objectContaining({ code: "INPUT_IN_PROGRESS" }),
      );
    });
    expect(store.get(company.id).sourceIntakes).toEqual([]);
  });
  it("hardlinked owned path is not accepted during recovery", () => {
    const created = create(),
      target = join(root, "originals", company.id, `${created.item.sourceId}.bin`),
      outside = join(root, "other.bin");
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(outside, "abc");
    linkSync(outside, target);
    expect(() =>
      store.storeSourceIntakeOriginal(
        company.id,
        created.item.id,
        {
          revision: created.company.revision,
          expectedItemVersion: 1,
          clientRequestId: randomUUID(),
        },
        { name: "sample.txt", mimeType: "text/plain", buffer: Buffer.from("abc") },
      ),
    ).toThrow(expect.objectContaining({ code: "UNSAFE_ORIGINAL_PATH" }));
    expect(readFileSync(outside, "utf8")).toBe("abc");
    expect(store.get(company.id).sources).toEqual([]);
  });
  it("linked parent cannot receive originals", () => {
    const created = create(),
      elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(root, "originals"), "junction");
    expect(() =>
      store.storeSourceIntakeOriginal(
        company.id,
        created.item.id,
        {
          revision: created.company.revision,
          expectedItemVersion: 1,
          clientRequestId: randomUUID(),
        },
        { name: "sample.txt", mimeType: null, buffer: Buffer.from("abc") },
      ),
    ).toThrow(expect.objectContaining({ code: "UNSAFE_ORIGINAL_PATH" }));
    expect(existsSync(join(elsewhere, company.id))).toBe(false);
  });
});
