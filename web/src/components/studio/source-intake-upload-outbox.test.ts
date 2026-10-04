import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "@/lib/studio-storage";
import { emptyProfile } from "@/lib/studio-schema";
import { createSourceIntakeSchema } from "@/lib/studio-source-intake-types";
import { intakeSha } from "@/lib/studio-source-intake";
import { IntakeHttpError, intakeCommand, type IntakePending } from "./source-intakes-ui";
import {
  IntakeUploadOutbox,
  IntakeUploadOutboxError,
  decodeIntakeUploadJournal,
  restoreIntakeUploadFile,
  intakeUploadOutboxKey,
} from "./source-intake-upload-outbox";

let directory: string, store: StudioStore, companyId: string;
let values: Map<string, string>;
let locked = false;
const content = "synthetic original text";
const file = () => new File([content], "source.txt", { type: "text/plain" });
const hash = intakeSha(content);
let send: ReturnType<typeof vi.fn<(request: IntakePending) => Promise<unknown>>>;
let status: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
let storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
function outbox() {
  return new IntakeUploadOutbox(companyId, {
    storage,
    status,
    send,
    exclusive: async (work) => {
      if (locked) throw new IntakeUploadOutboxError("BUSY");
      locked = true;
      try {
        return await work();
      } finally {
        locked = false;
      }
    },
  });
}
function create(count = 1) {
  return intakeCommand(
    createSourceIntakeSchema.parse({
      action: "create",
      revision: store.get(companyId).revision,
      clientRequestId: randomUUID(),
      files: Array.from({ length: count }, (_, index) => ({
        clientFileId: randomUUID(),
        originalName: `source${index || ""}.txt`,
        kind: "technology",
        sizeBytes: file().size,
        sha256: hash,
      })),
    }),
  );
}
async function commit(request: IntakePending) {
  if (request.kind === "command") {
    if (request.command.action !== "create") throw new Error("test only accepts file commands");
    return store.createSourceIntakeBatch(companyId, request.command);
  }
  return store.storeSourceIntakeOriginal(companyId, request.itemId, request.input, {
    name: request.file.name,
    mimeType: request.file.type || "application/octet-stream",
    buffer: Buffer.from(await request.file.arrayBuffer()),
  });
}
async function original(): Promise<Extract<IntakePending, { kind: "original" }>> {
  await outbox().send(create());
  const company = store.get(companyId),
    item = company.sourceIntakes[0];
  return {
    kind: "original",
    itemId: item.id,
    input: {
      revision: company.revision,
      clientRequestId: randomUUID(),
      expectedItemVersion: item.version,
    },
    file: file(),
    sha256: hash,
  };
}
const raw = () => values.get(intakeUploadOutboxKey(companyId))!;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "venturepass-intake-outbox-"));
  store = new StudioStore(directory);
  companyId = store.create({ ...emptyProfile(), companyName: "합성 접수 복구" }).id;
  values = new Map();
  locked = false;
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

