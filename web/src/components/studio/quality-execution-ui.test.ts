import { randomUUID, webcrypto } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("openai", () => ({
  default: class {
    constructor() {
      throw new Error("Provider forbidden");
    }
  },
}));
import {
  createCandidateRegistrySource,
  candidateRegistryVersionDigest,
} from "@/lib/studio-plan-quality-candidate-registry";
import {
  candidateRegistryNotice,
  type CandidateRegistrySnapshot,
} from "@/lib/studio-plan-quality-candidate-registry-types";
import { generateObservedPlan, generatePlan, getPlanExecutionContract } from "@/lib/studio-engine";
import { caseSchema } from "@/lib/studio-schema";
import {
  createQualityExecutionPreparation,
  qualityExecutionCreateRun,
  qualityExecutionCreateEvent,
  validateQualityExecutionLedger,
} from "@/lib/studio-plan-quality-execution";
import {
  qualityExecutionRequestDigestInput,
  qualityExecutionSnapshotDigestInput,
  qualityExecutionPreparationDigestInput,
  qualityExecutionDownloadName,
  type QualityExecutionEvent,
  type QualityExecutionEventPayload,
  type QualityExecutionReceipt,
} from "@/lib/studio-plan-quality-execution-types";
import { planQualityEvaluationDigest as digest } from "@/lib/studio-plan-quality-evaluation";
import {
  qualityExecutionPreparation,
  qualityExecutionPending,
  qualityExecutionRecovery,
  qualityExecutionCommitted,
  qualityExecutionSnapshot,
  qualityExecutionList,
  qualityExecutionArchive,
  qualityExecutionUnsettled,
  qualityExecutionStateLabels,
  qualityExecutionCanRetry,
} from "./quality-execution-ui";
import { QualityExecutionPanel } from "./quality-execution-panel";

const now = "2026-09-27T03:00:00.000Z";
beforeAll(() => vi.stubGlobal("crypto", webcrypto));
async function fixture() {
  const payload: Omit<CandidateRegistrySnapshot, "versionDigest"> = {
    ...createCandidateRegistrySource(),
    kind: "validation-candidate-set",
    version: 1,
    previousVersion: null,
    previousDigest: null,
    registeredAt: now,
    clientRequestId: randomUUID(),
    notice: candidateRegistryNotice,
  };
  const registry = { ...payload, versionDigest: candidateRegistryVersionDigest(payload) };
  const entry = registry.entries[0],
    preparation = createQualityExecutionPreparation(
      registry,
      entry.candidateId,
      getPlanExecutionContract(),
      0,
    );
  const pending = qualityExecutionPending(preparation, registry, randomUUID());
  const run = qualityExecutionCreateRun({
    id: randomUUID(),
    clientRequestId: pending.request.clientRequestId,
    preparation,
    authorizedAt: now,
  });
  const receipt: QualityExecutionReceipt = {
    kind: "start-candidate-execution",
    executionId: run.id,
    clientRequestId: run.clientRequestId,
    inputDigest: digest(qualityExecutionRequestDigestInput(pending.request)),
    runDigest: run.runDigest,
    planDigest: preparation.planDigest,
  };
  const events: QualityExecutionEvent[] = [];
  const append = (item: QualityExecutionEventPayload) => {
    events.push(
      qualityExecutionCreateEvent({
        executionId: run.id,
        revision: events.length + 1,
        previousEventDigest: events.at(-1)?.eventDigest ?? null,
        recordedAt: now,
        payload: item,
      }),
    );
  };
  const company = caseSchema.parse({
    id: run.id,
    profile: entry.input.profile,
    sources: entry.input.sources,
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: "preparing",
    revision: 0,
    createdAt: now,
    updatedAt: now,
  });
  const plan = await generatePlan(company, entry.input.candidate, "assisted");
  const result = await generateObservedPlan(company, entry.input.candidate, {
    mode: "mock",
    model: preparation.model,
    contractDigest: preparation.engine.contractDigest,
    transport: async ({ request }) => ({
      id: `mock-${request.sequence}`,
      status: "completed",
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: JSON.stringify(request.phase === "generation" ? plan : { findings: [] }),
            },
          ],
        },
      ],
    }),
    hooks: {
      onDispatch: (request) => append({ kind: "dispatch", request }),
      onResponse: (response) => append({ kind: "response", response }),
      onValidated: (validated) => append({ kind: "validated", validated }),
    },
  });
  append({ kind: "finished", outcome: "completed", failureCode: null, result });
  const snapshot = validateQualityExecutionLedger(run, events, registry);
  return { registry, preparation, pending, receipt, run, events, snapshot };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
