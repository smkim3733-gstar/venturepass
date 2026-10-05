import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { finalizationStoreFixture } from "./studio-plan-quality-provider-finalization-store-test-helpers";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import { readPublicComparisonPrefix } from "./studio-public-claim-comparison-prefix-test-helpers";
import { publicClaimComparisonFixture } from "./studio-public-claim-comparison-test-helpers";
import { preparePublicClaimComparison } from "./studio-public-claim-comparison";
import {
  inspectArchivedPublicClaimRequest,
  buildPublicClaimComparisonRequest,
} from "./studio-public-claim-comparison-request";
import { captureProviderResponse } from "../../scripts/local-data-quality-provider-usage.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { publicClaimComparisonRequestAuthority } from "./studio-public-claim-comparison-request-types";
import { validatePreparedPublicClaimComparison } from "./studio-public-claim-comparison";
import * as configuration from "./studio-plan-quality-provider-configuration";
import {
  createPublicComparisonCoverage,
  inspectPublicComparisonNativeArchive,
  lookupPublicComparisonNativeNonce,
  createPublicComparisonBudgetEvent,
  publicComparisonBudgetInputDigest,
  type PublicComparisonPrefix,
  type PublicComparisonCoverage,
  type PublicComparisonBudgetSuffix,
  type PublicComparisonBudgetEvent,
} from "./studio-public-claim-comparison-budget";
import {
  createPublicComparisonNativeRun,
  createPublicComparisonNativeEvent,
  publicComparisonNativeInputDigest,
  type PublicComparisonNativeEvent,
  type PublicComparisonNativeRecords,
} from "./studio-public-claim-comparison-native";
vi.mock("server-only", () => ({}));
vi.mock(
  "./studio-plan-quality-provider-configuration-current",
  () => import("./studio-plan-quality-provider-configuration-20260927-test-fixture"),
);
const guard = vi.hoisted(() => ({ enabled: false }));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("I/O forbidden");
  }),
);
vi.mock("node:sqlite", async (original) => {
  const actual = await original<typeof import("node:sqlite")>();
  return {
    ...actual,
    DatabaseSync: class extends actual.DatabaseSync {
      constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) {
        if (guard.enabled) forbidden();
        super(...args);
      }
    },
  };
});
vi.mock("openai", () => ({
  default: class {
    constructor() {
      forbidden();
    }
  },
}));
vi.mock("./studio-storage", () => ({ getStudioStore: forbidden, StudioStore: forbidden }));
let prefix: PublicComparisonPrefix, coverage: PublicComparisonCoverage, directory: string;
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-native-contract-"));
  const store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
  try {
    store.candidateRegistryRegister({
      expectedVersion: 0,
      clientRequestId: randomUUID(),
      sourceDigest: store.candidateRegistryList().source.sourceDigest,
      acknowledgedCandidateStatus: true,
    });
    const f = await finalizationStoreFixture(store);
    store.providerRecordFinalization(f.identity);
    const db = new DatabaseSync(join(directory, "quality-evaluation", "quality.sqlite"));
    try {
      prefix = readPublicComparisonPrefix(db);
    } finally {
      db.close();
    }
  } finally {
    store.close();
  }
  coverage = createPublicComparisonCoverage(prefix);
  guard.enabled = true;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(forbidden);
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(forbidden);
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(forbidden);
}, 30000);
afterAll(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (directory) {
    const r = relative(resolve(tmpdir()), resolve(directory));
    if (!r.startsWith("venture-native-contract-") || r.includes(".."))
      throw Error("Unsafe cleanup");
    rmSync(directory, { recursive: true, force: true });
  }
});
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
type Archive = {
  records: PublicComparisonNativeRecords;
  financial: Omit<PublicComparisonBudgetSuffix, "evidence">;
};
function fixture(base?: Archive) {
  const f = publicClaimComparisonFixture(2),
    selection = f.select();
  selection.sourceIds = selection.sourceIds.slice(0, 1);
  const command = {
    requestVersion: "public-claim-comparison-request-v1" as const,
    model: "synthetic-model",
    selection,
  };
  const request = buildPublicClaimComparisonRequest(f.company, command),
    prepared = preparePublicClaimComparison(f.company, selection);
  const a: Archive = base ?? {
    records: { runs: [], events: [], receipts: [], artifacts: [] },
    financial: { events: [], receipts: [] },
  };
  const runId = randomUUID(),
    now = "2026-10-05T10:00:00.000Z";
  const addArtifact = (
    key: PublicComparisonNativeRecords["artifacts"][number]["key"],
    body: string,
  ) => {
    const v = { runId, key, body, sha256: sha(body), sizeBytes: Buffer.byteLength(body) };
    a.records.artifacts.push(v);
    return v;
  };
  const context = addArtifact("comparison-context", JSON.stringify(prepared));
  addArtifact("comparison-request", request.rawBody);
  const b = coverage.budgets.find((v) => v.scopeId === prefix.scopeId)!;
  const manifest = {
    version: 1 as const,
    purpose: "compare-public-claim" as const,
    coverageDigest: coverage.coverageDigest,
    scopeId: prefix.scopeId,
    environment: prefix.environment,
    currency: b.currency!,
    unitScale: b.unitScale!,
    expectedBudgetHead: {
      revision: a.financial.events.at(-1)?.revision ?? b.revision,
      headDigest: a.financial.events.at(-1)?.eventDigest ?? b.headDigest!,
    },
    reservedUnits: "1000",
    requestIdentityDigest: digest(request.identity),
    contextSha256: context.sha256,
    expiresAt: "2026-10-05T11:00:00.000Z",
    maxCalls: 1 as const,
    automaticRetryLimit: 0 as const,
    storageReservationBytes: 33554432 as const,
    selectedContentRetentionAcknowledged: true as const,
    comparisonPurposeAcknowledged: true as const,
  };
  const run = createPublicComparisonNativeRun({
    schemaVersion: 3,
    archiveFormatVersion: 4,
    purpose: "compare-public-claim",
    id: runId,
    createdAt: now,
    command,
    identity: request.identity,
    manifest,
    manifestDigest: digest(manifest),
  });
  a.records.runs.push(run);
  function money(payload: PublicComparisonBudgetEvent["payload"]) {
    const e = createPublicComparisonBudgetEvent({
      schemaVersion: 3,
      purpose: "compare-public-claim",
      scopeId: prefix.scopeId,
      environment: prefix.environment,
      provenance: "explicit-user",
      currency: b.currency!,
      unitScale: b.unitScale!,
      revision: (a.financial.events.at(-1)?.revision ?? b.revision) + 1,
      previousDigest: a.financial.events.at(-1)?.eventDigest ?? b.headDigest!,
      eventId: randomUUID(),
      recordedAt: now,
      payload,
    });
    a.financial.events.push(e);
    a.financial.receipts.push({
      schemaVersion: 3,
      purpose: "compare-public-claim",
      scopeId: prefix.scopeId,
      clientRequestId: randomUUID(),
      runId,
      inputDigest: publicComparisonBudgetInputDigest(e),
      budgetRevision: e.revision,
      operationDigest: e.eventDigest,
      recordedAt: now,
    });
    return e;
  }
  function event(
    payload: PublicComparisonNativeEvent["payload"],
    budget?: PublicComparisonBudgetEvent,
  ) {
    const e = createPublicComparisonNativeEvent({
      schemaVersion: 3,
      purpose: "compare-public-claim",
      runId,
      eventId: randomUUID(),
      revision: a.records.events.filter((v) => v.runId === runId).length + 1,
      previousDigest:
        a.records.events.filter((v) => v.runId === runId).at(-1)?.eventDigest ?? run.runDigest,
      recordedAt: now,
      payload,
    });
    a.records.events.push(e);
    const br = budget && a.financial.receipts.find((r) => r.operationDigest === budget.eventDigest);
    a.records.receipts.push({
      schemaVersion: 3,
      purpose: "compare-public-claim",
      runId,
      clientRequestId: br?.clientRequestId ?? randomUUID(),
      inputDigest: br?.inputDigest ?? publicComparisonNativeInputDigest(e),
      eventRevision: e.revision,
      operationDigest: e.eventDigest,
      budgetOperationDigest: budget?.eventDigest ?? null,
      recordedAt: now,
    });
    return e;
  }
  const reserved = money({
    kind: "reserve-comparison",
    runId,
    requestDigest: run.identity.requestDigest,
    manifestDigest: run.manifestDigest,
    reservedUnits: "1000",
  });
  event({ kind: "reserved", budgetEventDigest: reserved.eventDigest }, reserved);
  const dispatch = () =>
    event({
      kind: "dispatch-recorded",
      reservationDigest: reserved.eventDigest,
      requestDigest: request.identity.requestDigest,
      manifestDigest: run.manifestDigest,
    });
  function cancel() {
    const e = event({
      kind: "cancelled",
      reservationDigest: reserved.eventDigest,
      reason: "not-dispatched",
    });
    const b = money({
      kind: "release-comparison",
      runId,
      reservationDigest: reserved.eventDigest,
      reason: "not-dispatched",
      cancellationEventDigest: e.eventDigest,
      releasedUnits: "1000",
    });
    const r = a.records.receipts.at(-1)!,
      br = a.financial.receipts.at(-1)!;
    r.clientRequestId = br.clientRequestId;
    r.inputDigest = br.inputDigest;
    r.budgetOperationDigest = b.eventDigest;
  }
  const response = {
    preparationDigest: prepared.preparationDigest,
    claimQuote: prepared.input.claimQuote,
    overall: { relation: "undetermined" as const, reason: "Provided excerpt only" },
    evidence: prepared.input.selectedEvidence.map((v) => ({
      sourceId: v.sourceId,
      relation: "undetermined" as const,
      quotes: [],
      reason: "Needs review",
      nextCheck: "",
    })),
    checks: [],
  };
  function capture(d: PublicComparisonNativeEvent, raw?: unknown) {
    const body = JSON.stringify(
      captureProviderResponse(
        raw ?? {
          id: "resp_synthetic",
          model: command.model,
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: JSON.stringify(response) }],
            },
          ],
        },
      ),
    );
    const artifact = addArtifact("comparison-response", body);
    event({
      kind: "response-captured",
      dispatchEventDigest: d.eventDigest,
      responseArtifactSha256: artifact.sha256,
    });
    return artifact;
  }
  function comparison(responseSha: string, state = "comparison-ready") {
    const value = {
      source: "supplied-response",
      evidenceOrigin: "manual-unverified",
      ...publicClaimComparisonRequestAuthority,
      currentContextVerified: false,
      requestIdentity: run.identity,
      responseArtifactSha256: responseSha,
      state,
      comparison:
        state === "comparison-ready"
          ? validatePreparedPublicClaimComparison(prepared, response)
          : null,
    };
    const art = addArtifact("comparison-validated", JSON.stringify(value));
    event({
      kind: "comparison-recorded",
      responseArtifactSha256: responseSha,
      validatedArtifactSha256: art.sha256,
    });
  }
  function settle(d: PublicComparisonNativeEvent, responseSha: string, units = "200") {
    const assessment = {
      status: "known" as const,
      units,
      requestDigest: request.identity.requestDigest,
      dispatchEventDigest: d.eventDigest,
      responseArtifactSha256: responseSha,
      requestedTier: null,
      violations: [],
    };
    event({ kind: "usage-assessed", assessment });
    const cost = BigInt(units),
      held = BigInt(1000),
      consumed = cost < held ? cost : held;
    const b = money({
      kind: "recognize-comparison-usage",
      runId,
      reservationDigest: reserved.eventDigest,
      dispatchEventDigest: d.eventDigest,
      responseArtifactSha256: responseSha,
      usageAssessmentDigest: digest(assessment),
      recognizedUnits: units,
      consumedHeldUnits: consumed.toString(),
      releasedHeldUnits: (held - consumed).toString(),
      boundExcessUnits: (cost > held ? cost - held : BigInt(0)).toString(),
    });
    event({ kind: "cost-settled", budgetEventDigest: b.eventDigest }, b);
  }
  function finish() {
    const captured = a.records.artifacts.find(
      (v) => v.runId === runId && v.key === "comparison-response",
    );
    const assessed = a.records.events.find(
      (v) => v.runId === runId && v.payload.kind === "usage-assessed",
    );
    const compared = a.records.artifacts.find(
      (v) => v.runId === runId && v.key === "comparison-validated",
    );
    const value = {
      schemaVersion: 3,
      purpose: "compare-public-claim",
      runId,
      requestDigest: request.identity.requestDigest,
      manifestDigest: run.manifestDigest,
      cancelled: a.records.events.some((v) => v.runId === runId && v.payload.kind === "cancelled"),
      responseArtifactSha256: captured?.sha256 ?? null,
      comparisonState: compared ? JSON.parse(compared.body).state : null,
      assessmentDigest:
        assessed?.payload.kind === "usage-assessed" ? digest(assessed.payload.assessment) : null,
      costSettled: true,
      source: "supplied-native-archive",
      currentContextVerified: false,
      dispatchAllowed: false,
      costAssessmentVerified: false,
    };
    const art = addArtifact("final-result", JSON.stringify(value));
    event({ kind: "finalized", finalArtifactSha256: art.sha256 });
  }
  return {
    a,
    f,
    run,
    prepared,
    request,
    addArtifact,
    event,
    money,
    dispatch,
    cancel,
    capture,
    comparison,
    settle,
    finish,
    response,
  };
}
const inspect = (a: Archive) => inspectPublicComparisonNativeArchive(prefix, coverage, a);
function complete() {
  const f = fixture(),
    d = f.dispatch(),
    c = f.capture(d);
  f.comparison(c.sha256);
  f.settle(d, c.sha256);
  f.finish();
  return f;
}
it("audits nonempty legacy cost and exact request/context without company/private records", () => {
  const f = complete(),
    before = JSON.stringify(f.a),
    r = inspect(f.a);
  expect(r.structureConsistent).toBe(true);
  expect(r.runs[0].finalized).toBe(true);
  const old = coverage.budgets.find((v) => v.scopeId === prefix.scopeId)!;
  expect(r.recognizedUnits).toBe((BigInt(old.recognizedUnits) + BigInt(200)).toString());
  expect(r.heldUnits).toBe("0");
  expect(r.capacity.comparisonHeldBytes).toBe(0);
  expect(r.capacity.comparisonUsedBytes).toBeGreaterThan(0);
  expect(Object.values(r.authority).every((v) => v === false)).toBe(true);
  expect(before).not.toMatch(/PRIVATE_PROFILE|PRIVATE_SUMMARY|PRIVATE_OWNER|PRIVATE_SECTION/);
  expect(JSON.stringify(f.a)).toBe(before);
  f.f.company.sources = [];
  f.f.company.plans = [];
  expect(inspect(f.a)).toEqual(r);
});
it("retains a full reservation until finalized even after monetary settlement", () => {
  const f = fixture(),
    d = f.dispatch(),
    c = f.capture(d);
  f.comparison(c.sha256);
  f.settle(d, c.sha256);
  const r = inspect(f.a);
  expect(r.heldUnits).toBe("0");
  expect(r.capacity.comparisonUsedBytes + r.capacity.comparisonHeldBytes).toBe(33554432);
  expect(r.capacity.reservedReceiptSlots).toBe(64 - f.a.records.events.length);
});
it("pre-dispatch cancellation shares the original money command receipt", () => {
  const f = fixture();
  f.cancel();
  f.finish();
  const r = inspect(f.a);
  expect(r.heldUnits).toBe("0");
  expect(r.runs[0].dispatchRecorded).toBe(false);
  expect(r.nativeReceipts).toHaveLength(3);
  expect(r.capacity.comparisonHeldBytes).toBe(0);
});
it.each(["not-started-unconfirmed", "transport-unknown", "restart-unknown"] as const)(
  "keeps unknown cost held and allows one late capture: %s",
  (reason) => {
    const f = fixture(),
      d = f.dispatch();
    f.event({ kind: "dispatch-unknown", dispatchEventDigest: d.eventDigest, reason });
    expect(inspect(f.a).heldUnits).toBe("1000");
    const c = f.capture(d);
    f.comparison(c.sha256);
    expect(inspect(f.a).heldUnits).toBe("1000");
    f.settle(d, c.sha256);
    f.finish();
    expect(inspect(f.a).runs[0].finalized).toBe(true);
  },
);
it.each(["response-incomplete", "model-mismatch", "comparison-rejected"] as const)(
  "preserves rejected response and separate supplied settlement: %s",
  (state) => {
    const f = fixture(),
      d = f.dispatch();
    const raw =
      state === "response-incomplete"
        ? { id: "r", status: "incomplete", model: "synthetic-model", output: [] }
        : {
            id: "r",
            status: "completed",
            model: state === "model-mismatch" ? "alias" : "synthetic-model",
            output: [
              {
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "{}" }],
              },
            ],
          };
    const c = f.capture(d, raw);
    f.comparison(c.sha256, state);
    f.settle(d, c.sha256);
    f.finish();
    const r = inspect(f.a);
    expect(r.runs[0].comparisonState).toBe(state);
    expect(r.runs[0].costSettled).toBe(true);
    expect(r.authority.costAssessmentVerified).toBe(false);
  },
);
it("keeps missing usage nullable and explicit zero cost distinct from no assessment", () => {
  const f = fixture(),
    d = f.dispatch(),
    c = f.capture(d);
  f.comparison(c.sha256);
  expect(inspect(f.a).runs[0].responseMetadata?.usage.inputTokens).toBeNull();
  expect(inspect(f.a).heldUnits).toBe("1000");
  f.settle(d, c.sha256, "0");
  f.finish();
  expect(inspect(f.a).heldUnits).toBe("0");
});
it("exposes cost excess without erasing the response or certifying price", () => {
  const f = fixture(),
    d = f.dispatch(),
    c = f.capture(d);
  f.comparison(c.sha256);
  f.settle(d, c.sha256, "1001");
  f.finish();
  expect(inspect(f.a).boundBreached).toBe(true);
});
it("replay returns the original native receipt, never an owner", () => {
  const f = complete(),
    r = f.a.records.receipts[1],
    read = () =>
      lookupPublicComparisonNativeNonce(prefix, coverage, f.a, {
        nonce: r.clientRequestId,
        inputDigest: r.inputDigest,
      });
  expect(read()).toMatchObject({ status: "replay", record: r, owner: null });
  const first = read();
  if (first.record && typeof first.record === "object" && "inputDigest" in first.record) first.record.inputDigest = digest("changed");
  expect(read().record).toEqual(r);
  expect(() =>
    lookupPublicComparisonNativeNonce(prefix, coverage, f.a, {
      nonce: r.clientRequestId,
      inputDigest: digest("other"),
    }),
  ).toThrow();
});
it("reads legacy nonce without a current company", () => {
  const row = prefix.rows.actualRows.receipts[0],
    r = JSON.parse(row.body);
  expect(
    lookupPublicComparisonNativeNonce(prefix, coverage, complete().a, {
      nonce: row.nonce,
      inputDigest: r.inputDigest,
    }),
  ).toMatchObject({ status: "replay", record: r, owner: null });
});
it.each([
  [
    "run schema",
    (a: Archive) => {
      Object.assign(a.records.runs[0], { schemaVersion: 2 });
    },
  ],
  [
    "run digest",
    (a: Archive) => {
      a.records.runs[0].runDigest = digest("bad");
    },
  ],
  [
    "request bytes",
    (a: Archive) => {
      a.records.artifacts[1].body += " ";
    },
  ],
  [
    "artifact size",
    (a: Archive) => {
      a.records.artifacts[0].sizeBytes++;
    },
  ],
  [
    "duplicate artifact",
    (a: Archive) => {
      a.records.artifacts.push(a.records.artifacts[0]);
    },
  ],
  [
    "orphan artifact",
    (a: Archive) => {
      a.records.artifacts[0].runId = randomUUID();
    },
  ],
  [
    "event chain",
    (a: Archive) => {
      a.records.events[1].previousDigest = digest("bad");
    },
  ],
  [
    "event missing",
    (a: Archive) => {
      a.records.events.splice(1, 1);
    },
  ],
  [
    "receipt missing",
    (a: Archive) => {
      a.records.receipts.pop();
    },
  ],
  [
    "receipt cross run",
    (a: Archive) => {
      a.records.receipts[1].runId = randomUUID();
    },
  ],
  [
    "receipt input",
    (a: Archive) => {
      a.records.receipts[1].inputDigest = digest("bad");
    },
  ],
  [
    "duplicate nonce",
    (a: Archive) => {
      a.records.receipts[1].clientRequestId = a.records.receipts[0].clientRequestId;
    },
  ],
  [
    "split money receipt",
    (a: Archive) => {
      a.records.receipts[0].clientRequestId = randomUUID();
    },
  ],
  [
    "money event missing",
    (a: Archive) => {
      a.financial.events.pop();
      a.financial.receipts.pop();
    },
  ],
  [
    "old nonce reuse",
    (a: Archive) => {
      a.records.receipts[1].clientRequestId = prefix.rows.actualRows.receipts[0].nonce;
    },
  ],
  [
    "old event ID",
    (a: Archive) => {
      a.records.events[1].eventId = JSON.parse(prefix.rows.actualRows.budget[0].body).eventId;
    },
  ],
  [
    "supplied evidence",
    (a: Archive) => {
      Object.assign(a.financial, { evidence: [] });
    },
  ],
  [
    "authority",
    (a: Archive) => {
      Object.assign(a.records.runs[0], { dispatchAllowed: true });
    },
  ],
] as const)("rejects %s", (_name, change) => {
  const f = complete();
  change(f.a);
  expect(() => inspect(f.a)).toThrow();
});
it.each([
  "comparison-context",
  "comparison-request",
  "comparison-response",
  "comparison-validated",
  "final-result",
] as const)("detects rewritten %s even with a matching artifact hash", (key) => {
  const f = complete(),
    a = f.a.records.artifacts.find((v) => v.key === key)!;
  a.body += " ";
  a.sha256 = sha(a.body);
  a.sizeBytes = Buffer.byteLength(a.body);
  expect(() => inspect(f.a)).toThrow();
});
it.each([
  "double-dispatch",
  "cancel-after-dispatch",
  "capture-without-dispatch",
  "unknown-after-capture",
  "double-capture",
  "finalize-held",
  "after-final",
] as const)("rejects invalid transition %s", (kind) => {
  const f = fixture();
  if (kind === "double-dispatch") {
    f.dispatch();
    f.dispatch();
  }
  if (kind === "cancel-after-dispatch") {
    f.dispatch();
    f.cancel();
  }
  if (kind === "capture-without-dispatch") {
    f.capture(f.a.records.events[0]);
  }
  if (kind === "unknown-after-capture") {
    const d = f.dispatch();
    f.capture(d);
    f.event({
      kind: "dispatch-unknown",
      dispatchEventDigest: d.eventDigest,
      reason: "restart-unknown",
    });
  }
  if (kind === "double-capture") {
    const d = f.dispatch();
    f.capture(d);
    f.capture(d);
  }
  if (kind === "finalize-held") {
    f.finish();
  }
  if (kind === "after-final") {
    f.cancel();
    f.finish();
    f.dispatch();
  }
  expect(() => inspect(f.a)).toThrow();
});
it("does not invoke getters or toJSON before rejecting malformed archives", () => {
  const f = fixture(),
    hook = vi.fn(() => {
      throw Error("sensitive");
    });
  Object.defineProperty(f.a.records, "credentials", { get: hook, enumerable: true });
  expect(() => inspect(f.a)).toThrow();
  expect(hook).not.toHaveBeenCalled();
});
it("rejects capacity overflow before parsing huge records", () => {
  const f = fixture();
  f.a.records.runs = Array.from({ length: 21 }, () => f.run);
  expect(() => inspect(f.a)).toThrow();
});
it("keeps exact excluded IDs and returns detached state/metadata", () => {
  const f = complete(),
    r = inspect(f.a);
  r.runs[0].responseMetadata!.usage.inputTokens = 123;
  expect(inspect(f.a).runs[0].responseMetadata!.usage.inputTokens).toBeNull();
  expect(f.prepared.input.excludedSourceIds).toHaveLength(1);
});

