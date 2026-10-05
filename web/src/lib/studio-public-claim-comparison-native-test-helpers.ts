import { randomUUID, createHash } from "node:crypto";
import { publicClaimComparisonFixture } from "./studio-public-claim-comparison-test-helpers";
import {
  preparePublicClaimComparison,
  validatePreparedPublicClaimComparison,
} from "./studio-public-claim-comparison";
import { buildPublicClaimComparisonRequest } from "./studio-public-claim-comparison-request";
import { captureProviderResponse } from "../../scripts/local-data-quality-provider-usage.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { publicClaimComparisonRequestAuthority } from "./studio-public-claim-comparison-request-types";
import {
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
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export type ComparisonTestArchive = {
  records: PublicComparisonNativeRecords;
  financial: Omit<PublicComparisonBudgetSuffix, "evidence">;
};
export function publicComparisonNativeFixture(
  prefix: PublicComparisonPrefix,
  coverage: PublicComparisonCoverage,
  base?: ComparisonTestArchive,
) {
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
  const a: ComparisonTestArchive = base ?? {
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
