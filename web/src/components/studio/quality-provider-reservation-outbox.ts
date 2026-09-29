import { z } from "zod";
import type { CandidateRegistrySnapshot } from "@/lib/studio-plan-quality-candidate-registry-types";
import {
  providerReservationInputSchema,
  providerReservationReceiptSchema,
  providerReservationResponseSchema,
  providerReservationHttpLimits,
} from "@/lib/studio-plan-quality-provider-reservation-http-types";
import {
  providerReservationReviewSchema,
  providerReservationReviewDigestInput,
  type ProviderReservationReview,
} from "@/lib/studio-plan-quality-provider-reservation-review-types";
import { providerPolicyReviewDigestInput } from "@/lib/studio-plan-quality-provider-policy-review-types";
import { qualityProviderReservationInspection } from "./quality-provider-reservation-ui";
import {
  candidateRegistryCanonical as canonical,
  candidateRegistryDigest as digest,
} from "./quality-candidate-registry-ui";

export const reservationOutboxKey = "venturepass:provider-reservation-outbox:v1";
export const reservationOutboxLock = "venturepass:provider-reservation-outbox";
export const reservationOutboxLimits = {
  bytes: 96 * 1024,
  responseBytes: 16 * 1024,
  timeoutMs: 20000,
};
const base = "/api/studio/quality/provider-reservation";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const requestSchema = providerReservationInputSchema.extend({
  approvedReview: providerReservationReviewSchema,
});
const outcomeSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending") }).strict(),
  z.object({ state: z.literal("committed"), receipt: providerReservationReceiptSchema }).strict(),
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
export type ReservationJournal = z.infer<typeof journalSchema>;
type JournalBody = Omit<ReservationJournal, "journalDigest">;
type Receipt = z.infer<typeof providerReservationReceiptSchema>;
export type ReservationOutboxDependencies = {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  exclusive: <T>(work: () => Promise<T>) => Promise<T>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => string;
  uuid: () => string;
};
const messages = {
  UNSUPPORTED: "이 브라우저에서 요청 보관과 탭 잠금을 사용할 수 없어 예약을 중단했습니다.",
  BUSY: "다른 탭에서 예약 요청을 처리하고 있습니다. 잠시 후 보관 요청을 다시 읽어 주세요.",
  STORAGE: "요청 보관 상태를 확인하지 못했습니다. 원래 요청을 보존하고 새 요청을 만들지 마세요.",
  CORRUPT: "보관한 요청을 검증하지 못했습니다. 기록을 지우거나 새 예약 요청을 만들지 마세요.",
  CHANGED:
    "다른 탭에서 보관 요청이 바뀌었습니다. 원래 기록을 덮어쓰지 않았습니다. 다시 읽어 주세요.",
  EXISTING: "먼저 보관한 예약 요청의 결과를 확인해 주세요.",
  PENDING: "결과 미확인 요청은 닫거나 교체할 수 없습니다. 같은 요청으로 결과를 확인해 주세요.",
  REVIEW: "검토안과 확인 내용을 다시 확인해 주세요. 기한이 지났거나 조건이 달라졌을 수 있습니다.",
} as const;
export class ReservationOutboxError extends Error {
  constructor(public readonly code: keyof typeof messages) {
    super(messages[code]);
  }
}
const fail = (code: keyof typeof messages): never => {
  throw new ReservationOutboxError(code);
};
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
function bodyOf(value: ReservationJournal): JournalBody {
  const { journalDigest: _ignored, ...body } = value;
  void _ignored;
  return body;
}
async function seal(body: JournalBody): Promise<ReservationJournal> {
  return { ...body, journalDigest: await digest(body) };
}

