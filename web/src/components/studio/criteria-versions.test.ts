import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { caseSchema, emptyProfile } from "@/lib/studio-schema";
import { applicationCycleSchema } from "@/lib/studio-application-types";
import {
  buildApplicationCriteriaBinding,
  buildCriteriaVersion,
  criteriaVersionInputDigest,
  withApplicationCriteriaContexts,
} from "@/lib/studio-criteria-version";
import {
  criteriaReferenceDownloadName,
  type CriteriaVersion,
  type AppendCriteriaVersionInput,
  type PinApplicationCriteriaInput,
} from "@/lib/studio-criteria-version-types";
import {
  CriteriaApplicationStatus,
  CriteriaBindingView,
  CriteriaDetailsEditor,
  CriteriaVersions,
  CriteriaVersionView,
} from "./criteria-versions";
import {
  criteriaApplicationUiContext,
  criteriaCommandProblem,
  criteriaSaveAcknowledged,
  emptyCriteriaPin,
  emptyCriteriaVersion,
  latestCriteriaVersions,
  newCriteriaDocument,
  type CriteriaCommand,
} from "./criteria-versions-ui";

const now = "2026-09-25T00:00:00.000Z";
function fixture() {
  const company = caseSchema.parse({
    id: randomUUID(),
    profile: { ...emptyProfile(), companyName: "합성 기준 회사", businessNumber: "1234567890" },
    sources: [],
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: "preparing",
    revision: 3,
    createdAt: now,
    updatedAt: now,
  });
  company.applications.push(
    applicationCycleSchema.parse({
      id: randomUUID(),
      clientRequestId: randomUUID(),
      inputDigest: "a".repeat(64),
      origin: "manual",
      recordedAt: now,
      title: "합성 신청 회차",
      kind: "new",
      plannedOn: "",
      criteriaNote: "미확인",
      previousApplicationId: null,
      companyAtCreation: {
        companyName: company.profile.companyName,
        businessNumber: company.profile.businessNumber,
      },
    }),
  );
  const append: AppendCriteriaVersionInput = {
    criteriaId: null,
    previousVersionId: null,
    details: {
      title: "기입 기준",
      versionLabel: "내부 1",
      applicationPath: "",
      checkedOn: "",
      sources: [
        {
          title: "합성 출처",
          url: "https://example.invalid/criteria",
          quote: "당시 원문 인용",
          note: "합성 안내",
        },
      ],
      documents: [
        {
          ...newCriteriaDocument(),
          name: "합성 서류",
          autoLinkGuidance: "자동연계 가능하다고 기입",
        },
      ],
    },
    recordedBy: "합성 담당자",
    reason: "첫 기준 보관",
  };
  const server = (input: CriteriaCommand) => {
    const clientRequestId = randomUUID();
    return {
      id: randomUUID(),
      clientRequestId,
      recordedAt: now,
      inputDigest: criteriaVersionInputDigest({
        ...input,
        revision: company.revision,
        clientRequestId,
      }),
    };
  };
  const add = (input = append) => {
    const record = buildCriteriaVersion(
      company,
      input,
      server({ action: "append-criteria-version", ...input }),
    );
    company.criteriaVersions.push(record);
    return record;
  };
  const pinInput = (record: CriteriaVersion): PinApplicationCriteriaInput => ({
    applicationId: company.applications[0].id,
    applicationMetadataVersionId: company.applications[0].id,
    criteriaVersionId: record.id,
    criteriaContentSha256: record.contentSha256,
    previousBindingId: company.applicationCriteriaBindings.at(-1)?.id ?? null,
    recordedBy: "합성 연결 담당자",
    reason: "정확한 버전 선택",
  });
  const pin = (record: CriteriaVersion) => {
    const input = pinInput(record),
      binding = buildApplicationCriteriaBinding(
        company,
        input,
        server({ action: "pin-application-criteria", ...input }),
      );
    company.applicationCriteriaBindings.push(binding);
    return { binding, input };
  };
  return { company, append, add, server, pinInput, pin };
}

