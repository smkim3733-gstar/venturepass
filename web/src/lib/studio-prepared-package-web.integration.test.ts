import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GET as listRoute,
  POST as preserveRoute,
} from "@/app/api/studio/cases/[caseId]/prepared-packages/route";
import { GET as getRoute } from "@/app/api/studio/cases/[caseId]/prepared-packages/[packageId]/route";
import { GET as downloadRoute } from "@/app/api/studio/cases/[caseId]/prepared-packages/[packageId]/download/route";
import { DELETE as deleteCaseRoute } from "@/app/api/studio/cases/[caseId]/route";
import {
  MemoryOriginalStore,
  originalObjectKey,
  preparedPackageObjectKey,
} from "./studio-original-store";
import {
  ensureVenturePassSchema,
  PostgresCaseRowRepository,
  type SqlExecutor,
} from "./studio-postgres-repository";
import { PostgresPreparedPackageRepository } from "./studio-prepared-package-repository";
import { MAX_PREPARED_PACKAGES } from "./studio-prepared-package-types";
import { configureServerRuntime, type StudioPrincipal } from "./studio-request-scope";
import { emptyProfile, type Candidate, type SourceDocument } from "./studio-schema";
import { StudioStore } from "./studio-storage";

vi.mock("server-only", () => ({}));

const origin = "https://venturepass.test";
const orgA = randomUUID();
const orgB = randomUUID();
const principal = (organizationId: string, role: StudioPrincipal["role"]): StudioPrincipal => ({
  userId: randomUUID(),
  organizationId,
  role,
  displayName: "가상 담당",
});
const principals: Record<string, StudioPrincipal> = {
  "a-admin": principal(orgA, "admin"),
  "a-editor": principal(orgA, "editor"),
  "a-viewer": principal(orgA, "viewer"),
  "b-editor": principal(orgB, "editor"),
};
const originalBytes = new TextEncoder().encode("%PDF-1.7\nSYNTHETIC PRESERVED ORIGINAL");
const quote = "이 문장은 합성 보관본 원문의 정확한 인용입니다.";
const candidate: Candidate = {
  id: "synthetic-candidate",
  title: "시험 아이템",
  problem: "시험 문제",
  solution: "시험 해결",
  targetCustomer: "시험 고객",
  differentiation: "확인 필요",
  stage: "구상",
  businessModel: "확인 필요",
  recommendation: "확인 필요",
  evidence: [],
  gaps: [],
};
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

let directory: string;
let database: PGlite;
let executor: SqlExecutor;
let objects: MemoryOriginalStore;
let caseId: string;
let revision: number;
let planId: string;
let sourceId: string;

/** A company with an uploaded original and a generated plan, made with the PC store code. */
function seedCompany() {
  const store = new StudioStore(directory);
  try {
    let company = store.create({ ...emptyProfile(), companyName: "가상 보관본 회사" });
    const now = new Date().toISOString();
    const source: SourceDocument = {
      id: randomUUID(),
      name: "합성 근거",
      kind: "technology",
      text: quote,
      originalName: "selected.pdf",
      mimeType: "application/pdf",
      extraction: "local",
      warnings: [],
      createdAt: now,
      updatedAt: now,
    };
    company = store.addUpload(company.id, company.revision, source, originalBytes);
    company = store.saveAnalysis(
      company.id,
      company.revision,
      { summary: "분석", facts: [], candidates: [candidate], questions: [], warnings: [] },
      "assisted",
    );
    company = store.mutate(
      company.id,
      {
        action: "select-candidate",
        revision: company.revision,
        clientRequestId: randomUUID(),
        candidateId: candidate.id,
        analysisGeneratedAt: company.analysis!.generatedAt,
        analysisSourceRevision: company.analysis!.sourceRevision,
        expectedSelectedCandidateId: company.selectedCandidateId,
        reason: "합성 후보 선택 근거",
      },
      () => [],
    );
    company = store.saveGeneratedPlan(
      company.id,
      company.revision,
      candidate.id,
      {
        title: "합성 계획",
        summary: "합성 원고 본문",
        sections: [
          {
            key: "solution",
            title: "기술 구상",
            content: "합성 구상",
            evidence: [{ sourceId: source.id, quote, locator: "본문 1문단" }],
            needsConfirmation: true,
          },
        ],
        actionItems: [],
        interviewQuestions: [],
      },
      [],
      "assisted",
    );
    return {
      row: store.exportCaseRow(company.id),
      sourceId: source.id,
      planId: company.plans[0].id,
    };
  } finally {
    store.close();
  }
}

