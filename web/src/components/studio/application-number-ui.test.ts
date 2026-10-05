import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { StudioStore } from "@/lib/studio-storage";
import { mutationSchema } from "@/lib/studio-schema";
import { publicEvidenceExportFixture } from "@/lib/studio-public-evidence-export-test-helpers";
import {
  readApplicationNumbers,
  inspectApplicationNumberRequest,
} from "@/lib/studio-application-number-read";
import {
  applicationNumberBindingCommandSchema,
  type ApplicationNumberBindingCommand as Command,
} from "@/lib/studio-application-number-types";
import {
  NumberRequestJournal,
  validateNumberStatus,
  type NumberTransport,
  type NumberLock,
} from "./application-number-ui";
import { ApplicationNumberPanel } from "./application-number-panel";
vi.mock("server-only", () => ({}));
const holder = vi.hoisted(() => ({ store: null as StudioStore | null }));
vi.mock("@/lib/studio-storage", async (original) => ({
  ...(await original<typeof import("@/lib/studio-storage")>()),
  getStudioStore: () => holder.store!,
}));
import { GET, POST } from "@/app/api/studio/cases/[caseId]/application-numbers/route";
let directory: string, caseId: string, applicationId: string;
const store = () => holder.store!;
const db = () => (store() as unknown as { db: DatabaseSync }).db;
const company = () => store().get(caseId);
function save(c: Command) {
  return store().mutate(caseId, mutationSchema.parse(c), () => []);
}
function command(): Command {
  const c = company();
  return applicationNumberBindingCommandSchema.parse({
    action: "record-application-number",
    revision: c.revision,
    clientRequestId: randomUUID(),
    applicationId,
    metadataVersionId: applicationId,
    expectedPreviousBindingId: c.applicationNumberBindings?.records.at(-1)?.id ?? null,
    operation: "bind",
    applicationNumber: "SYNTHETIC-REQ-1",
    recordedBy: "Synthetic reviewer",
    reason: "Manual only",
    confirmed: true,
  });
}
const rows = () =>
  ["studio_cases", "studio_prepared_packages", "venture_accounts", "venture_workflows"].map(
    (name) =>
      db()
        .prepare('SELECT * FROM "' + name + '" ORDER BY 1')
        .all(),
  );
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "venture-number-ui-"));
  holder.store = new StudioStore(directory);
  const c = publicEvidenceExportFixture().record;
  c.profile.businessNumber = "1234567890";
  caseId = c.id;
  db()
    .prepare("INSERT INTO studio_cases(id,revision,evidence_revision,body) VALUES(?,?,?,?)")
    .run(c.id, c.revision, c.revision, JSON.stringify(c));
  const next = store().mutate(
    caseId,
    mutationSchema.parse({
      action: "create-application",
      revision: c.revision,
      clientRequestId: randomUUID(),
      title: "Synthetic round",
      kind: "new",
      plannedOn: "",
      criteriaNote: "",
      previousApplicationId: null,
    }),
    () => [],
  );
  applicationId = next.applications.at(-1)!.id;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw Error("Network forbidden");
    }),
  );
  vi.spyOn(store(), "getVentureAccountEnvelope").mockImplementation(() => {
    throw Error("Account forbidden");
  });
});
afterEach(() => {
  holder.store?.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  const boundary = relative(resolve(tmpdir()), resolve(directory));
  if (isAbsolute(boundary) || !/^venture-number-ui-[^\\/]+$/.test(boundary))
    throw Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});
