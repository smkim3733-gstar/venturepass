/** Synthetic archive chains only: never dispatches to a supplier. */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import * as core from "../../scripts/local-data-quality-provider.mjs";
import { inspectVersionedProviderTransmissionApprovalArchive as inspectUpper } from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import {
  executionBase,
  fixture,
  complete,
  prepare,
  dispatch,
  receive,
  validate,
  finish,
  add,
  snapshot,
  budget,
  type Fixture,
} from "./studio-plan-quality-provider-execution-version-test-helpers";
import type {
  VersionedProviderExecutionPayload,
  ProviderExecutionArtifact,
} from "./studio-plan-quality-provider-execution-types";
let base: ReturnType<typeof executionBase>;
beforeAll(() => {
  base = executionBase();
}, 15000);
const forbidden = vi.fn(() => {
  throw Error("No supplier IO");
});
beforeEach(() => {
  forbidden.mockClear();
  vi.stubGlobal("fetch", forbidden);
});
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const make = () => fixture(base);
function generation(f: Fixture) {
  prepare(f, "generation");
  dispatch(f, "generation");
  receive(f, "generation");
  validate(f, "generation");
}
function replaceLast(
  f: Fixture,
  mutate: (p: VersionedProviderExecutionPayload) => void,
  artifact?: ProviderExecutionArtifact,
) {
  const e = f.data.events.pop()!,
    r = f.data.receipts.pop()!;
  mutate(e.payload);
  if (artifact) {
    const i = f.data.artifacts.findIndex((a) => a.key === artifact.key);
    if (i >= 0) f.data.artifacts.splice(i, 1);
  }
  return add(f, e.payload, artifact, r.clientRequestId);
}

it("audits full v2 generation and derived review, two settlements and final output without granting authority", () => {
  const f = make(),
    before = JSON.stringify(snapshot(f));
  const approvalOnly = core.validateVersionedProviderApprovalLedger({
    ...f.data,
    events: [core.versionedProviderApprovalEventSchema.parse(f.data.events[0])],
    startSnapshot: core.validateVersionedProviderRunLedger({
      ...f.data,
      events: [],
      receipts: f.data.receipts.slice(0, 1),
    }) as import("./studio-plan-quality-provider-types").VersionedProviderReservationSnapshot,
  });
  expect(JSON.stringify(approvalOnly)).toBe(before);
  complete(f);
  expect(snapshot(f)).toMatchObject({
    archiveFormatVersion: 5,
    revision: 10,
    state: "completed",
    terminal: true,
    unsettled: false,
    dispatchAllowed: false,
    canResume: false,
    actualAiCalls: null,
    dispatchIntentCount: 2,
    responseCount: 2,
  });
  expect(budget(f)).toMatchObject({ heldUnits: "0", recognizedUnits: "350", capUnits: "15000000" });
  expect(inspectUpper(f.upper()).reservationArchive.ledger.provider.snapshots[0]).toEqual(
    snapshot(f),
  );
  expect(
    JSON.stringify(
      core.validateVersionedProviderRunLedger({
        ...f.data,
        events: f.data.events.slice(0, 1),
        artifacts: f.data.artifacts.slice(0, 1),
        budgetEvents: f.data.budgetEvents.slice(0, 2),
        receipts: f.data.receipts.slice(0, 2),
      }),
    ),
  ).toBe(before);
  expect(() => core.validateProviderRunLedger(f.data as never)).toThrow();
  expect(() =>
    core.validateVersionedProviderApprovalLedger({
      ...f.data,
      startSnapshot: f.startSnapshot,
    } as never),
  ).toThrow();
});

it("keeps approval operation bytes identical while later event digests explicitly bind execution version2", () => {
  const f = make(),
    a = f.data.events[0];
  const command = {
    clientRequestId: f.data.receipts[1].clientRequestId,
    expectedRevision: 0 as const,
    payload: core.versionedProviderTransmissionApprovalSchema.parse(a.payload),
  };
  expect(core.versionedProviderExecutionOperationDigest(f.data.run.id, command)).toBe(
    core.versionedProviderApprovalOperationDigest(f.data.run.id, command),
  );
  prepare(f, "generation");
  const p = f.data.events[1].payload;
  if (p.kind !== "request-prepared") throw Error("prepared");
  const c = {
    clientRequestId: f.data.receipts[2].clientRequestId,
    expectedRevision: 1,
    payload: p,
  };
  expect(core.versionedProviderExecutionOperationDigest(f.data.run.id, c)).not.toBe(
    core.providerExecutionOperationDigest(f.data.run.id, c),
  );
  expect(core.versionedProviderApprovalCommandSchema.safeParse(c).success).toBe(false);
  f.data.receipts[2].inputDigest = core.providerExecutionOperationDigest(f.data.run.id, c);
  expect(() => snapshot(f)).toThrow();
});

