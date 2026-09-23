import { randomUUID } from "node:crypto";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StudioStore } from "./studio-storage";
import {
  emptyProfile,
  type AnalysisContent,
  type PlanContent,
  type SourceDocument,
  type StudioCase,
} from "./studio-schema";

const review = () => [];
const profile = {
  ...emptyProfile(),
  companyName: "자료분석 시험기업",
  technologySummary: "산업용 센서 시제품 개발",
};
const analysis: AnalysisContent = {
  summary: "시제품 개발",
  facts: [],
  candidates: [
    {
      id: "sensor",
      title: "산업용 센서",
      problem: "고장 탐지",
      solution: "센서",
      targetCustomer: "제조업",
      differentiation: "확인 필요",
      stage: "시제품",
      businessModel: "판매",
      recommendation: "기술자료 기반",
      evidence: [],
      gaps: [],
    },
  ],
  questions: [],
  warnings: [],
};
const content: PlanContent = {
  title: "산업용 센서 사업계획서",
  summary: "시제품 검증 계획",
  sections: [
    { key: "problem", title: "문제", content: "고장 탐지", evidence: [], needsConfirmation: false },
  ],
  actionItems: [],
  interviewQuestions: [],
};
function source(overrides: Partial<SourceDocument> = {}): SourceDocument {
  return {
    id: randomUUID(),
    name: "개발자료",
    kind: "technology",
    text: "시제품을 개발했습니다.",
    originalName: null,
    mimeType: null,
    extraction: "manual",
    warnings: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("로컬 기업 저장소", () => {
  let directory: string;
  let store: StudioStore;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "venture-studio-test-"));
    store = new StudioStore(directory);
  });
  afterEach(() => {
    store.close();
    const target = resolve(directory);
    if (
      !target.startsWith(resolve(tmpdir()) + "\\venture-studio-test-") &&
      !target.startsWith(resolve(tmpdir()) + "/venture-studio-test-")
    )
      throw new Error("Unsafe test cleanup");
    rmSync(target, { recursive: true, force: true });
  });
  function withPlan(): StudioCase {
    let record = store.create(profile);
    record = store.saveAnalysis(record.id, record.revision, analysis, "assisted");
    record = store.mutate(
      record.id,
      { action: "select-candidate", revision: record.revision, candidateId: "sensor" },
      review,
    );
    return store.saveGeneratedPlan(record.id, record.revision, "sensor", content, [], "assisted");
  }
  it("재시작 후 기업과 자료를 복구한다", () => {
    let record = store.create(profile);
    record = store.mutate(
      record.id,
      { action: "source", revision: record.revision, source: source() },
      review,
    );
    store.close();
    store = new StudioStore(directory);
    expect(store.get(record.id)).toEqual(record);
    expect(store.list()[0]).toMatchObject({
      companyName: profile.companyName,
      sourceCount: 1,
      revision: 1,
    });
  });
  it("별도 연결의 오래된 수정 및 삭제로 최신 내용을 덮어쓰지 않는다", () => {
    const record = store.create(profile);
    const second = new StudioStore(directory);
    try {
      store.mutate(record.id, { action: "stage", revision: 0, stage: "drafting" }, review);
      expect(() =>
        second.mutate(record.id, { action: "stage", revision: 0, stage: "confirmed" }, review),
      ).toThrow("변경");
      expect(() => second.delete(record.id, 0)).toThrow("변경");
      expect(second.get(record.id).stage).toBe("drafting");
    } finally {
      second.close();
    }
  });
  it("계정 암호문은 기업 JSON 밖에 보관하고 재시작 후 계정 버전을 유지한다", () => {
    const record = store.create(profile);
    expect(store.getVentureAccountEnvelope(record.id)).toEqual({
      encryptedPayload: null,
      maskedLoginId: null,
      revision: 0,
      updatedAt: null,
    });
    const encrypted = new Uint8Array([10, 20, 30]);
    store.saveVentureAccountEnvelope(record.id, 0, encrypted, "fi***e");
    expect(store.get(record.id)).toEqual(record);
    expect(JSON.stringify(store.list())).not.toContain("fi***e");
    store.close();
    store = new StudioStore(directory);
    const restored = store.getVentureAccountEnvelope(record.id);
    expect(restored).toMatchObject({ maskedLoginId: "fi***e", revision: 1 });
    expect(Array.from(restored.encryptedPayload!)).toEqual([10, 20, 30]);
  });
  it("계정 연결 해제 뒤 오래된 저장과 삭제를 거절하고 버전을 재사용하지 않는다", () => {
    const record = store.create(profile);
    const second = new StudioStore(directory);
    try {
      store.saveVentureAccountEnvelope(record.id, 0, new Uint8Array([1]), "fi***e");
      expect(() =>
        second.saveVentureAccountEnvelope(record.id, 0, new Uint8Array([2]), "ol***d"),
      ).toThrow("변경");
      expect(() => second.deleteVentureAccountEnvelope(record.id, 0)).toThrow("변경");
      expect(store.deleteVentureAccountEnvelope(record.id, 1)).toMatchObject({
        encryptedPayload: null,
        maskedLoginId: null,
        revision: 2,
      });
      expect(() =>
        second.saveVentureAccountEnvelope(record.id, 1, new Uint8Array([3]), "ol***d"),
      ).toThrow("변경");
      expect(
        second.saveVentureAccountEnvelope(record.id, 2, new Uint8Array([4]), "ne***w").revision,
      ).toBe(3);
      expect(store.get(record.id).revision).toBe(0);
    } finally {
      second.close();
    }
  });
  it("기업 삭제는 해당 암호문과 해제 기록을 cascade 삭제하며 다른 기업 계정은 보존한다", () => {
    const one = store.create(profile);
    const two = store.create({ ...profile, companyName: "계정 격리 시험기업" });
    store.saveVentureAccountEnvelope(one.id, 0, new Uint8Array([1]), "on***e");
    store.saveVentureAccountEnvelope(two.id, 0, new Uint8Array([2]), "tw***o");
    store.deleteVentureAccountEnvelope(one.id, 1);
    store.delete(one.id, one.revision);
    const database = new DatabaseSync(join(directory, "studio.sqlite"));
    try {
      expect(
        database.prepare("SELECT case_id FROM venture_accounts WHERE case_id = ?").get(one.id),
      ).toBeUndefined();
      expect(
        database.prepare("SELECT case_id FROM venture_accounts WHERE case_id = ?").get(two.id),
      ).toBeTruthy();
      expect(() =>
        store.saveVentureAccountEnvelope(one.id, 2, new Uint8Array([3]), "ol***d"),
      ).toThrow("찾을 수 없습니다");
      expect(store.getVentureAccountEnvelope(two.id).revision).toBe(1);
    } finally {
      database.close();
    }
  });
  it("AI 처리 중 수정된 자료에 오래된 생성 결과를 저장하지 않는다", () => {
    const record = store.create(profile);
    store.mutate(
      record.id,
      { action: "source", revision: record.revision, source: source() },
      review,
    );
    expect(() => store.saveAnalysis(record.id, record.revision, analysis, "ai")).toThrow("변경");
    expect(store.get(record.id).analysis).toBeNull();
  });
  it("자료 변경은 분석·선택·검토 확인을 취소하고 이전 원고를 보존한다", () => {
    let record = withPlan();
    const old = record.plans[0];
    record = store.mutate(
      record.id,
      { action: "confirm-plan", revision: record.revision, planId: old.id },
      review,
    );
    expect(record.plans[0].confirmedAt).toBeTruthy();
    record = store.mutate(
      record.id,
      {
        action: "profile",
        revision: record.revision,
        profile: { ...profile, technologySummary: "기술 변경" },
      },
      review,
    );
    expect(record.analysis).toBeNull();
    expect(record.selectedCandidateId).toBeNull();
    expect(record.plans[0].content).toEqual(old.content);
    expect(record.plans[0].confirmedAt).toBeNull();
    expect(store.isPlanCurrent(record.id, record.plans[0])).toBe(false);
    expect(() =>
      store.mutate(
        record.id,
        { action: "confirm-plan", revision: record.revision, planId: old.id },
        review,
      ),
    ).toThrow("변경");
  });
  it("업무 변경은 자료의 최신성이나 계획서 확인을 취소하지 않는다", () => {
    let record = withPlan();
    const task = {
      id: randomUUID(),
      title: "실험자료 준비",
      category: "evidence" as const,
      dueDate: "2026-10-01",
      status: "pending" as const,
      notes: "",
    };
    record = store.mutate(record.id, { action: "task", revision: record.revision, task }, review);
    expect(record.revision).toBeGreaterThan(record.plans[0].sourceRevision);
    expect(store.isPlanCurrent(record.id, record.plans[0])).toBe(true);
    record = store.mutate(
      record.id,
      { action: "confirm-plan", revision: record.revision, planId: record.plans[0].id },
      review,
    );
    expect(record.plans[0].confirmedAt).toBeTruthy();
  });
  it("원고 수정은 새 버전이며 기존 버전의 내용은 변경되지 않는다", () => {
    let record = withPlan();
    const original = structuredClone(record.plans[0]);
    record = store.mutate(
      record.id,
      {
        action: "save-plan",
        revision: record.revision,
        planId: original.id,
        content: { ...content, summary: "수정 원고" },
      },
      review,
    );
    expect(record.plans[0]).toEqual(original);
    expect(record.plans[1]).toMatchObject({
      version: 2,
      mode: "manual",
      content: { summary: "수정 원고" },
      confirmedAt: null,
    });
    expect(record.plans[1].id).not.toBe(original.id);
  });
  it("재분석에서 아이템 ID가 같아도 이전 전략의 계획서는 새 계획서로 취급하지 않는다", () => {
    let record = withPlan();
    const old = record.plans[0];
    record = store.saveAnalysis(
      record.id,
      record.revision,
      { ...analysis, summary: "다른 전략" },
      "assisted",
    );
    record = store.mutate(
      record.id,
      { action: "select-candidate", revision: record.revision, candidateId: "sensor" },
      review,
    );
    expect(store.isPlanCurrent(record.id, old)).toBe(false);
    expect(() =>
      store.mutate(
        record.id,
        { action: "confirm-plan", revision: record.revision, planId: old.id },
        review,
      ),
    ).toThrow("변경");
  });
  it("확인 필요 표시만 해제해도 본문에 미해결 항목이 남으면 확정하지 않는다", () => {
    const record = withPlan();
    expect(() =>
      store.mutate(
        record.id,
        { action: "confirm-plan", revision: record.revision, planId: record.plans[0].id },
        () => [
          {
            id: "c",
            severity: "warning",
            category: "confirmation",
            message: "[확인 필요]가 남았습니다.",
            action: "확인",
            sectionKey: null,
            sourceIds: [],
          },
        ],
      ),
    ).toThrow("검토");
  });
  it("공백 자료를 거절하고 추출 파일의 본문 수정도 원본 다운로드를 유지한다", () => {
    let record = store.create(profile);
    expect(() =>
      store.mutate(
        record.id,
        { action: "source", revision: record.revision, source: source({ text: "  " }) },
        review,
      ),
    ).toThrow("내용");
    const upload = source({ originalName: "원문.txt", extraction: "local" });
    record = store.addUpload(
      record.id,
      record.revision,
      upload,
      new TextEncoder().encode("original"),
    );
    record = store.mutate(
      record.id,
      {
        action: "source",
        revision: record.revision,
        source: { ...record.sources[0], text: "수정한 본문", originalName: "위조.txt" },
      },
      review,
    );
    expect(record.sources[0]).toMatchObject({
      originalName: "원문.txt",
      extraction: "manual",
      text: "수정한 본문",
    });
    expect(store.original(record.id, upload.id).buffer.toString()).toBe("original");
    record = store.mutate(
      record.id,
      { action: "delete-source", revision: record.revision, sourceId: upload.id },
      review,
    );
    expect(record.sources).toEqual([]);
    expect(existsSync(join(directory, "originals", record.id, `${upload.id}.bin`))).toBe(false);
  });
  it("선택되지 않은 아이템과 미검토 계획서는 확인할 수 없다", () => {
    const record = withPlan();
    expect(() =>
      store.mutate(
        record.id,
        { action: "select-candidate", revision: record.revision, candidateId: "forged" },
        review,
      ),
    ).toThrow("추천");
    expect(() =>
      store.mutate(
        record.id,
        { action: "confirm-plan", revision: record.revision, planId: record.plans[0].id },
        () => [
          {
            id: "e",
            severity: "error",
            category: "evidence",
            message: "근거 누락",
            action: "추가",
            sectionKey: null,
            sourceIds: [],
          },
        ],
      ),
    ).toThrow("검토");
  });
  it("수동 입력으로 다른 원본 파일 메타데이터를 만들 수 없다", () => {
    let record = store.create(profile);
    record = store.mutate(
      record.id,
      {
        action: "source",
        revision: record.revision,
        source: source({
          originalName: "secret.pdf",
          mimeType: "application/pdf",
          extraction: "ai",
        }),
      },
      review,
    );
    expect(record.sources[0]).toMatchObject({
      originalName: null,
      mimeType: null,
      extraction: "manual",
    });
    expect(() => store.original(record.id, record.sources[0].id)).toThrow("원본");
  });
  it("원본을 기업별로 격리하고 해당 기업 삭제만 수행한다", () => {
    let one = store.create(profile);
    const two = store.create({ ...profile, companyName: "다른 기업" });
    const upload = source({
      originalName: "../../밖.txt",
      mimeType: "text/plain",
      extraction: "local",
    });
    one = store.addUpload(one.id, one.revision, upload, new TextEncoder().encode("original"));
    const outside = join(directory, "keep.txt");
    writeFileSync(outside, "keep");
    expect(store.original(one.id, upload.id).buffer.toString()).toBe("original");
    expect(() => store.original(two.id, upload.id)).toThrow("원본");
    expect(() => store.get("../../keep.txt")).toThrow();
    store.delete(one.id, one.revision);
    expect(readFileSync(outside, "utf8")).toBe("keep");
    expect(store.get(two.id).id).toBe(two.id);
    expect(existsSync(join(directory, "originals", one.id, `${upload.id}.bin`))).toBe(false);
  });
  it("용량 초과는 잘라 저장하지 않고 원본·DB 모두 저장을 거절한다", () => {
    let record = store.create(profile);
    record = store.mutate(
      record.id,
      { action: "source", revision: record.revision, source: source({ text: "a".repeat(100000) }) },
      review,
    );
    const upload = source({
      text: "b".repeat(70000),
      originalName: "large.txt",
      extraction: "local",
    });
    expect(() => store.addUpload(record.id, record.revision, upload, new Uint8Array([1]))).toThrow(
      "160,000",
    );
    expect(store.get(record.id).sources).toHaveLength(1);
    expect(store.get(record.id).revision).toBe(record.revision);
    expect(existsSync(join(directory, "originals", record.id, `${upload.id}.bin`))).toBe(false);
  });
});
