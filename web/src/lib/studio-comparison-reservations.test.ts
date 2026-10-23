import { afterEach, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ owner: vi.fn(), input: vi.fn() }));
vi.mock("./studio-comparison-input-preparation", () => ({
  createComparisonReservationCatalog: mocks.owner,
}));
vi.mock("./studio-comparison-execution-input-file", () => ({
  readComparisonExecutionInputFile: mocks.input,
}));
vi.mock("node:sqlite", () => {
  throw Error("SQL forbidden");
});
vi.mock("openai", () => {
  throw Error("SDK forbidden");
});
import { decodeReservationView, type ReservationView } from "./studio-comparison-reservations-wire";
import { openConfiguredReservations } from "./studio-comparison-reservations-open";
import { createReservationHttpServer } from "./studio-comparison-reservations-route";
import { createReservationClient } from "./studio-comparison-reservations-client";
const company = { id: "16a6a2ec-90d5-4400-b139-ec04bb8f91bb", revision: 3 },
  runId = "98d05f74-8527-4789-831c-6611e73bc9cc",
  other = "4900300f-313a-4114-bbf5-5b0d33b7c824",
  origin = "http://127.0.0.1:30333",
  endpoint = `${origin}/api/studio/cases/${company.id}/public-claim-comparison/reservations`;
