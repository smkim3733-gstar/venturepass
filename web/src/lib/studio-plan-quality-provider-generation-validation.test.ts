import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { generationValidationFixture } from "./studio-plan-quality-provider-generation-validation-test-helpers";
import {
  prepareProviderGenerationValidation as prepare,
  type ProviderGenerationValidationIdentity,
} from "./studio-plan-quality-provider-generation-validation";
import { inspectProviderTransmissionApprovalArchive as inspect } from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import {
  providerDigest as digest,
  providerWireDigest,
  providerRawDigest,
} from "../../scripts/local-data-quality-provider.mjs";
import * as engine from "./studio-engine";
import type { PlanContent } from "./studio-schema";

vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("External IO forbidden");
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
  throw new Error("No DB in pure validation");
});
const base = generationValidationFixture();
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
const identity = () => f.input.identity as ProviderGenerationValidationIdentity;
function plan() {
  const result = prepare(f.input);
  if (result.status !== "prepared") throw new Error(result.reason);
  return result.plan;
}
const refuse = (reason: string) => {
  const result = prepare(f.input);
  expect(result.status).toBe("refused");
  if (result.status === "refused")
    expect(result).toEqual({ status: "refused", reason, plan: null });
};
function generated(change: (plan: PlanContent) => void) {
  f = generationValidationFixture((response) => {
    const output = response.output as { content: { text: string }[] }[];
    const body = JSON.parse(output[0].content[0].text);
    change(body);
    output[0].content[0].text = JSON.stringify(body);
  });
}

