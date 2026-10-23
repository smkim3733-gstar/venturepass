import { afterEach, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
vi.mock("server-only", () => ({}));
vi.mock("node:sqlite", () => {
  throw Error("SQL forbidden");
});
vi.mock("openai", () => {
  throw Error("SDK forbidden");
});
import { createInputPreparationHttpServer } from "./studio-comparison-input-route";
import { createInputPreparationClient } from "./studio-comparison-input-client";
import { decodeInputDownload, type InputSelection } from "./studio-comparison-input-wire";
const selection: InputSelection = {
  companyId: "16a6a2ec-90d5-4400-b139-ec04bb8f91bb",
  companyRevision: 3,
  runId: "98d05f74-8527-4789-831c-6611e73bc9cc",
};
const origin = "http://127.0.0.1:30333",
  endpoint = `${origin}/api/studio/cases/${selection.companyId}/public-claim-comparison/input-preparation`;
function fixture() {
  const content = JSON.stringify({
    inputVersion: 1,
    databaseInstanceId: selection.companyId,
    settings: {
      ...selection,
      basis: { provenance: "official-reviewed" },
      usagePolicy: { provenance: "official-reviewed" },
    },
  });
  return {
    ...selection,
    kind: "comparison-input-download" as const,
    inspectedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    reviewDigest: "a".repeat(64),
    model: "synthetic-model",
    content,
    sha256: createHash("sha256").update(content).digest("hex"),
    transmissionAllowed: false as const,
    consentRecorded: false as const,
    runtimeObserved: false as const,
  };
}
function request(
  body: unknown = selection,
  method = "POST",
  extra: RequestInit = {},
  url = endpoint,
) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", origin },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...extra,
  });
}
function service() {
  let closed = false;
  return {
    prepare: vi.fn(),
    close: vi.fn(() => {
      closed = true;
      return { closed: true };
    }),
    download: vi.fn(() => {
      expect(closed).toBe(true);
      return fixture();
    }),
  };
}
afterEach(() => vi.restoreAllMocks());
it("explicit preparation releases its original owner before exposing a download", async () => {
  const owner = service(),
    open = vi.fn(async () => owner),
    server = createInputPreparationHttpServer(open);
  const req = request();
  const response = await server.handle(req, selection.companyId);
  expect(response.status).toBe(200);
  expect(req.body?.locked).toBe(false);
  expect(await response.json()).toMatchObject(selection);
  expect(open).toHaveBeenCalledExactlyOnceWith(selection);
  expect(owner.prepare).toHaveBeenCalledTimes(1);
  expect(owner.close).toHaveBeenCalledTimes(1);
  expect(server.inspect().retained).toBe(0);
  expect(response.headers.get("cache-control")).toContain("no-store");
});
it.each(["false", "throw"])(
  "failed %s cleanup retains the original owner through withdrawal",
  async (mode) => {
    const owner = service();
    let fail = true;
    owner.close.mockImplementation(() => {
      if (fail) {
        if (mode === "throw") throw Error("private path");
        return { closed: false };
      }
      return { closed: true };
    });
    const open = vi.fn(async () => owner),
      server = createInputPreparationHttpServer(open);
    expect((await server.handle(request(), selection.companyId)).status).toBe(409);
    expect(owner.download).not.toHaveBeenCalled();
    expect(server.inspect().retained).toBe(1);
    open.mockRejectedValue(Error("NOT_CONFIGURED"));
    expect((await server.handle(request(), selection.companyId)).status).toBe(409);
    expect(open).toHaveBeenCalledTimes(1);
    fail = false;
    const cleanup = new Request(endpoint, { method: "DELETE", headers: { origin } });
    expect((await server.handle(cleanup, selection.companyId)).status).toBe(200);
    expect(server.inspect().retained).toBe(0);
  },
);
it.each([
  "extra",
  "path",
  "query",
  "origin",
  "host",
  "proxy",
  "utf8",
  "too-large",
  "content-type",
  "revision",
  "run",
  "company",
  "delete-body",
])("rejects %s before opening any resources", async (mode) => {
  const open = vi.fn(async () => service()),
    server = createInputPreparationHttpServer(open);
  let req = request();
  if (mode === "extra") req = request({ ...selection, policyFile: "private" });
  if (mode === "path") req = request(selection, "POST", {}, endpoint + "/");
  if (mode === "query") req = request(selection, "POST", {}, endpoint + "?revision=3");
  if (mode === "origin")
    req = request(selection, "POST", {
      headers: { origin: "https://foreign.invalid", "content-type": "application/json" },
    });
  if (mode === "host")
    req = request(selection, "POST", {
      headers: { host: "evil.invalid", "content-type": "application/json" },
    });
  if (mode === "proxy")
    req = request(selection, "POST", {
      headers: { "x-forwarded-host": "evil.invalid", "content-type": "application/json" },
    });
  if (mode === "utf8") req = request(selection, "POST", { body: new Uint8Array([255]) });
  if (mode === "too-large") req = request("x".repeat(8193));
  if (mode === "content-type")
    req = request(selection, "POST", { headers: { "content-type": "text/plain" } });
  if (mode === "revision") req = request({ ...selection, companyRevision: -1 });
  if (mode === "run") req = request({ ...selection, runId: "bad" });
  if (mode === "company") req = request({ ...selection, companyId: selection.runId });
  if (mode === "delete-body") req = request({}, "DELETE");
  expect((await server.handle(req, selection.companyId)).status).toBeGreaterThanOrEqual(400);
  expect(open).not.toHaveBeenCalled();
});
it("pending acquisitions are bounded and cannot be replaced by cleanup or a second preparation", async () => {
  let release!: (value: ReturnType<typeof service>) => void;
  const open = vi.fn(
    () =>
      new Promise<ReturnType<typeof service>>((resolve) => {
        release = resolve;
      }),
  );
  const server = createInputPreparationHttpServer(open),
    first = server.handle(request(), selection.companyId);
  await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
  expect((await server.handle(request(), selection.companyId)).status).toBe(409);
  expect(
    (
      await server.handle(
        new Request(endpoint, { method: "DELETE", headers: { origin } }),
        selection.companyId,
      )
    ).status,
  ).toBe(409);
  release(service());
  expect((await first).status).toBe(200);
});
it("disconnect after opening closes without preparing or exposing a file", async () => {
  const controller = new AbortController(),
    owner = service();
  const server = createInputPreparationHttpServer(async () => {
    controller.abort();
    return owner;
  });
  expect(
    (
      await server.handle(
        request(selection, "POST", { signal: controller.signal }),
        selection.companyId,
      )
    ).status,
  ).toBe(422);
  expect(owner.close).toHaveBeenCalled();
  expect(owner.prepare).not.toHaveBeenCalled();
  expect(owner.download).not.toHaveBeenCalled();
});
it("eight failed original owners block a ninth acquisition", async () => {
  const open = vi.fn(async () => ({ ...service(), close: () => ({ closed: false }) })),
    server = createInputPreparationHttpServer(open);
  for (let i = 0; i < 9; i++) {
    const id = randomUUID(),
      url = endpoint.replace(selection.companyId, id);
    expect(
      (await server.handle(request({ ...selection, companyId: id }, "POST", {}, url), id)).status,
    ).toBe(409);
  }
  expect(open).toHaveBeenCalledTimes(8);
  expect(server.inspect().retained).toBe(8);
});
it.each(["prepare", "download", "missing"])(
  "redacts %s failures and closes acquired resources",
  async (mode) => {
    const owner = service();
    if (mode === "prepare")
      owner.prepare.mockImplementation(() => {
        throw Error("secret");
      });
    if (mode === "download")
      owner.download.mockImplementation(() => {
        throw Error("secret");
      });
    const server = createInputPreparationHttpServer(async () => {
      if (mode === "missing") throw Error("NOT_CONFIGURED");
      return owner;
    });
    const response = await server.handle(request(), selection.companyId);
    expect(response.status).toBe(mode === "missing" ? 503 : 422);
    expect(await response.text()).not.toContain("secret");
    expect(server.inspect().retained).toBe(0);
    if (mode !== "missing") expect(owner.close).toHaveBeenCalled();
  },
);
it("client performs one explicit read and verifies exact UTF8 SHA before offering a file", async () => {
  const value = fixture(),
    fetcher = vi.fn(async () => Response.json(value)),
    client = createInputPreparationClient(fetcher);
  expect(fetcher).not.toHaveBeenCalled();
  await client.prepare(selection);
  expect(client.getSnapshot().result).toEqual(value);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]).toMatchObject([
    expect.any(String),
    {
      method: "POST",
      body: JSON.stringify(selection),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    },
  ]);
});
it.each([
  "company",
  "revision",
  "run",
  "document-run",
  "expired",
  "future",
  "hash",
  "utf8-limit",
  "extra",
  "synthetic",
  "broken-json",
  "response-limit",
])("client rejects %s with no retry or usable file", async (mode) => {
  const value = fixture();
  if (mode === "company") value.companyId = selection.runId;
  if (mode === "revision") value.companyRevision++;
  if (mode === "run") value.runId = selection.companyId;
  if (mode === "document-run")
    value.content = value.content.replace(selection.runId, selection.companyId);
  if (mode === "expired") value.expiresAt = new Date(Date.now() - 1).toISOString();
  if (mode === "future") value.inspectedAt = new Date(Date.now() + 10000).toISOString();
  if (mode === "hash") value.sha256 = "b".repeat(64);
  if (mode === "utf8-limit") value.content = "가".repeat(60000);
  if (mode === "extra") Object.assign(value, { secret: "bad" });
  if (mode === "synthetic")
    value.content = value.content.replaceAll("official-reviewed", "synthetic-test");
  const fetcher = vi.fn(async () =>
    mode === "broken-json"
      ? new Response("{")
      : mode === "response-limit"
        ? new Response("x".repeat(1024 * 1024 + 1))
        : Response.json(value),
  );
  const client = createInputPreparationClient(fetcher);
  await client.prepare(selection);
  expect(client.getSnapshot().result).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("late response after screen change and duplicate clicks cannot publish old data", async () => {
  let release!: (response: Response) => void;
  const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    ),
    client = createInputPreparationClient(fetcher);
  const pending = client.prepare(selection);
  await client.prepare(selection);
  expect(fetcher).toHaveBeenCalledTimes(1);
  client.invalidate();
  release(Response.json(fixture()));
  await pending;
  expect(client.getSnapshot()).toEqual({ busy: false, result: null, message: "" });
});
it("explicit cleanup clears downloaded data without activation", async () => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
    Response.json(init?.method === "DELETE" ? { closed: true } : fixture()),
  );
  const client = createInputPreparationClient(fetcher);
  await client.prepare(selection);
  await client.cleanup(selection);
  expect(client.getSnapshot().result).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1][1]?.body).toBeUndefined();
});
it("wire selection mismatch cannot be treated as current even with a valid shape", () => {
  expect(() => decodeInputDownload(fixture(), { ...selection, companyRevision: 4 })).toThrow();
});
