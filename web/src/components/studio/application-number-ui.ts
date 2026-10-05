import { z } from "zod";
import { caseSchema } from "@/lib/studio-schema";
import { applicationMetadata } from "@/lib/studio-application-types";
import { normalizeVentureBusinessNumber } from "@/lib/venturein-inspection";
import {
  applicationNumberBindingCommandSchema as commandSchema,
  applicationNumberBindingRecordSchema as recordSchema,
  type ApplicationNumberBindingCommand as Command,
} from "@/lib/studio-application-number-types";

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const fail = (): never => {
  throw Error("신청번호 연결 기록을 대조하지 못했습니다. 원래 요청을 유지했습니다.");
};
const snapshotSchema = z
  .object({
    company: caseSchema,
    records: z.array(recordSchema).max(200),
    current: z
      .array(
        z
          .object({
            applicationId: z.string().uuid(),
            state: z.enum(["unassigned", "manual-unverified", "stale"]),
            record: recordSchema.nullable(),
          })
          .strict(),
      )
      .max(30),
    historyAudited: z.literal(true),
    officialStatusChecked: z.literal(false),
    databaseChanged: z.literal(false),
    transmissionAllowed: z.literal(false),
  })
  .strict();
const inspectionSchema = snapshotSchema
  .extend({
    command: commandSchema,
    receipt: recordSchema.nullable(),
    outcome: z.enum(["recorded", "not-recorded-stale", "unconfirmed"]),
  })
  .strict();
