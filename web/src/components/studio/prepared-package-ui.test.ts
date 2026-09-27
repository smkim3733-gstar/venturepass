import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { caseSchema, emptyProfile, type BusinessPlan } from "@/lib/studio-schema";
import {
  preparedPackageRecordSchema,
  preparedPackageSummary,
  type PreparedPackageRecord,
  type PreparedPackageRequest,
} from "@/lib/studio-prepared-package-types";
import {
  preparedPackageCurrent,
  preparedPackageList,
  preparedPackageReceipt,
  preparedPackageDefiniteRejection,
} from "./prepared-package-ui";
import { PackagePanel } from "./package-panel";
import { PreparedPackagesPanel } from "./prepared-packages-panel";

const id = "11111111-1111-4111-8111-111111111111",
  planId = "22222222-2222-4222-8222-222222222222",
  nonce = "33333333-3333-4333-8333-333333333333",
  archiveId = "44444444-4444-4444-8444-444444444444",
  foreign = "55555555-5555-4555-8555-555555555555",
  now = "2026-09-26T00:00:00.000Z",
  hash = "a".repeat(64);
function fixture() {
  const plan: BusinessPlan = {
    id: planId,
    version: 1,
    generatedAt: now,
    sourceRevision: 1,
    mode: "ai",
    candidateId: "synthetic",
    confirmedAt: null,
    review: [
      {
        id: "f",
        severity: "warning",
        category: "semantic-evidence",
        sectionKey: "problem",
        message: "합성 사실 확인",
        action: "근거 확인",
        sourceIds: [],
      },
    ],
    content: {
      title: "합성 준비본",
      summary: "합성 설명",
      sections: [
        {
          key: "problem",
          title: "문제",
          content: "합성 개발 중",
          evidence: [],
          needsConfirmation: true,
        },
      ],
      actionItems: ["사실 확인"],
      interviewQuestions: [],
    },
  };
  const company = caseSchema.parse({
    id,
    profile: { ...emptyProfile(), companyName: "합성 기업" },
    sources: [],
    plans: [plan],
    analysis: null,
    selectedCandidateId: "synthetic",
    stage: "drafting",
    tasks: [],
    revision: 4,
    createdAt: now,
    updatedAt: now,
  });
  const request: PreparedPackageRequest = {
    revision: 4,
    planId,
    sourceIds: [],
    clientRequestId: nonce,
  };
  const record = preparedPackageRecordSchema.parse({
    id: archiveId,
    version: 1,
    caseId: id,
    caseRevision: 4,
    clientRequestId: nonce,
    requestDigest: hash,
    input: request,
    createdAt: now,
    scope: "local-preparation-only",
    company: { profile: company.profile, snapshotSha256: hash },
    plan: { ...company.plans[0], contentSha256: hash },
    sourceIds: [],
    sources: [],
    review: {
      storedFindings: company.plans[0].review,
      currentRuleFindings: [],
      confirmedAt: null,
      unconfirmedSectionKeys: ["problem"],
      currentEvidence: true,
      latestPlanVersion: true,
      draft: true,
      draftReasons: ["NOT_REVIEWED"],
    },
    zip: { fileName: "venturepass-preparation-package.zip", sha256: hash, sizeBytes: 100 },
  });
  return { company, plan: company.plans[0], request, record };
}
describe("로컬 준비본 응답과 기본 화면", () => {
  it.each([
    "STALE_REVISION",
    "PREPARED_SNAPSHOT_CHANGED",
    "PACKAGE_ORIGINAL_CHANGED",
    "PREPARED_REQUEST_CONFLICT",
    "ORIGINAL_UNAVAILABLE",
    "ORIGINAL_CHANGED",
    "ORIGINAL_METADATA_CHANGED",
    "UNSAFE_ORIGINAL_PATH",
    "INTAKE_ORIGINAL_CHANGED",
    "SUGGESTION_ORIGINAL_CHANGED",
    "PROCEDURE_ORIGINAL_CHANGED",
  ])("저장 전 확정 거절 %s는 편집 화면을 가두지 않는다", (code) => {
    expect(preparedPackageDefiniteRejection(409, code)).toBe(true);
  });
  it.each([
    [409, "PACKAGE_BUSY"],
    [409, undefined],
    [500, "INTERNAL_ERROR"],
    [408, undefined],
    [429, undefined],
  ])("불명확한 %s/%s는 새 요청을 만들지 않는다", (status, code) => {
    expect(preparedPackageDefiniteRejection(status as number, code as string | undefined)).toBe(
      false,
    );
  });
  it("선택한 원고·검토 상태·요청의 보관 결과만 채택한다", () => {
    const { company, request, record } = fixture();
    expect(preparedPackageReceipt({ package: record, replayed: false }, company, request)).toEqual(
      record,
    );
  });
  const corruptions: [string, (r: PreparedPackageRecord) => void][] = [
    [
      "기업",
      (r) => {
        r.caseId = foreign;
      },
    ],
    [
      "버전",
      (r) => {
        r.caseRevision++;
      },
    ],
    [
      "요청",
      (r) => {
        r.clientRequestId = foreign;
      },
    ],
    [
      "원요청",
      (r) => {
        r.input.revision++;
      },
    ],
    [
      "원고",
      (r) => {
        r.plan.id = foreign;
      },
    ],
    [
      "원고버전",
      (r) => {
        r.plan.version++;
      },
    ],
    [
      "본문",
      (r) => {
        r.plan.content.summary = "다른 본문";
      },
    ],
    [
      "검토",
      (r) => {
        r.plan.review = [];
      },
    ],
    [
      "확정",
      (r) => {
        r.plan.confirmedAt = now;
      },
    ],
    [
      "회사정보",
      (r) => {
        r.company.profile.companyName = "다른기업";
      },
    ],
    [
      "첨부",
      (r) => {
        r.sourceIds = [foreign];
      },
    ],
    [
      "저장검토",
      (r) => {
        r.review.storedFindings = [];
      },
    ],
    [
      "확인상태",
      (r) => {
        r.review.unconfirmedSectionKeys = [];
      },
    ],
    [
      "검토확정",
      (r) => {
        r.review.confirmedAt = now;
      },
    ],
  ];
  it.each(corruptions)("%s 불일치를 성공으로 표시하지 않는다", (_, change) => {
    const { company, request, record } = fixture();
    change(record);
    expect(() => preparedPackageReceipt({ package: record }, company, request)).toThrow();
  });
  it("당시 요청 결과는 현재 자료와 별개로 복구하되 현재 자료 일치로 표시하지 않는다", () => {
    const { company, request, record } = fixture();
    const original = structuredClone(company);
    company.revision++;
    expect(preparedPackageReceipt({ package: record }, original, request).id).toBe(archiveId);
    expect(preparedPackageCurrent(preparedPackageSummary(record), company)).toBe(false);
  });
  it("현재 회사·버전의 목록을 채택하고 중복·다른회사 항목은 거부한다", () => {
    const { company, record } = fixture();
    const summary = preparedPackageSummary(record);
    const list = { caseId: id, caseRevision: 4, packages: [summary] };
    expect(preparedPackageList(list, company).packages).toHaveLength(1);
    expect(() => preparedPackageList({ ...list, packages: [summary, summary] }, company)).toThrow();
    expect(() =>
      preparedPackageList({ ...list, packages: [{ ...summary, caseId: foreign }] }, company),
    ).toThrow();
    expect(() => preparedPackageList({ ...list, caseRevision: 3 }, company)).toThrow();
  });
  it("보관 버튼이 있는 경우 직접 다운로드는 보조 동작이다", () => {
    const { company, plan } = fixture();
    const preserve = vi.fn(),
      busy = vi.fn();
    const html = renderToStaticMarkup(
      createElement(PackagePanel, {
        company,
        plan,
        dirty: false,
        onBusyChange: busy,
        onPreserve: preserve,
      }),
    );
    expect(html).toContain("원고와 선택 원본 보관");
    expect(html).toContain("제출 준비 ZIP 내려받기");
    expect(preserve).not.toHaveBeenCalled();
    expect(busy).not.toHaveBeenCalled();
  });
  it("사용자 확인 표시가 있어도 미해결 AI 의미 의견을 검토 필요로 표시한다", () => {
    const { company, plan } = fixture();
    company.analysis = {
      generatedAt: now,
      mode: "ai",
      sourceRevision: 1,
      summary: "합성 분석",
      facts: [],
      candidates: [],
      questions: [],
      warnings: [],
    };
    plan.confirmedAt = now;
    plan.content.sections[0].needsConfirmation = false;
    const html = renderToStaticMarkup(
      createElement(PackagePanel, {
        company,
        plan,
        dirty: false,
        onBusyChange: vi.fn(),
      }),
    );
    expect(html).toContain("DRAFT · 담당자 검토 필요");
  });
  it("준비본 화면 진입만으로 보관·AI 호출·확정을 수행하지 않는다", () => {
    const { company, plan } = fixture();
    const before = structuredClone(company),
      fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      const html = renderToStaticMarkup(
        createElement(PreparedPackagesPanel, {
          company,
          plan,
          dirty: false,
          blocked: false,
          onBusyChange: vi.fn(),
          onUnsettledChange: vi.fn(),
          onClose: vi.fn(),
        }),
      );
      expect(html).toContain("기관 전송·접수·내부 검토 완료를 대신하지 않습니다");
      expect(html).toContain("보관한 준비본");
      expect(fetch).not.toHaveBeenCalled();
      expect(company).toEqual(before);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
