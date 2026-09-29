import { z } from "zod";
import type { CandidateRegistrySnapshot } from "@/lib/studio-plan-quality-candidate-registry-types";
import type { ProviderSnapshot } from "@/lib/studio-plan-quality-provider-types";
import {
  providerTransmissionApprovalInputSchema,
  providerTransmissionApprovalReceiptSchema,
  providerTransmissionApprovalResponseSchema,
  providerTransmissionApprovalHttpLimits,
} from "@/lib/studio-plan-quality-provider-transmission-approval-http-types";
import {
  providerTransmissionReviewSchema,
  providerTransmissionReviewDigestInput,
  type ProviderTransmissionReview,
} from "@/lib/studio-plan-quality-provider-transmission-review-types";
import { qualityProviderTransmissionInspection } from "./quality-provider-transmission-ui";
import {
  candidateRegistryCanonical as canonical,
  candidateRegistryDigest as digest,
} from "./quality-candidate-registry-ui";

export const transmissionOutboxKey = "venturepass:provider-transmission-outbox:v1";
export const transmissionOutboxLock = "venturepass:provider-transmission-outbox";
export const transmissionOutboxLimits = {
  bytes: 160 * 1024,
  responseBytes: 16 * 1024,
  timeoutMs: 20000,
};
const base = "/api/studio/quality/provider-transmission";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const requestSchema = providerTransmissionApprovalInputSchema.extend({
  approvedReview: providerTransmissionReviewSchema,
});
const outcomeSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending") }).strict(),
  z
    .object({ state: z.literal("committed"), receipt: providerTransmissionApprovalReceiptSchema })
    .strict(),
  // Only a directly observed refusal of the first, exclusively owned attempt can be terminal.
  z.object({ state: z.literal("refused"), code: z.string().min(1).max(120) }).strict(),
]);
const journalSchema = z
  .object({
    journalVersion: z.literal(1),
    request: requestSchema,
    commandDigest: hash,
    outcome: outcomeSchema,
    journalDigest: hash,
  })
  .strict();