export type NumberStatus = z.infer<typeof snapshotSchema>;
export type NumberInspection = z.infer<typeof inspectionSchema>;
export async function numberDigest(value: unknown) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
export async function validateNumberStatus(
  raw: unknown,
  caseId: string,
  minimumRevision = 0,
): Promise<NumberStatus> {
  const s = snapshotSchema.parse(raw);
  if (
    s.company.id !== caseId ||
    s.company.revision < minimumRevision ||
    !equal(s.records, s.company.applicationNumberBindings?.records ?? []) ||
    s.current.length !== s.company.applications.length
  )
    fail();
  const ids = new Set<string>(),
    nonces = new Set<string>();
  for (const entry of s.records) {
    const { recordDigest, ...body } = entry;
    if (
      entry.caseId !== caseId ||
      ids.has(entry.id) ||
      nonces.has(entry.command.clientRequestId) ||
      entry.committedRevision !== entry.command.revision + 1 ||
      entry.committedRevision > s.company.revision ||
      recordDigest !== (await numberDigest(body)) ||
      entry.inputDigest !==
        (await numberDigest({ formatVersion: 1, caseId, command: entry.command }))
    )
      fail();
    ids.add(entry.id);
    nonces.add(entry.command.clientRequestId);
  }
  for (let i = 0; i < s.current.length; i++) {
    const item = s.current[i],
      cycle = s.company.applications[i];
    const last = s.records.filter((r) => r.command.applicationId === cycle.id).at(-1) ?? null;
    const number = normalizeVentureBusinessNumber(s.company.profile.businessNumber);
    const state =
      !last || last.command.operation === "release"
        ? "unassigned"
        : !!number &&
            number === normalizeVentureBusinessNumber(last.companySnapshot.businessNumber) &&
            applicationMetadata(s.company, cycle.id)?.metadataVersionId ===
              last.command.metadataVersionId
          ? "manual-unverified"
          : "stale";
    if (item.applicationId !== cycle.id || !equal(item.record, last) || item.state !== state)
      fail();
  }
  return s;
}
async function validateInspection(raw: unknown, caseId: string, command: Command) {
  const parsed = inspectionSchema.parse(raw);
  const { command: received, receipt, outcome, ...snapshot } = parsed;
  const s = await validateNumberStatus(snapshot, caseId, command.revision);
  if (!equal(command, received)) fail();
  const match =
    s.records.find((r) => r.command.clientRequestId === command.clientRequestId) ?? null;
  if (
    !equal(match, receipt) ||
    (receipt && !equal(receipt.command, command)) ||
    (outcome === "recorded") !== !!receipt ||
    (outcome === "not-recorded-stale" && s.company.revision <= command.revision)
  )
    fail();
  return parsed;
}
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type NumberLock = <T>(name: string, task: () => Promise<T>) => Promise<T>;
export type NumberTransport = (
  action: "read" | "write" | "inspect",
  command?: Command,
) => Promise<unknown>;
const entrySchema = z
  .object({
    format: z.literal("application-number-v1"),
    caseId: z.string().uuid(),
    command: commandSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
/** Same-browser pending command only; no company bodies, source files, session cookies or responses. */
export class NumberRequestJournal {
  private key: string;
  constructor(
    readonly caseId: string,
    private storage: StoragePort,
    private lock: NumberLock,
    private transport: NumberTransport,
  ) {
    z.string().uuid().parse(caseId);
    this.key = `venturepass:application-number:v1:${caseId}`;
  }
  async pending() {
    const raw = this.storage.getItem(this.key);
    if (raw === null) return null;
    if (new TextEncoder().encode(raw).byteLength > 32768) fail();
    const entry = entrySchema.parse(JSON.parse(raw));
    if (
      entry.caseId !== this.caseId ||
      entry.sha256 !== (await numberDigest({ caseId: this.caseId, command: entry.command }))
    )
      fail();
    return structuredClone(entry.command);
  }
  private async remember(command: Command) {
    const entry = entrySchema.parse({
      format: "application-number-v1",
      caseId: this.caseId,
      command,
      sha256: await numberDigest({ caseId: this.caseId, command }),
    });
    const text = JSON.stringify(entry);
    if (new TextEncoder().encode(text).byteLength > 32768) fail();
    this.storage.setItem(this.key, text);
    if (!equal(await this.pending(), command)) fail();
  }
  private async remove(command: Command) {
    if (!equal(await this.pending(), command)) fail();
    this.storage.removeItem(this.key);
    if (this.storage.getItem(this.key) !== null) fail();
  }
  private async inspect(minimumRevision = 0) {
    const pending = await this.pending();
    const status = await validateNumberStatus(
      await this.transport("read"),
      this.caseId,
      minimumRevision,
    );
    const receipt = pending
      ? (status.records.find((r) => r.command.clientRequestId === pending.clientRequestId) ?? null)
      : null;
    if (receipt) {
      if (!equal(receipt.command, pending)) fail();
      await this.remove(pending!);
    }
    return { status, receipt, pending: await this.pending() };
  }
  read(minimumRevision = 0) {
    return this.lock(this.key, () => this.inspect(minimumRevision));
  }
  execute(raw: Command, retry = false) {
    const command = commandSchema.parse(structuredClone(raw));
    return this.lock(this.key, async () => {
      const pending = await this.pending();
      if (retry ? !equal(pending, command) : pending !== null) fail();
      const before = await this.inspect(command.revision);
      if (before.receipt) return before;
      if (!retry && before.status.company.revision !== command.revision) fail();
      if (!pending) await this.remember(command);
      // A transport failure may follow COMMIT. Only the audited read can acknowledge it.
      try {
        await this.transport("write", structuredClone(command));
      } catch {}
      return this.inspect(command.revision);
    });
  }
  inspectClosure(raw: Command) {
    const command = commandSchema.parse(structuredClone(raw));
    return this.lock(this.key, async () => {
      if (!equal(await this.pending(), command)) fail();
      const value = await validateInspection(
        await this.transport("inspect", command),
        this.caseId,
        command,
      );
      if (value.receipt) await this.remove(command);
      return value;
    });
  }
  close(raw: NumberInspection, confirmed: boolean) {
    const expected = inspectionSchema.parse(structuredClone(raw));
    if (
      !confirmed ||
      expected.outcome !== "not-recorded-stale" ||
      expected.company.id !== this.caseId
    )
      fail();
    return this.lock(this.key, async () => {
      if (!equal(await this.pending(), expected.command)) fail();
      const current = await validateInspection(
        await this.transport("inspect", expected.command),
        this.caseId,
        expected.command,
      );
      if (current.receipt) {
        await this.remove(expected.command);
        return current;
      }
      if (
        current.outcome !== "not-recorded-stale" ||
        current.company.revision !== expected.company.revision
      )
        fail();
      await this.remove(expected.command);
      return current;
    });
  }
}
export const numberBrowserLock: NumberLock = async (name, task) => {
  if (!navigator.locks) throw Error("이 브라우저에서 요청 보관 잠금을 사용할 수 없습니다.");
  return navigator.locks.request(name, { mode: "exclusive", ifAvailable: true }, async (lock) => {
    if (!lock) throw Error("다른 창에서 이 회사의 신청번호를 처리 중입니다.");
    return task();
  });
};
export function numberTransport(caseId: string): NumberTransport {
  z.string().uuid().parse(caseId);
  return async (action, command) => {
    const base = `/api/studio/cases/${caseId}`;
    const response = await fetch(action === "write" ? base : base + "/application-numbers", {
      cache: "no-store",
      ...(action === "read"
        ? {}
        : {
            method: action === "write" ? "PATCH" : "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(
              action === "write" ? command : { action: "inspect-original-request", command },
            ),
          }),
    });
    if (!response.ok)
      throw Error("연결 상태를 확인하지 못했습니다. 원래 요청으로 다시 확인해 주세요.");
    return response.json();
  };
}
