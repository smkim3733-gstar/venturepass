import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as packageRoute } from "@/app/api/studio/cases/[caseId]/package/route";
import { GET as exportRoute } from "@/app/api/studio/cases/[caseId]/package/exports/[exportId]/route";
import { POST as visitRoute } from "@/app/api/studio/cases/[caseId]/visit-package/route";
import { GET as visitExportRoute } from "@/app/api/studio/cases/[caseId]/visit-package/exports/[exportId]/route";
import { MemoryCaseRowRepository, runCaseSession } from "./studio-case-session";
import {
  exportObjectKey,
  exportPrefix,
  MemoryOriginalStore,
  originalObjectKey,
} from "./studio-original-store";
import { PACKAGE_DOWNLOAD_NAME } from "./studio-package-types";
import { VISIT_PACKAGE_DOWNLOAD_NAME } from "./studio-visit-package-types";
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
  "a-editor": principal(orgA, "editor"),
  "a-viewer": principal(orgA, "viewer"),
  "b-editor": principal(orgB, "editor"),
};
const originalBytes = new TextEncoder().encode("%PDF-1.7\nSYNTHETIC WEB ORIGINAL");
const quote = "이 문장은 합성 원문의 정확한 인용입니다.";
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

let directory: string;
let repositories: Map<string, MemoryCaseRowRepository>;
let objects: MemoryOriginalStore;
let caseId: string;
let revision: number;
let planId: string;
let sourceId: string;

/** A company with an uploaded original and a generated plan, made with the PC store code. */
function seedCompany() {
  const store = new StudioStore(directory);
  try {
    let company = store.create({ ...emptyProfile(), companyName: "가상 웹 묶음 회사" });
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
const makePackage = (user = "a-editor") =>
  packageRoute(
    request(`/api/studio/cases/${caseId}/package`, user, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision, planId, sourceIds: [sourceId] }),
    }),
    { params: Promise.resolve({ caseId }) },
  );
const download = (exportId: string, user = "a-editor") =>
  exportRoute(request(`/api/studio/cases/${caseId}/package/exports/${exportId}`, user), {
    params: Promise.resolve({ caseId, exportId }),
  });
const exportKeys = () => [...objects.objects.keys()].filter((key) => key.includes("/exports/"));
function runtime(originals: MemoryOriginalStore | null = objects) {
  configureServerRuntime({
    origin,
    authenticate: async (value) => principals[value.headers.get("x-test-user") ?? ""] ?? null,
    repositoryFor: (current) => repositories.get(current.organizationId)!,
    originals: originals ?? undefined,
  });
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "venturepass-web-package-"));
  const seeded = seedCompany();
  caseId = seeded.row.id;
  revision = seeded.row.revision;
  planId = seeded.planId;
  sourceId = seeded.sourceId;
  repositories = new Map([
    [orgA, new MemoryCaseRowRepository()],
    [orgB, new MemoryCaseRowRepository()],
  ]);
  await repositories.get(orgA)!.insert(seeded.row);
  objects = new MemoryOriginalStore();
  await objects.put(originalObjectKey(orgA, caseId, sourceId), originalBytes);
  runtime();
});
afterEach(() => {
  configureServerRuntime(null);
  rmSync(directory, { recursive: true, force: true });
});

