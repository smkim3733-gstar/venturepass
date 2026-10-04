import { z } from "zod";
import type { StudioCase } from "@/lib/studio-schema";
import { MAX_COMPANY_SOURCES, occupiedSourceSlots } from "@/lib/studio-source-limits";
import { createSourceIntakeSchema, sourceIntakeLimits } from "@/lib/studio-source-intake-types";
import { intakeFileSha256, intakeNonce, type IntakePending } from "./source-intakes-ui";
import {
  IntakeUploadOutbox,
  browserIntakeUploadOutbox,
  createIntakeUploadJournal,
  decodeIntakeUploadJournal,
  intakeUploadAcknowledged,
  restoreIntakeUploadFile,
  type IntakeUploadJournal,
} from "./source-intake-upload-outbox";

const uuid = z.string().uuid();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const declared = createSourceIntakeSchema.shape.files.element.extend({ sha256: sha });
const selectedSchema = declared
  .extend({
    originalNonce: uuid,
    mimeType: z.string().max(150),
  })
  .strict();
const queueSchema = z
  .object({
    queueVersion: z.literal(1),
    companyId: uuid,
    selectionId: uuid,
    files: z.array(selectedSchema).min(1).max(MAX_COMPANY_SOURCES),
    batches: z
      .array(z.object({ nonce: uuid, fileIds: z.array(uuid).min(1).max(10) }).strict())
      .min(1)
      .max(100),
    actions: z
      .array(z.object({ journal: z.unknown(), acknowledged: z.boolean() }).strict())
      .max(200),
    digest: sha,
  })
  .strict();
type Selected = z.infer<typeof selectedSchema>;
export type IntakeBulkQueue = Omit<z.infer<typeof queueSchema>, "actions"> & {
  actions: { journal: IntakeUploadJournal; acknowledged: boolean }[];
};
export type BulkFileState = "remaining" | "stored" | "confirmation" | "cancelled";
export type IntakeBulkView = {
  company: StudioCase;
  activeItemIds: string[];
  queue: IntakeBulkQueue | null;
  files: { clientFileId: string; name: string; size: number; state: BulkFileState }[];
  complete: boolean;
};
const messages = {
  STORAGE:
    "전체 선택 목록의 보관 상태를 확인하지 못했습니다. 추가 전송을 중단합니다. 같은 브라우저에서 원래 요청의 상태를 확인해 주세요.",
  CORRUPT:
    "전체 선택 목록의 신원을 확인하지 못했습니다. 기록을 덮어쓰거나 새 요청으로 바꾸지 않습니다.",
  CHANGED: "다른 화면에서 선택 목록이 바뀌었습니다. 기존 요청을 보존하고 상태 확인을 기다립니다.",
  BUSY: "다른 화면에서 이 회사의 자료를 처리하고 있습니다. 잠시 뒤 상태를 확인해 주세요.",
  EXISTING: "이전 선택 목록이나 접수 요청을 먼저 확인해 주세요. 새 목록으로 바꾸지 않았습니다.",
  FILE: "선택 목록과 이름·크기·내용이 같은 원래 파일을 다시 선택해 주세요. 다른 파일이나 중복 파일은 전송하지 않습니다.",
  CAPACITY:
    "저장 자료와 접수 예약은 회사당 100개까지입니다. 취소를 포함한 접수 이력 100개 한도도 별도로 확인해 주세요.",
  RESPONSE:
    "원래 선택 목록과 서버의 접수 기록이 일치하지 않습니다. 새 요청으로 다시 만들지 않습니다.",
  INCOMPLETE:
    "원본 보관을 모두 확인한 목록만 닫을 수 있습니다. 미확인 요청과 남은 파일을 먼저 확인해 주세요.",
} as const;
export class IntakeBulkQueueError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
  }
}
const fail = (code: keyof typeof messages): never => {
  throw new IntakeBulkQueueError(code);
};
export const intakeBulkQueueKey = (companyId: string) =>
  `venturepass:intake-bulk-queue:v1:${uuid.parse(companyId)}`;
