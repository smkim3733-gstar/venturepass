import { z } from "zod";
import {
  createRequestArchive,
  requireMissingComparisonOwner,
  archiveFailure,
  type RequestArchive,
} from "./studio-comparison-request-archive";
import { readReservationView } from "./studio-comparison-reservations-client";
import {
  comparisonRequestReferenceSchema,
  matchComparisonHistory,
} from "./studio-comparison-history-match";
import type { ReservationView } from "./studio-comparison-reservations-wire";
import { canonicalSelectionValue as canonical } from "./studio-candidate-selection-types";
import {
  cancellationSelectionSchema,
  cancellationConsentSchema,
  cancellationStateSchema,
  type CancellationSelection,
  type CancellationState,
} from "./studio-comparison-cancellation-wire";
const routingSchema = z
  .object({
    version: z.literal(1),
    registrationId: z.string().uuid(),
    selection: cancellationSelectionSchema,
    attempted: z.boolean(),
    requestReference: comparisonRequestReferenceSchema.optional(),
  })
  .strict();
type Routing = z.infer<typeof routingSchema>;
type Company = { id: string; revision: number };
type State = {
  routing: Routing | null;
  archives: RequestArchive<Routing>[];
  status: CancellationState | null;
  snapshot: Company | null;
  busy: boolean;
  message: string;
};
const key = "venturepass.comparison-cancellation.v1";
async function read(response: Response) {
  if (!response.body) throw Error("RESPONSE");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const v = await reader.read();
      if (v.done) break;
      size += v.value.byteLength;
      if (size > 64 * 1024) {
        await reader.cancel();
        throw Error("LIMIT");
      }
      chunks.push(v.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!response.ok)
    throw Error(
      value?.code === "NOT_CONFIGURED"
        ? "NOT_CONFIGURED"
        : response.status === 404 && value?.code === "OWNER_UNAVAILABLE"
          ? "OWNER_UNAVAILABLE"
          : "CANCELLATION_UNAVAILABLE",
    );
  return value;
}
export function createCancellationClient(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  fetcher: typeof fetch,
) {
  let state: State = {
      routing: null,
      archives: [],
      status: null,
      snapshot: null,
      busy: false,
      message: "",
    },
    epoch = 0;
  const history = createRequestArchive(storage, key, routingSchema, "cancellation");
  const listeners = new Set<() => void>();
  const update = (patch: Partial<State>) => {
    state = { ...state, ...patch };
    listeners.forEach((fn) => fn());
  };
  function routing() {
    const current = history.load();
    update({ routing: current.active, archives: current.archives });
    return current.active;
  }
  function save(owner: Routing) {
    history.save(owner);
    update({ routing: owner });
  }
  async function request(owner: Routing, action: unknown) {
    const response = await fetcher(
      `/api/studio/cases/${owner.selection.companyId}/public-claim-comparison/cancellation`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-venturepass-comparison-cancellation": owner.registrationId,
        },
        body: JSON.stringify(action),
        signal: AbortSignal.timeout(30000),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      },
    );
    const value = cancellationStateSchema.parse(await read(response));
    if (
      value.registrationId !== owner.registrationId ||
      canonical(value.selection) !== canonical(owner.selection)
    )
      throw Error("BINDING");
    if (
      owner.requestReference &&
      (value.clientRequestId !== owner.requestReference.clientRequestId ||
        value.selection.runId !== owner.requestReference.runId)
    )
      throw Error("REQUEST_CHANGED");
    for (const item of [value.review, value.receipt])
      if (
        item &&
        (item.companyId !== owner.selection.companyId ||
          item.companyRevision !== owner.selection.companyRevision ||
          item.runId !== owner.selection.runId)
      )
        throw Error("SELECTION");
    if (
      (value.status === "recorded" && !value.receipt) ||
      (value.status === "closed" && value.retained) ||
      (value.receipt && value.receipt.clientRequestId !== value.clientRequestId)
    )
      throw Error("RECEIPT");
    return value;
  }
  async function work(fn: () => Promise<void>) {
    if (state.busy) return;
    update({ busy: true, message: "취소 상태를 확인하고 있습니다." });
    try {
      await fn();
    } catch (e) {
      update({
        snapshot: null,
        status: state.status ? { ...state.status, review: null } : null,
        message:
          e instanceof Error && e.message === "NOT_CONFIGURED"
            ? "취소에 사용할 기존 저장소 설정이 없습니다."
            : e instanceof Error && e.message === "OWNER_UNAVAILABLE"
              ? "현재 서버에서 원래 취소 연결을 찾지 못했습니다. 이 회사의 기존 예약 목록에서 예약을 직접 선택해 저장된 예약·취소 기록을 확인하세요. 과거 기록을 이번 요청의 결과로 단정하지 않으며 취소를 다시 보내지 않습니다."
              : "취소를 확인하지 못했습니다. 자동 반복하지 않습니다. 전송 여부·현재 회사 버전을 확인하고 원래 취소 상태 조회·기록 확인·연결 정리를 사용해 주세요.",
      });
    } finally {
      update({ busy: false });
    }
  }
  return Object.freeze({
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    getSnapshot: () => state,
    showArchives() {
      return work(async () => {
        routing();
        update({
          message: "이 탭에 보관한 요청 기록을 읽었습니다. 현재 서버 상태는 별도로 조회하세요.",
        });
      });
    },
    archiveConfirmed(company: Company) {
      return work(async () => {
        const currentEpoch = ++epoch;
        update({ snapshot: null, status: state.status ? { ...state.status, review: null } : null });
        try {
          const owner = routing();
          if (
            !owner?.attempted ||
            !owner.requestReference ||
            owner.selection.companyId !== company.id
          )
            throw Error("HISTORY_UNCONFIRMED");
          const inspect = () => request(owner, { action: "inspect" });
          await requireMissingComparisonOwner(inspect);
          const view = await readReservationView(fetcher, company);
          if (currentEpoch !== epoch) throw Error("HISTORY_CHANGED");
          await requireMissingComparisonOwner(inspect);
          if (currentEpoch !== epoch) throw Error("HISTORY_CHANGED");
          const archives = history.archive(owner, view);
          update({
            routing: null,
            status: null,
            archives,
            message:
              "확인된 취소 요청을 이 탭에 보관했습니다. 새 작업은 새 검토와 동의로 시작하세요.",
          });
        } catch (error) {
          update({ message: archiveFailure(error) });
        }
      });
    },
    matchHistory(view: ReservationView) {
      try {
        return matchComparisonHistory("cancellation", routing(), view);
      } catch {
        return "브라우저의 원래 취소 식별자를 읽지 못해 대조할 수 없습니다.";
      }
    },
    invalidate() {
      epoch++;
      update({ snapshot: null, status: state.status ? { ...state.status, review: null } : null });
    },
    review(company: Company, raw: CancellationSelection) {
      return work(async () => {
        const current = ++epoch,
          selection = cancellationSelectionSchema.parse(raw);
        update({ snapshot: null, status: null });
        if (company.id !== selection.companyId || company.revision !== selection.companyRevision)
          throw Error("COMPANY");
        let owner = routing();
        if (owner && (owner.attempted || canonical(owner.selection) !== canonical(selection)))
          throw Error("ORIGINAL_OWNER");
        if (!owner) {
          owner = { version: 1, registrationId: crypto.randomUUID(), selection, attempted: false };
          save(owner);
        }
        try {
          update({ status: await request(owner, { action: "open", selection }) });
        } catch (e) {
          if (e instanceof Error && e.message === "NOT_CONFIGURED") {
            history.clear(owner);
            update({ routing: null });
          }
          throw e;
        }
        if (current !== epoch) return;
        const status = await request(owner, { action: "review" });
        if (current !== epoch) return;
        update({
          status,
          snapshot: company,
          message: "예약 번호·해제 금액·기록 보존 안내를 확인하고 취소 여부를 결정해 주세요.",
        });
      });
    },
    cancel(company: Company, raw: unknown) {
      return work(async () => {
        const owner = routing(),
          review = state.status?.review,
          consent = cancellationConsentSchema.parse(raw);
        if (
          !owner ||
          owner.attempted ||
          !review ||
          state.snapshot !== company ||
          review.reviewDigest !== consent.reviewDigest ||
          Date.now() < Date.parse(review.inspectedAt) ||
          Date.now() >= Date.parse(review.expiresAt)
        )
          throw Error("REVIEW");
        const pending = {
          ...owner,
          attempted: true,
          requestReference: comparisonRequestReferenceSchema.parse({
            clientRequestId: state.status!.clientRequestId,
            runId: owner.selection.runId,
          }),
        };
        save(pending);
        update({ snapshot: null, status: { ...state.status!, review: null } });
        const status = await request(pending, { action: "cancel", consent });
        update({
          status,
          message: status.receipt
            ? "원래 예약의 취소와 예산 보유 해제 기록을 확인했습니다."
            : "취소 결과를 확인하지 못했습니다. 원래 취소 기록을 조회해 주세요.",
        });
      });
    },
    inspect() {
      return work(async () => {
        const owner = routing();
        if (!owner) {
          update({ message: "이 브라우저에 남은 취소 연결이 없습니다." });
          return;
        }
        update({
          status: await request(owner, { action: "inspect" }),
          snapshot: null,
          message: "원래 취소 연결의 상태를 조회했습니다.",
        });
      });
    },
    recover() {
      return work(async () => {
        const owner = routing();
        if (!owner) throw Error("OWNER");
        update({
          status: await request(owner, { action: "recover" }),
          snapshot: null,
          message: "원래 취소 요청의 기록만 조회했습니다.",
        });
      });
    },
    close() {
      return work(async () => {
        const owner = routing();
        if (!owner) throw Error("OWNER");
        epoch++;
        const status = await request(owner, { action: "close" });
        update({
          status,
          snapshot: null,
          message:
            status.status === "closed"
              ? "취소 연결을 정리했습니다. 연결 정리 자체는 예약 취소가 아닙니다."
              : "취소 연결 정리가 끝나지 않았습니다. 원래 연결 정리를 다시 시도해 주세요.",
        });
        if (status.status === "closed") {
          history.clear(owner);
          update({ routing: null });
        }
      });
    },
  });
}
