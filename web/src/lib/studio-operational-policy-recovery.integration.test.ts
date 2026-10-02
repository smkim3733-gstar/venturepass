import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() => vi.fn(() => { throw Error("Customer access forbidden"); }));
vi.mock("./studio-storage", () => ({ getStudioStore: forbidden, StudioStore: forbidden }));
import { auditAdditionalValidationJournal } from "./studio-operational-validation-cross-audit";
import { OperationalValidationPreparation } from "./studio-operational-validation-preparation";
import { OperationalValidationSession } from "./studio-operational-validation-session";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestPlan, actualTestRegistry } from "./studio-plan-quality-actual-test-helpers";
import { inspectProviderProductionServer } from "./studio-plan-quality-provider-production-server";
import {
  acquireValidationJournal, acquireAdditionalValidationJournal, type ValidationProfile,
} from "../../scripts/operational-validation-journal.mjs";

let root: string, profile: ValidationProfile;
let closers: Array<() => unknown>;
const network = vi.fn<typeof fetch>();
const timeout = 120000;
function open() {
  const journal = acquireValidationJournal(profile);
  const store = new PlanQualityStore(profile.directory);
  const close = () => { store.close(); journal.close(); };
  let closed = false;
  const once = () => { if (!closed) { close(); closed = true; } };
  closers.push(once);
  return { journal, store, preparation: new OperationalValidationPreparation(store, journal), close: once };
}
type Envelope = {
  command: { clientRequestId: string; initialBudgetRequestId: string; approval: { approvedAt: string } };
  review: unknown;
};
function pending(mode: "invalid" | "valid" | "committed" = "invalid") {
  const j = acquireValidationJournal(profile);
  j.initialize((directory) => new PlanQualityStore(directory).close());
  j.close();
  const resources = open();
  const record = resources.journal.prepare.bind(resources.journal);
  if (mode === "invalid") vi.spyOn(resources.journal, "prepare").mockImplementation((stage, payload) => {
    if (stage !== "policy") return record(stage, payload);
    const original = structuredClone(payload) as Envelope;
    original.command.approval.approvedAt = new Date(Date.now() - 63).toISOString();
    return record(stage, original);
  });
  else {
    const adopt = resources.store.providerPolicyAdopt.bind(resources.store);
    vi.spyOn(resources.store, "providerPolicyAdopt").mockImplementation((...args) => {
      if (mode === "committed") adopt(...args);
      throw Error("Deliberate lost result");
    });
  }
  expect(() => resources.preparation.prepare()).toThrow();
  vi.restoreAllMocks();
  const original = resources.journal.readStep("policy").command as Envelope;
  resources.close();
  return original;
}
function savedBytes() {
  return readdirSync(profile.controlDirectory).map((name) => ({ name,
    bytes: readFileSync(join(profile.controlDirectory, name)) }));
}
function unchanged(before: ReturnType<typeof savedBytes>) {
  for (const { name, bytes } of before) {
    expect(readFileSync(join(profile.controlDirectory, name))).toEqual(bytes);
    expect(readFileSync(join(profile.directory, "operational-journal", name))).toEqual(bytes);
  }
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-09-28T19:00:00.000Z");
  root = mkdtempSync(join(tmpdir(), "venture-policy-recovery-"));
  profile = { approvalId: "venturepass-operational-validation-20260928", directory: join(root, "data"),
    controlDirectory: join(root, "control"), currency: "USD", unitScale: 6, capUnits: "15000000" };
  closers = [];
  vi.stubEnv("VENTURE_DATA_DIR", profile.directory);
  vi.stubEnv("OPENAI_API_KEY", "sk-synthetic-policy-recovery-key-only");
  network.mockReset();
  vi.stubGlobal("fetch", network);
  network.mockImplementation(async () => {
    if (network.mock.calls.length > 2) throw Error("Extra dispatch forbidden");
    return Response.json({ id: "synthetic-policy-recovery", model: "gpt-5.4-2026-03-05",
      service_tier: "default", status: "completed",
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30,
        input_tokens_details: { cached_tokens: 5 }, output_tokens_details: { reasoning_tokens: 2 } },
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(
        network.mock.calls.length === 1 ? actualTestPlan(actualTestRegistry()) : { findings: [] }) }] }] });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of closers.reverse()) close();
  expect(forbidden).not.toHaveBeenCalled();
  expect(inspectProviderProductionServer().retainedCaptures).toBe(0);
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (!rel.startsWith("venture-policy-recovery-") || rel.includes("..")) throw Error("Unsafe cleanup");
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