const identical = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
async function digest(value: unknown) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function declaration(file: Selected) {
  return declared.parse({
    clientFileId: file.clientFileId,
    originalName: file.originalName,
    kind: file.kind,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
  });
}
/** Stable consecutive batches; the API's per-batch limits do not become company limits. */
function partition(files: Selected[]) {
  const batches: string[][] = [];
  let current: string[] = [],
    bytes = 0;
  for (const file of files) {
    if (
      current.length === sourceIntakeLimits.filesPerBatch ||
      bytes + file.sizeBytes > sourceIntakeLimits.batchBytes
    ) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file.clientFileId);
    bytes += file.sizeBytes;
  }
  if (current.length) batches.push(current);
  return batches;
}
function sequence(queue: IntakeBulkQueue) {
  return queue.batches.flatMap((batch) => [
    { kind: "create" as const, batch },
    ...batch.fileIds.map((id) => ({
      kind: "original" as const,
      batch,
      file: queue.files.find((file) => file.clientFileId === id)!,
    })),
  ]);
}
async function seal(value: Omit<IntakeBulkQueue, "digest">): Promise<IntakeBulkQueue> {
  return { ...value, digest: await digest(value) };
}
/** Checksums detect corruption; they are not authentication or a grant to transmit. */
export async function decodeIntakeBulkQueue(
  raw: string,
  companyId: string,
): Promise<IntakeBulkQueue> {
  try {
    if (new TextEncoder().encode(raw).length > 1024 * 1024) return fail("CORRUPT");
    const parsed = queueSchema.parse(JSON.parse(raw));
    const { digest: savedDigest, ...body } = parsed;
    if (parsed.companyId !== companyId || savedDigest !== (await digest(body)))
      return fail("CORRUPT");
    const nonces = [
      parsed.selectionId,
      ...parsed.files.flatMap((file) => [file.clientFileId, file.originalNonce]),
      ...parsed.batches.map((batch) => batch.nonce),
    ];
    const identities = parsed.files.map((file) =>
      JSON.stringify([file.originalName, file.sizeBytes, file.sha256]),
    );
    if (
      new Set(nonces).size !== nonces.length ||
      new Set(identities).size !== identities.length ||
      !identical(
        partition(parsed.files),
        parsed.batches.map((batch) => batch.fileIds),
      )
    )
      return fail("CORRUPT");
    const actions = [];
    for (const action of parsed.actions)
      actions.push({
        ...action,
        journal: await decodeIntakeUploadJournal(JSON.stringify(action.journal), companyId),
      });
    const queue = { ...parsed, actions };
    const steps = sequence(queue);
    if (actions.length > steps.length) return fail("CORRUPT");
    for (const [index, action] of actions.entries()) {
      if (!action.acknowledged && index !== actions.length - 1) return fail("CORRUPT");
      const step = steps[index],
        request = action.journal.request;
      if (step.kind === "create") {
        if (
          request.kind !== "command" ||
          request.command.clientRequestId !== step.batch.nonce ||
          !identical(
            request.command.files,
            step.batch.fileIds.map((id) =>
              declaration(queue.files.find((file) => file.clientFileId === id)!),
            ),
          )
        )
          return fail("CORRUPT");
      } else {
        if (
          request.kind !== "original" ||
          request.input.clientRequestId !== step.file.originalNonce ||
          request.file.name !== step.file.originalName ||
          request.file.size !== step.file.sizeBytes ||
          request.file.type !== step.file.mimeType ||
          request.sha256 !== step.file.sha256
        )
          return fail("CORRUPT");
      }
    }
    return queue;
  } catch {
    return fail("CORRUPT");
  }
}

type Dependencies = {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  exclusive: <T>(work: () => Promise<T>) => Promise<T>;
  outbox: IntakeUploadOutbox;
};
/** Metadata-only selection journal. No File bytes, extracted text, review approval or AI command.
 * The selection lock surrounds the whole operation; the existing company outbox lock still
 * surrounds every actual API request. A stale server revision is never silently refreshed.
 */
