import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { emptyProfile } from "./studio-schema";
import { StudioStore } from "./studio-storage";
import {
  deleteVentureAccount,
  getVentureAccountStatus,
  readVentureAccount,
  saveVentureAccount,
} from "./venturein-vault";

type BridgeRequest = { operation: "protect" | "unprotect"; data: string; entropy: string };

describe("벤처인 계정 보관", () => {
  let directory: string;
  let store: StudioStore;
  let caseId: string;
  let handleBridge: (request: BridgeRequest) => string;
  const protectedValues = new Map<string, { data: string; entropy: string }>();
  const bridgeRequests: BridgeRequest[] = [];
  const fixture = { loginId: "fictional-venture-account", password: " fictional-password-!한글 " };
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

  beforeEach(() => {
    // Unit tests exercise the subprocess protocol without accessing any OS credentials.
    Object.defineProperty(process, "platform", { value: "win32" });
    directory = mkdtempSync(join(tmpdir(), "venture-vault-test-"));
    store = new StudioStore(directory);
    caseId = store.create({ ...emptyProfile(), companyName: "계정 보관 가상 시험기업" }).id;
    protectedValues.clear();
    bridgeRequests.length = 0;
    handleBridge = (request) => {
      if (request.operation === "protect") {
        const encrypted = randomBytes(128).toString("base64");
        protectedValues.set(encrypted, { data: request.data, entropy: request.entropy });
        return encrypted;
      }
      const value = protectedValues.get(request.data);
      if (!value || value.entropy !== request.entropy) throw new Error("DPAPI_FAILED");
      return value.data;
    };
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(),
      });
      let input = "";
      child.stdin.on("data", (chunk: Buffer) => {
        input += chunk.toString();
      });
      child.stdin.on("finish", () => {
        queueMicrotask(() => {
          try {
            const request = JSON.parse(input) as BridgeRequest;
            bridgeRequests.push(request);
            child.stdout.end(handleBridge(request));
            child.emit("close", 0);
          } catch {
            child.stderr.end(`fixture diagnostic ${fixture.password}`);
            child.emit("close", 1);
          }
        });
      });
      return child;
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", originalPlatform);
    store.close();
    const target = resolve(directory);
    const prefix =
      resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/") + "venture-vault-test-";
    if (!target.startsWith(prefix)) throw new Error("Unsafe test cleanup");
    rmSync(target, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("암호화 계정은 메타만 노출하며 기업 JSON과 DB/WAL 파일에 원문을 저장하지 않는다", async () => {
    const companyBefore = store.get(caseId);
    expect(getVentureAccountStatus(store, caseId)).toEqual({
      saved: false,
      maskedLoginId: null,
      updatedAt: null,
      revision: 0,
    });
    const status = await saveVentureAccount(store, caseId, fixture, 0);
    expect(Object.keys(status).sort()).toEqual(["maskedLoginId", "revision", "saved", "updatedAt"]);
    expect(status).toMatchObject({ saved: true, maskedLoginId: "fi***t", revision: 1 });
    expect(store.get(caseId)).toEqual(companyBefore);
    expect(JSON.stringify(store.get(caseId))).not.toContain(fixture.loginId);
    expect(JSON.stringify(store.list())).not.toContain(fixture.password);
    expect(await readVentureAccount(store, caseId)).toEqual(fixture);
    for (const name of readdirSync(directory)) {
      const data = readFileSync(join(directory, name));
      expect(data.includes(Buffer.from(fixture.loginId))).toBe(false);
      expect(data.includes(Buffer.from(fixture.password))).toBe(false);
    }
  });

  it("비밀은 고정 명령의 stdin에만 보내고 숨김·비셸 프로세스를 사용한다", async () => {
    await saveVentureAccount(store, caseId, fixture, 0);
    const [executable, args, options] = spawnMock.mock.calls[0];
    expect(executable).toMatch(
      /^[A-Z]:\\.+\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i,
    );
    expect(options).toMatchObject({
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(JSON.stringify([executable, args, options])).not.toContain(fixture.loginId);
    expect(JSON.stringify([executable, args, options])).not.toContain(fixture.password);
    const payload = JSON.parse(Buffer.from(bridgeRequests[0].data, "base64").toString());
    expect(payload).toEqual({ version: 1, caseId, ...fixture });
    expect(Buffer.from(bridgeRequests[0].entropy, "base64").toString()).toBe(
      `venture-pass:venturein:v1:${caseId}`,
    );
  });

  it("계정 해제는 복호화를 막으며 이전 버전 저장을 되살리지 않는다", async () => {
    await saveVentureAccount(store, caseId, fixture, 0);
    expect(deleteVentureAccount(store, caseId, 1)).toMatchObject({
      saved: false,
      maskedLoginId: null,
      revision: 2,
    });
    await expect(readVentureAccount(store, caseId)).rejects.toMatchObject({
      code: "ACCOUNT_NOT_SAVED",
    });
    await expect(saveVentureAccount(store, caseId, fixture, 0)).rejects.toMatchObject({
      code: "STALE_ACCOUNT_REVISION",
    });
    expect((await saveVentureAccount(store, caseId, fixture, 2)).revision).toBe(3);
  });

  it("다른 기업의 암호문과 손상된 암호문은 복호화를 거절한다", async () => {
    await saveVentureAccount(store, caseId, fixture, 0);
    const another = store.create({ ...emptyProfile(), companyName: "다른 가상 기업" });
    const cipher = store.getVentureAccountEnvelope(caseId).encryptedPayload!;
    store.saveVentureAccountEnvelope(another.id, 0, cipher, "fi***t");
    await expect(readVentureAccount(store, another.id)).rejects.toMatchObject({
      code: "VAULT_UNAVAILABLE",
    });
    const corrupt = new Uint8Array(cipher);
    corrupt[0] ^= 1;
    store.saveVentureAccountEnvelope(caseId, 1, corrupt, "fi***t");
    await expect(readVentureAccount(store, caseId)).rejects.toMatchObject({
      code: "VAULT_UNAVAILABLE",
    });
  });

  it("보호 저장소 실패는 진단의 비밀을 노출하거나 평문 저장으로 대체하지 않는다", async () => {
    handleBridge = () => {
      throw new Error(fixture.password);
    };
    const failure = await saveVentureAccount(store, caseId, fixture, 0).catch(
      (error: Error) => error,
    );
    expect(failure).toMatchObject({ code: "VAULT_UNAVAILABLE" });
    expect(String(failure)).not.toContain(fixture.password);
    expect(getVentureAccountStatus(store, caseId).saved).toBe(false);
    expect(getVentureAccountStatus(store, caseId).revision).toBe(0);
  });

  it("복호화 도중 연결이 해제되면 읽은 비밀을 반환하지 않는다", async () => {
    await saveVentureAccount(store, caseId, fixture, 0);
    const previousBridge = handleBridge;
    handleBridge = (request) => {
      const result = previousBridge(request);
      if (request.operation === "unprotect") deleteVentureAccount(store, caseId, 1);
      return result;
    };
    await expect(readVentureAccount(store, caseId)).rejects.toMatchObject({
      code: "STALE_ACCOUNT_REVISION",
    });
  });

  it("동시에 시작한 두 계정 저장 중 첫 번째 버전만 저장한다", async () => {
    const results = await Promise.allSettled([
      saveVentureAccount(store, caseId, fixture, 0),
      saveVentureAccount(
        store,
        caseId,
        { loginId: "other-fixture", password: "other-fixture-password" },
        0,
      ),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(getVentureAccountStatus(store, caseId).revision).toBe(1);
  });

  it("비정상 프로세스 출력과 시작 실패를 비밀 없는 저장소 오류로 처리한다", async () => {
    handleBridge = () => "malformed plaintext";
    await expect(saveVentureAccount(store, caseId, fixture, 0)).rejects.toMatchObject({
      code: "VAULT_UNAVAILABLE",
    });
    spawnMock.mockImplementationOnce(() => {
      throw new Error(fixture.password);
    });
    await expect(saveVentureAccount(store, caseId, fixture, 0)).rejects.toMatchObject({
      code: "VAULT_UNAVAILABLE",
    });
    expect(getVentureAccountStatus(store, caseId).saved).toBe(false);
  });

  it("응답이 없는 보호 프로세스를 종료하고 저장을 완료로 처리하지 않는다", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    spawnMock.mockReturnValueOnce(child);
    const result = expect(saveVentureAccount(store, caseId, fixture, 0)).rejects.toMatchObject({
      code: "VAULT_UNAVAILABLE",
    });
    await vi.advanceTimersByTimeAsync(15000);
    await result;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(getVentureAccountStatus(store, caseId).saved).toBe(false);
  });

  it("허용량을 넘긴 출력과 지원하지 않는 운영체제에서는 저장을 거절한다", async () => {
    handleBridge = () => "a".repeat(70000);
    await expect(saveVentureAccount(store, caseId, fixture, 0)).rejects.toMatchObject({
      code: "VAULT_UNAVAILABLE",
    });
    Object.defineProperty(process, "platform", { value: "linux" });
    spawnMock.mockClear();
    await expect(saveVentureAccount(store, caseId, fixture, 0)).rejects.toMatchObject({
      code: "VAULT_UNAVAILABLE",
    });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(getVentureAccountStatus(store, caseId).saved).toBe(false);
  });

  it.skipIf(process.platform !== "win32" || process.env.VENTURE_TEST_DPAPI !== "1")(
    "실제 Windows DPAPI는 가상 계정을 복원하며 다른 기업·변조 데이터는 거절한다",
    async () => {
      const actual =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      spawnMock.mockImplementation(actual.spawn);
      await saveVentureAccount(store, caseId, fixture, 0);
      expect(await readVentureAccount(store, caseId)).toEqual(fixture);
      const another = store.create({ ...emptyProfile(), companyName: "DPAPI 격리 가상 기업" });
      const cipher = store.getVentureAccountEnvelope(caseId).encryptedPayload!;
      store.saveVentureAccountEnvelope(another.id, 0, cipher, "fi***t");
      await expect(readVentureAccount(store, another.id)).rejects.toMatchObject({
        code: "VAULT_UNAVAILABLE",
      });
      const corrupt = new Uint8Array(cipher);
      corrupt[corrupt.length - 1] ^= 1;
      store.saveVentureAccountEnvelope(caseId, 1, corrupt, "fi***t");
      await expect(readVentureAccount(store, caseId)).rejects.toMatchObject({
        code: "VAULT_UNAVAILABLE",
      });
    },
    30000,
  );
});
