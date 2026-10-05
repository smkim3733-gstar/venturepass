import "server-only";
import type { JSHandle, Page } from "playwright-core";
import {
  collectVentureScreen, captureVentureInspectionGuard,
} from "./venturein-inspection-collector";
import { sanitizeVentureInspectionUrl, verifyVentureCompany } from "./venturein-inspection";
import {
  decodeVentureMyStatus, validateVentureMyStatusExpected, ventureMyStatusUrl, ventureMyStatusLimits,
  ventureMyReadColumns, VentureMyStatusError,
  type VentureMyStatusExpected, type VentureMyTable,
} from "./venturein-my-status";

type ReadConfig = {
  guard: { isCurrent: () => boolean };
  rawUrl: string;
  limits: typeof ventureMyStatusLimits;
  readColumns: typeof ventureMyReadColumns;
};

/** One synchronous DOM read; never click, navigate, read input values or serialize HTML. */
function readMyTables(config: ReadConfig) {
  if (location.href !== config.rawUrl || !config.guard.isCurrent()) throw new Error("Changed");
  const clean = (value: string) => value.replace(/\s+/gu, " ").trim();
  const visible = (element: Element) => {
    if (element.closest("[hidden], [aria-hidden=true], [inert]")) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" &&
      style.visibility !== "collapse" && element.getClientRects().length > 0;
  };
  const text = (element: Element, max: number) => {
    const value = (element as HTMLElement).innerText || "";
    if (value.length > max) throw new Error("Limit");
    return value;
  };
  const unsupported = (reason: "ambiguous-structure" | "observation-limit" | "unsupported-content"): VentureMyTable =>
    ({ state: "unsupported", reason });
  const all = Array.from(document.querySelectorAll("table"));
  const read = (kind: "application" | "certificate"): VentureMyTable => {
    if (all.length > 200) return unsupported("observation-limit");
    const prefix = kind === "application" ? "벤처확인 신청이력 목록" : "벤처확인서 이력 목록";
    let tables: Element[];
    try {
      tables = all.filter((table) => visible(table) &&
        Array.from(table.children).some((child) =>
          child.tagName === "CAPTION" && clean(text(child, 500)).startsWith(prefix)));
    } catch { return unsupported("observation-limit"); }
    if (tables.length === 0) return { state: "not-present" };
    if (tables.length > 2 || (kind === "application" && tables.length !== 1))
      return unsupported("ambiguous-structure");
    const headersOf = (table: Element) => Array.from(table.querySelectorAll("th"))
      .filter((cell) => cell.closest("table") === table);
    const headerTables = tables.filter((table) => headersOf(table).length > 0);
    if (headerTables.length !== 1) return unsupported("ambiguous-structure");
    const headerTable = headerTables[0];
    let bodyTable = headerTable;
    if (tables.length === 2) {
      bodyTable = tables.find((table) => table !== headerTable)!;
      const scope = headerTable.closest(".board_write_box");
      // No caption-only cross-section joins. Unobserved wrapper variants remain unsupported.
      if (
        !scope || bodyTable.closest(".board_write_box") !== scope ||
        headerTable.parentElement !== scope ||
        !bodyTable.parentElement?.classList.contains("board_list_scroll") ||
        bodyTable.parentElement.parentElement !== scope ||
        headerTable.nextElementSibling !== bodyTable.parentElement ||
        headerTable.querySelector("td") ||
        scope.querySelectorAll("table").length !== 2
      ) return unsupported("ambiguous-structure");
    }
    try {
      const headerCells = headersOf(headerTable);
      if (headerCells.length > 11) return unsupported("observation-limit");
      if (headerCells.some((cell) => !visible(cell) ||
        (cell as HTMLTableCellElement).colSpan !== 1 ||
        (cell as HTMLTableCellElement).rowSpan !== 1))
        return unsupported("ambiguous-structure");
      const headers = headerCells.map((cell) => clean(text(cell, 100)));
      const rows = Array.from(bodyTable.querySelectorAll("tr"))
        .filter((row) => row.closest("table") === bodyTable && row.querySelector("td") && visible(row));
      if (rows.length > config.limits.rows) return unsupported("observation-limit");
      const cells = rows.map((row) => Array.from(row.children));
      if (cells.some((row) => row.length > 11)) return unsupported("observation-limit");
      if (cells.some((row) => row.some((cell) =>
        cell.tagName !== "TD" || !visible(cell) ||
        (cell as HTMLTableCellElement).colSpan !== 1 ||
        (cell as HTMLTableCellElement).rowSpan !== 1 ||
        cell.querySelector("table, input, textarea, select, iframe, [contenteditable]")
      ))) return unsupported("unsupported-content");
      const rowsRead = cells.map((row) => row.map((cell, index) =>
        (config.readColumns[kind] as readonly string[]).includes(headers[index])
          ? text(cell, config.limits.cellChars) : ""));
      return { state: "observed", headers, rows: rowsRead };
    } catch { return unsupported("observation-limit"); }
  };
  const result = { applications: read("application"), certificates: read("certificate") };
  if (location.href !== config.rawUrl || !config.guard.isCurrent()) throw new Error("Changed");
  return { ...result, observedAt: new Date().toISOString() };
}