/** Historical receipt identity checking, not current state or the server's full ledger audit. */
function matchesReceipt(
  receipt: Receipt,
  journal: Pick<ReservationJournal, "request" | "commandDigest">,
) {
  const { command, approvedReview: review } = journal.request;
  return (
    receipt.clientRequestId === command.clientRequestId &&
    receipt.commandDigest === journal.commandDigest &&
    receipt.approvedReviewDigest === command.approvedReviewDigest &&
    Date.parse(receipt.recordedAt) >= Date.parse(command.approval.approvedAt) &&
    Date.parse(receipt.recordedAt) < Date.parse(review.policyReview.expiresAt)
  );
}
export async function decodeReservationJournal(raw: string): Promise<ReservationJournal> {
  try {
    if (bytes(raw) > reservationOutboxLimits.bytes) return fail("CORRUPT");
    const journal = journalSchema.parse(JSON.parse(raw));
    const { command, approvedReview: review } = journal.request;
    if (
      journal.journalDigest !== (await digest(bodyOf(journal))) ||
      journal.commandDigest !== (await digest(command)) ||
      command.approvedReviewDigest !== review.reviewDigest ||
      review.reviewDigest !== (await digest(providerReservationReviewDigestInput(review))) ||
      review.policyReview.reviewDigest !==
        (await digest(providerPolicyReviewDigestInput(review.policyReview))) ||
      command.version !== review.policyReview.scope.version ||
      command.versionDigest !== review.policyReview.scope.versionDigest ||
      command.candidateId !== review.policyReview.scope.candidateId ||
      review.assessment.state !== "conditions-met" ||
      review.policy.state !== "matched" ||
      !same(command.expectedPolicyReference, review.policy.reference) ||
      !same(command.expectedPolicyHead, review.policyHead) ||
      !same(command.expectedBudgetHead, {
        revision: review.policyReview.budget.revision,
        headDigest: review.policyReview.budget.headDigest,
      }) ||
      command.expectedLedgerDigest !== review.ledgerDigest ||
      command.expectedGlobalRunCount !== review.runs.globalCount ||
      command.expectedProductionRunCount !== review.runs.productionCount ||
      Date.parse(command.approval.approvedAt) < Date.parse(review.policyReview.inspectedAt) ||
      Date.parse(command.approval.approvedAt) >= Date.parse(review.policyReview.expiresAt) ||
      bytes(canonical(journal.request)) > providerReservationHttpLimits.bodyBytes ||
      (journal.outcome.state === "committed" && !matchesReceipt(journal.outcome.receipt, journal))
    )
      return fail("CORRUPT");
    return journal;
  } catch {
    return fail("CORRUPT");
  }
}

async function responseValue(response: Response) {
  if (
    !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") ||
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
      if (size > reservationOutboxLimits.responseBytes) {
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
  return providerReservationResponseSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result)),
  );
}