describe("intake upload journal across reload", () => {
  it("persists complete declarations before first POST and reconciles a lost committed reply by GET only", async () => {
    const request = create(10);
    send.mockImplementation(async (value) => {
      expect((await decodeIntakeUploadJournal(raw(), companyId)).request).toEqual(value);
      await commit(value);
      throw new Error("reply lost");
    });
    await expect(outbox().send(request)).rejects.toThrow("reply lost");
    const stored = store.get(companyId);
    expect(stored.sourceIntakes).toHaveLength(10);
    const inspected = await outbox().inspect(0);
    expect(inspected.journal).toBeNull();
    expect(inspected.company).toEqual(stored);
    expect(send).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(1);
    expect(values.size).toBe(0);
  });
  it("retains an unobserved create after reload; explicit replay uses the original nonce and bytes", async () => {
    const request = create();
    send.mockRejectedValueOnce(new Error("before server"));
    await expect(outbox().send(request)).rejects.toThrow();
    const retained = raw();
    const read = await outbox().inspect(0);
    expect(raw()).toBe(retained);
    expect(read.journal?.request).toEqual(request);
    expect(store.get(companyId).sourceIntakes).toHaveLength(0);
    const completed = await outbox().send(request);
    expect(completed.sourceIntakes).toHaveLength(1);
    expect(send.mock.calls[0][0]).toEqual(send.mock.calls[1][0]);
    expect(status).toHaveBeenCalledTimes(2);
  });
  it.each(["text/plain", ""])(
    "matches original server receipt digest for MIME %s without retaining File bytes",
    async (type) => {
      const request = await original();
      request.file = new File([content], request.file.name, { type });
      send.mockImplementationOnce(async (value) => {
        expect(raw()).not.toContain(content);
        expect(raw()).not.toContain("arrayBuffer");
        await commit(value);
        throw new Error("saved reply lost");
      });
      await expect(outbox().send(request)).rejects.toThrow();
      store.close();
      store = new StudioStore(directory);
      const stored = store.get(companyId);
      const read = await outbox().inspect(0);
      expect(read.company).toEqual(stored);
      expect(read.journal).toBeNull();
      expect(read.company.sources[0].text).toBe("");
      expect(read.company.sources[0].extraction).toBe("pending");
      expect(send).toHaveBeenCalledTimes(2);
    },
    30000,
  );
  it("requires matching reselected bytes and restores exact original MIME/input after a no-write interruption", async () => {
    const request = await original();
    send.mockRejectedValueOnce(new Error("not reached"));
    await expect(outbox().send(request)).rejects.toThrow();
    const read = await outbox().inspect(0);
    const restored = read.journal!.request;
    if (restored.kind !== "original") throw new Error("wrong fixture");
    for (const changed of [
      new File(["x".repeat(content.length)], file().name),
      new File([content], "other.txt"),
    ])
      await expect(restoreIntakeUploadFile(restored, changed)).rejects.toThrow("원래 파일");
    expect(send).toHaveBeenCalledTimes(2);
    const selected = await restoreIntakeUploadFile(restored, new File([content], file().name));
    if (selected.kind !== "original") throw new Error("wrong type");
    expect(selected.file.type).toBe(request.file.type);
    expect(selected.input).toEqual(request.input);
    const saved = await outbox().send(selected);
    expect(saved.sources).toHaveLength(1);
    expect(saved.sourceIntakes[0].original?.sha256).toBe(hash);
    expect(values.size).toBe(0);
  }, 30000);
  it("transmits the sealed copy even when the caller mutates its object during persistence", async () => {
    const request = create();
    const expected = structuredClone(request);
    storage.setItem = (key, value) => {
      values.set(key, value);
      if (request.kind === "command" && request.command.action === "create") {
        request.command.clientRequestId = randomUUID();
        request.command.files[0].originalName = "caller-mutated.txt";
      }
    };
    const saved = await outbox().send(request);
    expect(send).toHaveBeenCalledExactlyOnceWith(expected);
    expect(saved.sourceIntakes[0].declared.originalName).toBe("source.txt");
    expect(values.size).toBe(0);
  });
  it("does not replace any original command field or overtake an existing request with another action", async () => {
    const request = create();
    send.mockRejectedValueOnce(new Error("lost"));
    await expect(outbox().send(request)).rejects.toThrow();
    const retained = raw();
    const changed = structuredClone(request);
    if (changed.kind !== "command") throw new Error("fixture");
    changed.command.revision++;
    await expect(outbox().send(changed)).rejects.toThrow("먼저 보관");
    await expect(outbox().send(create())).rejects.toThrow("먼저 보관");
    const other = vi.fn();
    await expect(outbox().guard(other)).rejects.toThrow("먼저 보관");
    expect(other).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(raw()).toBe(retained);
  });
  it.each(["get", "set", "readback"])(
    "fails before transmission when storage %s fails",
    async (failure) => {
      if (failure === "get")
        storage.getItem = () => {
          throw new Error("blocked");
        };
      if (failure === "set")
        storage.setItem = () => {
          throw new Error("quota");
        };
      if (failure === "readback") storage.setItem = () => {};
      await expect(outbox().send(create())).rejects.toThrow("보관");
      expect(send).not.toHaveBeenCalled();
      expect(store.get(companyId).sourceIntakes).toHaveLength(0);
    },
  );
  it("retains a committed journal when removal fails and later resolves it without resending", async () => {
    storage.removeItem = () => {
      throw new Error("disk interrupted");
    };
    await expect(outbox().send(create())).rejects.toThrow("보관");
    expect(store.get(companyId).sourceIntakes).toHaveLength(1);
    storage.removeItem = (key) => {
      values.delete(key);
    };
    expect((await outbox().inspect(0)).journal).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("only releases a directly observed first-attempt refusal, retaining replay refusal after uncertainty", async () => {
    send.mockRejectedValueOnce(new IntakeHttpError("INTAKE_STALE", false));
    await expect(outbox().send(create())).rejects.toMatchObject({ accepted: false });
    expect(values.size).toBe(0);
    const request = create();
    send.mockRejectedValueOnce(new Error("unknown"));
    await expect(outbox().send(request)).rejects.toThrow();
    const retained = raw();
    send.mockRejectedValueOnce(new IntakeHttpError("INTAKE_STALE", false));
    await expect(outbox().send(request)).rejects.toMatchObject({ accepted: null });
    expect(raw()).toBe(retained);
    expect((await outbox().inspect(0)).journal).not.toBeNull();
  });
  it("never automatically sends a restored request on inspect, even when server revision has advanced", async () => {
    const request = create();
    send.mockRejectedValueOnce(new Error("unknown"));
    await expect(outbox().send(request)).rejects.toThrow();
    await commit(create());
    expect((await outbox().inspect(0)).journal).not.toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("blocks another tab through the entire server response and journal acknowledgement", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const observed = new Promise<void>((resolve) => {
      started = resolve;
    });
    send.mockImplementationOnce(async (request) => {
      started();
      await gate;
      return commit(request);
    });
    const running = outbox().send(create());
    await observed;
    await expect(outbox().send(create())).rejects.toThrow("다른 탭");
    await expect(outbox().inspect(0)).rejects.toThrow("다른 탭");
    release();
    await running;
    expect(send).toHaveBeenCalledTimes(1);
    expect(values.size).toBe(0);
  });
  it("coalesces same-panel effect replay without releasing a different tab lock or caching completed reads", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    status.mockImplementationOnce(async () => {
      await gate;
      return { company: store.get(companyId), activeItemIds: [] };
    });
    const samePanel = outbox();
    const first = samePanel.inspect(0),
      repeated = samePanel.inspect(0);
    await expect(outbox().inspect(0)).rejects.toThrow("다른 탭");
    release();
    expect(await repeated).toEqual(await first);
    expect(status).toHaveBeenCalledTimes(1);
    await samePanel.inspect(0);
    expect(status).toHaveBeenCalledTimes(2);
  });
  it("preserves a changed journal rather than clearing it after server success", async () => {
    send.mockImplementationOnce(async (request) => {
      const saved = await commit(request);
      values.set(intakeUploadOutboxKey(companyId), "changed-by-other-writer");
      return saved;
    });
    await expect(outbox().send(create())).rejects.toThrow("다른 탭");
    expect(raw()).toBe("changed-by-other-writer");
  });
  it.each(["hash", "company", "extra", "oversize"])(
    "rejects damaged journal %s without IO or replacement",
    async (damage) => {
      send.mockRejectedValueOnce(new Error("unknown"));
      await expect(outbox().send(create())).rejects.toThrow();
      const value = JSON.parse(raw());
      if (damage === "hash") value.request.command.files[0].sha256 = "b".repeat(64);
      if (damage === "company") value.companyId = randomUUID();
      if (damage === "extra") value.request.command.providerKey = "synthetic forbidden field";
      values.set(
        intakeUploadOutboxKey(companyId),
        damage === "oversize" ? " ".repeat(33000) : JSON.stringify(value),
      );
      const retained = raw();
      await expect(outbox().inspect(0)).rejects.toThrow("검증하지 못했습니다");
      expect(status).not.toHaveBeenCalled();
      expect(raw()).toBe(retained);
      expect(send).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects a same nonce receipt with different full command digest", async () => {
    const request = create();
    send.mockRejectedValueOnce(new Error("unknown"));
    await expect(outbox().send(request)).rejects.toThrow();
    await commit(request);
    const company = store.get(companyId);
    company.sourceIntakes[0].requests[0].inputDigest = "b".repeat(64);
    status.mockResolvedValueOnce({ company, activeItemIds: [] });
    const retained = raw();
    await expect(outbox().inspect(0)).rejects.toThrow("원래 요청");
    expect(raw()).toBe(retained);
  });
  it("retains original request when the status is stale, belongs to another company or has an active item", async () => {
    const request = await original();
    send.mockRejectedValueOnce(new Error("lost"));
    await expect(outbox().send(request)).rejects.toThrow();
    const company = store.get(companyId),
      retained = raw();
    status.mockResolvedValueOnce({ company: { ...company, revision: 0 }, activeItemIds: [] });
    await expect(outbox().inspect(company.revision)).rejects.toThrow();
    status.mockResolvedValueOnce({ company: { ...company, id: randomUUID() }, activeItemIds: [] });
    await expect(outbox().inspect(0)).rejects.toThrow();
    status.mockResolvedValueOnce({ company, activeItemIds: [request.itemId] });
    await expect(outbox().send(request)).rejects.toThrow("다른 탭");
    expect(raw()).toBe(retained);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("rejects invalid new declarations and local or external commands before storing", async () => {
    const request = create();
    if (request.kind !== "command" || request.command.action !== "create")
      throw new Error("fixture");
    delete request.command.files[0].sha256;
    await expect(outbox().send(request)).rejects.toThrow();
    await expect(
      outbox().send(
        intakeCommand({
          action: "run-next",
          revision: 0,
          clientRequestId: randomUUID(),
          itemId: randomUUID(),
          expectedItemVersion: 1,
          engine: "local-document",
        }),
      ),
    ).rejects.toThrow();
    expect(values.size).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});
