import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import { emptyProfile, type StudioCase } from "./studio-schema";
import type { VentureScreenSnapshot } from "./venturein-inspection";
import type { VentureSessionStatus } from "./venturein-schema";
import { preparedPackageRecordSchema } from "./studio-prepared-package-types";
import { StudioError } from "./studio-http";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  store: null as StudioStore | null,
  accountRevision: 1,
  session: null as VentureSessionStatus | null,
  fill: vi.fn(),
  compare: vi.fn(),
  inspect: vi.fn(),
}));
vi.mock("@/lib/studio-storage", async (original) => ({
  ...(await original<typeof import("./studio-storage")>()),
  getStudioStore: () => state.store!,
}));
vi.mock("@/lib/venturein-vault", () => ({
  getVentureAccountStatus: () => ({ revision: state.accountRevision }),
}));
vi.mock("@/lib/venturein-runner", () => ({
  getVentureSession: () => state.session!,
  fillVentureApplication: state.fill,
  compareVentureApplication: state.compare,
  inspectVentureApplication: state.inspect,
}));

import { POST } from "@/app/api/studio/cases/[caseId]/venturein/workflow/execution/route";
import {
  GET,
  POST as INSPECT,
  PUT as SAVE,
} from "@/app/api/studio/cases/[caseId]/venturein/workflow/route";
import { getVentureWorkflow } from "./venturein-workflow";