it.each(["generationEventDigest", "artifactSha256", "outputDigest"] as const)(
  "rejects resealed review provenance with another %s",
  (key) => {
    const f = make();
    generation(f);
    prepare(f, "review");
    replaceLast(
      f,
      (p) => {
        if (p.kind !== "request-prepared" || !p.derivedFrom) throw Error("derived");
        p.derivedFrom[key] = "a".repeat(64);
      },
      f.data.artifacts.find((a) => a.key === "review-request"),
    );
    expect(() => snapshot(f)).toThrow();
  },
);

it.each(["system", "draft", "schema", "store", "tools"] as const)(
  "rejects a rehashed review request with changed %s",
  (key) => {
    const f = make();
    generation(f);
    prepare(f, "review");
    const original = f.data.artifacts.find((a) => a.key === "review-request")!,
      body = JSON.parse(original.body);
    if (key === "system") body.input[0].content = "old v1 instructions";
    if (key === "draft") {
      const u = JSON.parse(body.input[1].content);
      u.draft.summary = "different or final draft";
      body.input[1].content = JSON.stringify(u);
    }
    if (key === "schema") body.text.format.name = "wrong_contract";
    if (key === "store") body.store = true;
    if (key === "tools") body.tools = [];
    const artifact = core.createProviderExecutionArtifact({
      runId: f.data.run.id,
      key: "review-request",
      body: JSON.stringify(body),
    });
    replaceLast(
      f,
      (p) => {
        if (p.kind !== "request-prepared") throw Error("prepared");
        p.requestDigest = core.providerWireDigest(body);
        p.artifactSha256 = artifact.sha256;
      },
      artifact,
    );
    expect(() => snapshot(f)).toThrow();
  },
);

it.each(["generation", "review"] as const)("rejects a v1 %s event in a v2 chain", (phase) => {
  const f = make();
  if (phase === "review") generation(f);
  prepare(f, phase);
  const e = f.data.events.at(-1)!;
  Object.assign(e, { executionContractVersion: 1 });
  expect(() => snapshot(f)).toThrow();
});

it("does not allow review preparation before the original generation validation", () => {
  const f = make();
  prepare(f, "generation");
  dispatch(f, "generation");
  receive(f, "generation");
  const a = core.createProviderExecutionArtifact({
      runId: f.data.run.id,
      key: "review-request",
      body: "{}",
    }),
    b = budget(f);
  add(
    f,
    {
      kind: "request-prepared",
      phase: "review",
      requestDigest: core.providerWireDigest({}),
      artifactSha256: a.sha256,
      derivedFrom: {
        generationEventDigest: "a".repeat(64),
        artifactSha256: "b".repeat(64),
        outputDigest: "c".repeat(64),
      },
      budgetRevision: b.revision,
      budgetDigest: b.headDigest!,
    },
    a,
  );
  expect(() => snapshot(f)).toThrow();
});

it("retains unknown-cost holds and releases only the undispatched review", () => {
  const f = make();
  prepare(f, "generation");
  dispatch(f, "generation");
  receive(f, "generation", (raw) => {
    delete raw.usage;
  });
  finish(f, "needs-cost-review");
  expect(snapshot(f)).toMatchObject({
    state: "needs-cost-review",
    terminal: true,
    unsettled: true,
    eligibleForNewCandidateRun: false,
    dispatchIntentCount: 1,
    responseCount: 1,
  });
  expect(budget(f).recognizedUnits).toBe("0");
  expect(BigInt(budget(f).heldUnits)).toBeGreaterThan(BigInt(0));
  expect(inspectUpper(f.upper()).reservationArchive.ledger.provider.snapshots[0]).toEqual(
    snapshot(f),
  );
});

