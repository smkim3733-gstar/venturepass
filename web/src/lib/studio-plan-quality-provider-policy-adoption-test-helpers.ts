/** Synthetic approval fixtures only. No application route imports this module. */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { PlanQualityStore } from "./studio-plan-quality-store";
import { getProviderConfigurationProposal } from "./studio-plan-quality-provider-configuration";
import { createProviderPolicyReview } from "./studio-plan-quality-provider-policy-review";
import { providerPolicyAdoptionCommandSchema } from "./studio-plan-quality-provider-policy-adoption-command";
import {
  createProviderBudgetEvent,
  createProviderReceipt,
  providerDigest as digest,
  providerPolicyDigestInput,
} from "../../scripts/local-data-quality-provider.mjs";

export function policyAdoptionFixture(store: PlanQualityStore, candidateIndex = 0) {
  const context = store.providerReviewContext(1);
  const candidateId = context.registry.entries[candidateIndex].candidateId;
  const value = createProviderPolicyReview({
    ...context,
    candidateId,
    configuration: getProviderConfigurationProposal(),
  });
  if (value.status !== "review") throw new Error(value.reason);
  const review = value.review;
  const command = providerPolicyAdoptionCommandSchema.parse({
    commandVersion: 1,
    kind: "adopt-provider-policy",
    clientRequestId: randomUUID(),
    version: 1,
    versionDigest: context.registry.versionDigest,
    candidateId,
    expectedPolicyHead: store.providerPolicyHead(),
    approvedReviewDigest: review.reviewDigest,
    budgetAction: review.budget.revision ? "keep-existing-budget" : "initialize-proposed-budget",
    initialBudgetRequestId: review.budget.revision ? null : randomUUID(),
    approval: {
      noticeVersion: 1,
      acknowledgedPolicy: true,
      acknowledgedBudgetAction: true,
      reservationAndTransmission: "separate-approval-required",
      approvedAt: new Date().toISOString(),
    },
  });
  return { command, review };
}

export function seedPolicyTestBudget(db: DatabaseSync, capUnits = "1000000", currency = "USD") {
  const clientRequestId = randomUUID();
  const policy = {
    environment: "production" as const,
    provenance: "explicit-user" as const,
    currency,
    unitScale: 6,
    capUnits,
  };
  const event = createProviderBudgetEvent({
    schemaVersion: 2,
    scopeId: "candidate-quality-provider-v2-live",
    environment: policy.environment,
    provenance: policy.provenance,
    currency,
    unitScale: policy.unitScale,
    revision: 1,
    previousDigest: null,
    eventId: clientRequestId,
    recordedAt: new Date().toISOString(),
    payload: { kind: "configure", capUnits },
  });
  const receipt = createProviderReceipt({
    schemaVersion: 2,
    scopeId: event.scopeId,
    kind: "provider-budget-configure",
    clientRequestId,
    inputDigest: digest(
      providerPolicyDigestInput({ clientRequestId, expectedRevision: 0, policy }),
    ),
    runId: null,
    runRevision: null,
    budgetRevision: 1,
    operationDigest: event.eventDigest,
    recordedAt: event.recordedAt,
  });
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO quality_actual_budget_events VALUES(?,?,?,?)").run(
      event.scopeId,
      1,
      JSON.stringify(event),
      digest(event),
    );
    db.prepare("INSERT INTO quality_actual_requests VALUES(?,?,?)").run(
      clientRequestId,
      JSON.stringify(receipt),
      digest(receipt),
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { event, receipt };
}
