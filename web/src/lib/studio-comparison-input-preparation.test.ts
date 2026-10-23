import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
vi.mock("server-only", () => ({}));
const calls = vi.hoisted(() => ({
  open: vi.fn(),
  dbClose: vi.fn(),
  session: vi.fn<(...args: unknown[]) => object>(() => ({})),
  sessionClose: vi.fn(),
  factory: vi.fn(),
  check: vi.fn(),
  revoke: vi.fn(),
  network: vi.fn(() => {
    throw Error("network forbidden");
  }),
}));
vi.mock("openai", calls.network);
vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    isTransaction = false;
    constructor(...args: unknown[]) {
      calls.open(...args);
    }
    close() {
      calls.dbClose();
    }
  },
}));
vi.mock("./studio-public-comparison-file-identity", () => ({
  checkComparisonDatabasePath: calls.check,
}));
vi.mock("./studio-comparison-company-capability", () => ({
  recordComparisonCompanyConnection: vi.fn(),
  issueComparisonCompanyGuard: vi.fn(() => ({})),
  revokeComparisonCompanyGuards: calls.revoke,
}));
vi.mock("./studio-public-comparison-storage-witness", () => ({
  openComparisonStorageSession: calls.session,
  closeComparisonStorageSession: calls.sessionClose,
}));
vi.mock("./studio-public-claim-comparison-database-v11", () => ({
  createPublicComparisonPreparationReader: calls.factory,
}));
// File/SQL integration separately exercises the complete real policy schemas.
vi.mock("./studio-comparison-execution-approval", () => ({
  comparisonExecutionSettingsSchema: z
    .object({
      companyId: z.string().uuid(),
      companyRevision: z.number().int().nonnegative(),
      runId: z.string().uuid(),
      basis: z.object({ provenance: z.string(), tag: z.string() }),
      usagePolicy: z.object({ provenance: z.string(), tag: z.string() }),
    })
    .strict(),
}));
import {
  createComparisonInputPreparation,
  createComparisonReservationCatalog,
} from "./studio-comparison-input-preparation";
const id = "4900300f-313a-4114-bbf5-5b0d33b7c824",
  hash = "a".repeat(64);
