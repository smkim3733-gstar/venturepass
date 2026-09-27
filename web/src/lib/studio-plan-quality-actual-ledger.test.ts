import { it, expect } from "vitest";
import { z } from "zod";
import * as types from "./studio-plan-quality-actual-ledger-types";
import { actualArchiveJsonSchemas } from "../../scripts/local-data-quality-actual.mjs";
import { randomUUID } from "node:crypto";
import {
  actualTestRegistry,
  actualTestPreparation,
  actualTestPlan,
  actualTestResponse,
  actualTestNow,
} from "./studio-plan-quality-actual-test-helpers";
import {
  createActualBudgetEvent,
  createActualRun,
  createActualRunEvent,
  createActualReceipt,
  createActualArtifact,
  validateActualBudgetLedger,
  validateActualRunLedger,
  calculateActualUsage,
  deriveActualReviewRequest,
  inspectActualLedger,
  actualLedgerOperationDigest,
  actualLedgerPolicyRequestDigest,
} from "./studio-plan-quality-actual-ledger";
import { executionDigest } from "./studio-engine-request-preparation";
import type {
  EngineExecutionResponse,
  EngineExecutionOutput,
} from "./studio-engine-execution-types";
import type {
  ActualLedgerRunPayload,
  ActualLedgerBudgetPayload,
  ActualLedgerArtifact,
  ActualLedgerReceipt,
} from "./studio-plan-quality-actual-ledger-types";
it("keeps shared archive strict schemas identical to TypeScript schemas", () => {
  const schemas = Object.fromEntries(
    Object.entries(types)
      .filter(([key]) => key.endsWith("Schema"))
      .map(([key, value]) => [key, z.toJSONSchema(value as z.ZodType, { unrepresentable: "any" })]),
  );
  expect(actualArchiveJsonSchemas).toEqual(schemas);
});