function harness() {
  const data = new Map<string, string>();
  let locked = false;
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    removeItem: (k: string) => {
      data.delete(k);
    },
  };
  const lock: NumberLock = async (_name, task) => {
    if (locked) throw Error("Locked");
    locked = true;
    try {
      return await task();
    } finally {
      locked = false;
    }
  };
  let mode: "ok" | "after-commit" | "before-commit" | "read-error" = "ok",
    writes = 0;
  const transport: NumberTransport = async (action, c) => {
    if (action === "write") {
      writes++;
      if (mode === "before-commit") throw Error("Lost before");
      save(c!);
      if (mode === "after-commit") throw Error("Lost after");
      return company();
    }
    if (action === "inspect") return inspectApplicationNumberRequest(company(), c!);
    if (mode === "read-error") throw Error("Lost read");
    return readApplicationNumbers(company());
  };
  return {
    data,
    storage,
    lock,
    transport,
    create: () => new NumberRequestJournal(caseId, storage, lock, transport),
    mode: (v: typeof mode) => {
      mode = v;
    },
    writes: () => writes,
  };
}
it("audited GET is keyless, query-free, no-store, isolated and leaves four tables unchanged", async () => {
  const before = rows();
  const r = await GET(
    new Request("http://localhost:3000/api/studio/cases/" + caseId + "/application-numbers"),
    { params: Promise.resolve({ caseId }) },
  );
  expect(r.status).toBe(200);
  expect(r.headers.get("cache-control")).toContain("no-store");
  const s = await validateNumberStatus(await r.json(), caseId);
  expect(s.records).toEqual([]);
  expect(s.company).not.toHaveProperty("applicationNumberBindings");
  s.company.profile.companyName = "changed";
  expect(company().profile.companyName).not.toBe("changed");
  expect(rows()).toEqual(before);
});
it("SSR renders no network, save, storage or automatic approval", () => {
  const before = rows();
  const html = renderToStaticMarkup(
    createElement(ApplicationNumberPanel, {
      company: company(),
      blockedReason: "",
      onDirtyChange: () => {},
      onCompany: () => {},
      onClose: () => {},
    }),
  );
  expect(html).toContain("担当".replace("担当", "담당"));
  expect(html).not.toContain('checked=""');
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(rows()).toEqual(before);
});
it.each(["query", "origin", "content-type", "extra", "over-limit", "supplied"])(
  "inspection rejects %s without writes",
  async (kind) => {
    const before = rows();
    let input: unknown = { action: "inspect-original-request", command: command() };
    if (kind === "extra") input = { ...(input as object), confirmed: true };
    if (kind === "supplied")
      input = { ...(input as object), observation: { origin: "page-observation" } };
    const request = new Request(
      "http://localhost:3000/api/studio/cases/" +
        caseId +
        "/application-numbers" +
        (kind === "query" ? "?x=1" : ""),
      {
        method: "POST",
        headers: {
          "Content-Type": kind === "content-type" ? "text/plain" : "application/json",
          ...(kind === "origin" ? { Origin: "https://example.com" } : {}),
        },
        body: kind === "over-limit" ? " ".repeat(65537) : JSON.stringify(input),
      },
    );
    const r = await POST(request, { params: Promise.resolve({ caseId }) });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(rows()).toEqual(before);
  },
);
it("same revision missing receipt stays unknown; later revision is closeable; receipt wins after correction", () => {
  const c = command();
  expect(inspectApplicationNumberRequest(company(), c).outcome).toBe("unconfirmed");
  save(c);
  save({ ...command(), applicationNumber: "SYNTHETIC-REQ-2" });
  const before = rows();
  const result = inspectApplicationNumberRequest(company(), c);
  expect(result.outcome).toBe("recorded");
  expect(result.receipt?.command).toEqual(c);
  expect(result.current[0].record?.command.applicationNumber).toBe("SYNTHETIC-REQ-2");
  expect(rows()).toEqual(before);
});
it("lost original round cannot prove non-storage", () => {
  const c = command();
  const changed = company();
  changed.revision++;
  changed.applications = [];
  expect(inspectApplicationNumberRequest(changed, c).outcome).toBe("unconfirmed");
});
it("damaged history is rejected before original request recovery", () => {
  const c = command();
  save(c);
  const changed = company();
  changed.applicationNumberBindings!.headDigest = "f".repeat(64);
  expect(() => readApplicationNumbers(changed)).toThrow();
  expect(() => inspectApplicationNumberRequest(changed, c)).toThrow();
});
it.each([
  "wrong-company",
  "old-revision",
  "permission",
  "extra",
  "record-copy",
  "current",
  "digest",
  "command",
])("client rejects %s response", async (kind) => {
  save(command());
  const s = structuredClone(readApplicationNumbers(company()));
  if (kind === "wrong-company") s.company.id = randomUUID();
  if (kind === "old-revision") s.company.revision = 0;
  if (kind === "permission") Object.assign(s, { transmissionAllowed: true });
  if (kind === "extra") Object.assign(s, { observation: {} });
  if (kind === "record-copy") s.records = [];
  if (kind === "current") s.current[0].state = "unassigned";
  if (kind === "digest") {
    s.records[0].recordDigest = "0".repeat(64);
    s.company.applicationNumberBindings!.records[0].recordDigest = "0".repeat(64);
  }
  if (kind === "command") {
    s.records[0].command.reason = "Other";
    s.company.applicationNumberBindings!.records[0].command.reason = "Other";
  }
  await expect(validateNumberStatus(s, caseId, 1)).rejects.toThrow();
});
it("one explicit write is followed by audited GET, and normal acknowledgement clears journal", async () => {
  const h = harness(),
    j = h.create(),
    c = command();
  const before = company();
  await j.read();
  expect(h.writes()).toBe(0);
  const r = await j.execute(c);
  expect(r.receipt?.command).toEqual(c);
  expect(await j.pending()).toBeNull();
  expect(h.writes()).toBe(1);
  const after = company();
  expect(after.plans).toEqual(before.plans);
  expect(after.sources).toEqual(before.sources);
  expect(after.agencyRecords).toEqual(before.agencyRecords);
});
it("response loss after COMMIT recovers with a new journal and read, never another write", async () => {
  const h = harness();
  h.mode("after-commit");
  const c = command();
  const transport: NumberTransport = async (action, value) => {
    if (action === "read" && company().revision > c.revision) throw Error("Read lost");
    return h.transport(action, value);
  };
  await expect(
    new NumberRequestJournal(caseId, h.storage, h.lock, transport).execute(c),
  ).rejects.toThrow();
  expect(h.data.size).toBe(1);
  store().close();
  holder.store = new StudioStore(directory);
  const r = await h.create().read();
  expect(r.receipt?.command).toEqual(c);
  expect(r.pending).toBeNull();
  expect(h.writes()).toBe(1);
});
it("loss before save stays pending, same original explicit retry makes one record", async () => {
  const h = harness(),
    c = command();
  h.mode("before-commit");
  const r = await h.create().execute(c);
  expect(r.pending).toEqual(c);
  expect(r.receipt).toBeNull();
  await h.create().read();
  expect(h.writes()).toBe(1);
  h.mode("ok");
  const saved = await h.create().execute(c, true);
  expect(saved.receipt?.command).toEqual(c);
  expect(company().applicationNumberBindings?.records).toHaveLength(1);
});
it.each(["different-command", "new-command", "missing-pending"])(
  "pending guard rejects %s",
  async (kind) => {
    const h = harness(),
      c = command();
    h.mode("before-commit");
    if (kind !== "missing-pending") await h.create().execute(c);
    const writes = h.writes();
    await expect(
      h
        .create()
        .execute(
          kind === "different-command" ? { ...c, reason: "Changed" } : c,
          kind !== "new-command",
        ),
    ).rejects.toThrow();
    expect(h.writes()).toBe(writes);
  },
);
it.each([
  "set-failure",
  "readback-mismatch",
  "corrupt-json",
  "extra-field",
  "wrong-case",
  "digest",
  "oversize",
])("storage %s blocks before sending", async (kind) => {
  const h = harness(),
    c = command();
  if (kind === "set-failure")
    h.storage.setItem = () => {
      throw Error("Quota");
    };
  if (kind === "readback-mismatch") h.storage.setItem = () => {};
  if (!["set-failure", "readback-mismatch"].includes(kind)) {
    h.mode("before-commit");
    await h.create().execute(c);
    const [key, value] = [...h.data][0],
      entry = JSON.parse(value);
    if (kind === "extra-field") entry.extra = true;
    if (kind === "wrong-case") entry.caseId = randomUUID();
    if (kind === "digest") entry.sha256 = "0".repeat(64);
    h.data.set(
      key,
      kind === "corrupt-json"
        ? "{"
        : kind === "oversize"
          ? "x".repeat(32769)
          : JSON.stringify(entry),
    );
  }
  const writes = h.writes();
  await expect(h.create().execute(c)).rejects.toThrow();
  expect(h.writes()).toBe(writes);
});
it("caller mutation while awaiting the lock cannot change sent original bytes", async () => {
  const h = harness(),
    c = command(),
    copy = structuredClone(c);
  let go!: () => void;
  const lock: NumberLock = async (_n, task) => {
    await new Promise<void>((r) => {
      go = r;
    });
    return task();
  };
  const promise = new NumberRequestJournal(caseId, h.storage, lock, h.transport).execute(c);
  c.reason = "tampered";
  go();
  const result = await promise;
  expect(result.receipt?.command).toEqual(copy);
});
it("two simultaneous tabs allow one write, and the other request is rejected", async () => {
  const h = harness(),
    c = command();
  const a = h.create().execute(c);
  await expect(h.create().execute(c)).rejects.toThrow();
  await a;
  expect(h.writes()).toBe(1);
});
it("old successful request can be recovered after another correction without rolling it back", async () => {
  const h = harness(),
    c = command();
  h.mode("before-commit");
  await h.create().execute(c);
  save(c);
  save({ ...command(), applicationNumber: "SECOND" });
  const before = rows();
  const r = await h.create().read();
  expect(r.receipt?.command).toEqual(c);
  expect(r.status.current[0].record?.command.applicationNumber).toBe("SECOND");
  expect(rows()).toEqual(before);
});
it("closure requires stale CAS, exact original, separate confirmation and unchanged displayed revision", async () => {
  const h = harness(),
    c = command();
  h.mode("before-commit");
  await h.create().execute(c);
  const same = await h.create().inspectClosure(c);
  expect(same.outcome).toBe("unconfirmed");
  expect(() => h.create().close(same, true)).toThrow();
  save({ ...command(), clientRequestId: randomUUID(), applicationNumber: "OTHER" });
  const close = await h.create().inspectClosure(c);
  expect(close.outcome).toBe("not-recorded-stale");
  expect(() => h.create().close(close, false)).toThrow();
  save({ ...command(), applicationNumber: "NEWER" });
  await expect(h.create().close(close, true)).rejects.toThrow();
  expect(await h.create().pending()).toEqual(c);
  const next = await h.create().inspectClosure(c),
    before = rows();
  await h.create().close(next, true);
  expect(await h.create().pending()).toBeNull();
  expect(rows()).toEqual(before);
});
it("receipt appearing before closure wins, never claims non-storage", async () => {
  const h = harness(),
    c = command();
  h.mode("before-commit");
  await h.create().execute(c);
  // A displayed stale inspection is forged for this race; server reinspection remains authoritative.
  const fake = {
    ...inspectApplicationNumberRequest(company(), c),
    outcome: "not-recorded-stale" as const,
  };
  save(c);
  const r = await h.create().close(fake, true);
  expect(r.outcome).toBe("recorded");
  expect(await h.create().pending()).toBeNull();
});
it("failed journal removal retains the pending command for the next audited GET", async () => {
  const h = harness(),
    c = command();
  h.storage.removeItem = () => {
    throw Error("Read only");
  };
  await expect(h.create().execute(c)).rejects.toThrow();
  expect(await h.create().pending()).toEqual(c);
  expect(company().applicationNumberBindings?.records).toHaveLength(1);
});