it("releases verified terminal storage for later runs in the same scope without resetting costs", () => {
  let a: Archive | undefined;
  for (let i = 0; i < 10; i++) {
    const f = fixture(a);
    f.cancel();
    f.finish();
    a = f.a;
  }
  const r = inspect(a!);
  expect(r.runs).toHaveLength(10);
  expect(r.capacity.comparisonHeldBytes).toBe(0);
  expect(r.capacity.reservedBudgetSlots).toBe(0);
  expect(r.heldUnits).toBe("0");
  expect(r.recognizedUnits).toBe(
    coverage.budgets.find((v) => v.scopeId === prefix.scopeId)!.recognizedUnits,
  );
});
it("keeps reservation and dispatch records cold with no automatic resumption", () => {
  const f = fixture();
  expect(inspect(f.a).heldUnits).toBe("1000");
  const d = f.dispatch();
  const r = f.a.records.receipts.find((v) => v.operationDigest === d.eventDigest)!;
  const archive = JSON.parse(JSON.stringify(f.a));
  expect(
    lookupPublicComparisonNativeNonce(prefix, coverage, archive, {
      nonce: r.clientRequestId,
      inputDigest: r.inputDigest,
    }),
  ).toMatchObject({ status: "replay", owner: null });
  expect(inspect(archive).runs[0]).toMatchObject({
    responseCaptured: false,
    costSettled: false,
    owner: null,
  });
});
it("rejects expired dispatch after checking a valid hash/receipt chain", () => {
  const f = fixture(),
    d = f.dispatch();
  d.recordedAt = f.run.manifest.expiresAt;
  const { eventDigest: old, ...unsigned } = d;
  d.eventDigest = digest(unsigned);
  const r = f.a.records.receipts.find((v) => v.operationDigest === old)!;
  r.operationDigest = d.eventDigest;
  r.recordedAt = d.recordedAt;
  expect(() => inspect(f.a)).toThrow();
});
it("rejects known assessment with an invented requested tier", () => {
  const f = complete(),
    e = f.a.records.events.find((v) => v.payload.kind === "usage-assessed")!;
  if (e.payload.kind !== "usage-assessed") throw Error("fixture");
  Object.assign(e.payload.assessment, { requestedTier: "default" });
  expect(() => inspect(f.a)).toThrow();
});
it("rejects response credentials even if the enclosing artifact checksum is recomputed", () => {
  const f = fixture(),
    d = f.dispatch(),
    c = f.capture(d);
  c.body = c.body.slice(0, -1) + ',"api_key":"private"}';
  c.sha256 = sha(c.body);
  c.sizeBytes = Buffer.byteLength(c.body);
  const e = f.a.records.events.at(-1)!;
  if (e.payload.kind !== "response-captured") throw Error("fixture");
  e.payload.responseArtifactSha256 = c.sha256;
  const { eventDigest: old, ...unsigned } = e;
  e.eventDigest = digest(unsigned);
  const r = f.a.records.receipts.find((v) => v.operationDigest === old)!;
  r.operationDigest = e.eventDigest;
  r.inputDigest = publicComparisonNativeInputDigest(e);
  expect(() => inspect(f.a)).toThrow();
});

