import { z } from "zod";
import type { StudioCase } from "@/lib/studio-schema";
import {
  createSourceIntakeSchema,
  sourceIntakeOriginalInputSchema,
  sourceIntakeNameSchema,
  sourceIntakeLimits,
} from "@/lib/studio-source-intake-types";
import {
  IntakeHttpError,
  intakeFileSha256,
  intakeNonce,
  intakeRevision,
  intakeRequestAcknowledged,
  sendIntakeRequest,
  validateIntakeResponse,
  validateIntakeStatus,
  type IntakePending,
  type IntakeRequestIdentity,
} from "./source-intakes-ui";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const requestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("command"),
      command: createSourceIntakeSchema.refine((value) =>
        value.files.every((file) => !!file.sha256),
      ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("original"),
      itemId: z.string().uuid(),
      input: sourceIntakeOriginalInputSchema,
      file: z
        .object({
          name: sourceIntakeNameSchema,
          size: z.number().int().min(1).max(sourceIntakeLimits.fileBytes),
          type: z.string().max(150),
        })
        .strict(),
      sha256: sha,
    })
    .strict(),
]);
const journalSchema = z
  .object({
    journalVersion: z.literal(1),
    companyId: z.string().uuid(),
    request: requestSchema,
    inputDigest: sha,
    journalDigest: sha,
  })
  .strict();
export type IntakeUploadJournal = z.infer<typeof journalSchema>;
export const intakeUploadOutboxKey = (companyId: string) =>
  `venturepass:intake-upload-outbox:v1:${z.string().uuid().parse(companyId)}`;