function fixture(cap = "100") {
  const registry = actualTestRegistry(),
    id = randomUUID();
  const budgetEvents = [
    createActualBudgetEvent({
      scopeId: types.actualLedgerScope,
      revision: 1,
      previousDigest: null,
      eventId: randomUUID(),
      recordedAt: actualTestNow,
      provenance: "synthetic-test",
      currency: "TST",
      unitScale: 6,
      payload: { kind: "configure", capUnits: cap },
    }),
  ];
  const preparation = actualTestPreparation(registry, {
    capUnits: cap,
    ledgerDigest: budgetEvents[0].eventDigest,
  });
  const start: types.ActualLedgerStart = {
    clientRequestId: randomUUID(),
    expectedBudgetRevision: 1,
    expectedBudgetDigest: budgetEvents[0].eventDigest,
    expectedActualRunCount: 0,
    preparation,
    approval: {
      provenance: "synthetic-test",
      approvedPreparationDigest: preparation.preparationDigest,
      acknowledgedSyntheticOnly: true,
      approvedAt: actualTestNow,
    },
  };
  function budget(payload: ActualLedgerBudgetPayload) {
    const event = createActualBudgetEvent({
      scopeId: types.actualLedgerScope,
      revision: budgetEvents.length + 1,
      previousDigest: budgetEvents.at(-1)!.eventDigest,
      eventId: randomUUID(),
      recordedAt: actualTestNow,
      provenance: "synthetic-test",
      currency: "TST",
      unitScale: 6,
      payload,
    });
    budgetEvents.push(event);
    return event;
  }
  const reserve = budget({
    kind: "reserve-run",
    runId: id,
    preparationDigest: preparation.preparationDigest,
    generationUnits: preparation.costs!.generationUnits,
    reviewUnits: preparation.costs!.reviewUnits,
  });
  const run = createActualRun({
    input: start,
    id,
    recordedAt: actualTestNow,
    reservation: reserve,
  });
  const events: types.ActualLedgerRunEvent[] = [],
    artifacts: ActualLedgerArtifact[] = [
      createActualArtifact({
        runId: id,
        key: "generation-request",
        body: JSON.stringify(preparation.requestEvidence!.generation.body),
      }),
    ];
  const receipts: ActualLedgerReceipt[] = [
    createActualReceipt({
      kind: "actual-start",
      clientRequestId: start.clientRequestId,
      inputDigest: run.inputDigest,
      runId: id,
      runRevision: 0,
      budgetRevision: 2,
      operationDigest: run.runDigest,
      recordedAt: actualTestNow,
    }),
  ];
  function event(payload: ActualLedgerRunPayload) {
    const item = createActualRunEvent({
      runId: id,
      revision: events.length + 1,
      budgetRevision: budgetEvents.length,
      previousEventDigest: events.at(-1)?.eventDigest ?? null,
      recordedAt: actualTestNow,
      payload,
    });
    events.push(item);
    const kind = (
      {
        "request-prepared": "actual-prepare",
        "dispatch-intent": "actual-dispatch",
        "response-received": "actual-response",
        "domain-validated": "actual-validate",
        "execution-stopped": "actual-stop",
      } as const
    )[payload.kind];
    const nonce = randomUUID();
    let linkedArtifact: ActualLedgerArtifact | undefined;
    if (
      payload.kind === "response-received" ||
      payload.kind === "domain-validated" ||
      (payload.kind === "request-prepared" && payload.phase === "review")
    )
      linkedArtifact = artifacts.find((a) => a.sha256 === payload.artifactSha256);
    else if (payload.kind === "execution-stopped" && payload.outcome === "completed")
      linkedArtifact = artifacts.find((a) => a.key === "final-result");
    receipts.push(
      createActualReceipt({
        kind,
        clientRequestId: nonce,
        inputDigest: actualLedgerOperationDigest({
          kind,
          clientRequestId: nonce,
          runId: id,
          expectedRevision: item.revision - 1,
          payload,
          artifact: linkedArtifact,
        }),
        runId: id,
        runRevision: item.revision,
        budgetRevision: budgetEvents.length,
        operationDigest: item.eventDigest,
        recordedAt: actualTestNow,
      }),
    );
    return item;
  }
  const artifact = (key: ActualLedgerArtifact["key"], body: unknown) => {
    const a = createActualArtifact({ runId: id, key, body: JSON.stringify(body) });
    artifacts.push(a);
    return a;
  };
  const head = () => ({
    budgetRevision: budgetEvents.length,
    budgetDigest: budgetEvents.at(-1)!.eventDigest,
  });
  function prepared(phase: "generation" | "review", output?: EngineExecutionOutput) {
    let a = artifacts[0];
    if (phase === "review") a = artifact("review-request", deriveActualReviewRequest(run, output!));
    return event({
      kind: "request-prepared",
      phase,
      requestDigest: executionDigest(JSON.parse(a.body)),
      artifactSha256: a.sha256,
      inputTokenUpperBound: phase === "generation" ? 10 : 20,
      derivedFrom:
        phase === "generation"
          ? null
          : {
              generationEventDigest: events.find(
                (item) => item.payload.kind === "domain-validated",
              )!.eventDigest,
              artifactSha256: artifacts.find((item) => item.key === "generation-validated")!.sha256,
            },
      ...head(),
    });
  }
  function dispatch(phase: "generation" | "review") {
    const p = events.findLast(
      (item) => item.payload.kind === "request-prepared" && item.payload.phase === phase,
    )!;
    if (p.payload.kind !== "request-prepared") throw 0;
    return event({
      kind: "dispatch-intent",
      phase,
      requestDigest: p.payload.requestDigest,
      preparedEventDigest: p.eventDigest,
      artifactSha256: p.payload.artifactSha256,
      ...head(),
    });
  }
  function response(
    phase: "generation" | "review",
    output: unknown,
    options: Parameters<typeof actualTestResponse>[1] = {},
  ) {
    const raw = actualTestResponse(output, options),
      a = artifact(`${phase}-response`, { captureKind: "sdk-response-json", response: raw });
    const dispatchEvent = events.findLast(
      (item) => item.payload.kind === "dispatch-intent" && item.payload.phase === phase,
    )!;
    if (dispatchEvent.payload.kind !== "dispatch-intent") throw 0;
    const requestBody = JSON.parse(artifacts.find((item) => item.key === `${phase}-request`)!.body);
    const metadata: EngineExecutionResponse = {
      request: {
        mode: "mock",
        provider: "mock",
        phase,
        sequence: phase === "generation" ? 1 : 2,
        configuredModel: preparation.model!,
        contractDigest: preparation.engine.contractDigest,
        requestDigest: dispatchEvent.payload.requestDigest,
        inputChars: requestBody.input.reduce(
          (n: number, item: { content: string }) => n + item.content.length,
          0,
        ),
        maxOutputTokens: 16000,
      },
      responseId: raw.id,
      requestId: raw._request_id,
      responseModel: raw.model,
      status: raw.status,
      usage: raw.usage
        ? {
            inputTokens: raw.usage.input_tokens,
            outputTokens: raw.usage.output_tokens,
            totalTokens: raw.usage.total_tokens,
            cachedInputTokens: null,
            reasoningOutputTokens: null,
          }
        : null,
    };
    const usage = calculateActualUsage({ run, phase, metadata, artifact: a }),
      usageEvent = usage ? budget(usage) : null;
    const result = event({
      kind: "response-received",
      phase,
      requestDigest: metadata.request.requestDigest,
      dispatchEventDigest: dispatchEvent.eventDigest,
      artifactSha256: a.sha256,
      metadata,
      usageBudgetEventDigest: usageEvent?.eventDigest ?? null,
    });
    return { result, metadata, artifact: a, usage };
  }
  function validated(phase: "generation" | "review", output: EngineExecutionOutput) {
    const responseEvent = events.findLast(
      (item) => item.payload.kind === "response-received" && item.payload.phase === phase,
    )!;
    if (responseEvent.payload.kind !== "response-received") throw 0;
    const a = artifact(`${phase}-validated`, output);
    return event({
      kind: "domain-validated",
      phase,
      requestDigest: responseEvent.payload.requestDigest,
      responseEventDigest: responseEvent.eventDigest,
      artifactSha256: a.sha256,
      outputDigest: executionDigest(output),
    });
  }
  const validate = () =>
    validateActualRunLedger({ run, events, artifacts, budgetEvents, receipts, registry });
  const inspect = () =>
    inspectActualLedger({
      runs: [run],
      events,
      artifacts,
      budgetEvents,
      receipts: [
        createActualReceipt({
          kind: "actual-budget-configure",
          clientRequestId: budgetEvents[0].eventId,
          inputDigest: actualLedgerPolicyRequestDigest(budgetEvents[0], budgetEvents[0].eventId),
          runId: null,
          runRevision: null,
          budgetRevision: 1,
          operationDigest: budgetEvents[0].eventDigest,
          recordedAt: actualTestNow,
        }),
        ...receipts,
      ],
      registries: [registry],
    });
  return {
    registry,
    run,
    start,
    budgetEvents,
    budget,
    events,
    event,
    artifacts,
    artifact,
    receipts,
    prepared,
    dispatch,
    response,
    validated,
    validate,
    inspect,
  };
}
it("starts with one immutable request and reserves record space and both stages", () => {
  const f = fixture(),
    s = f.validate(),
    all = f.inspect();
  expect(s.state).toBe("reserved");
  expect(s.actualAiCalls).toBe(0);
  expect(s.sameCandidateBlocked).toBe(true);
  expect(s.storage.heldBytes + s.storage.usedBytes).toBe(32 * 1024 * 1024);
  expect(all.budget.heldUnits).toBe("4");
  expect(all.reservedBudgetEventSlots).toBe(15);
  expect(all.reservedReceiptSlots).toBe(63);
});
it("preserves whole observed cost above reservation with min consumption and deficit", () => {
  const f = fixture("4");
  f.prepared("generation");
  f.dispatch("generation");
  const r = f.response("generation", actualTestPlan(f.registry), {
    inputTokens: 5000000,
    outputTokens: 16000,
  });
  expect(r.usage).toMatchObject({
    recognizedUnits: "6",
    consumedReservedUnits: "2",
    unusedReleasedUnits: "0",
    boundExcessUnits: "4",
    tokenBoundBreached: true,
  });
  const b = validateActualBudgetLedger(f.budgetEvents);
  expect(b.recognizedUsageUnits).toBe("6");
  expect(b.heldUnits).toBe("2");
  expect(b.deficitUnits).toBe("4");
  expect(f.validate().costState).toBe("bound-breached");
  expect(f.validate().actualAiCalls).toBe(0);
});
it("marks token breach even when money stays inside its reservation", () => {
  const f = fixture();
  f.prepared("generation");
  f.dispatch("generation");
  const r = f.response("generation", actualTestPlan(f.registry), {
    inputTokens: 11,
    outputTokens: 1,
  });
  expect(r.usage).toMatchObject({
    recognizedUnits: "2",
    boundExcessUnits: "0",
    tokenBoundBreached: true,
  });
  expect(validateActualBudgetLedger(f.budgetEvents).boundBreached).toBe(true);
});
it.each([{ missingUsage: true }, { model: "unclear-returned-model" }])(
  "holds costs when usage/model is unclear: %j",
  (options) => {
    const f = fixture();
    f.prepared("generation");
    f.dispatch("generation");
    expect(f.response("generation", actualTestPlan(f.registry), options).usage).toBeNull();
    expect(f.validate().costState).toBe("held");
    expect(validateActualBudgetLedger(f.budgetEvents).heldUnits).toBe("4");
  },
);
it("completes generation and exact same-run derived review and releases unused storage", () => {
  const f = fixture(),
    plan = actualTestPlan(f.registry),
    output: EngineExecutionOutput = { kind: "plan", content: plan };
  f.prepared("generation");
  f.dispatch("generation");
  f.response("generation", plan);
  f.validated("generation", output);
  f.prepared("review", output);
  f.dispatch("review");
  f.response("review", { findings: [] });
  f.validated("review", { kind: "review", findings: [] });
  const final = f.artifact("final-result", {
    content: plan,
    review: [],
    semanticReview: [],
    contractDigest: f.run.preparation.engine.contractDigest,
  });
  f.event({
    kind: "execution-stopped",
    outcome: "completed",
    failureCode: null,
    finalArtifactSha256: final.sha256,
    releasedBudgetEventDigests: [],
  });
  const s = f.validate();
  expect(s.state).toBe("completed");
  expect(s.costState).toBe("settled");
  expect(s.sameCandidateBlocked).toBe(false);
  expect(s.storage.heldBytes).toBe(0);
  expect(f.inspect().reservedBytes).toBe(0);
});
it("does not free dispatched costs when stopping without a response", () => {
  const f = fixture();
  f.prepared("generation");
  f.dispatch("generation");
  const release = f.budget({
    kind: "release-unused",
    runId: f.run.id,
    phase: "review",
    reservationDigest: f.run.reservationDigest,
    units: "2",
    reason: "not-dispatched",
  });
  f.event({
    kind: "execution-stopped",
    outcome: "result-unobserved",
    failureCode: "INTERRUPTED",
    finalArtifactSha256: null,
    releasedBudgetEventDigests: [release.eventDigest],
  });
  expect(f.validate().state).toBe("result-unobserved");
  expect(f.validate().storage.heldBytes).toBeGreaterThan(0);
  expect(validateActualBudgetLedger(f.budgetEvents).heldUnits).toBe("2");
});
it("rejects releasing a dispatched reservation even when all hashes are rebuilt", () => {
  const f = fixture();
  f.prepared("generation");
  f.dispatch("generation");
  const release = f.budget({
    kind: "release-unused",
    runId: f.run.id,
    phase: "generation",
    reservationDigest: f.run.reservationDigest,
    units: "2",
    reason: "not-dispatched",
  });
  f.event({
    kind: "execution-stopped",
    outcome: "result-unobserved",
    failureCode: "INTERRUPTED",
    finalArtifactSha256: null,
    releasedBudgetEventDigests: [release.eventDigest],
  });
  expect(f.validate).toThrow(/dispatched/);
});
it("rejects a second consumption of one reservation", () => {
  const f = fixture();
  f.prepared("generation");
  f.dispatch("generation");
  const r = f.response("generation", actualTestPlan(f.registry));
  f.budget(r.usage!);
  expect(() => validateActualBudgetLedger(f.budgetEvents)).toThrow(/consumed/);
});
it("allows zero cap policy but cannot reserve a paid stage", () => {
  const f = fixture();
  const policy = createActualBudgetEvent({
    ...f.budgetEvents[0],
    payload: { kind: "configure", capUnits: "0" },
  });
  expect(validateActualBudgetLedger([policy]).availableUnits).toBe("0");
  const reserve = createActualBudgetEvent({
    ...f.budgetEvents[1],
    previousDigest: policy.eventDigest,
  });
  expect(() => validateActualBudgetLedger([policy, reserve])).toThrow(/exceeded/);
});
it.each(["authorization", "headers", "apiKey", "client", "exception"])(
  "refuses %s in captured SDK response",
  (key) => {
    const f = fixture(),
      response = actualTestResponse({ findings: [] });
    expect(() =>
      f.artifact("generation-response", {
        captureKind: "sdk-response-json",
        response: { ...response, [key]: "sensitive" },
      }),
    ).toThrow();
  },
);
it("matches raw usage to metadata before recognizing costs", () => {
  const f = fixture();
  f.prepared("generation");
  f.dispatch("generation");
  const r = f.response("generation", actualTestPlan(f.registry));
  r.metadata.usage!.inputTokens = 8;
  expect(() =>
    calculateActualUsage({
      run: f.run,
      phase: "generation",
      metadata: r.metadata,
      artifact: r.artifact,
    }),
  ).toThrow(/metadata/);
});
it("rejects modified request bytes, missing receipts and global nonce collisions", () => {
  const f = fixture();
  f.artifacts[0] = createActualArtifact({
    runId: f.run.id,
    key: "generation-request",
    body: JSON.stringify({
      ...f.run.preparation.requestEvidence!.generation.body,
      model: "changed",
    }),
  });
  expect(f.validate).toThrow(/original request/);
  const g = fixture();
  g.receipts.length = 0;
  expect(g.inspect).toThrow(/receipt/);
  const h = fixture();
  expect(() =>
    inspectActualLedger({
      runs: [h.run],
      events: h.events,
      artifacts: h.artifacts,
      budgetEvents: h.budgetEvents,
      receipts: h.receipts,
      registries: [h.registry],
      otherNonces: [h.start.clientRequestId],
    }),
  ).toThrow(/nonce/);
});
it("rejects review before domain validation and cannot use another plan", () => {
  const f = fixture();
  f.prepared("generation");
  f.dispatch("generation");
  f.response("generation", actualTestPlan(f.registry));
  const plan = actualTestPlan(f.registry);
  f.validated("generation", { kind: "plan", content: plan });
  const changed = structuredClone(plan);
  changed.summary = "another execution";
  f.prepared("review", { kind: "plan", content: changed });
  expect(f.validate).toThrow(/derivation/);
});
it("enforces original quote evidence and output identity", () => {
  const f = fixture(),
    plan = actualTestPlan(f.registry);
  f.prepared("generation");
  f.dispatch("generation");
  f.response("generation", plan);
  const changed = structuredClone(plan);
  changed.sections[0].content = "unobserved content";
  f.validated("generation", { kind: "plan", content: changed });
  expect(f.validate).toThrow();
});
it("keeps historical snapshot stable after unrelated budgets and artifact row reordering", () => {
  const f = fixture(),
    plan = actualTestPlan(f.registry);
  f.prepared("generation");
  f.dispatch("generation");
  f.response("generation", plan);
  f.validated("generation", { kind: "plan", content: plan });
  const before = JSON.stringify(f.validate());
  f.artifacts.reverse();
  f.budget({
    kind: "reserve-run",
    runId: randomUUID(),
    preparationDigest: "b".repeat(64),
    generationUnits: "2",
    reviewUnits: "2",
  });
  expect(JSON.stringify(f.validate())).toBe(before);
});
it("rejects request digest and recorded time changes even after row SHA reconstruction", () => {
  const f = fixture();
  f.prepared("generation");
  f.receipts[1].inputDigest = "a".repeat(64);
  expect(f.inspect).toThrow(/request digest/);
  const g = fixture();
  g.prepared("generation");
  g.receipts[1].recordedAt = "2026-09-27T04:00:00.000Z";
  expect(g.inspect).toThrow(/receipt/);
});
it("cannot lower a response receipt below its own usage journal head", () => {
  const f = fixture();
  f.prepared("generation");
  f.dispatch("generation");
  f.response("generation", actualTestPlan(f.registry));
  f.receipts.at(-1)!.budgetRevision = 2;
  expect(f.inspect).toThrow(/receipt|budget order/);
});
it("rejects a receipt moved to a later unrelated budget head", () => {
  const f = fixture();
  f.prepared("generation");
  f.budget({
    kind: "reserve-run",
    runId: randomUUID(),
    preparationDigest: "c".repeat(64),
    generationUnits: "2",
    reviewUnits: "2",
  });
  f.receipts.at(-1)!.budgetRevision = f.budgetEvents.length;
  expect(f.inspect).toThrow(/receipt/);
});
it("rejects an invented quote even if it is present in both captured and validated outputs", () => {
  const f = fixture(),
    plan = actualTestPlan(f.registry);
  plan.sections[0].evidence[0].quote =
    "This quotation is deliberately absent from all synthetic source text.";
  f.prepared("generation");
  f.dispatch("generation");
  f.response("generation", plan);
  f.validated("generation", { kind: "plan", content: plan });
  expect(f.validate).toThrow(/quotation/);
});