function request(path: string, user: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-test-user", user);
  if (init.method && init.method !== "GET") headers.set("origin", origin);
  return new Request(`${origin}${path}`, { ...init, headers });
}
const base = () => `/api/studio/cases/${caseId}/prepared-packages`;
const body = (overrides: Record<string, unknown> = {}) => ({
  revision,
  planId,
  sourceIds: [sourceId],
  clientRequestId: randomUUID(),
  ...overrides,
});
const preserve = (input: Record<string, unknown> = body(), user = "a-editor") =>
  preserveRoute(
    request(base(), user, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
    { params: Promise.resolve({ caseId }) },
  );
const list = (user = "a-editor") =>
  listRoute(request(base(), user), { params: Promise.resolve({ caseId }) });
const getOne = (packageId: string, user = "a-editor") =>
  getRoute(request(`${base()}/${packageId}`, user), {
    params: Promise.resolve({ caseId, packageId }),
  });
const download = (packageId: string, user = "a-editor") =>
  downloadRoute(request(`${base()}/${packageId}/download`, user), {
    params: Promise.resolve({ caseId, packageId }),
  });
const preparedKeys = () => [...objects.objects.keys()].filter((key) => key.includes("/prepared/"));
const rowCount = async () =>
  Number(
    (
      await executor.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM venture_prepared_packages",
      )
    ).rows[0].count,
  );
