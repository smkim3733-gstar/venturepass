import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { studioFetch, StudioApiError } from "./shared";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  vi.unstubAllGlobals();
});
const respond = (body: unknown, status = 409) =>
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  );
describe("HTTP failure body handling", () => {
  it.each([
    null,
    [],
    true,
    42,
    "failure",
    { error: {} },
    { error: [] },
    { error: 17 },
    { error: false },
    { error: "" },
    { error: " \n " },
  ])("keeps status and a readable fallback for malformed body %#", async (body) => {
    respond(body);
    const failure = await studioFetch("/synthetic").catch((error) => error);
    expect(failure).toBeInstanceOf(StudioApiError);
    expect(failure).toMatchObject({
      status: 409,
      message: "요청을 처리하지 못했습니다.",
      code: undefined,
    });
  });
  it("preserves a nonblank server message and valid code verbatim", async () => {
    respond({ error: "  합성 실패\n다시 확인하세요.  ", code: "SYNTHETIC_ERROR_1" }, 429);
    await expect(studioFetch("/synthetic")).rejects.toMatchObject({
      status: 429,
      message: "  합성 실패\n다시 확인하세요.  ",
      code: "SYNTHETIC_ERROR_1",
    });
  });
  it.each(["bad-code", 17, null, "A".repeat(101)])(
    "omits an invalid machine code %#",
    async (code) => {
      respond({ error: "합성 실패", code }, 500);
      await expect(studioFetch("/synthetic")).rejects.toMatchObject({
        status: 500,
        message: "합성 실패",
        code: undefined,
      });
    },
  );
  it("keeps the existing JSON parsing message and HTTP status", async () => {
    fetchMock.mockResolvedValue(new Response("<html>synthetic</html>", { status: 502 }));
    await expect(studioFetch("/synthetic")).rejects.toMatchObject({
      status: 502,
      message: "서버 응답을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.",
    });
  });
  it("leaves a successful null body for the caller to validate", async () => {
    respond(null, 200);
    await expect(studioFetch("/synthetic")).resolves.toBeNull();
  });
  it("keeps successful content and request settings unchanged", async () => {
    const body = { value: "  합성 원문\n보존  " };
    respond(body, 200);
    await expect(
      studioFetch("/synthetic", {
        method: "PATCH",
        body: "synthetic-request",
        headers: { "X-Synthetic": "yes" },
        cache: "reload",
      }),
    ).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/synthetic", {
      method: "PATCH",
      body: "synthetic-request",
      headers: { "X-Synthetic": "yes" },
      cache: "no-store",
    });
  });
  it("does not replace a transport rejection", async () => {
    const failure = new Error("synthetic transport failure");
    fetchMock.mockRejectedValue(failure);
    await expect(studioFetch("/synthetic")).rejects.toBe(failure);
  });
});
