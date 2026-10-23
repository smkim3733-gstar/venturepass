import { z } from "zod";
import { canonicalSelectionValue as canonical } from "./studio-candidate-selection-types";
import {
  comparisonExecutionConsentSchema,
  comparisonExecutionSessionHeader,
  comparisonPostcaptureDisplaySchema,
} from "./studio-comparison-execution-wire";
import {
  publicClaimComparisonRequestCommandSchema,
  publicClaimComparisonRequestIdentitySchema,
} from "./studio-public-claim-comparison-request-types";
import {
  publicClaimPreviewResponse,
  type PublicClaimPreviewView,
} from "@/components/studio/public-claim-preview-ui";
import type { StudioCase } from "./studio-schema";

const uuid = z.string().uuid(),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1).max(10000),
  units = z.string().regex(/^(0|[1-9][0-9]{0,29})$/);
const ownerSchema = z
  .object({
    version: z.literal(1),
    companyId: uuid,
    companyRevision: z.number().int().nonnegative().safe(),
    clientRequestId: uuid,
    sessionId: uuid.optional(),
    runId: uuid.optional(),
    attempted: z.boolean(),
  })
  .strict();
type Owner = z.infer<typeof ownerSchema>;
const binding = z.object({
  sessionId: uuid,
  runId: uuid,
  companyId: uuid,
  companyRevision: z.number().int().nonnegative().safe(),
  runtimeObserved: z.literal(false),
  dispatchAllowed: z.literal(false),
});
const sessionSchema = binding.extend({
  kind: z.literal("comparison-execution-session"),
  closed: z.boolean(),
});
const statusSchema = binding.extend({
  kind: z.literal("comparison-execution-status"),
  status: z.enum(["unused", "reviewed", "running", "attempted", "draining", "closed"]),
  outcome: z.enum(["pending", "returned", "failed"]).nullable(),
  reviewDigest: hash.nullable(),
  bodyCleanupRequired: z.boolean(),
  postcapture: comparisonPostcaptureDisplaySchema.optional(),
  closed: z.boolean().optional(),
  selection: z.object({ runId: uuid, dispatchCommandDigest: hash }).nullable(),
  execution: z
    .object({
      phase: z.string().max(80),
      capturePersisted: z.boolean(),
      cleanupRequired: z.boolean(),
      networkSettled: z.boolean(),
      sdkSettled: z.boolean(),
      ioSettled: z.boolean(),
    })
    .nullable(),
});
const sourceSchema = z.object({
  title: text,
  url: z.string().url(),
  excerpt: text,
  reviewedAt: z.string().datetime(),
  validUntil: z.string().datetime(),
});
export const executionPreparedDisplaySchema = z.object({
  review: z.object({
    runId: uuid,
    companyId: uuid,
    companyRevision: z.number().int().nonnegative().safe(),
    reviewDigest: hash,
    expiresAt: z.string().datetime(),
    request: publicClaimComparisonRequestCommandSchema,
    identity: publicClaimComparisonRequestIdentitySchema,
    financialBasisDigest: hash,
    retentionNoticeDigest: hash,
    basis: z.object({
      model: text,
      destination: z.literal("https://api.openai.com/v1/responses"),
      store: z.literal(false),
      maxCalls: z.literal(1),
      automaticRetryLimit: z.literal(0),
      notice: z.object({ text }),
      sources: z.array(sourceSchema).min(1).max(12),
    }),
  }),
  reservation: z.object({
    financialBasis: z.object({
      basisDigest: hash,
      model: text,
      costs: z.object({
        currency: z.string().regex(/^[A-Z]{3}$/),
        unitScale: z.number().int().min(0).max(12),
        reservedUnits: units,
        inputUnits: units,
        outputUnits: units,
      }),
      evidence: z.object({ sources: z.array(sourceSchema).min(1).max(12) }),
    }),
    retentionNotice: z.object({ localNotice: text, providerNotice: text }),
    retentionNoticeDigest: hash,
  }),
});
type Prepared = z.infer<typeof executionPreparedDisplaySchema>;
type Status = z.infer<typeof statusSchema>;
export const executionAcknowledgements = {
  externalTransmissionAcknowledged:
    "표시된 주장·항목 전체·선택 근거를 외부 AI로 전송하는 데 동의합니다.",
  comparisonPurposeAcknowledged:
    "비교 의견은 사실 확인·기관 적합성 판단을 대신하지 않음을 확인했습니다.",
  singleCallAcknowledged: "표시된 예약 금액과 모델로 한 번만 호출하는 데 동의합니다.",
  noAutomaticRetryAcknowledged: "실패해도 자동으로 재시도하지 않음을 확인했습니다.",
  unknownCostHoldAcknowledged: "비용을 확인할 수 없으면 예약 금액이 보류되는 데 동의합니다.",
  noResendAcknowledged: "응답이 불명확해도 재전송하지 않고 원래 상태를 확인하겠습니다.",
  localRetentionAcknowledged:
    "회사 변경·삭제 뒤에도 로컬 기록이 남으며 공급자 보관 조건은 별도임을 확인했습니다.",
} as const;
export type ExecutionAcknowledgement = keyof typeof executionAcknowledgements;
export function executionAmount(value: string, scale: number) {
  const padded = value.padStart(scale + 1, "0");
  return scale ? padded.slice(0, -scale) + "." + padded.slice(-scale) : padded;
}
type State = {
  owner: Owner | null;
  busy: boolean;
  message: string;
  status: Status | null;
  prepared: Prepared | null;
  input: PublicClaimPreviewView | null;
  snapshot: StudioCase | null;
  closed: boolean;
  registrationFailed: boolean;
};
export const executionStorageKey = "venturepass.comparison-execution.v1";
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
const empty = (): State => ({
  owner: null,
  busy: false,
  message: "",
  status: null,
  prepared: null,
  input: null,
  snapshot: null,
  closed: false,
  registrationFailed: false,
});

