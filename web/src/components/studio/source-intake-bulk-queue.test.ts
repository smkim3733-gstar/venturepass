import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "@/lib/studio-storage";
import { emptyProfile } from "@/lib/studio-schema";
import { intakeSha } from "@/lib/studio-source-intake";
import { IntakeHttpError, type IntakePending } from "./source-intakes-ui";
import {
  IntakeUploadOutbox,
  IntakeUploadOutboxError,
  intakeUploadOutboxKey,
} from "./source-intake-upload-outbox";
import {
  IntakeBulkUploadQueue,
  IntakeBulkQueueError,
  intakeBulkQueueKey,
  decodeIntakeBulkQueue,
} from "./source-intake-bulk-queue";

let directory: string, store: StudioStore, companyId: string;
let values: Map<string, string>, queueLocked: boolean, outboxLocked: boolean;
let send: ReturnType<typeof vi.fn<(request: IntakePending) => Promise<unknown>>>;
let status: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
let storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
const content = "synthetic bulk original";
const files = (count: number) =>
  Array.from(
    { length: count },
    (_, index) => new File([content + index], `bulk-${index}.txt`, { type: "text/plain" }),
  );
const raw = () => values.get(intakeBulkQueueKey(companyId))!;
async function stored() {
  return decodeIntakeBulkQueue(raw(), companyId);
}
function controller() {
  return new IntakeBulkUploadQueue(companyId, {
    storage,
    exclusive: async (work) => {
      if (queueLocked) throw new IntakeBulkQueueError("BUSY");
      queueLocked = true;
      try {
        return await work();
      } finally {
        queueLocked = false;
      }
    },
    outbox: new IntakeUploadOutbox(companyId, {
      storage,
      status,
      send,
      exclusive: async (work) => {
        if (outboxLocked) throw new IntakeUploadOutboxError("BUSY");
        outboxLocked = true;
        try {
          return await work();
        } finally {
          outboxLocked = false;
        }
      },
    }),
  });
}
async function commit(request: IntakePending) {
  if (request.kind === "command") {
    if (request.command.action !== "create") throw new Error("unexpected command");
    return store.createSourceIntakeBatch(companyId, request.command);
  }
  return store.storeSourceIntakeOriginal(companyId, request.itemId, request.input, {
    name: request.file.name,
    mimeType: request.file.type || "application/octet-stream",
    buffer: Buffer.from(await request.file.arrayBuffer()),
  });
}
function reopen() {
  store.close();
  store = new StudioStore(directory);
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "venturepass-bulk-queue-"));
  store = new StudioStore(directory);
  companyId = store.create({ ...emptyProfile(), companyName: "합성 대량 접수" }).id;
  values = new Map();
  queueLocked = false;
  outboxLocked = false;
  storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
  send = vi.fn(commit);
  status = vi.fn(async () => ({ company: store.get(companyId), activeItemIds: [] }));
});
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  const base = resolve(tmpdir()),
    target = resolve(directory),
    part = relative(base, target);
  if (!part || part.startsWith("..") || isAbsolute(part)) throw new Error("Unsafe cleanup");
  rmSync(target, { recursive: true, force: true });
});

