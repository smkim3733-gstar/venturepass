import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() => vi.fn(() => { throw Error("SDK/SQLite/operational import forbidden"); }));
vi.mock("openai", forbidden);
vi.mock("openai/helpers/zod", forbidden);
vi.mock("openai/error", forbidden);
vi.mock("node:sqlite", forbidden);
vi.mock("./studio-storage", forbidden);
vi.mock("./studio-plan-quality-store", forbidden);
vi.mock("./studio-public-claim-comparison-database-v11", forbidden);
vi.mock("./studio-plan-quality-provider-production-runtime", forbidden);
vi.mock("./studio-plan-quality-provider-configuration-current", forbidden);
import { comparisonReviewExampleData } from "./comparison-review-example-data";
import { POST } from "../app/api/studio/cases/[caseId]/public-claim-comparison/stored-review/route";
it("4I51 actual example data and route load without SDK/SQLite/operational acquisition", () => {
  expect(comparisonReviewExampleData().query.mode).toBe("historical");
  expect(typeof POST).toBe("function");
  expect(forbidden).not.toHaveBeenCalled();
});
