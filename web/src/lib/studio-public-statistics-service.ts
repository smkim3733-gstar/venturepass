import "server-only";
import { StudioError } from "./studio-http";
import {
  createKosisReadTransport,
  type KosisReadDependencies,
} from "./studio-kosis-read-transport";
import {
  decodePublicStatisticsCell,
  readPublicStatisticsCellTarget,
  publicStatisticsReadLimits,
} from "./studio-public-statistics-cell";

const fail = () =>
  new StudioError(
    "선택한 공개 통계 수치를 확인하지 못했습니다. 선택 범위와 원문을 직접 확인해 주세요.",
    502,
    "PUBLIC_STATISTICS_UNAVAILABLE",
  );
/** Internal only. No route/UI accepts arbitrary cell targets in this development unit. */
export function createPublicStatisticsCellService(deps: KosisReadDependencies) {
  const read = createKosisReadTransport(deps, fail);
  return async (raw: unknown, signal?: AbortSignal) => {
    const target = readPublicStatisticsCellTarget(raw);
    const parameters: Record<string, string> = {
      method: "getList",
      orgId: target.organizationId,
      tblId: target.tableId,
      itmId: target.itemId,
      prdSe: target.period.cycle,
      startPrdDe: target.period.point,
      endPrdDe: target.period.point,
      format: "json",
      smblChk: "Y",
    };
    target.classifications.forEach((id, i) => {
      parameters[`objL${i + 1}`] = id;
    });
    const response = await read("cell", parameters, signal);
    if (response.status === "not-configured")
      return {
        ...publicStatisticsReadLimits,
        source: "not-requested" as const,
        status: "not-configured" as const,
        target,
        cell: null,
        retrievedAt: null,
      };
    try {
      // Target is a parsed copy captured before the await. Caller mutation cannot change it.
      const decoded = decodePublicStatisticsCell(response.body, target);
      return {
        ...decoded,
        source: "kosis-api-response" as const,
        retrievedAt: response.retrievedAt,
      };
    } catch {
      throw fail();
    }
  };
}
export const readPublicStatisticsCell = createPublicStatisticsCellService({
  apiKey: () => process.env.KOSIS_API_KEY,
  fetch: (...args) => globalThis.fetch(...args),
  now: () => new Date().toISOString(),
});
