import path from "node:path";
import { pathToFileURL } from "node:url";
import { inspectValidationJournal } from "./operational-validation-journal.mjs";

// PC-specific approval identity. Never derive a new budget path from date, cwd, or environment.
export function operationalValidationProfile() {
  return {
    approvalId: "venturepass-operational-validation-20260928",
    directory: "C:/Users/usr/AppData/Local/VenturePass/operational-validation-20260928",
    controlDirectory:
      "C:/Users/usr/AppData/Local/VenturePass/operational-validation-20260928-control",
    currency: "USD",
    unitScale: 6,
    capUnits: "15000000",
  };
}
export function operationalValidationStatus(args = []) {
  if (args.length > 1 || (args.length === 1 && args[0] !== "status"))
    return { state: "blocked", reason: "UNSUPPORTED_COMMAND", transmissionAllowed: false };
  if (process.platform !== "win32")
    return { state: "blocked", reason: "UNSUPPORTED_HOST", transmissionAllowed: false };
  return inspectValidationJournal(operationalValidationProfile());
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "recover-policy") {
    const { recoverOperationalPolicy } = await import("./operational-validation-run.mjs");
    await recoverOperationalPolicy(operationalValidationProfile());
  } else if (args.length === 1 && ["run", "continue-review"].includes(args[0])) {
    const { runOperationalValidation } = await import("./operational-validation-run.mjs");
    await runOperationalValidation(operationalValidationProfile(), args[0]);
  } else {
    // Status deliberately has no key loader, store constructor or production-server import.
    const result = operationalValidationStatus(args);
    console.log(JSON.stringify(result));
    if (result.state === "blocked") process.exitCode = 1;
  }
}
