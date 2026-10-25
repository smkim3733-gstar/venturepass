import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as listCasesRoute, POST as createCaseRoute } from "@/app/api/studio/cases/route";
import {
  GET as getCaseRoute,
  PATCH as patchCaseRoute,
  DELETE as deleteCaseRoute,
} from "@/app/api/studio/cases/[caseId]/route";
import { GET as ventureInRoute } from "@/app/api/studio/cases/[caseId]/venturein/route";
import { GET as statusRoute } from "@/app/api/studio/status/route";
import { POST as uploadRoute } from "@/app/api/studio/cases/[caseId]/sources/route";
import { GET as downloadRoute } from "@/app/api/studio/cases/[caseId]/sources/[sourceId]/route";
import { MemoryOriginalStore } from "./studio-original-store";
import { POST as startUploadRoute } from "@/app/api/studio/cases/[caseId]/sources/direct-upload/route";
import { POST as completeUploadRoute } from "@/app/api/studio/cases/[caseId]/sources/direct-upload/complete/route";
import { MemoryCaseRowRepository } from "./studio-case-session";
import { configureServerRuntime, type StudioPrincipal } from "./studio-request-scope";
import { emptyProfile } from "./studio-schema";
import { getStudioStore } from "./studio-storage";

vi.mock("server-only", () => ({}));

const origin = "https://venturepass.test";
const orgA = randomUUID();
const orgB = randomUUID();
const principals: Record<string, StudioPrincipal> = {
  "a-editor": {
    userId: randomUUID(),
    organizationId: orgA,
    role: "editor",
    displayName: "가상 A 담당",
  },
  "a-viewer": {
    userId: randomUUID(),
    organizationId: orgA,
    role: "viewer",
    displayName: "가상 A 조회",
  },
  "b-editor": {
    userId: randomUUID(),
    organizationId: orgB,
    role: "editor",
    displayName: "가상 B 담당",
  },
};
let repositories: Map<string, MemoryCaseRowRepository>;
let originalStore: MemoryOriginalStore;

function request(path: string, user: string | null, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (user) headers.set("x-test-user", user);
  if (!headers.has("origin") && init.method && init.method !== "GET") headers.set("origin", origin);
  return new Request(`${origin}${path}`, { ...init, headers });
}
const json = (body: unknown) => ({
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});
const params = (caseId: string) => ({ params: Promise.resolve({ caseId }) });
async function createCase(user: string, companyName: string) {
  const response = await createCaseRoute(
    request("/api/studio/cases", user, {
      method: "POST",
      ...json({ profile: { ...emptyProfile(), companyName } }),
    }),
  );
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; revision: number };
}

beforeEach(() => {
  repositories = new Map([
    [orgA, new MemoryCaseRowRepository()],
    [orgB, new MemoryCaseRowRepository()],
  ]);
  originalStore = new MemoryOriginalStore();
  configureServerRuntime({
    origin,
    authenticate: async (value) => principals[value.headers.get("x-test-user") ?? ""] ?? null,
    repositoryFor: (principal) => repositories.get(principal.organizationId)!,
    originals: originalStore,
  });
});
afterEach(() => {
  configureServerRuntime(null);
  delete process.env.VENTUREPASS_MODE;
});

