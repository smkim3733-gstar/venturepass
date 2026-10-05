import "server-only";
import { StudioError } from "./studio-http";
import {
  createKosisReadTransport,
  type KosisReadDependencies,
} from "./studio-kosis-read-transport";
import { createPublicResearchService } from "./studio-public-research-service";
import {
  decodePublicTableMetadata,
  publicTableMetadataCommandSchema,
  publicTableMetadataLimits,
  readPublicTableMetadataResult,
} from "./studio-public-table-metadata";
const fail = () =>
  new StudioError(
    "선택한 표 정보를 확인하지 못했습니다. 검색 후보를 다시 확인해 주세요.",
    502,
    "PUBLIC_TABLE_METADATA_UNAVAILABLE",
  );
export function createPublicTableMetadataService(deps: KosisReadDependencies) {
  const search = createPublicResearchService(deps);
  const read = createKosisReadTransport(deps, fail);
  return async (raw: unknown, callerSignal?: AbortSignal) => {
    const command = publicTableMetadataCommandSchema.parse(raw);
    if (callerSignal?.aborted) throw fail();
    const controller = new AbortController();
    const abort = () => controller.abort();
    callerSignal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 20_000);
    try {
      if (callerSignal?.aborted) controller.abort();
      // Fresh server search proves membership. Caller JSON alone is never a selection receipt.
      const current = await search({ topic: command.topic }, controller.signal);
      if (controller.signal.aborted) throw fail();
      const base = { ...publicTableMetadataLimits, command };
      if (current.status === "not-configured")
        return readPublicTableMetadataResult(
          {
            ...base,
            status: "not-configured",
            source: "not-requested",
            metadata: null,
            searchCheckedAt: null,
            retrievedAt: null,
          },
          command,
        );
      const candidate = current.candidates.find(
        (c) =>
          c.organizationId === command.candidate.organizationId &&
          c.tableId === command.candidate.tableId,
      );
      if (!candidate || JSON.stringify(candidate) !== JSON.stringify(command.candidate))
        throw new StudioError(
          "검색 후보가 바뀌었거나 선택한 표를 확인할 수 없습니다. 후보를 다시 조회해 주세요.",
          409,
          "PUBLIC_TABLE_SELECTION_CHANGED",
        );
      // These metadata responses do not echo org/table IDs. Scope comes from this fixed request.
      const response = await read(
        "metadata",
        {
          method: "getMeta",
          type: command.kind,
          orgId: candidate.organizationId,
          tblId: candidate.tableId,
          format: "json",
          content: "json",
        },
        controller.signal,
      );
      if (controller.signal.aborted) throw fail();
      // A configuration change after the checked search must not become a successful empty result.
      if (response.status !== "received") throw fail();
      const metadata = decodePublicTableMetadata(response.body, command.kind);
      return readPublicTableMetadataResult(
        {
          ...base,
          status: metadata.rows.length ? "results" : "empty",
          source: "kosis-api-response",
          searchCheckedAt: current.retrievedAt,
          retrievedAt: response.retrievedAt,
          metadata,
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
export const readSelectedPublicTableMetadata = createPublicTableMetadataService({
  apiKey: () => process.env.KOSIS_API_KEY,
  fetch: (...args) => globalThis.fetch(...args),
  now: () => new Date().toISOString(),
});
