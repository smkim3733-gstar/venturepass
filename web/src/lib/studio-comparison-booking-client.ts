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
import { publicClaimComparisonSelectionSchema } from "./studio-public-claim-comparison-types";
import {
  bookingStateSchema,
  comparisonReservationConsentSchema,
  type BookingState,
  type BookingSelection,
} from "./studio-comparison-booking-wire";
import {
  publicClaimPreviewResponse,
  type PublicClaimPreviewView,
} from "@/components/studio/public-claim-preview-ui";
import type { StudioCase } from "./studio-schema";
const routingSchema = z
  .object({
    version: z.literal(1),
    registrationId: z.string().uuid(),
    selection: publicClaimComparisonSelectionSchema,
    attempted: z.boolean(),
    requestReference: comparisonRequestReferenceSchema.optional(),
  })
  .strict();
type Routing = z.infer<typeof routingSchema>;
type State = {
  routing: Routing | null;
  archives: RequestArchive<Routing>[];
  status: BookingState | null;
  input: PublicClaimPreviewView | null;
  snapshot: StudioCase | null;
  busy: boolean;
  message: string;
};
const key = "venturepass.comparison-booking.v1";
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
async function read(response: Response, limit = 128 * 1024) {
  if (!response.body) throw Error("INVALID_RESPONSE");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw Error("LIMIT");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all));
  if (!response.ok)
    throw Error(
      value?.code === "NOT_CONFIGURED"
        ? "NOT_CONFIGURED"
        : response.status === 404 && value?.code === "OWNER_UNAVAILABLE"
          ? "OWNER_UNAVAILABLE"
          : "BOOKING_UNAVAILABLE",
    );
  return value;
}
/** Root-owned routing only. No automatic fetch, stored content/policy/consent, or resend. */
export function createBookingClient(storage: Storage, fetcher: typeof fetch) {
  let state: State = {
      routing: null,
      archives: [],
      status: null,
      input: null,
      snapshot: null,
      busy: false,
      message: "",
    },
    epoch = 0;
  const history = createRequestArchive(storage, key, routingSchema, "reservation");
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
      `/api/studio/cases/${owner.selection.companyId}/public-claim-comparison/booking`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-venturepass-comparison-booking": owner.registrationId,
        },
        body: JSON.stringify(action),
        signal: AbortSignal.timeout(30000),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      },
    );
    const value = bookingStateSchema.parse(await read(response));
    if (
      value.registrationId !== owner.registrationId ||
      canonical(value.selection) !== canonical(owner.selection)
    )
      throw Error("BINDING");
    if (
      owner.requestReference &&
      (value.clientRequestId !== owner.requestReference.clientRequestId ||
        value.runId !== owner.requestReference.runId)
    )
      throw Error("REQUEST_CHANGED");
    const r = value.review,
      receipt = value.receipt;
    if (
      r &&
      (canonical(r.request.selection) !== canonical(owner.selection) ||
        r.companyId !== owner.selection.companyId ||
        r.companyRevision !== owner.selection.companyRevision ||
        r.budget.currency !== r.costs.currency ||
        r.budget.unitScale !== r.costs.unitScale ||
        BigInt(r.costs.inputUnits) + BigInt(r.costs.outputUnits) !== BigInt(r.costs.reservedUnits))
    )
      throw Error("REVIEW");
    if (
      receipt &&
      (receipt.companyId !== owner.selection.companyId ||
        receipt.companyRevision !== owner.selection.companyRevision ||
        receipt.runId !== value.runId ||
        receipt.clientRequestId !== value.clientRequestId)
    )
      throw Error("RECEIPT");
    if ((value.status === "recorded" && !receipt) || (value.status === "closed" && value.retained))
      throw Error("STATE");
    return value;
  }
  async function work(fn: () => Promise<void>) {
    if (state.busy) return;
    update({ busy: true, message: "예약의 상태를 확인하고 있습니다." });
    try {
      await fn();
    } catch (e) {
      update({
        input: null,
        snapshot: null,
        message:
          e instanceof Error && e.message === "NOT_CONFIGURED"
            ? "예약용 검토 정책이 설정되지 않았습니다. 입력 준비 안내에 따라 서버 설정을 확인해 주세요."
            : e instanceof Error && e.message === "OWNER_UNAVAILABLE"
              ? "현재 서버에서 원래 예약 연결을 찾지 못했습니다. 이 회사의 기존 예약 목록에서 항목·시각·요청 번호를 확인하세요. 같은 선택의 과거 예약을 이번 요청의 결과로 단정하지 않으며 자동 재예약하지 않습니다."
              : "예약 상태를 확인하지 못했습니다. 자동 재예약하지 않습니다. 원래 상태 조회·기록 확인·연결 정리를 사용해 주세요.",
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
    archiveConfirmed(company: StudioCase) {
      return work(async () => {
        const currentEpoch = ++epoch;
        update({
          input: null,
          snapshot: null,
          status: state.status ? { ...state.status, review: null } : null,
        });
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
              "확인된 예약 요청을 이 탭에 보관했습니다. 새 작업은 새 검토와 동의로 시작하세요.",
          });
        } catch (error) {
          update({ message: archiveFailure(error) });
        }
      });
    },
    matchHistory(view: ReservationView) {
      try {
        return matchComparisonHistory("reservation", routing(), view);
      } catch {
        return "브라우저의 원래 예약 식별자를 읽지 못해 대조할 수 없습니다.";
      }
    },
    invalidate() {
      epoch++;
      update({
        input: null,
        snapshot: null,
        status: state.status ? { ...state.status, review: null } : null,
      });
    },
    prepare(company: StudioCase, selection: BookingSelection) {
      return work(async () => {
        const currentEpoch = ++epoch;
        update({ input: null, snapshot: null, status: null });
        const selected = publicClaimComparisonSelectionSchema.parse(selection);
        if (company.id !== selected.companyId || company.revision !== selected.companyRevision)
          throw Error("SELECTION");
        let owner = routing();
        if (owner && (canonical(owner.selection) !== canonical(selected) || owner.attempted))
          throw Error("ORIGINAL_OWNER_REQUIRED");
        if (!owner) {
          owner = {
            version: 1,
            registrationId: crypto.randomUUID(),
            selection: selected,
            attempted: false,
          };
          save(owner);
        }
        let opened: BookingState;
        try {
          opened = await request(owner, { action: "open", selection: selected });
        } catch (e) {
          if (e instanceof Error && e.message === "NOT_CONFIGURED") {
            history.clear(owner);
            update({ routing: null });
          }
          throw e;
        }
        update({ status: opened });
        if (currentEpoch !== epoch) return;
        const status = await request(owner, { action: "review" });
        update({ status });
        if (currentEpoch !== epoch || !status.review) return;
        const review = status.review;
        const response = await fetcher(
          `/api/studio/cases/${company.id}/public-claim-comparison/preview`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(review.request),
            signal: AbortSignal.timeout(30000),
            cache: "no-store",
            credentials: "omit",
            redirect: "error",
          },
        );
        const input = await publicClaimPreviewResponse(
          await read(response, 3 * 1024 * 1024),
          company,
          review.request,
        );
        if (canonical(input.preview.identity) !== canonical(review.identity))
          throw Error("INPUT_CHANGED");
        if (currentEpoch !== epoch) return;
        update({
          status,
          input,
          snapshot: company,
          message: "선택 내용·예산·보관 조건을 검토한 뒤 각 항목에 동의해 주세요.",
        });
      });
    },
    reserve(company: StudioCase, consent: unknown) {
      return work(async () => {
        const owner = routing(),
          review = state.status?.review;
        const parsed = comparisonReservationConsentSchema.parse(consent);
        if (
          !owner ||
          owner.attempted ||
          !review ||
          state.snapshot !== company ||
          !state.input ||
          review.reviewDigest !== parsed.reviewDigest ||
          Date.now() < Date.parse(review.inspectedAt) ||
          Date.now() >= Date.parse(review.expiresAt)
        )
          throw Error("REVIEW_REQUIRED");
        const pending = {
          ...owner,
          attempted: true,
          requestReference: comparisonRequestReferenceSchema.parse({
            clientRequestId: state.status!.clientRequestId,
            runId: state.status!.runId,
          }),
        };
        save(pending); // Verify persistence before writing; loss of delivery never enables resend.
        update({ input: null, snapshot: null, status: { ...state.status!, review: null } });
        const status = await request(pending, { action: "reserve", consent: parsed });
        update({
          status,
          message: status.receipt
            ? "예약 기록을 확인했습니다. 외부 전송은 별도 승인 단계에서 진행합니다."
            : "예약 완료를 확인하지 못했습니다. 원래 기록 확인을 사용해 주세요.",
        });
      });
    },
    inspect() {
      return work(async () => {
        const owner = routing();
        if (!owner) {
          update({ message: "이 브라우저에 남은 예약 연결이 없습니다." });
          return;
        }
        update({
          status: await request(owner, { action: "inspect" }),
          input: null,
          snapshot: null,
          message: "원래 예약 연결의 상태를 조회했습니다.",
        });
      });
    },
    recover() {
      return work(async () => {
        const owner = routing();
        if (!owner) throw Error("OWNER");
        update({
          status: await request(owner, { action: "recover" }),
          input: null,
          snapshot: null,
          message: "원래 요청의 예약 기록을 조회했습니다. 새 예약은 만들지 않았습니다.",
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
          input: null,
          snapshot: null,
          message:
            status.status === "closed"
              ? "예약 연결을 정리했습니다. 기존 예약·예산 보유는 취소되지 않습니다."
              : "원래 연결의 정리가 끝나지 않았습니다. 연결 정리를 다시 시도해 주세요.",
        });
        if (status.status === "closed") {
          history.clear(owner);
          update({ routing: null });
        }
      });
    },
  });
}
