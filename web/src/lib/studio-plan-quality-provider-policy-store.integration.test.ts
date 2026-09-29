import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import {
  providerTestConfigure,
  providerTestStartInput,
} from "./studio-plan-quality-provider-test-helpers";
import { createProviderPolicyReview } from "./studio-plan-quality-provider-policy-review";
import { getProviderConfigurationProposal } from "./studio-plan-quality-provider-configuration";
import {
  createProviderBudgetEvent,
  createProviderReceipt,
  providerDigest as digest,
  providerPolicyDigestInput,
} from "../../scripts/local-data-quality-provider.mjs";
import { qualityImmutableTriggerSql } from "../../scripts/local-data-quality-schema.mjs";
import { qualityProviderReviewRoute } from "./studio-plan-quality-provider-review-service";
import { providerReviewResponseSchema } from "./studio-plan-quality-provider-policy-view-types";

vi.mock("server-only", () => ({}));
const service = vi.hoisted(() => ({ store: null as PlanQualityStore | null }));
vi.mock("./studio-plan-quality-store", async (original) => ({
  ...(await original<typeof import("./studio-plan-quality-store")>()),
  getPlanQualityStore: () => service.store!,
}));
let directory: string, store: PlanQualityStore, db: DatabaseSync;
const forbidden = vi.fn(() => {
  throw new Error("Unexpected external access");
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(actualTestNow));
  vi.stubGlobal("fetch", forbidden);
  directory = mkdtempSync(join(tmpdir(), "venturepass-policy-store-"));
  store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
  service.store = store;
  store.candidateRegistryRegister({
    expectedVersion: 0,
    clientRequestId: randomUUID(),
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  });
  providerTestConfigure(store);
  store.providerStart(providerTestStartInput(store));
  db = new DatabaseSync(join(directory, "quality-evaluation", "quality.sqlite"));
  db.function("quality_storage_contract", { deterministic: true }, () => "quality-v9");
});
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  db?.close();
  store?.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  const path = resolve(directory),
    rel = relative(resolve(tmpdir()), path);
  if (!rel.startsWith("venturepass-policy-store-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(path, { recursive: true, force: true });
});
function rows() {
  return digest(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'quality_%' ORDER BY name",
      )
      .all()
      .map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]),
  );
}
// Isolated temporary-database protocol fixture only: never records actual consent or payment.
function seedProduction(capUnits = "20000000") {
  const policy = {
    environment: "production" as const,
    provenance: "explicit-user" as const,
    currency: "USD",
    unitScale: 6,
    capUnits,
  };
  const clientRequestId = randomUUID();
  const stored = createProviderBudgetEvent({
    schemaVersion: 2,
    scopeId: "candidate-quality-provider-v2-live",
    environment: policy.environment,
    provenance: policy.provenance,
    currency: policy.currency,
    unitScale: policy.unitScale,
    revision: 1,
    previousDigest: null,
    eventId: clientRequestId,
    recordedAt: actualTestNow,
    payload: { kind: "configure", capUnits },
  });
  const receipt = createProviderReceipt({
    schemaVersion: 2,
    scopeId: stored.scopeId,
    kind: "provider-budget-configure",
    clientRequestId,
    inputDigest: digest(
      providerPolicyDigestInput({ clientRequestId, expectedRevision: 0, policy }),
    ),
    runId: null,
    runRevision: null,
    budgetRevision: 1,
    operationDigest: stored.eventDigest,
    recordedAt: actualTestNow,
  });
  db.prepare(
    "INSERT INTO quality_actual_budget_events(scope_id,revision,body,body_hash) VALUES(?,?,?,?)",
  ).run(stored.scopeId, stored.revision, JSON.stringify(stored), digest(stored));
  db.prepare("INSERT INTO quality_actual_requests(nonce,body,body_hash) VALUES(?,?,?)").run(
    clientRequestId,
    JSON.stringify(receipt),
    digest(receipt),
  );
  return { event: stored, receipt };
}
function review() {
  const context = store.providerReviewContext(1);
  return createProviderPolicyReview({
    ...context,
    candidateId: context.registry.entries[0].candidateId,
    configuration: getProviderConfigurationProposal(),
  });
}
function request() {
  const registry = store.candidateRegistryGet(1);
  return new Request("http://127.0.0.1:3000/api/studio/quality/provider-review/inspect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      version: registry.version,
      versionDigest: registry.versionDigest,
      candidateId: registry.entries[0].candidateId,
    }),
  });
}
function corruptFixture(trigger: string, work: () => void) {
  // Deliberately damage only this test's temporary database, then restore the exact schema.
  const sql = qualityImmutableTriggerSql[trigger];
  if (!sql) throw new Error("Unknown trigger");
  db.exec(`DROP TRIGGER ${trigger}`);
  try {
    work();
  } finally {
    db.exec(sql);
  }
}
describe("policy review transaction and full-store trust boundary", () => {
  it("returns the configured production budget through the route without adopting the new proposal", async () => {
    seedProduction();
    const before = rows(),
      response = await qualityProviderReviewRoute(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const value = providerReviewResponseSchema.parse(await response.json());
    if (value.viewVersion !== 4) throw new Error("Expected v4");
    expect(value.policyReview.budget.capUnits).toBe("20000000");
    expect(value.policyReview.proposedBudget.capUnits).toBe("15000000");
    expect(value.blockers.map((item) => item.code)).not.toContain("BUDGET_NOT_CONFIGURED");
    expect(Object.values(value.policyReview.actions)).toEqual([false, false, false, false]);
    expect(rows()).toBe(before);
  });
  it("returns no financial view when complete-store inspection fails", async () => {
    const { receipt } = seedProduction();
    const inspection = request();
    corruptFixture("quality_actual_requests_no_delete", () => {
      db.prepare("DELETE FROM quality_actual_requests WHERE nonce=?").run(receipt.clientRequestId);
    });
    const before = rows(),
      response = await qualityProviderReviewRoute(inspection);
    expect(response.status).toBe(409);
    const value = await response.json();
    expect(value.code).toBe("QUALITY_ACTUAL_STORAGE_CORRUPT");
    expect(value).not.toHaveProperty("policyReview");
    expect(value).not.toHaveProperty("financialBasis");
    expect(rows()).toBe(before);
  });
  it("ignores synthetic holds and reads the later production head without resetting any rows", () => {
    const before = rows();
    const empty = store.providerReviewContext(1);
    expect(empty.expectedBudgetHead).toEqual({ revision: 0, headDigest: null });
    expect(empty.budgetEvents).toEqual([]);
    expect(rows()).toBe(before);
    const { event } = seedProduction(),
      seeded = rows();
    for (let i = 0; i < 2; i++) {
      const result = review();
      expect(result.status).toBe("review");
      if (result.status !== "review") throw new Error("fixture");
      expect(result.review.budget).toMatchObject({
        revision: 1,
        headDigest: event.eventDigest,
        capUnits: "20000000",
        availableUnits: "20000000",
        heldUnits: "0",
      });
      expect(result.review.assessment.availableAfterReservationUnits).toBe("8780000");
      expect(rows()).toBe(seeded);
    }
    expect(store.providerBudgetGet().heldUnits).toBe("4");
  });
  it.each(["missing receipt", "resealed receipt", "artifact"])(
    "rejects %s although the production budget chain itself is valid",
    (kind) => {
      const { receipt } = seedProduction();
      if (kind === "missing receipt")
        corruptFixture("quality_actual_requests_no_delete", () => {
          db.prepare("DELETE FROM quality_actual_requests WHERE nonce=?").run(
            receipt.clientRequestId,
          );
        });
      else if (kind === "resealed receipt") {
        const invalid = createProviderReceipt({ ...receipt, operationDigest: "a".repeat(64) });
        corruptFixture("quality_actual_requests_no_update", () => {
          db.prepare("UPDATE quality_actual_requests SET body=?, body_hash=? WHERE nonce=?").run(
            JSON.stringify(invalid),
            digest(invalid),
            receipt.clientRequestId,
          );
        });
      } else
        corruptFixture("quality_actual_artifacts_no_update", () => {
          db.prepare("UPDATE quality_actual_artifacts SET payload=?").run(Buffer.from("{}"));
        });
      const before = rows();
      expect(() => store.providerReviewContext(1)).toThrow("비용 원장의 무결성");
      expect(rows()).toBe(before);
    },
  );
});
