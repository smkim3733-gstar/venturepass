import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createCaseInRepository,
  MemoryCaseRowRepository,
  runCaseSession,
} from "./studio-case-session";
import {
  MemoryOriginalStore,
  originalObjectKey,
  SupabaseOriginalStore,
  exportObjectKey,
  exportPrefix,
  removeOldExports,
  removeOldTemporaryObjects,
  stagingObjectKey,
} from "./studio-original-store";
import { emptyProfile, type SourceDocument } from "./studio-schema";

const review = () => [];
const organizationId = randomUUID();
function upload(id = randomUUID()): SourceDocument {
  const now = new Date().toISOString();
  return {
    id,
    name: "가상_원본.txt",
    kind: "technology",
    text: "가상 본문",
    originalName: "가상_원본.txt",
    mimeType: "text/plain",
    extraction: "local",
    warnings: [],
    createdAt: now,
    updatedAt: now,
  };
}
async function setup() {
  const repository = new MemoryCaseRowRepository();
  const originals = new MemoryOriginalStore();
  const created = await createCaseInRepository(repository, {
    ...emptyProfile(),
    companyName: "가상 원본 회사",
  });
  return { repository, originals, created, scope: { store: originals, organizationId } };
}

describe("originals in server sessions", () => {
  it("stores a new upload in object storage before saving the row that references it", async () => {
    const { repository, originals, created, scope } = await setup();
    const source = upload();
    await runCaseSession(
      repository,
      created.id,
      ({ store }) => store.addUpload(created.id, 0, source, new TextEncoder().encode("원본")),
      scope,
    );
    const key = originalObjectKey(organizationId, created.id, source.id);
    expect(new TextDecoder().decode((await originals.get(key))!)).toBe("원본");
    expect(JSON.parse((await repository.load(created.id)).body).sources[0].id).toBe(source.id);
  });

  it("removes the uploaded object again when the row save loses a race", async () => {
    const { repository, originals, created, scope } = await setup();
    const source = upload();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = runCaseSession(
      repository,
      created.id,
      async ({ store }) => {
        await gate;
        return store.addUpload(created.id, 0, source, new TextEncoder().encode("늦은 원본"));
      },
      scope,
    );
    await runCaseSession(repository, created.id, ({ store }) =>
      store.mutate(
        created.id,
        { action: "profile", revision: 0, profile: { ...emptyProfile(), companyName: "먼저" } },
        review,
      ),
    );
    release();
    await expect(slow).rejects.toMatchObject({ status: 409 });
    expect(originals.objects.size).toBe(0);
  });

  it("deletes the object after a source deletion is saved", async () => {
    const { repository, originals, created, scope } = await setup();
    const source = upload();
    await runCaseSession(
      repository,
      created.id,
      ({ store }) => store.addUpload(created.id, 0, source, new Uint8Array([1, 2, 3])),
      scope,
    );
    await runCaseSession(
      repository,
      created.id,
      ({ store }) =>
        store.mutate(
          created.id,
          { action: "delete-source", revision: 1, sourceId: source.id },
          review,
        ),
      scope,
    );
    expect(originals.objects.size).toBe(0);
  });

  it("builds keys only from UUIDs", () => {
    expect(() => originalObjectKey(organizationId, "../x", randomUUID())).toThrow();
  });
});

describe("Supabase Storage adapter", () => {
  it("uploads without overwrite, downloads through the authenticated path and refuses http", async () => {
    const calls: [string, RequestInit][] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push([url, init]);
      if (init.method === "POST") return new Response("{}", { status: 200 });
      if (url.includes("/missing.bin")) return new Response("{}", { status: 400 });
      return new Response(new Uint8Array([7, 8]), { status: 200 });
    }) as unknown as typeof fetch;
    const storage = new SupabaseOriginalStore(
      {
        url: "https://project.supabase.test",
        serviceRoleKey: "service",
        bucket: "venturepass-originals",
      },
      fetchImpl,
    );
    await storage.put("a/b.bin", new Uint8Array([1]), "text/plain");
    expect(calls[0][0]).toBe(
      "https://project.supabase.test/storage/v1/object/venturepass-originals/a/b.bin",
    );
    expect(calls[0][1].headers).toMatchObject({ "x-upsert": "false" });
    expect(await storage.get("a/b.bin")).toEqual(new Uint8Array([7, 8]));
    expect(calls[1][0]).toContain("/storage/v1/object/authenticated/venturepass-originals/");
    expect(await storage.get("a/missing.bin")).toBeNull();
    const signer = new SupabaseOriginalStore(
      {
        url: "https://project.supabase.test",
        serviceRoleKey: "service",
        bucket: "venturepass-originals",
      },
      vi.fn(async () =>
        Response.json({ url: "/object/upload/sign/venturepass-originals/a/b.bin?token=t" }),
      ) as unknown as typeof fetch,
    );
    expect(await signer.createSignedUpload("a/b.bin")).toBe(
      "https://project.supabase.test/storage/v1/object/upload/sign/venturepass-originals/a/b.bin?token=t",
    );
    expect(
      () =>
        new SupabaseOriginalStore({ url: "http://x.test", serviceRoleKey: "s", bucket: "bucket" }),
    ).toThrow();
  });
});

