import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import {
  runQualityActualSimulation,
  type QualityActualSimulationOptions,
} from "./studio-plan-quality-actual-runner";
import {
  actualTestNow,
  actualTestPlan,
  actualTestPreparation,
  actualTestResponse,
} from "./studio-plan-quality-actual-test-helpers";
import { planQualityEvaluationDigest as digest } from "./studio-plan-quality-evaluation";
import { sectionDefinitions, type ReviewFinding } from "./studio-schema";
import type {
  ActualLedgerArtifactRef,
  ActualLedgerSnapshot,
  ActualLedgerStart,
} from "./studio-plan-quality-actual-ledger-types";
import {
  backupQualityData,
  inspectQualityDatabase,
  restoreQualityData,
  verifyQualityBackup,
} from "../../scripts/local-data-quality.mjs";

vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Provider and company IO forbidden");
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

type Scenario = "completed" | "missing-usage" | "response-write-failed";
type Preserved = {
  scenario: Scenario;
  snapshot: ActualLedgerSnapshot;
  archive: string;
  artifacts: { ref: ActualLedgerArtifactRef; bytes: Buffer }[];
  sent: number;
};
const sentinel = "SYNTHETIC_C1_COMPANY_FILE_NOT_OPENED";
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const timeout = process.platform === "win32" ? 150000 : 30000;
let directory: string, source: string;
let preserved: Preserved[], prefix: string, candidateArchive: string;

function startInput(store: PlanQualityStore, candidateIndex: number): ActualLedgerStart {
  const budget = store.actualBudgetGet();
  const preparation = actualTestPreparation(store.candidateRegistryGet(1), {
    candidateIndex,
    ledgerDigest: budget.headDigest!,
    capUnits: (BigInt(budget.capUnits) - BigInt(budget.recognizedUsageUnits)).toString(),
    heldUnits: budget.heldUnits,
  });
  return {
    clientRequestId: randomUUID(),
    expectedActualRunCount: store.actualList().executions.length,
    expectedBudgetRevision: budget.revision,
    expectedBudgetDigest: budget.headDigest!,
    preparation,
    approval: {
      provenance: "synthetic-test",
      acknowledgedSyntheticOnly: true,
      approvedAt: actualTestNow,
      approvedPreparationDigest: preparation.preparationDigest,
    },
  };
}
function adapters(
  input: ActualLedgerStart,
  send: QualityActualSimulationOptions["transport"]["send"],
): QualityActualSimulationOptions {
  const prep = input.preparation,
    tokens = prep.evidence.tokens!;
  return {
    transport: {
      provenance: "synthetic-test",
      model: prep.model!,
      contractDigest: prep.engine.contractDigest,
      send,
    },
    tokenAdapter: {
      provenance: "synthetic-test",
      model: prep.model!,
      contractDigest: prep.engine.contractDigest,
      evidenceDigest: digest(tokens),
      tokenizerId: tokens.tokenizerId,
      tokenizerVersion: tokens.tokenizerVersion,
      measure: (request) => (request.request.phase === "generation" ? 10 : 20),
    },
  };
}
function inspect(root: string) {
  const db = new DatabaseSync(join(root, "quality-evaluation", "quality.sqlite"), {
    readOnly: true,
  });
  try {
    return inspectQualityDatabase(db);
  } finally {
    db.close();
  }
}
function expectPreserved(store: PlanQualityStore) {
  expect(store.candidateRegistryDownload(1).body).toBe(candidateArchive);
  for (const fixture of preserved) {
    const { snapshot } = fixture;
    expect(store.actualGet(snapshot.run.id)).toEqual(snapshot);
    expect(store.actualDownload(snapshot.run.id, snapshot.revision).body).toBe(fixture.archive);
    for (const { ref, bytes } of fixture.artifacts) {
      const actual = store.actualArtifact(snapshot.run.id, ref.key);
      expect(actual.body).toEqual(bytes);
      expect(hash(actual.body)).toBe(ref.sha256);
      expect(actual.body.byteLength).toBe(ref.sizeBytes);
    }
  }
  expect(store.actualDownload(preserved[0].snapshot.run.id, 4).body).toBe(prefix);
}

