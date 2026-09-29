import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { failQualityReceiptInsert } from "./studio-plan-quality-policy-storage-test-helpers";
vi.mock("server-only", () => ({}));
import * as candidates from "./studio-plan-quality-validation-candidates";
import { planQualityEvaluationDigest as digest } from "./studio-plan-quality-evaluation";
import {
  candidateRegistryLimits,
  candidateRegistrySnapshotSchema,
} from "./studio-plan-quality-candidate-registry-types";
import { planQualityStoreLimits } from "./studio-plan-quality-store-types";

const external = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("External IO forbidden");
  }),
);
vi.mock("openai", () => ({
  default: class {
    constructor() {
      external();
    }
  },
}));
vi.mock("./studio-storage", () => ({ getStudioStore: () => external() }));
let directory: string, store: PlanQualityStore;
const originalCandidates = candidates.createPlanQualityValidationCandidates;
function changeBundledSource(label: string) {
  const value = originalCandidates();
  value[0].company.sources[0].text += `\n합성 변경 ${label}`;
  vi.spyOn(candidates, "createPlanQualityValidationCandidates").mockReturnValue(value);
}
function input(expectedVersion = 0) {
  return {
    expectedVersion,
    clientRequestId: randomUUID(),
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true as const,
  };
}
function unsafeDbChange(work: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(join(directory, "quality-evaluation", "quality.sqlite"));
  try {
    work(db);
  } finally {
    db.close();
  }
}
beforeEach(() => {
  external.mockClear();
  vi.stubGlobal("fetch", external);
  directory = mkdtempSync(join(tmpdir(), "venturepass-candidate-registry-"));
  writeFileSync(join(directory, "studio.sqlite"), "DO NOT OPEN COMPANY DATABASE");
  store = new PlanQualityStore(directory);
}, 15000);
afterEach(() => {
  expect(external).not.toHaveBeenCalled();
  expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe(
    "DO NOT OPEN COMPANY DATABASE",
  );
  store.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  const target = resolve(directory),
    rel = relative(resolve(tmpdir()), target);
  if (!rel.startsWith("venturepass-candidate-registry-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(target, { recursive: true, force: true });
}, 15000);

describe("candidate registry immutable local persistence", () => {
  it("registers and reloads exact snapshot and receipt without company or external IO", () => {
    expect(store.candidateRegistryList().versions).toEqual([]);
    const request = input(),
      saved = store.candidateRegistryRegister(request);
    expect(saved.replayed).toBe(false);
    expect(saved.snapshot).toMatchObject({
      version: 1,
      previousVersion: null,
      previousDigest: null,
      humanAnswerKey: null,
    });
    expect(candidateRegistrySnapshotSchema.parse(saved.snapshot)).toEqual(saved.snapshot);
    store.close();
    store = new PlanQualityStore(directory);
    expect(store.candidateRegistryGet(1)).toEqual(saved.snapshot);
    expect(store.candidateRegistryLookup(request.clientRequestId)).toMatchObject({
      state: "committed",
      receipt: { version: 1, versionDigest: saved.snapshot.versionDigest },
    });
    expect(store.candidateRegistryLookup(randomUUID())).toEqual({ state: "not-observed" });
  });
  it("pins changed source as next version while historical download and nonce stay exact", () => {
    const request = input(),
      first = store.candidateRegistryRegister(request).snapshot;
    const archive = store.candidateRegistryDownload(1).body;
    changeBundledSource("v2");
    const second = store.candidateRegistryRegister(input(1)).snapshot;
    expect(second.previousDigest).toBe(first.versionDigest);
    expect(second.previousVersion).toBe(1);
    expect(second.sourceDigest).not.toBe(first.sourceDigest);
    expect(store.candidateRegistryGet(1)).toEqual(first);
    expect(store.candidateRegistryDownload(1).body).toBe(archive);
    expect(store.candidateRegistryRegister(request)).toEqual({ snapshot: first, replayed: true });
  });
  it("rejects nonce scope changes, duplicate source, stale source and CAS without appending", () => {
    const request = input();
    store.candidateRegistryRegister(request);
    expect(() => store.candidateRegistryRegister({ ...request, expectedVersion: 1 })).toThrowError(
      expect.objectContaining({ code: "QUALITY_CANDIDATE_NONCE_CONFLICT" }),
    );
    expect(() => store.candidateRegistryRegister(input(1))).toThrowError(
      expect.objectContaining({ code: "QUALITY_CANDIDATE_ALREADY_REGISTERED" }),
    );
    const old = input(1);
    changeBundledSource("v2");
    expect(() => store.candidateRegistryRegister(old)).toThrowError(
      expect.objectContaining({ code: "QUALITY_CANDIDATE_SOURCE_CHANGED" }),
    );
    expect(() => store.candidateRegistryRegister(input(0))).toThrowError(
      expect.objectContaining({ code: "QUALITY_CANDIDATE_VERSION_CONFLICT" }),
    );
    expect(store.candidateRegistryList().versions).toHaveLength(1);
  });
  it("serializes competing connections and preserves the losing request as unobserved", () => {
    const other = new PlanQualityStore(directory),
      first = input(),
      second = input();
    try {
      store.candidateRegistryRegister(first);
      expect(() => other.candidateRegistryRegister(second)).toThrowError(
        expect.objectContaining({ code: "QUALITY_CANDIDATE_VERSION_CONFLICT" }),
      );
      expect(other.candidateRegistryLookup(second.clientRequestId)).toEqual({
        state: "not-observed",
      });
      expect(other.candidateRegistryRegister(first).replayed).toBe(true);
    } finally {
      other.close();
    }
  });
  it("preserves fixed50 archives and separates both nonce scopes", () => {
    const request = {
      clientRequestId: randomUUID(),
      title: "합성 고정50",
      manifestDigest: store.list().manifestDigest,
    };
    const run = store.create(request).run,
      archive = store.download(run.id, 0).body;
    expect(() =>
      store.candidateRegistryRegister({ ...input(), clientRequestId: request.clientRequestId }),
    ).toThrowError(expect.objectContaining({ code: "QUALITY_CANDIDATE_NONCE_CONFLICT" }));
    const candidateRequest = input();
    store.candidateRegistryRegister(candidateRequest);
    expect(store.download(run.id, 0).body).toBe(archive);
    expect(() =>
      store.create({ ...request, clientRequestId: candidateRequest.clientRequestId }),
    ).toThrowError(expect.objectContaining({ code: "QUALITY_NONCE_CONFLICT" }));
    expect(() =>
      store.save(run.id, {
        revision: 0,
        clientRequestId: candidateRequest.clientRequestId,
        record: run.records[0],
      }),
    ).toThrowError(expect.objectContaining({ code: "QUALITY_NONCE_CONFLICT" }));
  });
  it("does not fabricate success when transaction receipt insertion fails", () => {
    const request = input();
    const failure = failQualityReceiptInsert("quality_candidate_requests");
    expect(() => store.candidateRegistryRegister(request)).toThrow(
      "synthetic receipt insertion failure",
    );
    expect(failure).toHaveBeenCalledOnce();
    expect(store.candidateRegistryList().versions).toEqual([]);
    expect(store.candidateRegistryLookup(request.clientRequestId)).toEqual({
      state: "not-observed",
    });
  });
  it.each(["body", "receipt", "chain"])(
    "rejects %s corruption even with recomputed outer hash",
    (kind) => {
      store.candidateRegistryRegister(input());
      if (kind === "chain") {
        changeBundledSource("v2");
        store.candidateRegistryRegister(input(1));
      }
      unsafeDbChange((db) => {
        const table =
          kind === "receipt" ? "quality_candidate_requests" : "quality_candidate_versions";
        const trigger = db
          .prepare("SELECT sql FROM sqlite_schema WHERE name=?")
          .get(`${table}_no_update`)!.sql as string;
        db.exec(`DROP TRIGGER ${table}_no_update`);
        const row = db
          .prepare(`SELECT rowid,body FROM ${table} ORDER BY rowid DESC LIMIT 1`)
          .get()!;
        const body = JSON.parse(String(row.body));
        if (kind === "body") body.entries[0].input.sources[0].text += "tampered";
        if (kind === "receipt") body.inputDigest = "a".repeat(64);
        if (kind === "chain") body.previousDigest = "a".repeat(64);
        db.prepare(`UPDATE ${table} SET body=?,body_hash=? WHERE rowid=?`).run(
          JSON.stringify(body),
          digest(body),
          row.rowid!,
        );
        db.exec(trigger);
      });
      expect(() => store.candidateRegistryGet(1)).toThrowError(
        expect.objectContaining({ code: "QUALITY_STORAGE_CORRUPT" }),
      );
    },
  );
  it("enforces immutable triggers and notices path restore markers", () => {
    store.candidateRegistryRegister(input());
    unsafeDbChange((db) => {
      for (const table of ["quality_candidate_versions", "quality_candidate_requests"])
        expect(() => db.exec(`DELETE FROM ${table}`)).toThrow(/immutable/);
    });
    writeFileSync(join(directory, "quality-evaluation", ".restore-pending"), "synthetic");
    expect(() => store.candidateRegistryList()).toThrowError(
      expect.objectContaining({ code: "QUALITY_STORAGE_UNSAFE" }),
    );
  });
  it("counts registry bytes in fixed50 and registration shared capacity", () => {
    const first = store.create({
      clientRequestId: randomUUID(),
      title: "합성",
      manifestDigest: store.list().manifestDigest,
    });
    let evaluationBytes = 0,
      registryBytes = 0;
    unsafeDbChange((db) => {
      evaluationBytes = Number(
        db
          .prepare(
            "SELECT (SELECT SUM(length(CAST(body AS BLOB))) FROM quality_runs) + (SELECT SUM(length(CAST(body AS BLOB))) FROM quality_requests) AS bytes",
          )
          .get()!.bytes,
      );
    });
    store.candidateRegistryRegister(input());
    unsafeDbChange((db) => {
      registryBytes = Number(
        db
          .prepare(
            "SELECT (SELECT SUM(length(CAST(body AS BLOB))) FROM quality_candidate_versions) + (SELECT SUM(length(CAST(body AS BLOB))) FROM quality_candidate_requests) AS bytes",
          )
          .get()!.bytes,
      );
    });
    const original = planQualityStoreLimits.totalBytes;
    try {
      Object.assign(planQualityStoreLimits, {
        totalBytes: evaluationBytes * 2 + Math.floor(registryBytes / 2),
      });
      expect(() =>
        store.create({
          clientRequestId: randomUUID(),
          title: "합성",
          manifestDigest: store.list().manifestDigest,
        }),
      ).toThrowError(expect.objectContaining({ code: "QUALITY_STORAGE_LIMIT" }));
      Object.assign(planQualityStoreLimits, {
        totalBytes: evaluationBytes + Math.floor(registryBytes * 1.5),
      });
      changeBundledSource("v2");
      expect(() => store.candidateRegistryRegister(input(1))).toThrowError(
        expect.objectContaining({ code: "QUALITY_STORAGE_LIMIT" }),
      );
      expect(store.candidateRegistryList().versions).toHaveLength(1);
      expect(store.get(first.run.id).revision).toBe(0);
    } finally {
      Object.assign(planQualityStoreLimits, { totalBytes: original });
    }
  });
  it("enforces registration version limit without partial records", () => {
    store.candidateRegistryRegister(input());
    changeBundledSource("v2");
    const limits = { ...candidateRegistryLimits };
    try {
      Object.assign(candidateRegistryLimits, { versions: 1 });
      expect(() => store.candidateRegistryRegister(input(1))).toThrowError(
        expect.objectContaining({ code: "QUALITY_CANDIDATE_VERSION_LIMIT" }),
      );
    } finally {
      Object.assign(candidateRegistryLimits, limits);
    }
    expect(store.candidateRegistryList().versions).toHaveLength(1);
  });
  it("refuses oversized pinned input before writing either version or receipt", () => {
    const request = input(),
      original = candidateRegistryLimits.pinnedBytes;
    Object.assign(candidateRegistryLimits, { pinnedBytes: 1 });
    try {
      expect(() => store.candidateRegistryRegister(request)).toThrowError(
        expect.objectContaining({ code: "QUALITY_CANDIDATE_PIN_LIMIT" }),
      );
      expect(store.candidateRegistryLookup(request.clientRequestId)).toEqual({
        state: "not-observed",
      });
      expect(store.candidateRegistryList().versions).toEqual([]);
    } finally {
      Object.assign(candidateRegistryLimits, { pinnedBytes: original });
    }
  });
});