describe("수동 기준 편집과 정확한 회차 연결", () => {
  it("기준·확인일·서류 조건을 임의 기본값으로 채우지 않는다", () => {
    const input = emptyCriteriaVersion();
    expect(input).toMatchObject({
      action: "append-criteria-version",
      criteriaId: null,
      previousVersionId: null,
      details: { title: "", versionLabel: "", checkedOn: "", sources: [], documents: [] },
      recordedBy: "",
      reason: "",
    });
    expect(emptyCriteriaPin()).toMatchObject({
      applicationId: "",
      applicationMetadataVersionId: "",
      criteriaVersionId: "",
      criteriaContentSha256: "",
      previousBindingId: null,
    });
    const first = newCriteriaDocument(),
      second = newCriteriaDocument();
    expect(first.id).not.toBe(second.id);
    expect(
      Object.entries(first)
        .filter(([key]) => key !== "id")
        .every(([, value]) => value === ""),
    ).toBe(true);
  });
  it("정정은 이전 내용을 독립 복사하고 확인일/담당자를 재입력하게 한다", () => {
    const state = fixture(),
      first = state.add({
        ...state.append,
        details: { ...state.append.details, checkedOn: "2026-09-25" },
      }),
      input = emptyCriteriaVersion(first);
    if (input.action !== "append-criteria-version") throw new Error("fixture");
    expect(input).toMatchObject({
      criteriaId: first.criteriaId,
      previousVersionId: first.id,
      details: { checkedOn: "" },
      recordedBy: "",
      reason: "",
    });
    input.details.documents[0].name = "새 편집";
    expect(first.details.documents[0].name).toBe("합성 서류");
  });
  it("과거 정확 버전도 명시적으로 연결할 수 있으며 최신으로 대체하지 않는다", async () => {
    const state = fixture(),
      first = state.add();
    state.add({
      ...state.append,
      criteriaId: first.id,
      previousVersionId: first.id,
      details: { ...state.append.details, versionLabel: "내부 2" },
    });
    const input = { action: "pin-application-criteria" as const, ...state.pinInput(first) };
    expect(await criteriaCommandProblem(state.company, input)).toBe("");
    expect(input.criteriaVersionId).toBe(first.id);
    expect(latestCriteriaVersions(state.company)[0].version).toBe(2);
  });
  it.each(["foreign", "changed-content", "changed-sha", "duplicate"])(
    "기준 %s는 연결하지 않는다",
    async (change) => {
      const state = fixture(),
        first = state.add(),
        input = { action: "pin-application-criteria" as const, ...state.pinInput(first) };
      if (change === "foreign") first.caseId = randomUUID();
      if (change === "changed-content") first.details.documents[0].period = "변조";
      if (change === "changed-sha") first.contentSha256 = "f".repeat(64);
      if (change === "duplicate") state.company.criteriaVersions.push(first);
      expect(await criteriaCommandProblem(state.company, input)).toContain("정확한 기준");
    },
  );
  it.each(["foreign-application", "metadata", "previous-binding"])(
    "잘못된 회차 문맥 %s를 거부한다",
    async (change) => {
      const state = fixture(),
        first = state.add(),
        input = { action: "pin-application-criteria" as const, ...state.pinInput(first) };
      if (change === "foreign-application") input.applicationId = randomUUID();
      if (change === "metadata") input.applicationMetadataVersionId = randomUUID();
      if (change === "previous-binding") input.previousBindingId = randomUUID();
      expect(await criteriaCommandProblem(state.company, input)).not.toBe("");
    },
  );
  it("과거 버전을 정정 출발점으로 자동 사용하지 않는다", async () => {
    const state = fixture(),
      first = state.add(),
      command = emptyCriteriaVersion(first);
    if (command.action !== "append-criteria-version") throw new Error("fixture");
    command.recordedBy = "담당자";
    command.reason = "수정";
    state.add({ ...state.append, criteriaId: first.id, previousVersionId: first.id });
    expect(await criteriaCommandProblem(state.company, command)).toContain("최신 버전");
  });
  it("날짜·출처 URL 형식 오류를 기입값 검증에서 차단한다", async () => {
    const state = fixture();
    expect(
      await criteriaCommandProblem(state.company, {
        action: "append-criteria-version",
        ...state.append,
        details: { ...state.append.details, checkedOn: "2026-02-30" },
      }),
    ).not.toBe("");
    expect(
      await criteriaCommandProblem(state.company, {
        action: "append-criteria-version",
        ...state.append,
        details: {
          ...state.append.details,
          sources: [{ title: "", url: "javascript:synthetic()", quote: "", note: "" }],
        },
      }),
    ).not.toBe("");
  });
});