describe("durable complete selection and batches", () => {
  it.each([false, true])(
    "checks both occupied slots and cancelled history before begin (cancelled=%s)",
    async (cancelled) => {
      const declared = store.createSourceIntakeBatch(companyId, {
        action: "create",
        revision: store.get(companyId).revision,
        clientRequestId: randomUUID(),
        files: [
          {
            clientFileId: randomUUID(),
            originalName: "reserved.txt",
            kind: "other",
            sizeBytes: 1,
            sha256: intakeSha("x"),
          },
        ],
      });
      if (cancelled) {
        const item = declared.company.sourceIntakes[0];
        store.cancelSourceIntakeItem(companyId, {
          action: "cancel-awaiting-original",
          revision: declared.company.revision,
          clientRequestId: randomUUID(),
          itemId: item.id,
          expectedItemVersion: item.version,
          confirmed: true,
        });
      }
      const before = store.get(companyId);
      await expect(controller().begin(files(100))).rejects.toMatchObject({ code: "CAPACITY" });
      expect(values.size).toBe(0);
      expect(send).not.toHaveBeenCalled();
      expect(store.get(companyId)).toEqual(before);
    },
  );
  it("rechecks later reservations before the first new batch without replacing selection nonces", async () => {
    const selected = files(100);
    await controller().begin(selected);
    const original = raw();
    store.createSourceIntakeBatch(companyId, {
      action: "create",
      revision: store.get(companyId).revision,
      clientRequestId: randomUUID(),
      files: [
        {
          clientFileId: randomUUID(),
          originalName: "reserved.txt",
          kind: "other",
          sizeBytes: 1,
          sha256: intakeSha("x"),
        },
      ],
    });
    await expect(controller().run(selected)).rejects.toMatchObject({ code: "CAPACITY" });
    expect(raw()).toBe(original);
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects a changed receipt digest even when the matching nonce and declared files remain", async () => {
    const selected = files(1);
    await controller().begin(selected);
    let count = 0;
    await controller().run(selected, { shouldContinue: () => ++count === 1 });
    const saved = store.get(companyId),
      corrupted = structuredClone(saved);
    corrupted.sourceIntakes[0].requests[0].inputDigest = "0".repeat(64);
    status.mockResolvedValue({ company: corrupted, activeItemIds: [] });
    await expect(controller().inspect()).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.get(companyId)).toEqual(saved);
  });
  it("binds its outbox to the same company before reading or writing", () => {
    const foreign = new IntakeUploadOutbox(randomUUID(), {
      storage,
      status,
      send,
      exclusive: (work) => work(),
    });
    expect(
      () =>
        new IntakeBulkUploadQueue(companyId, {
          storage,
          outbox: foreign,
          exclusive: (work) => work(),
        }),
    ).toThrow(IntakeBulkQueueError);
    expect(send).not.toHaveBeenCalled();
    expect(values.size).toBe(0);
  });

  it("zero attachments creates no queue, request, or fact confirmation", async () => {
    expect(await controller().begin([])).toBeNull();
    expect(values.size).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect(store.get(companyId).sources).toEqual([]);
  });
  it.each([1, 10, 11, 99, 100])(
    "retains all %i declarations and fixed nonces before any transmission",
    async (count) => {
      const selected = files(count),
        before = store.get(companyId);
      const queue = await controller().begin(selected);
      expect(queue!.files).toHaveLength(count);
      expect(queue!.batches).toHaveLength(Math.ceil(count / 10));
      expect(queue!.actions).toEqual([]);
      expect(send).not.toHaveBeenCalled();
      expect(raw()).not.toContain(content);
      expect(raw()).not.toContain("reviewed");
      expect(store.get(companyId)).toEqual(before);
      const restored = await controller().inspect();
      expect(restored.files.every((file) => file.state === "remaining")).toBe(true);
      expect(restored.queue).toEqual(queue);
      await controller().run([]);
      expect(send).not.toHaveBeenCalled();
      expect(await stored()).toEqual(queue);
    },
  );
  it("keeps the 24 MiB limit independent of the ten-file limit", async () => {
    const selected = [12, 12, 1].map(
      (mb, i) => new File([new Uint8Array(mb * 1024 * 1024)], `bytes-${i}.txt`),
    );
    const queue = await controller().begin(selected);
    expect(queue!.batches.map((batch) => batch.fileIds.length)).toEqual([2, 1]);
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects 101, oversized files, duplicate identities and unsupported names before a write", async () => {
    await expect(controller().begin(files(101))).rejects.toMatchObject({ code: "CAPACITY" });
    await expect(
      controller().begin([new File([new Uint8Array(12 * 1024 * 1024 + 1)], "large.txt")]),
    ).rejects.toThrow();
    await expect(controller().begin([files(1)[0], files(1)[0]])).rejects.toMatchObject({
      code: "CORRUPT",
    });
    await expect(controller().begin([new File(["x"], "unsupported.doc")])).rejects.toThrow();
    expect(values.size).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
  it("fails closed on write/readback failure without creating server reservations", async () => {
    storage.setItem = () => {};
    await expect(controller().begin(files(2))).rejects.toMatchObject({ code: "STORAGE" });
    expect(send).not.toHaveBeenCalled();
    expect(store.get(companyId).sourceIntakes).toEqual([]);
  });
  it("detects foreign company, new fields, corruption and rehashed batch replacement", async () => {
    await controller().begin(files(11));
    const saved = raw();
    for (const modify of [
      (q: Record<string, unknown>) => {
        q.companyId = randomUUID();
      },
      (q: Record<string, unknown>) => {
        q.reviewed = true;
      },
      (q: Record<string, unknown>) => {
        q.files = [];
      },
      (q: Record<string, unknown>) => {
        const b = q.batches as { fileIds: string[] }[];
        b[1].fileIds[0] = b[0].fileIds[0];
      },
    ]) {
      const q = JSON.parse(saved);
      modify(q);
      delete q.digest;
      q.digest = intakeSha(JSON.stringify(q));
      values.set(intakeBulkQueueKey(companyId), JSON.stringify(q));
      await expect(controller().inspect()).rejects.toMatchObject({ code: "CORRUPT" });
    }
    expect(send).not.toHaveBeenCalled();
  });
  it("never replaces an existing selection and only explicitly discards a wholly unsent one", async () => {
    await controller().begin(files(2));
    const saved = raw();
    await expect(controller().begin(files(3))).rejects.toMatchObject({ code: "EXISTING" });
    expect(raw()).toBe(saved);
    await expect(controller().clearCompleted()).rejects.toMatchObject({ code: "INCOMPLETE" });
    await controller().discardUnsent();
    expect(values.size).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
  it("preserves 100 identities across a server restart after two stored originals and a lost third request", async () => {
    const selected = files(100);
    const declared = await controller().begin(selected);
    let originals = 0;
    send.mockImplementation(async (request) => {
      expect((await stored()).files).toEqual(declared!.files);
      if (request.kind === "original" && ++originals === 3)
        throw new Error("before original three");
      return commit(request);
    });
    await expect(controller().run(selected)).rejects.toThrow("before original three");
    const pending = (await stored()).actions.at(-1)!;
    const before = store.get(companyId);
    expect(before.sources).toHaveLength(2);
    expect(before.sourceIntakes).toHaveLength(10);
    reopen();
    const read = await controller().inspect();
    expect(read.files.filter((file) => file.state === "stored")).toHaveLength(2);
    expect(read.files.filter((file) => file.state === "confirmation")).toHaveLength(1);
    expect(read.files.filter((file) => file.state === "remaining")).toHaveLength(97);
    expect(read.queue!.files).toEqual(declared!.files);
    expect(read.queue!.batches).toEqual(declared!.batches);
    const sends = send.mock.calls.length;
    await controller().run([]);
    expect(send).toHaveBeenCalledTimes(sends);
    await expect(
      controller().run([new File(["x".repeat(selected[2].size)], selected[2].name)]),
    ).rejects.toMatchObject({ code: "FILE" });
    expect(send).toHaveBeenCalledTimes(sends);
    expect(store.get(companyId)).toEqual(before);
    send.mockImplementation(commit);
    const resumed = await controller().run([
      new File([await selected[2].arrayBuffer()], selected[2].name),
    ]);
    expect(resumed.files.filter((file) => file.state === "stored")).toHaveLength(3);
    expect(send.mock.calls.at(-1)![0]).toMatchObject(
      pending.journal.request.kind === "original"
        ? { itemId: pending.journal.request.itemId, input: pending.journal.request.input }
        : {},
    );
    expect(store.get(companyId).sources.slice(0, 2)).toEqual(before.sources);
    expect(store.get(companyId).sourceIntakes.slice(0, 2)).toEqual(
      before.sourceIntakes.slice(0, 2),
    );
    expect(resumed.queue!.actions).toHaveLength(4);
  }, 60000);
  it("finishes eleven originals in two batches, retains bytes and clears only the completed browser metadata", async () => {
    const selected = files(11);
    const initial = await controller().begin(selected);
    let completedActions = 0;
    const firstBatch = await controller().run(selected, {
      shouldContinue: () => ++completedActions <= 11,
      onProgress: (copy) => {
        copy.queue!.files[0].originalName = "callback-only.txt";
      },
    });
    expect(firstBatch.complete).toBe(false);
    expect(firstBatch.files.filter((file) => file.state === "stored")).toHaveLength(10);
    expect(send).toHaveBeenCalledTimes(11);
    reopen();
    await controller().run([]);
    expect(send).toHaveBeenCalledTimes(11);
    const view = await controller().run([selected[10]]);
    expect(view.complete).toBe(true);
    expect(view.files.every((file) => file.state === "stored")).toBe(true);
    expect(send).toHaveBeenCalledTimes(13);
    const creates = send.mock.calls
      .map(([request]) => request)
      .filter((request) => request.kind === "command");
    expect(creates.map((request) => request.command.clientRequestId)).toEqual(
      initial!.batches.map((batch) => batch.nonce),
    );
    for (const [index, source] of view.company.sources.entries()) {
      expect(source.text).toBe("");
      expect(source.extraction).toBe("pending");
      const original = store.original(companyId, source.id);
      expect(original.buffer).toEqual(Buffer.from(await selected[index].arrayBuffer()));
    }
    reopen();
    const restored = await controller().inspect();
    expect(restored.company).toEqual(view.company);
    await controller().run([]);
    expect(send).toHaveBeenCalledTimes(13);
    await controller().clearCompleted();
    expect(values.size).toBe(0);
    expect(store.get(companyId)).toEqual(view.company);
  }, 120000);
  it.each(["create", "original"])(
    "recovers a committed %s with GET only even when the original outbox was already cleared",
    async (target) => {
      const selected = files(1);
      await controller().begin(selected);
      let stop = false;
      // The network commits and the old outbox clears; then queue acknowledgement persistence fails.
      const set = storage.setItem;
      storage.setItem = (key, value) => {
        const next = key === intakeBulkQueueKey(companyId) ? JSON.parse(value) : null;
        const last = next?.actions.at(-1);
        if (
          !stop &&
          last?.acknowledged &&
          (target === "create"
            ? last.journal.request.kind === "command"
            : last.journal.request.kind === "original")
        ) {
          stop = true;
          throw new Error("queue ack lost");
        }
        set(key, value);
      };
      await expect(controller().run(selected)).rejects.toMatchObject({ code: "STORAGE" });
      expect(values.has(intakeUploadOutboxKey(companyId))).toBe(false);
      const count = send.mock.calls.length;
      const saved = store.get(companyId);
      reopen();
      const result = await controller().inspect();
      expect(result.queue!.actions.at(-1)!.acknowledged).toBe(true);
      expect(result.company).toEqual(saved);
      expect(send).toHaveBeenCalledTimes(count);
    },
    30000,
  );
  it.each(["create", "original"])(
    "reconciles a %s response loss without inventing a new request",
    async (target) => {
      const selected = files(1);
      await controller().begin(selected);
      send.mockImplementation(async (request) => {
        const result = await commit(request);
        if (target === "create" ? request.kind === "command" : request.kind === "original")
          throw new Error("reply lost");
        return result;
      });
      await expect(controller().run(selected)).rejects.toThrow("reply lost");
      const saved = store.get(companyId),
        count = send.mock.calls.length;
      reopen();
      const view = await controller().inspect();
      expect(view.company).toEqual(saved);
      expect(send).toHaveBeenCalledTimes(count);
      expect(view.queue!.actions.at(-1)!.acknowledged).toBe(true);
      expect(values.has(intakeUploadOutboxKey(companyId))).toBe(false);
    },
    30000,
  );
  it("retains a rejected replay's nonce and command rather than renewing CAS or forgetting uncertainty", async () => {
    const selected = files(1);
    await controller().begin(selected);
    send.mockRejectedValueOnce(new Error("not observed"));
    await expect(controller().run(selected)).rejects.toThrow("not observed");
    const original = (await stored()).actions[0].journal;
    send.mockRejectedValueOnce(new IntakeHttpError("INTAKE_VERSION_CONFLICT", false));
    await expect(controller().run(selected)).rejects.toBeInstanceOf(IntakeHttpError);
    expect((await stored()).actions[0].journal).toEqual(original);
    expect(send.mock.calls[0][0]).toEqual(send.mock.calls[1][0]);
    await expect(controller().discardUnsent()).rejects.toMatchObject({ code: "INCOMPLETE" });
  });
  it("rejects a database rollback after an acknowledged declaration without recreating it", async () => {
    const selected = files(1),
      old = store.get(companyId);
    await controller().begin(selected);
    let count = 0;
    await controller().run(selected, { shouldContinue: () => ++count === 1 });
    expect((await stored()).actions[0].acknowledged).toBe(true);
    status.mockResolvedValue({ company: old, activeItemIds: [] });
    await expect(controller().inspect()).rejects.toMatchObject({ code: "RESPONSE" });
    await expect(controller().run(selected)).rejects.toMatchObject({ code: "RESPONSE" });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("blocks another tab through response processing and does not reuse the first tab's snapshot", async () => {
    const selected = files(1);
    await controller().begin(selected);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const arrived = new Promise<void>((resolve) => {
      entered = resolve;
    });
    send.mockImplementationOnce(async (request) => {
      entered();
      await waiting;
      return commit(request);
    });
    let tick = 0;
    const run = controller().run(selected, { shouldContinue: () => ++tick === 1 });
    await arrived;
    await expect(controller().inspect()).rejects.toMatchObject({ code: "BUSY" });
    await expect(controller().run(selected)).rejects.toMatchObject({ code: "BUSY" });
    release();
    await run;
    expect((await controller().inspect()).company.sourceIntakes).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("does not transmit if selection persistence for the next exact command fails", async () => {
    const selected = files(1);
    await controller().begin(selected);
    storage.setItem = () => {
      throw new Error("quota");
    };
    await expect(controller().run(selected)).rejects.toMatchObject({ code: "STORAGE" });
    expect(send).not.toHaveBeenCalled();
    expect((await stored()).actions).toEqual([]);
  });
  it("rejects a foreign pending detailed upload before starting a bulk declaration", async () => {
    const selected = files(1);
    await controller().begin(selected);
    const outbox = new IntakeUploadOutbox(companyId, {
      storage,
      status,
      send: async () => {
        throw new Error("unknown detailed request");
      },
      exclusive: (work) => work(),
    });
    await expect(
      outbox.send({
        kind: "command",
        command: {
          action: "create",
          revision: store.get(companyId).revision,
          clientRequestId: randomUUID(),
          files: [
            {
              clientFileId: randomUUID(),
              originalName: "other.txt",
              kind: "other",
              sizeBytes: 1,
              sha256: intakeSha("x"),
            },
          ],
        },
      }),
    ).rejects.toThrow();
    const before = raw();
    await expect(controller().run(selected)).rejects.toMatchObject({ code: "EXISTING" });
    expect(raw()).toBe(before);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("guided queue recovery and explicit closing", () => {
  it("shares only an in-flight same-controller GET and returns isolated views", async () => {
    await controller().begin(files(1));
    status.mockClear();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    status.mockImplementation(async () => {
      await wait;
      return { company: store.get(companyId), activeItemIds: [] };
    });
    const owner = controller(),
      first = owner.inspect(),
      second = owner.inspect();
    await expect(controller().inspect()).rejects.toMatchObject({ code: "BUSY" });
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(status).toHaveBeenCalledTimes(1);
    a.queue!.files[0].originalName = "changed.txt";
    expect(b.queue!.files[0].originalName).toBe("bulk-0.txt");
    await owner.inspect();
    expect(status).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
  });
  it("retains selection cards when GET fails without treating metadata as storage evidence", async () => {
    const queue = await controller().begin(files(2));
    status.mockRejectedValue(new Error("offline"));
    await expect(controller().inspect()).rejects.toThrow("offline");
    expect(await controller().readSelection()).toEqual(queue);
    expect(store.get(companyId).sourceIntakes).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
  it("records only a first directly observed refusal and explicitly closes its local selection", async () => {
    const chosen = files(1),
      before = store.get(companyId);
    await controller().begin(chosen);
    send.mockRejectedValueOnce(new IntakeHttpError("INTAKE_VERSION_CONFLICT", false));
    await expect(controller().run(chosen)).rejects.toBeInstanceOf(IntakeHttpError);
    const saved = await stored();
    expect(saved.actions[0]).toMatchObject({
      acknowledged: false,
      rejection: "INTAKE_VERSION_CONFLICT",
    });
    expect(values.has(intakeUploadOutboxKey(companyId))).toBe(false);
    await controller().run(chosen);
    expect(send).toHaveBeenCalledTimes(1);
    await expect(
      controller().closeStoppedSelection({ confirmed: false } as never),
    ).rejects.toThrow();
    await controller().closeStoppedSelection({ confirmed: true });
    expect(values.size).toBe(0);
    expect(store.get(companyId)).toEqual(before);
  });
  it("never closes an uncertain request after a later refused replay", async () => {
    const chosen = files(1);
    await controller().begin(chosen);
    send.mockRejectedValueOnce(new Error("reply unknown"));
    await expect(controller().run(chosen)).rejects.toThrow("reply unknown");
    const original = raw();
    send.mockRejectedValueOnce(new IntakeHttpError("INTAKE_VERSION_CONFLICT", false));
    await expect(controller().run(chosen)).rejects.toThrow();
    await expect(controller().closeStoppedSelection({ confirmed: true })).rejects.toMatchObject({
      code: "INCOMPLETE",
    });
    expect(raw()).toBe(original);
    expect((await stored()).actions[0].rejection).toBeUndefined();
    expect(values.has(intakeUploadOutboxKey(companyId))).toBe(true);
    expect(send.mock.calls[0][0]).toEqual(send.mock.calls[1][0]);
  });
  it("closing a cancelled partial selection preserves the stored original and server reservations", async () => {
    const chosen = files(3);
    await controller().begin(chosen);
    let step = 0;
    await controller().run(chosen, { shouldContinue: () => ++step <= 2 });
    const company = store.get(companyId),
      item = company.sourceIntakes[1];
    store.cancelSourceIntakeItem(companyId, {
      action: "cancel-awaiting-original",
      revision: company.revision,
      itemId: item.id,
      expectedItemVersion: item.version,
      clientRequestId: randomUUID(),
      confirmed: true,
    });
    const before = store.get(companyId);
    const stopped = await controller().run(chosen);
    expect(stopped.files.map((file) => file.state)).toEqual(["stored", "cancelled", "remaining"]);
    expect(send).toHaveBeenCalledTimes(2);
    await controller().closeStoppedSelection({ confirmed: true });
    expect(values.size).toBe(0);
    expect(store.get(companyId)).toEqual(before);
    expect(store.original(companyId, before.sources[0].id).buffer).toEqual(
      Buffer.from(await chosen[0].arrayBuffer()),
    );
  }, 30000);
  it("refusal markers cannot coexist with an acknowledged server receipt", async () => {
    const chosen = files(1);
    await controller().begin(chosen);
    let step = 0;
    await controller().run(chosen, { shouldContinue: () => ++step === 1 });
    const saved = JSON.parse(raw());
    saved.actions[0].rejection = "INTAKE_VERSION_CONFLICT";
    delete saved.digest;
    saved.digest = intakeSha(JSON.stringify(saved));
    values.set(intakeBulkQueueKey(companyId), JSON.stringify(saved));
    await expect(controller().inspect()).rejects.toMatchObject({ code: "CORRUPT" });
    saved.actions[0].acknowledged = false;
    delete saved.digest;
    saved.digest = intakeSha(JSON.stringify(saved));
    values.set(intakeBulkQueueKey(companyId), JSON.stringify(saved));
    await expect(controller().closeStoppedSelection({ confirmed: true })).rejects.toMatchObject({
      code: "RESPONSE",
    });
    expect(values.has(intakeBulkQueueKey(companyId))).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