beforeAll(async () => {
  vi.stubGlobal("fetch", forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-quality-c1-backup-"));
  source = join(directory, "source");
  mkdirSync(source);
  writeFileSync(join(source, "studio.sqlite"), sentinel);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  const store = new PlanQualityStore(source, { actualEnvironment: "synthetic-test" });
  preserved = [];
  try {
    const registry = store.candidateRegistryRegister({
      expectedVersion: 0,
      clientRequestId: randomUUID(),
      sourceDigest: store.candidateRegistryList().source.sourceDigest,
      acknowledgedCandidateStatus: true,
    }).snapshot;
    candidateArchive = store.candidateRegistryDownload(1).body;
    store.actualBudgetConfigure({
      clientRequestId: randomUUID(),
      expectedRevision: 0,
      policy: { provenance: "synthetic-test", currency: "TST", unitScale: 6, capUnits: "1000000" },
    });
    const scenarios: Scenario[] = ["completed", "missing-usage", "response-write-failed"];
    for (const [index, scenario] of scenarios.entries()) {
      const input = startInput(store, index),
        plan = actualTestPlan(registry, index);
      // Exercise permitted domain changes rather than seeding already-normalized events.
      plan.sections[0].title = "합성 공급자가 붙인 비표준 제목";
      plan.sections[0].content += " [확인 필요] 시험 조건을 대조합니다.";
      const findings: ReviewFinding[] = [
        {
          id: "synthetic-review-warning",
          severity: "warning",
          category: "semantic-evidence",
          message: "합성 비교 조건을 확인해야 합니다.",
          action: "합성 자료의 시험 조건을 대조해 주세요.",
          sectionKey: "solution",
          sourceIds: [registry.entries[index].input.sources[0].id],
        },
      ];
      const response = actualTestResponse(plan, { missingUsage: scenario === "missing-usage" });
      const send = vi.fn<QualityActualSimulationOptions["transport"]["send"]>(async (request) =>
        request.request.phase === "generation"
          ? { ...response, headers: { authorization: "SYNTHETIC_UNSAFE_HEADER" } }
          : actualTestResponse({ findings }),
      );
      const failure =
        scenario === "response-write-failed"
          ? vi.spyOn(store, "actualRecordResponse").mockImplementationOnce(() => {
              throw new Error("Synthetic response persistence failure");
            })
          : null;
      let result;
      try {
        result = await runQualityActualSimulation(store, input, adapters(input, send));
      } finally {
        failure?.mockRestore();
      }
      const snapshot = result.snapshot;
      expect(snapshot.actualAiCalls).toBe(0);
      expect(snapshot.canResume).toBe(false);
      if (scenario === "completed") {
        expect(result.recordingStatus).toBe("complete");
        expect(snapshot.state).toBe("completed");
        expect(send).toHaveBeenCalledTimes(2);
        const captured = store.actualArtifact(snapshot.run.id, "generation-response");
        expect(captured.body.toString("utf8")).toBe(
          JSON.stringify({ captureKind: "sdk-response-json", response }),
        );
        const validated = JSON.parse(
          store.actualArtifact(snapshot.run.id, "generation-validated").body.toString("utf8"),
        );
        const reviewRequest = JSON.parse(
          store.actualArtifact(snapshot.run.id, "review-request").body.toString("utf8"),
        );
        expect(validated.content.sections[0].title).toBe(sectionDefinitions[0].title);
        expect(validated.content.sections[0].needsConfirmation).toBe(true);
        expect(JSON.parse(reviewRequest.input[1].content).draft).toEqual(validated.content);
        const final = JSON.parse(
          store.actualArtifact(snapshot.run.id, "final-result").body.toString("utf8"),
        );
        expect(final.semanticReview).toEqual(findings);
        expect(final.content.sections[1].needsConfirmation).toBe(true);
        expect(final.content.interviewQuestions[0]).toContain("기관 확정 질문 아님");
        expect(final.content.actionItems).not.toEqual(validated.content.actionItems);
        prefix = store.actualDownload(snapshot.run.id, 4).body;
      } else {
        expect(send).toHaveBeenCalledTimes(1);
        expect(snapshot.state).toBe(
          scenario === "missing-usage" ? "stopped-needs-cost-review" : "result-unobserved",
        );
        expect(snapshot.costState).toBe("held");
        expect(snapshot.sameCandidateBlocked).toBe(true);
        expect(snapshot.artifacts.some((item) => item.key.startsWith("review-"))).toBe(false);
        expect(snapshot.artifacts.some((item) => item.key === "generation-response")).toBe(
          scenario === "missing-usage",
        );
      }
      const artifacts = snapshot.artifacts.map((ref) => ({
        ref,
        bytes: Buffer.from(store.actualArtifact(snapshot.run.id, ref.key).body),
      }));
      const archive = store.actualDownload(snapshot.run.id, snapshot.revision).body;
      expect(archive).not.toContain("SYNTHETIC_UNSAFE_HEADER");
      preserved.push({ scenario, snapshot, artifacts, archive, sent: send.mock.calls.length });
    }
  } finally {
    store.close();
    vi.useRealTimers();
  }
}, 60000);
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  expect(readFileSync(join(source, "studio.sqlite"), "utf8")).toBe(sentinel);
});
afterAll(() => {
  vi.unstubAllGlobals();
  const target = resolve(directory),
    rel = relative(resolve(tmpdir()), target);
  if (!rel.startsWith("venture-quality-c1-backup-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(target, { recursive: true, force: true });
});

describe("observed runner records remain compatible with v4 archival validation", () => {
  it.each<Scenario>(["completed", "missing-usage", "response-write-failed"])(
    "reopens and validates the actual runner's %s artifacts and reserved cost",
    (scenario) => {
      expect(inspect(source)).toMatchObject({ actualRuns: 3, candidateVersions: 1 });
      const store = new PlanQualityStore(source);
      try {
        expectPreserved(store);
        const fixture = preserved.find((item) => item.scenario === scenario)!;
        const reservation = store
          .actualBudgetGet()
          .reservations.find(
            (item) => item.runId === fixture.snapshot.run.id && item.phase === "generation",
          )!;
        expect(reservation.settled).toBe(scenario === "completed");
        expect(reservation.heldUnits).toBe(scenario === "completed" ? "0" : "2");
        expect(fixture.sent).toBe(scenario === "completed" ? 2 : 1);
      } finally {
        store.close();
      }
    },
  );
  it(
    "backs up and restores one mixed runner ledger without changing preserved bytes or company data",
    async () => {
      const backup = join(directory, "backup"),
        target = join(directory, "restored"),
        { digest: ignored, storageVersion, ...counts } = inspect(source);
      void ignored;
      expect(storageVersion).toBe(9);
      const sourceBytes = readFileSync(join(source, "quality-evaluation", "quality.sqlite"));
      mkdirSync(target);
      writeFileSync(join(target, "studio.sqlite"), sentinel);
      expect(await backupQualityData(source, backup)).toEqual(counts);
      expect(verifyQualityBackup(backup).manifest).toMatchObject({ version: 9, ...counts });
      expect(restoreQualityData(backup, target)).toEqual(counts);
      expect(readFileSync(join(source, "quality-evaluation", "quality.sqlite"))).toEqual(
        sourceBytes,
      );
      expect(readFileSync(join(target, "quality-evaluation", "quality.sqlite"))).toEqual(
        readFileSync(join(backup, "quality.sqlite")),
      );
      const store = new PlanQualityStore(target);
      try {
        expectPreserved(store);
      } finally {
        store.close();
      }
      expect(readFileSync(join(target, "studio.sqlite"), "utf8")).toBe(sentinel);
      expect(existsSync(join(target, "quality-evaluation", ".restore-pending"))).toBe(false);
      expect(() => restoreQualityData(backup, target)).toThrow();
    },
    timeout,
  );
});
