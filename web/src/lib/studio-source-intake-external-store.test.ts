import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import { emptyProfile, type StudioCase } from "./studio-schema";
import {
  sourceIntakeCommandSchema,
  sourceIntakeItemSchema,
  sourceIntakeLimits,
  type SourceIntakeAttemptBinding,
  type SourceIntakeResponse,
} from "./studio-source-intake-types";
import {
  sourceIntakeExternalConfiguration,
  type RunExternalSourceIntakeCommand,
} from "./studio-source-intake-external-types";
import { withVentureInputCompanyLock } from "./venturein-input-lock";
import { validateSourceIntakeOriginal } from "./studio-source-intake-original";

vi.mock("server-only", () => ({}));
const pdf = Buffer.from("%PDF-1.7\nsynthetic original only");
const configuration = sourceIntakeExternalConfiguration("ai-document", "synthetic-model");
const completed = {
  status: "completed" as const,
  content: { kind: "plain" as const, text: "검토 전 합성 판독문" },
  warnings: [],
};
const unknown = { status: "unknown" as const, code: "INTAKE_EXTERNAL_RESULT_UNKNOWN" as const };

describe("external intake durable store: synthetic originals only", { timeout: 60_000 }, () => {
  let root: string, store: StudioStore, company: StudioCase;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "venture-external-intake-"));
    store = new StudioStore(root);
    company = store.create({ ...emptyProfile(), companyName: "합성 외부 접수 검사" });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    const path = resolve(root),
      boundary = relative(resolve(tmpdir()), path);
    if (
      !boundary.startsWith("venture-external-intake-") ||
      boundary.startsWith("..") ||
      isAbsolute(boundary)
    )
      throw new Error("Unsafe fixture cleanup");
    rmSync(path, { recursive: true, force: true });
  });
  function db() {
    return new DatabaseSync(join(root, "studio.sqlite"));
  }
  function savedRow() {
    const connection = db();
    try {
      return connection
        .prepare("SELECT revision,evidence_revision,body FROM studio_cases WHERE id=?")
        .get(company.id);
    } finally {
      connection.close();
    }
  }
  function alter(edit: (value: StudioCase) => void) {
    const connection = db();
    try {
      const row = connection
        .prepare("SELECT body FROM studio_cases WHERE id=?")
        .get(company.id) as { body: string };
      const value = JSON.parse(row.body) as StudioCase;
      edit(value);
      connection
        .prepare("UPDATE studio_cases SET body=? WHERE id=?")
        .run(JSON.stringify(value), company.id);
    } finally {
      connection.close();
    }
  }
  function upload(name = "fixture.pdf", buffer = pdf, mimeType: string | null = "application/pdf") {
    const current = store.get(company.id);
    const created = store.createSourceIntakeBatch(company.id, {
      action: "create",
      revision: current.revision,
      clientRequestId: randomUUID(),
      files: [
        { clientFileId: randomUUID(), originalName: name, sizeBytes: buffer.length, kind: "other" },
      ],
    });
    const item = created.company.sourceIntakes.at(-1)!;
    return store.storeSourceIntakeOriginal(
      company.id,
      item.id,
      {
        revision: created.company.revision,
        clientRequestId: randomUUID(),
        expectedItemVersion: item.version,
      },
      { name, mimeType, buffer },
    );
  }
  function command(response: SourceIntakeResponse): RunExternalSourceIntakeCommand {
    const item = response.item!;
    const preview = store.previewSourceIntakeExternal(
      company.id,
      {
        revision: response.company.revision,
        itemId: item.id,
        expectedItemVersion: item.version,
        engine: "ai-document",
      },
      configuration,
    );
    return {
      action: "run-external",
      revision: response.company.revision,
      clientRequestId: randomUUID(),
      itemId: item.id,
      expectedItemVersion: item.version,
      approval: preview.approval,
      approved: true,
      acknowledgePossibleDuplicate: preview.requiresDuplicateAcknowledgement,
    };
  }
  function start(response = upload()) {
    const input = command(response),
      begin = store.beginSourceIntakeExternalAttempt(company.id, input, configuration);
    const binding: SourceIntakeAttemptBinding = {
      revision: begin.response.company.revision,
      itemId: begin.response.item!.id,
      itemVersion: begin.response.item!.version,
      attemptId: begin.attemptId!,
    };
    return { input, begin, binding };
  }
  const pathFor = (response: SourceIntakeResponse) =>
    join(root, "originals", company.id, `${response.item!.sourceId}.bin`);
  const resumeInput = (response: SourceIntakeResponse) => ({
    action: "resume" as const,
    revision: response.company.revision,
    clientRequestId: randomUUID(),
    itemId: response.item!.id,
    expectedItemVersion: response.item!.version,
  });

  it("preview is read-only; exact approval is durable before a provider could run", () => {
    const response = upload(),
      row = savedRow(),
      bytes = readFileSync(pathFor(response));
    const input = command(response);
    expect(savedRow()).toEqual(row);
    expect(readFileSync(pathFor(response))).toEqual(bytes);
    const begun = store.beginSourceIntakeExternalAttempt(company.id, input, configuration);
    expect(begun.started).toBe(true);
    expect(begun.response.item).toMatchObject({
      phase: "requesting_external",
      version: response.item!.version + 1,
      result: null,
    });
    expect(begun.response.item!.attempts[0]).toMatchObject({
      externalRequestStarted: true,
      status: "running",
      externalApproval: input.approval,
      clientRequestId: input.clientRequestId,
      engine: "ai-document",
      resultId: null,
    });
    expect(begun.response.company.sources).toEqual(response.company.sources);
    expect(begun.response.company.analysis).toEqual(response.company.analysis);
    expect(begun.response.company.stage).toBe(response.company.stage);
    expect((savedRow() as { evidence_revision: number }).evidence_revision).toBe(
      (row as { evidence_revision: number }).evidence_revision,
    );
  });
  it("same nonce survives restart and ignores changed provider configuration without creating an attempt", () => {
    const { input, begin } = start();
    store.close();
    store = new StudioStore(root);
    const row = savedRow();
    const replay = store.beginSourceIntakeExternalAttempt(company.id, input, {
      ...configuration,
      model: "changed-model",
    });
    expect(replay.started).toBe(false);
    expect(replay.attemptId).toBeNull();
    expect(replay.response.item).toEqual(begin.response.item);
    expect(savedRow()).toEqual(row);
    expect(() =>
      store.beginSourceIntakeExternalAttempt(
        company.id,
        { ...input, acknowledgePossibleDuplicate: true },
        configuration,
      ),
    ).toThrow(expect.objectContaining({ code: "INTAKE_NONCE_CONFLICT" }));
  });
  it("successful external result stays unreviewed, then requires exact manual adoption", () => {
    const { input, begin, binding } = start();
    const result = store.finishSourceIntakeExternalAttempt(company.id, binding, completed);
    expect(result.item).toMatchObject({ phase: "awaiting_review", adoption: null });
    expect(result.item!.attempts[0]).toMatchObject({
      status: "completed",
      externalApproval: input.approval,
    });
    expect(result.item!.result).toMatchObject({
      engine: "ai-document",
      content: completed.content,
      reviewStatus: "unreviewed",
    });
    expect(result.item!.result).not.toHaveProperty("locations");
    expect(result.company.sources).toEqual(begin.response.company.sources);
    const adopted = store.adoptSourceIntakeResult(company.id, {
      action: "adopt",
      revision: result.company.revision,
      clientRequestId: randomUUID(),
      itemId: result.item!.id,
      expectedItemVersion: result.item!.version,
      resultId: result.item!.result!.id,
      sourceUpdatedAt: result.item!.original!.sourceUpdatedAt,
      originalSha256: result.item!.original!.sha256,
      text: "담당자가 교정한 합성 본문",
      reviewed: true,
    });
    expect(adopted.company.sources[0]).toMatchObject({
      extraction: "manual",
      text: "담당자가 교정한 합성 본문",
    });
    expect(adopted.item!.attempts[0]).toEqual(result.item!.attempts[0]);
    const row = savedRow();
    expect(store.beginSourceIntakeExternalAttempt(company.id, input, configuration).started).toBe(
      false,
    );
    expect(savedRow()).toEqual(row);
  });
  it("resume only closes uncertainty; a new transmission requires new exact approval and duplicate acknowledgment", () => {
    const { input, begin, binding } = start();
    store.close();
    store = new StudioStore(root);
    const recovery = resumeInput(begin.response),
      resumed = store.resumeSourceIntakeExternal(company.id, recovery);
    expect(resumed.item).toMatchObject({ phase: "external_result_unknown", result: null });
    expect(resumed.item!.attempts).toHaveLength(1);
    expect(resumed.item!.attempts[0]).toMatchObject({
      status: "unknown",
      externalRequestStarted: true,
      externalApproval: input.approval,
    });
    const row = savedRow();
    expect(store.resumeSourceIntakeExternal(company.id, recovery).item).toEqual(resumed.item);
    expect(savedRow()).toEqual(row);
    expect(() => store.finishSourceIntakeExternalAttempt(company.id, binding, completed)).toThrow();
    const next = command(resumed);
    expect(next.acknowledgePossibleDuplicate).toBe(true);
    expect(() =>
      store.beginSourceIntakeExternalAttempt(
        company.id,
        { ...next, acknowledgePossibleDuplicate: false },
        configuration,
      ),
    ).toThrow(expect.objectContaining({ code: "INTAKE_EXTERNAL_DUPLICATE_ACK_REQUIRED" }));
    expect(savedRow()).toEqual(row);
    const nextBegin = store.beginSourceIntakeExternalAttempt(company.id, next, configuration);
    expect(nextBegin.response.item!.attempts).toHaveLength(2);
    expect(nextBegin.response.item!.attempts[0]).toEqual(resumed.item!.attempts[0]);
  });
  it("same-size changed original cannot become a result; uncertainty can still be recorded", () => {
    const { begin, binding } = start(),
      file = pathFor(begin.response);
    writeFileSync(file, Buffer.alloc(pdf.length, 0x41));
    const row = savedRow();
    expect(() => store.finishSourceIntakeExternalAttempt(company.id, binding, completed)).toThrow();
    expect(savedRow()).toEqual(row);
    expect(store.finishSourceIntakeExternalAttempt(company.id, binding, unknown).item!.phase).toBe(
      "external_result_unknown",
    );
  });
  it("changed company revision rejects late completion; explicit recovery binds current CAS", () => {
    const { begin, binding } = start();
    const changed = store.mutate(
      company.id,
      {
        action: "profile",
        revision: begin.response.company.revision,
        profile: { ...begin.response.company.profile, industry: "수동 변경" },
      },
      () => [],
    );
    expect(() => store.finishSourceIntakeExternalAttempt(company.id, binding, completed)).toThrow(
      expect.objectContaining({ code: "STALE_REVISION" }),
    );
    const resumed = store.resumeSourceIntakeExternal(company.id, {
      ...resumeInput(begin.response),
      revision: changed.revision,
    });
    expect(resumed.company.profile.industry).toBe("수동 변경");
    expect(resumed.item!.phase).toBe("external_result_unknown");
  });
  it.each(["configuration", "company", "item", "source"])(
    "stale %s approval writes nothing",
    (change) => {
      const response = upload(),
        input = command(response),
        row = savedRow();
      const altered = structuredClone(input);
      let config = configuration;
      if (change === "configuration") config = { ...configuration, model: "other-model" };
      if (change === "company") altered.revision--;
      if (change === "item") {
        altered.expectedItemVersion--;
        altered.approval.itemVersion--;
      }
      if (change === "source") altered.approval.sourceId = randomUUID();
      expect(() => store.beginSourceIntakeExternalAttempt(company.id, altered, config)).toThrow();
      expect(savedRow()).toEqual(row);
    },
  );
  it("local run/resume cannot execute an external engine or claim an external checkpoint", () => {
    const response = upload(),
      input = command(response);
    expect(
      sourceIntakeCommandSchema.safeParse({
        action: "run-next",
        revision: response.company.revision,
        clientRequestId: randomUUID(),
        itemId: response.item!.id,
        expectedItemVersion: response.item!.version,
        engine: "ai-document",
      }).success,
    ).toBe(false);
    expect(() =>
      store.beginSourceIntakeAttempt(company.id, resumeInput(response), "ai-document"),
    ).toThrow();
    const begin = store.beginSourceIntakeExternalAttempt(company.id, input, configuration);
    expect(() =>
      store.beginSourceIntakeAttempt(company.id, resumeInput(begin.response), "local-document"),
    ).toThrow();
    expect(() =>
      store.finishSourceIntakeAttempt(
        company.id,
        {
          revision: begin.response.company.revision,
          itemId: begin.response.item!.id,
          itemVersion: begin.response.item!.version,
          attemptId: begin.attemptId!,
        },
        completed,
      ),
    ).toThrow();
    expect(store.get(company.id).sourceIntakes[0].phase).toBe("requesting_external");
  });
  it("result capacity converts completed transport to unknown without losing approval or changing source", () => {
    const { begin, binding } = start();
    alter((record) => {
      const item = record.sourceIntakes[0];
      for (let index = 0; index < 5; index++)
        item.previousResults.push({
          id: randomUUID(),
          attemptId: randomUUID(),
          engine: "local-document",
          generatedAt: item.createdAt,
          originalSha256: item.original!.sha256,
          sourceUpdatedAt: item.original!.sourceUpdatedAt,
          textSha256: "a".repeat(64),
          content: { kind: "plain", text: "x".repeat(100_000) },
          warnings: [],
          reviewStatus: "unreviewed",
          discardedAt: null,
        });
    });
    const result = store.finishSourceIntakeExternalAttempt(company.id, binding, completed);
    expect(result.item!.phase).toBe("external_result_unknown");
    expect(result.item!.result).toBeNull();
    expect(result.item!.previousResults).toHaveLength(5);
    expect(result.company.sources).toEqual(begin.response.company.sources);
  });
  it("request limit reserves one receipt for interrupted external recovery", () => {
    const response = upload();
    alter((record) => {
      const item = record.sourceIntakes[0];
      while (item.requests.length < sourceIntakeLimits.requests - 2)
        item.requests.push({
          action: "resume",
          clientRequestId: randomUUID(),
          inputDigest: "b".repeat(64),
        });
    });
    const current = {
      ...response,
      company: store.get(company.id),
      item: store.get(company.id).sourceIntakes[0],
    };
    const input = command(current),
      begin = store.beginSourceIntakeExternalAttempt(company.id, input, configuration);
    expect(begin.response.item!.requests).toHaveLength(19);
    const recovered = store.resumeSourceIntakeExternal(company.id, resumeInput(begin.response));
    expect(recovered.item!.requests).toHaveLength(20);
    expect(recovered.item!.phase).toBe("external_result_unknown");
    expect(() => command(recovered)).toThrow(
      expect.objectContaining({ code: "INTAKE_EXTERNAL_LIMIT" }),
    );
  });
  it("company input lock blocks preview, new checkpoint, completion and recovery", async () => {
    const response = upload(),
      input = command(response),
      row = savedRow();
    await withVentureInputCompanyLock(company.id, async () => {
      expect(() => command(response)).toThrow(
        expect.objectContaining({ code: "INPUT_IN_PROGRESS" }),
      );
      expect(() =>
        store.beginSourceIntakeExternalAttempt(company.id, input, configuration),
      ).toThrow(expect.objectContaining({ code: "INPUT_IN_PROGRESS" }));
    });
    expect(savedRow()).toEqual(row);
    const { begin, binding } = start(response);
    await withVentureInputCompanyLock(company.id, async () => {
      expect(() => store.finishSourceIntakeExternalAttempt(company.id, binding, unknown)).toThrow(
        expect.objectContaining({ code: "INPUT_IN_PROGRESS" }),
      );
      expect(() =>
        store.resumeSourceIntakeExternal(company.id, resumeInput(begin.response)),
      ).toThrow(expect.objectContaining({ code: "INPUT_IN_PROGRESS" }));
    });
  });
  it("audio originals are accepted only by explicit external transcription; no fabricated timing", () => {
    const wave = Buffer.alloc(48);
    wave.write("RIFF");
    wave.writeUInt32LE(40, 4);
    wave.write("WAVEfmt ", 8);
    wave.writeUInt32LE(16, 16);
    wave.writeUInt16LE(1, 20);
    wave.writeUInt16LE(1, 22);
    wave.writeUInt32LE(8000, 24);
    wave.writeUInt32LE(16000, 28);
    wave.writeUInt16LE(2, 32);
    wave.writeUInt16LE(16, 34);
    wave.write("data", 36);
    wave.writeUInt32LE(4, 40);
    expect(
      validateSourceIntakeOriginal({ name: "fixture.wav", mimeType: "audio/wave", buffer: wave })
        .buffer,
    ).toEqual(wave);
    const response = upload("fixture.wav", wave, "audio/wave"),
      config = sourceIntakeExternalConfiguration("ai-transcription", "synthetic-transcribe");
    const preview = store.previewSourceIntakeExternal(
      company.id,
      {
        revision: response.company.revision,
        itemId: response.item!.id,
        expectedItemVersion: response.item!.version,
        engine: "ai-transcription",
      },
      config,
    );
    expect(preview.approval.mimeType).toBe("audio/wave");
    expect(JSON.stringify(preview)).not.toMatch(/duration|startMs|endMs|pageNumber/);
    expect(() =>
      store.beginSourceIntakeAttempt(
        company.id,
        { ...resumeInput(response), action: "run-next", engine: "local-document" },
        "local-document",
      ),
    ).toThrow();
  });
  it("local legacy schema parses without injecting external approval fields", () => {
    const response = upload("fixture.txt", Buffer.from("abc"), "text/plain");
    const begun = store.beginSourceIntakeAttempt(
      company.id,
      { ...resumeInput(response), action: "run-next", engine: "local-document" },
      "local-document",
    );
    const item = begun.response.item!,
      row = savedRow();
    expect(sourceIntakeItemSchema.parse(item)).toEqual(item);
    expect(item.attempts[0]).not.toHaveProperty("externalApproval");
    store.close();
    store = new StudioStore(root);
    expect(store.get(company.id).sourceIntakes[0]).toEqual(item);
    expect(savedRow()).toEqual(row);
  });
});
