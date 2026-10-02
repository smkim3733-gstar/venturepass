import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("Customer access forbidden");
  }),
);
vi.mock("./studio-storage", () => ({ getStudioStore: forbidden, StudioStore: forbidden }));
import { OperationalValidationSession } from "./studio-operational-validation-session";
import { AdditionalOperationalValidationSession } from "./studio-operational-validation-additional-session";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { ProviderGenerationDispatchStore } from "./studio-plan-quality-provider-dispatch-store";
import * as configuration from "./studio-plan-quality-provider-configuration";
import * as runtime from "./studio-plan-quality-provider-production-runtime";
import { actualTestPlan, actualTestRegistry } from "./studio-plan-quality-actual-test-helpers";
import * as journals from "../../scripts/operational-validation-journal.mjs";
import {
  acquireAdditionalValidationJournal,
  type ValidationProfile,
} from "../../scripts/operational-validation-journal.mjs";

let root: string, profile: ValidationProfile, originalDb: Buffer;
let originalFiles: Map<string, Buffer>;
let sessions: AdditionalOperationalValidationSession[] = [];
const network = vi.fn<typeof fetch>(),
  key = "sk-synthetic-additional-session-only";
const timeout = 120000;
const database = () => join(profile.directory, "quality-evaluation", "quality.sqlite");
const dirs = () => [join(profile.directory, "operational-journal"), profile.controlDirectory];
function files() {
  return new Map(
    dirs().flatMap((dir) =>
      readdirSync(dir).map((name) => {
        const path = join(dir, name);
        return [path, readFileSync(path)] as const;
      }),
    ),
  );
}
function response(value: unknown) {
  return Response.json({
    id: "synthetic-additional-session",
    model: "gpt-5.4-2026-03-05",
    service_tier: "default",
    status: "completed",
    usage: {
      input_tokens: 20,
      output_tokens: 10,
      total_tokens: 30,
      input_tokens_details: { cached_tokens: 5 },
      output_tokens_details: { reasoning_tokens: 2 },
    },
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }],
  });
}
function setupNetwork() {
  network.mockReset();
  network.mockImplementation(async () => {
    if (network.mock.calls.length > 2) throw Error("Extra dispatch forbidden");
    return response(
      network.mock.calls.length === 1 ? actualTestPlan(actualTestRegistry()) : { findings: [] },
    );
  });
  vi.stubGlobal("fetch", network);
}
function session() {
  const value = new AdditionalOperationalValidationSession(profile);
  sessions.push(value);
  return value;
}
function journalView() {
  const journal = acquireAdditionalValidationJournal(profile);
  try {
    return journal.readAuditView();
  } finally {
    journal.close();
  }
}
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-09-28T18:01:37.000Z");
  root = mkdtempSync(join(tmpdir(), "venture-additional-session-"));
  profile = {
    approvalId: "venturepass-operational-validation-20260928",
    directory: join(root, "data"),
    controlDirectory: join(root, "control"),
    currency: "USD",
    unitScale: 6,
    capUnits: "15000000",
  };
  vi.stubEnv("VENTURE_DATA_DIR", profile.directory);
  vi.stubEnv("OPENAI_API_KEY", key);
  setupNetwork();
  const old = new OperationalValidationSession(profile);
  try {
    old.prepare();
    expect((await old.execute()).executionCompleted).toBe(true);
  } finally {
    expect(old.close()).toBe(true);
  }
  originalDb = readFileSync(database());
  originalFiles = files();
}, timeout);
beforeEach(() => {
  // Test-only in-place restoration preserves the original inode and all binding bytes.
  // No operational path is used, and every owner/SQLite connection was closed first.
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (!rel.startsWith("venture-additional-session-") || rel.includes(".."))
    throw Error("Unsafe fixture");
  writeFileSync(database(), originalDb);
  for (const [path] of files()) if (!originalFiles.has(path)) rmSync(path);
  for (const [path, bytes] of originalFiles) writeFileSync(path, bytes);
  vi.setSystemTime("2026-09-28T18:01:37.000Z");
  vi.stubEnv("VENTURE_DATA_DIR", profile.directory);
  vi.stubEnv("OPENAI_API_KEY", key);
  setupNetwork();
  sessions = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const item of sessions) {
    if (!item.close()) {
      item.recover();
      expect(item.close()).toBe(true);
    }
  }
  expect(forbidden).not.toHaveBeenCalled();
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (!rel.startsWith("venture-additional-session-") || rel.includes(".."))
    throw Error("Unsafe cleanup");
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
it(
  "uses one fixed runtime for additional preparation and two SDK calls; preserves original bytes and cumulative budget",
  async () => {
    const factory = vi.spyOn(runtime, "createVersionedProviderProductionRuntime");
    const register = vi.spyOn(PlanQualityStore.prototype, "candidateRegistryRegister");
    const first = session(),
      returned = first.prepare(),
      selection = { ...returned };
    returned.approvalBindingDigest = "a".repeat(64); // Caller mutation cannot change the owner identity.
    expect(network).not.toHaveBeenCalled();
    expect(first.inspect()).toMatchObject({
      preparationComplete: true,
      transmissionAllowed: false,
      status: { lastAuditedRevision: 1 },
      budget: { capUnits: "15000000", recognizedUnits: "380" },
    });
    expect((await first.execute()).executionCompleted).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith("plan-observation-v2");
    expect(register).not.toHaveBeenCalled();
    expect(network).toHaveBeenCalledTimes(2);
    expect(first.inspect()).toMatchObject({
      status: { lastAuditedRevision: 10 },
      budget: { capUnits: "15000000", recognizedUnits: "760", heldUnits: "0" },
    });
    expect(JSON.stringify(first.inspect())).not.toContain(key);
    expect(first.close()).toBe(true);
    for (const [path, bytes] of originalFiles) expect(readFileSync(path)).toEqual(bytes);
    const view = journalView();
    expect(view.additional?.approval?.scope.engineVersion).toBe("plan-observation-v2");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.setSystemTime("2035-01-01T00:00:00Z");
    const configurationRead = vi
      .spyOn(configuration, "getProviderConfigurationProposal")
      .mockImplementation(forbidden);
    const restored = session();
    expect(restored.prepare()).toEqual(selection);
    expect(restored.inspect().status?.executionCompleted).toBe(true);
    await expect(restored.execute()).rejects.toThrow();
    expect(configurationRead).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(network).toHaveBeenCalledTimes(2);
    expect(restored.close()).toBe(true);
    const cold = spawnSync(
      process.execPath,
      [
        "--conditions=react-server",
        "--import",
        "./scripts/operational-typescript-loader.mjs",
        "--input-type=module",
        "-e",
        `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const open = fs.openSync;
      fs.openSync = function(path, ...args) {
        if (String(path).endsWith(".env.local")) throw Error("Key read forbidden");
        return open.call(this, path, ...args);
      };
      syncBuiltinESMExports();
      globalThis.fetch = () => { throw Error("Network forbidden"); };
      const cli = await import("./scripts/operational-validation-run.mjs");
      const profile = JSON.parse(process.env.ADDITIONAL_TEST_PROFILE);
      console.log(JSON.stringify(await cli.additionalOperationalValidationStatus(profile)));
      await cli.runAdditionalOperationalValidation(profile, "run");
    `,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        windowsHide: true,
        timeout: 30000,
        env: {
          ...process.env,
          OPENAI_API_KEY: "",
          ADDITIONAL_TEST_PROFILE: JSON.stringify(profile),
        },
      },
    );
    expect(cold.status, cold.stderr).toBe(0);
    const views = cold.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(views).toHaveLength(2);
    for (const view of views)
      expect(view).toMatchObject({
        status: { executionCompleted: true },
        budget: { recognizedUnits: "760", capUnits: "15000000" },
        transmissionAllowed: false,
      });
  },
  timeout,
);
it.each(["providerPolicyAdopt", "providerReserve", "providerApproveTransmission"] as const)(
  "recovers %s COMMIT with no acknowledgement before configuration/clock and keeps its exact nonce",
  (method) => {
    const first = session(),
      original: (this: PlanQualityStore, command: unknown, review: unknown) => unknown =
        PlanQualityStore.prototype[method];
    const fault = vi.spyOn(PlanQualityStore.prototype, method).mockImplementation(function (
      this: PlanQualityStore,
      ...args
    ) {
      original.apply(this, args);
      throw Error("Lost DB COMMIT reply");
    });
    expect(() => first.prepare()).toThrow("Lost DB COMMIT reply");
    expect(first.close()).toBe(true);
    const before = journalView(),
      pending = before.additional!.pendingStage!;
    expect(before.additional!.steps[pending].receipt).toBeNull();
    fault.mockRestore();
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.setSystemTime("2035-01-01T00:00:00Z");
    const config = vi
      .spyOn(configuration, "getProviderConfigurationProposal")
      .mockImplementation(forbidden);
    const writes = vi.spyOn(PlanQualityStore.prototype, method);
    const next = session();
    next.reconcile();
    expect(next.close()).toBe(true);
    const after = journalView();
    expect(after.additional!.steps[pending].command).toEqual(
      before.additional!.steps[pending].command,
    );
    expect(after.additional!.steps[pending].receipt).not.toBeNull();
    expect(writes).not.toHaveBeenCalled();
    expect(config).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  },
  timeout,
);
it(
  "blocks a physically rolled-back DB after file acknowledgement without recreating policy/run",
  () => {
    const first = session();
    first.prepare();
    expect(first.close()).toBe(true);
    const acknowledged = files();
    writeFileSync(database(), originalDb); // actual temporary-file loss; same inode and old valid DB prefix.
    const writes = vi.spyOn(PlanQualityStore.prototype, "providerPolicyAdopt");
    expect(() => session()).toThrow("VALIDATION_HISTORY_MISMATCH");
    expect(readFileSync(database())).toEqual(originalDb);
    expect(files()).toEqual(acknowledged);
    expect(writes).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  },
  timeout,
);
it(
  "keeps an attempted execute command after a pre-COMMIT failure; restart never resends",
  async () => {
    const first = session();
    const selection = first.prepare();
    const fault = vi
      .spyOn(PlanQualityStore.prototype, "providerRunApprovedProduction")
      .mockImplementation(() => {
        throw Error("Before dispatch COMMIT");
      });
    await first.execute();
    expect(first.inspect().attemptRecorded).toBe(true);
    expect(first.close()).toBe(true);
    fault.mockRestore();
    const next = session();
    expect(next.prepare()).toEqual(selection);
    await expect(next.execute()).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  },
  timeout,
);
it.each(["generation", "review"] as const)(
  "retains the %s capture and file lease across response storage failure; recovers once without redispatch",
  async (phase) => {
    const first = session();
    first.prepare();
    const fault = vi
      .spyOn(
        ProviderGenerationDispatchStore.prototype,
        phase === "generation" ? "recordResponse" : "recordReviewResponse",
      )
      .mockImplementation(() => {
        throw Error("Capture storage unavailable");
      });
    const result = await first.execute();
    expect(result.status).toBe("capture-recovery-required");
    expect(first.close()).toBe(false);
    expect(() => session()).toThrow();
    expect(network).toHaveBeenCalledTimes(phase === "generation" ? 1 : 2);
    fault.mockRestore();
    if (phase === "review") {
      vi.stubEnv("OPENAI_API_KEY", "");
      vi.setSystemTime("2035-01-01T00:00:00Z");
      vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(forbidden);
    }
    first.recover();
    expect(first.inspect().lifetime?.retainedCaptures).toBe(0);
    if (phase === "generation")
      expect((await first.continueReview()).executionCompleted).toBe(true);
    expect(first.inspect().status?.executionCompleted).toBe(true);
    expect(network).toHaveBeenCalledTimes(2);
    expect(first.close()).toBe(true);
    const original = journalView();
    expect(original.additional!.steps.execute.receipt).not.toBeNull();
    if (phase === "generation")
      expect(original.additional!.steps["continue-review"].receipt).not.toBeNull();
  },
  timeout,
);
it(
  "does not resend unobserved transmission after close/restart and preserves its held cost",
  async () => {
    network.mockImplementation(async () => {
      throw Error("No observed response");
    });
    const first = session();
    const selection = first.prepare();
    await first.execute();
    const stopped = first.inspect();
    expect(network).toHaveBeenCalledTimes(1);
    expect(stopped.status?.generation?.lastConfirmed).toBe("stopped");
    expect(BigInt(stopped.budget.heldUnits)).toBeGreaterThan(BigInt(0));
    expect(first.close()).toBe(true);
    const next = session();
    expect(next.prepare()).toEqual(selection);
    await expect(next.execute()).rejects.toThrow();
    await expect(next.continueReview()).rejects.toThrow();
    expect(next.inspect().budget).toEqual(stopped.budget);
    expect(network).toHaveBeenCalledTimes(1);
  },
  timeout,
);
it(
  "retains the original owner while fetch is pending; duplicate requests and another lease cannot dispatch",
  async () => {
    let release!: (response: Response) => void, observed!: () => void;
    const started = new Promise<void>((resolve) => {
      observed = resolve;
    });
    network.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
          observed();
        }),
    );
    const first = session();
    first.prepare();
    const running = first.execute();
    await started;
    expect(first.close()).toBe(false);
    await expect(first.execute()).rejects.toThrow();
    expect(() => session()).toThrow();
    release(response(actualTestPlan(actualTestRegistry())));
    expect((await running).executionCompleted).toBe(true);
    expect(network).toHaveBeenCalledTimes(2);
  },
  timeout,
);

