import { describe, expect, it } from "vitest";
import {
  assertLocalRequest,
  attachmentHeaders,
  jsonResponse,
  readBoundedBody,
  readJson,
  StudioError,
  studioRoute,
} from "./studio-http";

describe("로컬 API 경계", () => {
  it("Next 내부 localhost URL은 검증된 실제 Host와 Origin으로 판별한다", () => {
    expect(() =>
      assertLocalRequest(
        new Request("http://localhost:3001/api", {
          headers: {
            host: "127.0.0.1:3001",
            origin: "http://127.0.0.1:3001",
            "sec-fetch-site": "same-origin",
          },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertLocalRequest(
        new Request("http://localhost:3001/api", {
          headers: { host: "127.0.0.1:3001", origin: "http://localhost:3001" },
        }),
      ),
    ).toThrow(StudioError);
  });
  it.each([
    "http://localhost:3000/api/studio",
    "http://127.0.0.1:3000/api/studio",
    "http://[::1]:3000/api/studio",
  ])("루프백 요청 %s 허용", (url) => {
    expect(() =>
      assertLocalRequest(
        new Request(url, {
          headers: { origin: new URL(url).origin, "sec-fetch-site": "same-origin" },
        }),
      ),
    ).not.toThrow();
  });
  it.each([
    ["http://localhost.attacker.test/api", {}],
    ["http://192.168.0.1:3000/api", {}],
    ["http://localhost:3000/api", { origin: "https://attacker.test" }],
    ["http://localhost:3000/api", { origin: "null" }],
    ["http://localhost:3000/api", { "sec-fetch-site": "same-site" }],
    ["http://localhost:3000/api", { "sec-fetch-site": "cross-site" }],
    ["http://localhost:3000/api", { host: "attacker.test" }],
    ["http://localhost:3000/api", { "x-forwarded-host": "attacker.test" }],
  ])("외부·위장 요청 차단 %s %j", (url, headers) => {
    expect(() => assertLocalRequest(new Request(url, { headers: headers as HeadersInit }))).toThrow(
      StudioError,
    );
  });
  it("민감한 내부 오류를 노출하지 않고 캐시를 금지한다", async () => {
    const response = await studioRoute(new Request("http://localhost:3000/api"), () => {
      throw new Error("secret-key and private company document");
    });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(jsonResponse({ ok: true }).headers.get("cache-control")).toContain("no-store");
  });
  it("Content-Length가 없어도 읽기 도중 초과 용량을 차단한다", async () => {
    const request = new Request("http://localhost:3000/api", { method: "POST", body: "123456789" });
    await expect(readBoundedBody(request, 8)).rejects.toMatchObject({
      code: "TOO_LARGE",
      status: 413,
    });
    await expect(
      readBoundedBody(new Request("http://localhost:3000", { method: "POST", body: "abc" }), 3),
    ).resolves.toEqual(new TextEncoder().encode("abc"));
  });
  it("JSON 이외 요청과 잘못된 JSON을 명확히 처리한다", async () => {
    await expect(
      readJson(new Request("http://localhost/api", { method: "POST", body: "{}" })),
    ).rejects.toMatchObject({ code: "CONTENT_TYPE" });
    const response = await studioRoute(new Request("http://localhost/api"), async () => {
      return jsonResponse(
        await readJson(
          new Request("http://localhost/api", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{",
          }),
        ),
      );
    });
    expect(response.status).toBe(400);
  });
  it("다운로드 파일명은 헤더 삽입을 방지하며 첨부파일로만 제공한다", () => {
    const headers = new Headers(
      attachmentHeaders("자료\r\nInjected: yes.txt", "application/octet-stream"),
    );
    expect(headers.get("content-disposition")).toContain("attachment;");
    expect(headers.get("content-disposition")).toContain("%0D%0A");
    expect(headers.has("Injected")).toBe(false);
    expect(headers.get("content-security-policy")).toContain("sandbox");
  });
});
