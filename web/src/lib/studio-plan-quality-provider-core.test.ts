import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actualTestNow, actualTestRegistry } from "./studio-plan-quality-actual-test-helpers";
import { candidateRegistryVersionDigest } from "./studio-plan-quality-candidate-registry";
import {
  providerTestExpires,
  providerTestFinancialInput,
} from "./studio-plan-quality-provider-test-helpers";
import {
  createProviderPreparation,
  createProviderRequestReview,
  validateNewProviderPreparation,
  validateProviderPreparation,
  providerBudgetScope,
  providerDigest,
  providerWireDigest,
  providerRawDigest,
  providerPolicyDigestInput,
  providerCancelDigestInput,
  createProviderBudgetEvent,
  createProviderRun,
  createProviderRunEvent,
  createProviderReceipt,
  createProviderArtifact,
  validateProviderBudgetLedger,
  validateProviderRunLedger,
  inspectProviderLedger,
} from "./studio-plan-quality-provider-core";
import { providerRunEventSchema, providerStartSchema } from "./studio-plan-quality-provider-types";
import type {
  ProviderPreparation,
  ProviderStart,
  ProviderRunEvent,
  ProviderReceipt,
} from "./studio-plan-quality-provider-types";

const forbidden = vi.fn(() => {
  throw new Error("Provider IO forbidden");
});
beforeEach(() => vi.stubGlobal("fetch", forbidden));
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
const without = (value: object, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
function eventInput<T extends { eventDigest: string }>(value: T): Omit<T, "eventDigest"> {
  const { eventDigest, ...input } = value;
  void eventDigest;
  return input;
}
function rehash(p: ProviderPreparation) {
  p.generation.requestDigest = providerWireDigest(p.generation.body);
  p.generation.sha256 = providerRawDigest(JSON.stringify(p.generation.body));
  p.generation.inputChars = p.generation.body.input.reduce((n, v) => n + v.content.length, 0);
  p.reviewTemplate.templateDigest = providerWireDigest(without(p.reviewTemplate, "templateDigest"));
  p.financialBasisDigest = providerDigest(p.financialBasis);
  p.retentionDigest = providerDigest(p.retention);
  p.preparationDigest = providerDigest(without(p, "preparationDigest"));
  return p;
}
function fixture() {
  const registry = actualTestRegistry(),
    scopeId = providerBudgetScope("synthetic-test"),
    nonce = randomUUID();
  const policy = {
    environment: "synthetic-test",
    provenance: "synthetic-test",
    currency: "TST",
    unitScale: 6,
    capUnits: "100",
  } as const;
  const configured = createProviderBudgetEvent({
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
  const policyReceipt = createProviderReceipt({
    schemaVersion: 2,
    scopeId,
    kind: "provider-budget-configure",
    clientRequestId: nonce,
    inputDigest: providerDigest(
      providerPolicyDigestInput({ clientRequestId: nonce, expectedRevision: 0, policy }),
    ),
    runId: null,
    runRevision: null,
    budgetRevision: 1,
    operationDigest: configured.eventDigest,
    recordedAt: actualTestNow,
  });
  const preparation = createProviderPreparation({
    registry,
    candidateId: registry.entries[0].candidateId,
    environment: "synthetic-test",
    preparedAt: actualTestNow,
    expiresAt: providerTestExpires,
    financialInput: providerTestFinancialInput(),
    budget: {
      scopeId,
      revision: 1,
      headDigest: configured.eventDigest,
      currency: "TST",
      unitScale: 6,
      capUnits: "100",
      heldUnits: "0",
      recognizedUnits: "0",
    },
    retention: {
      policyVersion: "synthetic-v2",
      notice: "Synthetic fixture; no provider call",
      sourceUrl: "https://example.invalid/retention",
      documentDigest: "b".repeat(64),
      reviewedAt: actualTestNow,
      validUntil: providerTestExpires,
    },
  });
  const start: ProviderStart = {
    clientRequestId: randomUUID(),
    expectedBudgetRevision: 1,
    expectedBudgetDigest: configured.eventDigest,
    expectedScopeRunCount: 0,
    expectedGlobalRunCount: 0,
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
    reservation = createProviderBudgetEvent({
      schemaVersion: 2,
      scopeId,
      environment: "synthetic-test",
      provenance: "synthetic-test",
      revision: 2,
      previousDigest: configured.eventDigest,
      eventId: start.clientRequestId,
      recordedAt: actualTestNow,
      currency: "TST",
      unitScale: 6,
      payload: {
        kind: "reserve-run",
        runId: id,
        preparationDigest: preparation.preparationDigest,
        generationUnits: "2",
        reviewUnits: "2",
      },
    });
  const run = createProviderRun({ input: start, id, recordedAt: actualTestNow, reservation });
  const receipt = createProviderReceipt({
    schemaVersion: 2,
    scopeId,
    kind: "provider-start",
    clientRequestId: start.clientRequestId,
    inputDigest: run.inputDigest,
    runId: id,
    runRevision: 0,
    budgetRevision: 2,
    operationDigest: run.runDigest,
    recordedAt: actualTestNow,
  });
  const artifacts = [
    createProviderArtifact({ runId: id, body: JSON.stringify(preparation.generation.body) }),
  ];
  const data = {
    run,
    events: [] as ProviderRunEvent[],
    artifacts,
    budgetEvents: [configured, reservation],
    receipts: [receipt],
    registry,
  };
  const all = () => ({
    runs: [data.run],
    events: data.events,
    artifacts: data.artifacts,
    budgetEvents: data.budgetEvents,
    receipts: [policyReceipt, ...data.receipts],
    registries: [registry],
  });
  return { registry, preparation, start, data, all, policyReceipt };
}
function cancel(f: ReturnType<typeof fixture>) {
  const run = f.data.run,
    last = f.data.budgetEvents.at(-1)!,
    nonce = randomUUID(),
    time = "2026-09-27T04:00:00.000Z";
  const release = createProviderBudgetEvent({
    ...without(last, "eventDigest"),
    schemaVersion: 2,
    scopeId: last.scopeId,
    environment: last.environment,
    provenance: last.provenance,
    currency: last.currency,
    unitScale: last.unitScale,
    revision: last.revision + 1,
    previousDigest: last.eventDigest,
    eventId: nonce,
    recordedAt: time,
    payload: {
      kind: "release-run",
      runId: run.id,
      reservationDigest: run.reservationDigest,
      generationUnits: "2",
      reviewUnits: "2",
      reason: "cancelled-before-dispatch",
    },
  });
  const event = createProviderRunEvent({
    schemaVersion: 2,
    runId: run.id,
    revision: 1,
    budgetRevision: release.revision,
    previousEventDigest: null,
    recordedAt: time,
    payload: {
      kind: "cancelled-before-dispatch",
      reason: "test-cleanup",
      releaseBudgetEventDigest: release.eventDigest,
    },
  });
  const receipt = createProviderReceipt({
    schemaVersion: 2,
    scopeId: last.scopeId,
    kind: "provider-cancel",
    clientRequestId: nonce,
    inputDigest: providerDigest(
      providerCancelDigestInput(run.id, {
        clientRequestId: nonce,
        expectedRevision: 0,
        reason: "test-cleanup",
      }),
    ),
    runId: run.id,
    runRevision: 1,
    budgetRevision: release.revision,
    operationDigest: event.eventDigest,
    recordedAt: time,
  });
  f.data.budgetEvents.push(release);
  f.data.events.push(event);
  f.data.receipts.push(receipt);
}
function appendSameCandidate(f: ReturnType<typeof fixture>) {
  const prior = validateProviderBudgetLedger(
    f.data.budgetEvents,
    providerBudgetScope("synthetic-test"),
  );
  const p = rehash({
    ...structuredClone(f.preparation),
    budget: {
      ...f.preparation.budget,
      revision: prior.revision,
      headDigest: prior.headDigest!,
      heldUnits: prior.heldUnits,
    },
  });
  const input: ProviderStart = {
    ...structuredClone(f.start),
    clientRequestId: randomUUID(),
    expectedBudgetRevision: prior.revision,
    expectedBudgetDigest: prior.headDigest!,
    expectedScopeRunCount: 1,
    expectedGlobalRunCount: 1,
    preparation: p,
    approval: { ...f.start.approval, approvedPreparationDigest: p.preparationDigest },
  };
  const id = randomUUID(),
    reservation = createProviderBudgetEvent({
      schemaVersion: 2,
      scopeId: prior.scopeId,
      environment: "synthetic-test",
      provenance: "synthetic-test",
      revision: prior.revision + 1,
      previousDigest: prior.headDigest,
      eventId: input.clientRequestId,
      recordedAt: actualTestNow,
      currency: "TST",
      unitScale: 6,
      payload: {
        kind: "reserve-run",
        runId: id,
        preparationDigest: p.preparationDigest,
        generationUnits: "2",
        reviewUnits: "2",
      },
    });
  const run = createProviderRun({ input, id, recordedAt: actualTestNow, reservation }),
    artifact = createProviderArtifact({ runId: id, body: JSON.stringify(p.generation.body) });
  const receipt = createProviderReceipt({
    schemaVersion: 2,
    scopeId: prior.scopeId,
    kind: "provider-start",
    clientRequestId: input.clientRequestId,
    inputDigest: run.inputDigest,
    runId: id,
    runRevision: 0,
    budgetRevision: reservation.revision,
    operationDigest: run.runDigest,
    recordedAt: actualTestNow,
  });
  f.data.budgetEvents.push(reservation);
  return () => ({
    ...f.all(),
    runs: [f.data.run, run],
    artifacts: [...f.data.artifacts, artifact],
    receipts: [...f.all().receipts, receipt],
  });
}

function requestFixture(candidateIndex = 0) {
  const registry = actualTestRegistry();
  registry.clientRequestId = "10000000-0000-4000-8000-000000000001";
  registry.versionDigest = candidateRegistryVersionDigest(registry);
  const input = {
    registry,
    candidateId: registry.entries[candidateIndex].candidateId,
    environment: "synthetic-test" as const,
    preparedAt: actualTestNow,
    expiresAt: providerTestExpires,
    financialInput: providerTestFinancialInput(),
    budget: {
      scopeId: providerBudgetScope("synthetic-test"),
      revision: 1,
      headDigest: "a".repeat(64),
      currency: "TST",
      unitScale: 6,
      capUnits: "100",
      heldUnits: "0",
      recognizedUnits: "0",
    },
    retention: {
      policyVersion: "synthetic-v2",
      notice: "Synthetic fixture; no provider call",
      sourceUrl: "https://example.invalid/retention",
      documentDigest: "b".repeat(64),
      reviewedAt: actualTestNow,
      validUntil: providerTestExpires,
    },
  };
  return { input, preparation: createProviderPreparation(input) };
}

it("preserves pre-extraction v2 preparation bytes and request digests for all 12 candidates", () => {
  const values = Array.from({ length: 12 }, (_, index) => requestFixture(index).preparation);
  expect({
    fullPreparations: providerRawDigest(JSON.stringify(values)),
    generationDigest: values[0].generation.requestDigest,
    generationSha: values[0].generation.sha256,
    contractDigest: values[0].contract.contractDigest,
    templateDigest: values[0].reviewTemplate.templateDigest,
    preparationDigest: values[0].preparationDigest,
  }).toEqual({
    fullPreparations: "6da2519a86e5600e88837831fca3a2b88695476d1d38064037586a08329d3113",
    generationDigest: "247d1eb983f8cf935050fe28cd6e64ea2ca54d1f8d96f8542d8859553f4cdbcf",
    generationSha: "5285ca79a1f44504ffd0d6cb33e9626212a1768c3ed3a415f1410e26e36c5235",
    contractDigest: "8aea9dead3e03a323d5a60be7daaec73ad10c9ae5a504e86b86ae2e132212648",
    templateDigest: "6d351c579620cac0142ab749c0f64962e04116f698931e623242146cd9102941",
    preparationDigest: "23bb6d9362ae8f463dfff8a594c8b0e4eea1bf6aebde7fa390a8fdba2b6bc391",
  });
});

describe("provider request review without financial or execution authority", () => {
  it.each(Array.from({ length: 12 }, (_, index) => index))(
    "matches exact preparation request bytes for registered candidate %i without requiring a budget",
    (index) => {
      const { input, preparation } = requestFixture(index);
      const requestInput = {
        registry: input.registry,
        candidateId: input.candidateId,
        model: preparation.model,
        preparedAt: input.preparedAt,
      };
      const before = structuredClone(requestInput);
      const review = createProviderRequestReview(requestInput);
      expect(requestInput).toEqual(before);
      expect(Object.keys(review)).toEqual([
        "scope",
        "model",
        "contract",
        "generation",
        "reviewTemplate",
      ]);
      for (const key of Object.keys(review) as (keyof typeof review)[])
        expect(JSON.stringify(review[key])).toBe(JSON.stringify(preparation[key]));
      expect(review.generation.body.model).toBe(requestInput.model);
      expect(review.generation.sha256).toBe(
        providerRawDigest(JSON.stringify(review.generation.body)),
      );
      expect(review.generation.requestDigest).toBe(providerWireDigest(review.generation.body));
      expect(review.generation.requestDigest).not.toBe(review.generation.sha256);
      expect(review.reviewTemplate).toMatchObject({
        complete: false,
        draftSlot: {
          rule: "this-run-validated-generation-only",
          requiresValidatedEventBinding: true,
        },
      });
      expect(review.reviewTemplate).not.toHaveProperty("body");
      expect(review.reviewTemplate).not.toHaveProperty("requestDigest");
    },
  );

  it("assembles only registered model input and never grants financial or execution capability", () => {
    const registry = actualTestRegistry();
    const review = createProviderRequestReview({
      registry,
      candidateId: registry.entries[0].candidateId,
      model: "synthetic-provider-model",
      preparedAt: actualTestNow,
    });
    const input = JSON.parse(review.generation.body.input[1].content);
    expect(input.selectedCandidate.id).toBe(registry.entries[0].input.candidate.id);
    expect(input).not.toHaveProperty("reviewerMetadata");
    expect(input).not.toHaveProperty("authoringNotes");
    for (const key of [
      "budget",
      "financialBasis",
      "environment",
      "approval",
      "run",
      "manifest",
      "permissions",
    ])
      expect(review).not.toHaveProperty(key);
    expect(review.contract).toMatchObject({ maxCalls: 2, maxRetries: 0 });
    expect(review.generation.body).toMatchObject({ store: false, truncation: "disabled" });
    const before = structuredClone(registry);
    review.generation.body.input[1].content = "changed after return";
    review.reviewTemplate.fixedUserContext.selectedCandidate = {};
    expect(registry).toEqual(before);
  });

  it.each([undefined, null, "", " ", " model", "model ", "model/name", "모델", "m".repeat(201)])(
    "rejects missing or non-exact model %s without inferring a default",
    (model) => {
      const registry = actualTestRegistry();
      expect(() =>
        createProviderRequestReview({
          registry,
          candidateId: registry.entries[0].candidateId,
          model: model as string,
          preparedAt: actualTestNow,
        }),
      ).toThrow();
    },
  );

  it.each([undefined, null, "", "today", "2026-09-27", "2026-02-30T00:00:00.000Z"])(
    "rejects a missing or invalid preparation timestamp %s",
    (preparedAt) => {
      const registry = actualTestRegistry();
      expect(() =>
        createProviderRequestReview({
          registry,
          candidateId: registry.entries[0].candidateId,
          model: "synthetic-provider-model",
          preparedAt: preparedAt as string,
        }),
      ).toThrow();
    },
  );

  it.each([undefined, "", "absent-candidate"])("rejects missing candidate %s", (candidateId) => {
    expect(() =>
      createProviderRequestReview({
        registry: actualTestRegistry(),
        candidateId: candidateId as string,
        model: "synthetic-provider-model",
        preparedAt: actualTestNow,
      }),
    ).toThrow();
  });

  it.each(["source", "manifest", "version"])("rejects changed registered %s binding", (kind) => {
    const registry = actualTestRegistry();
    if (kind === "source") registry.entries[0].input.sources[0].text += " changed";
    if (kind === "manifest") registry.manifest[0].sourceDigest = "f".repeat(64);
    if (kind === "version") registry.versionDigest = "f".repeat(64);
    expect(() =>
      createProviderRequestReview({
        registry,
        candidateId: registry.entries[0].candidateId,
        model: "synthetic-provider-model",
        preparedAt: actualTestNow,
      }),
    ).toThrow();
  });

  it.each(["tokens", "time", "scope"])("preserves preparation financial guard %s", (kind) => {
    const { input } = requestFixture();
    if (kind === "tokens") input.financialInput.outputReservationTokens = 1000;
    if (kind === "time") input.preparedAt = "2026-09-27T04:00:00.000Z";
    if (kind === "scope") input.budget.scopeId = providerBudgetScope("production");
    expect(() => createProviderPreparation(input)).toThrow("Provider financial scope invalid");
  });
});

describe("provider v2 reservation-only contract", () => {
  it("only permits a second reservation for the same candidate after the prior cancellation in ledger order", () => {
    const allowed = fixture();
    cancel(allowed);
    expect(inspectProviderLedger(appendSameCandidate(allowed)()).snapshots).toHaveLength(2);
    const pending = fixture(),
      all = appendSameCandidate(pending);
    expect(() => inspectProviderLedger(all())).toThrow();
    cancel(pending);
    expect(() => inspectProviderLedger(all())).toThrow();
  });
  it("rejects a rehashed release whose event nonce differs from its cancellation receipt", () => {
    const f = fixture();
    cancel(f);
    const old = f.data.budgetEvents.at(-1)!;
    f.data.budgetEvents[2] = createProviderBudgetEvent({
      ...eventInput(old),
      eventId: randomUUID(),
    });
    const e = f.data.events[0];
    if (e.payload.kind !== "cancelled-before-dispatch") throw new Error("Invalid fixture");
    f.data.events[0] = createProviderRunEvent({
      ...eventInput(e),
      payload: { ...e.payload, releaseBudgetEventDigest: f.data.budgetEvents[2].eventDigest },
    });
    f.data.receipts[1].operationDigest = f.data.events[0].eventDigest;
    expect(
      validateProviderBudgetLedger(f.data.budgetEvents, f.preparation.budget.scopeId).heldUnits,
    ).toBe("0");
    expect(() => inspectProviderLedger(f.all())).toThrow();
  });
  it("builds separate exact v2 request bytes without authority or dispatch permission", () => {
    const f = fixture(),
      p = f.preparation;
    expect(validateNewProviderPreparation(p, f.registry, actualTestNow)).toEqual(p);
    expect(p.generation.body).toMatchObject({
      store: false,
      truncation: "disabled",
      service_tier: "default",
      background: false,
      stream: false,
      max_output_tokens: 16000,
    });
    expect(p.reviewTemplate).toMatchObject({
      schemaVersion: 2,
      complete: false,
      draftSlot: { rule: "this-run-validated-generation-only" },
    });
    expect(p.financialBasis.costs!.totalUnits).toBe("4");
    expect(p.permissions).toEqual({
      dispatchAllowed: false,
      tokenFitVerified: false,
      accountAccessVerified: false,
    });
    expect(p.generation.sha256).toBe(providerRawDigest(JSON.stringify(p.generation.body)));
    expect(p.contract.contractDigest).not.toBe(p.contract.baseContract.contractDigest);
  });
  it("preserves source input and does not place registry reviewer metadata into provider body", () => {
    const f = fixture();
    const input = JSON.parse(f.preparation.generation.body.input[1].content);
    expect(input.profile).not.toHaveProperty("businessNumber");
    expect(input.selectedCandidate.id).toBe(f.registry.entries[0].input.candidate.id);
    expect(input).not.toHaveProperty("reviewerNotes");
  });
  it("validates complete immutable start ledger, raw bytes, scope and all false transport flags", () => {
    const f = fixture(),
      snapshot = validateProviderRunLedger(f.data),
      full = inspectProviderLedger(f.all());
    expect(snapshot).toMatchObject({
      state: "reserved",
      revision: 0,
      dispatchAllowed: false,
      canResume: false,
      actualAiCalls: 0,
    });
    expect(snapshot.run).toMatchObject({
      observedTransport: "none",
      executionKind: "provider-contract-simulation",
    });
    expect(full.budgets.find((v) => v.environment === "synthetic-test")!.heldUnits).toBe("4");
    expect(full.reservedBytes + snapshot.storage.usedBytes).toBe(33554432);
  });
  it("cancels without any dispatch and releases exact financial and storage reservations", () => {
    const f = fixture();
    cancel(f);
    const result = inspectProviderLedger(f.all());
    expect(result.snapshots[0]).toMatchObject({
      state: "cancelled-before-dispatch",
      revision: 1,
      storage: { heldBytes: 0 },
      actualAiCalls: 0,
    });
    expect(result.budgets[0].heldUnits).toBe("0");
    expect(result.reservedBytes).toBe(0);
  });
  it("keeps historical reservation snapshot bytes fixed after cancellation when replaying its exact prefix", () => {
    const f = fixture(),
      before = JSON.stringify(validateProviderRunLedger(f.data));
    cancel(f);
    const historical = {
      ...f.data,
      events: [],
      receipts: f.data.receipts.slice(0, 1),
      budgetEvents: f.data.budgetEvents.slice(0, 2),
    };
    expect(JSON.stringify(validateProviderRunLedger(historical))).toBe(before);
  });
  it("rejects expired new writes while historical preparation remains readable", () => {
    const f = fixture();
    expect(() =>
      validateNewProviderPreparation(f.preparation, f.registry, providerTestExpires),
    ).toThrow();
    expect(validateProviderPreparation(f.preparation, f.registry)).toEqual(f.preparation);
  });
  it("keeps a coherent archived engine contract readable but rejects it as a new current-engine preparation", () => {
    const f = fixture(),
      p = structuredClone(f.preparation);
    for (const message of [p.generation.body.input[0], p.reviewTemplate.systemMessage])
      message.content = "Archived prompt version\n" + message.content;
    const content = p.generation.body.input[0].content,
      system = content.slice(0, content.lastIndexOf("\n\n"));
    p.contract.baseContract.phases.forEach((v) => (v.systemDigest = providerWireDigest(system)));
    p.contract.baseContract.contractDigest = providerWireDigest(
      without(p.contract.baseContract, "contractDigest"),
    );
    p.contract.contractDigest = providerWireDigest(without(p.contract, "contractDigest"));
    p.reviewTemplate.contractDigest = p.contract.contractDigest;
    rehash(p);
    expect(validateProviderPreparation(p, f.registry)).toEqual(p);
    expect(() => validateNewProviderPreparation(p, f.registry, actualTestNow)).toThrow();
  });
  it.each(["source", "classification", "model", "prompt", "review", "cost", "retention", "scope"])(
    "rejects rehashed %s changes against pinned preparation evidence",
    (kind) => {
      const f = fixture(),
        p = structuredClone(f.preparation);
      if (kind === "source" || kind === "classification") {
        const content = JSON.parse(p.generation.body.input[1].content);
        if (kind === "source") content.sources[0].text += "fabricated";
        else content.selectedCandidate.classification = "future-proposal";
        p.generation.body.input[1].content = JSON.stringify(content);
      }
      if (kind === "model") p.generation.body.model = "different-model";
      if (kind === "prompt") p.generation.body.input[0].content += "changed";
      if (kind === "review") p.reviewTemplate.fixedUserContext.selectedCandidate = {};
      if (kind === "cost") p.financialBasis.costs!.generation.totalUnits = "1";
      if (kind === "retention") p.retention.validUntil = actualTestNow;
      if (kind === "scope") p.budget.scopeId = providerBudgetScope("production");
      expect(() => validateProviderPreparation(rehash(p), f.registry)).toThrow();
    },
  );
  it.each(["body", "approval", "nonce", "operation", "budget", "scope", "run"])(
    "rejects %s ledger tampering",
    (kind) => {
      const f = fixture();
      if (kind === "body")
        f.data.artifacts[0] = createProviderArtifact({
          runId: f.data.run.id,
          body: f.data.artifacts[0].body + " ",
        });
      if (kind === "approval") f.data.run.approval.provenance = "explicit-user";
      if (kind === "nonce") f.data.receipts[0].clientRequestId = randomUUID();
      if (kind === "operation") f.data.receipts[0].operationDigest = "e".repeat(64);
      if (kind === "budget") f.data.receipts[0].budgetRevision = 1;
      if (kind === "scope") f.data.receipts[0].scopeId = providerBudgetScope("production");
      if (kind === "run") f.data.receipts[0].runId = randomUUID();
      expect(() => inspectProviderLedger(f.all())).toThrow();
    },
  );
  it("rejects shared nonce collision and orphan rows", () => {
    const f = fixture();
    expect(() =>
      inspectProviderLedger({ ...f.all(), otherNonces: [f.start.clientRequestId] }),
    ).toThrow();
    expect(() =>
      inspectProviderLedger({
        ...f.all(),
        artifacts: [
          ...f.data.artifacts,
          createProviderArtifact({ runId: randomUUID(), body: "{}" }),
        ],
      }),
    ).toThrow();
  });
  it("rejects synthetic rows masquerading as production and current unsupported dispatch events", () => {
    const f = fixture();
    expect(providerStartSchema.safeParse({ ...f.start, environment: "production" }).success).toBe(
      false,
    );
    expect(
      providerRunEventSchema.safeParse({
        schemaVersion: 2,
        runId: f.data.run.id,
        revision: 1,
        budgetRevision: 2,
        previousEventDigest: null,
        recordedAt: actualTestNow,
        payload: { kind: "dispatch" },
        eventDigest: "a".repeat(64),
      }).success,
    ).toBe(false);
  });
  it("rejects a cross-scope reservation targeting a synthetic owner", () => {
    const f = fixture(),
      scopeId = providerBudgetScope("production"),
      nonce = randomUUID(),
      policy = {
        environment: "production",
        provenance: "explicit-user",
        currency: "TST",
        unitScale: 6,
        capUnits: "100",
      } as const;
    const configured = createProviderBudgetEvent({
      schemaVersion: 2,
      scopeId,
      environment: "production",
      provenance: "explicit-user",
      revision: 1,
      previousDigest: null,
      eventId: nonce,
      recordedAt: actualTestNow,
      currency: "TST",
      unitScale: 6,
      payload: { kind: "configure", capUnits: "100" },
    });
    const reserve = createProviderBudgetEvent({
      ...without(configured, "eventDigest"),
      schemaVersion: 2,
      scopeId,
      environment: "production",
      provenance: "explicit-user",
      currency: "TST",
      unitScale: 6,
      recordedAt: actualTestNow,
      revision: 2,
      previousDigest: configured.eventDigest,
      eventId: randomUUID(),
      payload: {
        kind: "reserve-run",
        runId: f.data.run.id,
        preparationDigest: f.preparation.preparationDigest,
        generationUnits: "2",
        reviewUnits: "2",
      },
    });
    const receipt: ProviderReceipt = {
      schemaVersion: 2,
      scopeId,
      kind: "provider-budget-configure",
      clientRequestId: nonce,
      inputDigest: providerDigest(
        providerPolicyDigestInput({ clientRequestId: nonce, expectedRevision: 0, policy }),
      ),
      runId: null,
      runRevision: null,
      budgetRevision: 1,
      operationDigest: configured.eventDigest,
      recordedAt: actualTestNow,
    };
    expect(validateProviderBudgetLedger([configured, reserve], scopeId).heldUnits).toBe("4");
    expect(() =>
      inspectProviderLedger({
        ...f.all(),
        budgetEvents: [...f.data.budgetEvents, configured, reserve],
        receipts: [...f.all().receipts, receipt],
      }),
    ).toThrow();
  });
});
