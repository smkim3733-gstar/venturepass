import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actualTestNow, actualTestRegistry } from "./studio-plan-quality-actual-test-helpers";
import {
  providerTestExpires,
  providerTestFinancialInput,
} from "./studio-plan-quality-provider-test-helpers";
import { createVersionedProviderPreparationBuilder } from "./studio-plan-quality-provider-core";
import type { PlanPromptVersion } from "./studio-plan-prompt-versions";
import type {
  StoredProviderRun,
  VersionedProviderStart,
  VersionedProviderPreparation,
} from "./studio-plan-quality-provider-types";
import * as core from "../../scripts/local-data-quality-provider.mjs";
import * as frozen from "../../scripts/local-data-quality-provider-reservation-ledger.mjs";

type Archive = Parameters<typeof core.inspectVersionedProviderLedger>[0];
const omit = (value: object, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
const forbidden = vi.fn(() => {
  throw Error("No provider IO");
});
beforeEach(() => {
  forbidden.mockClear();
  vi.stubGlobal("fetch", forbidden);
});
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function costs(p: VersionedProviderPreparation) {
  if (!p.financialBasis.costs) throw Error("Expected valid synthetic costs");
  return p.financialBasis.costs;
}
function fixture() {
  const registry = actualTestRegistry(),
    scopeId = core.providerBudgetScope("synthetic-test"),
    nonce = randomUUID();
  const policy = {
    environment: "synthetic-test",
    provenance: "synthetic-test",
    currency: "TST",
    unitScale: 6,
    capUnits: "100",
  } as const;
  const configured = core.createProviderBudgetEvent({
    schemaVersion: 2,
    scopeId,
    environment: policy.environment,
    provenance: policy.provenance,
    revision: 1,
    previousDigest: null,
    eventId: nonce,
    recordedAt: actualTestNow,
    currency: policy.currency,
    unitScale: policy.unitScale,
    payload: { kind: "configure", capUnits: policy.capUnits },
  });
  const archive: Archive = {
    runs: [],
    events: [],
    artifacts: [],
    budgetEvents: [configured],
    registries: [registry],
    receipts: [
      core.createProviderReceipt({
        schemaVersion: 2,
        scopeId,
        kind: "provider-budget-configure",
        clientRequestId: nonce,
        inputDigest: core.providerDigest(
          core.providerPolicyDigestInput({ clientRequestId: nonce, expectedRevision: 0, policy }),
        ),
        runId: null,
        runRevision: null,
        budgetRevision: 1,
        operationDigest: configured.eventDigest,
        recordedAt: actualTestNow,
      }),
    ],
  };
  function add(
    version: PlanPromptVersion = "plan-observation-v2",
    legacy = false,
    candidate = archive.runs.length,
  ) {
    const prior = core.validateProviderBudgetLedger(archive.budgetEvents, scopeId);
    const preparation = createVersionedProviderPreparationBuilder(version).createPreparation({
      registry,
      candidateId: registry.entries[candidate].candidateId,
      environment: "synthetic-test",
      preparedAt: actualTestNow,
      expiresAt: providerTestExpires,
      financialInput: providerTestFinancialInput(),
      budget: {
        scopeId,
        revision: prior.revision,
        headDigest: prior.headDigest!,
        currency: "TST",
        unitScale: 6,
        capUnits: prior.capUnits,
        heldUnits: prior.heldUnits,
        recognizedUnits: prior.recognizedUnits,
      },
      retention: {
        policyVersion: "synthetic-v2",
        notice: "Synthetic only; no provider call",
        sourceUrl: "https://example.invalid/retention",
        documentDigest: "b".repeat(64),
        reviewedAt: actualTestNow,
        validUntil: providerTestExpires,
      },
    });
    const start: VersionedProviderStart = {
      startVersion: 2,
      clientRequestId: randomUUID(),
      expectedBudgetRevision: prior.revision,
      expectedBudgetDigest: prior.headDigest!,
      expectedScopeRunCount: archive.runs.length,
      expectedGlobalRunCount: archive.runs.length,
      preparation,
      approval: {
        provenance: "synthetic-test",
        approvedPreparationDigest: preparation.preparationDigest,
        approvedAt: actualTestNow,
        expiresAt: providerTestExpires,
        acknowledgedReservationOnly: true,
        acknowledgedFinancialBasisNotTokenFit: true,
        acknowledgedRetention: true,
        acknowledgedNoAutomaticRetry: true,
      },
    };
    const id = randomUUID(),
      reservation = core.createProviderBudgetEvent({
        schemaVersion: 2,
        scopeId,
        environment: "synthetic-test",
        provenance: "synthetic-test",
        revision: prior.revision + 1,
        previousDigest: prior.headDigest,
        eventId: start.clientRequestId,
        recordedAt: actualTestNow,
        currency: "TST",
        unitScale: 6,
        payload: {
          kind: "reserve-run",
          runId: id,
          preparationDigest: preparation.preparationDigest,
          generationUnits: costs(preparation).generation.totalUnits,
          reviewUnits: costs(preparation).review.totalUnits,
        },
      });
    const oldStart = () => core.providerStartSchema.parse(omit(start, "startVersion"));
    const run: StoredProviderRun = legacy
      ? core.createProviderRun({ input: oldStart(), id, recordedAt: actualTestNow, reservation })
      : core.createVersionedProviderRun({
          input: start,
          id,
          recordedAt: actualTestNow,
          reservation,
        });
    archive.runs.push(run);
    archive.budgetEvents.push(reservation);
    archive.artifacts.push(
      core.createProviderArtifact({ runId: id, body: JSON.stringify(preparation.generation.body) }),
    );
    archive.receipts.push(
      core.createProviderReceipt({
        schemaVersion: 2,
        scopeId,
        kind: "provider-start",
        clientRequestId: start.clientRequestId,
        inputDigest: run.inputDigest,
        runId: id,
        runRevision: 0,
        budgetRevision: reservation.revision,
        operationDigest: run.runDigest,
        recordedAt: actualTestNow,
      }),
    );
    return { run, start, reservation, oldStart };
  }
  function cancel(run: StoredProviderRun) {
    const last = archive.budgetEvents.at(-1)!,
      nonce = randomUUID();
    const release = core.createProviderBudgetEvent({
      schemaVersion: 2,
      scopeId,
      environment: "synthetic-test",
      provenance: "synthetic-test",
      revision: last.revision + 1,
      previousDigest: last.eventDigest,
      eventId: nonce,
      recordedAt: actualTestNow,
      currency: "TST",
      unitScale: 6,
      payload: {
        kind: "release-run",
        runId: run.id,
        reservationDigest: run.reservationDigest,
        generationUnits: costs(run.preparation).generation.totalUnits,
        reviewUnits: costs(run.preparation).review.totalUnits,
        reason: "cancelled-before-dispatch",
      },
    });
    const event = core.createProviderRunEvent({
      schemaVersion: 2,
      runId: run.id,
      revision: 1,
      budgetRevision: release.revision,
      previousEventDigest: null,
      recordedAt: actualTestNow,
      payload: {
        kind: "cancelled-before-dispatch",
        reason: "test-cleanup",
        releaseBudgetEventDigest: release.eventDigest,
      },
    });
    archive.budgetEvents.push(release);
    archive.events.push(event);
    archive.receipts.push(
      core.createProviderReceipt({
        schemaVersion: 2,
        scopeId,
        kind: "provider-cancel",
        clientRequestId: nonce,
        inputDigest: core.providerDigest(
          core.providerCancelDigestInput(run.id, {
            clientRequestId: nonce,
            expectedRevision: 0,
            reason: "test-cleanup",
          }),
        ),
        runId: run.id,
        runRevision: 1,
        budgetRevision: release.revision,
        operationDigest: event.eventDigest,
        recordedAt: actualTestNow,
      }),
    );
  }
  return { archive, add, cancel };
}
function bindAlteredPreparation(f: ReturnType<typeof fixture>, p: VersionedProviderPreparation) {
  // Rehash every surrounding link so rejection must come from semantic validation, not stale hashes.
  p.generation.requestDigest = core.providerWireDigest(p.generation.body);
  p.generation.sha256 = core.providerRawDigest(JSON.stringify(p.generation.body));
  p.generation.inputChars = p.generation.body.input.reduce((n, x) => n + x.content.length, 0);
  p.reviewTemplate.templateDigest = core.providerWireDigest(
    omit(p.reviewTemplate, "templateDigest"),
  );
  p.preparationDigest = core.providerDigest(omit(p, "preparationDigest"));
  const old = f.archive.runs[0];
  const start: VersionedProviderStart = {
    startVersion: 2,
    clientRequestId: old.clientRequestId,
    expectedBudgetRevision: old.expectedBudgetRevision,
    expectedBudgetDigest: old.expectedBudgetDigest,
    expectedScopeRunCount: old.expectedScopeRunCount,
    expectedGlobalRunCount: old.expectedGlobalRunCount,
    preparation: p,
    approval: { ...old.approval, approvedPreparationDigest: p.preparationDigest },
  };
  const reservation = core.createProviderBudgetEvent({
    ...f.archive.budgetEvents[1],
    payload: {
      kind: "reserve-run",
      runId: old.id,
      preparationDigest: p.preparationDigest,
      generationUnits: costs(p).generation.totalUnits,
      reviewUnits: costs(p).review.totalUnits,
    },
  });
  const run = core.createVersionedProviderRun({
    input: start,
    id: old.id,
    recordedAt: old.recordedAt,
    reservation,
  });
  f.archive.budgetEvents[1] = reservation;
  f.archive.runs[0] = run;
  f.archive.artifacts[0] = core.createProviderArtifact({
    runId: run.id,
    body: JSON.stringify(p.generation.body),
  });
  f.archive.receipts[1] = {
    ...f.archive.receipts[1],
    inputDigest: run.inputDigest,
    operationDigest: run.runDigest,
  };
}
describe("native format3 reservations and passive mixed archive", () => {
  it.each(["plan-observation-v1", "plan-observation-v2"] as const)(
    "reads explicit %s without granting dispatch",
    (version) => {
      const f = fixture(),
        { run, start } = f.add(version),
        before = JSON.stringify(f.archive);
      const result = core.inspectVersionedProviderLedger(f.archive),
        snapshot = result.snapshots[0];
      expect(run.archiveFormatVersion).toBe(3);
      expect(run.schemaVersion).toBe(2);
      expect(run.inputDigest).toBe(
        core.providerDigest(core.versionedProviderStartDigestInput(start)),
      );
      expect(snapshot).toMatchObject({
        archiveFormatVersion: 4,
        revision: 0,
        state: "reserved",
        dispatchAllowed: false,
        canResume: false,
        actualAiCalls: 0,
      });
      expect(result.budgets[0]).toMatchObject({
        capUnits: "100",
        heldUnits: "4",
        recognizedUnits: "0",
      });
      expect(JSON.stringify(f.archive)).toBe(before);
    },
  );
  it("preserves legacy run, snapshot and full archive bytes against the frozen reader", () => {
    const f = fixture(),
      { run, reservation, oldStart } = f.add("plan-observation-v1", true);
    const oldInput = {
      input: oldStart(),
      id: run.id,
      recordedAt: run.recordedAt,
      reservation: frozen.providerBudgetEventSchema.parse(reservation),
    };
    expect(JSON.stringify(core.createProviderRun(oldInput))).toBe(
      JSON.stringify(frozen.createProviderRun(oldInput)),
    );
    const oldArchive = () => ({
      ...f.archive,
      runs: f.archive.runs.map((v) => frozen.providerRunSchema.parse(v)),
      events: f.archive.events.map((v) => frozen.providerRunEventSchema.parse(v)),
      artifacts: f.archive.artifacts.map((v) => frozen.providerArtifactSchema.parse(v)),
      budgetEvents: f.archive.budgetEvents.map((v) => frozen.providerBudgetEventSchema.parse(v)),
      receipts: f.archive.receipts.map((v) => frozen.providerReceiptSchema.parse(v)),
    });
    expect(JSON.stringify(core.inspectVersionedProviderLedger(oldArchive()))).toBe(
      JSON.stringify(frozen.inspectProviderLedger(oldArchive())),
    );
    f.cancel(run);
    expect(JSON.stringify(core.inspectVersionedProviderLedger(oldArchive()))).toBe(
      JSON.stringify(frozen.inspectProviderLedger(oldArchive())),
    );
  });
  it("retains the shared budget, nonces and original bytes across old, new-v1 and new-v2 runs", () => {
    const f = fixture();
    const old = f.add("plan-observation-v1", true).run;
    const oldBytes = JSON.stringify(old);
    f.add("plan-observation-v1");
    const v2 = f.add().run;
    const result = core.inspectVersionedProviderLedger(f.archive);
    expect(result.snapshots.map((v) => v.archiveFormatVersion)).toEqual([2, 4, 4]);
    expect(result.budgets[0]).toMatchObject({
      revision: 4,
      capUnits: "100",
      heldUnits: "12",
      recognizedUnits: "0",
    });
    f.cancel(v2);
    const cancelled = core.inspectVersionedProviderLedger(f.archive);
    expect(cancelled.budgets[0].heldUnits).toBe("8");
    expect(cancelled.snapshots[2]).toMatchObject({
      state: "cancelled-before-dispatch",
      storage: { heldBytes: 0 },
    });
    expect(JSON.stringify(f.archive.runs[0])).toBe(oldBytes);
  });
  it("allows the same candidate only after a valid cancellation and does not reset the budget", () => {
    const f = fixture(),
      first = f.add().run;
    f.cancel(first);
    f.add("plan-observation-v1", true, 0);
    expect(core.inspectVersionedProviderLedger(f.archive).budgets[0]).toMatchObject({
      revision: 4,
      capUnits: "100",
      heldUnits: "4",
    });
    const bad = fixture();
    bad.add();
    bad.add("plan-observation-v1", true, 0);
    expect(() => core.inspectVersionedProviderLedger(bad.archive)).toThrow();
  });
  it("rejects new native records at the unchanged legacy and frozen reservation schemas", () => {
    const f = fixture(),
      { run, start } = f.add();
    expect(() => core.providerStartSchema.parse(start)).toThrow();
    expect(() => core.providerRunSchema.parse(run)).toThrow();
    expect(() => frozen.providerRunSchema.parse(run)).toThrow();
    expect(() =>
      core.inspectProviderLedger(f.archive as Parameters<typeof core.inspectProviderLedger>[0]),
    ).toThrow();
  });
  it.each([undefined, null, 1, 3, "2"])(
    "rejects an invalid explicit startVersion %s",
    (startVersion) => {
      const f = fixture(),
        { start, run, reservation } = f.add();
      expect(() =>
        core.createVersionedProviderRun({
          input: { ...start, startVersion } as unknown as VersionedProviderStart,
          id: run.id,
          recordedAt: run.recordedAt,
          reservation,
        }),
      ).toThrow();
    },
  );
  it.each([2, 4, null])(
    "rejects archive retagging to %s even with a refreshed run digest",
    (archiveFormatVersion) => {
      const f = fixture();
      f.add();
      const changed = { ...f.archive.runs[0], archiveFormatVersion };
      changed.runDigest = core.providerDigest(omit(changed, "runDigest"));
      f.archive.runs[0] = changed as StoredProviderRun;
      f.archive.receipts[1].operationDigest = changed.runDigest;
      expect(() => core.inspectVersionedProviderLedger(f.archive)).toThrow();
    },
  );
  it("binds the start format in the digest, rejecting a retagged old v1 approval envelope", () => {
    const f = fixture();
    f.add("plan-observation-v1", true);
    const changed = { ...f.archive.runs[0], archiveFormatVersion: 3 as const };
    changed.runDigest = core.providerDigest(omit(changed, "runDigest"));
    f.archive.runs[0] = changed;
    f.archive.receipts[1].operationDigest = changed.runDigest;
    expect(() => core.inspectVersionedProviderLedger(f.archive)).toThrow();
  });
  it.each(["instructions", "review-version", "store", "tools", "budget"] as const)(
    "rejects completely rehashed %s changes",
    (kind) => {
      const f = fixture();
      f.add();
      const p = structuredClone(f.archive.runs[0].preparation);
      if (kind === "instructions") p.generation.body.input[0].content += " changed";
      if (kind === "store") Object.assign(p.generation.body, { store: true });
      if (kind === "tools") Object.assign(p.generation.body, { tools: [{ type: "web_search" }] });
      if (kind === "review-version") {
        const other = fixture();
        other.add("plan-observation-v1");
        p.reviewTemplate = other.archive.runs[0].preparation.reviewTemplate;
      }
      if (kind === "budget") p.budget.capUnits = "200";
      expect(() => {
        bindAlteredPreparation(f, p);
        core.inspectVersionedProviderLedger(f.archive);
      }).toThrow();
    },
  );
  it.each(["nonce", "receipt", "artifact", "execution", "response-key", "orphan-budget"] as const)(
    "rejects mixed archive corruption: %s",
    (kind) => {
      const f = fixture();
      f.add("plan-observation-v1", true);
      const { run } = f.add();
      if (kind === "nonce") f.archive.otherNonces = [run.clientRequestId];
      if (kind === "receipt") f.archive.receipts[2].operationDigest = f.archive.runs[0].runDigest;
      if (kind === "artifact")
        f.archive.artifacts[1] = core.createProviderArtifact({ runId: run.id, body: "{}" });
      if (kind === "execution") {
        f.cancel(run);
        Object.assign(f.archive.events[0], { executionContractVersion: 1 });
      }
      if (kind === "response-key")
        Object.assign(f.archive.artifacts[1], { key: "generation-response" });
      if (kind === "orphan-budget") f.archive.runs.pop();
      expect(() => core.inspectVersionedProviderLedger(f.archive)).toThrow();
    },
  );
  it("reads the exact mixed bytes in a cold Node process without a current prompt builder or clock", () => {
    const f = fixture();
    f.add("plan-observation-v1", true);
    const run = f.add().run;
    f.cancel(run);
    const expected = JSON.stringify(core.inspectVersionedProviderLedger(f.archive));
    const dir = mkdtempSync(join(tmpdir(), "venturepass-native-archive-"));
    try {
      const file = join(dir, "synthetic.json");
      writeFileSync(file, JSON.stringify(f.archive));
      const moduleUrl = pathToFileURL(resolve("scripts/local-data-quality-provider.mjs")).href;
      const output = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "import {readFileSync} from 'node:fs'; const core=await import(process.argv[1]); const input=JSON.parse(readFileSync(process.argv[2],'utf8')); Date.now=()=>{throw Error('No current clock')}; globalThis.fetch=()=>{throw Error('No network')}; process.stdout.write(JSON.stringify(core.inspectVersionedProviderLedger(input)));",
          moduleUrl,
          file,
        ],
        { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      );
      expect(output).toBe(expected);
    } finally {
      if (!resolve(dir).startsWith(resolve(tmpdir()) + sep)) throw Error("Unsafe cleanup");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
});
