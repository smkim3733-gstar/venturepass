import { z } from "zod";
import { caseSchema, type StudioCase } from "@/lib/studio-schema";
import {
  planConfirmationSnapshot,
  planConfirmationMessage,
  type PlanConfirmation,
} from "./plan-confirmation";
import {
  publicEvidenceBrowserLock,
  publicEvidenceBrowserStorage,
  PublicEvidenceRecoveryError,
} from "./public-evidence-recovery";

type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Lock = <T>(name: string, task: () => Promise<T>) => Promise<T>;
type Current = () => Pick<StudioCase, "id" | "revision">;
type Command = { action: "confirm-plan"; planId: string; revision: number };
type Transport = (command?: Command) => Promise<unknown>;
const receiptSchema = z
  .object({
    format: z.literal("plan-confirmation-v1"),
    caseId: z.string().uuid(),
    planId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    version: z.number().int().positive(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type PlanConfirmationReceipt = z.infer<typeof receiptSchema>;
const messages = {
  unconfirmed: planConfirmationMessage,
  storage:
    "브라우저에서 검토 완료 복구 기록을 읽거나 보관하지 못했습니다. 새 저장을 멈췄습니다. 브라우저 저장소를 확인한 뒤 복구 기록을 다시 확인해 주세요.",
  busy: "다른 창에서 이 회사의 검토 완료를 저장하거나 확인 중입니다. 처리가 끝나면 다시 확인해 주세요.",
  unavailable:
    "이 브라우저에서는 검토 완료 복구 기록을 안전하게 보관할 수 없습니다. 사용하던 브라우저에서 다시 확인해 주세요.",
} as const;
type Failure = keyof typeof messages;
export class PlanConfirmationRecoveryError extends Error {
  constructor(readonly reason: Failure) {
    super(messages[reason]);
  }
}
export function planConfirmationRecoveryMessage(error: unknown) {
  return error instanceof PlanConfirmationRecoveryError
    ? messages[error.reason]
    : messages.unconfirmed;
}
const fail = (): never => {
  throw new PlanConfirmationRecoveryError("unconfirmed");
};
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function storageAccess<T>(task: () => T): T {
  try {
    return task();
  } catch {
    throw new PlanConfirmationRecoveryError("storage");
  }
}
async function digest(value: unknown) {
  if (!globalThis.crypto?.subtle) throw new PlanConfirmationRecoveryError("unavailable");
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
function normalize(raw: PlanConfirmation): PlanConfirmation {
  return { company: caseSchema.parse(raw.company), planId: z.string().uuid().parse(raw.planId) };
}
async function receipt(request: PlanConfirmation): Promise<PlanConfirmationReceipt> {
  const base = request.company;
  const targets = base.plans.filter((p) => p.id === request.planId);
  const target = targets[0];
  if (
    targets.length !== 1 ||
    !target ||
    target.confirmedAt ||
    target.version !== Math.max(...base.plans.map((p) => p.version)) ||
    new Set(base.plans.map((p) => p.id)).size !== base.plans.length ||
    new Set(base.plans.map((p) => p.version)).size !== base.plans.length
  )
    fail();
  const identity = {
    format: "plan-confirmation-v1" as const,
    caseId: base.id,
    planId: request.planId,
    revision: base.revision,
    version: target.version,
  };
  // Bind exactly the context checked by planConfirmationSnapshot. Review recalculation
  // and completion time are allowed changes; no titles, text or evidence are persisted.
  // This digest is a local comparison aid, not a server receipt or authentication proof.
  const context = [
    base.profile,
    base.sources,
    base.analysis,
    base.selectedCandidateId,
    base.candidateSelections,
    [...base.plans]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((p) => (p.id === request.planId ? { ...p, review: [], confirmedAt: null } : p)),
  ];
  return receiptSchema.parse({ ...identity, digest: await digest([identity, context]) });
}
export const planConfirmationRecoveryKey = (caseId: string) =>
  `venturepass:plan-confirmation:v1:${caseId}`;

/** Browser identity journal. Recovery only GETs; it never replays a confirm-plan command. */
export class PlanConfirmationJournal {
  readonly key: string;
  constructor(
    readonly caseId: string,
    private storage: StoragePort,
    private lock: Lock,
    private transport: Transport,
  ) {
    z.string().uuid().parse(caseId);
    this.key = planConfirmationRecoveryKey(caseId);
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
    expected: PlanConfirmationReceipt,
    current: Current,
    storedAtStart: PlanConfirmationReceipt | null,
  ) {
    const next = caseSchema.parse(raw);
    const targets = next.plans.filter((p) => p.id === expected.planId);
    if (
      next.id !== expected.caseId ||
      targets.length !== 1 ||
      targets[0].version !== expected.version
    )
      fail();
    // Reconstruct the pre-confirmation view from the result, prove its unchanged
    // context with the original digest, then reuse the full completion checks.
    const request: PlanConfirmation = {
      company: {
        ...next,
        revision: expected.revision,
        plans: next.plans.map((p) =>
          p.id === expected.planId ? { ...p, review: [], confirmedAt: null } : p,
        ),
      },
      planId: expected.planId,
    };
    const accepted = planConfirmationSnapshot(next, request);
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
        throw new PlanConfirmationRecoveryError("storage");
    }
    return accepted;
  }
  save(
    raw: PlanConfirmation,
    current: Current,
    onPending: (value: PlanConfirmationReceipt) => void,
  ) {
    const request = normalize(structuredClone(raw));
    return this.lock(this.key, async () => {
      if (request.company.id !== this.caseId || this.pending()) fail();
      const original = await receipt(request);
      const now = current();
      if (now.id !== this.caseId || now.revision !== original.revision || this.pending()) fail();
      storageAccess(() => this.storage.setItem(this.key, JSON.stringify(original)));
      if (!equal(this.pending(), original)) throw new PlanConfirmationRecoveryError("storage");
      onPending(original);
      // Exactly one explicit PATCH; errors retain the identity with no automatic GET.
      return this.accept(
        await this.transport({
          action: "confirm-plan",
          planId: request.planId,
          revision: original.revision,
        }),
        original,
        current,
        original,
      );
    });
  }
  recover(raw: PlanConfirmationReceipt, current: Current) {
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
export function planConfirmationBrowserStorage() {
  return storageAccess(publicEvidenceBrowserStorage);
}
export const planConfirmationBrowserLock: Lock = async (name, task) => {
  try {
    return await publicEvidenceBrowserLock(name, task);
  } catch (error) {
    if (
      error instanceof PublicEvidenceRecoveryError &&
      (error.reason === "busy" || error.reason === "unavailable")
    )
      throw new PlanConfirmationRecoveryError(error.reason);
    throw error;
  }
};