export type TransmissionJournal = z.infer<typeof journalSchema>;
type JournalBody = Omit<TransmissionJournal, "journalDigest">;
type Receipt = z.infer<typeof providerTransmissionApprovalReceiptSchema>;
export type TransmissionOutboxDependencies = {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  exclusive: <T>(work: () => Promise<T>) => Promise<T>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => string;
  uuid: () => string;
};
const messages = {
  UNSUPPORTED: "이 브라우저에서 요청 보관과 탭 잠금을 사용할 수 없어 전송 승인을 중단했습니다.",
  BUSY: "다른 탭에서 전송 승인 요청을 처리하고 있습니다. 잠시 후 보관 요청을 다시 읽어 주세요.",
  STORAGE: "요청 보관 상태를 확인하지 못했습니다. 원래 요청을 보존하고 새 요청을 만들지 마세요.",
  CORRUPT: "보관한 요청을 검증하지 못했습니다. 기록을 지우거나 새 전송 승인 요청을 만들지 마세요.",
  CHANGED:
    "다른 탭에서 보관 요청이 바뀌었습니다. 원래 기록을 덮어쓰지 않았습니다. 다시 읽어 주세요.",
  EXISTING: "먼저 보관한 전송 승인 요청의 결과를 확인해 주세요.",
  PENDING: "결과 미확인 요청은 닫거나 교체할 수 없습니다. 같은 요청으로 결과를 확인해 주세요.",
  REVIEW: "검토안과 확인 내용을 다시 확인해 주세요. 기한이 지났거나 조건이 달라졌을 수 있습니다.",
} as const;
export class TransmissionOutboxError extends Error {
  constructor(public readonly code: keyof typeof messages) {
    super(messages[code]);
  }
}
const fail = (code: keyof typeof messages): never => {
  throw new TransmissionOutboxError(code);
};
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const without = (value: object, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
function bodyOf(value: TransmissionJournal): JournalBody {
  const { journalDigest: _ignored, ...body } = value;
  void _ignored;
  return body;
}
async function seal(body: JournalBody): Promise<TransmissionJournal> {
  return { ...body, journalDigest: await digest(body) };
}

/** Historical receipt identity checking, not current state or the server's full ledger audit. */
async function matchesReceipt(
  receipt: Receipt,
  journal: Pick<TransmissionJournal, "request" | "commandDigest">,
) {
  const { command, approvedReview: review } = journal.request;
  if (!(
    receipt.clientRequestId === command.clientRequestId &&
    receipt.commandDigest === journal.commandDigest &&
    receipt.approvedReviewDigest === command.approvedReviewDigest &&
    receipt.runId === command.runId &&
    receipt.runDigest === command.runDigest &&
    Date.parse(receipt.recordedAt) >= Date.parse(command.approval.approvedAt) &&
    Date.parse(receipt.recordedAt) < Date.parse(review.expiresAt)
  ))
    return false;
  // Reconstruct the frozen native identity in the browser, without importing server/crypto modules.
  // Full command + review identity is essential: distinct reviews can share a native input digest.
  const payload = {
    kind: "transmission-approved",
    manifest: review.manifest,
    provenance: "explicit-user",
    approvedAt: command.approval.approvedAt,
    expiresAt: review.expiresAt,
    acknowledgedExternalTransmission: true,
    acknowledgedGenerationAndDerivedReview: true,
    acknowledgedRetentionNoticeDigest: command.approval.acknowledgedRetentionNoticeDigest,
    acknowledgedFinancialReservationNotTokenFit: true,
    acknowledgedUnknownCostHoldAndNoRetry: true,
    budgetRevision: command.expectedBudgetHead.revision,
    budgetDigest: command.expectedBudgetHead.headDigest,
  };
  const executionInputDigest = await digest({
    kind: "provider-execution-operation",
    runId: command.runId,
    clientRequestId: command.clientRequestId,
    expectedRevision: 0,
    payload,
    artifact: null,
  });
  const approvalEventDigest = await digest({
    schemaVersion: 2,
    executionContractVersion: 1,
    runId: command.runId,
    revision: 1,
    budgetRevision: command.expectedBudgetHead.revision,
    previousEventDigest: null,
    recordedAt: receipt.recordedAt,
    payload,
  });
  return (
    receipt.executionInputDigest === executionInputDigest &&
    receipt.approvalEventDigest === approvalEventDigest &&
    receipt.recordDigest ===
      (await digest({
        recordVersion: 1,
        kind: "provider-transmission-approval-binding",
        clientRequestId: command.clientRequestId,
        command,
        commandDigest: journal.commandDigest,
        approvedReview: review,
        runId: command.runId,
        runDigest: command.runDigest,
        executionInputDigest,
        approvalEventDigest,
        approvalRevision: 1,
        recordedAt: receipt.recordedAt,
        dispatchAllowed: false,
      }))
  );
}
export async function decodeTransmissionJournal(raw: string): Promise<TransmissionJournal> {
  try {
    if (bytes(raw) > transmissionOutboxLimits.bytes) return fail("CORRUPT");
    const journal = journalSchema.parse(JSON.parse(raw));
    const { command, approvedReview: review } = journal.request;
    const manifest = review.manifest,
      contract = manifest.executionContract;
    if (
      journal.journalDigest !== (await digest(bodyOf(journal))) ||
      journal.commandDigest !== (await digest(command)) ||
      command.approvedReviewDigest !== review.reviewDigest ||
      review.reviewDigest !== (await digest(providerTransmissionReviewDigestInput(review))) ||
      manifest.manifestDigest !== (await digest(without(manifest, "manifestDigest"))) ||
      contract.contractDigest !== (await digest(without(contract, "contractDigest"))) ||
      contract.usagePolicyDigest !== (await digest(contract.usagePolicy)) ||
      contract.usagePolicy.financialBasisDigest !== (await digest(review.financialBasis)) ||
      command.runId !== review.run.id ||
      command.runDigest !== review.run.runDigest ||
      command.expectedArchiveDigest !== review.archiveDigest ||
      command.expectedCoverageDigest !== review.coverageDigest ||
      command.expectedReservationBindingDigest !== review.reservation.bindingDigest ||
      command.expectedManifestDigest !== manifest.manifestDigest ||
      !same(command.expectedRun, {
        revision: review.run.revision,
        snapshotDigest: review.run.snapshotDigest,
      }) ||
      review.assessment.state !== "conditions-met" ||
      !same(command.expectedPolicyReference, review.policy.reservedReference) ||
      !same(command.expectedPolicyReference, review.policy.currentReference) ||
      !same(command.expectedPolicyHead, review.policy.head) ||
      !same(command.expectedBudgetHead, {
        revision: review.budget.revision,
        headDigest: review.budget.headDigest,
      }) ||
      command.approval.acknowledgedRetentionNoticeDigest !== (await digest(review.retention)) ||
      Date.parse(command.approval.approvedAt) < Date.parse(review.inspectedAt) ||
      Date.parse(command.approval.approvedAt) >= Date.parse(review.expiresAt) ||
      bytes(canonical(journal.request)) > providerTransmissionApprovalHttpLimits.bodyBytes ||
      (journal.outcome.state === "committed" &&
        !(await matchesReceipt(journal.outcome.receipt, journal)))
    )
      return fail("CORRUPT");
    return journal;
  } catch {
    return fail("CORRUPT");
  }
}

async function responseValue(response: Response) {
  const declared = response.headers.get("content-length");
  if (
    !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") ||
    (declared !== null &&
      (!/^\d+$/.test(declared) || Number(declared) > transmissionOutboxLimits.responseBytes)) ||
    !response.body
  )
    throw new Error("Invalid response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > transmissionOutboxLimits.responseBytes) {
        await reader.cancel();
        throw new Error("Response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return providerTransmissionApprovalResponseSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result)),
  );
}

/** One journal per browser origin. All cooperating writers hold the same Web Lock through response persistence. */
export class TransmissionOutbox {
  private damaged = false;
  constructor(private readonly deps: TransmissionOutboxDependencies) {}
  private raw() {
    try {
      return this.deps.storage.getItem(transmissionOutboxKey);
    } catch {
      return fail("STORAGE");
    }
  }
  async read() {
    const raw = this.raw();
    return raw === null ? null : decodeTransmissionJournal(raw);
  }
  private assertRaw(expected: string | null) {
    if (this.raw() !== expected) {
      this.damaged = true;
      fail("CHANGED");
    }
  }
  private async replace(expected: string | null, body: JournalBody) {
    const journal = await seal(body);
    const raw = canonical(journal);
    // Validate before writing; read-back must match before any network operation or success is exposed.
    await decodeTransmissionJournal(raw);
    this.assertRaw(expected);
    try {
      this.deps.storage.setItem(transmissionOutboxKey, raw);
      if (this.raw() !== raw) throw new Error("Read-back mismatch");
    } catch {
      this.damaged = true;
      return fail("STORAGE");
    }
    return { journal, raw };
  }
  async begin(
    rawView: unknown,
    registry: CandidateRegistrySnapshot,
    snapshot: ProviderSnapshot,
    acknowledgements: unknown,
  ) {
    return this.deps.exclusive(async () => {
      if (this.damaged) return fail("STORAGE");
      if (this.raw() !== null) return fail("EXISTING");
      let review: ProviderTransmissionReview;
      try {
        z.object({
          external: z.literal(true),
          generationAndReview: z.literal(true),
          currentPolicyAndBudget: z.literal(true),
          financial: z.literal(true),
          retention: z.literal(true),
          retry: z.literal(true),
        })
          .strict()
          .parse(acknowledgements);
        const inspected = await qualityProviderTransmissionInspection(rawView, registry, snapshot);
        if (inspected.status !== "review" || inspected.review.assessment.state !== "conditions-met")
          return fail("REVIEW");
        review = inspected.review;
      } catch {
        return fail("REVIEW");
      }
      const approvedAt = this.deps.now();
      if (
        !z.string().datetime().safeParse(approvedAt).success ||
        Date.parse(approvedAt) < Date.parse(review.inspectedAt) ||
        Date.parse(approvedAt) >= Date.parse(review.expiresAt)
      )
        return fail("REVIEW");
      const request = requestSchema.parse({
        command: {
          commandVersion: 1,
          kind: "approve-provider-transmission",
          clientRequestId: this.deps.uuid(),
          runId: review.run.id,
          runDigest: review.run.runDigest,
          expectedPolicyHead: review.policy.head,
          approvedReviewDigest: review.reviewDigest,
          expectedArchiveDigest: review.archiveDigest,
          expectedCoverageDigest: review.coverageDigest,
          expectedReservationBindingDigest: review.reservation.bindingDigest,
          expectedManifestDigest: review.manifest.manifestDigest,
          expectedRun: { revision: review.run.revision, snapshotDigest: review.run.snapshotDigest },
          expectedPolicyReference: review.policy.currentReference,
          expectedBudgetHead: {
            revision: review.budget.revision,
            headDigest: review.budget.headDigest,
          },
          approval: {
            noticeVersion: 1,
            acknowledgedExternalTransmission: true,
            acknowledgedGenerationAndDerivedReview: true,
            acknowledgedRetentionNoticeDigest: await digest(review.retention),
            acknowledgedFinancialReservationNotTokenFit: true,
            acknowledgedUnknownCostHoldAndNoRetry: true,
            acknowledgedCurrentPolicyAndBudget: true,
            approvedAt,
          },
        },
        approvedReview: review,
      });
      const stored = await this.replace(null, {
        journalVersion: 1,
        request,
        commandDigest: await digest(request.command),
        outcome: { state: "pending" },
      });
      return this.attempt(stored.journal, stored.raw, "replay", true);
    });
  }
  async recover(expectedId: string, mode: "lookup" | "replay") {
    return this.deps.exclusive(async () => {
      if (this.damaged) return fail("STORAGE");
      const raw = this.raw();
      if (raw === null) return fail("CHANGED");
      const journal = await decodeTransmissionJournal(raw);
      if (journal.request.command.clientRequestId !== expectedId) return fail("CHANGED");
      this.assertRaw(raw);
      if (journal.outcome.state !== "pending") return journal;
      // Recovery never gets the first-attempt exception, even after a not-observed lookup or refusal.
      return this.attempt(journal, raw, mode, false);
    });
  }
  private async attempt(
    journal: TransmissionJournal,
    raw: string,
    mode: "lookup" | "replay",
    first: boolean,
  ) {
    this.assertRaw(raw);
    let outcome: TransmissionJournal["outcome"] = { state: "pending" };
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), transmissionOutboxLimits.timeoutMs);
    try {
      const response = await this.deps.fetch(
        mode === "lookup"
          ? `${base}/requests/${journal.request.command.clientRequestId}`
          : `${base}/approvals`,
        {
          method: mode === "lookup" ? "GET" : "POST",
          ...(mode === "replay"
            ? { headers: { "content-type": "application/json" }, body: canonical(journal.request) }
            : {}),
          cache: "no-store",
          credentials: "same-origin",
          redirect: "error",
          signal: abort.signal,
        },
      );
      const result = await responseValue(response);
      if (abort.signal.aborted) throw new Error("Response after timeout");
      if (
        result.state === "committed" &&
        response.status === 200 &&
        (mode === "lookup" ? result.delivery === "lookup" : result.delivery !== "lookup") &&
        (await matchesReceipt(result.receipt, journal)) &&
        !abort.signal.aborted
      )
        outcome = { state: "committed", receipt: result.receipt };
      else if (
        result.state === "refused" &&
        first &&
        mode === "replay" &&
        response.status >= 400 &&
        response.status < 500 &&
        result.clientRequestId === journal.request.command.clientRequestId &&
        result.code.length <= 120 &&
        result.code.length > 0
      )
        outcome = { state: "refused", code: result.code };
    } catch {
      // Network errors, invalid/mismatched responses and timeouts retain the exact pending command.
    } finally {
      clearTimeout(timer);
    }
    this.assertRaw(raw);
    if (outcome.state === "pending") return journal;
    return (await this.replace(raw, { ...bodyOf(journal), outcome })).journal;
  }
  async dismiss(expectedId: string) {
    return this.deps.exclusive(async () => {
      if (this.damaged) return fail("STORAGE");
      const raw = this.raw();
      if (raw === null) return fail("CHANGED");
      const journal = await decodeTransmissionJournal(raw);
      if (journal.request.command.clientRequestId !== expectedId) return fail("CHANGED");
      if (journal.outcome.state === "pending") return fail("PENDING");
      this.assertRaw(raw);
      try {
        this.deps.storage.removeItem(transmissionOutboxKey);
        if (this.raw() !== null) throw new Error("Remove mismatch");
      } catch {
        this.damaged = true;
        return fail("STORAGE");
      }
    });
  }
}

export function browserTransmissionOutbox() {
  try {
    if (
      !window.isSecureContext ||
      !navigator.locks?.request ||
      !crypto.subtle ||
      !crypto.randomUUID
    )
      return fail("UNSUPPORTED");
    return new TransmissionOutbox({
      storage: window.localStorage,
      exclusive: async (work) =>
        await navigator.locks.request(
          transmissionOutboxLock,
          { mode: "exclusive", ifAvailable: true },
          (lock) => (lock ? work() : fail("BUSY")),
        ),
      fetch: (url, init) => fetch(url, init),
      now: () => new Date().toISOString(),
      uuid: () => crypto.randomUUID(),
    });
  } catch {
    return fail("UNSUPPORTED");
  }
}
