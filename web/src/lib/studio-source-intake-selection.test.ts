import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import { emptyProfile } from "./studio-schema";
import { intakeDigest, intakeSha, newSourceIntakeBatch } from "./studio-source-intake";
import {
  createSourceIntakeSchema,
  sourceIntakeItemSchema,
  type SourceIntakeItem,
} from "./studio-source-intake-types";
import {
  intakeCommand,
  intakeFileSha256,
  intakeRequestAcknowledged,
  intakeRecoverySummary,
  intakeSelectionMatches,
} from "../components/studio/source-intakes-ui";

const bytes = Buffer.from("abc");
const sha256 = intakeSha(bytes);
function command(revision = 0, count = 1) {
  return createSourceIntakeSchema.parse({
    action: "create",
    revision,
    clientRequestId: randomUUID(),
    files: Array.from({ length: count }, (_, i) => ({
      clientFileId: randomUUID(),
      originalName: `sample-${i}.txt`,
      kind: "technology",
      sizeBytes: 3,
      sha256,
    })),
  });
}
function selected(item: SourceIntakeItem, text = "abc") {
  return new File([text], item.declared.originalName, { type: "text/plain" });
}
describe("durable selection identity", () => {
  afterEach(() => vi.restoreAllMocks());
  it("hashes actual bytes and rejects equal-size changed content before sending", async () => {
    const item = newSourceIntakeBatch(command())[0];
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network"));
    expect(await intakeFileSha256(selected(item))).toBe(sha256);
    expect(await intakeSelectionMatches(item, selected(item))).toBe(sha256);
    expect(await intakeSelectionMatches(item, selected(item, "xyz"))).toBeNull();
    expect(await intakeSelectionMatches(item, new File(["abc"], "other.txt"))).toBeNull();
    expect(await intakeSelectionMatches(item, selected(item, "longer"))).toBeNull();
    expect(network).not.toHaveBeenCalled();
  });
  it("bounds hashing before reading and does not suppress a read failure", async () => {
    const read = vi.fn();
    await expect(
      intakeFileSha256({
        name: "large.txt",
        size: 12 * 1024 * 1024 + 1,
        arrayBuffer: read,
      } as unknown as File),
    ).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    const item = newSourceIntakeBatch(command())[0],
      file = selected(item);
    vi.spyOn(file, "arrayBuffer").mockRejectedValue(new Error("read interrupted"));
    await expect(intakeSelectionMatches(item, file)).rejects.toThrow("read interrupted");
  });
  it.each([null, "", "A".repeat(64), "a".repeat(63)])(
    "rejects malformed declared hash %s",
    (value) => {
      const input = command();
      expect(
        createSourceIntakeSchema.safeParse({
          ...input,
          files: [{ ...input.files[0], sha256: value }],
        }).success,
      ).toBe(false);
    },
  );
  it("legacy declarations retain their exact JSON and digest without inventing hashes", async () => {
    const input = command();
    delete input.files[0].sha256;
    const original = JSON.stringify(input);
    expect(JSON.stringify(createSourceIntakeSchema.parse(input))).toBe(original);
    expect(intakeDigest(createSourceIntakeSchema.parse(input))).toBe(intakeDigest(input));
    const item = newSourceIntakeBatch(input)[0];
    expect(item.declared).not.toHaveProperty("sha256");
    expect(sourceIntakeItemSchema.parse(item)).toEqual(item);
    expect(await intakeSelectionMatches(item, selected(item))).toBe(sha256);
    expect(item.declared).not.toHaveProperty("sha256");
  });
  it("rejects a preserved original inconsistent with the declared selection", () => {
    const item = newSourceIntakeBatch(command())[0];
    item.original = {
      originalName: item.declared.originalName,
      sizeBytes: 3,
      mimeType: "text/plain",
      sha256: intakeSha("xyz"),
      sourceUpdatedAt: item.createdAt,
    };
    expect(sourceIntakeItemSchema.safeParse(item).success).toBe(false);
    item.original.sha256 = sha256;
    expect(sourceIntakeItemSchema.safeParse(item).success).toBe(true);
  });
  it("separates unknown work, missing File, stored original and cancelled history", () => {
    const items = newSourceIntakeBatch(command(0, 6));
    items[1].phase = "storing_original";
    items[2].phase = "extracting_local";
    items[3].phase = "external_result_unknown";
    items[4].phase = "original_stored";
    items[4].original = {
      originalName: items[4].declared.originalName,
      sizeBytes: 3,
      mimeType: null,
      sha256,
      sourceUpdatedAt: items[4].createdAt,
    };
    items[5].phase = "cancelled";
    expect(intakeRecoverySummary(items)).toEqual({
      stored: 1,
      awaiting: 1,
      check: 3,
      cancelled: 1,
    });
    expect(intakeRecoverySummary([])).toEqual({ stored: 0, awaiting: 0, check: 0, cancelled: 0 });
  });
});

