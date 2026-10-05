import "server-only";
import { StudioError } from "./studio-http";
import type { KosisReadDependencies } from "./studio-kosis-read-transport";
import {
  createPublicResearchService,
  requireCurrentPublicTableCandidate,
} from "./studio-public-research-service";
import { createPublicStatisticsCellService } from "./studio-public-statistics-service";
import {
  publicSelectedCellCommandSchema,
  publicSelectedCellLimits,
  selectedCellTarget,
  readPublicSelectedCellResult,
} from "./studio-public-selected-cell";
const fail = () =>
  new StudioError(
    "선택한 통계 수치를 확인하지 못했습니다. 검색 후보와 코드를 확인한 뒤 다시 조회해 주세요.",
    502,
    "PUBLIC_SELECTED_CELL_UNAVAILABLE",
  );
export function createPublicSelectedCellService(deps: KosisReadDependencies) {
  const search = createPublicResearchService(deps);
  const readCell = createPublicStatisticsCellService(deps);
  return async (raw: unknown, callerSignal?: AbortSignal) => {
    // A parsed copy binds every manual selection before any network await.
    const command = publicSelectedCellCommandSchema.parse(raw);
    const target = selectedCellTarget(command);
    if (callerSignal?.aborted) throw fail();
    const controller = new AbortController();
    const abort = () => controller.abort();
    callerSignal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 20_000);
    try {
      if (callerSignal?.aborted) controller.abort();
      const current = await search({ topic: command.topic }, controller.signal);
      if (controller.signal.aborted) throw fail();
      const base = { ...publicSelectedCellLimits, command };
      if (current.status === "not-configured")
        return readPublicSelectedCellResult(
          {
            ...base,
            status: "not-configured",
            source: "not-requested",
            cell: null,
            searchCheckedAt: null,
            retrievedAt: null,
          },
          command,
        );
      requireCurrentPublicTableCandidate(current, command.candidate);
      const response = await readCell(target, controller.signal);
      if (controller.signal.aborted || response.status === "not-configured") throw fail();
      return readPublicSelectedCellResult(
        {
          ...base,
          status: response.status,
          source: response.source,
          cell: response.cell,
          searchCheckedAt: current.retrievedAt,
          retrievedAt: response.retrievedAt,
        },
        command,
      );
    } catch (error) {
      if (
        error instanceof StudioError &&
        ["PUBLIC_RESEARCH_BUSY", "PUBLIC_TABLE_SELECTION_CHANGED"].includes(error.code)
      )
        throw error;
      throw fail();
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abort);
    }
  };
}
export const readSelectedPublicStatisticsCell = createPublicSelectedCellService({
  apiKey: () => process.env.KOSIS_API_KEY,
  fetch: (...args) => globalThis.fetch(...args),
  now: () => new Date().toISOString(),
});
