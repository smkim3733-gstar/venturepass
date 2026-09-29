import { z } from "zod";
import type { CandidateRegistrySnapshot } from "@/lib/studio-plan-quality-candidate-registry-types";
import {
  providerPolicyAdoptionInputSchema,
  providerPolicyAdoptionReceiptSchema,
  providerPolicyAdoptionResponseSchema,
  providerPolicyHttpLimits,
  type ProviderPolicyInspection,
} from "@/lib/studio-plan-quality-provider-policy-http-types";
import {
  providerPolicyReviewSchema,
  providerPolicyReviewDigestInput,
} from "@/lib/studio-plan-quality-provider-policy-review-types";
import { qualityProviderReview } from "./quality-provider-review-ui";
import {
  candidateRegistryCanonical as canonical,
  candidateRegistryDigest as digest,
} from "./quality-candidate-registry-ui";

export const policyOutboxKey = "venturepass:provider-policy-outbox:v1";
export const policyOutboxLock = "venturepass:provider-policy-outbox";
export const policyOutboxLimits = { bytes: 96 * 1024, responseBytes: 16 * 1024, timeoutMs: 20000 };
const base = "/api/studio/quality/provider-policy";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const requestSchema = providerPolicyAdoptionInputSchema.extend({
  approvedReview: providerPolicyReviewSchema,
});
const outcomeSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending") }).strict(),
  z
    .object({ state: z.literal("committed"), receipt: providerPolicyAdoptionReceiptSchema })
    .strict(),
  // Only a directly observed refusal of the first, exclusively owned attempt can be terminal.
  z.object({ state: z.literal("refused"), code: z.string().min(1).max(120) }).strict(),
]);
const journalSchema = z
  .object({
    journalVersion: z.literal(1),
    request: requestSchema,
    requestDigest: hash,
    outcome: outcomeSchema,
    journalDigest: hash,
  })
  .strict();
export type PolicyJournal = z.infer<typeof journalSchema>;
type JournalBody = Omit<PolicyJournal, "journalDigest">;
type Receipt = z.infer<typeof providerPolicyAdoptionReceiptSchema>;
export type PolicyOutboxDependencies = {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  exclusive: <T>(work: () => Promise<T>) => Promise<T>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => string;
  uuid: () => string;
};
const messages = {
  UNSUPPORTED: "이 브라우저에서 요청 보관과 탭 잠금을 사용할 수 없어 채택을 중단했습니다.",
  BUSY: "다른 탭에서 정책 요청을 처리하고 있습니다. 잠시 후 보관 요청을 다시 읽어 주세요.",
  STORAGE: "요청 보관 상태를 확인하지 못했습니다. 원래 요청을 보존하고 새 요청을 만들지 마세요.",
  CORRUPT: "보관한 요청을 검증하지 못했습니다. 기록을 지우거나 새 채택 요청을 만들지 마세요.",
  CHANGED:
    "다른 탭에서 보관 요청이 바뀌었습니다. 원래 기록을 덮어쓰지 않았습니다. 다시 읽어 주세요.",
  EXISTING: "먼저 보관한 정책 요청의 결과를 확인해 주세요.",
  PENDING: "결과 미확인 요청은 닫거나 교체할 수 없습니다. 같은 요청으로 결과를 확인해 주세요.",
  REVIEW: "검토안과 확인 내용을 다시 확인해 주세요. 기한이 지났거나 조건이 달라졌을 수 있습니다.",
} as const;
export class PolicyOutboxError extends Error {
  constructor(public readonly code: keyof typeof messages) {
    super(messages[code]);
  }
}
const fail = (code: keyof typeof messages): never => {
  throw new PolicyOutboxError(code);
};
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
function bodyOf(value: PolicyJournal): JournalBody {
  const { journalDigest: _ignored, ...body } = value;
  void _ignored;
  return body;
}
async function seal(body: JournalBody): Promise<PolicyJournal> {
  return { ...body, journalDigest: await digest(body) };
}

/** Receipt identity/transition checking, not a substitute for the server's full ledger audit. */
function matchesReceipt(
  receipt: Receipt,
  journal: Pick<PolicyJournal, "request" | "requestDigest">,
) {
  const { command, approvedReview: review } = journal.request;
  const transition = receipt.budgetTransition;
  const before = { revision: review.budget.revision, headDigest: review.budget.headDigest };
  return (
    receipt.clientRequestId === command.clientRequestId &&
    receipt.requestDigest === journal.requestDigest &&
    receipt.approvedReviewDigest === command.approvedReviewDigest &&
    receipt.revision === command.expectedPolicyHead.revision + 1 &&
    Date.parse(receipt.recordedAt) >= Date.parse(command.approval.approvedAt) &&
    Date.parse(receipt.recordedAt) < Date.parse(review.expiresAt) &&
    transition.kind === command.budgetAction &&
    same(transition.before, before) &&
    transition.initializationRequestId === command.initialBudgetRequestId &&
    (command.budgetAction === "keep-existing-budget"
      ? same(transition.after, before)
      : before.revision === 0 &&
        transition.after.revision === 1 &&
        transition.after.headDigest !== null)
  );
}
export async function decodePolicyJournal(raw: string): Promise<PolicyJournal> {
  try {
    if (bytes(raw) > policyOutboxLimits.bytes) return fail("CORRUPT");
    const journal = journalSchema.parse(JSON.parse(raw));
    const { command, approvedReview: review } = journal.request;
    if (
      journal.journalDigest !== (await digest(bodyOf(journal))) ||
      journal.requestDigest !== (await digest(command)) ||
      command.approvedReviewDigest !== review.reviewDigest ||
      review.reviewDigest !== (await digest(providerPolicyReviewDigestInput(review))) ||
      command.version !== review.scope.version ||
      command.versionDigest !== review.scope.versionDigest ||
      command.candidateId !== review.scope.candidateId ||
      (command.budgetAction === "initialize-proposed-budget") !== (review.budget.revision === 0) ||
      Date.parse(command.approval.approvedAt) < Date.parse(review.inspectedAt) ||
      Date.parse(command.approval.approvedAt) >= Date.parse(review.expiresAt) ||
      bytes(canonical(journal.request)) > providerPolicyHttpLimits.bodyBytes ||
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
      if (size > policyOutboxLimits.responseBytes) {
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
  return providerPolicyAdoptionResponseSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result)),
  );
}