function fixture() {
  return {
    kind: "comparison-reservation-view" as const,
    companyId: company.id,
    companyRevision: 3,
    inspectedAt: "2026-10-14T08:00:00.000Z",
    input: { status: "matched" as const, runId },
    reservations: [
      {
        runId,
        companyRevision: 3,
        companyRevisionMatches: true,
        createdAt: "2026-10-14T07:59:00.000Z",
        expiresAt: "2026-10-14T08:09:00.000Z",
        reservationExpired: false,
        model: "synthetic-model",
        sectionKey: "problem",
        sectionTitle: "합성 작성 항목",
        currency: "USD",
        unitScale: 6,
        reservedUnits: "1250",
        latestEventKind: "reserved" as const,
        history: {
          reservation: {
            clientRequestId: company.id,
            commandDigest: "a".repeat(64),
            recordedAt: "2026-10-14T07:59:00.000Z",
          },
          cancellation: null,
          finalizedAt: null,
        },
      },
    ],
    currentContextVerified: false as const,
    policiesVerified: false as const,
    transmissionAllowed: false as const,
    consentRecorded: false as const,
    runtimeObserved: false as const,
  };
}
function cancelledFixture(): ReservationView {
  const view: ReservationView = fixture(),
    row = view.reservations[0];
  row.latestEventKind = "finalized";
  row.history.finalizedAt = "2026-10-14T07:59:30.000Z";
  row.history.cancellation = {
    clientRequestId: other,
    commandDigest: "b".repeat(64),
    recordedAt: row.history.finalizedAt,
    releasedUnits: row.reservedUnits,
  };
  return view;
}
it.each([
  "missing",
  "reservation-time",
  "future",
  "unfinished",
  "amount",
  "nonce",
  "final-time",
  "extra",
])("historical receipt rejects %s without displaying release", (kind) => {
  const view = cancelledFixture(),
    row = view.reservations[0];
  if (kind === "missing") Object.assign(row, { history: undefined });
  if (kind === "reservation-time") row.history.reservation.recordedAt = "2026-10-14T07:58:00.000Z";
  if (kind === "future") view.inspectedAt = "2026-10-14T07:59:15.000Z";
  if (kind === "unfinished") row.latestEventKind = "reserved";
  if (kind === "amount") row.history.cancellation!.releasedUnits = "0";
  if (kind === "nonce")
    row.history.cancellation!.clientRequestId = row.history.reservation.clientRequestId;
  if (kind === "final-time") row.history.finalizedAt = null;
  if (kind === "extra") Object.assign(row.history, { refundVerified: true });
  expect(() => decodeReservationView(view, company)).toThrow();
});
it("a fresh HTTP registry reads persisted cancellation history without a booking or cancellation owner", async () => {
  const view = cancelledFixture(),
    factory = vi.fn(async () => ({
      list: () => structuredClone(view),
      close: () => ({ closed: true }),
    }));
  const first = createReservationHttpServer(factory),
    restarted = createReservationHttpServer(factory);
  const before = await (await first.handle(req(), company.id)).json();
  const after = await (await restarted.handle(req(), company.id)).json();
  expect(after).toEqual(before);
  expect(after.reservations[0].history.cancellation.releasedUnits).toBe("1250");
  expect(after.transmissionAllowed).toBe(false);
  expect(first.inspect().retained + restarted.inspect().retained).toBe(0);
  view.reservations[0].history.cancellation = null;
  expect(decodeReservationView(view, company).reservations[0].history.cancellation).toBeNull();
});
function setup() {
  const view = fixture(),
    row = view.reservations[0];
  const raw = {
    ...view,
    reservations: [
      {
        ...row,
        costs: {
          currency: row.currency,
          unitScale: row.unitScale,
          reservedUnits: row.reservedUnits,
        },
      },
    ],
  };
  // Native projection has costs only, never duplicate monetary display fields.
  delete (raw.reservations[0] as Partial<(typeof raw.reservations)[0]>).currency;
  delete (raw.reservations[0] as Partial<(typeof raw.reservations)[0]>).unitScale;
  delete (raw.reservations[0] as Partial<(typeof raw.reservations)[0]>).reservedUnits;
  const owner = { list: vi.fn(() => structuredClone(raw)), close: vi.fn(() => ({ closed: true })) };
  mocks.owner.mockReturnValue(owner);
  const input = {
    file: join(tmpdir(), "input.json"),
    sha256: "a".repeat(64),
    settings: { companyId: company.id, companyRevision: 3, runId },
  };
  mocks.input.mockReturnValue(input);
  vi.stubEnv("VENTURE_DATA_DIR", join(tmpdir(), "data"));
  vi.stubEnv("VENTUREPASS_COMPARISON_EXECUTION_CONTROL_DIR", join(tmpdir(), "control"));
  vi.stubEnv("VENTUREPASS_COMPARISON_EXECUTION_DATABASE_ID", other);
  vi.stubEnv("VENTUREPASS_COMPARISON_EXECUTION_INPUT_FILE", input.file);
  vi.stubEnv("OPENAI_API_KEY", "");
  return { view, raw, owner, input };
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
const req = (query = "?revision=3", init?: RequestInit) => new Request(endpoint + query, init);
it("configured read is passive, key-free and releases metadata without policy or file paths", () => {
  const f = setup(),
    owner = openConfiguredReservations(company.id, 3);
  expect(f.owner.list).not.toHaveBeenCalled();
  expect(Object.keys(owner)).toEqual(["close", "list"]);
  const view = owner.list();
  expect(view).toEqual(f.view);
  expect(JSON.stringify(view)).not.toMatch(/input.json|sha256|usagePolicy|basis|apiKey/);
  expect(owner.close()).toEqual({ closed: true });
});
it.each([
  "not-configured",
  "unavailable",
  "other-company",
  "different-revision",
  "missing-reservation",
])("input state %s is advisory and never exposes another company run", (status) => {
  const f = setup();
  if (status === "not-configured") mocks.input.mockReturnValue(null);
  if (status === "unavailable")
    mocks.input.mockImplementation(() => {
      throw Error("secret path");
    });
  if (status === "other-company") f.input.settings.companyId = other;
  if (status === "different-revision") f.input.settings.companyRevision++;
  if (status === "missing-reservation") f.input.settings.runId = other;
  const owner = openConfiguredReservations(company.id, 3),
    view = owner.list();
  expect(view.input).toEqual({ status, runId: status === "missing-reservation" ? other : null });
  expect(view.reservations).toHaveLength(1);
  owner.close();
});
it.each(["path", "id", "input"])(
  "configuration %s drift invalidates the catalog without replacing its owner",
  (kind) => {
    const f = setup(),
      owner = openConfiguredReservations(company.id, 3);
    f.owner.list.mockImplementationOnce(() => {
      if (kind === "path") vi.stubEnv("VENTURE_DATA_DIR", join(tmpdir(), "changed"));
      if (kind === "id") vi.stubEnv("VENTUREPASS_COMPARISON_EXECUTION_DATABASE_ID", runId);
      if (kind === "input") f.input.sha256 = "b".repeat(64);
      return f.raw;
    });
    expect(() => owner.list()).toThrow("CONFIGURATION_CHANGED");
    expect(mocks.owner).toHaveBeenCalledTimes(1);
    owner.close();
  },
);
it.each(["company", "duplicate", "elevated", "mismatch", "expired-flag", "extra"])(
  "wire rejects %s metadata",
  (kind) => {
    const view = fixture();
    const raw = kind === "extra" ? { ...view, apiKey: "never-use" } : view;
    if (kind === "company") view.companyId = other;
    if (kind === "duplicate") view.reservations.push(view.reservations[0]);
    if (kind === "elevated") Object.assign(view, { transmissionAllowed: true });
    if (kind === "mismatch") view.input.runId = other;
    if (kind === "expired-flag") view.reservations[0].reservationExpired = true;
    expect(() => decodeReservationView(raw, company)).toThrow();
  },
);
it("HTTP returns only validated metadata after close and uses private headers", async () => {
  const f = setup(),
    owner = { list: vi.fn(() => f.view), close: f.owner.close },
    factory = vi.fn(async () => owner);
  const server = createReservationHttpServer(factory);
  expect(factory).not.toHaveBeenCalled();
  const result = await server.handle(req(), company.id);
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual(f.view);
  expect(result.headers.get("cache-control")).toContain("no-store");
  expect(owner.close).toHaveBeenCalledTimes(1);
  expect(server.inspect().retained).toBe(0);
});
it("HTTP rejects extra/duplicate query, bad revision, foreign origin and DELETE payload before factory", async () => {
  const factory = vi.fn(async () => ({ list: () => fixture(), close: () => ({ closed: true }) }));
  const server = createReservationHttpServer(factory);
  for (const request of [
    req("?revision=3&runId=" + runId),
    req("?revision=3&revision=3"),
    req("?revision=03"),
    req("?revision=-1"),
    req("?revision=3", { headers: { origin: "https://foreign.example" } }),
    req("", { method: "DELETE", body: "{}" }),
    req("", { method: "POST", body: "{}" }),
  ])
    expect((await server.handle(request, company.id)).status).toBeGreaterThanOrEqual(400);
  expect(factory).not.toHaveBeenCalled();
});
it("HTTP failed cleanup retains original owner and same-origin DELETE retries after configuration removal", async () => {
  const owner = {
    list: () => fixture(),
    close: vi.fn<() => { closed: boolean }>(() => {
      throw Error("private detail");
    }),
  };
  const factory = vi.fn(async () => owner),
    server = createReservationHttpServer(factory);
  expect((await server.handle(req(), company.id)).status).toBe(409);
  expect((await server.handle(req(), company.id)).status).toBe(409);
  factory.mockRejectedValue(Error("NOT_CONFIGURED"));
  expect(
    (
      await server.handle(
        new Request(endpoint.replace("127.0.0.1", "localhost"), { method: "DELETE" }),
        company.id,
      )
    ).status,
  ).toBe(409);
  owner.close.mockImplementation(() => ({ closed: true }));
  expect((await server.handle(req("", { method: "DELETE" }), company.id)).status).toBe(200);
  expect(server.inspect().retained).toBe(0);
  expect(factory).toHaveBeenCalledTimes(1);
});
it("HTTP retains pending factory and closes cancelled acquisition without reading", async () => {
  let finish!: (owner: {
    list(): ReturnType<typeof fixture>;
    close(): { closed: boolean };
  }) => void;
  const factory = vi.fn(
    () =>
      new Promise<{ list(): ReturnType<typeof fixture>; close(): { closed: boolean } }>(
        (resolve) => {
          finish = resolve;
        },
      ),
  );
  const owner = { list: vi.fn(fixture), close: vi.fn(() => ({ closed: true })) };
  const server = createReservationHttpServer(factory),
    controller = new AbortController();
  const pending = server.handle(req("?revision=3", { signal: controller.signal }), company.id);
  expect((await server.handle(req("", { method: "DELETE" }), company.id)).status).toBe(409);
  controller.abort();
  finish(owner);
  expect((await pending).status).toBeGreaterThanOrEqual(400);
  expect(owner.list).not.toHaveBeenCalled();
  expect(owner.close).toHaveBeenCalledTimes(1);
  expect(server.inspect().retained).toBe(0);
});
it("HTTP hides exception details and rejects mismatched company results", async () => {
  const owner = {
    list: () => ({ ...fixture(), companyId: other }),
    close: vi.fn(() => ({ closed: true })),
  };
  const server = createReservationHttpServer(async () => owner);
  expect((await server.handle(req(), company.id)).status).toBe(422);
  expect(owner.close).toHaveBeenCalledTimes(1);
  const unavailable = createReservationHttpServer(async () => {
    throw Error("NOT_CONFIGURED");
  });
  expect((await unavailable.handle(req(), company.id)).status).toBe(503);
});
it("client is passive, selects display metadata only and clears it before cleanup", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(fixture()))
    .mockResolvedValueOnce(Response.json({ closed: true }));
  const client = createReservationClient(fetcher);
  expect(fetcher).not.toHaveBeenCalled();
  await client.load(company);
  expect(client.getSnapshot().selected).toBe("");
  client.select(runId);
  expect(client.getSnapshot().selected).toBe(runId);
  await client.cleanup(company);
  expect(client.getSnapshot().view).toBeNull();
  expect(client.getSnapshot().selected).toBe("");
  expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "DELETE"]);
  expect(fetcher.mock.calls.every(([, init]) => !init?.body && init?.cache === "no-store")).toBe(
    true,
  );
});
it("client ignores late response after company invalidation and never auto-retries", async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn<typeof fetch>(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const client = createReservationClient(fetcher),
    pending = client.load(company);
  await client.load(company);
  expect(fetcher).toHaveBeenCalledTimes(1);
  client.invalidate();
  finish(Response.json(fixture()));
  await pending;
  expect(client.getSnapshot()).toMatchObject({
    busy: false,
    view: null,
    selected: "",
    snapshot: null,
  });
  expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
});
it.each(["invalid", "large", "cleanup", "not-configured"])(
  "client clears old data and reports %s response",
  async (kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(fixture()));
    const client = createReservationClient(fetcher);
    await client.load(company);
    client.select(runId);
    fetcher.mockResolvedValueOnce(
      kind === "large"
        ? new Response(" ".repeat(128 * 1024 + 1))
        : kind === "invalid"
          ? Response.json({ ...fixture(), companyId: other })
          : Response.json(
              { code: kind === "cleanup" ? "CLEANUP_REQUIRED" : "NOT_CONFIGURED" },
              { status: 409 },
            ),
    );
    await client.load(company);
    expect(client.getSnapshot()).toMatchObject({ view: null, selected: "", busy: false });
    expect(client.getSnapshot().message).not.toBe("");
  },
);
