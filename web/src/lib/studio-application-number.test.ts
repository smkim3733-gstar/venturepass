import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import { caseSchema, mutationSchema, type StudioCase } from "./studio-schema";
import { publicEvidenceExportFixture } from "./studio-public-evidence-export-test-helpers";
import {
  applicationEventSchema,
  applicationMetadata,
  applicationLimits,
} from "./studio-application-types";
import { applicationInputDigest, assertApplicationCapacity } from "./studio-applications";
import {
  auditApplicationNumberBindings,
  buildApplicationNumberBinding,
  currentApplicationNumberBinding,
  findApplicationNumberReplay,
} from "./studio-application-number";
import {
  applicationNumberBindingCommandSchema,
  applicationNumberBindingHistorySchema,
  type ApplicationNumberBindingCommand,
} from "./studio-application-number-types";
import { withVentureInputCompanyLock } from "./venturein-input-lock";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ store: null as StudioStore | null, external: vi.fn() }));
vi.mock("./studio-storage", async (original) => ({
  ...(await original<typeof import("./studio-storage")>()),
  getStudioStore: () => state.store!,
}));
vi.mock("openai", () => ({
  default: class {
    constructor() {
      state.external();
      throw Error("SDK forbidden");
    }
  },
}));
vi.mock("./venturein-runner", () => ({
  stopVentureSession: () => {
    state.external();
    throw Error("Runner forbidden");
  },
}));
import { GET, PATCH } from "@/app/api/studio/cases/[caseId]/route";

let directory: string, caseId: string, applicationId: string;
const store = () => state.store!;
const db = () => (store() as unknown as { db: DatabaseSync }).db;
const read = () => store().get(caseId);
const body = () =>
  String(db().prepare("SELECT body FROM studio_cases WHERE id=?").get(caseId)!.body);