describe("generated ZIP objects", () => {
  const config = {
    url: "https://project.supabase.test",
    serviceRoleKey: "service",
    bucket: "venturepass-originals",
  };

  it("signs an attachment download and lists exports through the Supabase API", async () => {
    const calls: [string, RequestInit][] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      if (url.includes("/object/sign/") && url.endsWith("/missing.zip"))
        return new Response("{}", { status: 400 });
      if (url.includes("/object/sign/"))
        return Response.json({ signedURL: "/object/sign/venturepass-originals/a/b.zip?token=t" });
      return Response.json([
        { name: "x.zip", created_at: "2026-10-26T00:00:00.000Z" },
        { name: "folder", created_at: null },
      ]);
    }) as unknown as typeof fetch;
    const storage = new SupabaseOriginalStore(config, fetchImpl);
    const signed = new URL((await storage.createSignedDownload("a/b.zip", 300, "pack.zip"))!);
    expect(signed.origin + signed.pathname).toBe(
      "https://project.supabase.test/storage/v1/object/sign/venturepass-originals/a/b.zip",
    );
    expect(signed.searchParams.get("token")).toBe("t");
    expect(signed.searchParams.get("download")).toBe("pack.zip");
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ expiresIn: 300 });
    expect(await storage.createSignedDownload("a/missing.zip", 300, "pack.zip")).toBeNull();
    expect(await storage.list("org/case/exports")).toEqual([
      { key: "org/case/exports/x.zip", createdAt: new Date("2026-10-26T00:00:00.000Z") },
    ]);
    expect(calls.at(-1)![0]).toBe(
      "https://project.supabase.test/storage/v1/object/list/venturepass-originals",
    );
    expect(JSON.parse(String(calls.at(-1)![1].body))).toMatchObject({ prefix: "org/case/exports" });
  });

  it("removes only expired ZIPs of one company and never its originals", async () => {
    const store = new MemoryOriginalStore();
    const caseId = randomUUID();
    const old = exportObjectKey(organizationId, caseId, randomUUID());
    const fresh = exportObjectKey(organizationId, caseId, randomUUID());
    const original = originalObjectKey(organizationId, caseId, randomUUID());
    const other = exportObjectKey(organizationId, randomUUID(), randomUUID());
    for (const key of [old, fresh, original, other]) await store.put(key, new Uint8Array([1]));
    store.createdAt.set(old, new Date(Date.now() - 2 * 3600_000));
    store.createdAt.set(other, new Date(Date.now() - 2 * 3600_000));
    await removeOldExports(store, organizationId, caseId);
    expect([...store.objects.keys()].sort()).toEqual([fresh, original, other].sort());
    await removeOldExports(store, organizationId, caseId, 0);
    expect(store.objects.has(fresh)).toBe(false);
    expect(store.objects.has(original)).toBe(true);
    expect(exportPrefix(organizationId, caseId)).toBe(`${organizationId}/${caseId}/exports`);
  });

  it("clears unfinished uploads by name pattern only", async () => {
    const store = new MemoryOriginalStore();
    const caseId = randomUUID();
    const staged = stagingObjectKey(organizationId, caseId, randomUUID());
    const lookalike = `${organizationId}/${caseId}/staging/${randomUUID()}xbin`;
    const notes = `${organizationId}/${caseId}/staging/notes.txt`;
    for (const key of [staged, lookalike, notes]) await store.put(key, new Uint8Array([1]));
    await removeOldTemporaryObjects(store, organizationId, caseId, "staging", 0);
    expect([...store.objects.keys()].sort()).toEqual([lookalike, notes].sort());
  });
});