it("prepares audited r5 rows and a review derived solely from validated output, without writing or sending", () => {
  const before = structuredClone(f),
    p = plan();
  expect(f).toEqual(before);
  expect(p).toMatchObject({
    status: "prepared-not-committed",
    dispatchAllowed: false,
    budgetWriteAllowed: false,
    automaticRetryAllowed: false,
    rows: {
      event: {
        revision: 5,
        payload: {
          kind: "domain-validated",
          phase: "generation",
          responseEventDigest: f.response.eventDigest,
        },
      },
    },
    review: { status: "derived-not-prepared" },
  });
  const output = JSON.parse(p.rows.artifact.body);
  expect(p.output).toEqual(output);
  expect(p.command.payload.outputDigest).toBe(digest(output));
  const draft = JSON.parse(p.review.body.input[1].content).draft;
  expect(draft).toEqual(output.content);
  expect(p.review.rawBody).toBe(JSON.stringify(p.review.body));
  expect(p.review.requestDigest).toBe(providerWireDigest(p.review.body));
  expect(p.review.artifactSha256).toBe(providerRawDigest(p.review.rawBody));
  expect(p.review.derivedFrom).toEqual({
    generationEventDigest: p.rows.event.eventDigest,
    artifactSha256: p.rows.artifact.sha256,
    outputDigest: digest(output),
  });
  expect(p.review.body).toMatchObject({
    model: "gpt-5.4-2026-03-05",
    store: false,
    stream: false,
    background: false,
    truncation: "disabled",
    service_tier: "default",
  });
  expect(Object.isFrozen(p.review.body.input)).toBe(true);
  expect(Object.isFrozen(p.output)).toBe(true);
  const ledger = f.input.archive.archive.ledger;
  const after = inspect({
    ...f.input.archive,
    archive: {
      ...f.input.archive.archive,
      ledger: {
        ...ledger,
        events: [...ledger.events, p.rows.event],
        receipts: [...ledger.receipts, p.rows.receipt],
        artifacts: [...ledger.artifacts, p.rows.artifact],
      },
    },
  });
  expect(after.reservationArchive.ledger.provider.snapshots[0]).toMatchObject({
    revision: 5,
    state: "validated",
    dispatchAllowed: false,
  });
  expect(after.reservationArchive.ledger.provider.budgetEvents).toEqual(ledger.budgetEvents);
});
it("is deterministic, uses frozen titles and preserves/increases confirmation flags", () => {
  generated((draft) => {
    draft.sections[0].title = "model supplied title";
    draft.sections[0].needsConfirmation = true;
    draft.sections[1].evidence = [];
  });
  const a = plan(),
    b = plan();
  expect(a).toEqual(b);
  if (a.output.kind !== "plan") throw new Error("Plan required");
  expect(a.output.content.sections[0].title).toBe("개발 필요성과 고객의 문제");
  expect(a.output.content.sections[0].needsConfirmation).toBe(true);
  expect(a.output.content.sections[1].needsConfirmation).toBe(true);
});
it.each([
  "missing",
  "duplicate",
  "order",
  "unknown-source",
  "invented-quote",
  "empty-locator",
  "guarantee",
  "extra-field",
])("refuses invalid generated content: %s", (kind) => {
  generated((draft) => {
    if (kind === "missing") draft.sections.pop();
    if (kind === "duplicate") draft.sections[1].key = draft.sections[0].key;
    if (kind === "order") draft.sections.reverse();
    if (kind === "unknown-source") draft.sections[0].evidence[0].sourceId = "unregistered-source";
    if (kind === "invented-quote")
      draft.sections[0].evidence[0].quote = "Invented unsupported claim";
    if (kind === "empty-locator") draft.sections[0].evidence[0].locator = " ";
    if (kind === "guarantee") draft.sections[0].content = "벤처확인 100% 보장합니다.";
    if (kind === "extra-field") Object.assign(draft, { hiddenApproval: true });
  });
  refuse("output-invalid");
});
it.each(["incomplete", "missing", "refusal", "multiple", "invalid-json", "text-limit"])(
  "refuses response output %s",
  (kind) => {
    f = generationValidationFixture((response) => {
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
      if (kind === "invalid-json")
        response.output = [
          { type: "message", content: [{ type: "output_text", text: "invalid-json" }] },
        ];
      if (kind === "text-limit")
        response.output = [
          { type: "message", content: [{ type: "output_text", text: " ".repeat(2097153) }] },
        ];
    });
    refuse("output-invalid");
  },
);
it("blocks unknown usage even when the generated plan is otherwise valid", () => {
  f = generationValidationFixture((response) => {
    delete response.usage;
  });
  refuse("usage-unknown");
});
it("blocks known usage exceeding the original bound", () => {
  f = generationValidationFixture((response) => {
    response.usage = {
      input_tokens: 20,
      output_tokens: 600000,
      total_tokens: 600020,
      input_tokens_details: { cached_tokens: 5 },
    };
  });
  refuse("budget-bound-breached");
});
it("prepares offline after expiry without granting fresh transmission", () => {
  f.input.inspectedAt = "2035-01-01T00:00:00.000Z";
  expect(plan().dispatchAllowed).toBe(false);
});
it("separates an incompatible current validator from invalid stored output", () => {
  const current = engine.getPlanExecutionContract();
  vi.spyOn(engine, "getPlanExecutionContract").mockReturnValue({
    ...current,
    contractDigest: "0".repeat(64),
  });
  refuse("validation-contract-changed");
});
it.each(["responseRequestId", "responseEventDigest"] as const)(
  "requires exact original response %s",
  (key) => {
    identity()[key] = key.endsWith("Id") ? randomUUID() : "0".repeat(64);
    refuse("bindings-changed");
  },
);
it.each([
  "runId",
  "runDigest",
  "approvalBindingDigest",
  "preparedRequestId",
  "dispatchRequestId",
] as const)("requires original dispatch binding %s", (key) => {
  identity().dispatch[key] = key.endsWith("Id") ? randomUUID() : "0".repeat(64);
  refuse("bindings-changed");
});
it.each(["model", "output", "transport", "configuration", "dispatchAllowed"])(
  "rejects caller override %s",
  (key) => {
    Object.assign(identity(), { [key]: {} });
    refuse("invalid-input");
  },
);
it("rejects reused native and unrelated shared nonces", () => {
  identity().validationRequestId = identity().responseRequestId;
  refuse("nonce-conflict");
  identity().validationRequestId = randomUUID();
  f.input.archive.archive.ledger.otherNonces = [identity().validationRequestId];
  refuse("nonce-conflict");
});
it.each(["response", "binding", "coverage"])(
  "rejects corrupted %s before deriving a review",
  (kind) => {
    if (kind === "response")
      (f.input.archive.archive.ledger.artifacts.at(-1) as { body: string }).body += " ";
    if (kind === "binding") f.input.archive.records.length = 0;
    if (kind === "coverage") f.input.archive.coverage = null;
    refuse("archive-invalid");
  },
);
it("includes audited external raw bytes in the exact shared storage boundary", () => {
  const initial = plan(),
    left = 256 * 1024 * 1024 - initial.capacity.totalExposureBytes;
  f.input.additionalUsedBytes = left;
  expect(plan().capacity.totalExposureBytes).toBe(256 * 1024 * 1024);
  f.input.additionalUsedBytes++;
  refuse("capacity-exceeded");
});
it.each([NaN, -1, 0.5])("rejects invalid raw byte accounting %s", (value) => {
  f.input.additionalUsedBytes = value;
  refuse("invalid-input");
});
it("rejects time before the captured response", () => {
  f.input.inspectedAt = "2026-09-27T03:35:59.999Z";
  refuse("invalid-input");
});