describe("수동 기준 영수증과 서버 상태 결합", () => {
  it("저장 내용·nonce·서버 버전이 정확한 경우에만 ACK를 인정한다", async () => {
    const state = fixture(),
      baseline = structuredClone(state.company),
      record = state.add();
    state.company.revision++;
    expect(
      await criteriaSaveAcknowledged(state.company, baseline, record.clientRequestId, {
        action: "append-criteria-version",
        ...state.append,
      }),
    ).toBe(true);
    expect(
      await criteriaSaveAcknowledged(state.company, baseline, randomUUID(), {
        action: "append-criteria-version",
        ...state.append,
      }),
    ).toBe(false);
  });
  it.each([
    "company",
    "revision",
    "duplicate",
    "input-digest",
    "details",
    "version",
    "root",
    "official",
  ])("기준 저장 ACK %s 불일치는 성공으로 표시하지 않는다", async (change) => {
    const state = fixture(),
      baseline = structuredClone(state.company),
      record = state.add();
    state.company.revision++;
    if (change === "company") state.company.id = randomUUID();
    if (change === "revision") state.company.revision = 0;
    if (change === "duplicate") state.company.criteriaVersions.push(record);
    if (change === "input-digest") record.inputDigest = "f".repeat(64);
    if (change === "details") record.details.applicationPath = "다른 경로";
    if (change === "version") record.version++;
    if (change === "root") record.criteriaId = randomUUID();
    const raw =
      change === "official"
        ? { ...state.company, criteriaVersions: [{ ...record, officialVerification: "verified" }] }
        : state.company;
    expect(
      await criteriaSaveAcknowledged(raw, baseline, record.clientRequestId, {
        action: "append-criteria-version",
        ...state.append,
      }),
    ).toBe(false);
  });
  it("회차 연결 ACK는 정확한 기준 및 당시 회차와 회사 스냅샷을 요구한다", async () => {
    const state = fixture(),
      record = state.add(),
      baseline = structuredClone(state.company),
      { input, binding } = state.pin(record);
    state.company.revision++;
    expect(
      await criteriaSaveAcknowledged(state.company, baseline, binding.clientRequestId, {
        action: "pin-application-criteria",
        ...input,
      }),
    ).toBe(true);
    binding.applicationSnapshot.title = "다른 회차 제목";
    expect(
      await criteriaSaveAcknowledged(state.company, baseline, binding.clientRequestId, {
        action: "pin-application-criteria",
        ...input,
      }),
    ).toBe(false);
  });
  it.each(["summary", "company-revision", "company-name"])(
    "회차 연결 ACK의 %s 불일치를 거부한다",
    async (change) => {
      const state = fixture(),
        record = state.add(),
        baseline = structuredClone(state.company),
        { input, binding } = state.pin(record);
      state.company.revision++;
      if (change === "summary") binding.criteriaSummary.title = "다른 기준 요약";
      if (change === "company-revision") binding.companySnapshot.revision++;
      if (change === "company-name") binding.companySnapshot.companyName = "다른 회사";
      expect(
        await criteriaSaveAcknowledged(state.company, baseline, binding.clientRequestId, {
          action: "pin-application-criteria",
          ...input,
        }),
      ).toBe(false);
    },
  );
  it("서버 상태가 없거나 다른 연결용이면 현재성 성공으로 추정하지 않는다", () => {
    const state = fixture(),
      first = state.add();
    state.pin(first);
    expect(
      criteriaApplicationUiContext(state.company, state.company.applications[0].id).context,
    ).toBeNull();
    const result = withApplicationCriteriaContexts(state.company);
    expect(criteriaApplicationUiContext(result, result.applications[0].id).context?.status).toBe(
      "pinned-unverified",
    );
    result.applicationCriteriaContexts[0].context.bindingId = randomUUID();
    expect(criteriaApplicationUiContext(result, result.applications[0].id).context).toBeNull();
  });
  it("새 기준 버전의 재확인 안내가 과거 고정 버전을 바꾸지 않는다", () => {
    const state = fixture(),
      first = state.add(),
      { binding } = state.pin(first);
    state.add({
      ...state.append,
      criteriaId: first.id,
      previousVersionId: first.id,
      details: { ...state.append.details, versionLabel: "새 기준" },
    });
    const observed = criteriaApplicationUiContext(
      withApplicationCriteriaContexts(state.company),
      state.company.applications[0].id,
    );
    expect(observed.context?.reasons).toContain("newer-criteria-version");
    expect(observed.binding?.criteriaVersionId).toBe(first.id);
    expect(observed.binding?.id).toBe(binding.id);
  });
  it("서버 표시의 상태/식별자 조합이 모순이면 확인 완료를 추정하지 않는다", () => {
    const state = fixture(),
      record = state.add();
    state.pin(record);
    const result = withApplicationCriteriaContexts(state.company),
      target = result.applicationCriteriaContexts[0];
    target.context.status = "unpinned";
    expect(criteriaApplicationUiContext(result, target.applicationId).context).toBeNull();
    target.context.status = "pinned-unverified";
    target.context.reasons = ["criteria-changed"];
    expect(criteriaApplicationUiContext(result, target.applicationId).context).toBeNull();
  });
});