it.each([
  [
    "reference outside excerpt",
    (p: ReturnType<typeof preparePublicClaimComparison>) => {
      p.input.selectedEvidence[0].originalReference.quote = "unseen quote";
    },
  ],
  [
    "excluded selected ID",
    (p: ReturnType<typeof preparePublicClaimComparison>) => {
      p.input.excludedSourceIds = [p.selection.sourceIds[0]];
    },
  ],
  [
    "duplicate excluded ID",
    (p: ReturnType<typeof preparePublicClaimComparison>) => {
      p.input.excludedSourceIds.push(p.input.excludedSourceIds[0]);
    },
  ],
  [
    "claim outside section",
    (p: ReturnType<typeof preparePublicClaimComparison>) => {
      p.input.claimQuote = "not in section";
    },
  ],
  [
    "changed source date",
    (p: ReturnType<typeof preparePublicClaimComparison>) => {
      p.input.selectedEvidence[0].metadata.publishedOn = "2024-01-01";
    },
  ],
  [
    "unknown private field",
    (p: ReturnType<typeof preparePublicClaimComparison>) => {
      Object.assign(p.input, { profile: "private" });
    },
  ],
  [
    "false authority",
    (p: ReturnType<typeof preparePublicClaimComparison>) => {
      Object.assign(p, { factVerified: true });
    },
  ],
] as const)("rejects self-rehashed archived context: %s", (_name, change) => {
  const f = fixture(),
    p = structuredClone(f.prepared);
  change(p);
  const { preparationDigest: _hash, inputCharacters: _length, ...payload } = p;
  void _hash;
  void _length;
  const body = JSON.stringify(payload),
    raw = JSON.stringify({
      ...payload,
      preparationDigest: sha(body),
      inputCharacters: body.length,
    });
  expect(() => inspectArchivedPublicClaimRequest(f.run.command, raw)).toThrow();
});
it("preserves all original request bytes when reading the archived preparation", () => {
  const f = fixture(),
    read = inspectArchivedPublicClaimRequest(f.run.command, JSON.stringify(f.prepared));
  expect(read.request).toEqual(f.request);
  expect(read.prepared).toEqual(f.prepared);
  expect(read.request.identity.rawBodySha256).toBe(sha(f.request.rawBody));
});
