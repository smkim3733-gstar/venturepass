import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("SDK or database access forbidden");
  }),
);
vi.mock("openai", forbidden);
vi.mock("openai/helpers/zod", forbidden);
vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    constructor() {
      forbidden();
    }
  },
}));
import { publicClaimComparisonFixture } from "./studio-public-claim-comparison-test-helpers";
import { preparePublicClaimComparison } from "./studio-public-claim-comparison";
import {
  buildPublicClaimComparisonRequest,
  inspectArchivedPublicClaimRequest,
  publicClaimComparisonRequestVersion,
} from "./studio-public-claim-comparison-request";
import { capturePublicClaimComparisonResponse } from "./studio-public-claim-comparison-capture";
import { createIsolatedPublicComparisonService } from "./studio-public-claim-comparison-database-v11";

afterEach(() => {
  vi.unstubAllGlobals();
  expect(forbidden).not.toHaveBeenCalled();
});

it("loads the SQL13 reader composition and rebuilds/decodes a comparison without SDK imports or IO", () => {
  vi.stubGlobal("fetch", forbidden);
  const f = publicClaimComparisonFixture();
  const before = structuredClone(f.company);
  const command = {
    requestVersion: publicClaimComparisonRequestVersion,
    model: "synthetic-passive",
    selection: f.select(),
  };
  const prepared = preparePublicClaimComparison(f.company, command.selection);
  const preview = buildPublicClaimComparisonRequest(f.company, command);
  const historical = inspectArchivedPublicClaimRequest(command, JSON.stringify(prepared));
  expect(historical.request.rawBody).toBe(preview.rawBody);
  expect(historical.request.identity).toEqual(preview.identity);
  const result = capturePublicClaimComparisonResponse(f.company, command, preview.identity, {
    id: "synthetic-response",
    status: "completed",
    model: command.model,
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              preparationDigest: prepared.preparationDigest,
              claimQuote: prepared.input.claimQuote,
              overall: { relation: "undetermined", reason: "합성 의견" },
              evidence: prepared.input.selectedEvidence.map((s) => ({
                sourceId: s.sourceId,
                relation: "undetermined",
                quotes: [],
                reason: "합성 의견",
                nextCheck: "",
              })),
              checks: [],
            }),
          },
        ],
      },
    ],
  });
  expect(result.state).toBe("comparison-ready");
  expect(result.providerExecutionObserved).toBe(false);
  expect(result.transmissionAllowed).toBe(false);
  expect(result.databaseWriteAllowed).toBe(false);
  expect(f.company).toEqual(before);
  expect(typeof createIsolatedPublicComparisonService).toBe("function");
});
