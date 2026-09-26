import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import { emptyProfile } from "./studio-schema";
import type { VentureScreenSnapshot } from "./venturein-inspection";
import type { VentureSubmissionDraft } from "./venturein-preflight";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  store: null as StudioStore | null,
  accountRevision: 1,
  inspect: vi.fn(),
  preview: vi.fn(),
}));
vi.mock("@/lib/studio-storage", async (original) => ({
  ...(await original<typeof import("./studio-storage")>()),
  getStudioStore: () => state.store!,
}));
vi.mock("@/lib/venturein-vault", () => ({
  getVentureAccountStatus: () => ({
    saved: true,
    maskedLoginId: "te***t",
    revision: state.accountRevision,
    updatedAt: null,
  }),
}));
vi.mock("@/lib/venturein-runner", () => ({
  inspectVentureApplication: state.inspect,
  previewVentureApplication: state.preview,
  getVentureSession: () => ({
    state: "connected_unmapped",
    message: "시험 연결",
    startedAt: "2026-09-25T00:00:00.000Z",
    updatedAt: "2026-09-25T00:00:00.000Z",
  }),
}));

import { GET, POST, PUT } from "@/app/api/studio/cases/[caseId]/venturein/workflow/route";
import { GET as PREVIEW } from "@/app/api/studio/cases/[caseId]/venturein/workflow/preview/route";

