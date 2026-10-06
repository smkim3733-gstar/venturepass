import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import example from "./fixtures/comparison-review-example.json";
import provenance from "./fixtures/comparison-review-example-provenance.json";
import { validateComparisonExampleArtifact, exampleWireSha256 } from "./comparison-review-example-artifact";
import { exportComparisonExample } from "./comparison-review-example-export-test-helper";
import { copyComparisonReviewQuery } from "./studio-public-claim-comparison-review-wire";

it("4I51 committed snapshot matches its exact original SQL export identity and wire hash", () => {
  const value = validateComparisonExampleArtifact(example, provenance);
  expect(value.query.mode).toBe("historical");
  expect(value.result.database.comparisonRecorded).toBe(true);
  expect(value.result.current).toMatchObject({ status: "not-checked", observedRevision: null });
  expect(value.result.owner).toBeNull();
  expect(value.result.runtimeObserved).toBe(false);
  expect(Object.values(value.result.authority).every((x) => x === false)).toBe(true);
  expect(provenance.wireSha256).toBe(exampleWireSha256(JSON.stringify(example)));
});
it.each(["runId", "dispatchCommandDigest", "comparisonEventDigest", "responseArtifactSha256",
  "validatedArtifactSha256", "wireSha256"] as const)("4I51 refuses altered provenance %s", (key) => {
  const changed = { ...provenance, [key]: key === "runId" ? "00000000-0000-4000-8000-000000000000" : "0".repeat(64) };
  expect(() => validateComparisonExampleArtifact(example, changed)).toThrow();
});
it("4I51 changed wire bytes cannot use the old provenance", () => {
  const wire = structuredClone(example);
  wire.result.database.runHeldBytes++;
  expect(() => validateComparisonExampleArtifact(wire, provenance)).toThrow("EXAMPLE_WIRE_HASH");
});
it("4I51 current-mode data cannot masquerade as an historical snapshot", () => {
  const wire = structuredClone(example);
  wire.query.mode = "inspect-current";
  const manifest = { ...provenance, wireSha256: exampleWireSha256(JSON.stringify(wire)) };
  expect(() => validateComparisonExampleArtifact(wire, manifest)).toThrow("EXAMPLE_HISTORICAL_ONLY");
});
it("4I51 a matching hash does not bypass strict wire authority checks", () => {
  const wire = structuredClone(example);
  wire.result.runtimeObserved = true;
  const manifest = { ...provenance, wireSha256: exampleWireSha256(JSON.stringify(wire)) };
  expect(() => validateComparisonExampleArtifact(wire, manifest)).toThrow();
});
it("4I51 extra manifest fields cannot add runtime or operational authority", () => {
  expect(() => validateComparisonExampleArtifact(example, { ...provenance, runtimeSql: true })).toThrow();
});
it.each(["read", "wire", "cleanup"] as const)("4I51 %s failure cannot return a publishable candidate", (failure) => {
  const cleanup = vi.fn(() => { if (failure === "cleanup") throw Error("cleanup failed"); });
  const publish = vi.fn();
  expect(() => {
    const candidate = exportComparisonExample({
      query: copyComparisonReviewQuery(example.query),
      read: () => {
        if (failure === "read") throw Error("read audit failed");
        return failure === "wire" ? {} : example.result;
      },
      cleanup,
    });
    publish(candidate);
  }).toThrow();
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(publish).not.toHaveBeenCalled();
});
it("4I51 export preserves the whole original result and returns only after cleanup", () => {
  const order: string[] = [];
  const candidate = exportComparisonExample({
    query: copyComparisonReviewQuery(example.query),
    read: () => { order.push("read"); return example.result; },
    cleanup: () => { order.push("cleanup"); },
  });
  order.push("publish");
  expect(order).toEqual(["read", "cleanup", "publish"]);
  expect(candidate.wire).toEqual(example);
  expect(candidate.provenance).toEqual(provenance);
});