function setup() {
  calls.session.mockReturnValue({});
  vi.stubGlobal("fetch", calls.network);
  const root = resolve(tmpdir(), "preparation-owner-unit");
  const input = {
    dataRoot: join(root, "data"),
    controlDirectory: join(root, "control"),
    databaseInstanceId: id,
    settings: {
      companyId: id,
      companyRevision: 3,
      runId: id,
      basis: { provenance: "official-reviewed", tag: "original" },
      usagePolicy: { provenance: "official-reviewed", tag: "original" },
    },
  };
  const prepared = {
    review: {
      runId: id,
      request: { model: "synthetic-model", selection: { companyId: id, companyRevision: 3 } },
      basis: structuredClone(input.settings.basis),
      usagePolicy: structuredClone(input.settings.usagePolicy),
      reviewDigest: hash,
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    reservation: {
      financialBasis: { costs: { currency: "USD", unitScale: 6, reservedUnits: "123" } },
    },
  };
  const reader = {
    list: vi.fn(() => ({ reservations: [], transmissionAllowed: false })),
    prepare: vi.fn(() => structuredClone(prepared)),
    close: vi.fn(() => ({ closed: true })),
  };
  calls.factory.mockReturnValue(reader);
  return { input, reader, prepared };
}
afterEach(() => {
  expect(calls.network).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
it("catalog needs only an explicit company, is passive and cannot prepare or execute", () => {
  const f = setup(),
    { settings, ...paths } = f.input;
  const query = {
    ...paths,
    companyId: settings.companyId,
    companyRevision: settings.companyRevision,
  };
  const owner = createComparisonReservationCatalog(query);
  expect(Object.keys(owner)).toEqual(["inspect", "list", "close"]);
  expect(calls.open).not.toHaveBeenCalled();
  query.companyRevision++;
  expect(owner.list()).toEqual({ reservations: [], transmissionAllowed: false });
  expect(f.reader.list).toHaveBeenCalledWith(
    { companyId: id, companyRevision: 3 },
    expect.any(String),
  );
  expect(f.reader.prepare).not.toHaveBeenCalled();
  owner.close();
  expect(() => owner.list()).toThrow(/CLOSED/);
});
it("catalog refuses policy/run overrides and invalid company revisions before acquisition", () => {
  const f = setup(),
    { settings, ...paths } = f.input;
  const query = { ...paths, companyId: id, companyRevision: 3 };
  for (const extra of [
    { settings },
    { runId: id },
    { companyRevision: -1 },
    { companyRevision: 1.5 },
    { companyId: "invalid" },
  ])
    expect(() => createComparisonReservationCatalog({ ...query, ...extra })).toThrow();
  expect(calls.open).not.toHaveBeenCalled();
});
it("catalog cleanup failure retains the original owner and denies further reads until closed", () => {
  const f = setup(),
    { settings, ...paths } = f.input;
  const owner = createComparisonReservationCatalog({
    ...paths,
    companyId: settings.companyId,
    companyRevision: 3,
  });
  f.reader.list.mockImplementationOnce(() => {
    throw Error("audit failed");
  });
  expect(() => owner.list()).toThrow();
  f.reader.close.mockImplementationOnce(() => {
    throw Error("retained cleanup");
  });
  expect(() => owner.close()).toThrow();
  expect(calls.sessionClose).not.toHaveBeenCalled();
  expect(calls.dbClose).not.toHaveBeenCalled();
  expect(() => owner.list()).toThrow(/CLOSED/);
  expect(owner.close()).toMatchObject({ closed: true, cleanupRequired: false });
  expect(calls.open).toHaveBeenCalledTimes(1);
});
it("is passive until explicit prepare, pins selection/policies and exposes no execute method", () => {
  const f = setup(),
    owner = createComparisonInputPreparation(f.input);
  expect(calls.open).not.toHaveBeenCalled();
  expect(Object.keys(owner)).toEqual(["inspect", "prepare", "close"]);
  f.input.settings.basis.tag = "edited";
  const result = owner.prepare();
  expect(result.document.settings.basis).toMatchObject({ tag: "original" });
  expect(result.summary).toMatchObject({
    transmissionAllowed: false,
    consentRecorded: false,
    databaseVerified: true,
  });
  expect(f.reader.prepare).toHaveBeenCalledWith(
    { companyId: id, companyRevision: 3, runId: id },
    f.prepared.review.basis,
    f.prepared.review.usagePolicy,
    expect.any(String),
  );
  expect(calls.open).toHaveBeenCalledWith(join(f.input.dataRoot, "studio.sqlite"), {
    readOnly: false,
  });
  expect(calls.session.mock.calls[0][1]).toMatchObject({
    databaseInstanceId: id,
    environment: "production",
    scopeId: "candidate-quality-provider-v2-live",
  });
  expect(owner.close()).toMatchObject({ closed: true, cleanupRequired: false });
  expect(() => owner.prepare()).toThrow(/CLOSED/);
  owner.close();
  expect(calls.dbClose).toHaveBeenCalledTimes(1);
});
it.each(["relative", "nested", "same", "synthetic", "extra"])(
  "rejects %s input before acquisition",
  (kind) => {
    const f = setup();
    const raw = kind === "extra" ? { ...f.input, apiKey: "forbidden" } : f.input;
    if (kind === "relative") f.input.dataRoot = "relative";
    if (kind === "nested") f.input.controlDirectory = join(f.input.dataRoot, "control");
    if (kind === "same") f.input.controlDirectory = f.input.dataRoot;
    if (kind === "synthetic") f.input.settings.usagePolicy.provenance = "synthetic-test";
    expect(() => createComparisonInputPreparation(raw)).toThrow();
    expect(calls.open).not.toHaveBeenCalled();
  },
);
it("mismatched reviewed selection or policy is never exported", () => {
  const f = setup(),
    owner = createComparisonInputPreparation(f.input);
  f.prepared.review.request.selection.companyRevision++;
  expect(() => owner.prepare()).toThrow(/REVIEW_MISMATCH/);
  f.prepared.review.request.selection.companyRevision--;
  f.prepared.review.usagePolicy.tag = "different";
  expect(() => owner.prepare()).toThrow(/REVIEW_MISMATCH/);
  expect(calls.open).toHaveBeenCalledTimes(1);
  owner.close();
});
it("partial acquisition never substitutes a connection and closes only original resources", () => {
  const f = setup();
  calls.factory.mockImplementationOnce(() => {
    throw Error("read acquisition failed");
  });
  const owner = createComparisonInputPreparation(f.input);
  expect(() => owner.prepare()).toThrow();
  expect(() => owner.prepare()).toThrow(/CLEANUP_REQUIRED/);
  expect(calls.open).toHaveBeenCalledTimes(1);
  owner.close();
  expect(calls.sessionClose).toHaveBeenCalledTimes(1);
  expect(calls.dbClose).toHaveBeenCalledTimes(1);
});
it("failed read cleanup keeps the same reader, session and company until close retry succeeds", () => {
  const f = setup(),
    owner = createComparisonInputPreparation(f.input);
  f.reader.prepare.mockImplementationOnce(() => {
    throw Error("read cleanup");
  });
  expect(() => owner.prepare()).toThrow();
  f.reader.close.mockImplementationOnce(() => {
    throw Error("close cleanup");
  });
  expect(() => owner.close()).toThrow();
  expect(calls.dbClose).not.toHaveBeenCalled();
  expect(calls.sessionClose).not.toHaveBeenCalled();
  expect(owner.inspect()).toMatchObject({ closed: false, cleanupRequired: true });
  expect(() => owner.prepare()).toThrow(/CLOSED/);
  expect(owner.close().closed).toBe(true);
  expect(calls.open).toHaveBeenCalledTimes(1);
});
