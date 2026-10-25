import { z } from "zod";

/** Private object storage for uploaded originals (server mode). Keys are built by the server. */
export interface OriginalObjectStore {
  /** Must not overwrite: an existing key is an error, never a silent replacement. */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  remove(key: string): Promise<void>;
  /** A short-lived URL the browser can PUT one object to, bypassing the function body limit. */
  createSignedUpload?(key: string): Promise<string>;
  /**
   * A short-lived URL that downloads one object as an attachment named `fileName`, bypassing
   * the function response limit. Null when the object does not exist.
   */
  createSignedDownload?(key: string, seconds: number, fileName: string): Promise<string | null>;
  /** Objects directly under `prefix/` with their creation time. */
  list?(prefix: string): Promise<{ key: string; createdAt: Date }[]>;
}

/** A generated ZIP waiting to be downloaded; derived data, removed after `exportMaxAgeMs`. */
export function exportObjectKey(organizationId: string, caseId: string, exportId: string) {
  return `${exportPrefix(organizationId, caseId)}/${uuid.parse(exportId)}.zip`;
}
export function exportPrefix(organizationId: string, caseId: string) {
  return `${uuid.parse(organizationId)}/${uuid.parse(caseId)}/exports`;
}
export const exportMaxAgeMs = 60 * 60 * 1000;
/** A browser upload not completed within this time is abandoned. */
export const stagingMaxAgeMs = 60 * 60 * 1000;
const uuidName = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const temporaryKinds = {
  exports: new RegExp(`^${uuidName}[.]zip$`, "i"),
  staging: new RegExp(`^${uuidName}[.]bin$`, "i"),
} as const;

/**
 * Best effort: removes a case's temporary objects (generated ZIPs or unfinished browser
 * uploads) older than `maxAgeMs`; 0 removes all of them. Never touches registered originals,
 * which live directly under the case prefix.
 */
export async function removeOldTemporaryObjects(
  store: OriginalObjectStore,
  organizationId: string,
  caseId: string,
  kind: keyof typeof temporaryKinds,
  maxAgeMs: number,
  now = Date.now(),
) {
  if (!store.list) return;
  const prefix = `${uuid.parse(organizationId)}/${uuid.parse(caseId)}/${kind}`;
  const items = await store.list(prefix).catch(() => []);
  for (const item of items) {
    const name = item.key.slice(prefix.length + 1);
    if (!item.key.startsWith(`${prefix}/`) || !temporaryKinds[kind].test(name)) continue;
    if (now - item.createdAt.getTime() >= maxAgeMs) await store.remove(item.key).catch(() => {});
  }
}

/** Generated ZIPs older than `maxAgeMs` (0 removes all of them). */
export function removeOldExports(
  store: OriginalObjectStore,
  organizationId: string,
  caseId: string,
  maxAgeMs = exportMaxAgeMs,
  now = Date.now(),
) {
  return removeOldTemporaryObjects(store, organizationId, caseId, "exports", maxAgeMs, now);
}

/** Where a browser upload waits until the server has checked and registered it. */
export function stagingObjectKey(organizationId: string, caseId: string, uploadId: string) {
  return `${uuid.parse(organizationId)}/${uuid.parse(caseId)}/staging/${uuid.parse(uploadId)}.bin`;
}

const uuid = z.string().uuid();
/** `organization/case/source.bin`; every part is a UUID so no caller text reaches the key. */
export function originalObjectKey(organizationId: string, caseId: string, sourceId: string) {
  return `${uuid.parse(organizationId)}/${uuid.parse(caseId)}/${uuid.parse(sourceId)}.bin`;
}

export class MemoryOriginalStore implements OriginalObjectStore {
  objects = new Map<string, Uint8Array>();
  createdAt = new Map<string, Date>();
  async put(key: string, bytes: Uint8Array) {
    if (this.objects.has(key)) throw new Error("Original already exists");
    this.objects.set(key, new Uint8Array(bytes));
    this.createdAt.set(key, new Date());
  }
  async get(key: string) {
    const value = this.objects.get(key);
    return value ? new Uint8Array(value) : null;
  }
  async remove(key: string) {
    this.objects.delete(key);
    this.createdAt.delete(key);
  }
  async createSignedUpload(key: string) {
    return `memory://${key}`;
  }
  async createSignedDownload(key: string, seconds: number, fileName: string) {
    return this.objects.has(key)
      ? `https://storage.memory.test/${key}?expires=${seconds}&download=${encodeURIComponent(fileName)}`
      : null;
  }
  async list(prefix: string) {
    return [...this.objects.keys()]
      .filter((key) => key.startsWith(`${prefix}/`) && !key.slice(prefix.length + 1).includes("/"))
      .map((key) => ({ key, createdAt: this.createdAt.get(key) ?? new Date(0) }));
  }
}