/** One root-owned operation. Only routing IDs/attempt marker survive a tab reload;
 * customer text, consent and review bodies never enter browser storage. No automatic IO. */
export function createComparisonExecutionClient(storage: Storage, fetcher: typeof fetch) {
  let state = empty(),
    generation = 0;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<State>) => {
    state = { ...state, ...patch };
    listeners.forEach((fn) => fn());
  };
  function save(owner: Owner) {
    storage.setItem(executionStorageKey, JSON.stringify(owner));
    update({ owner });
  }
  function match(value: z.infer<typeof binding>, owner: Owner) {
    if (
      value.companyId !== owner.companyId ||
      value.companyRevision !== owner.companyRevision ||
      (owner.sessionId && value.sessionId !== owner.sessionId) ||
      (owner.runId && value.runId !== owner.runId)
    )
      throw Error("RESPONSE_MISMATCH");
  }
  async function post(owner: Owner, action: unknown, preview = false): Promise<unknown> {
    const response = await fetcher(
      `/api/studio/cases/${owner.companyId}/public-claim-comparison/${preview ? "preview" : "execution"}`,
      {
        method: "POST",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(30000),
        headers: {
          "content-type": "application/json",
          ...(!preview && owner.sessionId
            ? { [comparisonExecutionSessionHeader]: owner.sessionId }
            : {}),
        },
        body: JSON.stringify(action),
      },
    );
    if (
      !response.body ||
      !/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "")
    )
      throw Error("INVALID_RESPONSE");
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0,
      ended = false;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) {
          ended = true;
          break;
        }
        size += next.value.byteLength;
        if (size > (preview ? 3 * 1024 * 1024 : 128 * 1024)) throw Error("RESPONSE_LIMIT");
        chunks.push(next.value);
      }
    } finally {
      try {
        if (!ended) await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!response.ok) {
      const error = z
        .object({
          kind: z.literal("comparison-execution-error"),
          code: z.string().max(100),
          runtimeObserved: z.literal(false),
        })
        .safeParse(raw);
      throw Error(error.success ? error.data.code : "REQUEST_UNCERTAIN");
    }
    return raw;
  }
  async function perform(work: () => Promise<void>) {
    if (state.busy) return;
    update({ busy: true, message: "요청 결과를 확인 중입니다. 자동 재전송하지 않습니다." });
    try {
      await work();
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      update({
        prepared: null,
        input: null,
        snapshot: null,
        registrationFailed:
          !state.owner?.sessionId && ["NOT_CONFIGURED", "OPEN_UNAVAILABLE"].includes(code),
        message: ["NOT_CONFIGURED", "OPEN_UNAVAILABLE"].includes(code)
          ? "실행 입력 연결을 확인하지 못했습니다. 서버의 검토된 정책·기존 예약 설정이 필요합니다."
          : "요청 결과를 확인하지 못했습니다. 원래 요청을 유지합니다. 등록 또는 상태 확인으로 다시 확인해 주세요.",
      });
    } finally {
      update({ busy: false });
    }
  }
  function requireOwner() {
    if (!state.owner?.sessionId || state.closed) throw Error("OWNER_REQUIRED");
    return state.owner;
  }
  const client = {
    getSnapshot: () => state,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    invalidateReview() {
      generation++;
      if (state.prepared || state.input) update({ prepared: null, input: null, snapshot: null });
    },
    open(company: StudioCase) {
      return perform(async () => {
        if (!state.owner) {
          const saved = storage.getItem(executionStorageKey);
          save(
            saved
              ? ownerSchema.parse(JSON.parse(saved))
              : {
                  version: 1,
                  companyId: company.id,
                  companyRevision: company.revision,
                  clientRequestId: crypto.randomUUID(),
                  attempted: false,
                },
          );
        }
        const owner = state.owner!;
        if (owner.sessionId) {
          update({ message: "원래 실행을 보관하고 있습니다. 상태 확인을 눌러 주세요." });
          return;
        }
        const raw = await post(owner, {
          action: "open",
          companyRevision: owner.companyRevision,
          clientRequestId: owner.clientRequestId,
        });
        const result = sessionSchema.parse(raw);
        match(result, owner);
        save({ ...owner, sessionId: result.sessionId, runId: result.runId });
        update({
          closed: result.closed,
          registrationFailed: false,
          message: result.closed
            ? "이 실행 연결은 종료되었습니다."
            : "실행을 등록했습니다. 비용·전송 내용을 확인해 주세요.",
        });
      });
    },
    preview(company: StudioCase) {
      return perform(async () => {
        client.invalidateReview();
        const token = generation,
          owner = requireOwner();
        if (
          owner.attempted ||
          owner.companyId !== company.id ||
          owner.companyRevision !== company.revision
        )
          throw Error("SELECTION_CHANGED");
        const raw = await post(owner, { action: "preview" });
        const status = statusSchema.parse(raw);
        match(status, owner);
        const prepared = executionPreparedDisplaySchema.parse(
            z.object({ prepared: z.unknown() }).parse(raw).prepared,
          ),
          r = prepared.review;
        if (
          status.status !== "reviewed" ||
          status.outcome !== null ||
          status.reviewDigest !== r.reviewDigest ||
          r.runId !== owner.runId ||
          r.companyId !== owner.companyId ||
          r.companyRevision !== owner.companyRevision ||
          r.basis.model !== r.request.model ||
          prepared.reservation.financialBasis.model !== r.request.model ||
          r.financialBasisDigest !== prepared.reservation.financialBasis.basisDigest ||
          r.retentionNoticeDigest !== prepared.reservation.retentionNoticeDigest ||
          Date.parse(r.expiresAt) <= Date.now()
        )
          throw Error("REVIEW_MISMATCH");
        const input = await publicClaimPreviewResponse(
          await post(owner, r.request, true),
          company,
          r.request,
        );
        if (canonical(input.preview.identity) !== canonical(r.identity))
          throw Error("INPUT_MISMATCH");
        if (token !== generation) {
          update({
            message:
              "화면이 변경되어 검토를 표시하지 않았습니다. 현재 회사에서 다시 확인해 주세요.",
          });
          return;
        }
        update({
          prepared,
          input,
          snapshot: company,
          status,
          message: "비용과 전송 내용을 확인한 뒤 각 동의 항목을 직접 선택해 주세요.",
        });
      });
    },
    execute(company: StudioCase, checks: Partial<Record<ExecutionAcknowledgement, boolean>>) {
      return perform(async () => {
        const owner = requireOwner(),
          review = state.prepared?.review;
        if (
          owner.attempted ||
          state.snapshot !== company ||
          !review ||
          Date.parse(review.expiresAt) <= Date.now()
        )
          throw Error("REVIEW_REQUIRED");
        const consent = comparisonExecutionConsentSchema.parse({
          ...checks,
          clientRequestId: crypto.randomUUID(),
          reviewDigest: review.reviewDigest,
        });
        save({ ...owner, attempted: true }); // Persist before any send; uncertain delivery permits status only.
        const result = statusSchema.parse(await post(owner, { action: "execute", consent }));
        match(result, owner);
        update({
          status: result,
          message: "동의를 전달했습니다. 상태 확인으로 원래 실행 결과를 확인해 주세요.",
        });
      });
    },
    postcapture(operation: "record-result" | "settle-finalize", recovery = false) {
      return perform(async () => {
        const owner = requireOwner(),
          p = state.status?.postcapture;
        if (!p) throw Error("POSTCAPTURE_STATUS_REQUIRED");
        const prior = operation === "record-result" ? p.record : p.settlement;
        if (recovery ? prior === "unattempted" : prior !== "unattempted" || !p.review)
          throw Error("POSTCAPTURE_REVIEW_REQUIRED");
        if (
          !recovery &&
          (operation === "record-result"
            ? p.review!.comparisonRecorded
            : !p.review!.comparisonRecorded ||
              p.review!.costSettled ||
              p.review!.finalized ||
              p.review!.usageStatus !== "known" ||
              p.review!.units === null)
        )
          throw Error("POSTCAPTURE_NOT_READY");
        const action = recovery
          ? { action: "recover-postcapture", operation }
          : { action: operation, reviewDigest: p.review!.reviewDigest };
        update({ status: null }); // Uncertain delivery requires inspect before any further choice.
        const result = statusSchema.parse(await post(owner, action));
        match(result, owner);
        update({
          status: result,
          message: "원래 응답의 보관·정산 상태를 확인했습니다. 최신 비용·보관 확인으로 이어가세요.",
        });
      });
    },
    command(action: "inspect" | "recover" | "close" | "postcapture-preview") {
      return perform(async () => {
        const owner = requireOwner();
        if (action === "postcapture-preview") update({ status: null });
        const result = statusSchema.parse(await post(owner, { action }));
        match(result, owner);
        if (result.selection || result.outcome !== null) save({ ...owner, attempted: true });
        const closed = result.status === "closed" && result.closed === true;
        if (
          closed ||
          result.status !== "reviewed" ||
          result.reviewDigest !== state.prepared?.review.reviewDigest
        )
          client.invalidateReview();
        update({
          status: result,
          closed,
          message: closed
            ? "실행 연결 종료를 확인했습니다."
            : action === "recover"
              ? "원래 실행의 복구 상태를 확인했습니다. 재전송하지 않았습니다."
              : "원래 실행 상태를 확인했습니다.",
        });
      });
    },
    release() {
      if (state.busy || (!state.closed && !state.registrationFailed)) return;
      try {
        storage.removeItem(executionStorageKey);
        generation++;
        update(empty());
      } catch {
        update({ message: "이 창의 연결 기록을 지우지 못했습니다. 원래 요청을 유지합니다." });
      }
    },
  };
  return client;
}
