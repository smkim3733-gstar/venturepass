import { z } from "zod";

/** Private object storage for uploaded originals (server mode). Keys are built by the server. */
export interface OriginalObjectStore {
  /** Must not overwrite: an existing key is an error, never a silent replacement. */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  remove(key: string): Promise<void>;
  /** A short-lived URL the browser can PUT one object to, bypassing the function body limit. */
  createSignedUpload?(key: string): Promise<string>;
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
  async put(key: string, bytes: Uint8Array) {
    if (this.objects.has(key)) throw new Error("Original already exists");
    this.objects.set(key, new Uint8Array(bytes));
  }
  async get(key: string) {
    const value = this.objects.get(key);
    return value ? new Uint8Array(value) : null;
  }
  async remove(key: string) {
    this.objects.delete(key);
  }
  async createSignedUpload(key: string) {
    return `memory://${key}`;
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