describe("검토한 공식 입력값의 단회 실행 API", () => {
  let directory: string;
  let company: StudioCase;
  let screen: VentureScreenSnapshot;
  const context = () => ({ params: Promise.resolve({ caseId: company.id }) });
  const request = (body: unknown, headers: Record<string, string> = {}) =>
    new Request(
      `http://localhost:3000/api/studio/cases/${company.id}/venturein/workflow/execution`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      },
    );
  const prepareBody = () => ({
    action: "prepare",
    revision: state.store!.getVentureWorkflowEnvelope(company.id).revision,
    accountRevision: state.accountRevision,
    companyRevision: company.revision,
  });
  const prepare = async () => {
    const response = await POST(request(prepareBody()), context());
    expect(response.status).toBe(200);
    return (await response.json()).review;
  };
  const execute = (token: string) =>
    POST(request({ action: "execute", token, approved: true }), context());
  const pinnedPackage = (originals = new Map<string, Buffer>()) => {
    const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
    const buffer = Buffer.from("synthetic pinned archive");
    const plan = company.plans.at(-1)!;
    const input = {
      revision: company.revision,
      planId: plan.id,
      sourceIds: [...originals.keys()],
      clientRequestId: randomUUID(),
    };
    const record = preparedPackageRecordSchema.parse({
      id: randomUUID(),
      version: 1,
      caseId: company.id,
      caseRevision: company.revision,
      clientRequestId: input.clientRequestId,
      input,
      requestDigest: sha(JSON.stringify(input)),
      createdAt: new Date().toISOString(),
      scope: "local-preparation-only",
      company: { profile: company.profile, snapshotSha256: sha(JSON.stringify(company)) },
      plan: { ...plan, contentSha256: sha(JSON.stringify(plan.content)) },
      sourceIds: input.sourceIds,
      sources: input.sourceIds.map((id) => {
        const source = company.sources.find((item) => item.id === id)!;
        const { text, ...metadata } = source;
        return {
          source: metadata,
          sourceSha256: sha(JSON.stringify(source)),
          textSha256: sha(text),
          originalSha256: sha(originals.get(id)!),
          originalSizeBytes: originals.get(id)!.byteLength,
        };
      }),
      review: {
        storedFindings: plan.review,
        currentRuleFindings: [],
        confirmedAt: plan.confirmedAt,
        unconfirmedSectionKeys: [],
        currentEvidence: true,
        latestPlanVersion: true,
        draft: false,
        draftReasons: [],
      },
      zip: {
        fileName: "venturepass-preparation-package.zip",
        sha256: sha(buffer),
        sizeBytes: buffer.byteLength,
      },
    });
    const download = vi
      .spyOn(state.store!, "downloadPreparedPackage")
      .mockImplementation((caseId, id) => {
        if (caseId !== company.id || id !== record.id)
          throw new StudioError("합성 준비본 없음", 404, "PREPARED_PACKAGE_NOT_FOUND");
        return { record: structuredClone(record), buffer: Buffer.from(buffer) };
      });
    return { record, buffer, download };
  };
  const preparePinned = async (preparedPackageId: string) => {
    const response = await POST(request({ ...prepareBody(), preparedPackageId }), context());
    expect(response.status).toBe(200);
    return (await response.json()).review;
  };
  const alter = (change: (data: ReturnType<typeof JSON.parse>) => void) => {
    const envelope = state.store!.getVentureWorkflowEnvelope(company.id);
    const data = JSON.parse(envelope.body!);
    change(data);
    state.store!.saveVentureWorkflowEnvelope(company.id, envelope.revision, JSON.stringify(data));
  };
  const useCompanyWithoutPlan = () => {
    const envelope = state.store!.getVentureWorkflowEnvelope(company.id);
    const data = JSON.parse(envelope.body!);
    company = state.store!.create({ ...company.profile });
    data.snapshot.caseId = company.id;
    Object.assign(data.draft, {
      caseId: company.id,
      companyRevision: company.revision,
      planId: null,
      planVersion: null,
    });
    state.store!.saveVentureWorkflowEnvelope(company.id, 0, JSON.stringify(data));
  };
  const addOriginal = (
    content = Buffer.from("synthetic original"),
    mimeType: string | null = "application/pdf",
  ) => {
    const analysis = company.analysis!;
    const plan = company.plans.at(-1)!;
    const now = new Date().toISOString();
    const source = {
      id: randomUUID(),
      name: "가상 첨부",
      kind: "finance" as const,
      text: "실제 고객 자료가 아닙니다",
      originalName: "synthetic.pdf",
      mimeType,
      extraction: "local" as const,
      warnings: [],
      createdAt: now,
      updatedAt: now,
    };
    company = state.store!.addUpload(company.id, company.revision, source, content);
    company = state.store!.saveAnalysis(company.id, company.revision, analysis, "assisted");
    company = state.store!.mutate(
      company.id,
      {
        action: "select-candidate",
        revision: company.revision,
        clientRequestId: randomUUID(),
        candidateId: "sample",
        analysisGeneratedAt: company.analysis!.generatedAt,
        analysisSourceRevision: company.analysis!.sourceRevision,
        expectedSelectedCandidateId: company.selectedCandidateId,
        reason: "합성 후보 선택 근거",
      },
      () => [],
    );
    company = state.store!.saveGeneratedPlan(
      company.id,
      company.revision,
      "sample",
      plan.content,
      [],
      "assisted",
    );
    const latest = company.plans.at(-1)!;
    company = state.store!.mutate(
      company.id,
      { action: "confirm-plan", revision: company.revision, planId: latest.id },
      () => [],
    );
    const fileField = {
      key: "document",
      id: "document",
      name: "document",
      kind: "file" as const,
      type: "file",
      labels: ["가상 증빙"],
      required: true,
      maxLength: null,
      accept: ".pdf",
      multiple: false,
      disabled: false,
      readOnly: false,
      options: [],
    };
    alter((data) => {
      data.snapshot.screen.fields.push(fileField);
      data.draft.companyRevision = company.revision;
      data.draft.planId = latest.id;
      data.draft.planVersion = latest.version;
      data.draft.attachmentMappings = [
        {
          fieldKey: "document",
          sourceId: source.id,
          sourceUpdatedAt: source.updatedAt,
          confirmed: true,
        },
      ];
    });
    return {
      source,
      content,
      fileField,
      path: join(directory, "originals", company.id, `${source.id}.bin`),
    };
  };
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "venture-execution-test-"));
    state.store = new StudioStore(directory);
    company = state.store.create({
      ...emptyProfile(),
      companyName: "입력 검증 가상기업",
      businessNumber: "1234567890",
      technologySummary: "가상 기술 설명",
    });
    company = state.store.saveAnalysis(
      company.id,
      company.revision,
      {
        summary: "시험",
        facts: [],
        questions: [],
        warnings: [],
        candidates: [
          {
            id: "sample",
            title: "시제품",
            problem: "문제",
            solution: "해결",
            targetCustomer: "시험",
            differentiation: "검증",
            stage: "개발",
            businessModel: "판매",
            recommendation: "근거",
            evidence: [],
            gaps: [],
          },
        ],
      },
      "assisted",
    );
    company = state.store.mutate(
      company.id,
      {
        action: "select-candidate",
        revision: company.revision,
        clientRequestId: randomUUID(),
        candidateId: "sample",
        analysisGeneratedAt: company.analysis!.generatedAt,
        analysisSourceRevision: company.analysis!.sourceRevision,
        expectedSelectedCandidateId: company.selectedCandidateId,
        reason: "합성 후보 선택 근거",
      },
      () => [],
    );
    company = state.store.saveGeneratedPlan(
      company.id,
      company.revision,
      "sample",
      {
        title: "가상 작성본",
        summary: "시험",
        sections: [
          {
            key: "solution",
            title: "해결",
            content: "가상 내용",
            needsConfirmation: false,
            evidence: [],
          },
        ],
        actionItems: [],
        interviewQuestions: [],
      },
      [],
      "assisted",
    );
    company = state.store.mutate(
      company.id,
      { action: "confirm-plan", revision: company.revision, planId: company.plans[0].id },
      () => [],
    );
    state.accountRevision = 1;
    const now = new Date().toISOString();
    state.session = {
      state: "connected_unmapped",
      message: "가상 로그인",
      startedAt: now,
      updatedAt: now,
    };
    screen = {
      id: randomUUID(),
      observedAt: now,
      url: "https://www.smes.go.kr/venturein/aply/v2",
      title: "가상 신청서",
      truncated: false,
      warnings: [],
      companyEvidence: [
        { kind: "businessNumber", label: "사업자등록번호", value: "1234567890", source: "table" },
      ],
      fields: ["company", "technology"].map((key) => ({
        key,
        id: key,
        name: key,
        kind: "input",
        type: "text",
        labels: [key],
        required: true,
        maxLength: 200,
        accept: null,
        multiple: false,
        disabled: false,
        readOnly: false,
        options: [],
      })),
    };
    state.store.saveVentureWorkflowEnvelope(
      company.id,
      0,
      JSON.stringify({
        snapshot: { screen, caseId: company.id, sessionStartedAt: now, accountRevision: 1 },
        draft: {
          caseId: company.id,
          snapshotId: screen.id,
          sessionStartedAt: now,
          accountRevision: 1,
          companyRevision: company.revision,
          planId: company.plans[0].id,
          planVersion: 1,
          textMappings: [
            {
              fieldKey: "company",
              source: { kind: "profile", property: "companyName" },
              confirmed: true,
            },
            {
              fieldKey: "technology",
              source: { kind: "profile", property: "technologySummary" },
              confirmed: true,
            },
          ],
          attachmentMappings: [],
        },
      }),
    );
    state.inspect.mockReset();
    state.compare.mockReset();
    state.compare.mockImplementation(async (_caseId, input, assertCurrent, finalizeCurrent) => {
      assertCurrent();
      finalizeCurrent();
      return {
        status: "completed",
        code: null,
        observedAt: new Date().toISOString(),
        fields: [
          ...input.fields.map((field: { fieldKey: string }) => ({
            fieldKey: field.fieldKey,
            kind: "text",
            state: "matched",
            code: null,
          })),
          ...input.attachments.map((field: { fieldKey: string }) => ({
            fieldKey: field.fieldKey,
            kind: "file",
            state: "empty",
            code: null,
          })),
        ],
      };
    });
    state.fill.mockReset();
    state.fill.mockImplementation(async (_caseId, input, assertCurrent) => {
      assertCurrent();
      const written = [
        ...input.fields.map((field: { fieldKey: string }) => field.fieldKey),
        ...(input.attachments ?? []).map((field: { fieldKey: string }) => field.fieldKey),
      ].filter((key: string) => !(input.preserveFieldKeys ?? []).includes(key));
      return {
        status: "completed",
        completedFieldKeys: written,
        touchedFieldKeys: written,
        attemptedFieldKey: null,
        code: null,
      };
    });
  });
  afterEach(() => {
    state.store!.close();
    const boundary = relative(resolve(tmpdir()), resolve(directory));
    if (!boundary.startsWith("venture-execution-test-") || boundary.includes(".."))
      throw new Error("Unsafe cleanup");
    rmSync(directory, { recursive: true, force: true });
  });

  const compare = () => POST(request({ ...prepareBody(), action: "compare" }), context());
  it("현재 연결안 대조는 관측 상태만 반환하고 token·receipt·현재 연결안을 변경하지 않는다", async () => {
    const before = state.store!.getVentureWorkflowEnvelope(company.id);
    const response = await compare();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.comparison).toMatchObject({
      scope: "current-mapping",
      workflowRevision: before.revision,
      companyRevision: company.revision,
      accountRevision: 1,
      snapshotId: screen.id,
      sessionStartedAt: state.session!.startedAt,
      fields: [
        { fieldKey: "company", kind: "text", state: "matched", code: null },
        { fieldKey: "technology", kind: "text", state: "matched", code: null },
      ],
    });
    expect(Number.isFinite(Date.parse(body.comparison.observedAt))).toBe(true);
    expect(JSON.stringify(body)).not.toContain(company.profile.technologySummary);
    expect(body).not.toHaveProperty("review");
    expect(state.store!.getVentureWorkflowEnvelope(company.id)).toEqual(before);
    expect(state.fill).not.toHaveBeenCalled();
    expect(state.inspect).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("대조는 기존 미사용 승인 token을 소비하지 않는다", async () => {
    const review = await prepare();
    expect((await compare()).status).toBe(200);
    expect((await execute(review.token)).status).toBe(200);
  });

  it.each(["running", "completed", "stopped"])(
    "%s receipt가 있어도 읽기 대조만 허용하고 동일 화면 재실행 금지는 유지한다",
    async (status) => {
      alter((data) => {
        data.execution = {
          id: randomUUID(),
          snapshotId: screen.id,
          status,
          startedAt: new Date().toISOString(),
          finishedAt: status === "running" ? null : new Date().toISOString(),
          completedFieldKeys: status === "completed" ? ["company", "technology"] : [],
          attemptedFieldKey: status === "stopped" ? "company" : null,
          code: status === "stopped" ? "INPUT_RESULT_UNKNOWN" : null,
        };
      });
      const before = state.store!.getVentureWorkflowEnvelope(company.id);
      expect((await compare()).status).toBe(200);
      expect(state.store!.getVentureWorkflowEnvelope(company.id)).toEqual(before);
      expect((await POST(request(prepareBody()), context())).status).toBe(409);
      expect(state.fill).not.toHaveBeenCalled();
    },
  );

  it("대조도 선택 범위 준비도만 사용하며 전체제출 미완료를 완료로 바꾸지 않는다", async () => {
    useCompanyWithoutPlan();
    alter((data) => {
      data.draft.textMappings = [data.draft.textMappings[0]];
    });
    expect((await compare()).status).toBe(200);
    expect(getVentureWorkflow(company.id).report.readyForLocalReview).toBe(false);
    expect(getVentureWorkflow(company.id).execution).toBeNull();
  });

  it("파일 대조에는 서버의 이름·MIME·크기·SHA만 전달하고 원본 bytes와 경로는 전달하지 않는다", async () => {
    const original = addOriginal();
    const response = await compare();
    expect(response.status).toBe(200);
    const forwarded = state.compare.mock.calls[0][1];
    expect(forwarded.attachments).toEqual([
      {
        fieldKey: "document",
        files: [
          {
            name: "synthetic.pdf",
            mimeType: "application/pdf",
            size: original.content.length,
            sha256: createHash("sha256").update(original.content).digest("hex"),
          },
        ],
      },
    ]);
    expect(JSON.stringify(forwarded)).not.toContain("buffer");
    expect(JSON.stringify(forwarded)).not.toContain(original.path);
    const body = await response.json();
    expect(body.comparison.fields).toHaveLength(3);
    expect(JSON.stringify(body)).not.toContain("sha256");
    expect(JSON.stringify(body)).not.toContain("synthetic.pdf");
  });

  it("파일 읽기 중 같은 크기로 원본이 바뀌면 마지막 SHA 재검사에서 전체 결과를 버린다", async () => {
    const original = addOriginal();
    state.compare.mockImplementationOnce(
      async (_caseId, input, _assertCurrent, finalizeCurrent) => {
        writeFileSync(original.path, Buffer.alloc(original.content.length, 65));
        finalizeCurrent();
        return {
          status: "completed",
          code: null,
          fields: [
            ...input.fields.map((item: { fieldKey: string }) => ({
              fieldKey: item.fieldKey,
              kind: "text",
              state: "matched",
              code: null,
            })),
            { fieldKey: "document", kind: "file", state: "matched", code: null },
          ],
        };
      },
    );
    const response = await compare();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "COMPARE_ORIGINAL_CHANGED" });
    expect(getVentureWorkflow(company.id).execution).toBeNull();
  });

  it.each(["account", "workflow", "session"])(
    "대조 중 %s 변경이면 전체 결과 폐기",
    async (kind) => {
      state.compare.mockImplementationOnce(async () => {
        if (kind === "account") state.accountRevision++;
        if (kind === "workflow")
          alter((data) => {
            data.draft.textMappings[0].confirmed = false;
          });
        if (kind === "session")
          state.session = {
            ...state.session!,
            startedAt: new Date(Date.now() + 1_000).toISOString(),
          };
        return { status: "completed", code: null, fields: [] };
      });
      const response = await compare();
      expect(response.status).toBe(409);
      expect(await response.json()).not.toHaveProperty("comparison");
    },
  );

  it.each(["extra", "duplicate", "kind", "missing", "stopped"])(
    "신뢰할 수 없는 대조 결과 %s는 반환하지 않는다",
    async (kind) => {
      const fields = [
        { fieldKey: "company", kind: "text", state: "matched", code: null },
        { fieldKey: "technology", kind: "text", state: "empty", code: null },
      ];
      if (kind === "extra") fields.push({ ...fields[0], fieldKey: "not-selected" });
      if (kind === "duplicate") fields[1] = { ...fields[0] };
      if (kind === "kind") fields[0].kind = "file";
      if (kind === "missing") fields.pop();
      state.compare.mockResolvedValueOnce({
        status: kind === "stopped" ? "stopped" : "completed",
        fields,
        code: null,
      });
      const response = await compare();
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "COMPARE_UNVERIFIED" });
      expect(getVentureWorkflow(company.id).execution).toBeNull();
    },
  );

  it("대조 중 중복 요청·기업 수정은 차단하고 종료 후 lock을 해제한다", async () => {
    let release: (value: unknown) => void = () => {};
    state.compare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = compare();
    await vi.waitFor(() => expect(state.compare).toHaveBeenCalledOnce());
    expect((await compare()).status).toBe(409);
    expect(() =>
      state.store!.mutate(
        company.id,
        { action: "profile", revision: company.revision, profile: company.profile },
        () => [],
      ),
    ).toThrow("입력이 진행 중");
    release({ status: "stopped", fields: [], code: "COMPARE_FAILED" });
    expect((await pending).status).toBe(409);
    expect((await compare()).status).toBe(200);
  });

  it.each(["revision", "companyRevision", "accountRevision"])(
    "오래된 %s는 브라우저 조회 전에 차단한다",
    async (version) => {
      const response = await POST(
        request({ ...prepareBody(), action: "compare", [version]: 999 }),
        context(),
      );
      expect(response.status).toBe(409);
      expect(state.compare).not.toHaveBeenCalled();
    },
  );

  it("compare에 값·승인·파일경로 등 추가 실행 인자를 허용하지 않는다", async () => {
    const response = await POST(
      request({
        ...prepareBody(),
        action: "compare",
        approved: true,
        fields: [{ fieldKey: "company", value: "injected" }],
      }),
      context(),
    );
    expect(response.status).toBe(400);
    expect(state.compare).not.toHaveBeenCalled();
  });

  it("계획서 없는 기업도 확인한 profile만 실행하며 미선택 필수·동의는 남은 제출 과제로 보존한다", async () => {
    useCompanyWithoutPlan();
    alter((data) => {
      data.draft.textMappings = [data.draft.textMappings[0]];
      data.snapshot.screen.fields.push({
        ...screen.fields[0],
        key: "agreement",
        id: "agreement",
        name: "agreement",
        labels: ["개인정보 동의"],
        type: "checkbox",
      });
    });
    const workflow = getVentureWorkflow(company.id);
    expect(workflow.report.readyForLocalReview).toBe(false);
    expect(workflow.report.inputReadiness.ready).toBe(true);
    const review = await prepare();
    expect(review).toMatchObject({
      scope: "selected-fields",
      submissionReady: false,
      fieldCount: 1,
    });
    expect(review.remainingIssues.map((issue: { code: string }) => issue.code)).toEqual(
      expect.arrayContaining([
        "PLAN_MISSING",
        "AGREEMENT_REQUIRES_USER",
        "REQUIRED_FIELD_UNMAPPED",
      ]),
    );
    expect((await execute(review.token)).status).toBe(200);
    expect(state.fill.mock.calls[0][1].fields).toEqual([
      { fieldKey: "company", value: company.profile.companyName },
    ]);
    const after = getVentureWorkflow(company.id);
    expect(after.report.readyForLocalReview).toBe(false);
    expect(after.report.issues.some((issue) => issue.code === "AGREEMENT_REQUIRES_USER")).toBe(
      true,
    );
  });

  it.each(["company", "confirmation", "plan-section"] as const)(
    "일부 항목 실행도 기업 일치·선택값 확인·선택 원고의 계획서 검증은 유지한다: %s",
    async (missing) => {
      useCompanyWithoutPlan();
      alter((data) => {
        if (missing === "company") data.snapshot.screen.companyEvidence = [];
        if (missing === "confirmation") data.draft.textMappings[0].confirmed = false;
        if (missing === "plan-section")
          data.draft.textMappings[0].source = { kind: "plan-section", sectionKey: "solution" };
      });
      expect((await POST(request(prepareBody()), context())).status).toBe(409);
      expect(state.fill).not.toHaveBeenCalled();
      expect(getVentureWorkflow(company.id).execution).toBeNull();
    },
  );

  it("준비는 서버의 정확한 값·목적지만 반환하고 브라우저·저장소를 변경하지 않는다", async () => {
    const review = await prepare();
    expect(review).toMatchObject({
      destination: screen.url,
      fieldCount: 2,
      workflowRevision: 1,
      companyRevision: company.revision,
    });
    expect(review.fields.map((field: { value: string }) => field.value)).toEqual([
      company.profile.companyName,
      company.profile.technologySummary,
    ]);
    expect(state.store!.getVentureWorkflowEnvelope(company.id).revision).toBe(1);
    expect(state.fill).not.toHaveBeenCalled();
    expect(state.inspect).not.toHaveBeenCalled();
  });
  it("첨부 검토안은 이름·크기·해시만 반환하고 원본 버퍼·경로를 노출하지 않는다", async () => {
    const file = addOriginal();
    const review = await prepare();
    expect(review).toMatchObject({
      attachmentCount: 1,
      totalAttachmentBytes: file.content.length,
      attachments: [
        {
          originalName: "synthetic.pdf",
          sha256: createHash("sha256").update(file.content).digest("hex"),
        },
      ],
    });
    expect(JSON.stringify(review)).not.toContain(directory);
    expect(JSON.stringify(review)).not.toContain("synthetic original");
    expect(review.attachments[0]).not.toHaveProperty("buffer");
    expect(state.fill).not.toHaveBeenCalled();
    const result = await (await execute(review.token)).json();
    expect(result.execution).toMatchObject({
      status: "completed",
      attachmentFieldKeys: ["document"],
      completedFieldKeys: ["company", "technology", "document"],
    });
    expect(state.fill.mock.calls[0][1].attachments[0].files[0].buffer).toEqual(file.content);
    expect(state.fill.mock.calls[0][1].attachments[0].files[0]).not.toHaveProperty("path");
  });
  it("첨부만 있는 단계와 MIME 미지정 원본을 지원한다", async () => {
    addOriginal(undefined, null);
    alter((data) => {
      data.snapshot.screen.fields = data.snapshot.screen.fields.filter(
        (field: { kind: string }) => field.kind === "file",
      );
      data.draft.textMappings = [];
    });
    const review = await prepare();
    expect(review).toMatchObject({ fieldCount: 0, attachmentCount: 1 });
    expect((await execute(review.token)).status).toBe(200);
    expect(state.fill.mock.calls[0][1].attachments[0].files[0].mimeType).toBe(
      "application/octet-stream",
    );
  });
  it("검토 후 같은 크기의 원본 내용이 변하면 승인과 브라우저 실행을 거부한다", async () => {
    const file = addOriginal(Buffer.from("original A"));
    const review = await prepare();
    writeFileSync(file.path, Buffer.from("original B"));
    expect((await execute(review.token)).status).toBe(409);
    expect(state.fill).not.toHaveBeenCalled();
    expect((await execute(review.token)).status).toBe(410);
  });
  it("앱 첨부 처리 한도를 초과하면 원본 전송을 준비하지 않는다", async () => {
    addOriginal(Buffer.alloc(12 * 1024 * 1024 + 1));
    const response = await POST(request(prepareBody()), context());
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("INPUT_FILE_LIMIT");
    expect(state.fill).not.toHaveBeenCalled();
  });
  it("여러 신청 화면을 읽기→연결→승인→입력·첨부까지 이어가며 이력을 보존한다", async () => {
    const { fileField, source } = addOriginal();
    // First screen requests text only; the approved original remains safely in the local library.
    alter((data) => {
      data.snapshot.screen.fields = data.snapshot.screen.fields.filter(
        (field: { kind: string }) => field.kind !== "file",
      );
      data.draft.attachmentMappings = [];
    });
    expect(getVentureWorkflow(company.id).journey.phase).toBe("execute");
    expect((await execute((await prepare()).token)).status).toBe(200);
    const firstSnapshotId = getVentureWorkflow(company.id).snapshot!.screen.id;
    expect(getVentureWorkflow(company.id).journey.phase).toBe("handoff");
    const nextScreen = {
      ...screen,
      id: randomUUID(),
      title: "가상 첨부 단계",
      url: "https://www.smes.go.kr/venturein/aply/attachment",
      fields: [fileField],
    };
    state.inspect.mockResolvedValue({
      screen: nextScreen,
      sessionStartedAt: state.session!.startedAt,
    });
    const inspected = await INSPECT(
      request({ ...prepareBody(), action: "inspect", destination: "current" }),
      context(),
    );
    expect(inspected.status).toBe(200);
    const observed = await inspected.json();
    expect(observed.journey.phase).toBe("map");
    expect(observed.draft).toBeNull();
    expect(
      observed.journey.entries.find(
        (entry: { snapshotId: string }) => entry.snapshotId === firstSnapshotId,
      ).execution.status,
    ).toBe("completed");
    const latest = company.plans.at(-1)!;
    const versions = {
      revision: prepareBody().revision,
      accountRevision: state.accountRevision,
      companyRevision: company.revision,
    };
    const draft = {
      caseId: company.id,
      snapshotId: nextScreen.id,
      sessionStartedAt: state.session!.startedAt,
      accountRevision: 1,
      companyRevision: company.revision,
      planId: latest.id,
      planVersion: latest.version,
      textMappings: [],
      attachmentMappings: [
        {
          fieldKey: "document",
          sourceId: source.id,
          sourceUpdatedAt: source.updatedAt,
          confirmed: true,
        },
      ],
    };
    const saveResult = await SAVE(
      new Request(request({ ...versions, draft }), { method: "PUT" }),
      context(),
    );
    expect(saveResult.status).toBe(200);
    const executed = await (await execute((await prepare()).token)).json();
    expect(executed.execution.status).toBe("completed");
    expect(executed.workflow.journey).toMatchObject({
      phase: "handoff",
      entries: [
        { snapshotId: firstSnapshotId, execution: { status: "completed" } },
        {
          snapshotId: nextScreen.id,
          execution: { status: "completed", attachmentFieldKeys: ["document"] },
        },
      ],
    });
    state.store!.close();
    state.store = new StudioStore(directory);
    expect(getVentureWorkflow(company.id).journey.entries).toHaveLength(2);
    const json = JSON.stringify(getVentureWorkflow(company.id).journey);
    expect(json).not.toContain("synthetic.pdf");
    expect(json).not.toContain(company.profile.companyName);
    expect(state.inspect).toHaveBeenCalledTimes(1);
    expect(state.fill).toHaveBeenCalledTimes(2);
  });
  it("모든 입력 전에 running을 영속 저장하고 완료 기록을 재시작 후 복원한다", async () => {
    state.fill.mockImplementation(async (_caseId, _input, assertCurrent) => {
      expect(getVentureWorkflow(company.id).execution?.status).toBe("running");
      expect(state.store!.getVentureWorkflowEnvelope(company.id).revision).toBe(2);
      assertCurrent();
      return {
        status: "completed",
        completedFieldKeys: ["company", "technology"],
        touchedFieldKeys: ["company", "technology"],
        attemptedFieldKey: null,
        code: null,
      };
    });
    const review = await prepare();
    const response = await execute(review.token);
    expect(response.status).toBe(200);
    expect((await response.json()).execution).toMatchObject({
      status: "completed",
      completedFieldKeys: ["company", "technology"],
    });
    state.store!.close();
    state.store = new StudioStore(directory);
    expect(getVentureWorkflow(company.id).execution?.status).toBe("completed");
    expect(getVentureWorkflow(company.id).revision).toBe(3);
  });
  it("같은 승인과 같은 화면의 재준비를 거부한다", async () => {
    const review = await prepare();
    await execute(review.token);
    expect((await execute(review.token)).status).toBe(410);
    expect((await POST(request(prepareBody()), context())).status).toBe(409);
    expect(state.fill).toHaveBeenCalledTimes(1);
  });
  it("새 검토안은 이전 토큰을 폐기한다", async () => {
    const first = await prepare();
    const second = await prepare();
    expect((await execute(first.token)).status).toBe(410);
    expect((await execute(second.token)).status).toBe(200);
    expect(state.fill).toHaveBeenCalledTimes(1);
  });
  it("2분이 지난 검토안은 입력하지 않는다", async () => {
    const review = await prepare();
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(review.expiresAt));
    expect((await execute(review.token)).status).toBe(410);
    expect(state.fill).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { approved: false },
    { approved: true, fields: [{ value: "조작" }] },
    { approved: true, destination: "https://evil.example" },
  ])("명시승인 누락과 값 주입을 거부한다: %j", async (extra) => {
    const review = await prepare();
    expect(
      (await POST(request({ action: "execute", token: review.token, ...extra }), context())).status,
    ).toBe(400);
    expect(state.fill).not.toHaveBeenCalled();
  });
  it("외부 origin과 초과 body를 실행 전에 거부한다", async () => {
    expect(
      (await POST(request(prepareBody(), { origin: "https://evil.example" }), context())).status,
    ).toBe(403);
    expect(
      (await POST(request({ ...prepareBody(), body: "x".repeat(5000) }), context())).status,
    ).toBe(413);
    expect(state.fill).not.toHaveBeenCalled();
  });
  it("다른 기업 토큰은 사용할 수 없으며 원래 기업의 토큰은 유지한다", async () => {
    const review = await prepare();
    expect(
      (
        await POST(request({ action: "execute", token: review.token, approved: true }), {
          params: Promise.resolve({ caseId: randomUUID() }),
        })
      ).status,
    ).toBe(410);
    expect((await execute(review.token)).status).toBe(200);
  });
  it.each(["company", "account", "session", "workflow"])(
    "검토 후 %s 변경을 입력 전에 차단한다",
    async (change) => {
      const review = await prepare();
      if (change === "company")
        company = state.store!.mutate(
          company.id,
          { action: "stage", revision: company.revision, stage: "preparing" },
          () => [],
        );
      if (change === "account") state.accountRevision += 1;
      if (change === "session")
        state.session = { ...state.session!, startedAt: new Date(Date.now() + 1000).toISOString() };
      if (change === "workflow") alter(() => undefined);
      expect((await execute(review.token)).status).toBe(409);
      expect(state.fill).not.toHaveBeenCalled();
    },
  );
  it.each(["mapping", "company", "plan"])(
    "기존 %s 미확인 차단조건을 완화하지 않는다",
    async (change) => {
      if (change === "mapping")
        alter((data) => {
          data.draft.textMappings[0].confirmed = false;
        });
      if (change === "company")
        alter((data) => {
          data.snapshot.screen.companyEvidence = [];
        });
      if (change === "plan") {
        company = state.store!.mutate(
          company.id,
          { action: "profile", revision: company.revision, profile: company.profile },
          () => [],
        );
        alter((data) => {
          data.draft.companyRevision = company.revision;
          data.draft.textMappings[1].source = { kind: "plan-section", sectionKey: "solution" };
        });
      }
      expect((await POST(request(prepareBody()), context())).status).toBe(409);
      expect(state.fill).not.toHaveBeenCalled();
    },
  );
  it("동시 실행은 1회만 실행하고 GET은 running을 읽을 뿐이다", async () => {
    let release!: (value: unknown) => void;
    state.fill.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const review = await prepare();
    const first = execute(review.token);
    await vi.waitFor(() => expect(state.fill).toHaveBeenCalledTimes(1));
    expect((await execute(review.token)).status).toBe(409);
    const running = await GET(new Request(`http://localhost:3000/api?download=1`), context());
    expect(await running.json()).toMatchObject({
      latestExecutionExternalWritesPerformed: null,
      execution: { status: "running" },
    });
    expect(state.inspect).not.toHaveBeenCalled();
    release({
      status: "completed",
      completedFieldKeys: ["company", "technology"],
      touchedFieldKeys: ["company", "technology"],
      attemptedFieldKey: null,
      code: null,
    });
    expect((await first).status).toBe(200);
  });
  it("부분 성공·불확실한 항목을 구별하며 실패 항목을 자동 재실행하지 않는다", async () => {
    state.fill.mockResolvedValue({
      status: "stopped",
      completedFieldKeys: ["company"],
      touchedFieldKeys: ["company", "technology"],
      attemptedFieldKey: "technology",
      code: "INPUT_CHANGED",
    });
    const review = await prepare();
    const result = await (await execute(review.token)).json();
    expect(result.execution).toMatchObject({
      status: "stopped",
      completedFieldKeys: ["company"],
      attemptedFieldKey: "technology",
    });
    expect(JSON.stringify(result.execution)).not.toContain(company.profile.companyName);
    const exported = await GET(new Request("http://localhost:3000/api?download=1"), context());
    expect((await exported.json()).latestExecutionExternalWritesPerformed).toBe(true);
    expect(state.fill).toHaveBeenCalledTimes(1);
  });
  it("입력 대기 중 기업·계정·삭제 변경을 잠그고 완료 후 해제한다", async () => {
    let release!: (value: unknown) => void;
    state.fill.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const review = await prepare();
    const executing = execute(review.token);
    await vi.waitFor(() => expect(state.fill).toHaveBeenCalledTimes(1));
    const secondStore = new StudioStore(directory);
    try {
      expect(() =>
        secondStore.mutate(
          company.id,
          { action: "profile", revision: company.revision, profile: company.profile },
          () => [],
        ),
      ).toThrow("입력이 진행 중");
      expect(() => secondStore.delete(company.id, company.revision)).toThrow("입력이 진행 중");
      expect(() =>
        secondStore.saveVentureAccountEnvelope(company.id, 0, new Uint8Array([1]), "t***t"),
      ).toThrow("입력이 진행 중");
      expect(secondStore.get(company.id).revision).toBe(company.revision);
      release({
        status: "completed",
        completedFieldKeys: ["company", "technology"],
        touchedFieldKeys: ["company", "technology"],
        attemptedFieldKey: null,
        code: null,
      });
      expect((await executing).status).toBe(200);
      expect(() =>
        secondStore.mutate(
          company.id,
          { action: "stage", revision: company.revision, stage: "preparing" },
          () => [],
        ),
      ).not.toThrow();
    } finally {
      secondStore.close();
    }
  });
  it("내보내기는 최근 실행 범위를 명시해 이전 입력 이력을 부정하지 않는다", async () => {
    await execute((await prepare()).token);
    alter((data) => {
      data.snapshot.screen.id = randomUUID();
      data.draft.snapshotId = data.snapshot.screen.id;
    });
    state.fill.mockResolvedValue({
      status: "stopped",
      completedFieldKeys: [],
      touchedFieldKeys: [],
      attemptedFieldKey: null,
      code: "TARGET_NOT_EMPTY",
    });
    await execute((await prepare()).token);
    const exported = await (
      await GET(new Request("http://localhost:3000/api?download=1"), context())
    ).json();
    expect(exported).toMatchObject({
      format: "venturepass-local-review-v2",
      latestExecutionExternalWritesPerformed: false,
    });
    expect(exported).not.toHaveProperty("externalWritesPerformed");
  });
  it("예상 밖 오류를 값·로그 노출 없이 결과 미확인으로 기록한다", async () => {
    state.fill.mockRejectedValue(new Error("secret raw value and URL must not escape"));
    const review = await prepare();
    const result = await (await execute(review.token)).json();
    expect(result.execution).toMatchObject({ status: "stopped", code: "INPUT_RESULT_UNKNOWN" });
    expect(JSON.stringify(result)).not.toContain("secret raw");
    expect((await POST(request(prepareBody()), context())).status).toBe(409);
  });
  it("실행 시작 기록 저장이 실패하면 브라우저를 건드리지 않는다", async () => {
    const review = await prepare();
    vi.spyOn(state.store!, "saveVentureWorkflowEnvelope").mockImplementationOnce(() => {
      throw new Error("disk");
    });
    expect((await execute(review.token)).status).toBe(500);
    expect(state.fill).not.toHaveBeenCalled();
    expect((await execute(review.token)).status).toBe(410);
  });
  it("결과 저장 실패 시 running을 남겨 성공으로 오인하지 않는다", async () => {
    const review = await prepare();
    const original = state.store!.saveVentureWorkflowEnvelope.bind(state.store!);
    vi.spyOn(state.store!, "saveVentureWorkflowEnvelope").mockImplementation(
      (id, revision, body) => {
        if (revision === 2) throw new Error("disk");
        return original(id, revision, body);
      },
    );
    expect((await execute(review.token)).status).toBe(500);
    expect(getVentureWorkflow(company.id).execution?.status).toBe("running");
    expect((await POST(request(prepareBody()), context())).status).toBe(409);
    expect(state.fill).toHaveBeenCalledTimes(1);
  });

  const recoveryPrepare = () =>
    POST(request({ ...prepareBody(), action: "prepare-recovery" }), context());
  const recoveryExecute = (token: string) =>
    POST(request({ action: "execute-recovery", token, approved: true }), context());
  const comparisonStates = (states: string[]) => {
    state.compare.mockImplementation(async (_caseId, input, assertCurrent, finalizeCurrent) => {
      assertCurrent();
      finalizeCurrent();
      return {
        status: "completed",
        code: null,
        observedAt: new Date().toISOString(),
        fields: input.fields.map((field: { fieldKey: string }, index: number) => ({
          fieldKey: field.fieldKey,
          kind: "text",
          state: states[index],
          code: null,
        })),
      };
    });
  };
  const partial = async (touched = ["company"], completed = ["company"]) => {
    state.fill.mockResolvedValueOnce({
      status: "stopped",
      completedFieldKeys: completed,
      touchedFieldKeys: touched,
      attemptedFieldKey: touched.at(-1) ?? null,
      code: "TARGET_CHANGED",
    });
    const response = await execute((await prepare()).token);
    expect(response.status).toBe(200);
    const execution = (await response.json()).execution;
    expect(execution.code).toBe("TARGET_CHANGED");
    comparisonStates(["matched", "empty"]);
    return execution;
  };
  // Corrupt only receipt evidence without making the separate revision guard mask these cases.
  const changeReceipt = (change: (receipt: ReturnType<typeof JSON.parse>) => void) =>
    alter((data) => {
      if (data.execution.manifest) data.execution.manifest.workflowRevision += 1;
      change(data.execution);
    });

  it("새 running에 값 없는 원본 manifest와 ordered targets를 영속 보관한다", async () => {
    const original = state.fill.getMockImplementation()!;
    state.fill.mockImplementationOnce(async (...args) => {
      const record = getVentureWorkflow(company.id).execution!;
      expect(record).toMatchObject({
        status: "running",
        requestedFieldKeys: ["company", "technology"],
        touchedFieldKeys: [],
        preservedFieldKeys: [],
        priorExecutionId: null,
        previousAttempts: [],
        manifest: {
          version: 1,
          caseId: company.id,
          workflowRevision: 1,
          snapshotId: screen.id,
          companyRevision: company.revision,
          accountRevision: 1,
          sessionStartedAt: state.session!.startedAt,
          targets: [
            { fieldKey: "company", kind: "text" },
            { fieldKey: "technology", kind: "text" },
          ],
        },
      });
      expect(record.manifest!.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(record)).not.toContain(company.profile.companyName);
      expect(JSON.stringify(record)).not.toContain(company.profile.technologySummary);
      return original(...args);
    });
    expect((await execute((await prepare()).token)).status).toBe(200);
  });
  it("텍스트 부분실행 복구는 일치 항목을 보호하고 남은 빈칸만 새 단회 승인으로 쓴다", async () => {
    const first = await partial();
    state.store!.close();
    state.store = new StudioStore(directory);
    const before = state.store!.getVentureWorkflowEnvelope(company.id);
    const prepared = await recoveryPrepare();
    expect(prepared.status).toBe(200);
    const { review } = await prepared.json();
    expect(review).toMatchObject({
      scope: "text-recovery",
      priorExecutionId: first.id,
      fieldCount: 1,
      fields: [{ fieldKey: "technology", value: company.profile.technologySummary }],
      protectedFields: [{ fieldKey: "company", label: "company" }],
    });
    expect(review).not.toHaveProperty("attachments");
    expect(state.store!.getVentureWorkflowEnvelope(company.id)).toEqual(before);
    expect(state.fill).toHaveBeenCalledTimes(1);
    const original = state.fill.getMockImplementation()!;
    state.fill.mockImplementationOnce(async (...args) => {
      expect(args[1].preserveFieldKeys).toEqual(["company"]);
      expect(args[1].fields).toHaveLength(2);
      expect(getVentureWorkflow(company.id).execution).toMatchObject({
        status: "running",
        manifest: first.manifest,
        priorExecutionId: first.id,
        previousAttempts: [{ id: first.id }],
        requestedFieldKeys: ["technology"],
        preservedFieldKeys: ["company"],
        touchedFieldKeys: [],
      });
      return original(...args);
    });
    const response = await recoveryExecute(review.token);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.execution).toMatchObject({
      status: "completed",
      completedFieldKeys: ["technology"],
      touchedFieldKeys: ["technology"],
      preservedFieldKeys: ["company"],
      previousAttempts: [
        { id: first.id, touchedFieldKeys: ["company"], completedFieldKeys: ["company"] },
      ],
    });
    expect(body.execution.previousAttempts[0]).not.toHaveProperty("manifest");
    expect(body.execution.previousAttempts[0]).not.toHaveProperty("previousAttempts");
    expect(body.workflow.revision).toBe(5);
    expect(state.compare).toHaveBeenCalledTimes(2);
    expect((await recoveryExecute(review.token)).status).toBe(410);
    expect((await POST(request(prepareBody()), context())).status).toBe(409);
    expect(state.fill).toHaveBeenCalledTimes(2);
  });
  it("미시도 항목이 수동으로 일치했어도 보호하며 completed에 새 쓰기로 포함하지 않는다", async () => {
    await partial([], []);
    const { review } = await (await recoveryPrepare()).json();
    const result = await (await recoveryExecute(review.token)).json();
    expect(result.execution.completedFieldKeys).toEqual(["technology"]);
    expect(result.execution.preservedFieldKeys).toEqual(["company"]);
  });
  it("모두 미시도 빈칸이면 preserveFieldKeys 빈 배열로 복구 모드를 명시한다", async () => {
    await partial([], []);
    comparisonStates(["empty", "empty"]);
    const { review } = await (await recoveryPrepare()).json();
    expect((await recoveryExecute(review.token)).status).toBe(200);
    expect(state.fill.mock.calls.at(-1)![1].preserveFieldKeys).toEqual([]);
  });
  it.each([
    ["empty", "empty"],
    ["conflict", "empty"],
    ["unknown", "empty"],
    ["matched", "conflict"],
    ["matched", "unknown"],
    ["matched", "matched"],
  ])(
    "이전 시도 공란·상충·미확인 또는 남은 빈칸 없음은 복구하지 않는다: %s %s",
    async (...states) => {
      await partial();
      comparisonStates(states);
      expect((await recoveryPrepare()).status).toBe(409);
      expect(state.fill).toHaveBeenCalledTimes(1);
    },
  );
  it("시도했지만 완료 확인 없는 빈칸도 자동 재전송하지 않는다", async () => {
    await partial(["company", "technology"], ["company"]);
    expect((await recoveryPrepare()).status).toBe(409);
    expect(state.fill).toHaveBeenCalledTimes(1);
  });
  it.each([
    "manifest",
    "touchedFieldKeys",
    "requestedFieldKeys",
    "preservedFieldKeys",
    "previousAttempts",
    "priorExecutionId",
  ])("이전 정확기록 %s 누락은 legacy로 복구 차단한다", async (key) => {
    await partial();
    changeReceipt((record) => {
      delete record[key];
    });
    expect((await recoveryPrepare()).status).toBe(409);
    expect(state.compare).not.toHaveBeenCalled();
  });
  it.each([
    "running",
    "completed",
    "unknown",
    "unclassified",
    "duplicate",
    "not-prefix",
    "completed-outside",
    "attempted-outside",
    "old-id",
  ])("모순되거나 결과 미확인인 이력은 복구 차단한다: %s", async (condition) => {
    await partial();
    changeReceipt((record) => {
      if (condition === "running" || condition === "completed") record.status = condition;
      if (condition === "unknown") record.code = "INPUT_RESULT_UNKNOWN";
      if (condition === "unclassified") record.code = "FUTURE_UNVERIFIED_CODE";
      if (condition === "duplicate") record.touchedFieldKeys = ["company", "company"];
      if (condition === "not-prefix") record.touchedFieldKeys = ["technology"];
      if (condition === "completed-outside") record.completedFieldKeys = ["technology"];
      if (condition === "attempted-outside") record.attemptedFieldKey = "technology";
      if (condition === "old-id") record.priorExecutionId = randomUUID();
    });
    expect((await recoveryPrepare()).status).toBe(409);
    expect(state.compare).not.toHaveBeenCalled();
  });
  it("원래 manifest의 첨부는 현재 첨부 목록에 없어도 복구 불가", async () => {
    await partial();
    changeReceipt((record) => {
      record.manifest.targets[1].kind = "file";
    });
    expect((await recoveryPrepare()).status).toBe(409);
    expect(state.compare).not.toHaveBeenCalled();
  });
  it("실제 첨부를 포함한 원래 실행은 텍스트 부분실행처럼 복구하지 않는다", async () => {
    addOriginal();
    await partial();
    expect((await recoveryPrepare()).status).toBe(409);
    expect(state.compare).not.toHaveBeenCalled();
  });
  it("동일 내용 연결안 재저장도 immutable 원래 revision과 달라 복구 차단한다", async () => {
    await partial();
    alter(() => undefined);
    expect((await recoveryPrepare()).status).toBe(409);
    expect(state.compare).not.toHaveBeenCalled();
  });
  it.each(["company", "account", "session", "snapshot", "mapping"])(
    "복구 검토 후 %s 변경은 새 입력 전에 차단한다",
    async (change) => {
      await partial();
      const { review } = await (await recoveryPrepare()).json();
      if (change === "company")
        company = state.store!.mutate(
          company.id,
          { action: "stage", revision: company.revision, stage: "preparing" },
          () => [],
        );
      if (change === "account") state.accountRevision += 1;
      if (change === "session")
        state.session = { ...state.session!, startedAt: new Date(Date.now() + 1000).toISOString() };
      if (change === "snapshot")
        alter((data) => {
          data.snapshot.screen.id = randomUUID();
          data.draft.snapshotId = data.snapshot.screen.id;
        });
      if (change === "mapping")
        alter((data) => {
          data.draft.textMappings[1].source.property = "companyName";
        });
      expect((await recoveryExecute(review.token)).status).toBe(409);
      expect(state.fill).toHaveBeenCalledTimes(1);
      expect((await recoveryExecute(review.token)).status).toBe(410);
    },
  );
  it("복구 승인 후 읽기 대조 분할이 바뀌면 기존 token으로 다른 빈칸을 쓰지 않는다", async () => {
    await partial([], []);
    const { review } = await (await recoveryPrepare()).json();
    comparisonStates(["empty", "matched"]);
    expect((await recoveryExecute(review.token)).status).toBe(409);
    expect(state.fill).toHaveBeenCalledTimes(1);
  });
  it("정상 token을 복구에, 복구 token을 정상 실행에 교차 사용하지 않는다", async () => {
    const normal = await prepare();
    expect((await recoveryExecute(normal.token)).status).toBe(410);
    expect((await execute(normal.token)).status).toBe(410);
    await partial();
    const { review } = await (await recoveryPrepare()).json();
    expect((await execute(review.token)).status).toBe(410);
    expect((await recoveryExecute(review.token)).status).toBe(410);
    expect(state.fill).toHaveBeenCalledTimes(1);
  });
  it("복구 검토는 별도 2분 단회 만료와 재검토 이전 token 폐기를 적용한다", async () => {
    await partial();
    const first = await (await recoveryPrepare()).json();
    const { review } = await (await recoveryPrepare()).json();
    expect((await recoveryExecute(first.review.token)).status).toBe(410);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(review.expiresAt));
    expect((await recoveryExecute(review.token)).status).toBe(410);
    expect(state.fill).toHaveBeenCalledTimes(1);
  });
  it("복구 전용 승인도 approved true 외 값·파일 주입을 거부한다", async () => {
    await partial();
    const { review } = await (await recoveryPrepare()).json();
    expect(
      (
        await POST(
          request({ action: "execute-recovery", token: review.token, approved: false }),
          context(),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await POST(
          request({ action: "execute-recovery", token: review.token, approved: true, fields: [] }),
          context(),
        )
      ).status,
    ).toBe(400);
    expect(state.fill).toHaveBeenCalledTimes(1);
  });
  it("복구 runner가 보호 대상 새 쓰기 또는 touched 누락을 보고하면 unknown으로 보관한다", async () => {
    await partial();
    const { review } = await (await recoveryPrepare()).json();
    state.fill.mockResolvedValueOnce({
      status: "completed",
      completedFieldKeys: ["company", "technology"],
      touchedFieldKeys: ["company", "technology"],
      attemptedFieldKey: null,
      code: null,
    });
    const result = await (await recoveryExecute(review.token)).json();
    expect(result.execution).toMatchObject({
      status: "stopped",
      code: "INPUT_RESULT_UNKNOWN",
      previousAttempts: [{ touchedFieldKeys: ["company"] }],
    });
    expect((await recoveryPrepare()).status).toBe(409);
  });
  it("일반 runner의 touched 누락은 0회 입력으로 추정하지 않고 복구 금지한다", async () => {
    state.fill.mockResolvedValueOnce({
      status: "stopped",
      completedFieldKeys: [],
      attemptedFieldKey: null,
      code: "TARGET_CHANGED",
    });
    const result = await (await execute((await prepare()).token)).json();
    expect(result.execution.code).toBe("INPUT_RESULT_UNKNOWN");
    expect((await recoveryPrepare()).status).toBe(409);
  });
  it("복구 중 다시 중단돼도 모든 과거 touched를 보존하고 빈칸 재전송을 막는다", async () => {
    const first = await partial();
    const { review } = await (await recoveryPrepare()).json();
    state.fill.mockResolvedValueOnce({
      status: "stopped",
      completedFieldKeys: [],
      touchedFieldKeys: ["technology"],
      attemptedFieldKey: "technology",
      code: "VALUE_UNCONFIRMED",
    });
    const result = await (await recoveryExecute(review.token)).json();
    expect(result.execution.previousAttempts).toMatchObject([
      { id: first.id, touchedFieldKeys: ["company"] },
    ]);
    expect(result.execution.touchedFieldKeys).toEqual(["technology"]);
    expect((await recoveryPrepare()).status).toBe(409);
    expect(state.fill).toHaveBeenCalledTimes(2);
  });
  it("복구가 쓰기 전 중단돼 touched가 없으면 동일 보호항목으로 새 승인을 준비할 수 있다", async () => {
    await partial();
    const { review } = await (await recoveryPrepare()).json();
    state.fill.mockResolvedValueOnce({
      status: "stopped",
      completedFieldKeys: [],
      touchedFieldKeys: [],
      attemptedFieldKey: null,
      code: "TARGET_CHANGED",
    });
    expect((await recoveryExecute(review.token)).status).toBe(200);
    const next = await recoveryPrepare();
    expect(next.status).toBe(200);
    expect((await recoveryExecute((await next.json()).review.token)).status).toBe(200);
    expect(getVentureWorkflow(company.id).execution!.previousAttempts).toHaveLength(2);
  });
  it("시도 10회 이력 상한에서는 trim 없이 복구를 차단한다", async () => {
    await partial();
    for (let index = 0; index < 9; index += 1) {
      const prepared = await recoveryPrepare();
      expect(prepared.status).toBe(200);
      state.fill.mockResolvedValueOnce({
        status: "stopped",
        completedFieldKeys: [],
        touchedFieldKeys: [],
        attemptedFieldKey: null,
        code: "TARGET_CHANGED",
      });
      expect((await recoveryExecute((await prepared.json()).review.token)).status).toBe(200);
    }
    expect(getVentureWorkflow(company.id).execution!.previousAttempts).toHaveLength(9);
    expect((await recoveryPrepare()).status).toBe(409);
    expect(state.fill).toHaveBeenCalledTimes(10);
  });
  it("최종 재검사 실패로 완료 목록이 비어도 touched가 있으면 내보내기는 결과 미확인이다", async () => {
    state.fill.mockResolvedValueOnce({
      status: "stopped",
      completedFieldKeys: [],
      touchedFieldKeys: ["company", "technology"],
      attemptedFieldKey: null,
      code: "VALUE_UNCONFIRMED",
    });
    await execute((await prepare()).token);
    const exported = await (
      await GET(new Request("http://localhost:3000/api?download=1"), context())
    ).json();
    expect(exported.latestExecutionExternalWritesPerformed).toBeNull();
    expect(exported.execution.touchedFieldKeys).toEqual(["company", "technology"]);
  });

  it("준비본 로컬 대조는 실행·화면 접근·승인 발급 없이 기존 v1 승인을 보존한다", async () => {
    const prior = await prepare();
    const pinned = pinnedPackage();
    const revision = prepareBody().revision;
    const response = await POST(
      request({
        ...prepareBody(),
        action: "compare-prepared-package",
        preparedPackageId: pinned.record.id,
      }),
      context(),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).preparedComparison).toMatchObject({
      caseId: company.id,
      workflowRevision: revision,
      companyRevision: company.revision,
      accountRevision: state.accountRevision,
      snapshotId: screen.id,
      result: {
        matched: true,
        binding: { targets: [{ fieldKey: "company" }, { fieldKey: "technology" }] },
      },
    });
    expect(prepareBody().revision).toBe(revision);
    expect(getVentureWorkflow(company.id).execution).toBeNull();
    expect(state.fill).not.toHaveBeenCalled();
    expect(state.compare).not.toHaveBeenCalled();
    expect(state.inspect).not.toHaveBeenCalled();
    const done = await (await execute(prior.token)).json();
    expect(done.execution.manifest.version).toBe(1);
    expect(done.execution.manifest.preparedPackage).toBeUndefined();
  });

  it("준비본 대조 실패는 불일치를 표시하고 명시한 v2 준비를 v1으로 낮추지 않는다", async () => {
    const pinned = pinnedPackage();
    pinned.record.company.profile.technologySummary = "보관된 다른 내용";
    const compared = await POST(
      request({
        ...prepareBody(),
        action: "compare-prepared-package",
        preparedPackageId: pinned.record.id,
      }),
      context(),
    );
    expect(compared.status).toBe(200);
    expect((await compared.json()).preparedComparison.result).toMatchObject({
      matched: false,
      binding: null,
      digest: null,
      issues: [{ code: "PROFILE_VALUE_MISMATCH", fieldKey: "technology" }],
    });
    const refused = await POST(
      request({ ...prepareBody(), preparedPackageId: pinned.record.id }),
      context(),
    );
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe("PREPARED_PACKAGE_MISMATCH");
    expect(getVentureWorkflow(company.id).execution).toBeNull();
    expect(state.fill).not.toHaveBeenCalled();
  });

  it("같은 회사 revision·원고 ID·version에서도 원고 내용이 바뀌면 v2 승인을 거부한다", async () => {
    const pinned = pinnedPackage();
    const review = await preparePinned(pinned.record.id);
    const get = state.store!.get.bind(state.store!);
    vi.spyOn(state.store!, "get").mockImplementation((id) => {
      const value = get(id);
      if (id === company.id) value.plans.at(-1)!.content.summary += " 내용 변경";
      return value;
    });
    const response = await execute(review.token);
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("PREPARED_PACKAGE_MISMATCH");
    expect(state.fill).not.toHaveBeenCalled();
    expect((await execute(review.token)).status).toBe(410);
  });

  it.each(["company", "account", "session", "snapshot", "mapping"])(
    "v2 검토 후 %s 변경은 기존 승인으로 입력할 수 없다",
    async (change) => {
      const pinned = pinnedPackage();
      const review = await preparePinned(pinned.record.id);
      if (change === "company")
        company = state.store!.mutate(
          company.id,
          { action: "stage", revision: company.revision, stage: "preparing" },
          () => [],
        );
      if (change === "account") state.accountRevision += 1;
      if (change === "session")
        state.session = { ...state.session!, startedAt: new Date(Date.now() + 1000).toISOString() };
      if (change === "snapshot")
        alter((data) => {
          data.snapshot.screen.id = randomUUID();
          data.draft.snapshotId = data.snapshot.screen.id;
        });
      if (change === "mapping")
        alter((data) => {
          data.draft.textMappings[1].source.property = "companyName";
        });
      expect((await execute(review.token)).status).toBe(409);
      expect(state.fill).not.toHaveBeenCalled();
      expect((await execute(review.token)).status).toBe(410);
    },
  );

  it.each(["delete", "same-size-content"])(
    "v2 승인 후 현재 원본 %s 변경은 보관 ZIP이 있어도 전송하지 않는다",
    async (change) => {
      const original = addOriginal();
      const pinned = pinnedPackage(new Map([[original.source.id, original.content]]));
      const review = await preparePinned(pinned.record.id);
      if (change === "delete") unlinkSync(original.path);
      else writeFileSync(original.path, Buffer.alloc(original.content.byteLength, 120));
      expect((await execute(review.token)).status).toBe(409);
      expect(state.fill).not.toHaveBeenCalled();
      expect((await execute(review.token)).status).toBe(410);
    },
  );

  const partialPinned = async () => {
    const pinned = pinnedPackage();
    const review = await preparePinned(pinned.record.id);
    state.fill.mockResolvedValueOnce({
      status: "stopped",
      completedFieldKeys: ["company"],
      touchedFieldKeys: ["company"],
      attemptedFieldKey: "company",
      code: "TARGET_CHANGED",
    });
    const response = await execute(review.token);
    expect(response.status).toBe(200);
    const execution = (await response.json()).execution;
    comparisonStates(["matched", "empty"]);
    return { ...pinned, review, execution };
  };

  it("v2 부분 복구는 원래 준비본·전체 두 항목을 보존하고 새 빈칸 한 개만 승인한다", async () => {
    const first = await partialPinned();
    const response = await recoveryPrepare();
    expect(response.status).toBe(200);
    const { review } = await response.json();
    expect(review.preparedPackage).toEqual(first.review.preparedPackage);
    expect(
      review.preparedPackage.binding.targets.map((item: { fieldKey: string }) => item.fieldKey),
    ).toEqual(["company", "technology"]);
    expect(review.fields.map((item: { fieldKey: string }) => item.fieldKey)).toEqual([
      "technology",
    ]);
    const result = await (await recoveryExecute(review.token)).json();
    expect(result.execution.status).toBe("completed");
    expect(result.execution.manifest).toEqual(first.execution.manifest);
    expect(result.execution.requestedFieldKeys).toEqual(["technology"]);
    expect(result.execution.preservedFieldKeys).toEqual(["company"]);
    expect(result.execution.previousAttempts[0].id).toBe(first.execution.id);
    expect(state.fill).toHaveBeenCalledTimes(2);
  });

  it.each(["missing", "other-version", "protected-value"])(
    "v2 부분 복구에서 원래 준비본 %s 변경을 전체 범위로 다시 확인한다",
    async (change) => {
      const first = await partialPinned();
      if (change === "missing")
        first.download.mockImplementation(() => {
          throw new StudioError("합성 준비본 없음", 404, "PREPARED_PACKAGE_NOT_FOUND");
        });
      if (change === "other-version") first.record.version += 1;
      if (change === "protected-value")
        first.record.company.profile.companyName = "이미 입력된 보호 항목도 변경됨";
      expect((await recoveryPrepare()).status).toBe(change === "missing" ? 404 : 409);
      expect(state.compare).not.toHaveBeenCalled();
      expect(state.fill).toHaveBeenCalledTimes(1);
      expect(getVentureWorkflow(company.id).execution!.manifest).toEqual(first.execution.manifest);
    },
  );

  it("v1 부분 복구는 준비본이 있어도 조회하거나 권한을 자동 결합하지 않는다", async () => {
    const first = await partial();
    const pinned = pinnedPackage();
    const { review } = await (await recoveryPrepare()).json();
    expect(review.preparedPackage).toBeUndefined();
    const result = await (await recoveryExecute(review.token)).json();
    expect(result.execution.manifest).toEqual(first.manifest);
    expect(result.execution.manifest.version).toBe(1);
    expect(pinned.download).not.toHaveBeenCalled();
  });

  it("v2 runner 도중 준비본 변경은 완료로 확정하지 않고 원래 manifest와 unknown을 보관한다", async () => {
    const pinned = pinnedPackage();
    const review = await preparePinned(pinned.record.id);
    state.fill.mockImplementationOnce(async (_caseId, _input, assertCurrent) => {
      assertCurrent();
      pinned.buffer[0] ^= 1;
      return {
        status: "completed",
        completedFieldKeys: ["company", "technology"],
        touchedFieldKeys: ["company", "technology"],
        attemptedFieldKey: null,
        code: null,
      };
    });
    const result = await (await execute(review.token)).json();
    expect(result.execution).toMatchObject({
      status: "stopped",
      code: "INPUT_RESULT_UNKNOWN",
      manifest: { version: 2, preparedPackage: review.preparedPackage },
    });
    expect((await recoveryPrepare()).status).toBe(409);
    expect((await execute(review.token)).status).toBe(410);
    expect(state.fill).toHaveBeenCalledTimes(1);
  });
});
