import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  reviewValidationFixture,
  reviewValidationFindings,
  setReviewValidationOutput,
} from "./studio-plan-quality-provider-review-validation-test-helpers";
import { prepareProviderReviewValidation as prepare } from "./studio-plan-quality-provider-review-validation";
import { inspectProviderTransmissionApprovalArchive as inspect } from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import {
  providerDigest as digest,
  providerRawDigest,
} from "../../scripts/local-data-quality-provider.mjs";
import {
  createProviderExecutionArtifact,
  createProviderExecutionEvent,
  createProviderExecutionReceipt,
  providerExecutionOperationDigest,
  validateProviderExecutionFinalResult,
} from "../../scripts/local-data-quality-provider-execution.mjs";
import type {
  ProviderExecutionCommand,
  ProviderExecutionArtifact,
  ProviderExecutionEvent,
  ProviderExecutionReceipt,
  ProviderExecutionBudgetEvent,
} from "./studio-plan-quality-provider-execution-types";
import * as engine from "./studio-engine";

vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("External IO forbidden");
  }),
);
vi.mock("openai", () => ({
  default: class {
    constructor() {
      forbidden();
    }
  },
}));
vi.mock("./studio-storage", () => ({ getStudioStore: forbidden, StudioStore: forbidden }));
vi.mock("./studio-plan-quality-store", () => {
  throw Error("No DB in pure validation");
});
const base = reviewValidationFixture();
let f: typeof base;
beforeEach(() => {
  f = structuredClone(base);
  forbidden.mockClear();
  vi.stubGlobal("fetch", forbidden);
});
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function plan() {
  const result = prepare(f.input);
  if (result.status !== "prepared") throw Error(result.reason);
  return result.plan;
}
const refuse = (reason: string) =>
  expect(prepare(f.input)).toEqual({ status: "refused", reason, plan: null });
