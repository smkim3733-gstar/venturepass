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
  configureServerRuntime({
    origin,
    authenticate: async (value) => principals[value.headers.get("x-test-user") ?? ""] ?? null,
    repositoryFor: (principal) => repositories.get(principal.organizationId)!,
  });
});
afterEach(() => {
  configureServerRuntime(null);
  delete process.env.VENTUREPASS_MODE;
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