function runtime(options: { prepared?: boolean; originals?: boolean } = {}) {
  configureServerRuntime({
    origin,
    authenticate: async (value) => principals[value.headers.get("x-test-user") ?? ""] ?? null,
    repositoryFor: (current) => new PostgresCaseRowRepository(executor, current.organizationId),
    preparedPackagesFor:
      options.prepared === false
        ? undefined
        : (current) => new PostgresPreparedPackageRepository(executor, current.organizationId),
    originals: options.originals === false ? undefined : objects,
  });
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "venturepass-web-prepared-"));
  database = new PGlite();
  executor = {
    query: async (text, params) => {
      const result = await database.query(text, params);
      return { rows: result.rows as never[], affectedRows: result.affectedRows ?? 0 };
    },
  };
  await ensureVenturePassSchema(executor);
  for (const [id, name] of [
    [orgA, "합성 조직 A"],
    [orgB, "합성 조직 B"],
  ])
    await executor.query("INSERT INTO venture_organizations (id, name) VALUES ($1, $2)", [
      id,
      name,
    ]);
  const seeded = seedCompany();
  caseId = seeded.row.id;
  revision = seeded.row.revision;
  planId = seeded.planId;
  sourceId = seeded.sourceId;
  await new PostgresCaseRowRepository(executor, orgA).insert(seeded.row);
  objects = new MemoryOriginalStore();
  await objects.put(originalObjectKey(orgA, caseId, sourceId), originalBytes);
  runtime();
});
afterEach(async () => {
  configureServerRuntime(null);
  await database.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("preserved packages (원고·첨부 보관본) on the web service", { timeout: 60_000 }, () => {
  it("stores the record in Postgres and the ZIP privately, and replays the same request", async () => {
    const input = body();
    const response = await preserve(input);
    expect(response.status).toBe(200);
    const { package: record, replayed } = await response.json();
    expect(replayed).toBe(false);
    expect(record.version).toBe(1);
    expect(record.caseRevision).toBe(revision);
    expect(record.sourceIds).toEqual([sourceId]);
    const key = preparedPackageObjectKey(orgA, caseId, record.id);
    expect(preparedKeys()).toEqual([key]);
    const stored = (await objects.get(key))!;
    expect(stored.length).toBe(record.zip.sizeBytes);
    expect(sha(stored)).toBe(record.zip.sha256);
    const zip = await JSZip.loadAsync(stored);
    const files = await Promise.all(
      Object.values(zip.files)
        .filter((file) => !file.dir)
        .map((file) => file.async("uint8array")),
    );
    expect(files.some((file) => Buffer.from(file).equals(Buffer.from(originalBytes)))).toBe(true);
    // The staged original was not uploaded again and the company row did not change.
    expect(objects.objects.size).toBe(2);
    const caseRow = await new PostgresCaseRowRepository(executor, orgA).load(caseId);
    expect(caseRow.revision).toBe(revision);

    const again = await (await preserve(input)).json();
    expect(again.replayed).toBe(true);
    expect(again.package).toEqual(record);
    expect(await rowCount()).toBe(1);
    expect(preparedKeys()).toHaveLength(1);
    const conflict = await preserve({ ...input, sourceIds: [] });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe("PREPARED_REQUEST_CONFLICT");

    const listed = await (await list()).json();
    expect(listed.caseId).toBe(caseId);
    expect(listed.caseRevision).toBe(revision);
    expect(listed.packages).toHaveLength(1);
    expect(listed.packages[0]).toMatchObject({
      id: record.id,
      version: 1,
      zipSha256: record.zip.sha256,
      sizeBytes: record.zip.sizeBytes,
      planId,
    });
    expect((await (await getOne(record.id)).json()).package).toEqual(record);
    expect((await getOne(randomUUID())).status).toBe(404);
  });

  it("downloads through a checked same-origin redirect and refuses a changed ZIP", async () => {
    const { package: record } = await (await preserve()).json();
    const redirect = await download(record.id);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("cache-control")).toContain("no-store");
    expect(redirect.headers.get("x-archive-sha256")).toBe(record.zip.sha256);
    const location = new URL(redirect.headers.get("location")!);
    expect(location.pathname).toContain(`/prepared/${record.id}.zip`);
    expect(location.searchParams.get("download")).toBe("venturepass-preparation-package.zip");
    expect(location.searchParams.get("expires")).toBe("300");
    expect((await download(record.id, "a-viewer")).status).toBe(302);
    expect((await download(record.id, "b-editor")).status).toBe(404);

    const key = preparedPackageObjectKey(orgA, caseId, record.id);
    objects.objects.set(key, new TextEncoder().encode("PK\u0003\u0004 changed"));
    const changed = await download(record.id);
    expect(changed.status).toBe(409);
    expect((await changed.json()).code).toBe("PREPARED_ARCHIVE_CHANGED");
    await objects.remove(key);
    expect((await download(record.id)).status).toBe(409);
  });

  it("keeps at most 20 per company and stores nothing for the 21st", async () => {
    for (let index = 0; index < MAX_PREPARED_PACKAGES; index++)
      expect((await preserve(body({ sourceIds: [] }))).status).toBe(200);
    const listed = await (await list()).json();
    expect(listed.packages.map((item: { version: number }) => item.version)).toEqual(
      Array.from({ length: MAX_PREPARED_PACKAGES }, (_, index) => MAX_PREPARED_PACKAGES - index),
    );
    const full = await preserve();
    expect(full.status).toBe(413);
    expect((await full.json()).code).toBe("PREPARED_PACKAGE_LIMIT");
    expect(await rowCount()).toBe(MAX_PREPARED_PACKAGES);
    expect(preparedKeys()).toHaveLength(MAX_PREPARED_PACKAGES);
  });

  it("refuses a stale revision and lets only one of two racing inserts take a version", async () => {
    const stale = await preserve(body({ revision: revision - 1 }));
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("STALE_REVISION");
    expect(preparedKeys()).toEqual([]);

    // The database insert itself decides a race: one version, one company revision.
    const repository = new PostgresPreparedPackageRepository(executor, orgA);
    const row = (version: number) => ({
      id: randomUUID(),
      caseId,
      version,
      clientRequestId: randomUUID(),
      requestDigest: "a".repeat(64),
      body: "{}",
      bodySha256: "b".repeat(64),
      zipSha256: "c".repeat(64),
      zipSizeBytes: 10,
    });
    expect(await repository.insert(row(2), revision)).toBe(false);
    expect(await repository.insert(row(1), revision + 1)).toBe(false);
    const racing = await Promise.all([
      repository.insert(row(1), revision),
      repository.insert(row(1), revision),
    ]);
    expect(racing.sort()).toEqual([false, true]);
    expect(await repository.count(caseId)).toBe(1);
    await executor.query("DELETE FROM venture_prepared_packages");

    // A request that loses at the insert removes its ZIP again and stores nothing.
    configureServerRuntime({
      origin,
      authenticate: async (value) => principals[value.headers.get("x-test-user") ?? ""] ?? null,
      repositoryFor: (current) => new PostgresCaseRowRepository(executor, current.organizationId),
      preparedPackagesFor: (current) => {
        const inner = new PostgresPreparedPackageRepository(executor, current.organizationId);
        return Object.assign(Object.create(inner), { insert: async () => false });
      },
      originals: objects,
    });
    const lost = await preserve();
    expect(lost.status).toBe(409);
    expect((await lost.json()).code).toBe("STALE_REVISION");
    expect(preparedKeys()).toEqual([]);
    expect(await rowCount()).toBe(0);
    runtime();
    expect((await preserve()).status).toBe(200);
    expect(await rowCount()).toBe(1);
  });

  it("separates organizations and roles and fails closed without storage", async () => {
    expect((await preserve(body(), "a-viewer")).status).toBe(403);
    expect((await list("a-viewer")).status).toBe(200);
    expect((await preserve(body(), "b-editor")).status).toBe(404);
    expect((await list("b-editor")).status).toBe(404);
    const { package: record } = await (await preserve()).json();
    expect((await getOne(record.id, "b-editor")).status).toBe(404);
    // Another organization's repository cannot read or count this company's records.
    const other = new PostgresPreparedPackageRepository(executor, orgB);
    expect(await other.list(caseId)).toEqual([]);
    expect(await other.get(caseId, record.id)).toBeNull();
    expect(await other.count(caseId)).toBe(0);

    runtime({ prepared: false });
    const missingTable = await list();
    expect(missingTable.status).toBe(503);
    expect((await missingTable.json()).code).toBe("PREPARED_NOT_CONFIGURED");
    runtime({ originals: false });
    expect((await preserve()).status).toBe(503);
    expect(await rowCount()).toBe(1);
  });

  it("deletes the records and stored ZIPs with the company", async () => {
    await (await preserve()).json();
    await (await preserve()).json();
    expect(preparedKeys()).toHaveLength(2);
    const response = await deleteCaseRoute(
      request(`/api/studio/cases/${caseId}`, "a-admin", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision }),
      }),
      { params: Promise.resolve({ caseId }) },
    );
    expect(response.status).toBe(200);
    expect(await rowCount()).toBe(0);
    expect(preparedKeys()).toEqual([]);
    expect(objects.objects.size).toBe(0);
  });
});