export class IntakeBulkUploadQueue {
  readonly key: string;
  constructor(
    readonly companyId: string,
    private readonly deps: Dependencies,
  ) {
    this.key = intakeBulkQueueKey(companyId);
    if (deps.outbox.companyId !== companyId) fail("RESPONSE");
  }
  private raw() {
    try {
      return this.deps.storage.getItem(this.key);
    } catch {
      return fail("STORAGE");
    }
  }
  private assertRaw(expected: string | null) {
    if (this.raw() !== expected) fail("CHANGED");
  }
  private async save(queue: IntakeBulkQueue, expected: string | null) {
    const body = {
      queueVersion: queue.queueVersion,
      companyId: queue.companyId,
      selectionId: queue.selectionId,
      files: queue.files,
      batches: queue.batches,
      actions: queue.actions,
    };
    const next = await seal(body),
      raw = JSON.stringify(next);
    await decodeIntakeBulkQueue(raw, this.companyId);
    this.assertRaw(expected);
    try {
      this.deps.storage.setItem(this.key, raw);
      if (this.raw() !== raw) fail("STORAGE");
    } catch {
      return fail("STORAGE");
    }
    return next;
  }
  private capacity(company: StudioCase, remaining: number) {
    if (
      occupiedSourceSlots(company) + remaining > MAX_COMPANY_SOURCES ||
      company.sourceIntakes.length + remaining > sourceIntakeLimits.items
    )
      fail("CAPACITY");
  }
  async begin(files: readonly File[], kind: Selected["kind"] = "other") {
    const chosen = [...files];
    return this.deps.exclusive(async () => {
      if (this.raw() !== null) return fail("EXISTING");
      // Zero attachments is a valid company workflow, but needs no upload journal.
      if (!chosen.length) return null;
      if (chosen.length > MAX_COMPANY_SOURCES) return fail("CAPACITY");
      const selected: Selected[] = [];
      // Validate every name/size before reading any body, then hash only one bounded file at a time.
      for (const file of chosen)
        declared.parse({
          clientFileId: crypto.randomUUID(),
          originalName: file.name,
          sizeBytes: file.size,
          kind,
          sha256: "0".repeat(64),
        });
      for (const file of chosen)
        selected.push(
          selectedSchema.parse({
            clientFileId: crypto.randomUUID(),
            originalNonce: crypto.randomUUID(),
            originalName: file.name,
            sizeBytes: file.size,
            kind,
            mimeType: file.type,
            sha256: await intakeFileSha256(file),
          }),
        );
      const queue = await seal({
        queueVersion: 1,
        companyId: this.companyId,
        selectionId: crypto.randomUUID(),
        files: selected,
        batches: partition(selected).map((fileIds) => ({ nonce: crypto.randomUUID(), fileIds })),
        actions: [],
      });
      await decodeIntakeBulkQueue(JSON.stringify(queue), this.companyId);
      const snapshot = await this.deps.outbox.inspect(0);
      if (snapshot.journal || snapshot.activeItemIds.length) return fail("EXISTING");
      this.capacity(snapshot.company, selected.length);
      return this.save(queue, null);
    });
  }
  private async inspectLocked(minimumRevision = 0): Promise<IntakeBulkView> {
    const raw = this.raw();
    let queue = raw === null ? null : await decodeIntakeBulkQueue(raw, this.companyId);
    const snapshot = await this.deps.outbox.inspect(minimumRevision);
    this.assertRaw(raw);
    if (!queue) {
      if (snapshot.journal) return fail("EXISTING");
      return { ...snapshot, queue: null, files: [], complete: false };
    }
    const last = queue.actions.at(-1);
    if (snapshot.journal && (!last || !identical(last.journal, snapshot.journal)))
      return fail("EXISTING");
    let changed = false;
    for (const action of queue.actions) {
      const acknowledged = intakeUploadAcknowledged(
        snapshot.company,
        this.companyId,
        action.journal,
      );
      if (action.acknowledged && !acknowledged) return fail("RESPONSE");
      if (acknowledged && !action.acknowledged) {
        action.acknowledged = true;
        changed = true;
      }
    }
    // A matching client ID alone is not a receipt. Bind every server item to the complete
    // original declaration command, including the stable batch nonce and content hashes.
    for (const batch of queue.batches) {
      const action = queue.actions.find(
        (action) => intakeNonce(action.journal.request) === batch.nonce,
      );
      const items = snapshot.company.sourceIntakes.filter((item) =>
        batch.fileIds.includes(item.clientFileId),
      );
      if (items.length && (!action?.acknowledged || items.length !== batch.fileIds.length))
        return fail("RESPONSE");
      if (action?.acknowledged) {
        const first = items.find((item) =>
          item.requests.some((receipt) => receipt.clientRequestId === batch.nonce),
        );
        if (!first || items.some((item) => item.batchId !== first.batchId)) return fail("RESPONSE");
      }
    }
    const files = queue.files.map((file) => {
      const matches = snapshot.company.sourceIntakes.filter(
        (item) => item.clientFileId === file.clientFileId,
      );
      if (matches.length > 1) return fail("RESPONSE");
      const item = matches[0];
      const original = queue!.actions.find(
        (action) => intakeNonce(action.journal.request) === file.originalNonce,
      );
      if (
        original &&
        (original.journal.request.kind !== "original" ||
          original.journal.request.itemId !== item?.id)
      )
        return fail("RESPONSE");
      if (
        item?.original &&
        (item.original.sha256 !== file.sha256 || item.original.sizeBytes !== file.sizeBytes)
      )
        return fail("RESPONSE");
      const source = item && snapshot.company.sources.find((entry) => entry.id === item.sourceId);
      let state: BulkFileState = "remaining";
      if (item?.phase === "cancelled") state = "cancelled";
      else if (
        item?.original &&
        original?.acknowledged &&
        source &&
        item.phase !== "storing_original"
      )
        state = "stored";
      else if (
        item?.original ||
        original ||
        (last &&
          !last.acknowledged &&
          last.journal.request.kind === "command" &&
          last.journal.request.command.files.some(
            (entry) => entry.clientFileId === file.clientFileId,
          ))
      )
        state = "confirmation";
      return {
        clientFileId: file.clientFileId,
        name: file.originalName,
        size: file.sizeBytes,
        state,
      };
    });
    if (changed) queue = await this.save(queue, raw);
    return {
      company: snapshot.company,
      activeItemIds: snapshot.activeItemIds,
      queue,
      files,
      complete:
        queue.actions.length === sequence(queue).length &&
        queue.actions.every((action) => action.acknowledged) &&
        files.every((file) => file.state === "stored"),
    };
  }
  inspect(minimumRevision = 0) {
    return this.deps.exclusive(() => this.inspectLocked(minimumRevision));
  }
  private async match(queue: IntakeBulkQueue, files: readonly File[]) {
    const selected = new Map<string, File>();
    for (const file of files) {
      const candidates = queue.files.filter(
        (entry) => entry.originalName === file.name && entry.sizeBytes === file.size,
      );
      if (!candidates.length) return fail("FILE");
      const hash = await intakeFileSha256(file);
      const matches = candidates.filter((entry) => entry.sha256 === hash);
      if (matches.length !== 1 || selected.has(matches[0].clientFileId)) return fail("FILE");
      selected.set(
        matches[0].clientFileId,
        new File([file], file.name, { type: matches[0].mimeType }),
      );
    }
    return selected;
  }
  /** Explicit user continuation only. Reads never call this method or recreate a lost File. */
  async run(
    files: readonly File[],
    options: {
      onProgress?: (view: IntakeBulkView) => void;
      shouldContinue?: () => boolean;
    } = {},
  ): Promise<IntakeBulkView> {
    const chosen = [...files];
    return this.deps.exclusive(async () => {
      let view = await this.inspectLocked();
      if (!view.queue || view.complete) return view;
      const selected = await this.match(view.queue, chosen);
      for (let iteration = 0; iteration < 200; iteration++) {
        if (options.shouldContinue && !options.shouldContinue()) return view;
        if (view.activeItemIds.length) return fail("BUSY");
        if (
          view.files.some((file) => file.state === "cancelled") ||
          view.files.some(
            (file) =>
              file.state === "confirmation" &&
              view.queue!.actions.some(
                (action) =>
                  action.acknowledged &&
                  action.journal.request.kind === "original" &&
                  action.journal.request.input.clientRequestId ===
                    view.queue!.files.find((entry) => entry.clientFileId === file.clientFileId)!
                      .originalNonce,
              ),
          )
        )
          return view;
        const queue = view.queue!;
        const raw = this.raw();
        if (raw === null || !identical(await decodeIntakeBulkQueue(raw, this.companyId), queue))
          return fail("CHANGED");
        let action = queue.actions.at(-1);
        if (!action || action.acknowledged) {
          const step = sequence(queue)[queue.actions.length];
          if (!step) return view;
          let request: IntakeUploadJournal["request"];
          if (step.kind === "create") {
            // An untouched later batch waits for the actual reselected Files.
            if (step.batch.fileIds.some((id) => !selected.has(id))) return view;
            const unregistered = queue.files.filter(
              (file) =>
                !view.company.sourceIntakes.some((item) => item.clientFileId === file.clientFileId),
            ).length;
            this.capacity(view.company, unregistered);
            request = {
              kind: "command",
              command: createSourceIntakeSchema.parse({
                action: "create",
                revision: view.company.revision,
                clientRequestId: step.batch.nonce,
                files: step.batch.fileIds.map((id) =>
                  declaration(queue.files.find((file) => file.clientFileId === id)!),
                ),
              }),
            };
          } else {
            const file = selected.get(step.file.clientFileId);
            if (!file) return view;
            const item = view.company.sourceIntakes.find(
              (item) => item.clientFileId === step.file.clientFileId,
            );
            if (!item || item.phase !== "awaiting_original" || item.original)
              return fail("RESPONSE");
            request = {
              kind: "original",
              itemId: item.id,
              input: {
                revision: view.company.revision,
                clientRequestId: step.file.originalNonce,
                expectedItemVersion: item.version,
              },
              file: { name: file.name, size: file.size, type: step.file.mimeType },
              sha256: step.file.sha256,
            };
          }
          action = {
            journal: await createIntakeUploadJournal(this.companyId, request),
            acknowledged: false,
          };
          queue.actions.push(action);
          view.queue = await this.save(queue, raw);
          action = view.queue.actions.at(-1)!;
        }
        const request = action.journal.request;
        let transmission: IntakePending;
        if (request.kind === "original") {
          const metadata = queue.files.find(
            (file) => file.originalNonce === request.input.clientRequestId,
          )!;
          const file = selected.get(metadata.clientFileId);
          if (!file) return view;
          transmission = await restoreIntakeUploadFile(request, file);
        } else transmission = request;
        // Both the entire selection and this exact command are durable before the old outbox sends.
        this.assertRaw(JSON.stringify(view.queue));
        await this.deps.outbox.send(transmission);
        view = await this.inspectLocked();
        options.onProgress?.(structuredClone(view));
        if (view.complete) return view;
      }
      return fail("RESPONSE");
    });
  }
  async clearCompleted() {
    return this.deps.exclusive(async () => {
      const view = await this.inspectLocked();
      if (!view.queue || !view.complete) return fail("INCOMPLETE");
      this.assertRaw(JSON.stringify(view.queue));
      try {
        this.deps.storage.removeItem(this.key);
        if (this.raw() !== null) fail("STORAGE");
      } catch {
        return fail("STORAGE");
      }
    });
  }
  async discardUnsent() {
    return this.deps.exclusive(async () => {
      const view = await this.inspectLocked();
      if (
        !view.queue ||
        view.queue.actions.length ||
        view.files.some((file) => file.state !== "remaining")
      )
        return fail("INCOMPLETE");
      this.assertRaw(JSON.stringify(view.queue));
      try {
        this.deps.storage.removeItem(this.key);
        if (this.raw() !== null) fail("STORAGE");
      } catch {
        return fail("STORAGE");
      }
    });
  }
}
export function browserIntakeBulkUploadQueue(companyId: string) {
  if (!window.isSecureContext || !navigator.locks?.request || !crypto.subtle)
    return fail("STORAGE");
  return new IntakeBulkUploadQueue(companyId, {
    storage: window.localStorage,
    outbox: browserIntakeUploadOutbox(companyId),
    exclusive: async (work) =>
      await navigator.locks.request(
        intakeBulkQueueKey(companyId),
        { mode: "exclusive", ifAvailable: true },
        (lock) => (lock ? work() : fail("BUSY")),
      ),
  });
}
