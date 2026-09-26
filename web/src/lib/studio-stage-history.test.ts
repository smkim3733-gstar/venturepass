import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StudioStore } from "./studio-storage";
import { emptyProfile, mutationSchema } from "./studio-schema";

describe("단계 변경 이력 보존", () => {
  let directory: string;
  let store: StudioStore;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "venture-stage-test-"));
    store = new StudioStore(directory);
  });
  afterEach(() => {
    store.close();
    const boundary = relative(resolve(tmpdir()), resolve(directory));
    if (!boundary.startsWith("venture-stage-test-") || boundary.includes(".."))
      throw new Error("Unsafe cleanup");
    rmSync(directory, { recursive: true, force: true });
  });
  const review = () => [];
  const create = () => store.create({ ...emptyProfile(), companyName: "단계 이력 시험기업" });
  function replaceBody(id: string, body: unknown) {
    const db = new DatabaseSync(join(directory, "studio.sqlite"));
    try {
      db.prepare("UPDATE studio_cases SET body = ? WHERE id = ?").run(JSON.stringify(body), id);
    } finally {
      db.close();
    }
  }
  it("수동 기록의 발생일·메모·역방향 정정을 이전 이력과 함께 재시작 후 복원한다", () => {
    let company = create();
    const other = create();
    company = store.mutate(
      company.id,
      {
        action: "stage",
        revision: company.revision,
        stage: "submitted",
        occurredOn: "2026-09-20",
        note: "담당자가 통보 원문을 확인함. 자동 검증 아님.",
      },
      review,
    );
    const first = company.stageHistory[0];
    expect(first).toMatchObject({
      from: "preparing",
      to: "submitted",
      origin: "manual",
      occurredOn: "2026-09-20",
      note: "담당자가 통보 원문을 확인함. 자동 검증 아님.",
    });
    expect(Number.isNaN(Date.parse(first.recordedAt))).toBe(false);
    company = store.mutate(
      company.id,
      {
        action: "stage",
        revision: company.revision,
        stage: "drafting",
        note: "잘못 기록한 단계 정정",
      },
      review,
    );
    expect(company.stageHistory[0]).toEqual(first);
    expect(company.stageHistory[1]).toMatchObject({
      from: "submitted",
      to: "drafting",
      origin: "manual",
      note: "잘못 기록한 단계 정정",
    });
    expect(store.get(other.id).stageHistory).toEqual([]);
    store.close();
    store = new StudioStore(directory);
    expect(store.get(company.id)).toEqual(company);
  });
  it("기존 회사의 과거 이력은 빈 목록으로 읽고 이후 변경부터 추가한다", () => {
    const company = create();
    const legacy = { ...company } as Record<string, unknown>;
    delete legacy.stageHistory;
    replaceBody(company.id, legacy);
    const restored = store.get(company.id);
    expect(restored.stageHistory).toEqual([]);
    expect(restored.revision).toBe(company.revision);
    const saved = store.mutate(
      company.id,
      { action: "stage", revision: company.revision, stage: "drafting" },
      review,
    );
    expect(saved.stageHistory).toHaveLength(1);
    expect(saved.stageHistory[0].origin).toBe("manual");
  });
  it("오래된 변경 요청과 동일 단계 재저장은 기존 기록을 복제하거나 덮어쓰지 않는다", () => {
    const original = create();
    const saved = store.mutate(
      original.id,
      { action: "stage", revision: 0, stage: "drafting" },
      review,
    );
    expect(() =>
      store.mutate(saved.id, { action: "stage", revision: 0, stage: "confirmed" }, review),
    ).toThrow();
    const same = store.mutate(
      saved.id,
      { action: "stage", revision: saved.revision, stage: "drafting" },
      review,
    );
    expect(same.stageHistory).toEqual(saved.stageHistory);
    expect(same.stage).toBe("drafting");
  });
  it.each([{ occurredOn: "2026-02-30" }, { note: "x".repeat(2001) }])(
    "유효하지 않은 기록 입력은 단계와 이력을 함께 롤백한다: %j",
    (invalid) => {
      const company = create();
      expect(() =>
        store.mutate(
          company.id,
          { action: "stage", revision: 0, stage: "submitted", ...invalid },
          review,
        ),
      ).toThrow();
      expect(store.get(company.id)).toEqual(company);
    },
  );
  it("이력 한도에 도달해도 이전 기록을 잘라내거나 단계만 바꾸지 않는다", () => {
    const company = create();
    company.stageHistory = Array.from({ length: 500 }, () => ({
      id: randomUUID(),
      from: "preparing",
      to: "drafting",
      origin: "manual",
      recordedAt: "2026-09-25T00:00:00.000Z",
      occurredOn: "",
      note: "보존할 기록",
    }));
    replaceBody(company.id, company);
    expect(() =>
      store.mutate(company.id, { action: "stage", revision: 0, stage: "submitted" }, review),
    ).toThrow("보관 한도");
    expect(store.get(company.id)).toEqual(company);
  });
  it.each([
    { origin: "agency-verified" },
    { stageHistory: [] },
    { recordedAt: "2020-01-01T00:00:00.000Z" },
  ])("요청자가 서버 생성 이력이나 검증 출처를 주입할 수 없다: %j", (forged) => {
    expect(
      mutationSchema.safeParse({ action: "stage", revision: 0, stage: "submitted", ...forged })
        .success,
    ).toBe(false);
  });
});