let base: Fixture;
beforeAll(async () => {
  base = await fixture();
});
function copy() {
  return structuredClone(base);
}
function archive(value = base.snapshot, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="${qualityExecutionDownloadName(value.run.id, value.revision)}"`,
      ...headers,
    },
  });
}

describe("mock execution UI binding and response recovery", () => {
  it("validates exact preparation and snapshot without escalating mock status", async () => {
    const { registry, preparation, snapshot } = copy();
    expect(
      await qualityExecutionPreparation(preparation, registry, preparation.candidateId),
    ).toEqual(preparation);
    expect(
      await qualityExecutionSnapshot(snapshot, registry, { id: snapshot.run.id, revision: 7 }),
    ).toEqual(snapshot);
    expect(await qualityExecutionList({ executions: [snapshot] })).toEqual([snapshot]);
    expect(qualityExecutionStateLabels.completed).toBe("모의 연결 시험 종료");
  });
  it("detaches pending request and registry from later selection or draft mutation", () => {
    const { preparation, registry } = copy(),
      waiting = qualityExecutionPending(preparation, registry, randomUUID());
    preparation.label = "changed";
    registry.entries[0].input.profile.companyName = "changed";
    expect(waiting.request.preparation.label).not.toBe("changed");
    expect(waiting.registry.entries[0].input.profile.companyName).not.toBe("changed");
  });
  it.each(["candidate", "version", "source", "engine", "mode"])(
    "rejects changed %s in preparation even when outer digest is recomputed",
    async (kind) => {
      const { preparation, registry } = copy();
      if (kind === "candidate") preparation.candidateId = registry.entries[1].candidateId;
      if (kind === "version") preparation.version = 2;
      if (kind === "source") preparation.modelInputDigest = "0".repeat(64);
      if (kind === "engine") preparation.engine.phases[0].instructionDigest = "0".repeat(64);
      if (kind === "mode") Object.assign(preparation, { mode: "actual-ai" });
      preparation.planDigest = digest(qualityExecutionPreparationDigestInput(preparation));
      await expect(
        qualityExecutionPreparation(preparation, registry, registry.entries[0].candidateId),
      ).rejects.toThrow();
    },
  );
  it("retains not-observed uncertainty without creating a replacement request", async () => {
    const { pending } = copy(),
      nonce = pending.request.clientRequestId;
    expect(await qualityExecutionRecovery({ state: "not-observed" }, pending)).toEqual({
      state: "not-observed",
    });
    expect(pending.request.clientRequestId).toBe(nonce);
  });
  it("permits explicit same-body retry only after that exact nonce was not observed", () => {
    const nonce = randomUUID();
    expect(qualityExecutionCanRetry(nonce, null, null)).toBe(false);
    expect(qualityExecutionCanRetry(nonce, randomUUID(), null)).toBe(false);
    expect(qualityExecutionCanRetry(nonce, nonce, null)).toBe(true);
    expect(qualityExecutionCanRetry(nonce, nonce, nonce)).toBe(false);
    // Starting a lookup or consuming a retry clears the previous not-observed observation.
    expect(qualityExecutionCanRetry(nonce, null, nonce)).toBe(false);
    expect(qualityExecutionCanRetry(nonce, null, null)).toBe(false);
  });
  it("adopts committed receipt only with exact durable run and preparation", async () => {
    const { receipt, pending, snapshot } = copy();
    expect(await qualityExecutionRecovery({ state: "committed", receipt }, pending)).toEqual({
      state: "committed",
      receipt,
    });
    expect(await qualityExecutionCommitted(snapshot, pending, receipt)).toEqual(snapshot);
  });
  it.each(["nonce", "input", "plan", "run"])(
    "rejects different %s receipt during recovery",
    async (kind) => {
      const { receipt, pending, snapshot } = copy();
      if (kind === "nonce") receipt.clientRequestId = randomUUID();
      if (kind === "input") receipt.inputDigest = "0".repeat(64);
      if (kind === "plan") receipt.planDigest = "0".repeat(64);
      if (kind === "run") receipt.runDigest = "0".repeat(64);
      await expect(qualityExecutionCommitted(snapshot, pending, receipt)).rejects.toThrow();
    },
  );
  it("does not mistake committed start for completed execution", async () => {
    const { run, registry, pending, receipt, events } = copy();
    for (const count of [0, 1, 2, 3, 4, 5, 6]) {
      const value = validateQualityExecutionLedger(run, events.slice(0, count), registry);
      expect(
        qualityExecutionUnsettled(await qualityExecutionCommitted(value, pending, receipt)),
      ).toBe(true);
    }
  });
  it("keeps unknown records unsettled and distinguishes known failed termination", async () => {
    const { run, registry, events } = copy();
    const unknown = qualityExecutionCreateEvent({
      executionId: run.id,
      revision: 2,
      previousEventDigest: events[0].eventDigest,
      recordedAt: now,
      payload: {
        kind: "finished",
        outcome: "unknown",
        failureCode: "RESPONSE_UNRECORDED",
        result: null,
      },
    });
    expect(
      qualityExecutionUnsettled(
        await qualityExecutionSnapshot(
          validateQualityExecutionLedger(run, [events[0], unknown], registry),
          registry,
        ),
      ),
    ).toBe(true);
    const failed = qualityExecutionCreateEvent({
      executionId: run.id,
      revision: 3,
      previousEventDigest: events[1].eventDigest,
      recordedAt: now,
      payload: { kind: "finished", outcome: "failed", failureCode: "OUTPUT_INVALID", result: null },
    });
    expect(
      qualityExecutionUnsettled(
        await qualityExecutionSnapshot(
          validateQualityExecutionLedger(run, [...events.slice(0, 2), failed], registry),
          registry,
        ),
      ),
    ).toBe(false);
  });
  it.each(["state", "counts", "output", "chain"])(
    "rejects forged %s despite valid top-level snapshot SHA",
    async (kind) => {
      const { snapshot, registry } = copy();
      if (kind === "state") snapshot.state = "failed";
      if (kind === "counts") snapshot.responseCount = 0;
      if (kind === "output") snapshot.output.plan!.title = "changed";
      if (kind === "chain") snapshot.events[1].previousEventDigest = "0".repeat(64);
      snapshot.snapshotDigest = digest(qualityExecutionSnapshotDigestInput(snapshot));
      await expect(qualityExecutionSnapshot(snapshot, registry)).rejects.toThrow();
    },
  );
  it("refuses duplicate history, another run and a different historical revision", async () => {
    const { snapshot, registry } = copy();
    await expect(qualityExecutionList({ executions: [snapshot, snapshot] })).rejects.toThrow();
    await expect(
      qualityExecutionSnapshot(snapshot, registry, { id: randomUUID() }),
    ).rejects.toThrow();
    await expect(
      qualityExecutionSnapshot(snapshot, registry, { id: snapshot.run.id, revision: 0 }),
    ).rejects.toThrow();
  });
  it("downloads only pinned historical revision bytes after attachment and SHA checks", async () => {
    const { snapshot, registry } = copy();
    const result = await qualityExecutionArchive(archive(), snapshot, registry);
    expect(await result.blob.text()).toBe(JSON.stringify(base.snapshot));
    expect(result.filename).toBe(qualityExecutionDownloadName(snapshot.run.id, snapshot.revision));
    await expect(
      qualityExecutionArchive(
        archive(snapshot, { "content-type": "text/html" }),
        snapshot,
        registry,
      ),
    ).rejects.toThrow();
    await expect(
      qualityExecutionArchive(
        archive(snapshot, { "content-disposition": "inline" }),
        snapshot,
        registry,
      ),
    ).rejects.toThrow();
  });
  it("renders mock-only mobile controls without a real AI execution action", () => {
    const html = renderToStaticMarkup(
      createElement(QualityExecutionPanel, { registry: base.registry }),
    );
    expect(html).toContain("무료 모의 연결 시험");
    expect(html).toContain("실제 AI 호출은 0회");
    expect(html).toContain("후보 한 개 선택");
    expect(html).toContain("min-h-11");
    expect(html).not.toContain(">실제 AI 실행<");
    expect(
      renderToStaticMarkup(createElement(QualityExecutionPanel, { registry: null })),
    ).toContain("고정된 등록 버전을 열면");
  });
});
