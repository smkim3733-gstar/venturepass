import { z } from "zod";
import { caseSchema, planContentSchema, type StudioCase } from "@/lib/studio-schema";
import { manualPlanSaveSnapshot, type ManualPlanSave } from "./manual-plan-save";
import {
  publicEvidenceBrowserLock,
  publicEvidenceBrowserStorage,
  PublicEvidenceRecoveryError,
} from "./public-evidence-recovery";

type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Lock = <T>(name: string, task: () => Promise<T>) => Promise<T>;
type Current = () => Pick<StudioCase, "id" | "revision">;
type Command = ManualPlanSave["mutation"] & { revision: number };
type Transport = (command?: Command) => Promise<unknown>;
const receiptSchema = z
  .object({
    format: z.literal("manual-plan-v1"),
    caseId: z.string().uuid(),
    planId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    nextVersion: z.number().int().positive(),
    previousDigest: z.string().regex(/^[a-f0-9]{64}$/),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ManualPlanReceipt = z.infer<typeof receiptSchema>;
const messages = {
  unconfirmed:
    "수정본 저장 여부를 아직 확인하지 못했습니다. 원래 요청을 유지하며 다시 저장하지 않습니다. 저장 상태를 확인해 주세요.",
  storage:
    "브라우저에서 수정본 복구 기록을 읽거나 보관하지 못했습니다. 새 저장을 멈췄습니다. 브라우저 저장소를 확인한 뒤 복구 기록을 다시 확인해 주세요.",
  busy: "다른 창에서 이 회사의 수정본을 저장하거나 확인 중입니다. 처리가 끝나면 다시 확인해 주세요.",
  unavailable:
    "이 브라우저에서는 수정본 복구 기록을 안전하게 보관할 수 없습니다. 사용하던 브라우저에서 다시 확인해 주세요.",
} as const;
type Failure = keyof typeof messages;
export class ManualPlanRecoveryError extends Error {
  constructor(readonly reason: Failure) {
    super(messages[reason]);
  }
}
export function manualPlanRecoveryMessage(error: unknown) {
  return error instanceof ManualPlanRecoveryError ? messages[error.reason] : messages.unconfirmed;
}
const fail = (): never => {
  throw new ManualPlanRecoveryError("unconfirmed");
};
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function storageAccess<T>(task: () => T): T {
  try {
    return task();
  } catch {
    throw new ManualPlanRecoveryError("storage");
  }
}
async function digest(value: unknown) {
  if (!globalThis.crypto?.subtle) throw new ManualPlanRecoveryError("unavailable");
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
function normalize(raw: ManualPlanSave): ManualPlanSave {
  if (raw.mutation.action !== "save-plan") fail();
  return {
    company: caseSchema.parse(raw.company),
    mutation: {
      action: "save-plan",
      planId: z.string().uuid().parse(raw.mutation.planId),
      content: planContentSchema.parse(raw.mutation.content),
    },
  };
}
async function receipt(request: ManualPlanSave): Promise<ManualPlanReceipt> {
  const base = request.company;
  if (base.plans.filter((p) => p.id === request.mutation.planId).length !== 1) fail();
  const identity = {
    format: "manual-plan-v1" as const,
    caseId: base.id,
    planId: request.mutation.planId,
    revision: base.revision,
    nextVersion: Math.max(0, ...base.plans.map((p) => p.version)) + 1,
    previousDigest: await digest([...base.plans].sort((a, b) => a.id.localeCompare(b.id))),
  };
  // Bind scope and every content field without persisting titles, text, evidence or responses.
  // Local digests are comparison aids, not server receipts or an authentication boundary.
  return receiptSchema.parse({
    ...identity,
    contentDigest: await digest([identity, request.mutation.content]),
  });
}
export const manualPlanRecoveryKey = (caseId: string) => `venturepass:manual-plan:v1:${caseId}`;

/** Browser identity journal. Recovery only GETs; it never replays a save-plan command. */
export class ManualPlanJournal {
  readonly key: string;
  constructor(
    readonly caseId: string,
    private storage: StoragePort,
    private lock: Lock,
    private transport: Transport,
  ) {
    z.string().uuid().parse(caseId);
    this.key = manualPlanRecoveryKey(caseId);
  }
  private pending() {
    const text = storageAccess(() => this.storage.getItem(this.key));
    if (text === null) return null;
    if (text.length > 1024) fail();
    const parsed = receiptSchema.parse(JSON.parse(text));
    if (parsed.caseId !== this.caseId) fail();
    return parsed;
  }
  async read() {
    return this.pending();
  }
  private async accept(
    raw: unknown,
    expected: ManualPlanReceipt,
    current: Current,
    storedAtStart: ManualPlanReceipt | null,
  ) {
    const next = caseSchema.parse(raw);
    const versions = next.plans.filter((p) => p.version === expected.nextVersion);
    if (next.id !== expected.caseId || versions.length !== 1) fail();
    // Reconstruct only from the response, then prove the original set and requested
    // contents by their bound digests. Reuse the full existing saved-version checks.
    const request: ManualPlanSave = {
      company: {
        ...next,
        revision: expected.revision,
        plans: next.plans.filter((p) => p.version < expected.nextVersion),
      },
      mutation: { action: "save-plan", planId: expected.planId, content: versions[0].content },
    };
    const accepted = manualPlanSaveSnapshot(next, request);
    if (!equal(await receipt(request), expected)) fail();
    const now = current();
    if (
      now.id !== this.caseId ||
      accepted.revision < now.revision ||
      !equal(this.pending(), storedAtStart)
    )
      fail();
    // A completed other tab can leave this tab holding the original identity.
    // Missing storage alone never acknowledges the save or recreates a receipt.
    if (storedAtStart !== null) {
      storageAccess(() => this.storage.removeItem(this.key));
      if (storageAccess(() => this.storage.getItem(this.key)) !== null)
        throw new ManualPlanRecoveryError("storage");
    }
    return accepted;
  }
  save(raw: ManualPlanSave, current: Current, onPending: (value: ManualPlanReceipt) => void) {
    const request = normalize(structuredClone(raw));
    return this.lock(this.key, async () => {
      if (request.company.id !== this.caseId || this.pending()) fail();
      const original = await receipt(request);
      const now = current();
      if (now.id !== this.caseId || now.revision !== original.revision || this.pending()) fail();
      storageAccess(() => this.storage.setItem(this.key, JSON.stringify(original)));
      if (!equal(this.pending(), original)) throw new ManualPlanRecoveryError("storage");
      onPending(original);
      // Exactly one explicit PATCH; errors retain the identity with no automatic GET.
      return this.accept(
        await this.transport({ ...request.mutation, revision: original.revision }),
        original,
        current,
        original,
      );
    });
  }
  recover(raw: ManualPlanReceipt, current: Current) {
    const original = receiptSchema.parse(structuredClone(raw));
    return this.lock(this.key, async () => {
      const storedAtStart = this.pending();
      if (
        original.caseId !== this.caseId ||
        current().id !== this.caseId ||
        (storedAtStart !== null && !equal(storedAtStart, original))
      )
        fail();
      return this.accept(await this.transport(), original, current, storedAtStart);
    });
  }
}
export function manualPlanBrowserStorage() {
  return storageAccess(publicEvidenceBrowserStorage);
}
export const manualPlanBrowserLock: Lock = async (name, task) => {
  try {
    return await publicEvidenceBrowserLock(name, task);
  } catch (error) {
    if (
      error instanceof PublicEvidenceRecoveryError &&
      (error.reason === "busy" || error.reason === "unavailable")
    )
      throw new ManualPlanRecoveryError(error.reason);
    throw error;
  }
};
