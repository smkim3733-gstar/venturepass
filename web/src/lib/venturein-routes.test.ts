import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import { emptyProfile } from "./studio-schema";
import type { VentureAccountStatus } from "./venturein-schema";

const state = vi.hoisted(() => ({
  store: null as StudioStore | null,
  account: {
    saved: false,
    maskedLoginId: null,
    updatedAt: null,
    revision: 0,
  } as VentureAccountStatus,
  read: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  start: vi.fn(),
  continueLogin: vi.fn(),
  stop: vi.fn(),
  resume: vi.fn(),
}));
vi.mock("@/lib/studio-storage", async (original) => ({
  ...(await original<typeof import("./studio-storage")>()),
  getStudioStore: () => state.store!,
}));
vi.mock("@/lib/venturein-vault", () => ({
  getVentureAccountStatus: (store: StudioStore, id: string) => {
    store.get(id);
    return state.account;
  },
  readVentureAccount: state.read,
  saveVentureAccount: state.save,
  deleteVentureAccount: state.remove,
}));
vi.mock("@/lib/venturein-runner", () => ({
  getVentureSession: () => ({
    state: "idle",
    message: "연결 전",
    startedAt: null,
    updatedAt: null,
  }),
  startVentureSession: state.start,
  continueVentureSession: state.continueLogin,
  stopVentureSession: state.stop,
  resumeVentureSession: state.resume,
}));
import { GET, PUT, POST, DELETE } from "@/app/api/studio/cases/[caseId]/venturein/route";

