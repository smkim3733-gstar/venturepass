import "server-only";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { createComparisonReservationCatalog } from "./studio-comparison-input-preparation";
import { readComparisonExecutionInputFile } from "./studio-comparison-execution-input-file";
import { decodeReservationView, type ReservationView } from "./studio-comparison-reservations-wire";

function configuration() {
  const data = process.env.VENTURE_DATA_DIR,
    control = process.env.VENTUREPASS_COMPARISON_EXECUTION_CONTROL_DIR,
    id = process.env.VENTUREPASS_COMPARISON_EXECUTION_DATABASE_ID;
  if (!control && !id) throw Error("NOT_CONFIGURED");
  if (!data || !control || !isAbsolute(data) || !isAbsolute(control))
    throw Error("CONFIGURATION_INVALID");
  return {
    dataRoot: resolve(data),
    controlDirectory: resolve(control),
    databaseInstanceId: z.string().uuid().parse(id),
  };
}
function inputSnapshot(config: ReturnType<typeof configuration>) {
  try {
    const input = readComparisonExecutionInputFile(
      config.controlDirectory,
      config.databaseInstanceId,
    );
    return {
      value: input,
      unavailable: false,
      fingerprint: JSON.stringify(
        input && {
          file: input.file,
          sha256: input.sha256,
        },
      ),
    };
  } catch {
    return {
      value: null,
      unavailable: true,
      fingerprint: "invalid:" + process.env.VENTUREPASS_COMPARISON_EXECUTION_INPUT_FILE,
    };
  }
}

/** No key/SDK acquisition. Existing execution paths are explicit; files/env are never written. */
export function openConfiguredReservations(companyId: string, companyRevision: number) {
  const config = configuration(),
    key = JSON.stringify(config);
  const owner = createComparisonReservationCatalog({ ...config, companyId, companyRevision });
  return Object.freeze({
    close: owner.close,
    list() {
      const input = inputSnapshot(config),
        catalog = owner.list();
      if (
        JSON.stringify(configuration()) !== key ||
        inputSnapshot(config).fingerprint !== input.fingerprint
      )
        throw Error("CONFIGURATION_CHANGED");
      const settings = input.value?.settings;
      let status: ReservationView["input"]["status"] = input.unavailable
        ? "unavailable"
        : "not-configured";
      let runId: string | null = null;
      if (settings) {
        if (settings.companyId !== companyId) status = "other-company";
        else if (settings.companyRevision !== companyRevision) status = "different-revision";
        else {
          runId = settings.runId;
          const row = catalog.reservations.find((r) => r.runId === runId);
          status = !row
            ? "missing-reservation"
            : row.companyRevisionMatches
              ? "matched"
              : "different-revision";
          if (status === "different-revision") runId = null;
        }
      }
      return decodeReservationView(
        {
          kind: "comparison-reservation-view",
          companyId,
          companyRevision,
          inspectedAt: catalog.inspectedAt,
          input: { status, runId },
          reservations: catalog.reservations.map(({ costs, ...row }) => ({
            ...row,
            currency: costs.currency,
            unitScale: costs.unitScale,
            reservedUnits: costs.reservedUnits,
          })),
          currentContextVerified: false,
          policiesVerified: false,
          transmissionAllowed: false,
          consentRecorded: false,
          runtimeObserved: false,
        },
        { id: companyId, revision: companyRevision },
      );
    },
  });
}