describe("기준·서류 조건 UI와 정확한 과거 출력", () => {
  it("빈 기준은 자동 생성하지 않으며 회차 연결 버튼은 비활성이다", () => {
    const state = fixture(),
      mutate = vi.fn();
    const html = renderToStaticMarkup(
      createElement(CriteriaVersions, {
        company: state.company,
        mutate,
        blockedReason: "",
        onDirtyChange: vi.fn(),
      }),
    );
    expect(html).toContain("기관 기준을 추정해 기본값으로 채우지 않습니다");
    expect(html).toMatch(/disabled=""[^>]*>회차에 기준 버전 연결/);
    expect(mutate).not.toHaveBeenCalled();
  });
  it("확인일은 빈 값이며 출처·서류 조건은 담당자가 직접 추가한다", () => {
    const command = emptyCriteriaVersion();
    if (command.action !== "append-criteria-version") throw new Error("fixture");
    const html = renderToStaticMarkup(
      createElement(CriteriaDetailsEditor, { details: command.details, onChange: vi.fn() }),
    );
    expect(html).toContain('type="date"');
    expect(html).not.toContain("2026-");
    expect(html).toContain("출처 추가");
    expect(html).toContain("서류 조건 추가");
    expect(html).toContain("앱이 기관을 조회한 것으로 표시하지 않습니다");
  });
  it("기준 기록과 수신 성공·현행 검증을 구분하고 공란 조건은 미확인이다", () => {
    const state = fixture(),
      record = state.add();
    const html = renderToStaticMarkup(createElement(CriteriaVersionView, { record }));
    expect(html).toContain("수동 기준 기록 · 현행 여부 미검증");
    expect(html).toContain("미확인");
    expect(html).toContain("자동연계 가능 안내 (실제 수신 결과 아님)");
    expect(html).not.toContain("서류 확보 완료");
  });
  it("기입한 URL·HTML·인용은 자동 조회하거나 실행하지 않는다", () => {
    const state = fixture(),
      record = state.add();
    record.details.sources[0].quote = "<script>synthetic()</script>";
    const html = renderToStaticMarkup(createElement(CriteriaVersionView, { record }));
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("https://example.invalid/criteria");
    expect(html).not.toContain('href="https://');
    expect(html).toContain("자동 조회하거나 원문의 진위를 확인하지 않았습니다");
  });
  it("서버 관측 누락·과거기준 경고를 회차 화면에서 명시한다", () => {
    const state = fixture(),
      record = state.add();
    state.pin(record);
    const absent = renderToStaticMarkup(
      createElement(CriteriaApplicationStatus, {
        company: state.company,
        applicationId: state.company.applications[0].id,
      }),
    );
    expect(absent).toContain("현재 연결 상태 확인 정보가 없습니다");
    expect(absent).not.toContain("대조 완료");
    state.add({ ...state.append, criteriaId: record.id, previousVersionId: record.id });
    const current = renderToStaticMarkup(
      createElement(CriteriaApplicationStatus, {
        company: withApplicationCriteriaContexts(state.company),
        applicationId: state.company.applications[0].id,
      }),
    );
    expect(current).toContain("새 기준 버전이 있습니다");
    expect(current).toContain("과거 연결은 자동 교체하지 않습니다");
  });
  it("과거 exact binding 출력은 최신 연결로 바뀌지 않는다", () => {
    const state = fixture(),
      first = state.add(),
      old = state.pin(first).binding;
    const second = state.add({
      ...state.append,
      criteriaId: first.id,
      previousVersionId: first.id,
      details: { ...state.append.details, title: "최신 교체 제목" },
    });
    state.pin(second);
    const html = renderToStaticMarkup(
      createElement(CriteriaBindingView, { company: state.company, binding: old }),
    );
    expect(html).toContain(`/criteria-bindings/${old.id}/export`);
    expect(html).toContain(`download="${criteriaReferenceDownloadName}"`);
    expect(html).toContain("당시 원문 인용");
    expect(html).not.toContain("최신 교체 제목");
  });
  it("기준 원문 누락 또는 타회사 연결·편집 중 출력 링크를 열지 않는다", () => {
    const state = fixture(),
      record = state.add(),
      { binding } = state.pin(record);
    const blocked = renderToStaticMarkup(
      createElement(CriteriaBindingView, { company: state.company, binding, blocked: true }),
    );
    expect(blocked).not.toContain("/export");
    const foreign = renderToStaticMarkup(
      createElement(CriteriaBindingView, {
        company: state.company,
        binding: { ...binding, caseId: randomUUID() },
      }),
    );
    expect(foreign).not.toContain("/export");
    state.company.criteriaVersions = [];
    const missing = renderToStaticMarkup(
      createElement(CriteriaBindingView, { company: state.company, binding }),
    );
    expect(missing).toContain("다른 버전으로 대체하지 않습니다");
    expect(missing).not.toContain("/export");
  });
  it("같은 기준을 여러 과거 연결에서 펼쳐도 DOM id는 중복하지 않는다", () => {
    const state = fixture(),
      first = state.add();
    state.pin(first);
    state.pin(first);
    const html = renderToStaticMarkup(
      createElement(CriteriaVersions, {
        company: withApplicationCriteriaContexts(state.company),
        mutate: vi.fn(),
        blockedReason: "",
        onDirtyChange: vi.fn(),
      }),
    );
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(html).toContain("과거 회차 기준 연결 보기");
  });
  it("다른 진행관리 폼 편집은 기준 작성·연결을 막고 기록을 바꾸지 않는다", () => {
    const state = fixture();
    state.add();
    const before = structuredClone(state.company),
      mutate = vi.fn();
    const html = renderToStaticMarkup(
      createElement(CriteriaVersions, {
        company: state.company,
        mutate,
        blockedReason: "기관 기록 편집 중",
        onDirtyChange: vi.fn(),
      }),
    );
    expect(html).toContain("기관 기록 편집 중");
    expect(html).toMatch(/disabled=""[^>]*>수동 기준 버전 추가/);
    expect(html).toMatch(/disabled=""[^>]*>회차에 기준 버전 연결/);
    expect(state.company).toEqual(before);
    expect(mutate).not.toHaveBeenCalled();
  });
});