describe("server mode originals", () => {
  async function uploadText(
    user: string,
    caseId: string,
    bytes: Uint8Array<ArrayBuffer>,
    revision = 0,
  ) {
    const form = new FormData();
    form.append("file", new File([bytes], "가상_자료.txt", { type: "text/plain" }));
    form.append("kind", "technology");
    form.append("revision", String(revision));
    return uploadRoute(
      request(`/api/studio/cases/${caseId}/sources`, user, { method: "POST", body: form }),
      params(caseId),
    );
  }

  it("uploads to the organization's object storage and downloads it back", async () => {
    const created = await createCase("a-editor", "가상 업로드 회사");
    const response = await uploadText(
      "a-editor",
      created.id,
      new TextEncoder().encode("가상 기술 설명 본문입니다."),
    );
    expect(response.status).toBe(201);
    const company = await response.json();
    const sourceId = company.sources[0].id as string;
    expect(originalStore.objects.size).toBe(1);
    const download = await downloadRoute(
      request(`/api/studio/cases/${created.id}/sources/${sourceId}`, "a-editor"),
      { params: Promise.resolve({ caseId: created.id, sourceId }) },
    );
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("가상 기술 설명 본문입니다.");
    const crossOrg = await downloadRoute(
      request(`/api/studio/cases/${created.id}/sources/${sourceId}`, "b-editor"),
      { params: Promise.resolve({ caseId: created.id, sourceId }) },
    );
    expect(crossOrg.status).toBe(404);
  });

  it("limits web uploads to 4MB and needs configured original storage", async () => {
    const created = await createCase("a-editor", "가상 한도 회사");
    const large = await uploadText("a-editor", created.id, new Uint8Array(4 * 1024 * 1024 + 1));
    expect(large.status).toBe(413);
    configureServerRuntime({
      origin,
      authenticate: async (value) => principals[value.headers.get("x-test-user") ?? ""] ?? null,
      repositoryFor: (principal) => repositories.get(principal.organizationId)!,
    });
    const unconfigured = await uploadText("a-editor", created.id, new TextEncoder().encode("본문"));
    expect(unconfigured.status).toBe(503);
    expect((await unconfigured.json()).code).toBe("ORIGINALS_NOT_CONFIGURED");
  });
});

describe("server mode direct uploads for large files", () => {
  const post = (path: string, body: unknown) =>
    request(path, "a-editor", { method: "POST", ...json(body) });

  it("registers a file the browser put into storage and drops the staging copy", async () => {
    const created = await createCase("a-editor", "가상 큰 파일 회사");
    const start = await startUploadRoute(
      post(`/api/studio/cases/${created.id}/sources/direct-upload`, {
        fileName: "가상_대용량.txt",
        size: 5 * 1024 * 1024,
        contentType: "text/plain",
      }),
      params(created.id),
    );
    expect(start.status).toBe(200);
    const { uploadId, uploadUrl } = await start.json();
    const stagingKey = String(uploadUrl).replace("memory://", "");
    expect(stagingKey).toContain("/staging/");
    await originalStore.put(stagingKey, new TextEncoder().encode("가상 대용량 기술 본문"));
    const complete = await completeUploadRoute(
      post(`/api/studio/cases/${created.id}/sources/direct-upload/complete`, {
        uploadId,
        fileName: "가상_대용량.txt",
        contentType: "text/plain",
        kind: "technology",
        revision: 0,
      }),
      params(created.id),
    );
    expect(complete.status).toBe(201);
    const company = await complete.json();
    expect(company.sources[0].text).toContain("가상 대용량 기술 본문");
    expect(await originalStore.get(stagingKey)).toBeNull();
    expect(originalStore.objects.size).toBe(1);
  });

  it("refuses to complete an upload that never reached storage", async () => {
    const created = await createCase("a-editor", "가상 미도착 회사");
    const complete = await completeUploadRoute(
      post(`/api/studio/cases/${created.id}/sources/direct-upload/complete`, {
        uploadId: randomUUID(),
        fileName: "없음.txt",
        kind: "other",
        revision: 0,
      }),
      params(created.id),
    );
    expect(complete.status).toBe(409);
    expect((await complete.json()).code).toBe("UPLOAD_NOT_FOUND");
  });

  it("rejects an announced size over 12MB before issuing an upload URL", async () => {
    const created = await createCase("a-editor", "가상 초과 회사");
    const start = await startUploadRoute(
      post(`/api/studio/cases/${created.id}/sources/direct-upload`, {
        fileName: "큰.pdf",
        size: 13 * 1024 * 1024,
      }),
      params(created.id),
    );
    expect(start.status).toBe(400);
  });
});