/** One journal per browser origin. All cooperating writers hold the same Web Lock through response persistence. */
export class ReservationOutbox {
  private damaged = false;
  constructor(private readonly deps: ReservationOutboxDependencies) {}
  private raw() {
    try {
      return this.deps.storage.getItem(reservationOutboxKey);
    } catch {
      return fail("STORAGE");
    }
  }
  async read() {
    const raw = this.raw();
    return raw === null ? null : decodeReservationJournal(raw);
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
    await decodeReservationJournal(raw);
    this.assertRaw(expected);
    try {
      this.deps.storage.setItem(reservationOutboxKey, raw);
      if (this.raw() !== raw) throw new Error("Read-back mismatch");
    } catch {
      this.damaged = true;
      return fail("STORAGE");
    }
    return { journal, raw };
  }
  async begin(rawView: unknown, registry: CandidateRegistrySnapshot, acknowledgements: unknown) {
    return this.deps.exclusive(async () => {
      if (this.damaged) return fail("STORAGE");
      if (this.raw() !== null) return fail("EXISTING");
      let review: ProviderReservationReview;
      try {
        z.object({
          candidate: z.literal(true),
          budget: z.literal(true),
          reservation: z.literal(true),
          financial: z.literal(true),
          retention: z.literal(true),
          retry: z.literal(true),
        })
          .strict()
          .parse(acknowledgements);
        const supplied = z
          .object({ selection: z.object({ candidateId: z.string() }) })
          .parse(rawView);
        const inspected = await qualityProviderReservationInspection(
          rawView,
          registry,
          supplied.selection.candidateId,
        );
        if (
          inspected.status !== "review" ||
          inspected.review.assessment.state !== "conditions-met" ||
          inspected.review.policy.state !== "matched"
        )
          return fail("REVIEW");
        review = inspected.review;
      } catch {
        return fail("REVIEW");
      }
      const approvedAt = this.deps.now();
      if (
        !z.string().datetime().safeParse(approvedAt).success ||
        Date.parse(approvedAt) < Date.parse(review.policyReview.inspectedAt) ||
        Date.parse(approvedAt) >= Date.parse(review.policyReview.expiresAt)
      )
        return fail("REVIEW");
      const request = requestSchema.parse({
        command: {
          commandVersion: 1,
          kind: "reserve-provider-candidate",
          clientRequestId: this.deps.uuid(),
          version: review.policyReview.scope.version,
          versionDigest: review.policyReview.scope.versionDigest,
          candidateId: review.policyReview.scope.candidateId,
          expectedPolicyHead: review.policyHead,
          approvedReviewDigest: review.reviewDigest,
          expectedLedgerDigest: review.ledgerDigest,
          expectedPolicyReference: review.policy.reference,
          expectedBudgetHead: {
            revision: review.policyReview.budget.revision,
            headDigest: review.policyReview.budget.headDigest,
          },
          expectedGlobalRunCount: review.runs.globalCount,
          expectedProductionRunCount: review.runs.productionCount,
          approval: {
            noticeVersion: 1,
            acknowledgedCandidate: true,
            acknowledgedCurrentBudget: true,
            acknowledgedReservationOnly: true,
            acknowledgedFinancialBasisNotTokenFit: true,
            acknowledgedRetention: true,
            acknowledgedNoAutomaticRetry: true,
            transmission: "separate-approval-required",
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
      const journal = await decodeReservationJournal(raw);
      if (journal.request.command.clientRequestId !== expectedId) return fail("CHANGED");
      this.assertRaw(raw);
      if (journal.outcome.state !== "pending") return journal;
      // Recovery never gets the first-attempt exception, even after a not-observed lookup or refusal.
      return this.attempt(journal, raw, mode, false);
    });
  }
  private async attempt(
    journal: ReservationJournal,
    raw: string,
    mode: "lookup" | "replay",
    first: boolean,
  ) {
    this.assertRaw(raw);
    let outcome: ReservationJournal["outcome"] = { state: "pending" };
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), reservationOutboxLimits.timeoutMs);
    try {
      const response = await this.deps.fetch(
        mode === "lookup"
          ? `${base}/requests/${journal.request.command.clientRequestId}`
          : `${base}/reservations`,
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
        response.ok &&
        (mode === "lookup" ? result.delivery === "lookup" : result.delivery !== "lookup") &&
        matchesReceipt(result.receipt, journal)
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
      const journal = await decodeReservationJournal(raw);
      if (journal.request.command.clientRequestId !== expectedId) return fail("CHANGED");
      if (journal.outcome.state === "pending") return fail("PENDING");
      this.assertRaw(raw);
      try {
        this.deps.storage.removeItem(reservationOutboxKey);
        if (this.raw() !== null) throw new Error("Remove mismatch");
      } catch {
        this.damaged = true;
        return fail("STORAGE");
      }
    });
  }
}

export function browserReservationOutbox() {
  try {
    if (
      !window.isSecureContext ||
      !navigator.locks?.request ||
      !crypto.subtle ||
      !crypto.randomUUID
    )
      return fail("UNSUPPORTED");
    return new ReservationOutbox({
      storage: window.localStorage,
      exclusive: async (work) =>
        await navigator.locks.request(
          reservationOutboxLock,
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
