import { z } from "zod";
import { caseSchema, sectionDefinitions, sourceSchema, type StudioCase } from "@/lib/studio-schema";
import { publicEvidenceSaved, type PublicEvidenceRequest } from "@/lib/studio-public-evidence";

type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Lock = <T>(name: string, task: () => Promise<T>) => Promise<T>;
type Current = () => Pick<StudioCase, "id" | "revision">;
type Transport = (command?: PublicEvidenceRequest["command"]) => Promise<unknown>;
const receiptSchema = z
  .object({
    format: z.literal("public-evidence-v1"),
    caseId: z.string().uuid(),
    sourceId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    sectionKey: z.enum(sectionDefinitions.map((s) => s.key)),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type PublicEvidenceReceipt = z.infer<typeof receiptSchema>;
const recoveryMessages = {
  unconfirmed:
    "저장 여부를 아직 확인하지 못했습니다. 원래 요청을 유지하며 자동으로 다시 저장하지 않습니다. ‘이 자료의 저장 상태 확인’을 눌러 주세요.",
  storage:
    "브라우저에서 복구 기록을 읽거나 보관하지 못했습니다. 저장 여부를 확인할 때까지 새 저장을 멈춥니다. 브라우저 저장소를 사용할 수 있는지 확인한 뒤 다시 확인해 주세요.",
  busy: "다른 창에서 이 회사의 공개 근거 저장을 확인 중입니다. 다른 창의 처리가 끝나면 다시 확인해 주세요.",
  unavailable:
    "이 브라우저에서는 저장 요청을 안전하게 구분할 수 없습니다. 사용하던 브라우저에서 다시 확인해 주세요.",
} as const;
type RecoveryFailure = keyof typeof recoveryMessages;
export class PublicEvidenceRecoveryError extends Error {
  constructor(readonly reason: RecoveryFailure) {
    super(recoveryMessages[reason]);
  }
}
/** Never display response/error text, even when a remote error resembles a known failure. */
export function publicEvidenceRecoveryMessage(
  error: unknown,
  fallback: RecoveryFailure = "unconfirmed",
) {
  if (error instanceof PublicEvidenceRecoveryError) {
    switch (error.reason) {
      case "unconfirmed":
      case "storage":
      case "busy":
      case "unavailable":
        return recoveryMessages[error.reason];
    }
  }
  return recoveryMessages[fallback];
}
function storageAccess<T>(task: () => T): T {
  try {
    return task();
  } catch {
    throw new PublicEvidenceRecoveryError("storage");
  }
}
export function publicEvidenceBrowserStorage() {
  return storageAccess(() => window.localStorage);
}
const fail = () => {
  throw new PublicEvidenceRecoveryError("unconfirmed");
};
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function receipt(request: PublicEvidenceRequest): Promise<PublicEvidenceReceipt> {
  const source = sourceSchema.parse(request.command.source);
  if (
    request.command.action !== "source" ||
    source.kind !== "market" ||
    source.originalName !== null ||
    source.mimeType !== null ||
    source.extraction !== "manual"
  )
    fail();
  const identity = receiptSchema.omit({ digest: true }).parse({
    format: "public-evidence-v1",
    caseId: request.caseId,
    sourceId: source.id,
    revision: request.command.revision,
    sectionKey: request.sectionKey,
  });
  // Bind the original scope and exact contents, excluding server-owned timestamps/warnings.
  // A local digest detects mismatches; it is not proof of provenance or protection against
  // an attacker who can rewrite both browser storage and the application's responses.
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      identity,
      source.name,
      source.kind,
      source.text,
      source.originalName,
      source.mimeType,
      source.extraction,
    ]),
  );
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { ...identity, digest };
}

export const publicEvidenceRecoveryKey = (caseId: string) =>
  `venturepass:public-evidence:v1:${caseId}`;

/** Browser recovery identities only: no source text, URL, title, manuscript, key or response. */
export class PublicEvidenceJournal {
  readonly key: string;
  constructor(
    readonly caseId: string,
    private storage: StoragePort,
    private lock: Lock,
    private transport: Transport,
  ) {
    z.string().uuid().parse(caseId);
    this.key = publicEvidenceRecoveryKey(caseId);
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
    // LocalStorage returns one atomic string. Read-only mounting must not compete with
    // another mount or a live write; save/recover recheck under the exclusive lock.
    return this.pending();
  }
  private async accept(raw: unknown, expected: PublicEvidenceReceipt, current: Current) {
    const company = caseSchema.parse(raw);
    const matches = company.sources.filter((s) => s.id === expected.sourceId);
    if (matches.length !== 1) return fail();
    const request: PublicEvidenceRequest = {
      caseId: expected.caseId,
      sectionKey: expected.sectionKey,
      command: { action: "source", revision: expected.revision, source: matches[0] },
    };
    if (!equal(await receipt(request), expected)) return fail();
    // Re-read the current company after hashing, then compare-and-remove under the same lock.
    const accepted = publicEvidenceSaved(company, request, current());
    if (!accepted || !equal(this.pending(), expected)) return fail();
    storageAccess(() => this.storage.removeItem(this.key));
    if (storageAccess(() => this.storage.getItem(this.key)) !== null)
      throw new PublicEvidenceRecoveryError("storage");
    return { company: accepted, request };
  }
  save(
    raw: PublicEvidenceRequest,
    current: Current,
    onPending: (r: PublicEvidenceReceipt) => void,
  ) {
    const request = structuredClone(raw);
    return this.lock(this.key, async () => {
      if (request.caseId !== this.caseId || this.pending()) fail();
      const original = await receipt(request);
      const now = current();
      if (now.id !== this.caseId || now.revision !== original.revision || this.pending()) fail();
      storageAccess(() => this.storage.setItem(this.key, JSON.stringify(original)));
      if (!equal(this.pending(), original)) throw new PublicEvidenceRecoveryError("storage");
      onPending(original);
      // Only this first explicit save sends a command. Reload/recovery is always GET only.
      try {
        return await this.accept(await this.transport(request.command), original, current);
      } catch {
        return this.accept(await this.transport(), original, current);
      }
    });
  }
  recover(raw: PublicEvidenceReceipt, current: Current) {
    const original = receiptSchema.parse(structuredClone(raw));
    return this.lock(this.key, async () => {
      if (original.caseId !== this.caseId || !equal(this.pending(), original)) fail();
      return this.accept(await this.transport(), original, current);
    });
  }
}

export const publicEvidenceBrowserLock: Lock = async (name, task) => {
  if (!navigator.locks) throw new PublicEvidenceRecoveryError("unavailable");
  return navigator.locks.request(name, { mode: "exclusive", ifAvailable: true }, async (lock) => {
    if (!lock) throw new PublicEvidenceRecoveryError("busy");
    return task();
  });
};