/**
 * Internal reader for a caller-owned, already authenticated Page. The caller must bind
 * company/account/session/revision in assertCurrent; this function owns none of them.
 * Requires the existing visible authentication guard, and never opens a hidden menu.
 * No DB, route, polling, credentials, selection changes or official status writer.
 */
export async function collectVentureMyStatus(
  page: Page,
  expected: VentureMyStatusExpected,
  assertCurrent: () => void,
) {
  let guard: JSHandle<{ isCurrent: () => boolean }> | undefined;
  let documentHandle: JSHandle<Document> | undefined;
  try {
    // Zod returns a strict copy before the first Page access or await.
    const requested = validateVentureMyStatusExpected(expected);
    assertCurrent();
    const rawUrl = page.url();
    if (page.isClosed() || sanitizeVentureInspectionUrl(rawUrl) !== ventureMyStatusUrl)
      throw new VentureMyStatusError("UNSUPPORTED_PAGE");
    let result: ReturnType<typeof decodeVentureMyStatus>;
    try {
      documentHandle = await page.evaluateHandle(() => document);
      assertCurrent();
      const screen = await collectVentureScreen(page);
      assertCurrent();
      if (screen.url !== ventureMyStatusUrl || verifyVentureCompany(screen, requested.businessNumber).status !== "matched")
        throw new VentureMyStatusError("COMPANY_UNVERIFIED");
      const { id, observedAt, ...semantics } = screen;
      void id; void observedAt;
      guard = await captureVentureInspectionGuard(page, {
        rawUrl, expectedSemantics: JSON.stringify(semantics), observations: [],
      });
      assertCurrent();
      const { observedAt: readAt, ...tables } = await page.evaluate(readMyTables, {
        guard, rawUrl, limits: ventureMyStatusLimits, readColumns: ventureMyReadColumns,
      });
      assertCurrent();
      if (
        page.isClosed() || page.url() !== rawUrl ||
        !(await documentHandle.evaluate((observedDocument) => observedDocument === document))
      ) throw new VentureMyStatusError("SCREEN_CHANGED");
      assertCurrent();
      // Keep the actual table capture time separate from agency notification/issue dates.
      result = decodeVentureMyStatus({ screen: { ...screen, observedAt: readAt }, ...tables }, requested);
    } finally {
      await guard?.dispose().catch(() => undefined);
      await documentHandle?.dispose().catch(() => undefined);
    }
    // Cleanup also awaits: a changed caller session/revision must not receive old data.
    assertCurrent();
    if (page.isClosed() || page.url() !== rawUrl) throw new VentureMyStatusError("SCREEN_CHANGED");
    return { ...result, origin: "page-observation" as const };
  } catch (error) {
    if (error instanceof VentureMyStatusError) throw error;
    // Never disclose Playwright URLs, query values, customer text or callback errors.
    throw new VentureMyStatusError("READ_FAILED");
  }
}
