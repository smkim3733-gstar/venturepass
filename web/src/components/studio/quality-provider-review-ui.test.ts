import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("External access forbidden");
  }),
);
vi.mock("openai", () => ({
  default: class {
    constructor() {
      forbidden();
    }
  },
}));
vi.mock("@/lib/studio-storage", () => ({ getStudioStore: forbidden }));
import { PlanQualityStore } from "@/lib/studio-plan-quality-store";
import { actualTestNow, actualTestPlan } from "@/lib/studio-plan-quality-actual-test-helpers";
import {
  providerTestConfigure,
  providerTestStartInput,
} from "@/lib/studio-plan-quality-provider-test-helpers";
import {
  providerExecutionTestApproval,
  providerExecutionTestResponse,
} from "@/lib/studio-plan-quality-provider-execution-test-helpers";
import { runQualityProviderSimulation } from "@/lib/studio-plan-quality-provider-runner";
import {
  providerLedgerNotice,
  providerReviewBlockerCodes,
  providerReviewBlockerMessages,
  providerReviewNotice,
  providerExpiredBlockerCodes,
  providerExpiredBlockerMessages,
  type ProviderReviewExpiredView,
  type ProviderReviewView,
} from "@/lib/studio-plan-quality-provider-review-types";
import type { CandidateRegistrySnapshot } from "@/lib/studio-plan-quality-candidate-registry-types";
import type { ProviderSnapshot } from "@/lib/studio-plan-quality-provider-types";
import { candidateRegistryDigest as digest } from "./quality-candidate-registry-ui";
import {
  qualityProviderReview,
  qualityProviderReviewArchive,
  qualityProviderSnapshot,
  qualityProviderOverview,
  qualityProviderArchive,
  qualityProviderArtifact,
  qualityProviderLookup,
  qualityProviderStateSummary,
} from "./quality-provider-review-ui";

let directory: string, store: PlanQualityStore, registry: CandidateRegistrySnapshot;
let view: ProviderReviewView;
const snapshots: Record<string, ProviderSnapshot> = {},
  archives: Record<string, string> = {};
const clone = <T>(v: T): T => structuredClone(v);
const candidate = (s: ProviderSnapshot) => s.run.preparation.scope.candidateId;
const expected = (s: ProviderSnapshot) => ({
  id: s.run.id,
  candidateId: candidate(s),
  revision: s.revision,
  snapshotDigest: s.snapshotDigest,
});
async function rehash<T extends object>(v: T, key: string) {
  const body = Object.fromEntries(Object.entries(v).filter(([k]) => k !== key));
  (v as Record<string, unknown>)[key] = await digest(body);
  return v;
}
const inspect = (s: ProviderSnapshot) =>
  qualityProviderSnapshot(s, registry, { id: s.run.id, candidateId: candidate(s) });
