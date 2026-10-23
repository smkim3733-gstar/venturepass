import { z } from "zod";
import { decodeReservationView, type ReservationView } from "./studio-comparison-reservations-wire";
type Company = { id: string; revision: number };
type State = {
  snapshot: Company | null;
  view: ReservationView | null;
  selected: string;
  busy: boolean;
  message: string;
};
const companySchema = z.object({
  id: z.string().uuid(),
  revision: z.number().int().nonnegative().safe(),
});
async function body(response: Response) {
  if (!response.body) throw Error("CATALOG_UNAVAILABLE");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 128 * 1024) {
        await reader.cancel();
        throw Error("CATALOG_LIMIT");
      }
      chunks.push(item.value);
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
      ["NOT_CONFIGURED", "CLEANUP_REQUIRED"].includes(value?.code)
        ? value.code
        : "CATALOG_UNAVAILABLE",
    );
  return value;
}
export async function readReservationView(fetcher: typeof fetch, company: Company) {
  companySchema.parse(company);
  const response = await fetcher(
    `/api/studio/cases/${company.id}/public-claim-comparison/reservations?revision=${company.revision}`,
    {
      method: "GET",
      signal: AbortSignal.timeout(30000),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    },
  );
  return decodeReservationView(await body(response), company);
}
/** Display-only selection. No execution client, policy input, local storage or automatic request. */
export function createReservationClient(fetcher: typeof fetch) {
  const initial = (): State => ({
    snapshot: null,
    view: null,
    selected: "",
    busy: false,
    message: "",
  });
  let state = initial(),
    pending: AbortController | null = null;
  const listeners = new Set<() => void>();
  function update(value: Partial<State>) {
    state = { ...state, ...value };
    listeners.forEach((fn) => fn());
  }
  async function request(company: Company, cleanup: boolean) {
    if (pending) return;
    companySchema.parse(company);
    const controller = new AbortController();
    pending = controller;
    update({
      snapshot: company,
      view: null,
      selected: "",
      busy: true,
      message: cleanup
        ? "예약 조회 연결을 정리하고 있습니다."
        : "기존 예약과 현재 실행 입력을 확인하고 있습니다.",
    });
    try {
      const response = await fetcher(
        `/api/studio/cases/${company.id}/public-claim-comparison/reservations${cleanup ? "" : "?revision=" + company.revision}`,
        {
          method: cleanup ? "DELETE" : "GET",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
        },
      );
      const value = await body(response);
      if (pending !== controller || controller.signal.aborted) return;
      if (cleanup) {
        z.object({ closed: z.literal(true) })
          .strict()
          .parse(value);
        update({ message: "예약 조회 연결을 정리했습니다. 목록을 다시 불러오세요." });
      } else {
        const view = decodeReservationView(value, company);
        update({
          view,
          message: view.reservations.length
            ? "예약 목록을 확인했습니다. 살펴볼 예약을 직접 선택하세요."
            : "이 회사에 기록된 비교 예약이 없습니다.",
        });
      }
    } catch (error) {
      if (pending === controller && !controller.signal.aborted)
        update({
          message:
            error instanceof Error && error.message === "NOT_CONFIGURED"
              ? "예약 조회 연결이 설정되지 않았습니다. 기존 실행 저장소 설정을 확인해 주세요."
              : error instanceof Error && error.message === "CLEANUP_REQUIRED"
                ? "이전 예약 조회 연결의 정리가 필요합니다. 연결 정리 후 다시 불러오세요."
                : "예약 목록을 확인하지 못했습니다. 연결 정리 후 회사 버전과 저장 기록을 확인해 주세요.",
        });
    } finally {
      if (pending === controller) {
        pending = null;
        update({ busy: false });
      }
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
    load: (company: Company) => request(company, false),
    cleanup: (company: Company) => request(company, true),
    select(runId: string) {
      update({ selected: state.view?.reservations.some((r) => r.runId === runId) ? runId : "" });
    },
    invalidate() {
      pending?.abort();
      pending = null;
      state = initial();
      listeners.forEach((fn) => fn());
    },
  });
}