export type SupabaseStorageConfig = { url: string; serviceRoleKey: string; bucket: string };

/** Supabase Storage over HTTP with the server-only service role key and a private bucket. */
export class SupabaseOriginalStore implements OriginalObjectStore {
  constructor(
    private config: SupabaseStorageConfig,
    private fetchImpl: typeof fetch = fetch,
  ) {
    if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(config.bucket)) throw new Error("Invalid bucket name");
    if (new URL(config.url).protocol !== "https:") throw new Error("Storage URL must use https");
  }
  private objectUrl(key: string, authenticated = false) {
    const path = authenticated ? "object/authenticated" : "object";
    return new URL(`/storage/v1/${path}/${this.config.bucket}/${key}`, this.config.url).toString();
  }
  private headers(extra: Record<string, string> = {}) {
    return {
      apikey: this.config.serviceRoleKey,
      authorization: `Bearer ${this.config.serviceRoleKey}`,
      ...extra,
    };
  }
  async put(key: string, bytes: Uint8Array, contentType: string) {
    const response = await this.fetchImpl(this.objectUrl(key), {
      method: "POST",
      headers: this.headers({ "content-type": contentType, "x-upsert": "false" }),
      body: new Uint8Array(bytes),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Original upload failed (${response.status})`);
  }
  async get(key: string) {
    const response = await this.fetchImpl(this.objectUrl(key, true), {
      headers: this.headers(),
      cache: "no-store",
    });
    if (response.status === 404 || response.status === 400) return null;
    if (!response.ok) throw new Error(`Original download failed (${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  }
  async createSignedUpload(key: string) {
    const response = await this.fetchImpl(
      new URL(
        `/storage/v1/object/upload/sign/${this.config.bucket}/${key}`,
        this.config.url,
      ).toString(),
      { method: "POST", headers: this.headers(), cache: "no-store" },
    );
    if (!response.ok) throw new Error(`Signed upload failed (${response.status})`);
    const body = z
      .object({ url: z.string().startsWith("/object/upload/sign/") })
      .parse(await response.json());
    return new URL(`/storage/v1${body.url}`, this.config.url).toString();
  }
  async createSignedDownload(key: string, seconds: number, fileName: string) {
    const response = await this.fetchImpl(
      new URL(`/storage/v1/object/sign/${this.config.bucket}/${key}`, this.config.url).toString(),
      {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify({ expiresIn: seconds }),
        cache: "no-store",
      },
    );
    if (response.status === 400 || response.status === 404) return null;
    if (!response.ok) throw new Error(`Signed download failed (${response.status})`);
    const body = z
      .object({ signedURL: z.string().startsWith("/object/sign/") })
      .parse(await response.json());
    const url = new URL(`/storage/v1${body.signedURL}`, this.config.url);
    url.searchParams.set("download", fileName);
    return url.toString();
  }
  async list(prefix: string) {
    const response = await this.fetchImpl(
      new URL(`/storage/v1/object/list/${this.config.bucket}`, this.config.url).toString(),
      {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify({
          prefix,
          limit: 100,
          offset: 0,
          sortBy: { column: "created_at", order: "asc" },
        }),
        cache: "no-store",
      },
    );
    if (!response.ok) throw new Error(`Object listing failed (${response.status})`);
    const items = z
      .array(z.object({ name: z.string(), created_at: z.string().nullable().optional() }))
      .parse(await response.json());
    return items
      .filter((item) => item.created_at && !item.name.includes("/"))
      .map((item) => ({ key: `${prefix}/${item.name}`, createdAt: new Date(item.created_at!) }));
  }
  async remove(key: string) {
    const response = await this.fetchImpl(
      new URL(`/storage/v1/object/${this.config.bucket}`, this.config.url).toString(),
      {
        method: "DELETE",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify({ prefixes: [key] }),
        cache: "no-store",
      },
    );
    if (!response.ok && response.status !== 404)
      throw new Error(`Original removal failed (${response.status})`);
  }
}