describe("벤처인 계정 API 경계", () => {
  let directory: string;
  let caseId: string;
  const context = () => ({ params: Promise.resolve({ caseId }) });
  const request = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
    new Request(`http://localhost:3000/api/studio/cases/${caseId}/venturein`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "venture-account-api-"));
    state.store = new StudioStore(directory);
    caseId = state.store.create({ ...emptyProfile(), companyName: "연결 시험용 가상기업" }).id;
    state.account = { saved: false, maskedLoginId: null, updatedAt: null, revision: 0 };
    for (const fn of [
      state.read,
      state.save,
      state.remove,
      state.start,
      state.continueLogin,
      state.stop,
      state.resume,
    ])
      fn.mockReset();
    state.read.mockResolvedValue({ loginId: "test-only-id", password: "test-only-secret" });
    state.save.mockImplementation(async () => {
      state.account = {
        saved: true,
        maskedLoginId: "te***id",
        updatedAt: new Date().toISOString(),
        revision: 1,
      };
    });
  });
  afterEach(() => {
    state.store!.close();
    const boundary = relative(resolve(tmpdir()), resolve(directory));
    if (!boundary.startsWith("venture-account-api-") || boundary.includes(".."))
      throw new Error("Unsafe test cleanup");
    rmSync(directory, { recursive: true, force: true });
  });
  it("저장 응답은 마스킹만 반환하고 일반 기업 JSON에는 자격정보가 없다", async () => {
    const response = await PUT(
      request("PUT", { revision: 0, loginId: "test-only-id", password: "test-only-secret" }),
      context(),
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("test-only-id");
    expect(body).not.toContain("test-only-secret");
    expect(body).toContain("te***id");
    expect(body).toContain('"automaticSubmissionAvailable":false');
    expect(JSON.stringify(state.store!.get(caseId))).not.toContain("test-only-secret");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("상태 조회는 복호화·로그인을 수행하지 않으며 제출 가능으로 표시하지 않는다", async () => {
    const response = await GET(request("GET"), context());
    expect(await response.json()).toMatchObject({
      automaticSubmissionAvailable: false,
      account: { saved: false },
      preparation: { planId: null },
    });
    expect(state.read).not.toHaveBeenCalled();
    expect(state.start).not.toHaveBeenCalled();
    expect(state.continueLogin).not.toHaveBeenCalled();
  });
  it("다른 출처 요청은 저장·복호화 이전에 거부한다", async () => {
    expect(
      (
        await PUT(
          request(
            "PUT",
            { revision: 0, loginId: "id", password: "pw" },
            { origin: "https://evil.example" },
          ),
          context(),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await POST(
          request(
            "POST",
            { action: "start", accountRevision: 0 },
            { "sec-fetch-site": "cross-site" },
          ),
          context(),
        )
      ).status,
    ).toBe(403);
    expect(state.save).not.toHaveBeenCalled();
    expect(state.read).not.toHaveBeenCalled();
  });
  it("오래된 계정 버전은 기존 연결을 중지하거나 실행하기 전에 거부한다", async () => {
    state.account.revision = 2;
    expect(
      (await PUT(request("PUT", { revision: 1, loginId: "id", password: "pw" }), context())).status,
    ).toBe(409);
    expect(
      (await POST(request("POST", { action: "start", accountRevision: 1 }), context())).status,
    ).toBe(409);
    expect(state.stop).not.toHaveBeenCalled();
    expect(state.read).not.toHaveBeenCalled();
  });
  it("미지원 제출 명령과 초과 입력은 실행하지 않는다", async () => {
    expect(
      (await POST(request("POST", { action: "submit", accountRevision: 0 }), context())).status,
    ).toBe(400);
    expect(
      (
        await PUT(
          request("PUT", { revision: 0, loginId: "id", password: "x".repeat(9000) }),
          context(),
        )
      ).status,
    ).toBe(413);
    expect(state.start).not.toHaveBeenCalled();
    expect(state.save).not.toHaveBeenCalled();
  });
  it.each(["start", "continue"] as const)(
    "%s는 저장 계정을 사용하고 처리 후 참조를 비운다",
    async (action) => {
      const credentials = { loginId: "test-only-id", password: "test-only-secret" };
      state.read.mockResolvedValue(credentials);
      let received: unknown;
      const runner = action === "start" ? state.start : state.continueLogin;
      runner.mockImplementation(async (_id, value) => {
        received = { ...value };
      });
      const response = await POST(request("POST", { action, accountRevision: 0 }), context());
      expect(response.status).toBe(200);
      expect(received).toEqual({ loginId: "test-only-id", password: "test-only-secret" });
      expect(credentials).toEqual({ loginId: "", password: "" });
      expect(runner).toHaveBeenCalledOnce();
      expect(action === "start" ? state.continueLogin : state.start).not.toHaveBeenCalled();
      expect(state.stop).not.toHaveBeenCalled();
      expect(await response.text()).not.toContain("test-only-secret");
    },
  );
  it.each(["start", "continue"] as const)(
    "%s 오류에도 비밀 참조를 비우고 원문을 노출하지 않는다",
    async (action) => {
      const credentials = { loginId: "test-only-id", password: "test-only-secret" };
      state.read.mockResolvedValue(credentials);
      (action === "start" ? state.start : state.continueLogin).mockRejectedValue(
        new Error("test-only-secret leaked by upstream"),
      );
      const response = await POST(request("POST", { action, accountRevision: 0 }), context());
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("test-only-secret");
      expect(credentials).toEqual({ loginId: "", password: "" });
    },
  );
  it("상태 확인은 계정을 복호화하거나 로그인을 재시도하지 않는다", async () => {
    const response = await POST(
      request("POST", { action: "resume", accountRevision: 0 }),
      context(),
    );
    expect(response.status).toBe(200);
    expect(state.resume).toHaveBeenCalledWith(caseId);
    expect(state.read).not.toHaveBeenCalled();
    expect(state.start).not.toHaveBeenCalled();
    expect(state.continueLogin).not.toHaveBeenCalled();
  });
  it("이어서 로그인 요청도 이전 계정 버전과 외부 출처를 거부한다", async () => {
    state.account.revision = 2;
    expect(
      (await POST(request("POST", { action: "continue", accountRevision: 1 }), context())).status,
    ).toBe(409);
    expect(
      (
        await POST(
          request(
            "POST",
            { action: "continue", accountRevision: 2 },
            { origin: "https://evil.example" },
          ),
          context(),
        )
      ).status,
    ).toBe(403);
    expect(state.read).not.toHaveBeenCalled();
    expect(state.continueLogin).not.toHaveBeenCalled();
  });
  it("복호화 도중 계정 버전이 바뀌면 재개하지 않고 비밀 참조를 비운다", async () => {
    const credentials = { loginId: "test-only-id", password: "test-only-secret" };
    state.read.mockImplementation(async () => {
      state.account.revision = 1;
      return credentials;
    });
    const response = await POST(
      request("POST", { action: "continue", accountRevision: 0 }),
      context(),
    );
    expect(response.status).toBe(409);
    expect(state.continueLogin).not.toHaveBeenCalled();
    expect(credentials).toEqual({ loginId: "", password: "" });
  });
  it("연결 시작 중 계정 삭제 경합을 막고 이후 잠금을 해제한다", async () => {
    let release!: (value: { loginId: string; password: string }) => void;
    state.read.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = POST(request("POST", { action: "start", accountRevision: 0 }), context());
    await vi.waitFor(() => expect(state.read).toHaveBeenCalled());
    expect((await DELETE(request("DELETE", { revision: 0 }), context())).status).toBe(409);
    expect(state.remove).not.toHaveBeenCalled();
    release({ loginId: "test-only-id", password: "test-only-secret" });
    expect((await pending).status).toBe(200);
    expect((await DELETE(request("DELETE", { revision: 0 }), context())).status).toBe(200);
    expect(state.remove).toHaveBeenCalledOnce();
  });
});