function edit(fn: (company: StudioCase) => void) {
  const value = JSON.parse(body()) as StudioCase;
  fn(value);
  db()
    .prepare("UPDATE studio_cases SET revision=?,body=? WHERE id=?")
    .run(value.revision, JSON.stringify(value), caseId);
}
function save(value: unknown) {
  return store().mutate(caseId, mutationSchema.parse(value), () => []);
}
function round() {
  const company = read();
  return save({
    action: "create-application",
    revision: company.revision,
    clientRequestId: randomUUID(),
    title: "Synthetic round",
    kind: "new",
    plannedOn: "",
    criteriaNote: "",
    previousApplicationId: null,
  }).applications.at(-1)!.id;
}
function command(overrides: Partial<ApplicationNumberBindingCommand> = {}) {
  const company = read();
  return applicationNumberBindingCommandSchema.parse({
    action: "record-application-number",
    revision: company.revision,
    clientRequestId: randomUUID(),
    applicationId,
    metadataVersionId: applicationMetadata(company, applicationId)!.metadataVersionId,
    expectedPreviousBindingId:
      auditApplicationNumberBindings(company).heads.get(applicationId)?.id ?? null,
    operation: "bind",
    applicationNumber: "SYNTHETIC-APPLICATION-001",
    recordedBy: "Synthetic reviewer",
    reason: "Manual statement only",
    confirmed: true,
    ...overrides,
  });
}
function correction() {
  const company = read(),
    metadata = applicationMetadata(company, applicationId)!;
  return save({
    action: "correct-application",
    revision: company.revision,
    clientRequestId: randomUUID(),
    applicationId,
    previousVersionId: metadata.metadataVersionId,
    title: "Corrected round",
    kind: "new",
    plannedOn: "",
    criteriaNote: "",
    previousApplicationId: null,
  });
}
async function patch(value: unknown, suffix = "", headers: Record<string, string> = {}) {
  return PATCH(
    new Request("http://localhost:3000/api/studio/cases/" + caseId + suffix, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...headers },
      body: typeof value === "string" ? value : JSON.stringify(value),
    }),
    { params: Promise.resolve({ caseId }) },
  );
}
function fingerprint() {
  const tables = db()
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  return tables.map(({ name }) => {
    if (!/^[a-z_]+$/.test(String(name))) throw Error("Unexpected synthetic table");
    return [
      name,
      db()
        .prepare('SELECT * FROM "' + name + '" ORDER BY 1')
        .all(),
    ];
  });
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "venture-number-test-"));
  state.store = new StudioStore(directory);
  const company = publicEvidenceExportFixture().record;
  company.profile.businessNumber = "123-45-67890";
  caseId = company.id;
  db()
    .prepare("INSERT INTO studio_cases(id,revision,evidence_revision,body) VALUES(?,?,?,?)")
    .run(caseId, company.revision, company.revision, JSON.stringify(company));
  applicationId = round();
  state.external.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      state.external();
      throw Error("Network forbidden");
    }),
  );
  vi.spyOn(store(), "getVentureAccountEnvelope").mockImplementation(() => {
    state.external();
    throw Error("Account forbidden");
  });
});
afterEach(() => {
  state.store?.close();
  const boundary = relative(resolve(tmpdir()), resolve(directory));
  if (isAbsolute(boundary) || !/^venture-number-test-[^\\/]+$/.test(boundary))
    throw Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
  expect(state.external).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("manual application number / real isolated SQLite and route", () => {
  it("old company reads do not add a history or change any database row", async () => {
    const before = fingerprint();
    expect(caseSchema.parse(JSON.parse(body()))).not.toHaveProperty("applicationNumberBindings");
    const response = await GET(new Request("http://localhost:3000/api/studio/cases/" + caseId), {
      params: Promise.resolve({ caseId }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("applicationNumberBindings");
    expect(fingerprint()).toEqual(before);
  });
  it("bind/correct/release and transfer preserve original records and authority", () => {
    const original = command(),
      one = save(original).applicationNumberBindings!.records[0];
    expect(one.origin).toBe("manual");
    expect(one.officialVerification).toBe("unverified");
    expect(one.command).toEqual(original);
    expect(currentApplicationNumberBinding(read(), applicationId).state).toBe("manual-unverified");
    save(command({ applicationNumber: "SYNTHETIC-APPLICATION-002" }));
    expect(findApplicationNumberReplay(read(), original)).toEqual(one);
    save(command({ operation: "release", applicationNumber: null }));
    expect(currentApplicationNumberBinding(read(), applicationId).state).toBe("unassigned");
    const other = round();
    save(
      command({
        applicationId: other,
        metadataVersionId: other,
        expectedPreviousBindingId: null,
        applicationNumber: "SYNTHETIC-APPLICATION-002",
      }),
    );
    expect(read().applicationNumberBindings!.records[0]).toEqual(one);
    expect(auditApplicationNumberBindings(read()).heads.size).toBe(2);
  });
  it("full original command replay precedes CAS and stays unchanged after a later correction", () => {
    const original = command();
    const saved = save(original).applicationNumberBindings!.records[0];
    save(command({ applicationNumber: "CORRECTED-002" }));
    const before = body();
    save(original);
    expect(body()).toBe(before);
    expect(findApplicationNumberReplay(read(), original)).toEqual(saved);
    expect(
      currentApplicationNumberBinding(read(), applicationId).record!.command.applicationNumber,
    ).toBe("CORRECTED-002");
  });
  it.each(["revision", "number", "reason", "round"] as const)(
    "same nonce with changed %s is rejected",
    (kind) => {
      const original = command();
      save(original);
      const changed = { ...original };
      if (kind === "revision") changed.revision++;
      if (kind === "number") changed.applicationNumber = "OTHER";
      if (kind === "reason") changed.reason = "Other manual statement";
      if (kind === "round") changed.applicationId = randomUUID();
      const before = body();
      expect(() => save(changed)).toThrow();
      expect(body()).toBe(before);
    },
  );
  it("legacy request nonce cannot be repurposed, and legacy hash rules stay unchanged", () => {
    const cycle = read().applications[0];
    expect(() => save(command({ clientRequestId: cycle.clientRequestId }))).toThrow();
    const old = {
      action: "create-application" as const,
      revision: 1,
      clientRequestId: randomUUID(),
      title: "Legacy",
      kind: "new" as const,
      plannedOn: "",
      criteriaNote: "",
      previousApplicationId: null,
    };
    expect(applicationInputDigest(old)).toBe(
      applicationInputDigest({ ...old, revision: 999, clientRequestId: randomUUID() }),
    );
  });
  it("another company's original command cannot reuse the first company's record", () => {
    const original = command();
    save(original);
    const second = store().create({ ...read().profile, companyName: "Other synthetic" });
    expect(() => store().mutate(second.id, original, () => [])).toThrow();
    expect(store().get(second.id)).not.toHaveProperty("applicationNumberBindings");
  });
  it.each(["other-round", "old-head", "late-revision", "release-unassigned"] as const)(
    "rejects %s without changing stored bytes",
    (kind) => {
      const old = command();
      save(old);
      let next = command();
      if (kind === "other-round") {
        const other = round();
        next = command({
          applicationId: other,
          metadataVersionId: other,
          expectedPreviousBindingId: null,
        });
      }
      if (kind === "old-head") next.expectedPreviousBindingId = null;
      if (kind === "late-revision") {
        correction();
      }
      if (kind === "release-unassigned") {
        save(command({ operation: "release", applicationNumber: null }));
        next = command({ operation: "release", applicationNumber: null });
      }
      const before = body();
      expect(() => save(next)).toThrow();
      expect(body()).toBe(before);
    },
  );
  it("round correction makes current selection stale, but historical replay survives", () => {
    const original = command();
    const old = save(original).applicationNumberBindings!.records[0];
    correction();
    expect(currentApplicationNumberBinding(read(), applicationId).state).toBe("stale");
    expect(findApplicationNumberReplay(read(), original)).toEqual(old);
    const before = body();
    save(original);
    expect(body()).toBe(before);
    save(command());
    expect(currentApplicationNumberBinding(read(), applicationId).state).toBe("manual-unverified");
  });
  it("company number changes require explicit reaffirmation and preserve the old snapshot", () => {
    const original = command();
    save(original);
    save({
      action: "profile",
      revision: read().revision,
      profile: { ...read().profile, businessNumber: "987-65-43210" },
    });
    expect(currentApplicationNumberBinding(read(), applicationId).state).toBe("stale");
    const old = findApplicationNumberReplay(read(), original)!;
    expect(old.companySnapshot.businessNumber).toBe("123-45-67890");
    save(command());
    expect(read().applicationNumberBindings!.records[0]).toEqual(old);
    expect(currentApplicationNumberBinding(read(), applicationId).state).toBe("manual-unverified");
  });
  it("missing company number cannot create a new association", () => {
    save({
      action: "profile",
      revision: read().revision,
      profile: { ...read().profile, businessNumber: "" },
    });
    const before = body();
    expect(() => save(command())).toThrow();
    expect(body()).toBe(before);
  });
  it.each([
    "head",
    "tail",
    "middle",
    "order",
    "duplicate",
    "digest",
    "parent",
    "case",
    "cycle",
    "metadata",
    "orphan",
  ] as const)("audits %s damage before replay of the original command", (kind) => {
    const original = command();
    save(original);
    correction();
    save(command({ applicationNumber: "SECOND" }));
    save(command({ operation: "release", applicationNumber: null }));
    edit((company) => {
      const h = company.applicationNumberBindings!;
      if (kind === "head") h.headId = randomUUID();
      if (kind === "tail") h.records.pop();
      if (kind === "middle") h.records.splice(1, 1);
      if (kind === "order") h.records.reverse();
      if (kind === "duplicate") h.records.push(structuredClone(h.records[0]));
      if (kind === "digest") h.records[2].recordDigest = "0".repeat(64);
      if (kind === "parent") h.records[2].command.expectedPreviousBindingId = h.records[0].id;
      if (kind === "case") h.records[2].caseId = randomUUID();
      if (kind === "cycle") company.applications[0].title = "Damaged base";
      if (kind === "metadata") company.applicationEvents = [];
      if (kind === "orphan") company.applications = [];
    });
    const before = body();
    expect(() => save(original)).toThrow();
    expect(body()).toBe(before);
  });
  it("total binding history loss at a later revision remains a stale request, never a new append", () => {
    const original = command();
    save(original);
    edit((company) => {
      delete company.applicationNumberBindings;
    });
    const before = body();
    expect(() => save(original)).toThrow();
    expect(body()).toBe(before);
  });
  it("returned history and lookup copies do not mutate stored or caller data", () => {
    const input = command(),
      caller = structuredClone(input);
    const output = save(input);
    input.applicationNumber = "MUTATED";
    const copy = findApplicationNumberReplay(read(), caller)!;
    copy.command.reason = "MUTATED";
    output.applicationNumberBindings!.records[0].companySnapshot.companyName = "MUTATED";
    expect(read().applicationNumberBindings!.records[0].command).toEqual(caller);
  });
  it("writer is inside the existing SQL write lock", () => {
    const other = new DatabaseSync(join(directory, "studio.sqlite"));
    other.exec("PRAGMA busy_timeout=0");
    const exec = db().exec.bind(db());
    const spy = vi.spyOn(db(), "exec").mockImplementation((sql) => {
      const result = exec(sql);
      if (sql === "BEGIN IMMEDIATE") expect(() => other.exec("BEGIN IMMEDIATE")).toThrow();
      return result;
    });
    try {
      save(command());
    } finally {
      spy.mockRestore();
      other.close();
    }
  });
  it("two independent stores using the same revision cannot both append", () => {
    const original = command(),
      second = { ...original, clientRequestId: randomUUID(), applicationNumber: "SECOND" };
    const other = new StudioStore(directory);
    try {
      save(original);
      expect(() => other.mutate(caseId, second, () => [])).toThrow();
      const before = body();
      other.mutate(caseId, original, () => []);
      expect(body()).toBe(before);
    } finally {
      other.close();
    }
  });
  it("COMMIT failure rolls back number/history/revision together", () => {
    const original = command(),
      before = body(),
      exec = db().exec.bind(db());
    const spy = vi.spyOn(db(), "exec").mockImplementation((sql) => {
      if (sql === "COMMIT") throw Error("before COMMIT");
      return exec(sql);
    });
    expect(() => save(original)).toThrow();
    spy.mockRestore();
    expect(body()).toBe(before);
    save(original);
    expect(read().applicationNumberBindings!.records).toHaveLength(1);
  });
  it("lost acknowledgement and SQLite reopening recover the original record without a second revision", () => {
    const original = command();
    const internal = store() as unknown as { update: (...args: unknown[]) => unknown };
    const update = internal.update.bind(internal);
    const spy = vi.spyOn(internal, "update").mockImplementationOnce((...args) => {
      update(...args);
      throw Error("ack lost");
    });
    expect(() => save(original)).toThrow();
    spy.mockRestore();
    const before = body();
    store().close();
    state.store = new StudioStore(directory);
    save(original);
    expect(body()).toBe(before);
    expect(read().applicationNumberBindings!.records).toHaveLength(1);
  });
  it("existing official-input company lock blocks even a replay", async () => {
    const original = command();
    save(original);
    const before = body();
    await withVentureInputCompanyLock(caseId, async () => expect(() => save(original)).toThrow());
    expect(body()).toBe(before);
  });
  it("preserves all other case fields, evidence revision, enabled automation and DDL", () => {
    save({
      action: "set-preparation-automation",
      revision: read().revision,
      clientRequestId: randomUUID(),
      expectedSettingVersion: 0,
      enabled: true,
    });
    const before = read(),
      rawBefore = JSON.parse(body()),
      tables = fingerprint();
    const ddl = db().prepare("SELECT * FROM sqlite_master ORDER BY name").all();
    const evidence = db()
      .prepare("SELECT evidence_revision FROM studio_cases WHERE id=?")
      .get(caseId);
    const after = save(command());
    const strip = (v: StudioCase) => {
      const c = structuredClone(v);
      delete c.applicationNumberBindings;
      Reflect.deleteProperty(c, "revision");
      Reflect.deleteProperty(c, "updatedAt");
      return c;
    };
    expect(strip(after)).toEqual(strip(before));
    expect(strip(JSON.parse(body()))).toEqual(strip(rawBefore));
    expect(
      db().prepare("SELECT evidence_revision FROM studio_cases WHERE id=?").get(caseId),
    ).toEqual(evidence);
    expect(db().prepare("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(ddl);
    expect(fingerprint().filter(([name]) => name !== "studio_cases")).toEqual(
      tables.filter(([name]) => name !== "studio_cases"),
    );
  });
  it.each([
    { confirmed: false },
    { receiptNumber: "NOT-APPLICATION" },
    { observation: { origin: "page-observation" } },
    { applicationNumber: " MASKED*" },
    { applicationNumber: "A\nB" },
    { applicationNumber: "N".repeat(201) },
    { operation: "release", applicationNumber: "NUMBER" },
    { reason: " " },
    { arbitrary: true },
  ])("strict local PATCH rejects unsupported command %#", async (extra) => {
    const before = body(),
      response = await patch({ ...command(), ...extra });
    expect(response.status).toBe(400);
    expect(body()).toBe(before);
  });
  it("explicit PATCH works with no-store and no other writes", async () => {
    const response = await patch(command());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const received = await response.json();
    expect(received.applicationNumberBindings.records).toHaveLength(1);
    expect(received.applicationNumberBindings.records[0].officialVerification).toBe("unverified");
  });
  it.each(["query", "origin", "type", "bytes"] as const)("route rejects %s", async (kind) => {
    const before = body();
    const response =
      kind === "query"
        ? await patch(command(), "?x=1")
        : kind === "origin"
          ? await patch(command(), "", { origin: "https://example.invalid" })
          : kind === "type"
            ? await patch(command(), "", { "content-type": "text/plain" })
            : await patch(JSON.stringify(command()) + " ".repeat(applicationLimits.requestBytes));
    expect(response.status).toBe({ query: 400, origin: 403, type: 415, bytes: 413 }[kind]);
    expect(body()).toBe(before);
  });
  it("new history adds to the existing shared text limit rather than expanding it", () => {
    save(command({ reason: "R".repeat(2000) }));
    const company = read(),
      entry = company.applicationNumberBindings!.records[0];
    company.applicationNumberBindings!.records = Array.from({ length: 100 }, () =>
      structuredClone(entry),
    );
    expect(() => assertApplicationCapacity(company)).toThrow();
    expect(applicationLimits.text).toBe(200_000);
  });
  it("binding schema retains a hard 200 record cap", () => {
    save(command());
    const history = read().applicationNumberBindings!;
    expect(
      applicationNumberBindingHistorySchema.safeParse({
        ...history,
        records: Array(201).fill(history.records[0]),
      }).success,
    ).toBe(false);
  });
  it("builder cannot append an existing command or invent a current round version", () => {
    const original = command();
    save(original);
    const context = { id: randomUUID(), recordedAt: new Date().toISOString() };
    expect(() => buildApplicationNumberBinding(read(), original, context)).toThrow();
    expect(() =>
      buildApplicationNumberBinding(read(), command({ metadataVersionId: randomUUID() }), context),
    ).toThrow();
  });
  it("manual literal application identifiers do not silently normalize", () => {
    save(command({ applicationNumber: "Manual-a-001" }));
    const other = round();
    save(
      command({
        applicationId: other,
        metadataVersionId: other,
        expectedPreviousBindingId: null,
        applicationNumber: "Manual-A-001",
      }),
    );
    expect(auditApplicationNumberBindings(read()).heads.size).toBe(2);
  });
  it("200 stored bindings permit replay but refuse record 201", () => {
    let company = read();
    const original = command();
    let last: string | null = null;
    for (let i = 0; i < 200; i++) {
      const input = {
        ...original,
        revision: company.revision,
        clientRequestId: i === 0 ? original.clientRequestId : randomUUID(),
        expectedPreviousBindingId: last,
      };
      const history = buildApplicationNumberBinding(company, input, {
        id: randomUUID(),
        recordedAt: new Date().toISOString(),
      });
      company = { ...company, revision: company.revision + 1, applicationNumberBindings: history };
      last = history.headId;
    }
    expect(findApplicationNumberReplay(company, original)?.command).toEqual(original);
    expect(() =>
      buildApplicationNumberBinding(
        company,
        {
          ...original,
          revision: company.revision,
          clientRequestId: randomUUID(),
          expectedPreviousBindingId: last,
        },
        { id: randomUUID(), recordedAt: new Date().toISOString() },
      ),
    ).toThrow();
    expect(company.applicationNumberBindings!.records).toHaveLength(200);
  }, 15000);
  it("shared 8 MiB limit includes the new history beside valid submission snapshots", () => {
    save(command({ reason: "R".repeat(2000) }));
    const company = read(),
      binding = company.applicationNumberBindings!;
    delete company.applicationNumberBindings;
    const plan = company.plans[0];
    const createSubmission = () => {
      const id = randomUUID();
      return applicationEventSchema.parse({
        id,
        kind: "submission-recorded",
        clientRequestId: randomUUID(),
        inputDigest: "a".repeat(64),
        recordedAt: "2026-10-05T00:00:00Z",
        origin: "manual",
        applicationId,
        submissionRecordId: id,
        previousVersionId: null,
        version: 1,
        occurredOn: "2026-10-05",
        recordedBy: "Synthetic",
        note: "",
        claim: "reported-submitted",
        officialVerification: "unverified",
        companySnapshot: {
          caseId,
          revision: company.revision,
          companyName: "Synthetic",
          businessNumber: "1234567890",
        },
        plan: {
          id: plan.id,
          version: 1,
          generatedAt: plan.generatedAt,
          mode: "manual",
          candidateId: "synthetic",
          sourceRevision: 1,
          contentSha256: "a".repeat(64),
          confirmedAt: null,
          review: [],
          sections: [],
          latestVersion: false,
          currentEvidence: false,
        },
        evidence: [],
        originals: [],
        owners: [],
        receiptRecordId: null,
      });
    };
    const evidence = (characters: number) =>
      Array.from({ length: Math.ceil(characters / 1500) }, (_, index) => ({
        sectionKey: "market",
        sourceId: "synthetic",
        sourceName: null,
        sourceUpdatedAt: null,
        quote: "X".repeat(Math.min(1500, characters - index * 1500)),
        locator: "",
        state: "matched" as const,
      }));
    const size = () =>
      Buffer.byteLength(
        JSON.stringify({
          applications: company.applications,
          applicationEvents: company.applicationEvents,
        }),
      );
    const target = applicationLimits.historyBytes - 1000;
    for (;;) {
      const entry = createSubmission();
      if (entry.kind !== "submission-recorded") throw Error("fixture kind");
      entry.evidence = evidence(300_000);
      company.applicationEvents.push(entry);
      if (size() > target) {
        let low = 0,
          high = 300_000;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          entry.evidence = evidence(middle);
          if (size() <= target) low = middle;
          else high = middle - 1;
        }
        entry.evidence = evidence(low);
        break;
      }
    }
    expect(size()).toBeGreaterThan(target - 200);
    expect(() => caseSchema.parse(company)).not.toThrow();
    expect(() => assertApplicationCapacity(company)).not.toThrow();
    company.applicationNumberBindings = binding;
    expect(() => assertApplicationCapacity(company)).toThrow();
  });
});