it("preserves the impossible original and recovers a fresh review without a key/send/budget write, then executes once", async () => {
  const original = pending(), before = savedBytes();
  // Expiry is not the proof: this original was impossible even when the review was current.
  vi.setSystemTime(Date.now() + 16 * 60 * 1000);
  const f = open();
  vi.stubEnv("OPENAI_API_KEY", "");
  expect(f.preparation.recoverPolicy()).toEqual({ state: "impossible-policy-rejection-preserved", transmissionAllowed: false });
  expect(f.journal.readStep("policy").command).toBeNull();
  expect(f.store.inspectDatabase()).toMatchObject({ providerPolicies: 0, actualBudgetEvents: 0, actualRuns: 0 });
  expect(network).not.toHaveBeenCalled();
  unchanged(before);
  f.close();
  // Recovery itself does not create a review that could expire while waiting for the next run.
  vi.setSystemTime(Date.now() + 16 * 60 * 1000);
  vi.stubEnv("OPENAI_API_KEY", "sk-synthetic-policy-recovery-key-only");
  const s = new OperationalValidationSession(profile);
  closers.push(() => expect(s.close()).toBe(true));
  s.prepare();
  const replacement = JSON.parse(readFileSync(join(profile.controlDirectory, "06.json"), "utf8")).payload as Envelope;
  expect(replacement.command.clientRequestId).not.toBe(original.command.clientRequestId);
  const completed = await s.execute();
  expect(completed.executionCompleted).toBe(true);
  expect(network).toHaveBeenCalledTimes(2);
  expect(s.inspect().budget).toMatchObject({ capUnits: "15000000", heldUnits: "0", recognizedUnits: "380" });
  unchanged(before);
  expect(s.close()).toBe(true);
  const journal = acquireAdditionalValidationJournal(profile), store = new PlanQualityStore(profile.directory);
  try {
    expect(auditAdditionalValidationJournal(store, journal).originalCommandsAudited).toBe(true);
    for (const field of ["databaseDigest", "registrationDigest", "commandDigest"]) {
      const view = journal.readAuditView();
      (view.rejection!.evidence as Record<string, unknown>)[field] = "a".repeat(64);
      expect(() => auditAdditionalValidationJournal(store, { readAuditView: () => view })).toThrow();
    }
  } finally { store.close(); journal.close(); }
}, timeout);

it("resumes lost rejection and replacement acknowledgements without replacing any already preserved nonce", () => {
  pending();
  let f = open();
  const reject = f.journal.rejectPendingPolicy.bind(f.journal);
  vi.spyOn(f.journal, "rejectPendingPolicy").mockImplementation((proof) => { reject(proof); throw Error("Lost rejection result"); });
  expect(() => f.preparation.recoverPolicy()).toThrow("Lost rejection result");
  vi.restoreAllMocks();
  const firstBytes = savedBytes();
  expect(f.journal.readStep("policy").command).toBeNull();
  f.close(); f = open();
  const record = f.journal.prepare.bind(f.journal);
  vi.spyOn(f.journal, "prepare").mockImplementation((stage, value) => { record(stage, value); throw Error("Lost replacement result"); });
  expect(() => f.preparation.prepare()).toThrow("Lost replacement result");
  vi.restoreAllMocks();
  const saved = f.journal.readStep("policy").command;
  f.close(); f = open();
  expect(f.preparation.recoverPolicy().transmissionAllowed).toBe(false);
  expect(f.journal.readStep("policy").command).toEqual(saved);
  unchanged(firstBytes);
  expect(f.store.providerBudgetGet("production").revision).toBe(0);
  expect(network).not.toHaveBeenCalled();
  f.preparation.prepare();
  expect(f.journal.readStep("policy").command).toEqual(saved);
  expect(f.store.providerPolicyHead().revision).toBe(1);
}, timeout);

it.each([false, true])("does not replace an unobserved but possibly valid policy (expired=%s)", (expired) => {
  pending("valid");
  if (expired) vi.setSystemTime(Date.now() + 16 * 60 * 1000);
  const before = savedBytes(), f = open();
  expect(() => f.preparation.recoverPolicy()).toThrow();
  expect(f.journal.readPolicyRejection()).toBeNull();
  expect(savedBytes()).toEqual(before);
  expect(network).not.toHaveBeenCalled();
}, timeout);

it("keeps a committed original whose reply was lost and reconciles it through normal lookup", () => {
  const original = pending("committed"), before = savedBytes(), f = open();
  expect(() => f.preparation.recoverPolicy()).toThrow();
  expect(savedBytes()).toEqual(before);
  expect(f.store.providerPolicyLookup(original.command.clientRequestId).state).toBe("committed");
  const write = vi.spyOn(f.store, "providerPolicyAdopt");
  f.preparation.prepare();
  expect(write).not.toHaveBeenCalled();
  expect(f.store.providerPolicyHead().revision).toBe(1);
  expect(network).not.toHaveBeenCalled();
}, timeout);

