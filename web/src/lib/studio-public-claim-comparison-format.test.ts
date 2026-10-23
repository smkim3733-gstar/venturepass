import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("openai", () => ({
  default: class {
    constructor() {
      throw Error("SDK client forbidden");
    }
  },
}));
// Test-only comparison with the locked SDK's local formatter; no client or provider request.
import { zodTextFormat } from "openai/helpers/zod";
import { publicClaimComparisonResponseSchema } from "./studio-public-claim-comparison-types";
import { publicClaimComparisonFormat } from "./studio-public-claim-comparison-format";
import { StudioEngineError } from "./studio-engine-request-core";
import { StudioEngineError as LegacyError } from "./studio-engine-request-preparation";
import { parseProviderResponseOutput } from "./studio-provider-response-output";
import type { ProviderCapturedResponse } from "../../scripts/local-data-quality-provider-usage.mjs";

it("keeps the exact original SDK format bytes, property order and fixed wire hash", () => {
  const expected = JSON.stringify(
    zodTextFormat(publicClaimComparisonResponseSchema, "public_claim_comparison_v1"),
  );
  const actual = JSON.stringify(publicClaimComparisonFormat());
  expect(actual).toBe(expected);
  expect(createHash("sha256").update(actual).digest("hex")).toBe(
    "413b79dd48bd3307647ac973cab4e9640f934bcd033afd944df78a978615b82c",
  );
});

it("returns independent schemas so one caller cannot rewrite later request bytes", () => {
  const original = JSON.stringify(publicClaimComparisonFormat());
  const changed = publicClaimComparisonFormat();
  changed.schema.description = "caller change";
  expect(JSON.stringify(publicClaimComparisonFormat())).toBe(original);
});

it("preserves the legacy error class identity and decoder failure contract", () => {
  expect(StudioEngineError).toBe(LegacyError);
  let failure: unknown;
  try {
    parseProviderResponseOutput({ status: "incomplete" } as ProviderCapturedResponse);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(LegacyError);
  expect(failure).toMatchObject({ code: "AI_INCOMPLETE", status: 502 });
});