describe("server mode organization boundaries", () => {
  it("keeps each organization's companies separate in lists and reads", async () => {
    const created = await createCase("a-editor", "가상 A 회사");
    const listA = await (await listCasesRoute(request("/api/studio/cases", "a-editor"))).json();
    const listB = await (await listCasesRoute(request("/api/studio/cases", "b-editor"))).json();
    expect(listA.cases.map((item: { companyName: string }) => item.companyName)).toEqual([
      "가상 A 회사",
    ]);
    expect(listB.cases).toEqual([]);
    const crossRead = await getCaseRoute(
      request(`/api/studio/cases/${created.id}`, "b-editor"),
      params(created.id),
    );
    expect(crossRead.status).toBe(404);
  });

  it("lets an editor change a company and stores it in that organization only", async () => {
    const created = await createCase("a-editor", "가상 변경 회사");
    const response = await patchCaseRoute(
      request(`/api/studio/cases/${created.id}`, "a-editor", {
        method: "PATCH",
        ...json({
          action: "profile",
          revision: 0,
          profile: { ...emptyProfile(), companyName: "가상 변경 회사", industry: "가상 업종" },
        }),
      }),
      params(created.id),
    );
    expect(response.status).toBe(200);
    const saved = await repositories.get(orgA)!.load(created.id);
    expect(JSON.parse(saved.body).profile.industry).toBe("가상 업종");
    expect(await repositories.get(orgB)!.list()).toEqual([]);
  });

  it("blocks a cross-organization change without touching the owner's record", async () => {
    const created = await createCase("a-editor", "가상 보호 회사");
    const response = await patchCaseRoute(
      request(`/api/studio/cases/${created.id}`, "b-editor", {
        method: "PATCH",
        ...json({
          action: "profile",
          revision: 0,
          profile: { ...emptyProfile(), companyName: "탈취 시도" },
        }),
      }),
      params(created.id),
    );
    expect(response.status).toBe(404);
    expect((await repositories.get(orgA)!.load(created.id)).revision).toBe(0);
  });

  it("allows viewers to read but not change", async () => {
    const created = await createCase("a-editor", "가상 조회 회사");
    expect(
      (
        await getCaseRoute(
          request(`/api/studio/cases/${created.id}`, "a-viewer"),
          params(created.id),
        )
      ).status,
    ).toBe(200);
    const change = await patchCaseRoute(
      request(`/api/studio/cases/${created.id}`, "a-viewer", {
        method: "PATCH",
        ...json({ action: "profile", revision: 0, profile: emptyProfile() }),
      }),
      params(created.id),
    );
    expect(change.status).toBe(403);
  });

  it("requires login and a same-origin request", async () => {
    expect((await listCasesRoute(request("/api/studio/cases", null))).status).toBe(401);
    const crossSite = await createCaseRoute(
      request("/api/studio/cases", "a-editor", {
        method: "POST",
        ...json({ profile: emptyProfile() }),
        headers: { "content-type": "application/json", origin: "https://evil.example" },
      }),
    );
    expect(crossSite.status).toBe(403);
    const noOrigin = new Request(`${origin}/api/studio/cases`, {
      method: "POST",
      body: JSON.stringify({ profile: emptyProfile() }),
      headers: { "content-type": "application/json", "x-test-user": "a-editor" },
    });
    expect((await createCaseRoute(noOrigin)).status).toBe(403);
  });

  it("answers local-only features as unavailable instead of running them", async () => {
    const created = await createCase("a-editor", "가상 로컬 기능 회사");
    const venture = await ventureInRoute(
      request(`/api/studio/cases/${created.id}/venturein`, "a-editor"),
      params(created.id),
    );
    expect(venture.status).toBe(404);
    expect((await venture.json()).code).toBe("LOCAL_ONLY");
    const remove = await deleteCaseRoute(
      request(`/api/studio/cases/${created.id}`, "a-editor", {
        method: "DELETE",
        ...json({ revision: 0 }),
      }),
      params(created.id),
    );
    expect(remove.status).toBe(405);
    expect((await repositories.get(orgA)!.load(created.id)).revision).toBe(0);
  });

  it("reports the server storage in status", async () => {
    const response = await statusRoute(request("/api/studio/status", "a-viewer"));
    expect((await response.json()).storage).toBe("server");
  });

  it("fails closed when server mode is requested without a configured runtime", async () => {
    configureServerRuntime(null);
    process.env.VENTUREPASS_MODE = "server";
    const response = await listCasesRoute(request("/api/studio/cases", "a-editor"));
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("SERVER_NOT_CONFIGURED");
    expect(() => getStudioStore()).toThrow("로컬 저장소");
  });
});
