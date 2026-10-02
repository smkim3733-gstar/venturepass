import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createInterface } from "node:readline";
import { readSafe } from "./local-data-files.mjs";
import { inspectValidationJournal } from "./operational-validation-journal.mjs";

/** Reconcile only an already initialized journal. No key, provider runtime, budget write or send. */
export async function recoverOperationalPolicy(profile) {
  let session;
  try {
    if (
      process.platform !== "win32" ||
      !process.execArgv.includes("--conditions=react-server") ||
      inspectValidationJournal(profile).state !== "initialized"
    )
      throw Error("Recovery unavailable");
    process.env.VENTURE_DATA_DIR = profile.directory;
    const { OperationalValidationSession } =
      await import("../src/lib/studio-operational-validation-session.ts");
    session = new OperationalValidationSession(profile);
    console.log(JSON.stringify(session.recoverPolicy()));
  } catch {
    console.log(
      JSON.stringify({
        state: "blocked",
        reason: "POLICY_RECOVERY_UNCONFIRMED",
        transmissionAllowed: false,
      }),
    );
    process.exitCode = 1;
  } finally {
    if (session && !session.close()) process.exitCode = 1;
  }
}

/** Explicit PC-local command only. Status never imports this module. */
export async function runOperationalValidation(profile, command) {
  return run(profile, command, false);
}
/** Explicit additional campaign only. Reuses the original owner-retaining CLI event loop. */
export async function runAdditionalOperationalValidation(profile, command) {
  return run(profile, command, true);
}
export async function additionalOperationalValidationStatus(profile) {
  let session;
  try {
    if (process.platform !== "win32" || !process.execArgv.includes("--conditions=react-server"))
      throw Error("Unsupported host");
    process.env.VENTURE_DATA_DIR = profile.directory;
    const { AdditionalOperationalValidationSession } =
      await import("../src/lib/studio-operational-validation-additional-session.ts");
    session = new AdditionalOperationalValidationSession(profile);
    // Inspection never acknowledges files, loads keys or installs a runtime.
    return session.inspect();
  } catch {
    process.exitCode = 1;
    return {
      state: "blocked",
      reason: "ADDITIONAL_VALIDATION_UNCONFIRMED",
      transmissionAllowed: false,
    };
  } finally {
    session?.close();
  }
}
async function run(profile, command, additional) {
  const output = (value) => console.log(JSON.stringify(value));
  if (
    process.platform !== "win32" ||
    !process.execArgv.includes("--conditions=react-server") ||
    !["run", "continue-review"].includes(command)
  ) {
    output({ state: "blocked", reason: "OPERATIONAL_LAUNCH_CONFIGURATION_REQUIRED" });
    process.exitCode = 1;
    return;
  }
  let session, input, keepAlive;
  const close = () => {
    try {
      if (session && !session.close()) return false;
      if (keepAlive) clearInterval(keepAlive);
      input?.close();
      return true;
    } catch {
      return false;
    }
  };
  const error = () =>
    output({
      state: "blocked",
      reason: "OPERATIONAL_RUN_UNCONFIRMED",
      automaticRetryAllowed: false,
    });
  let inputEnded = false,
    stopped = false,
    queue = Promise.resolve();
  const stopIfDrained = () => {
    if (stopped) return true;
    // Mark before readline.close(), whose close event can fire synchronously.
    stopped = true;
    if (!close()) {
      stopped = false;
      return false;
    }
    return true;
  };
  try {
    if (additional) {
      process.env.VENTURE_DATA_DIR = profile.directory;
      const { AdditionalOperationalValidationSession } =
        await import("../src/lib/studio-operational-validation-additional-session.ts");
      session = new AdditionalOperationalValidationSession(profile);
      // Recover exact acknowledged DB records before current key/configuration/time is needed.
      session.reconcile();
      const state = session.inspect();
      const attempted = command === "run" ? state.attemptRecorded : state.continuationRecorded;
      if (attempted) {
        output(state); // A restart is read/recovery only; it cannot replay the attempted send.
        stopIfDrained();
        return;
      }
    }
    // Only the key is consumed. Never copy ambient/old customer data directory into this process.
    const envFile = fileURLToPath(new URL("../.env.local", import.meta.url));
    const env = parseEnv(readSafe(envFile, 64 * 1024, null, true).bytes.toString("utf8"));
    if (!env.OPENAI_API_KEY) throw Error("Missing key");
    process.env.OPENAI_API_KEY = env.OPENAI_API_KEY;
    process.env.VENTURE_DATA_DIR = profile.directory;
    if (!additional) {
      const { OperationalValidationSession } =
        await import("../src/lib/studio-operational-validation-session.ts");
      session = new OperationalValidationSession(profile);
    }
    keepAlive = setInterval(() => {}, 1000);
    input = createInterface({ input: process.stdin, terminal: false });
    input.on("line", (line) => {
      queue = queue.then(async () => {
        if (stopped) return;
        try {
          const action = line.trim();
          if (action === "status") output(session.inspect());
          else if (action === "recover") output(session.recover());
          else if (action === "continue-review") output(await session.continueReview());
          else if (action === "close") output({ closed: stopIfDrained() });
          else output({ state: "blocked", reason: "UNSUPPORTED_COMMAND" });
          if (!stopped && (inputEnded || session.inspect().status?.executionCompleted))
            stopIfDrained();
        } catch {
          error();
          if (inputEnded) stopIfDrained();
        }
      });
    });
    input.on("close", () => {
      inputEnded = true;
      if (!stopped && !stopIfDrained())
        output({
          state: "owner-retained",
          reason: "ACTIVE_EXECUTION_OR_CAPTURE",
          automaticRetryAllowed: false,
        });
    });
    const onSignal = () => {
      if (!stopIfDrained())
        output({ state: "owner-retained", reason: "ACTIVE_EXECUTION_OR_CAPTURE" });
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    // Serialize input behind initial preparation/dispatch, including lines already buffered on stdin.
    queue = queue.then(async () => {
      try {
        session.prepare();
        output(command === "run" ? await session.execute() : await session.continueReview());
        output(session.inspect());
      } catch {
        error();
        process.exitCode = 1;
      }
      if (!stopIfDrained())
        output({
          state: "owner-retained",
          commands: ["status", "recover", "continue-review", "close"],
        });
    });
    await queue;
  } catch {
    error();
    process.exitCode = 1;
    stopIfDrained();
  }
}