it("preserves an unobserved dispatch and accepts its single later captured response without a retry", () => {
  const f = make();
  prepare(f, "generation");
  dispatch(f, "generation");
  finish(f, "result-unobserved");
  expect(snapshot(f)).toMatchObject({
    state: "result-unobserved",
    unobservedDispatchCount: 1,
    unsettled: true,
  });
  receive(f, "generation");
  expect(snapshot(f)).toMatchObject({
    state: "result-unobserved",
    unobservedDispatchCount: 0,
    unsettled: false,
    dispatchIntentCount: 1,
  });
  expect(() => {
    receive(f, "generation");
    snapshot(f);
  }).toThrow();
});

it("releases both reservations on a before-dispatch stop without recognized cost", () => {
  const f = make();
  finish(f, "before-dispatch");
  expect(snapshot(f)).toMatchObject({
    state: "before-dispatch",
    unsettled: false,
    dispatchIntentCount: 0,
  });
  expect(budget(f)).toMatchObject({ heldUnits: "0", recognizedUnits: "0" });
});

it.each(["metadata", "assessment", "recognition"] as const)(
  "rejects resealed response %s disagreement",
  (key) => {
    const f = make();
    prepare(f, "generation");
    dispatch(f, "generation");
    receive(f, "generation");
    replaceLast(
      f,
      (p) => {
        if (p.kind !== "response-received") throw Error("response");
        if (key === "metadata") p.metadata.configuredModel = "other-model";
        if (key === "assessment") Object.assign(p.usageAssessment, { units: "1" });
        if (key === "recognition") p.usageBudgetEventDigest = "a".repeat(64);
      },
      f.data.artifacts.find((a) => a.key === "generation-response"),
    );
    expect(() => snapshot(f)).toThrow();
  },
);

it("refuses a validated output invented after a provider refusal", () => {
  const f = make();
  prepare(f, "generation");
  dispatch(f, "generation");
  receive(f, "generation", (raw) => {
    raw.output = [{ type: "message", content: [{ type: "refusal", refusal: "declined" }] }];
  });
  validate(f, "generation");
  expect(() => snapshot(f)).toThrow();
});

it.each(["draft", "contract", "semanticReview"] as const)(
  "rejects a resealed final artifact changing %s",
  (key) => {
    const f = complete(make()),
      original = f.data.artifacts.find((a) => a.key === "final-result")!,
      final = JSON.parse(original.body);
    if (key === "draft") final.content.summary = "rewritten";
    if (key === "contract") final.contractDigest = "a".repeat(64);
    if (key === "semanticReview") {
      final.semanticReview = [
        {
          id: "new-finding",
          severity: "warning",
          category: "evidence",
          message: "Not in the captured review",
          action: "Check original",
          sectionKey: null,
          sourceIds: [],
        },
      ];
      final.review = final.semanticReview;
    }
    const artifact = core.createProviderExecutionArtifact({
      runId: f.data.run.id,
      key: "final-result",
      body: JSON.stringify(final),
    });
    replaceLast(
      f,
      (p) => {
        if (p.kind !== "execution-stopped") throw Error("finish");
        p.finalArtifactSha256 = artifact.sha256;
      },
      artifact,
    );
    expect(() => snapshot(f)).toThrow();
  },
);

it("rejects missing upper approval binding even when the native full chain is valid", () => {
  const f = complete(make());
  expect(snapshot(f).state).toBe("completed");
  expect(() => inspectUpper({ ...f.upper(), records: [] })).toThrow();
});

it("reads the exact full archive in a fresh Node process without a clock, prompt builder or network", () => {
  const f = complete(make()),
    expected = JSON.stringify(core.inspectVersionedProviderLedger(f.all()));
  const url = pathToFileURL(resolve("scripts/local-data-quality-provider.mjs")).href;
  const script =
    "import {readFileSync} from 'node:fs'; const core=await import(" +
    JSON.stringify(url) +
    "); Date.now=()=>{throw Error('clock')}; globalThis.fetch=()=>{throw Error('network')}; process.stdout.write(JSON.stringify(core.inspectVersionedProviderLedger(JSON.parse(readFileSync(0,'utf8')))));";
  expect(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      input: JSON.stringify(f.all()),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }),
  ).toBe(expected);
});