beforeAll(async () => {
  vi.stubGlobal("fetch", forbidden);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(actualTestNow));
  directory = mkdtempSync(join(tmpdir(), "venturepass-provider-browser-"));
  store = new PlanQualityStore(directory, {
    actualEnvironment: "synthetic-test",
    providerEnvironment: "synthetic-test",
  });
  registry = store.candidateRegistryRegister({
    clientRequestId: randomUUID(),
    expectedVersion: 0,
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  }).snapshot;
  providerTestConfigure(store);
  for (const [index, name] of [
    "reserved",
    "completed",
    "unknown",
    "interrupted",
    "late",
    "late-unknown",
    "cancelled",
  ].entries()) {
    vi.setSystemTime(new Date(actualTestNow));
    const start = store.providerStart(providerTestStartInput(store, index)),
      id = start.snapshot.run.id;
    if (name === "reserved") {
      snapshots[name] = start.snapshot;
      archives[name] = store.providerDownload(id, 0).body;
      continue;
    }
    if (name === "cancelled") {
      snapshots[name] = store.providerCancel(id, {
        clientRequestId: randomUUID(),
        expectedRevision: 0,
        reason: "test-cleanup",
      }).snapshot;
      archives[name] = store.providerDownload(id, 1).body;
      continue;
    }
    if (name === "completed") archives["completed-r0"] = store.providerDownload(id, 0).body;
    const approval = providerExecutionTestApproval(store, id);
    const result = await runQualityProviderSimulation(store, id, approval, {
      transport: {
        provenance: "synthetic-test",
        model: "synthetic-provider-model",
        contractDigest: approval.payload.manifest.executionContract.contractDigest,
        send: async ({ request }) => {
          const response = providerExecutionTestResponse(
            request.phase === "generation" ? actualTestPlan(registry, index) : { findings: [] },
          );
          if (name === "unknown" || name === "late-unknown")
            delete (response as { usage?: unknown }).usage;
          if (name === "interrupted") vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z"));
          if (name.startsWith("late"))
            store.providerRecordFinish(id, {
              clientRequestId: randomUUID(),
              expectedRevision: store.providerGet(id).revision,
              payload: {
                kind: "execution-stopped",
                outcome: "result-unobserved",
                failureCode: "INTERRUPTED",
                finalArtifactSha256: null,
              },
            });
          return response;
        },
      },
    });
    snapshots[name] = result.snapshot;
    archives[name] = store.providerDownload(id, result.snapshot.revision).body;
  }
  vi.setSystemTime(new Date(actualTestNow));
  const m = registry.manifest[0];
  view = {
    viewVersion: 1,
    providerContractVersion: 2,
    state: "configuration-missing",
    environment: "production",
    inputProvenance: "registered-synthetic-candidate",
    scope: {
      version: registry.version,
      versionDigest: registry.versionDigest,
      candidateId: m.candidateId,
      setId: registry.setId,
      registrySourceDigest: registry.sourceDigest,
      manifestDigest: registry.manifestDigest,
      label: m.label,
      sourceDigest: m.sourceDigest,
      candidateDigest: m.candidateDigest,
      modelInputDigest: m.modelInputDigest,
    },
    inspectedAt: actualTestNow,
    model: null,
    financialBasis: null,
    budget: null,
    retention: null,
    preparation: null,
    transmissionManifest: null,
    accountAccess: "not-checked",
    actualExecutionEnabled: false,
    maxCalls: 2,
    maxRetries: 0,
    automaticRepair: false,
    blockers: providerReviewBlockerCodes.map((code) => ({
      code,
      message: providerReviewBlockerMessages[code],
    })),
    notice: providerReviewNotice,
    viewDigest: "",
  };
  await rehash(view, "viewDigest");
}, 120000);
afterAll(() => {
  expect(forbidden).not.toHaveBeenCalled();
  store?.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  const rel = relative(resolve(tmpdir()), resolve(directory));
  if (!rel.startsWith("venturepass-provider-browser-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});

describe("provider read-only browser bindings", () => {
  const expiredView = () =>
    rehash(
      {
        ...clone(view),
        viewVersion: 3 as const,
        state: "configuration-expired" as const,
        inspectedAt: "2030-01-01T00:00:00.000Z",
        expiry: { configurationDigest: "a".repeat(64), validUntil: "2026-09-27T23:57:59.000Z" },
        blockers: providerExpiredBlockerCodes.map((code) => ({
          code,
          message: providerExpiredBlockerMessages[code],
        })),
      } as ProviderReviewExpiredView,
      "viewDigest",
    );
  it("binds expired diagnostics to the selected registry and preserves the exact diagnostic download", async () => {
    const expired = await expiredView();
    expect(await qualityProviderReview(expired, registry, registry.entries[0].candidateId)).toEqual(
      expired,
    );
    const archive = await qualityProviderReviewArchive(
      expired,
      registry,
      registry.entries[0].candidateId,
    );
    expect(JSON.parse(archive.text)).toEqual(expired);
    expect(archive.filename).toContain(expired.viewDigest.slice(0, 12));
    await expect(
      qualityProviderReview(expired, registry, registry.entries[1].candidateId),
    ).rejects.toThrow();
  });
  it.each(["future", "model", "permission", "blocker", "digest", "extra"])(
    "rejects forged expired diagnostic %s",
    async (mode) => {
      const expired = await expiredView();
      if (mode === "future") expired.expiry.validUntil = "2031-01-01T00:00:00.000Z";
      if (mode === "model") Object.assign(expired, { model: "old-model" });
      if (mode === "permission") Object.assign(expired, { actualExecutionEnabled: true });
      if (mode === "blocker") expired.blockers[0].message = "운영 가능";
      if (mode === "extra") Object.assign(expired.expiry, { capUnits: "15000000" });
      if (mode !== "digest") await rehash(expired, "viewDigest");
      else expired.expiry.configurationDigest = "b".repeat(64);
      await expect(
        qualityProviderReview(expired, registry, registry.entries[0].candidateId),
      ).rejects.toThrow();
    },
  );
  it("validates configuration-missing with exact registry and preserves inspected time in view download", async () => {
    expect(await qualityProviderReview(view, registry, registry.entries[0].candidateId)).toEqual(
      view,
    );
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const a = await qualityProviderReviewArchive(view, registry, registry.entries[0].candidateId);
    expect(JSON.parse(a.text)).toEqual(view);
    expect(a.text.endsWith("\n")).toBe(true);
    expect(a.filename).toContain(view.viewDigest.slice(0, 12));
  });
  it.each(["candidate", "source", "model", "permission", "blocker", "sha"])(
    "rejects forged review %s",
    async (mode) => {
      const v = clone(view);
      if (mode === "candidate") v.scope.candidateId = registry.entries[1].candidateId;
      if (mode === "source") v.scope.sourceDigest = "a".repeat(64);
      if (mode === "model") Object.assign(v, { model: "configured" });
      if (mode === "permission") Object.assign(v, { actualExecutionEnabled: true });
      if (mode === "blocker") v.blockers[0].message = "연결됨";
      if (mode !== "sha") await rehash(v, "viewDigest");
      else v.viewDigest = "a".repeat(64);
      await expect(
        qualityProviderReview(v, registry, registry.entries[0].candidateId),
      ).rejects.toThrow();
    },
  );
  it.each(["reserved", "completed", "unknown", "interrupted", "late", "late-unknown", "cancelled"])(
    "accepts real synthetic store %s and original archive bytes",
    async (name) => {
      const s = snapshots[name],
        before = JSON.stringify(s);
      expect(await inspect(s)).toEqual(s);
      expect((await qualityProviderArchive(archives[name], s)).text).toBe(archives[name]);
      expect(JSON.stringify(s)).toBe(before);
    },
  );
  it("accepts past revision zero after completion and refuses later artifacts against old prefix", async () => {
    const s = store.providerGet(snapshots.completed.run.id, 0);
    expect((await qualityProviderArchive(archives["completed-r0"], s)).text).toBe(
      archives["completed-r0"],
    );
    const body = store.providerArtifact(s.run.id, "generation-response").body.toString();
    await expect(qualityProviderArtifact(body, s, "generation-response")).rejects.toThrow();
    await expect(qualityProviderArchive(archives.completed, s)).rejects.toThrow();
  });
  it("checks the original export byte SHA without reserializing its whitespace", async () => {
    const s = snapshots.completed,
      text = archives.completed;
    const sha = createHash("sha256").update(text).digest("hex");
    expect((await qualityProviderArchive(text, s, sha)).text).toBe(text);
    await expect(qualityProviderArchive(text + " ", s, sha)).rejects.toThrow();
    await expect(qualityProviderArchive(text, s, "0".repeat(64))).rejects.toThrow();
    const originalSpacing = JSON.stringify(JSON.parse(text), null, 2) + "\n";
    expect(
      (
        await qualityProviderArchive(
          originalSpacing,
          s,
          createHash("sha256").update(originalSpacing).digest("hex"),
        )
      ).text,
    ).toBe(originalSpacing);
  });
  it.each(["id", "candidate", "revision", "digest"])(
    "rejects exact selection mismatch %s",
    async (field) => {
      const s = snapshots.completed,
        e = expected(s);
      if (field === "id") e.id = randomUUID();
      if (field === "candidate") e.candidateId = registry.entries[0].candidateId;
      if (field === "revision") e.revision--;
      if (field === "digest") e.snapshotDigest = "0".repeat(64);
      await expect(qualityProviderSnapshot(s, registry, e)).rejects.toThrow();
    },
  );
  it.each([
    "run",
    "budget-chain",
    "event-chain",
    "state",
    "calls",
    "artifacts",
    "foreign-environment",
  ])("rejects rehashed snapshot %s", async (kind) => {
    const s = clone(snapshots.completed);
    if (kind === "run") s.run.runDigest = "a".repeat(64);
    if (kind === "budget-chain") s.budgetEvents[1].previousDigest = "a".repeat(64);
    if (kind === "event-chain") s.events[1].previousEventDigest = "a".repeat(64);
    if (kind === "state") s.state = "reserved";
    if (kind === "calls") Object.assign(s, { actualAiCalls: null });
    if (kind === "artifacts") s.artifacts[1].sha256 = "a".repeat(64);
    if (kind === "foreign-environment") s.run.environment = "production";
    await rehash(s, "snapshotDigest");
    await expect(inspect(s)).rejects.toThrow();
  });
  it("filters overview only after all executions are validated and preserves separate budgets", async () => {
    const raw = {
      schemaVersion: 2,
      kind: "provider-ledger-overview",
      notice: providerLedgerNotice,
      actualExecutionEnabled: false,
      budgets: { production: null, synthetic: store.providerBudgetGet() },
      executions: store.providerList().executions,
    };
    const result = await qualityProviderOverview(raw, registry, candidate(snapshots.completed));
    expect(result.executions.map((s) => s.run.id)).toEqual([snapshots.completed.run.id]);
    expect(result.budgets.production).toBeNull();
    const bad = clone(raw);
    bad.executions[0].snapshotDigest = "a".repeat(64);
    await expect(
      qualityProviderOverview(bad, registry, candidate(snapshots.completed)),
    ).rejects.toThrow();
  });
  it.each([
    "receipt-nonce",
    "receipt-prefix",
    "receipt-input",
    "artifact-body",
    "future-event",
    "duplicate-key",
  ])("rejects archive %s", async (mode) => {
    const s = snapshots.completed,
      a = JSON.parse(archives.completed);
    if (mode === "receipt-nonce") a.receipts[1].clientRequestId = randomUUID();
    if (mode === "receipt-prefix") a.receipts.pop();
    if (mode === "receipt-input") a.receipts[1].inputDigest = "a".repeat(64);
    if (mode === "artifact-body") a.artifacts[0].payload = Buffer.from("{}").toString("base64");
    if (mode === "future-event") a.events.push(a.events.at(-1));
    if (mode === "duplicate-key") a.artifacts[1] = a.artifacts[0];
    await expect(qualityProviderArchive(JSON.stringify(a), s)).rejects.toThrow();
  });
  it("returns exact artifact text and rejects byte changes, wrong header or unknown key", async () => {
    const s = snapshots.completed,
      ref = s.artifacts.find((a) => a.key === "generation-request")!,
      text = store.providerArtifact(s.run.id).body.toString();
    expect((await qualityProviderArtifact(text, s, ref.key, ref.sha256)).text).toBe(text);
    await expect(qualityProviderArtifact(text + "\n", s, ref.key)).rejects.toThrow();
    await expect(qualityProviderArtifact(text, s, ref.key, "a".repeat(64))).rejects.toThrow();
  });
  it("requires exact nonce, operation and durable snapshot prefix for committed lookup", async () => {
    const s = snapshots.completed,
      raw = store.providerLookup(s.run.clientRequestId);
    if (raw.state !== "committed") throw new Error("fixture");
    const e = {
      clientRequestId: raw.receipt.clientRequestId,
      inputDigest: raw.receipt.inputDigest,
      runId: s.run.id,
      kind: raw.receipt.kind,
    };
    expect(await qualityProviderLookup(raw, e, s)).toEqual(raw);
    await expect(
      qualityProviderLookup(raw, { ...e, clientRequestId: randomUUID() }, s),
    ).rejects.toThrow();
    await expect(qualityProviderLookup(raw, e)).rejects.toThrow();
    expect(await qualityProviderLookup({ state: "not-observed" }, e)).toEqual({
      state: "not-observed",
    });
  });
  it("labels interrupted validation without claiming malformed draft, and keeps late response stopped", () => {
    expect(qualityProviderStateSummary(snapshots.interrupted).label).toContain("원고 검증 중단");
    expect(qualityProviderStateSummary(snapshots.interrupted).detail).toContain(
      "잘못됐다는 뜻은 아닙니다",
    );
    expect(qualityProviderStateSummary(snapshots.late).label).toContain(
      "늦은 응답 보관 · 비용 확인",
    );
    expect(qualityProviderStateSummary(snapshots["late-unknown"]).label).toContain(
      "비용 확인 필요",
    );
    expect(qualityProviderStateSummary(snapshots.late).detail).toContain("완료로 바꾸지 않습니다");
    expect(qualityProviderStateSummary(snapshots.unknown).costLabel).toMatch(/미정산 예약 [1-9]/);
    expect(qualityProviderStateSummary(snapshots.completed).costLabel).toContain(
      "확인된 사용량 비용 4 · 미정산 예약 0",
    );
  });
});
