import "server-only";

import { spawn } from "node:child_process";
import { win32 } from "node:path";
import { z } from "zod";
import { StudioError } from "./studio-http";
import type { StudioStore, VentureAccountEnvelope } from "./studio-storage";

const credentialsSchema = z.object({
  loginId: z.string().trim().min(1).max(200),
  // Password whitespace is significant and must never be normalized.
  password: z.string().min(1).max(512),
});
const payloadSchema = credentialsSchema.extend({
  version: z.literal(1),
  caseId: z.string().uuid(),
});
const MAX_OUTPUT = 65536;
const TIMEOUT_MS = 15000;

// Fixed code only. Credentials and encrypted payloads travel through stdin, never argv or env.
const DPAPI_COMMAND = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = $null
$result = $null
try {
  Add-Type -AssemblyName System.Security
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $data = [Convert]::FromBase64String($request.data)
  $entropy = [Convert]::FromBase64String($request.entropy)
  if ($request.operation -eq 'protect') {
    $result = [System.Security.Cryptography.ProtectedData]::Protect($data, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  } elseif ($request.operation -eq 'unprotect') {
    $result = [System.Security.Cryptography.ProtectedData]::Unprotect($data, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  } else {
    throw 'INVALID_OPERATION'
  }
  [Console]::Out.Write([Convert]::ToBase64String($result))
} catch {
  [Console]::Error.Write('DPAPI_FAILED')
  exit 1
} finally {
  if ($null -ne $data) { [Array]::Clear($data, 0, $data.Length) }
  if ($null -ne $result) { [Array]::Clear($result, 0, $result.Length) }
}
`;

function vaultError() {
  return new StudioError(
    "Windows 계정 보호 저장소를 사용할 수 없습니다. 앱을 저장 당시의 Windows 사용자로 실행하거나 연결 정보를 다시 등록해 주세요.",
    503,
    "VAULT_UNAVAILABLE",
  );
}

function transformDpapi(
  operation: "protect" | "unprotect",
  caseId: string,
  data: Uint8Array,
): Promise<Buffer> {
  if (process.platform !== "win32") return Promise.reject(vaultError());
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  if (!/^[a-z]:\\/i.test(systemRoot)) return Promise.reject(vaultError());
  const executable = win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return new Promise<Buffer>((resolve, reject) => {
    let finished = false;
    let received = 0;
    const chunks: Buffer[] = [];
    const child = spawn(
      executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", DPAPI_COMMAND],
      { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] },
    );
    const wipe = () => {
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
    };
    const fail = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill();
      wipe();
      reject(vaultError());
    };
    const timer = setTimeout(fail, TIMEOUT_MS);
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stdout.on("error", fail);
    child.stderr.on("error", fail);
    child.stderr.on("data", () => {
      // Intentionally discard diagnostics: never return or log process output to the caller.
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (finished) return;
      received += chunk.length;
      if (received > MAX_OUTPUT) return fail();
      chunks.push(chunk);
    });
    child.on("close", (code) => {
      if (finished) return;
      if (code !== 0) return fail();
      const joined = Buffer.concat(chunks);
      const encoded = joined.toString("ascii").trim();
      joined.fill(0);
      wipe();
      if (
        !encoded ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
      )
        return fail();
      const output = Buffer.from(encoded, "base64");
      if (output.length === 0 || output.length > 32768) {
        output.fill(0);
        return fail();
      }
      finished = true;
      clearTimeout(timer);
      resolve(output);
    });
    child.stdin.end(
      JSON.stringify({
        operation,
        data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64"),
        entropy: Buffer.from(`venture-pass:venturein:v1:${caseId}`, "utf8").toString("base64"),
      }),
    );
  }).catch(() => {
    throw vaultError();
  });
}

function toStatus(account: VentureAccountEnvelope) {
  return {
    saved: account.encryptedPayload !== null,
    maskedLoginId: account.maskedLoginId,
    updatedAt: account.updatedAt,
    revision: account.revision,
  };
}

function maskLoginId(value: string) {
  const characters = Array.from(value);
  return characters.length < 4
    ? "***"
    : `${characters.slice(0, 2).join("")}***${characters.at(-1)}`;
}

export function getVentureAccountStatus(store: StudioStore, caseId: string) {
  return toStatus(store.getVentureAccountEnvelope(caseId));
}

export async function saveVentureAccount(
  store: StudioStore,
  caseId: string,
  credentials: { loginId: string; password: string },
  expectedRevision: number,
) {
  const parsed = credentialsSchema.safeParse(credentials);
  if (!parsed.success)
    throw new StudioError("벤처인 아이디와 비밀번호를 확인해 주세요.", 400, "INVALID_CREDENTIALS");
  if (getVentureAccountStatus(store, caseId).revision !== expectedRevision)
    throw new StudioError(
      "벤처인 연결 정보가 변경되었습니다. 다시 불러와 주세요.",
      409,
      "STALE_ACCOUNT_REVISION",
    );
  const plain = Buffer.from(JSON.stringify({ version: 1, caseId, ...parsed.data }), "utf8");
  try {
    const encrypted = await transformDpapi("protect", caseId, plain);
    return toStatus(
      store.saveVentureAccountEnvelope(
        caseId,
        expectedRevision,
        encrypted,
        maskLoginId(parsed.data.loginId),
      ),
    );
  } finally {
    plain.fill(0);
  }
}

export function deleteVentureAccount(store: StudioStore, caseId: string, expectedRevision: number) {
  return toStatus(store.deleteVentureAccountEnvelope(caseId, expectedRevision));
}

/** Server worker only. The result must never enter a route response, StudioCase, AI input, or logs. */
export async function readVentureAccount(store: StudioStore, caseId: string) {
  const account = store.getVentureAccountEnvelope(caseId);
  if (!account.encryptedPayload)
    throw new StudioError("벤처인 연결 정보를 먼저 저장해 주세요.", 409, "ACCOUNT_NOT_SAVED");
  const plain = await transformDpapi("unprotect", caseId, account.encryptedPayload);
  try {
    let value: unknown;
    try {
      value = JSON.parse(plain.toString("utf8"));
    } catch {
      throw vaultError();
    }
    const parsed = payloadSchema.safeParse(value);
    if (!parsed.success || parsed.data.caseId !== caseId) throw vaultError();
    if (getVentureAccountStatus(store, caseId).revision !== account.revision)
      throw new StudioError(
        "벤처인 연결 정보가 변경되었습니다. 다시 시도해 주세요.",
        409,
        "STALE_ACCOUNT_REVISION",
      );
    return { loginId: parsed.data.loginId, password: parsed.data.password };
  } finally {
    plain.fill(0);
  }
}