it.each(["before", "after"] as const)(
  "recovers execution acknowledgement loss %s the paired file COMMIT without creating an owner",
  async (boundary) => {
    const acquire = journals.acquireAdditionalValidationJournal;
    vi.spyOn(journals, "acquireAdditionalValidationJournal").mockImplementation((profile) => {
      const journal = acquire(profile);
      return {
        ...journal,
        acknowledgeAdditional(stage, receipt) {
          if (stage === "execute") {
            if (boundary === "after") journal.acknowledgeAdditional(stage, receipt);
            throw Error("File acknowledgement reply lost");
          }
          journal.acknowledgeAdditional(stage, receipt);
        },
      };
    });
    const first = session(),
      selection = first.prepare();
    await expect(first.execute()).rejects.toThrow("File acknowledgement reply lost");
    expect(first.close()).toBe(true);
    vi.restoreAllMocks();
    expect(network).toHaveBeenCalledTimes(2);
    const saved = journalView();
    expect(saved.additional!.steps.execute.receipt === null).toBe(boundary === "before");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.setSystemTime("2035-01-01T00:00:00Z");
    const config = vi
      .spyOn(configuration, "getProviderConfigurationProposal")
      .mockImplementation(forbidden);
    const next = session();
    expect(next.prepare()).toEqual(selection);
    expect(next.inspect().status?.executionCompleted).toBe(true);
    await expect(next.execute()).rejects.toThrow();
    expect(next.close()).toBe(true);
    expect(journalView().additional!.steps.execute.receipt).not.toBeNull();
    expect(config).not.toHaveBeenCalled();
    expect(network).toHaveBeenCalledTimes(2);
  },
  timeout,
);
it(
  "pins the profile path and rejects caller test/version options before opening storage",
  () => {
    const first = session();
    const incompatible = { ...profile, directory: join(root, "absent") };
    expect(() => new AdditionalOperationalValidationSession(incompatible)).toThrow();
    const supplied = AdditionalOperationalValidationSession as unknown as new (
      ...args: unknown[]
    ) => unknown;
    expect(
      () => new supplied(profile, { version: "plan-observation-v1", tokenEvidence: {} }),
    ).toThrow();
    expect(first.close()).toBe(true);
    expect(network).not.toHaveBeenCalled();
  },
  timeout,
);

it(
  "preserves an uncommitted policy command through expiry without replacing its nonce or resetting budget",
  () => {
    const first = session();
    const fault = vi
      .spyOn(PlanQualityStore.prototype, "providerPolicyAdopt")
      .mockImplementation(() => {
        throw Error("Before policy COMMIT");
      });
    expect(() => first.prepare()).toThrow("Before policy COMMIT");
    expect(first.close()).toBe(true);
    const saved = journalView();
    fault.mockRestore();
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.setSystemTime("2035-01-01T00:00:00Z");
    const next = session();
    expect(next.reconcile()).toMatchObject({
      preparationComplete: false,
      budget: { recognizedUnits: "380", heldUnits: "0", capUnits: "15000000" },
    });
    expect(() => next.prepare()).toThrow();
    expect(next.close()).toBe(true);
    expect(journalView()).toEqual(saved);
    expect(network).not.toHaveBeenCalled();
  },
  timeout,
);