describe("공식 신청 화면과 로컬 연결안 API", () => {
  let directory: string;
  let caseId: string;
  let screen: VentureScreenSnapshot;
  const context = () => ({ params: Promise.resolve({ caseId }) });
  const request = (
    method: string,
    body?: unknown,
    headers: Record<string, string> = {},
    query = "",
  ) =>
    new Request(`http://localhost:3000/api/studio/cases/${caseId}/venturein/workflow${query}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const inspectBody = (extra: Record<string, unknown> = {}) => ({
    action: "inspect",
    destination: "current",
    revision: 0,
    accountRevision: 1,
    companyRevision: 0,
    ...extra,
  });
  const draft = (): VentureSubmissionDraft => ({
    caseId,
    snapshotId: screen.id,
    sessionStartedAt: "2026-09-25T00:00:00.000Z",
    accountRevision: 1,
    companyRevision: 0,
    planId: null,
    planVersion: null,
    textMappings: [
      {
        fieldKey: "companyName",
        source: { kind: "profile", property: "companyName" },
        confirmed: true,
      },
    ],
    attachmentMappings: [],
  });
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "venture-workflow-test-"));
    state.store = new StudioStore(directory);
    caseId = state.store.create({
      ...emptyProfile(),
      companyName: "신청연결 가상기업",
      businessNumber: "1234567890",
    }).id;
    state.accountRevision = 1;
    screen = {
      id: randomUUID(),
      observedAt: "2026-09-25T00:00:00.000Z",
      url: "https://www.smes.go.kr/venturein/aply/v2",
      title: "시험 신청서",
      companyEvidence: [
        { kind: "businessNumber", label: "사업자등록번호", value: "123-45-67890", source: "table" },
      ],
      fields: [
        {
          key: "companyName",
          kind: "input",
          id: "companyName",
          name: "companyName",
          type: "text",
          labels: ["기업명"],
          required: true,
          maxLength: 100,
          accept: null,
          multiple: false,
          disabled: false,
          readOnly: false,
          options: [],
        },
      ],
      truncated: false,
      warnings: [],
    };
    state.inspect.mockReset();
    state.preview.mockReset();
    state.preview.mockResolvedValue(Buffer.from("synthetic-image-bytes"));
    state.inspect.mockImplementation(async () => ({
      screen,
      sessionStartedAt: "2026-09-25T00:00:00.000Z",
    }));
  });
  afterEach(() => {
    state.store!.close();
    const boundary = relative(resolve(tmpdir()), resolve(directory));
    if (!boundary.startsWith("venture-workflow-test-") || boundary.includes(".."))
      throw new Error("Unsafe cleanup");
    rmSync(directory, { recursive: true, force: true });
  });
  it("조회는 브라우저 작업 없이 준비 상태를 반환한다", async () => {
    const response = await GET(request("GET"), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      revision: 0,
      snapshot: null,
      draft: null,
      report: { automaticSubmissionAvailable: false },
    });
    expect(state.inspect).not.toHaveBeenCalled();
    expect(state.preview).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("서버에서 읽은 화면만 계정·기업·세션에 결합해 저장한다", async () => {
    const response = await POST(request("POST", inspectBody()), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      revision: 1,
      snapshot: { caseId, accountRevision: 1, screen: { id: screen.id } },
      draft: null,
    });
    expect(state.inspect).toHaveBeenCalledWith(caseId, "current");
    expect(JSON.stringify(state.store!.get(caseId))).not.toContain(screen.id);
  });
  it.each([
    { action: "submit" },
    { destination: "https://evil.example" },
    { snapshot: {} },
    { approval: true },
  ])("미지원 동작과 임의 화면 입력을 거부한다: %j", async (extra) => {
    expect((await POST(request("POST", inspectBody(extra)), context())).status).toBe(400);
    expect(state.inspect).not.toHaveBeenCalled();
  });
  it("다른 출처와 초과 요청은 브라우저 실행 전에 거부한다", async () => {
    expect(
      (await POST(request("POST", inspectBody(), { origin: "https://evil.example" }), context()))
        .status,
    ).toBe(403);
    expect(
      (await POST(request("POST", { ...inspectBody(), huge: "x".repeat(140000) }), context()))
        .status,
    ).toBe(413);
    expect(state.inspect).not.toHaveBeenCalled();
  });
  it.each([{ revision: 2 }, { accountRevision: 0 }, { companyRevision: 1 }])(
    "오래된 버전은 화면 읽기 전에 거부한다: %j",
    async (extra) => {
      expect((await POST(request("POST", inspectBody(extra)), context())).status).toBe(409);
      expect(state.inspect).not.toHaveBeenCalled();
    },
  );
  it("화면 읽기 중 계정이 변경되면 결과를 저장하지 않는다", async () => {
    state.inspect.mockImplementation(async () => {
      state.accountRevision = 2;
      return { screen, sessionStartedAt: "2026-09-25T00:00:00.000Z" };
    });
    expect((await POST(request("POST", inspectBody()), context())).status).toBe(409);
    expect(state.store!.getVentureWorkflowEnvelope(caseId).body).toBeNull();
  });
  it("동시 화면 확인은 한 번만 실행하고 잠금을 해제한다", async () => {
    let release!: (value: unknown) => void;
    state.inspect.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const first = POST(request("POST", inspectBody()), context());
    await vi.waitFor(() => expect(state.inspect).toHaveBeenCalledTimes(1));
    expect((await POST(request("POST", inspectBody()), context())).status).toBe(409);
    release({ screen, sessionStartedAt: "2026-09-25T00:00:00.000Z" });
    expect((await first).status).toBe(200);
    expect((await GET(request("GET"), context())).status).toBe(200);
  });
  it("연결안을 로컬 저장하고 화면을 다시 읽으면 기존 선택을 초기화한다", async () => {
    await POST(request("POST", inspectBody()), context());
    const response = await PUT(
      request("PUT", { revision: 1, accountRevision: 1, companyRevision: 0, draft: draft() }),
      context(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ revision: 2, draft: { snapshotId: screen.id } });
    screen = { ...screen, id: randomUUID() };
    const refreshed = await POST(request("POST", inspectBody({ revision: 2 })), context());
    expect(await refreshed.json()).toMatchObject({ revision: 3, draft: null });
  });
  it("다른 기업이나 이전 화면의 연결안을 저장하지 않는다", async () => {
    await POST(request("POST", inspectBody()), context());
    for (const extra of [
      { caseId: randomUUID() },
      { snapshotId: randomUUID() },
      { accountRevision: 2 },
      { companyRevision: 2 },
    ]) {
      expect(
        (
          await PUT(
            request("PUT", {
              revision: 1,
              accountRevision: 1,
              companyRevision: 0,
              draft: { ...draft(), ...extra },
            }),
            context(),
          )
        ).status,
      ).toBe(409);
    }
    expect(state.store!.getVentureWorkflowEnvelope(caseId).revision).toBe(1);
  });
  it("검토안 다운로드는 제출과 구별하고 브라우저를 조작하지 않는다", async () => {
    await POST(request("POST", inspectBody()), context());
    state.inspect.mockClear();
    const response = await GET(request("GET", undefined, {}, "?download=1"), context());
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(await response.json()).toMatchObject({
      latestExecutionExternalWritesPerformed: false,
      automaticSubmissionAvailable: false,
    });
    expect(state.inspect).not.toHaveBeenCalled();
  });
  it("계획서 없는 재무 연결값·근거를 저장·복원·내보내며 외부 동작은 추가하지 않는다", async () => {
    caseId = state.store!.create({
      ...emptyProfile(),
      companyName: "재무 연결 가상기업",
      businessNumber: "1234567890",
      paidInCapital: "5000000",
      closingMonth: "12",
      financials: "가상 등기 자료 기준. 변경 여부 검토 필요.",
    }).id;
    screen.fields = [
      {
        ...screen.fields[0],
        key: "capital",
        id: "capital",
        name: "capital",
        type: "number",
        labels: ["납입자본금(원)"],
      },
      {
        ...screen.fields[0],
        key: "month",
        id: "month",
        name: "month",
        kind: "select",
        type: "select-one",
        labels: ["결산월"],
        options: [{ value: "12", label: "12월", disabled: false }],
      },
    ];
    expect((await POST(request("POST", inspectBody()), context())).status).toBe(200);
    const mapping = draft();
    mapping.textMappings = [
      {
        fieldKey: "capital",
        source: { kind: "profile", property: "paidInCapital" },
        confirmed: false,
      },
      { fieldKey: "month", source: { kind: "profile", property: "closingMonth" }, confirmed: true },
    ];
    state.inspect.mockClear();
    const saved = await PUT(
      request("PUT", { revision: 1, accountRevision: 1, companyRevision: 0, draft: mapping }),
      context(),
    );
    expect(saved.status).toBe(200);
    state.store!.close();
    state.store = new StudioStore(directory);
    const result = await (
      await GET(request("GET", undefined, {}, "?download=1"), context())
    ).json();
    expect(result.draft).toEqual(mapping);
    expect(result.report.textFields).toEqual([
      expect.objectContaining({
        value: "5000000",
        confirmed: false,
        financialContext: { unit: "원", evidenceNote: "가상 등기 자료 기준. 변경 여부 검토 필요." },
      }),
      expect.objectContaining({
        value: "12",
        confirmed: true,
        financialContext: { unit: "월", evidenceNote: "가상 등기 자료 기준. 변경 여부 검토 필요." },
      }),
    ]);
    expect(result.report.issues.map((issue: { code: string }) => issue.code)).toEqual(
      expect.arrayContaining(["PLAN_MISSING", "MAPPING_UNCONFIRMED"]),
    );
    expect(result.report.readyForLocalReview).toBe(false);
    expect(result.latestExecutionExternalWritesPerformed).toBe(false);
    expect(result.automaticSubmissionAvailable).toBe(false);
    expect(state.inspect).not.toHaveBeenCalled();
    expect(state.preview).not.toHaveBeenCalled();
  });
  it("기업 삭제 시 독립 저장한 신청 연결 기록도 제거한다", async () => {
    await POST(request("POST", inspectBody()), context());
    state.store!.delete(caseId, 0);
    expect((await GET(request("GET"), context())).status).toBe(404);
    const db = new DatabaseSync(join(directory, "studio.sqlite"));
    expect(db.prepare("SELECT COUNT(*) AS total FROM venture_workflows").get()).toMatchObject({
      total: 0,
    });
    db.close();
  });
  it("재시작 후 연결 기록을 복원하며 저장 버전 충돌을 거부한다", async () => {
    await POST(request("POST", inspectBody()), context());
    state.store!.close();
    state.store = new StudioStore(directory);
    expect(await (await GET(request("GET"), context())).json()).toMatchObject({
      revision: 1,
      snapshot: { screen: { id: screen.id } },
    });
    expect(() => state.store!.saveVentureWorkflowEnvelope(caseId, 0, "{}")).toThrow("변경");
    expect(() =>
      state.store!.saveVentureWorkflowEnvelope(caseId, 1, JSON.stringify("x".repeat(530000))),
    ).toThrow("크기");
  });
  it("파일 점검에는 원본 내용 없이 크기와 존재 여부만 반환한다", () => {
    const sourceId = randomUUID();
    state.store!.addUpload(
      caseId,
      0,
      {
        id: sourceId,
        name: "가상 증빙",
        kind: "other",
        text: "가상본문",
        originalName: "evidence.txt",
        mimeType: "text/plain",
        extraction: "local",
        warnings: [],
        createdAt: "2026-09-25T00:00:00.000Z",
        updatedAt: "2026-09-25T00:00:00.000Z",
      },
      new TextEncoder().encode("file-content-marker"),
    );
    expect(state.store!.originalMetadata(caseId, sourceId)).toEqual({
      sourceId,
      originalName: "evidence.txt",
      mimeType: "text/plain",
      sizeBytes: 19,
      exists: true,
    });
    expect(JSON.stringify(state.store!.originalMetadata(caseId, sourceId))).not.toContain(
      "file-content-marker",
    );
    expect(() => state.store!.originalMetadata(caseId, "../outside")).toThrow();
  });
  it("미리보기는 확인된 화면·계정 버전에만 응답하며 이미지를 저장하지 않는다", async () => {
    await POST(request("POST", inspectBody()), context());
    const response = await PREVIEW(
      request("GET", undefined, {}, "?revision=1&accountRevision=1"),
      context(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.text()).toBe("synthetic-image-bytes");
    expect(state.preview).toHaveBeenCalledWith(caseId, "2026-09-25T00:00:00.000Z", screen.url);
    expect(state.store!.getVentureWorkflowEnvelope(caseId).body).not.toContain(
      "synthetic-image-bytes",
    );
  });
  it("기록이 없거나 계정·화면 버전이 다르면 미리보기 실행을 거부한다", async () => {
    expect(
      (await PREVIEW(request("GET", undefined, {}, "?revision=0&accountRevision=1"), context()))
        .status,
    ).toBe(409);
    await POST(request("POST", inspectBody()), context());
    for (const query of ["?revision=0&accountRevision=1", "?revision=1&accountRevision=2"])
      expect((await PREVIEW(request("GET", undefined, {}, query), context())).status).toBe(409);
    expect(state.preview).not.toHaveBeenCalled();
  });
  it("외부 출처·잘못된 버전으로 미리보기를 요청할 수 없다", async () => {
    expect(
      (
        await PREVIEW(
          request(
            "GET",
            undefined,
            { origin: "https://evil.example" },
            "?revision=0&accountRevision=1",
          ),
          context(),
        )
      ).status,
    ).toBe(403);
    expect(
      (await PREVIEW(request("GET", undefined, {}, "?revision=abc&accountRevision=1"), context()))
        .status,
    ).toBe(400);
    expect(state.preview).not.toHaveBeenCalled();
  });
  it("이미지 생성 중 다른 프로세스에서 계정을 바꾸면 이전 화면을 반환하지 않는다", async () => {
    await POST(request("POST", inspectBody()), context());
    state.preview.mockImplementation(async () => {
      state.accountRevision = 2;
      return Buffer.from("previous-account-image");
    });
    const response = await PREVIEW(
      request("GET", undefined, {}, "?revision=1&accountRevision=1"),
      context(),
    );
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("previous-account-image");
  });
  it("혁신성장유형 화면도 고정 명령으로만 읽는다", async () => {
    expect(
      (await POST(request("POST", inspectBody({ destination: "innovation" })), context())).status,
    ).toBe(200);
    expect(state.inspect).toHaveBeenCalledWith(caseId, "innovation");
  });
});
