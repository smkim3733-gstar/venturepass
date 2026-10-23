import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { join } from "node:path";
import { tmpdir } from "node:os";
vi.mock("server-only", () => ({}));
const mock = vi.hoisted(() => ({ read: vi.fn(), create: vi.fn() }));
vi.mock("../../scripts/local-data-files.mjs", async (original) => ({
  ...(await original<typeof import("../../scripts/local-data-files.mjs")>()),
  readSafe: mock.read,
}));
vi.mock("./studio-comparison-reservation-booking", () => ({
  createComparisonReservationBooking: mock.create,
}));
vi.mock("./studio-public-claim-comparison-financial", () => ({
  comparisonFinancialEvidenceSchema: z
    .object({
      provenance: z.enum(["official-reviewed", "synthetic-test"]),
      model: z.string(),
      requestVersion: z.literal("public-claim-comparison-request-v1"),
    })
    .strict(),
}));
vi.mock("node:sqlite", () => {
  throw Error("SQL forbidden");
});
vi.mock("openai", () => {
  throw Error("SDK forbidden");
});
import { openConfiguredBooking } from "./studio-comparison-booking-open";
function setup() {
  const id = crypto.randomUUID(),
    selection = {
      companyId: id,
      companyRevision: 1,
      claimRecordId: crypto.randomUUID(),
      claimVersion: 1,
      claimInputDigest: "a".repeat(64),
      sourceIds: [crypto.randomUUID()],
    };
  const base = join(tmpdir(), "synthetic-booking-config");
  vi.stubEnv("VENTURE_DATA_DIR", join(base, "data"));
  vi.stubEnv("VENTUREPASS_COMPARISON_EXECUTION_CONTROL_DIR", join(base, "control"));
  vi.stubEnv("VENTUREPASS_COMPARISON_EXECUTION_DATABASE_ID", id);
  vi.stubEnv("VENTUREPASS_COMPARISON_RESERVATION_POLICY_FILE", join(base, "policy.json"));
  const policy = {
    policyVersion: 1,
    databaseInstanceId: id,
    evidence: {
      provenance: "official-reviewed",
      model: "synthetic-model",
      requestVersion: "public-claim-comparison-request-v1",
    },
  };
  const read = { bytes: Buffer.from(JSON.stringify(policy)), sha256: "a".repeat(64) };
  mock.read.mockReturnValue(read);
  const owner = {
    review: vi.fn(),
    reserve: vi.fn(),
    recover: vi.fn(),
    inspect: vi.fn(),
    close: vi.fn(),
    revoke: vi.fn(),
  };
  mock.create.mockReturnValue(owner);
  return { selection, owner, policy, read };
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
it("booking configuration is passive and fixes model policy paths before any owner review", () => {
  const f = setup();
  const owner = openConfiguredBooking(f.selection);
  expect(f.owner.review).not.toHaveBeenCalled();
  expect(mock.read).toHaveBeenCalledWith(
    expect.stringContaining("policy.json"),
    128 * 1024,
    null,
    true,
  );
  owner.review();
  expect(f.owner.review).toHaveBeenCalledTimes(1);
  expect(mock.create.mock.calls[0][0].request).toEqual({
    requestVersion: f.policy.evidence.requestVersion,
    model: "synthetic-model",
    selection: f.selection,
  });
});
it.each(["missing", "relative", "outside", "synthetic", "database", "extra"])(
  "booking rejects %s policy before construction",
  (kind) => {
    const f = setup();
    if (kind === "missing") vi.stubEnv("VENTUREPASS_COMPARISON_RESERVATION_POLICY_FILE", "");
    if (kind === "relative")
      vi.stubEnv("VENTUREPASS_COMPARISON_RESERVATION_POLICY_FILE", "policy.json");
    if (kind === "outside")
      vi.stubEnv("VENTUREPASS_COMPARISON_RESERVATION_POLICY_FILE", join(tmpdir(), "policy.json"));
    if (kind === "synthetic") f.policy.evidence.provenance = "synthetic-test";
    if (kind === "database") f.policy.databaseInstanceId = crypto.randomUUID();
    mock.read.mockReturnValue({
      ...f.read,
      bytes: Buffer.from(
        JSON.stringify({ ...f.policy, ...(kind === "extra" ? { apiKey: "forbidden" } : {}) }),
      ),
    });
    expect(() => openConfiguredBooking(f.selection)).toThrow();
    expect(mock.create).not.toHaveBeenCalled();
  },
);
it.each(["withdrawn", "bytes", "paths"])(
  "booking %s configuration revokes writes but retains original recovery and close",
  (kind) => {
    const f = setup(),
      owner = openConfiguredBooking(f.selection);
    if (kind === "withdrawn") vi.stubEnv("VENTUREPASS_COMPARISON_RESERVATION_POLICY_FILE", "");
    if (kind === "bytes") mock.read.mockReturnValue({ ...f.read, sha256: "b".repeat(64) });
    if (kind === "paths") vi.stubEnv("VENTURE_DATA_DIR", join(tmpdir(), "other-data"));
    expect(() => owner.review()).toThrow("POLICY_CHANGED");
    expect(() => owner.reserve({})).toThrow("POLICY_CHANGED");
    owner.recover();
    owner.close();
    expect(f.owner.revoke).toHaveBeenCalledTimes(2);
    expect(f.owner.reserve).not.toHaveBeenCalled();
    expect(f.owner.recover).toHaveBeenCalledTimes(1);
    expect(f.owner.close).toHaveBeenCalledTimes(1);
  },
);