describe(
  "selection identity across SQLite interruption and reselection",
  { timeout: 60_000 },
  () => {
    let store: StudioStore | undefined;
    let root = "";
    afterEach(() => {
      vi.restoreAllMocks();
      store?.close();
      if (!root) return;
      const delta = relative(resolve(tmpdir()), resolve(root));
      if (isAbsolute(delta) || delta.startsWith("..") || !delta.startsWith("venture-selection-"))
        throw new Error("unsafe fixture cleanup");
      rmSync(root, { recursive: true, force: true });
      root = "";
    });
    function setup(count = 1) {
      root = mkdtempSync(join(tmpdir(), "venture-selection-"));
      store = new StudioStore(root);
      const company = store.create({ ...emptyProfile(), companyName: "합성 재선택 검사" });
      const input = command(company.revision, count);
      const response = store.createSourceIntakeBatch(company.id, input);
      return { company: response.company, input };
    }
    function upload(
      companyId: string,
      item: SourceIntakeItem,
      content = bytes,
      nonce = randomUUID(),
    ) {
      const input = {
        revision: store!.get(companyId).revision,
        expectedItemVersion: item.version,
        clientRequestId: nonce,
      };
      const original = {
        name: item.declared.originalName,
        mimeType: "text/plain",
        buffer: content,
      };
      return {
        input,
        original,
        response: store!.storeSourceIntakeOriginal(companyId, item.id, input, original),
      };
    }
    function reopen() {
      store!.close();
      store = new StudioStore(root);
    }
    it("preserves a legacy completed item and request bytes when a hash-bound reservation is appended", () => {
      root = mkdtempSync(join(tmpdir(), "venture-selection-"));
      store = new StudioStore(root);
      const company = store.create({ ...emptyProfile(), companyName: "합성 이전 이력 보존" });
      const legacy = command(company.revision);
      delete legacy.files[0].sha256;
      const created = store.createSourceIntakeBatch(company.id, legacy);
      const saved = upload(company.id, created.company.sourceIntakes[0]).response;
      const prefix = JSON.stringify(saved.item),
        source = JSON.stringify(saved.company.sources[0]);
      reopen();
      store!.createSourceIntakeBatch(company.id, command(saved.company.revision));
      const mixed = store!.get(company.id);
      expect(JSON.stringify(mixed.sourceIntakes[0])).toBe(prefix);
      expect(JSON.stringify(mixed.sources[0])).toBe(source);
      expect(mixed.sourceIntakes[0].declared).not.toHaveProperty("sha256");
      expect(mixed.sourceIntakes[1].declared.sha256).toBe(sha256);
      const before = JSON.stringify(mixed);
      store!.createSourceIntakeBatch(company.id, legacy);
      expect(JSON.stringify(store!.get(company.id))).toBe(before);
    });
    it("rejects same-name same-size changed bytes without a checkpoint, file or receipt", () => {
      const { company } = setup();
      const item = company.sourceIntakes[0];
      reopen();
      const before = JSON.stringify(store!.get(company.id));
      expect(() => upload(company.id, item, Buffer.from("xyz"))).toThrow(
        expect.objectContaining({ code: "INTAKE_SELECTION_MISMATCH" }),
      );
      expect(JSON.stringify(store!.get(company.id))).toBe(before);
      expect(existsSync(join(root, "originals", company.id, `${item.sourceId}.bin`))).toBe(false);
      expect(upload(company.id, item).response.item?.original?.sha256).toBe(sha256);
    });
    it("preserves exact create/original nonce after lost responses and rejects altered selection", () => {
      const { company, input } = setup();
      const item = company.sourceIntakes[0];
      const saved = upload(company.id, item);
      reopen();
      const before = JSON.stringify(store!.get(company.id));
      expect(store!.createSourceIntakeBatch(company.id, { ...input, revision: 0 }).batchId).toBe(
        item.batchId,
      );
      expect(
        store!.storeSourceIntakeOriginal(company.id, item.id, saved.input, saved.original),
      ).toEqual(saved.response);
      const changed = structuredClone(input);
      changed.files[0].sha256 = intakeSha("xyz");
      expect(() => store!.createSourceIntakeBatch(company.id, changed)).toThrow(
        expect.objectContaining({ code: "INTAKE_NONCE_CONFLICT" }),
      );
      expect(JSON.stringify(store!.get(company.id))).toBe(before);
      expect(
        intakeRequestAcknowledged(saved.response.company, company.id, intakeCommand(input)),
      ).toBe(true);
      expect(
        intakeRequestAcknowledged(saved.response.company, company.id, intakeCommand(changed)),
      ).toBe(false);
      expect(
        intakeRequestAcknowledged(saved.response.company, company.id, {
          kind: "original",
          itemId: item.id,
          input: saved.input,
          file: selected(item),
          sha256: intakeSha("xyz"),
        }),
      ).toBe(false);
    });
    it.each(["before-file", "after-file"])(
      "keeps byte identity through %s interruption, read-only reopen and explicit resume",
      (when) => {
        const { company } = setup();
        const item = company.sourceIntakes[0];
        const spy =
          when === "before-file"
            ? vi.spyOn(
                store! as unknown as { writeIntakeOriginal: () => void },
                "writeIntakeOriginal",
              )
            : vi.spyOn(
                store! as unknown as { readIntakeCheckpoint: () => never },
                "readIntakeCheckpoint",
              );
        spy.mockImplementation(() => {
          throw new Error("synthetic stop");
        });
        expect(() => upload(company.id, item)).toThrow("synthetic stop");
        spy.mockRestore();
        const checkpoint = store!.get(company.id);
        reopen();
        expect(store!.get(company.id)).toEqual(checkpoint);
        expect(intakeRecoverySummary(checkpoint.sourceIntakes).check).toBe(1);
        const current = checkpoint.sourceIntakes[0];
        const response = store!.resumeSourceIntakeOriginal(company.id, {
          action: "resume",
          revision: checkpoint.revision,
          expectedItemVersion: current.version,
          itemId: item.id,
          clientRequestId: randomUUID(),
        });
        expect(response.item?.declared.sha256).toBe(sha256);
        if (when === "before-file") {
          expect(response.item?.phase).toBe("awaiting_original");
          expect(() => upload(company.id, response.item!, Buffer.from("xyz"))).toThrow(
            expect.objectContaining({ code: "INTAKE_SELECTION_MISMATCH" }),
          );
          expect(upload(company.id, response.item!).response.item?.phase).toBe("original_stored");
        } else {
          expect(response.item?.phase).toBe("original_stored");
          expect(store!.originalForVentureInput(company.id, item.sourceId).buffer).toEqual(bytes);
        }
      },
    );
    it("keeps 100 declared identities and earlier originals when the next upload is interrupted", () => {
      const { company } = setup(10);
      for (let i = 1; i < 10; i++)
        store!.createSourceIntakeBatch(company.id, command(store!.get(company.id).revision, 10));
      const items = store!.get(company.id).sourceIntakes;
      upload(company.id, items[0]);
      upload(company.id, items[1]);
      const spy = vi
        .spyOn(store! as unknown as { writeIntakeOriginal: () => void }, "writeIntakeOriginal")
        .mockImplementation(() => {
          throw new Error("synthetic interruption");
        });
      expect(() => upload(company.id, items[2])).toThrow();
      spy.mockRestore();
      const before = store!.get(company.id);
      reopen();
      const after = store!.get(company.id);
      expect(after).toEqual(before);
      expect(intakeRecoverySummary(after.sourceIntakes)).toEqual({
        stored: 2,
        awaiting: 97,
        check: 1,
        cancelled: 0,
      });
      expect(after.sourceIntakes.every((entry) => entry.declared.sha256 === sha256)).toBe(true);
      expect(after.sourceIntakes.map((entry) => entry.clientFileId)).toEqual(
        items.map((entry) => entry.clientFileId),
      );
      for (const item of items.slice(0, 2))
        expect(store!.originalForVentureInput(company.id, item.sourceId).buffer).toEqual(bytes);
    });
  },
);