it("blocks recovery when another policy and budget already exist", () => {
  const original = pending(), before = savedBytes(), f = open();
  const command = structuredClone(original.command);
  command.clientRequestId = randomUUID(); command.initialBudgetRequestId = randomUUID();
  command.approval.approvedAt = new Date().toISOString();
  f.store.providerPolicyAdopt(command, original.review);
  expect(() => f.preparation.recoverPolicy()).toThrow();
  expect(f.store.providerBudgetGet("production").revision).toBe(1);
  expect(savedBytes()).toEqual(before);
  expect(network).not.toHaveBeenCalled();
}, timeout);

it("revalidates journal proof before core writes and rejects fabricated evidence", () => {
  pending();
  const f = open();
  f.journal.rejectPendingPolicy({ invented: true });
  const before = savedBytes();
  expect(() => f.preparation.recoverPolicy()).toThrow();
  expect(() => f.preparation.prepare()).toThrow();
  expect(savedBytes()).toEqual(before);
  expect(f.store.inspectDatabase()).toMatchObject({ providerPolicies: 0, actualBudgetEvents: 0 });
  expect(network).not.toHaveBeenCalled();
}, timeout);

it("rejects reuse of an original nonce even after a valid rejection proof", () => {
  const original = pending(), f = open();
  f.preparation.recoverPolicy();
  const record = f.journal.prepare.bind(f.journal);
  vi.spyOn(f.journal, "prepare").mockImplementation((stage, value) => {
    const replacement = structuredClone(value) as Envelope;
    replacement.command.clientRequestId = original.command.clientRequestId;
    return record(stage, replacement);
  });
  expect(() => f.preparation.prepare()).toThrow();
  vi.restoreAllMocks();
  expect(() => f.preparation.prepare()).toThrow();
  expect(f.store.providerPolicyHead().revision).toBe(0);
  expect(network).not.toHaveBeenCalled();
}, timeout);

it("reconciles the replacement policy COMMIT after a lost reply without another budget initialization", () => {
  pending();
  const f = open();
  f.preparation.recoverPolicy();
  const adopt = f.store.providerPolicyAdopt.bind(f.store);
  vi.spyOn(f.store, "providerPolicyAdopt").mockImplementation((...args) => {
    adopt(...args); throw Error("Lost replacement COMMIT result");
  });
  expect(() => f.preparation.prepare()).toThrow("Lost replacement COMMIT result");
  vi.restoreAllMocks();
  const command = f.journal.readStep("policy").command;
  expect(f.store.providerPolicyHead().revision).toBe(1);
  expect(f.store.providerBudgetGet("production").revision).toBe(1);
  expect(() => f.preparation.recoverPolicy()).toThrow();
  const write = vi.spyOn(f.store, "providerPolicyAdopt");
  f.preparation.prepare();
  expect(write).not.toHaveBeenCalled();
  expect(f.journal.readStep("policy").command).toEqual(command);
  expect(f.store.providerPolicyHead().revision).toBe(1);
  expect(f.store.providerBudgetGet("production").capUnits).toBe("15000000");
  expect(network).not.toHaveBeenCalled();
}, timeout);

it("runs the native keyless recovery command with the operational loader and no production owner", () => {
  pending();
  const before = savedBytes();
  const child = spawnSync(process.execPath, ["--conditions=react-server", "--import",
    pathToFileURL(resolve("scripts/operational-typescript-loader.mjs")).href, "--input-type=module", "-e", `
      process.env.OPENAI_API_KEY = "";
      globalThis.fetch = () => { throw Error("Network forbidden"); };
      const { recoverOperationalPolicy } = await import("./scripts/operational-validation-run.mjs");
      await recoverOperationalPolicy(${JSON.stringify(profile)});
      const { inspectProviderProductionServer } = await import("./src/lib/studio-plan-quality-provider-production-server.ts");
      console.log(JSON.stringify({keyLoaded: Boolean(process.env.OPENAI_API_KEY), owner: inspectProviderProductionServer().status}));
    `], { cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 60000 });
  expect(child.status, child.stderr).toBe(0);
  const output = child.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  expect(output).toEqual([
    { state: "impossible-policy-rejection-preserved", transmissionAllowed: false },
    { keyLoaded: false, owner: "not-installed" },
  ]);
  unchanged(before);
  const f = open();
  expect(f.journal.readStep("policy").command).toBeNull();
  expect(f.store.inspectDatabase()).toMatchObject({ providerPolicies: 0, actualBudgetEvents: 0, actualRuns: 0 });
}, timeout);