/** One journal per browser origin. All cooperating writers hold the same Web Lock through response persistence. */
export class PolicyAdoptionOutbox {
  private damaged = false;
  constructor(private readonly deps: PolicyOutboxDependencies) {}
  private raw() {
    try {
      return this.deps.storage.getItem(policyOutboxKey);
    } catch {
      return fail("STORAGE");
    }
  }
  async read() {
    const raw = this.raw();
    return raw === null ? null : decodePolicyJournal(raw);
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
    await decodePolicyJournal(raw);
    this.assertRaw(expected);
    try {
      this.deps.storage.setItem(policyOutboxKey, raw);
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
      let view: ProviderPolicyInspection;
      try {
        z.object({ policy: z.literal(true), budget: z.literal(true) })
          .strict()
          .parse(acknowledgements);
        const supplied = z.object({ scope: z.object({ candidateId: z.string() }) }).parse(rawView);
        const inspected = await qualityProviderReview(
          rawView,
          registry,
          supplied.scope.candidateId,
        );
        if (inspected.viewVersion !== 5) return fail("REVIEW");
        view = inspected;
      } catch {
        return fail("REVIEW");
      }
      const approvedAt = this.deps.now();
      if (
        !z.string().datetime().safeParse(approvedAt).success ||
        Date.parse(approvedAt) < Date.parse(view.inspectedAt) ||
        Date.parse(approvedAt) >= Date.parse(view.policyReview.expiresAt) ||
        view.policyHead.revision >= 100 ||
        view.policyReview.assessment.state === "budget-incompatible"
      )
        return fail("REVIEW");
      const request = requestSchema.parse({
        command: {
          commandVersion: 1,
          kind: "adopt-provider-policy",
          clientRequestId: this.deps.uuid(),
          version: view.scope.version,
          versionDigest: view.scope.versionDigest,
          candidateId: view.scope.candidateId,
          expectedPolicyHead: view.policyHead,
          approvedReviewDigest: view.policyReview.reviewDigest,
          budgetAction: view.policyReview.budget.revision
            ? "keep-existing-budget"
            : "initialize-proposed-budget",
          initialBudgetRequestId: view.policyReview.budget.revision ? null : this.deps.uuid(),
          approval: {
            noticeVersion: 1,
            acknowledgedPolicy: true,
            acknowledgedBudgetAction: true,
            reservationAndTransmission: "separate-approval-required",
            approvedAt,
          },
        },
        approvedReview: view.policyReview,
      });
      const stored = await this.replace(null, {
        journalVersion: 1,
        request,
        requestDigest: await digest(request.command),
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
      const journal = await decodePolicyJournal(raw);
      if (journal.request.command.clientRequestId !== expectedId) return fail("CHANGED");
      this.assertRaw(raw);
      if (journal.outcome.state !== "pending") return journal;
      // Recovery never gets the first-attempt exception, even after a not-observed lookup or refusal.
      return this.attempt(journal, raw, mode, false);
    });
  }
  private async attempt(
    journal: PolicyJournal,
    raw: string,
    mode: "lookup" | "replay",
    first: boolean,
  ) {
    this.assertRaw(raw);
    let outcome: PolicyJournal["outcome"] = { state: "pending" };
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), policyOutboxLimits.timeoutMs);
    try {
      const response = await this.deps.fetch(
        mode === "lookup"
          ? `${base}/requests/${journal.request.command.clientRequestId}`
          : `${base}/adoptions`,
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
      const journal = await decodePolicyJournal(raw);
      if (journal.request.command.clientRequestId !== expectedId) return fail("CHANGED");
      if (journal.outcome.state === "pending") return fail("PENDING");
      this.assertRaw(raw);
      try {
        this.deps.storage.removeItem(policyOutboxKey);
        if (this.raw() !== null) throw new Error("Remove mismatch");
      } catch {
        this.damaged = true;
        return fail("STORAGE");
      }
    });
  }
}

export function browserPolicyOutbox() {
  try {
    if (
      !window.isSecureContext ||
      !navigator.locks?.request ||
      !crypto.subtle ||
      !crypto.randomUUID
    )
      return fail("UNSUPPORTED");
    return new PolicyAdoptionOutbox({
      storage: window.localStorage,
      exclusive: async (work) =>
        await navigator.locks.request(
          policyOutboxLock,
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
