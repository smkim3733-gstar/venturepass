import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as createCaseRoute } from "@/app/api/studio/cases/route";
import { PATCH as patchCaseRoute } from "@/app/api/studio/cases/[caseId]/route";
import { POST as uploadRoute } from "@/app/api/studio/cases/[caseId]/sources/route";
import { POST as previewRoute } from "@/app/api/studio/cases/[caseId]/source-suggestions/preview/route";
import { GET as evidenceRoute } from "@/app/api/studio/cases/[caseId]/agency-records/evidence/route";
import { MemoryCaseRowRepository } from "./studio-case-session";
import { MemoryOriginalStore, originalObjectKey } from "./studio-original-store";
import { configureServerRuntime, type StudioPrincipal } from "./studio-request-scope";
import { emptyProfile, type StudioCase } from "./studio-schema";
import type { SourceSuggestionsPreview } from "./studio-source-suggestion-types";

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
const text =
  "재무상태표\n회사명: 합성웹회사\n사업자등록번호: 123-45-67890\n업종: 소프트웨어 개발\n결산월: 12월";
const bytes = new TextEncoder().encode(text);
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

let repositories: Map<string, MemoryCaseRowRepository>;
let objects: MemoryOriginalStore;
let company: StudioCase;

function request(path: string, user: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-test-user", user);
  if (init.method && init.method !== "GET") headers.set("origin", origin);
  return new Request(`${origin}${path}`, { ...init, headers });
}
const json = (body: unknown) => ({
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});
const params = () => ({ params: Promise.resolve({ caseId: company.id }) });
const patch = (body: unknown, user = "a-editor") =>
  patchCaseRoute(
    request(`/api/studio/cases/${company.id}`, user, { method: "PATCH", ...json(body) }),
    params(),
  );
const evidence = (recordId: string, user = "a-editor") =>
  evidenceRoute(
    request(
      `/api/studio/cases/${company.id}/agency-records/evidence?recordId=${recordId}&revision=${company.revision}`,
      user,
    ),
    params(),
  );

beforeEach(async () => {
  repositories = new Map([
    [orgA, new MemoryCaseRowRepository()],
    [orgB, new MemoryCaseRowRepository()],
  ]);
  objects = new MemoryOriginalStore();
  configureServerRuntime({
    origin,
    authenticate: async (value) => principals[value.headers.get("x-test-user") ?? ""] ?? null,
    repositoryFor: (current) => repositories.get(current.organizationId)!,
    originals: objects,
  });
  const created = await createCaseRoute(
    request("/api/studio/cases", "a-editor", {
      method: "POST",
      ...json({ profile: { ...emptyProfile(), companyName: "가상 원본 회사" } }),
    }),
  );
  expect(created.status).toBe(201);
  company = await created.json();
  const form = new FormData();
  form.append("file", new File([bytes], "가상_재무.txt", { type: "text/plain" }));
  form.append("kind", "finance");
  form.append("revision", String(company.revision));
  const uploaded = await uploadRoute(
    request(`/api/studio/cases/${company.id}/sources`, "a-editor", { method: "POST", body: form }),
    params(),
  );
  expect(uploaded.status).toBe(201);
  company = await uploaded.json();
  expect(company.sources[0].originalName).toBe("가상_재무.txt");
});
afterEach(() => {
  configureServerRuntime(null);
});

describe("web changes that read stored originals", { timeout: 60_000 }, () => {
  it("previews and adopts company information from an uploaded original", async () => {
    const source = company.sources[0];
    const response = await previewRoute(
      request(`/api/studio/cases/${company.id}/source-suggestions/preview`, "a-editor", {
        method: "POST",
        ...json({
          revision: company.revision,
          sourceId: source.id,
          basis: { kind: "source-text", sourceUpdatedAt: source.updatedAt },
        }),
      }),
      params(),
    );
    expect(response.status).toBe(200);
    const preview = (await response.json()) as SourceSuggestionsPreview;
    expect(preview.binding.original?.sha256).toBe(sha(bytes));
    const candidate = preview.candidates.find((item) => item.target === "companyName")!;
    expect(candidate.value).toBe("합성웹회사");
    const adopted = await patch({
      action: "adopt-source-suggestions",
      revision: company.revision,
      clientRequestId: randomUUID(),
      binding: preview.binding,
      reviewed: true,
      selections: [
        {
          candidateId: candidate.id,
          target: "companyName",
          expectedCurrentValue: candidate.currentValue,
        },
      ],
    });
    expect(adopted.status).toBe(200);
    company = await adopted.json();
    expect(company.profile.companyName).toBe("합성웹회사");
    // Reading originals for the change never uploads them again.
    expect(objects.objects.size).toBe(1);
  });

  it("records agency evidence from a stored original and compares it later", async () => {
    const source = company.sources[0];
    const saved = await patch({
      action: "append-agency-record",
      revision: company.revision,
      clientRequestId: randomUUID(),
      record: {
        kind: "request",
        institution: "가상 확인기관",
        title: "보완 자료 요청",
        body: "시험 요청 내용입니다.",
        occurredOn: "2026-09-25",
        dueOn: "2026-10-01",
        dueNote: "담당자 확인 예정",
        note: "합성 기록",
        sourceIds: [source.id],
      },
    });
    expect(saved.status).toBe(200);
    company = await saved.json();
    const record = company.agencyRecords.at(-1)!;
    expect(record.evidence).toHaveLength(1);
    expect(record.evidence[0]).toMatchObject({ sourceId: source.id, sha256: sha(bytes) });

    const matched = await evidence(record.id);
    expect(matched.status).toBe(200);
    expect((await matched.json()).evidence).toEqual([{ sourceId: source.id, state: "matched" }]);
    expect((await evidence(record.id, "a-viewer")).status).toBe(200);
    expect((await evidence(record.id, "b-editor")).status).toBe(404);

    objects.objects.set(
      originalObjectKey(orgA, company.id, source.id),
      new TextEncoder().encode("변조된 합성 원본"),
    );
    const changed = await evidence(record.id);
    expect((await changed.json()).evidence).toEqual([{ sourceId: source.id, state: "changed" }]);
    await objects.remove(originalObjectKey(orgA, company.id, source.id));
    const missing = await evidence(record.id);
    expect((await missing.json()).evidence).toEqual([
      { sourceId: source.id, state: "unavailable" },
    ]);
  });
});
