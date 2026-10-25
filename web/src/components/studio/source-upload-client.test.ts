import { afterEach, describe, expect, it, vi } from "vitest";
import { directUploadThreshold, uploadSourceFile } from "./source-upload-client";

const fields = {
  kind: "technology",
  revision: 3,
  allowAi: false,
  extractionMode: "extract" as const,
};
afterEach(() => vi.unstubAllGlobals());

describe("browser source upload path", () => {
  it("keeps multipart uploads locally and for small files on the web", async () => {
    const fetchMock = vi.fn(async () => Response.json({}, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const big = new File([new Uint8Array(directUploadThreshold + 1)], "큰.pdf");
    await uploadSourceFile("case-1", big, fields, false);
    await uploadSourceFile("case-1", new File(["작은"], "작은.txt"), fields, true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect(url).toBe("/api/studio/cases/case-1/sources");
      expect(init.body).toBeInstanceOf(FormData);
    }
  });

  it("sends large web uploads to storage between start and complete", async () => {
    const calls: [string, RequestInit][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push([url, init]);
        if (url.endsWith("/direct-upload"))
          return Response.json({ uploadId: "u-1", uploadUrl: "https://storage.test/signed" });
        if (url === "https://storage.test/signed") return new Response("{}", { status: 200 });
        return Response.json({ ok: true }, { status: 201 });
      }),
    );
    const big = new File([new Uint8Array(directUploadThreshold + 1)], "큰.pdf", {
      type: "application/pdf",
    });
    const response = await uploadSourceFile("case-1", big, fields, true);
    expect(response.status).toBe(201);
    expect(calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
      "POST /api/studio/cases/case-1/sources/direct-upload",
      "PUT https://storage.test/signed",
      "POST /api/studio/cases/case-1/sources/direct-upload/complete",
    ]);
    expect(JSON.parse(String(calls[2][1].body))).toMatchObject({
      uploadId: "u-1",
      fileName: "큰.pdf",
      revision: 3,
    });
  });

  it("reports a failed storage PUT without calling complete", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith("/direct-upload")
        ? Response.json({ uploadId: "u-1", uploadUrl: "https://storage.test/signed" })
        : new Response("{}", { status: 403 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const big = new File([new Uint8Array(directUploadThreshold + 1)], "큰.pdf");
    const response = await uploadSourceFile("case-1", big, fields, true);
    expect(response.status).toBe(502);
    expect((await response.json()).code).toBe("DIRECT_UPLOAD_FAILED");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
