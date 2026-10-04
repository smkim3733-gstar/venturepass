import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import { emptyProfile } from "./studio-schema";
import type { VentureSessionStatus } from "./venturein-schema";
vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  store: null as StudioStore | null,
  session: {
    state: "idle",
    message: "private detail excluded",
    startedAt: null,
    updatedAt: null,
  } as VentureSessionStatus,
  accountRevision: 0,
  saved: false,
  accountReads: 0,
  changeAccount: false,
}));
vi.mock("@/lib/studio-storage", async (original) => ({
  ...(await original<typeof import("./studio-storage")>()),
  getStudioStore: () => state.store!,
}));
vi.mock("@/lib/venturein-vault", () => ({
  getVentureAccountStatus: () => ({
    saved: state.saved,
    maskedLoginId: "secret-excluded",
    updatedAt: null,
    revision: state.accountRevision + (state.changeAccount && ++state.accountReads > 1 ? 1 : 0),
  }),
  readVentureAccount: () => {
    throw Error("No decryption");
  },
}));
vi.mock("@/lib/venturein-runner", () => ({
  getVentureSession: () => ({ ...state.session }),
  inspectVentureApplication: () => {
    throw Error("No browser inspection");
  },
}));
import { GET } from "@/app/api/studio/cases/[caseId]/venturein/overview/route";
import { readVentureOverview, ventureOverviewAction } from "./venturein-overview-types";
let dir: string, caseId: string;
const request = (query = "", origin = "http://localhost:3000") =>
  new Request("http://localhost:3000/api/studio/cases/" + caseId + "/venturein/overview" + query, {
    headers: { origin },
  });
const read = () => GET(request(), { params: Promise.resolve({ caseId }) });
function rows() {
  const db = new DatabaseSync(join(dir, "studio.sqlite"), { readOnly: true });
  try {
    return [
      "studio_cases",
      "venture_accounts",
      "venture_workflows",
      "studio_prepared_packages",
    ].map((t) => db.prepare("SELECT * FROM " + t + " ORDER BY 1").all());
  } finally {
    db.close();
  }
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "venture-overview-test-"));
  state.store = new StudioStore(dir);
  caseId = state.store.create({ ...emptyProfile(), companyName: "합성 연결 요약" }).id;
  state.session = {
    state: "idle",
    message: "private detail excluded",
    startedAt: null,
    updatedAt: null,
  };
  state.saved = false;
  state.accountRevision = 0;
  state.accountReads = 0;
  state.changeAccount = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw Error("No external requests");
    }),
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  state.store!.close();
  const r = relative(resolve(tmpdir()), resolve(dir));
  if (!r.startsWith("venture-overview-test-") || r.includes("..")) throw Error("Unsafe cleanup");
  rmSync(dir, { recursive: true, force: true });
});
it("reads only a case-bound local summary without source/profile/credentials or writes", async () => {
  const before = rows();
  const response = await read();
  const value = await response.json();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(readVentureOverview(value, { id: caseId, revision: 0 })).toMatchObject({
    caseId,
    companyRevision: 0,
    phase: "connect",
    accountSaved: false,
    automaticSubmissionAvailable: false,
    officialStatusChecked: false,
    transmissionAllowed: false,
  });
  expect(JSON.stringify(value)).not.toMatch(/secret-excluded|private detail|합성 연결 요약/);
  expect(rows()).toEqual(before);
  state.store!.close();
  state.store = new StudioStore(dir);
  const reopened = await (await read()).json();
  expect({ ...reopened, readAt: null }).toEqual({ ...value, readAt: null });
  expect(rows()).toEqual(before);
});
it.each([
  "starting",
  "awaiting_setup",
  "awaiting_login",
  "awaiting_auth",
  "login_failed",
  "stopped",
  "connected_unmapped",
] as const)("keeps %s separate from receipt/submission", async (session) => {
  state.session.state = session;
  state.session.startedAt = "2026-10-05T00:00:00.000Z";
  const value = await (await read()).json();
  const action = ventureOverviewAction(value);
  expect(value.sessionState).toBe(session);
  expect(value.officialStatusChecked).toBe(false);
  expect(action.label).not.toMatch(/접수 시작|제출 실행|접수 완료/);
});
it("saved account does not mean successful login", async () => {
  state.saved = true;
  state.accountRevision = 2;
  const value = await (await read()).json();
  expect(ventureOverviewAction(value).title).toBe("저장한 계정으로 연결을 준비하세요");
  expect(value.phase).toBe("connect");
});
it("keeps a previous unknown execution visible even after the process lost its session", async () => {
  state.store!.saveVentureWorkflowEnvelope(
    caseId,
    0,
    JSON.stringify({
      snapshot: null,
      draft: null,
      history: [],
      execution: {
        id: randomUUID(),
        snapshotId: "old-screen",
        status: "stopped",
        startedAt: "2026-10-05T00:00:00.000Z",
        finishedAt: "2026-10-05T00:01:00.000Z",
        completedFieldKeys: [],
        attemptedFieldKey: "company",
        code: "INPUT_RESULT_UNKNOWN",
      },
    }),
  );
  const before = rows();
  const value = await (await read()).json();
  expect(value.phase).toBe("connect");
  expect(value.previousInputNeedsCheck).toBe(true);
  expect(ventureOverviewAction(value).label).toBe("이전 입력 결과 확인");
  expect(rows()).toEqual(before);
});
it("rejects different company, old revision, extra fields and implied transmission rights", async () => {
  const value = await (await read()).json();
  for (const changed of [
    { ...value, caseId: randomUUID() },
    { ...value, companyRevision: 1 },
    { ...value, token: "not-an-approval" },
    { ...value, transmissionAllowed: true },
    { ...value, officialStatusChecked: true },
    { ...value, automaticSubmissionAvailable: true },
  ])
    expect(() => readVentureOverview(changed, { id: caseId, revision: 0 })).toThrow();
});
it("declines a mixed account snapshot", async () => {
  state.changeAccount = true;
  const response = await read();
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "STALE_OVERVIEW" });
});
it("rejects cross-origin and extra query before reading", async () => {
  for (const req of [request("?action=start"), request("", "https://example.invalid")]) {
    const response = await GET(req, { params: Promise.resolve({ caseId }) });
    expect([400, 403]).toContain(response.status);
  }
});
it("the navigation projection separates all connected phases and never runs operations", async () => {
  const value = await (await read()).json();
  for (const phase of [
    "connect",
    "inspect",
    "map",
    "review",
    "execute",
    "verify",
    "handoff",
  ] as const) {
    const action = ventureOverviewAction({ ...value, sessionState: "connected_unmapped", phase });
    expect(action.label.length).toBeGreaterThan(0);
    expect(action.description).toMatch(/승인|공식 사이트/);
  }
});