const messages = {
  UNSUPPORTED:
    "이 브라우저에서 접수 요청 보관·탭 잠금을 사용할 수 없습니다. 새 전송을 시작하지 않았습니다.",
  BUSY: "다른 탭에서 이 회사의 접수를 처리하고 있습니다. 잠시 후 저장 상태를 확인해 주세요.",
  STORAGE:
    "접수 요청 보관을 확인하지 못했습니다. 브라우저 기록을 지우지 말고 저장 상태를 다시 확인해 주세요.",
  CORRUPT: "보관한 접수 요청을 검증하지 못했습니다. 기록을 보존하며 새 요청은 시작하지 않습니다.",
  CHANGED:
    "다른 탭에서 접수 요청이 바뀌었습니다. 원래 요청을 덮어쓰지 않았습니다. 저장 상태를 확인해 주세요.",
  EXISTING: "먼저 보관한 접수 요청의 저장 여부를 확인해 주세요. 새 요청은 시작하지 않았습니다.",
  FILE: "원래 파일을 다시 선택해 주세요. 이름·크기·내용이 일치할 때만 같은 요청으로 접수합니다.",
  RESPONSE:
    "원래 요청과 저장 기록을 대조하지 못했습니다. 새 요청으로 바꾸지 않고 확인을 기다립니다.",
} as const;
export class IntakeUploadOutboxError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
  }
}
const fail = (code: keyof typeof messages): never => {
  throw new IntakeUploadOutboxError(code);
};
async function hash(value: unknown) {
  const result = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
/** Match the frozen server intakeDigest order, excluding only revision. No server imports. */
async function inputDigest(request: IntakeUploadJournal["request"]) {
  const value: Record<string, unknown> =
    request.kind === "command"
      ? { ...request.command }
      : {
          action: "original",
          itemId: request.itemId,
          ...request.input,
          name: request.file.name,
          // Multipart File without a MIME type is received as application/octet-stream.
          mimeType: request.file.type.trim().toLowerCase() || "application/octet-stream",
          sizeBytes: request.file.size,
          sha256: request.sha256,
        };
  delete value.revision;
  return hash(value);
}
export async function createIntakeUploadJournal(
  companyId: string,
  request: IntakeUploadJournal["request"],
) {
  const normalized = requestSchema.parse(request);
  const body = {
    journalVersion: 1 as const,
    companyId: z.string().uuid().parse(companyId),
    request: normalized,
    inputDigest: await inputDigest(normalized),
  };
  return { ...body, journalDigest: await hash(body) };
}
export function intakeUploadAcknowledged(
  company: StudioCase,
  companyId: string,
  journal: IntakeUploadJournal,
) {
  if (journal.companyId !== companyId) return fail("RESPONSE");
  const receipts = company.sourceIntakes
    .flatMap((item) => item.requests)
    .filter((receipt) => receipt.clientRequestId === intakeNonce(journal.request));
  if (!receipts.length) return false;
  if (
    receipts.length !== 1 ||
    receipts[0].inputDigest !== journal.inputDigest ||
    !intakeRequestAcknowledged(company, companyId, journal.request)
  )
    return fail("RESPONSE");
  return true;
}
export async function decodeIntakeUploadJournal(raw: string, companyId: string) {
  try {
    if (new TextEncoder().encode(raw).length > 32 * 1024) return fail("CORRUPT");
    const journal = journalSchema.parse(JSON.parse(raw));
    const { journalDigest, ...body } = journal;
    if (
      journal.companyId !== companyId ||
      journalDigest !== (await hash(body)) ||
      journal.inputDigest !== (await inputDigest(journal.request))
    )
      return fail("CORRUPT");
    return journal;
  } catch {
    return fail("CORRUPT");
  }
}
export function isIntakeUpload(request: IntakeRequestIdentity) {
  return request.kind === "original" || request.command.action === "create";
}
export async function restoreIntakeUploadFile(
  request: Extract<IntakeUploadJournal["request"], { kind: "original" }>,
  file: File,
): Promise<IntakePending> {
  if (
    file.name !== request.file.name ||
    file.size !== request.file.size ||
    (await intakeFileSha256(file)) !== request.sha256
  )
    return fail("FILE");
  // MIME metadata is part of the original command, even if a picker reports it differently later.
  const originalFile = new File([file], request.file.name, { type: request.file.type });
  return { ...request, file: originalFile };
}
type Dependencies = {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  exclusive: <T>(work: () => Promise<T>) => Promise<T>;
  status: () => Promise<unknown>;
  send: (request: IntakePending) => Promise<unknown>;
};
/** Only file declarations and original upload identity are retained; never file bytes or reviewed text.
 * Every cooperating panel holds the case Web Lock through lookup/send and verified journal removal.
 */
export class IntakeUploadOutbox {
  readonly key: string;
  private inspection: Promise<
    NonNullable<ReturnType<typeof validateIntakeStatus>> & {
      journal: IntakeUploadJournal | null;
    }
  > | null = null;
  constructor(
    readonly companyId: string,
    private readonly deps: Dependencies,
  ) {
    this.key = intakeUploadOutboxKey(companyId);
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
  private clear(expected: string) {
    this.assertRaw(expected);
    try {
      this.deps.storage.removeItem(this.key);
      if (this.raw() !== null) fail("STORAGE");
    } catch {
      fail("STORAGE");
    }
  }
  async inspect(minimumRevision: number) {
    // React development effect replay may request the same read twice. Share only this
    // instance's ongoing lookup, never another tab's lock or a completed cached snapshot.
    this.inspection ??= this.inspectOnce(minimumRevision).finally(() => {
      this.inspection = null;
    });
    const snapshot = await this.inspection;
    if (snapshot.company.revision < minimumRevision) return fail("RESPONSE");
    return snapshot;
  }
  private async inspectOnce(minimumRevision: number) {
    return this.deps.exclusive(async () => {
      const raw = this.raw();
      let journal = raw === null ? null : await decodeIntakeUploadJournal(raw, this.companyId);
      const snapshot = validateIntakeStatus(
        await this.deps.status(),
        this.companyId,
        Math.max(minimumRevision, journal ? intakeRevision(journal.request) : 0),
      );
      if (!snapshot) return fail("RESPONSE");
      this.assertRaw(raw);
      if (journal && intakeUploadAcknowledged(snapshot.company, this.companyId, journal)) {
        this.clear(raw!);
        journal = null;
      }
      return { ...snapshot, journal };
    });
  }
  async send(request: IntakePending) {
    return this.deps.exclusive(async () => {
      const selectedFile = request.kind === "original" ? request.file : null;
      const raw = this.raw();
      const previous = raw === null ? null : await decodeIntakeUploadJournal(raw, this.companyId);
      const metadata =
        request.kind === "original"
          ? {
              ...request,
              file: { name: request.file.name, size: request.file.size, type: request.file.type },
            }
          : request;
      const normalized = requestSchema.parse(metadata);
      const transmission: IntakePending =
        normalized.kind === "original" ? { ...normalized, file: selectedFile! } : normalized;
      if (previous && JSON.stringify(previous.request) !== JSON.stringify(normalized))
        return fail("EXISTING");
      if (
        transmission.kind === "original" &&
        (await intakeFileSha256(transmission.file)) !== transmission.sha256
      )
        return fail("FILE");
      const journal = await createIntakeUploadJournal(this.companyId, normalized);
      const stored = JSON.stringify(journal);
      await decodeIntakeUploadJournal(stored, this.companyId);
      this.assertRaw(raw);
      if (raw === null) {
        try {
          this.deps.storage.setItem(this.key, stored);
          if (this.raw() !== stored) fail("STORAGE");
        } catch {
          return fail("STORAGE");
        }
      }
      const expected = raw ?? stored;
      // All replays first look up the original nonce; a missing receipt does not prove a refusal.
      if (previous) {
        const snapshot = validateIntakeStatus(
          await this.deps.status(),
          this.companyId,
          intakeRevision(transmission),
        );
        this.assertRaw(expected);
        if (!snapshot) return fail("RESPONSE");
        if (intakeUploadAcknowledged(snapshot.company, this.companyId, journal)) {
          this.clear(expected);
          return snapshot.company;
        }
        if (snapshot.activeItemIds.length) return fail("BUSY");
      }
      this.assertRaw(expected);
      let response: unknown;
      try {
        response = await this.deps.send(transmission);
      } catch (error) {
        this.assertRaw(expected);
        if (error instanceof IntakeHttpError && error.accepted === false) {
          if (!previous) this.clear(expected);
          else throw new IntakeHttpError(error.code, null);
        }
        throw error;
      }
      this.assertRaw(expected);
      const company = validateIntakeResponse(response, this.companyId, transmission);
      if (!company || !intakeUploadAcknowledged(company, this.companyId, journal))
        return fail("RESPONSE");
      this.clear(expected);
      return company;
    });
  }
  /** Keep existing non-upload actions unchanged, but don't overtake another tab's upload. */
  async guard<T>(work: () => Promise<T>): Promise<T> {
    return this.deps.exclusive(async () => {
      if (this.raw() !== null) return fail("EXISTING");
      return work();
    });
  }
}
export function browserIntakeUploadOutbox(companyId: string) {
  try {
    if (!window.isSecureContext || !navigator.locks?.request || !crypto.subtle)
      return fail("UNSUPPORTED");
    const endpoint = `/api/studio/cases/${companyId}/source-intakes`;
    return new IntakeUploadOutbox(companyId, {
      storage: window.localStorage,
      exclusive: async (work) =>
        await navigator.locks.request(
          intakeUploadOutboxKey(companyId),
          { mode: "exclusive", ifAvailable: true },
          (lock) => (lock ? work() : fail("BUSY")),
        ),
      status: async () => {
        const response = await fetch(endpoint, { cache: "no-store" });
        if (!response.ok) return fail("RESPONSE");
        return response.json();
      },
      send: (request) => sendIntakeRequest(endpoint, request),
    });
  } catch {
    return fail("UNSUPPORTED");
  }
}