function applyValidation() {
  const p = plan(),
    ledger = f.input.archive.archive.ledger;
  ledger.artifacts.push(p.rows.artifact);
  ledger.events.push(p.rows.event);
  ledger.receipts.push(p.rows.receipt);
  return p;
}
it("prepares exactly three r9 rows with original bindings and a deeply frozen final preview without mutations or completion", () => {
  const before = structuredClone(f),
    p = plan();
  expect(f).toEqual(before);
  expect(plan()).toEqual(p);
  expect(p).toMatchObject({
    kind: "provider-review-validation-plan",
    status: "prepared-not-committed",
    validationPersisted: false,
    finalResultPersisted: false,
    dispatchAllowed: false,
    budgetWriteAllowed: false,
    automaticRetryAllowed: false,
    command: { expectedRevision: 8 },
    rows: {
      event: {
        revision: 9,
        payload: {
          kind: "domain-validated",
          phase: "review",
          responseEventDigest: f.response.eventDigest,
        },
      },
    },
    finalization: { status: "derived-not-finalized" },
  });
  expect(Object.keys(p.rows).sort()).toEqual(["artifact", "event", "receipt"]);
  expect(p.output).toEqual(JSON.parse(p.rows.artifact.body));
  expect(p.command.payload.outputDigest).toBe(digest(p.output));
  expect(p.rows.receipt.inputDigest).toBe(
    providerExecutionOperationDigest(f.identity.dispatch.generation.dispatch.runId, p.command),
  );
  expect(p.finalization.rawBody).toBe(JSON.stringify(p.finalization.body));
  expect(p.finalization.artifactSha256).toBe(providerRawDigest(p.finalization.rawBody));
  expect(p.finalization.derivedFrom.reviewEventDigest).toBe(p.rows.event.eventDigest);
  expect(Object.isFrozen(p.output)).toBe(true);
  expect(Object.isFrozen(p.finalization.body.content.sections[0].evidence)).toBe(true);
  expect(Object.isFrozen(p.identity.dispatch.generation.dispatch)).toBe(true);
  const prior = inspect(f.input.archive).reservationArchive.ledger.provider;
  applyValidation();
  const after = inspect(f.input.archive).reservationArchive.ledger.provider;
  expect(after.snapshots[0]).toMatchObject({ revision: 9, state: "validated", terminal: false });
  expect(after.budgetEvents).toEqual(prior.budgetEvents);
  expect(after.budgets).toEqual(prior.budgets);
  expect(after.artifacts.some((a) => a.key === "final-result")).toBe(false);
  expect(
    (f.input.archive.archive.ledger.artifacts as ProviderExecutionArtifact[]).find(
      (a) => a.key === "review-response",
    ),
  ).toEqual(
    (before.input.archive.archive.ledger.artifacts as ProviderExecutionArtifact[]).find(
      (a) => a.key === "review-response",
    ),
  );
});
it.each(["warning", "info", "all", "empty"])(
  "preserves the initial title/content/evidence and only raises confirmation where appropriate: %s",
  (kind) => {
    const finding = {
      ...reviewValidationFindings[0],
      severity: kind === "info" ? "info" : "warning",
      sectionKey: kind === "all" ? null : "problem",
    };
    f = reviewValidationFixture((response) =>
      setReviewValidationOutput(response, { findings: kind === "empty" ? [] : [finding] }),
    );
    const initial = JSON.parse(
      (f.input.archive.archive.ledger.artifacts as ProviderExecutionArtifact[]).find(
        (a) => a.key === "generation-validated",
      )!.body,
    ).content;
    const final = plan().finalization.body;
    expect(final.content.title).toBe(initial.title);
    expect(final.content.summary).toBe(initial.summary);
    expect(final.content.sections).toEqual(
      initial.sections.map((s: Record<string, unknown>) => ({
        ...s,
        needsConfirmation:
          s.needsConfirmation ||
          (kind !== "info" && kind !== "empty" && (kind === "all" || s.key === "problem")),
      })),
    );
    expect(final.semanticReview).toEqual(kind === "empty" ? [] : [finding]);
    for (const value of final.semanticReview) expect(final.review).toContainEqual(value);
  },
);
it("its preview is accepted by the native completed ledger without any new cost or altered content", () => {
  const p = applyValidation(),
    ledger = f.input.archive.archive.ledger,
    id = f.identity.dispatch.generation.dispatch.runId;
  const artifact = createProviderExecutionArtifact({
    runId: id,
    key: "final-result",
    body: p.finalization.rawBody,
  });
  const command: ProviderExecutionCommand<"execution-stopped"> = {
    clientRequestId: randomUUID(),
    expectedRevision: 9,
    artifact,
    payload: {
      kind: "execution-stopped",
      outcome: "completed",
      failureCode: null,
      finalArtifactSha256: artifact.sha256,
    },
  };
  const event = createProviderExecutionEvent({
    schemaVersion: 2,
    executionContractVersion: 1,
    runId: id,
    revision: 10,
    budgetRevision: p.rows.event.budgetRevision,
    previousEventDigest: p.rows.event.eventDigest,
    recordedAt: p.inspectedAt,
    payload: { ...command.payload, releasedBudgetEventDigests: [] },
  });
  ledger.artifacts.push(artifact);
  ledger.events.push(event);
  ledger.receipts.push(
    createProviderExecutionReceipt({
      ...p.rows.receipt,
      kind: "provider-finish",
      clientRequestId: command.clientRequestId,
      runRevision: 10,
      operationDigest: event.eventDigest,
      inputDigest: providerExecutionOperationDigest(id, command),
    }),
  );
  expect(inspect(f.input.archive).reservationArchive.ledger.provider.snapshots[0]).toMatchObject({
    revision: 10,
    state: "completed",
    terminal: true,
  });
});
it.each([
  "unknown-source",
  "unknown-section",
  "extra-field",
  "extra-finding-field",
  "too-many",
  "severity",
])("rejects invalid review %s", (kind) => {
  const body = { findings: structuredClone(reviewValidationFindings) };
  if (kind === "unknown-source") body.findings[0].sourceIds = ["unregistered"];
  if (kind === "unknown-section") body.findings[0].sectionKey = "unregistered";
  if (kind === "extra-field") Object.assign(body, { hiddenApproval: true });
  if (kind === "extra-finding-field") Object.assign(body.findings[0], { hiddenApproval: true });
  if (kind === "too-many") body.findings = Array.from({ length: 13 }, () => body.findings[0]);
  if (kind === "severity") Object.assign(body.findings[0], { severity: "fatal" });
  f = reviewValidationFixture((response) => setReviewValidationOutput(response, body));
  refuse("output-invalid");
});
it.each(["incomplete", "missing", "refusal", "multiple", "invalid-json", "text-limit"])(
  "rejects captured output %s",
  (kind) => {
    f = reviewValidationFixture((response) => {
      if (kind === "incomplete") response.status = "incomplete";
      if (kind === "missing") response.output = [];
      if (kind === "refusal")
        response.output = [
          { type: "message", content: [{ type: "refusal", refusal: "declined" }] },
        ];
      if (kind === "multiple")
        response.output = [
          {
            type: "message",
            content: [
              { type: "output_text", text: "{}" },
              { type: "output_text", text: "{}" },
            ],
          },
        ];
      if (kind === "invalid-json" || kind === "text-limit")
        response.output = [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: kind === "invalid-json" ? "invalid" : " ".repeat(2097153),
              },
            ],
          },
        ];
    });
    refuse("output-invalid");
  },
);
it.each(["unknown", "bound", "output-limit"])("blocks unsettled or violated usage %s", (kind) => {
  f = reviewValidationFixture((response) => {
    if (kind === "unknown") delete response.usage;
    else {
      const tokens = kind === "bound" ? 600000 : 50000;
      response.usage = {
        input_tokens: 20,
        output_tokens: tokens,
        total_tokens: tokens + 20,
        input_tokens_details: { cached_tokens: 5 },
      };
    }
  });
  refuse(kind === "unknown" ? "usage-unknown" : "budget-bound-breached");
});
it.each([false, true])(
  "never validates a terminal late response even with known cost (unknown=%s)",
  (unknown) => {
    f = reviewValidationFixture((response) => {
      if (unknown) delete response.usage;
    }, true);
    const before = structuredClone(f);
    refuse("execution-stopped");
    expect(f).toEqual(before);
  },
);
it("requires exactly the nonterminal r8 prefix, refusing r7 and an already validated r9", () => {
  // Use the original exact r7 prefix so identity checks succeed.
  const ledger = f.input.archive.archive.ledger;
  ledger.events = (ledger.events as ProviderExecutionEvent[]).filter((e) => e.revision !== 8);
  ledger.receipts = (ledger.receipts as ProviderExecutionReceipt[]).filter(
    (r) => r.clientRequestId !== f.identity.responseRequestId,
  );
  ledger.artifacts = (ledger.artifacts as ProviderExecutionArtifact[]).filter(
    (a) => a.key !== "review-response",
  );
  ledger.budgetEvents = (ledger.budgetEvents as ProviderExecutionBudgetEvent[]).filter(
    (b) => b.eventId !== f.identity.responseRequestId,
  );
  refuse("review-response-required");
  f = structuredClone(base);
  applyValidation();
  refuse("review-response-required");
});
it.each([
  "responseRequestId",
  "responseEventDigest",
  "dispatch.preparedRequestId",
  "dispatch.dispatchRequestId",
  "dispatch.validationEventDigest",
  "dispatch.generation.responseRequestId",
  "dispatch.generation.responseEventDigest",
  "dispatch.generation.validationRequestId",
  "dispatch.generation.dispatch.runId",
  "dispatch.generation.dispatch.runDigest",
  "dispatch.generation.dispatch.approvalBindingDigest",
  "dispatch.generation.dispatch.preparedRequestId",
  "dispatch.generation.dispatch.dispatchRequestId",
])("binds every original identity field: %s", (path) => {
  const parts = path.split(".");
  let row = f.identity as unknown as Record<string, unknown>;
  for (const key of parts.slice(0, -1)) row = row[key] as Record<string, unknown>;
  const key = parts.at(-1)!;
  row[key] = key.endsWith("Digest") ? "f".repeat(64) : randomUUID();
  refuse("bindings-changed");
});
it.each(["output", "finalization", "transport", "configuration", "dispatchAllowed"])(
  "rejects caller injection %s",
  (key) => {
    Object.assign(f.identity, { [key]: {} });
    refuse("invalid-input");
  },
);
it.each(["native", "policy", "other"])("rejects globally occupied validation nonce %s", (kind) => {
  if (kind === "native") f.identity.validationRequestId = f.identity.responseRequestId;
  if (kind === "policy")
    f.identity.validationRequestId = inspect(
      f.input.archive,
    ).reservationArchive.ledger.policy.records[0].clientRequestId;
  if (kind === "other")
    f.input.archive.archive.ledger.otherNonces = [f.identity.validationRequestId];
  refuse("nonce-conflict");
});
it.each(["response", "generation", "receipt", "binding", "coverage"])(
  "refuses corrupted %s before domain validation",
  (kind) => {
    if (kind === "response" || kind === "generation")
      (f.input.archive.archive.ledger.artifacts as ProviderExecutionArtifact[]).find(
        (a) => a.key === (kind === "response" ? "review-response" : "generation-validated"),
      )!.body += " ";
    if (kind === "receipt")
      (f.input.archive.archive.ledger.receipts.at(-1) as ProviderExecutionReceipt).inputDigest =
        "f".repeat(64);
    if (kind === "binding") f.input.archive.records.length = 0;
    if (kind === "coverage") f.input.archive.coverage = null;
    const hook = vi.spyOn(engine, "validateObservedPlanReview");
    refuse("archive-invalid");
    expect(hook).not.toHaveBeenCalled();
  },
);
it("allows offline planning after expiry with the compatible contract", () => {
  f.input.inspectedAt = "2035-01-01T00:00:00.000Z";
  expect(plan().dispatchAllowed).toBe(false);
});
it("distinguishes changed validator contracts from invalid output", () => {
  vi.spyOn(engine, "getPlanExecutionContract").mockReturnValue({
    ...engine.getPlanExecutionContract(),
    contractDigest: "0".repeat(64),
  });
  refuse("validation-contract-changed");
});
it.each(["getPlanExecutionContract", "validateObservedPlanReview"] as const)(
  "keeps internal %s errors out of output-invalid",
  (key) => {
    vi.spyOn(engine, key).mockImplementation(() => {
      throw Error("Internal failure");
    });
    refuse("validation-unavailable");
  },
);
it.each(["exception", "title", "summary", "content", "evidence", "semantic", "review", "order"])(
  "rejects broken finalization %s separately from provider output",
  (kind) => {
    const original = engine.finalizeObservedPlanReview;
    vi.spyOn(engine, "finalizeObservedPlanReview").mockImplementation((...args) => {
      if (kind === "exception") throw Error("Internal failure");
      const value = original(...args);
      if (kind === "title") value.content.title += " changed";
      if (kind === "summary") value.content.summary += " changed";
      if (kind === "content") value.content.sections[0].content += " changed";
      if (kind === "evidence") value.content.sections[0].evidence = [];
      if (kind === "semantic") value.semanticReview = [];
      if (kind === "review") value.review = [];
      if (kind === "order") value.content.sections.reverse();
      return value;
    });
    refuse("finalization-unavailable");
  },
);
it("the shared native final validator rejects clearing an existing confirmation flag", () => {
  const p = plan(),
    final = structuredClone(p.finalization.body);
  const generation = JSON.parse(
    (f.input.archive.archive.ledger.artifacts as ProviderExecutionArtifact[]).find(
      (row) => row.key === "generation-validated",
    )!.body,
  );
  generation.content.sections[0].needsConfirmation = true;
  final.content.sections[0].needsConfirmation = false;
  expect(() =>
    validateProviderExecutionFinalResult(final, final.contractDigest, generation, p.output),
  ).toThrow("QUALITY_PROVIDER_EXECUTION_INVALID");
  final.content.sections[0].needsConfirmation = true;
  expect(
    validateProviderExecutionFinalResult(final, final.contractDigest, generation, p.output),
  ).toEqual(final);
});
it("rejects validated review JSON above 2 MiB even when the raw output text itself fits", () => {
  const body = { findings: [{ ...reviewValidationFindings[0], id: "" }] };
  const baseBytes = Buffer.byteLength(JSON.stringify(body));
  body.findings[0].id = "x".repeat(2097152 - baseBytes);
  f = reviewValidationFixture((response) => setReviewValidationOutput(response, body));
  refuse("output-invalid");
});
it("rejects final preview over 4 MiB without misclassifying a valid review", () => {
  f = reviewValidationFixture((response) =>
    setReviewValidationOutput(response, {
      findings: [{ ...reviewValidationFindings[0], id: "x".repeat(2094000) }],
    }),
  );
  refuse("final-result-too-large");
});
it("counts external raw bytes and remaining native slots at the exact 256 MiB boundary", () => {
  const p = plan();
  f.input.additionalUsedBytes = 256 * 1024 * 1024 - p.capacity.totalExposureBytes;
  expect(plan().capacity.totalExposureBytes).toBe(256 * 1024 * 1024);
  f.input.additionalUsedBytes++;
  refuse("capacity-exceeded");
});
it.each([NaN, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid external byte count %s",
  (value) => {
    f.input.additionalUsedBytes = value;
    refuse("invalid-input");
  },
);
it("rejects backdating before the captured response", () => {
  f.input.inspectedAt = "2026-09-27T03:38:59.999Z";
  refuse("invalid-input");
});