describe("submission package ZIP on the web service", { timeout: 30_000 }, () => {
  it("builds the ZIP from stored originals, keeps it privately and returns only its id", async () => {
    const response = await makePackage();
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["exportId", "fileName", "sizeBytes"]);
    expect(body.fileName).toBe(PACKAGE_DOWNLOAD_NAME);
    const stored = await objects.get(exportObjectKey(orgA, caseId, body.exportId));
    expect(stored?.length).toBe(body.sizeBytes);
    const zip = await JSZip.loadAsync(stored!);
    const files = await Promise.all(
      Object.values(zip.files)
        .filter((file) => !file.dir)
        .map((file) => file.async("uint8array")),
    );
    expect(files.some((file) => Buffer.from(file).equals(Buffer.from(originalBytes)))).toBe(true);
    // The staged original was not uploaded again and the company row did not change.
    expect(objects.objects.size).toBe(2);
    expect((await repositories.get(orgA)!.load(caseId)).revision).toBe(revision);
  });

  it("downloads through a same-origin redirect only for the same organization", async () => {
    const { exportId } = await (await makePackage()).json();
    const redirect = await download(exportId);
    expect(redirect.status).toBe(302);
    const location = new URL(redirect.headers.get("location")!);
    expect(location.pathname).toContain(`/exports/${exportId}.zip`);
    expect(location.searchParams.get("download")).toBe(PACKAGE_DOWNLOAD_NAME);
    expect(location.searchParams.get("expires")).toBe("300");
    expect(redirect.headers.get("cache-control")).toContain("no-store");
    expect((await download(exportId, "b-editor")).status).toBe(404);
    const unknown = await download(randomUUID());
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).code).toBe("EXPORT_EXPIRED");
  });

  it("treats exports older than an hour as expired and removes them on the next package", async () => {
    const { exportId: old } = await (await makePackage()).json();
    objects.createdAt.set(exportObjectKey(orgA, caseId, old), new Date(Date.now() - 2 * 3600_000));
    expect((await download(old)).status).toBe(404);
    const { exportId: fresh } = await (await makePackage()).json();
    expect(exportKeys()).toEqual([exportObjectKey(orgA, caseId, fresh)]);
    expect(await objects.get(originalObjectKey(orgA, caseId, sourceId))).toEqual(originalBytes);
  });

  it("refuses viewers, other organizations and a site without original storage", async () => {
    expect((await makePackage("a-viewer")).status).toBe(403);
    expect((await makePackage("b-editor")).status).toBe(404);
    runtime(null);
    const unconfigured = await makePackage();
    expect(unconfigured.status).toBe(503);
    expect(exportKeys()).toEqual([]);
  });

  it("removes a company's generated ZIPs with the company (session deletion)", async () => {
    await (await makePackage()).json();
    expect(exportKeys()).toHaveLength(1);
    // The web service has no company deletion route yet; the session path is what it will use.
    await runCaseSession(
      repositories.get(orgA)!,
      caseId,
      ({ store }) => store.delete(caseId, revision),
      { store: objects, organizationId: orgA },
    );
    await expect(repositories.get(orgA)!.load(caseId)).rejects.toMatchObject({ status: 404 });
    expect(exportKeys()).toEqual([]);
    expect(objects.objects.size).toBe(0);
    expect(exportPrefix(orgA, caseId)).toContain(caseId);
  });

  it("builds the visit preparation ZIP the same way with its own download name", async () => {
    const response = await visitRoute(
      request(`/api/studio/cases/${caseId}/visit-package`, "a-editor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          revision,
          mode: "draft",
          planId,
          submissionRecordId: null,
          answerVersionIds: [],
          sourceIds: [sourceId],
        }),
      }),
      { params: Promise.resolve({ caseId }) },
    );
    expect(response.status).toBe(201);
    const { exportId, fileName } = await response.json();
    expect(fileName).toBe(VISIT_PACKAGE_DOWNLOAD_NAME);
    const zip = await JSZip.loadAsync(
      (await objects.get(exportObjectKey(orgA, caseId, exportId)))!,
    );
    const files = await Promise.all(
      Object.values(zip.files)
        .filter((file) => !file.dir)
        .map((file) => file.async("uint8array")),
    );
    expect(files.some((file) => Buffer.from(file).equals(Buffer.from(originalBytes)))).toBe(true);
    const redirect = await visitExportRoute(
      request(`/api/studio/cases/${caseId}/visit-package/exports/${exportId}`, "a-editor"),
      { params: Promise.resolve({ caseId, exportId }) },
    );
    expect(redirect.status).toBe(302);
    expect(new URL(redirect.headers.get("location")!).searchParams.get("download")).toBe(
      VISIT_PACKAGE_DOWNLOAD_NAME,
    );
  });
});
