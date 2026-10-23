import "server-only";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  recordComparisonCompanyConnection,
  issueComparisonCompanyGuard,
  revokeComparisonCompanyGuards,
} from "./studio-comparison-company-capability";
import { checkComparisonDatabasePath } from "./studio-public-comparison-file-identity";
import {
  openComparisonStorageSession,
  closeComparisonStorageSession,
  type ComparisonStorageSession,
} from "./studio-public-comparison-storage-witness";
import { createPublicComparisonProviderService } from "./studio-public-claim-comparison-provider";
import { readComparisonExecutionInputFile } from "./studio-comparison-execution-input-file";

type Service = ReturnType<typeof createPublicComparisonProviderService>;

// Deliberately separate from the read-only history settings. No default DB or path.
function configuration() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const data = process.env.VENTURE_DATA_DIR;
  const control = process.env.VENTUREPASS_COMPARISON_EXECUTION_CONTROL_DIR;
  const id = process.env.VENTUREPASS_COMPARISON_EXECUTION_DATABASE_ID;
  if (
    !apiKey ||
    !/^sk-[A-Za-z0-9_-]{16,1024}$/.test(apiKey) ||
    !data ||
    !control ||
    !isAbsolute(data) ||
    !isAbsolute(control) ||
    process.env.OPENAI_CUSTOM_HEADERS
  )
    throw Error("COMPARISON_RUNTIME_CONFIGURATION_UNAVAILABLE");
  const dataRoot = resolve(data),
    controlDirectory = resolve(control);
  if (dataRoot === controlDirectory || dirname(dataRoot) !== dirname(controlDirectory))
    throw Error("COMPARISON_RUNTIME_CONFIGURATION_UNAVAILABLE");
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) throw Error("COMPARISON_RUNTIME_CONFIGURATION_UNAVAILABLE");
  return {
    apiKey,
    input: readComparisonExecutionInputFile(controlDirectory, parsed.data),
    paths: {
      dataRoot,
      controlDirectory,
      studioFile: join(dataRoot, "studio.sqlite"),
      qualityFile: join(dataRoot, "quality.sqlite"),
    },
    selection: {
      databaseInstanceId: parsed.data,
      environment: "production" as const,
      scopeId: "candidate-quality-provider-v2-live" as const,
    },
  };
}

/** Explicit server composition only, never HTTP options. Construction reads configuration
 * but opens no DB, creates no schema/approval/reservation and sends nothing. One owner per
 * run; retain this object through failed acquisition, pending IO and explicit close retries.
 * HTTP open may retain this passive runtime. Configuration is not paid-call authorization. */
export function createComparisonProviderRuntime() {
  if (arguments.length !== 0) throw Error("COMPARISON_RUNTIME_OPTIONS_FORBIDDEN");
  const config = configuration();
  const network = globalThis.fetch.bind(globalThis);
  let revoked = false,
    closing = false;
  let phase: "unused" | "acquiring" | "ready" | "failed" | "closed" = "unused";
  let company: DatabaseSync | undefined;
  let session: ComparisonStorageSession | undefined;
  let service: Service | undefined;
  function current() {
    if (revoked || phase === "closed") return false;
    try {
      const now = configuration();
      if (JSON.stringify(now) === JSON.stringify(config)) return true;
    } catch {
      /* Invalid/removed settings revoke the original owner as well. */
    }
    revoked = true;
    config.apiKey = "";
    return false;
  }
  function assertCurrent() {
    if (!current() || closing) throw Error("COMPARISON_RUNTIME_REVOKED");
  }
  function acquire() {
    if (closing || phase === "closed") throw Error("COMPARISON_RUNTIME_CLOSED");
    if (service) return service; // Replay/recovery must not require the former credential.
    if (phase !== "unused") throw Error("COMPARISON_RUNTIME_CLEANUP_REQUIRED");
    assertCurrent();
    phase = "acquiring";
    try {
      const { dataRoot, studioFile } = config.paths;
      checkComparisonDatabasePath(dataRoot, studioFile);
      // SQLite WAL read-only connections do not reserve the writer slot for BEGIN
      // IMMEDIATE. The final send guard needs that slot until its synchronous start.
      // This private existing-file connection is used only by SELECT/ROLLBACK guards.
      company = new DatabaseSync(studioFile, { readOnly: false });
      recordComparisonCompanyConnection(company, dataRoot);
      const guard = issueComparisonCompanyGuard(company, dataRoot);
      session = openComparisonStorageSession(config.paths, config.selection);
      service = createPublicComparisonProviderService(session, guard, {
        apiKey: config.apiKey,
        selection: config.selection,
        network,
        assertCurrent,
      });
      phase = "ready";
      return service;
    } catch {
      // Never replace a partially acquired owner, even if the environment is repaired.
      phase = "failed";
      throw Error("COMPARISON_RUNTIME_ACQUISITION_FAILED");
    }
  }
  function original() {
    if (!service || phase === "closed") throw Error("COMPARISON_RUNTIME_OWNER_UNAVAILABLE");
    return service;
  }
  const inspect = () =>
    Object.freeze({
      source: "comparison-provider-runtime" as const,
      status: phase === "closed" ? ("closed" as const) : closing ? ("draining" as const) : phase,
      configuration: current() ? ("pinned" as const) : ("revoked" as const),
      retained: !!company || !!session || !!service,
      service: service?.inspect() ?? null,
      credentialAuthenticated: false as const,
      runtimeObserved: false as const,
      dispatchAllowed: false as const,
    });
  return Object.freeze({
    inspect,
    approvalSettings() {
      assertCurrent();
      if (!config.input) throw Error("COMPARISON_INPUT_UNAVAILABLE");
      return structuredClone(config.input.settings);
    },
    open() {
      acquire();
      return inspect();
    },
    execute: (command: unknown, context: unknown) => acquire().execute(command, context),
    prepareTransmission: (...args: Parameters<Service["prepareTransmission"]>) => {
      assertCurrent();
      return acquire().prepareTransmission(...args);
    },
    recover: (selection: unknown) => original().recover(selection),
    previewPostcapture: (selection: unknown) => acquire().previewPostcapture(selection),
    readStoredReviewByRun: (query: unknown) => acquire().readStoredReviewByRun(query),
    readStoredComparison: (selection: unknown) => acquire().readStoredComparison(selection),
    inspectStoredComparisonContext: (selection: unknown) =>
      acquire().inspectStoredComparisonContext(selection),
    writePostcapture: (...args: Parameters<Service["writePostcapture"]>) =>
      acquire().writePostcapture(...args),
    recoverPostcapture: (...args: Parameters<Service["recoverPostcapture"]>) =>
      original().recoverPostcapture(...args),
    close() {
      if (phase === "closed") return inspect();
      closing = true;
      try {
        // The original service proves all IO/leases/transactions have finished. A failed
        // close retains it for recovery; never roll back someone else's transaction.
        service?.close();
        service = undefined;
        if (session) {
          closeComparisonStorageSession(session);
          session = undefined;
        }
        if (company) {
          if (company.isTransaction) throw Error("COMPANY_CLEANUP_REQUIRED");
          company.close();
          revokeComparisonCompanyGuards(company);
          company = undefined;
        }
        config.apiKey = "";
        phase = "closed";
      } catch {
        /* Keep this exact owner for an explicit recovery/close retry. */
      }
      return inspect();
    },
  });
}
