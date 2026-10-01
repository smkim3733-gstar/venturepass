import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  fixture,
  executionBase,
  prepare,
  dispatch,
  receive,
  validate,
  finish,
} from "./studio-plan-quality-provider-execution-version-test-helpers";
import { reviewResponseFixture } from "./studio-plan-quality-provider-review-response-test-helpers";
import {
  prepareProviderReviewResponse as frozen,
  prepareVersionedProviderReviewResponse as plan,
} from "./studio-plan-quality-provider-review-response";
import { inspectVersionedProviderTransmissionApprovalArchive as inspect } from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import {
  versionedProviderExecutionOperationDigest,
  providerDigest,
} from "../../scripts/local-data-quality-provider.mjs";
import type { ProviderReviewResponseInput } from "./studio-plan-quality-provider-review-response";
const base = fixture(executionBase());
prepare(base, "generation");
dispatch(base, "generation");
receive(base, "generation");
validate(base, "generation");
prepare(base, "review");
dispatch(base, "review");
const nonce = (revision: number) =>
  base.data.receipts.find((r) => r.runRevision === revision)!.clientRequestId;
const input: ProviderReviewResponseInput = {
  inspectedAt: "2026-09-27T03:35:00.000Z",
  additionalUsedBytes: 0,
  archive: base.upper(),
  capture: {
    dispatch: {
      generation: {
        dispatch: {
          runId: base.data.run.id,
          runDigest: base.data.run.runDigest,
          approvalBindingDigest: base.upper().records[0].recordDigest,
          preparedRequestId: nonce(2),
          dispatchRequestId: nonce(3),
        },
        responseRequestId: nonce(4),
        responseEventDigest: base.data.events[3].eventDigest,
        validationRequestId: nonce(5),
      },
      validationEventDigest: base.data.events[4].eventDigest,
      preparedRequestId: nonce(6),
      dispatchRequestId: nonce(7),
    },
    responseRequestId: randomUUID(),
    response: {
      id: "response-synthetic-review-v2",
      model: base.preparation.model,
      status: "completed",
      output: [],
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    },
  },
};
it("audits versioned response bytes, operation version and exact usage while frozen v1 rejects the archive", () => {
  const source = structuredClone(input),
    r = plan(source);
  expect(frozen(source)).toMatchObject({ status: "refused", reason: "archive-invalid" });
  expect(r).toMatchObject({
    status: "prepared",
    plan: {
      planVersion: 2,
      rows: { event: { executionContractVersion: 2, revision: 8 } },
      dispatchAllowed: false,
      budgetWriteAllowed: false,
      automaticRetryAllowed: false,
    },
  });
  if (r.status !== "prepared") throw Error(r.reason);
  expect(r.plan.rows.receipt.inputDigest).toBe(
    versionedProviderExecutionOperationDigest(base.data.run.id, r.plan.command),
  );
  const { planDigest, ...body } = r.plan;
  expect(planDigest).toBe(providerDigest(body));
  expect(Object.isFrozen(r.plan.rows.event)).toBe(true);
  expect(source).toEqual(input);
});
it("preserves v1 plan JSON bytes in the mixed-capable entry", () => {
  const f = reviewResponseFixture();
  expect(JSON.stringify(plan(f.input))).toBe(JSON.stringify(frozen(f.input)));
});
it.each([false, true])("preserves terminal late capture and unresolved usage=%s", (unknown) => {
  const f = {
    data: structuredClone(base.data),
    registry: base.registry,
    preparation: base.preparation,
  };
  finish(f, "result-unobserved");
  const next = structuredClone(input);
  next.archive = {
    ...input.archive,
    archive: {
      ...input.archive.archive,
      ledger: {
        ...input.archive.archive.ledger,
        events: f.data.events,
        receipts: [
          ...(input.archive.archive.ledger.receipts as typeof f.data.receipts).filter(
            (r) => !r.runId,
          ),
          ...f.data.receipts,
        ],
        artifacts: f.data.artifacts,
        budgetEvents: f.data.budgetEvents,
      },
    },
  };
  if (unknown) delete (next.capture as { response: { usage?: unknown } }).response.usage;
  const r = plan(next);
  expect(r).toMatchObject({
    status: "prepared",
    plan: {
      late: true,
      resultingState: { revision: 9, terminal: true, state: "result-unobserved" },
    },
  });
  if (r.status !== "prepared") throw Error(r.reason);
  if (unknown) {
    expect(r.plan.rows.usageEvent).toBeNull();
    expect(r.plan.budget.after).toEqual(r.plan.budget.before);
  }
  const ledger = next.archive.archive.ledger;
  ledger.events.push(r.plan.rows.event);
  ledger.receipts.push(r.plan.rows.receipt);
  ledger.artifacts.push(r.plan.rows.artifact);
  if (r.plan.rows.usageEvent) ledger.budgetEvents.push(r.plan.rows.usageEvent);
  expect(inspect(next.archive).reservationArchive.ledger.provider.snapshots[0]).toMatchObject({
    revision: 9,
    terminal: true,
    state: "result-unobserved",
  });
});
it.each(["version", "configuration", "tokenEvidence"])("rejects caller %s as authority", (key) => {
  expect(plan({ ...input, [key]: "plan-observation-v1" })).toMatchObject({
    status: "refused",
    reason: "invalid-input",
  });
});
it.each(["origin", "request", "event", "nonce"])(
  "rejects mismatched %s before preserving a response",
  (key) => {
    const f = structuredClone(input);
    if (key === "origin")
      (
        f.capture as typeof input.capture & {
          dispatch: { generation: { responseEventDigest: string } };
        }
      ).dispatch.generation.responseEventDigest = "0".repeat(64);
    if (key === "request") (f.archive.archive.ledger.artifacts[0] as { body: string }).body += " ";
    if (key === "event")
      (
        f.archive.archive.ledger.events[6] as { executionContractVersion: number }
      ).executionContractVersion = 1;
    if (key === "nonce") (f.capture as { responseRequestId: string }).responseRequestId = nonce(2);
    expect(plan(f).status).toBe("refused");
  },
);

import * as configuration from "./studio-plan-quality-provider-configuration";
import { readFixedProviderConfiguration } from "./studio-plan-quality-provider-configuration-20260927-test-fixture";
beforeEach(() => {
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(
    readFixedProviderConfiguration,
  );
});
afterEach(() => vi.restoreAllMocks());
