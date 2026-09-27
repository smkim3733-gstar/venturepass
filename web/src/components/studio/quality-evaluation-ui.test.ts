import { randomUUID, webcrypto } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPlanQualityEvaluationManifest,
  createUnevaluatedPlanQualityRecords,
  planQualityEvaluationDigest,
  summarizePlanQualityEvaluations,
} from "@/lib/studio-plan-quality-evaluation";
import { createPlanQualityFixtures } from "@/lib/studio-plan-quality-fixtures";
import { planQualitySummarySchema } from "@/lib/studio-plan-quality-summary-schema";
import {
  planQualityRequestDigestInput,
  planQualityRunSummarySchema,
  planQualityRunSnapshotSchema,
  planQualityDownloadName,
  type PlanQualityReceipt,
} from "@/lib/studio-plan-quality-store-types";
import {
  emptyQualityEvaluation,
  qualityCatalog,
  qualityArchiveDownload,
  qualityCommittedSnapshot,
  qualityDraftValue,
  qualityFixture,
  qualityPost,
  qualityRecovery,
  qualitySnapshot,
  qualityStatusLabels,
  qualityRecordText,
  QualityWriteRejection,
  type QualityPending,
  type QualityRun,
} from "./quality-evaluation-ui";
import { QualityEvaluationWorkspace } from "./quality-evaluation-workspace";

const now = "2026-09-26T02:00:00.000Z";
function fixture() {
  const manifest = createPlanQualityEvaluationManifest();
  const manifestDigest = planQualityEvaluationDigest(manifest);
  const records = createUnevaluatedPlanQualityRecords();
  const pending: Extract<QualityPending, { kind: "create" }> = {
    kind: "create",
    request: { clientRequestId: randomUUID(), title: "합성 UI 회차", manifestDigest },
  };
  const receipt: PlanQualityReceipt = {
    kind: "create",
    runId: randomUUID(),
    revision: 0,
    clientRequestId: pending.request.clientRequestId,
    inputDigest: planQualityEvaluationDigest(
      planQualityRequestDigestInput("create", pending.request),
    ),
  };
  const run: QualityRun = {
    id: receipt.runId,
    title: pending.request.title,
    revision: 0,
    currentRevision: 0,
    clientRequestId: pending.request.clientRequestId,
    manifestDigest,
    manifest,
    manifestCurrent: true,
    createdAt: now,
    updatedAt: now,
    records,
    recordSource: "user-supplied-records",
    history: [
      { ...receipt, fixtureId: null, fixtureRevision: 0, recordDigest: null, recordedAt: now },
    ],
    summary: planQualitySummarySchema.parse(summarizePlanQualityEvaluations(records)),
  };
  const summary = planQualityRunSummarySchema.strip().parse(run);
  return {
    manifest,
    pending,
    receipt,
    run,
    catalog: { manifestDigest, manifest, runs: [summary] },
  };
}

const fetchGuard = vi.fn(() => {
  throw new Error("합성 UI 검증에서 외부 요청 금지");
});
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  fetchGuard.mockClear();
  vi.stubGlobal("fetch", fetchGuard);
});
afterEach(() => vi.unstubAllGlobals());

describe("품질평가 도구 입력·응답 연결", () => {
  it("선택한 50사례 템플릿은 평가와 실행을 채우지 않는다", () => {
    const { manifest } = fixture();
    for (const entry of manifest) {
      const template = emptyQualityEvaluation(entry);
      expect(template).toMatchObject({
        fixtureId: entry.fixtureId,
        answerKey: null,
        execution: null,
        humanReviews: [],
        resolution: null,
      });
      expect(qualityDraftValue(qualityRecordText(template), entry, 10000)).toEqual(template);
    }
    expect(fetchGuard).not.toHaveBeenCalled();
  });

  it.each([
    "fixtureId",
    "sourceDigest",
    "candidateDigest",
    "inputPlanDigest",
    "rubricDigest",
  ] as const)("%s가 다른 초안을 현재 사례에 저장하지 않는다", (key) => {
    const { manifest } = fixture();
    const template = emptyQualityEvaluation(manifest[0]);
    const raw = { ...template, [key]: key === "fixtureId" ? "other-case" : "b".repeat(64) };
    expect(() => qualityDraftValue(qualityRecordText(raw), manifest[0], 10000)).toThrow(
      "선택한 합성 사례",
    );
    expect(template[key]).toBe(manifest[0][key]);
  });

  it("깨진 JSON과 UTF-8 바이트 초과를 감지하며 원본 입력을 변환하지 않는다", () => {
    const { manifest } = fixture();
    const raw = "{\n 합성 초안";
    expect(() => qualityDraftValue(raw, manifest[0], 10000)).toThrow("JSON 형식");
    expect(raw).toBe("{\n 합성 초안");
    const text = qualityRecordText(emptyQualityEvaluation(manifest[0]));
    expect(() => qualityDraftValue(text, manifest[0], 5)).toThrow("크기");
    expect(() => qualityDraftValue("[]", manifest[0], 10000)).toThrow("JSON 객체");
  });

  it("정답표를 정규화해도 기존 실행·검토 연결값을 고치지 않는다", () => {
    const { manifest } = fixture();
    const template = emptyQualityEvaluation(manifest[0]);
    template.answerKey = {
      authorId: "synthetic-reviewer",
      factsAndIssues: [" 합성 사실 검토 "],
      sufficientForCompleteDraft: false,
      mustBlockSubmission: true,
      rationale: " 자료 필요 ",
    };
    const raw = qualityRecordText(template);
    const parsed = qualityDraftValue(raw, manifest[0], 10000);
    expect(parsed.answerKey!.rationale).toBe("자료 필요");
    expect(parsed.execution).toBeNull();
    expect(parsed.humanReviews).toEqual([]);
    expect(raw).toContain(" 합성 사실 검토 ");
  });

  it("회차와 사례가 중복된 목록을 거부한다", () => {
    const { catalog } = fixture();
    expect(qualityCatalog(catalog).runs).toHaveLength(1);
    expect(() =>
      qualityCatalog({ ...catalog, runs: [catalog.runs[0], catalog.runs[0]] }),
    ).toThrow();
    expect(() =>
      qualityCatalog({
        ...catalog,
        manifest: catalog.manifest.map((entry) => ({
          ...entry,
          fixtureId: catalog.manifest[0].fixtureId,
        })),
      }),
    ).toThrow();
  });

  it("다른 회차·잘못된 revision·사례 연결을 성공으로 채택하지 않는다", () => {
    const { run } = fixture();
    expect(qualitySnapshot(run, { id: run.id, revision: 0 }).revision).toBe(0);
    expect(() => qualitySnapshot(run, { id: randomUUID() })).toThrow();
    expect(() => qualitySnapshot(run, { id: run.id, revision: 1 })).toThrow();
    const corrupt = structuredClone(run);
    corrupt.records[0].sourceDigest = "b".repeat(64);
    expect(() => qualitySnapshot(corrupt, { id: run.id })).toThrow();
  });

  it("과거 묶음의 집계가 없어도 미평가 0건 등으로 만들어내지 않는다", () => {
    const { run } = fixture();
    const historic = { ...run, currentRevision: 2, manifestCurrent: false, summary: null };
    expect(qualitySnapshot(historic, { id: run.id, revision: 0 }).summary).toBeNull();
  });

  it("50사례가 아닌 집계나 원고와 다른 사례 목록을 거부한다", () => {
    const { run } = fixture();
    const incorrect = structuredClone(run);
    incorrect.summary!.counts.unevaluated = 0;
    expect(() => qualitySnapshot(incorrect, { id: run.id })).toThrow();
    incorrect.summary = structuredClone(run.summary);
    incorrect.summary!.cases[0].fixtureId = "foreign-case";
    expect(() => qualitySnapshot(incorrect, { id: run.id })).toThrow();
  });

  it("정확한 nonce·정규 요청 digest의 복구만 인정하고 조회가 없으면 대기를 유지한다", async () => {
    const { pending, receipt } = fixture();
    expect(await qualityRecovery({ state: "committed", receipt }, pending)).toEqual({
      state: "committed",
      receipt,
    });
    expect(await qualityRecovery({ state: "not-observed" }, pending)).toEqual({
      state: "not-observed",
    });
    await expect(
      qualityRecovery(
        { state: "committed", receipt: { ...receipt, clientRequestId: randomUUID() } },
        pending,
      ),
    ).rejects.toThrow();
    await expect(
      qualityRecovery(
        { state: "committed", receipt: { ...receipt, inputDigest: "b".repeat(64) } },
        pending,
      ),
    ).rejects.toThrow();
    expect(fetchGuard).not.toHaveBeenCalled();
  });

  it("생성 응답의 초기 기록을 실제 평가로 바꾸어 채택하지 않는다", () => {
    const { run, pending, receipt } = fixture();
    expect(qualityCommittedSnapshot(run, pending, receipt).revision).toBe(0);
    const corrupt = structuredClone(run);
    corrupt.records[0].answerKey = {
      authorId: "someone",
      factsAndIssues: ["합성 주장"],
      sufficientForCompleteDraft: true,
      mustBlockSubmission: false,
      rationale: "합성 근거",
    };
    expect(() => qualityCommittedSnapshot(corrupt, pending, receipt)).toThrow();
  });

  it("저장한 사례 JSON과 이전 request revision을 정확히 대조한다", async () => {
    const { run } = fixture();
    const record = structuredClone(run.records[0]);
    record.answerKey = {
      authorId: "synthetic-reviewer",
      factsAndIssues: ["합성 사실 검토"],
      sufficientForCompleteDraft: false,
      mustBlockSubmission: true,
      rationale: "자료 필요",
    };
    const pending: Extract<QualityPending, { kind: "record" }> = {
      kind: "record",
      runId: run.id,
      manifestDigest: run.manifestDigest,
      request: { revision: 0, clientRequestId: randomUUID(), record },
    };
    const receipt: PlanQualityReceipt = {
      kind: "record",
      runId: run.id,
      revision: 1,
      clientRequestId: pending.request.clientRequestId,
      inputDigest: planQualityEvaluationDigest(
        planQualityRequestDigestInput("record", pending.request, run.id),
      ),
    };
    const saved = structuredClone(run);
    saved.revision = saved.currentRevision = 1;
    saved.records[0] = record;
    saved.summary = planQualitySummarySchema.parse(summarizePlanQualityEvaluations(saved.records));
    saved.history.push({
      ...receipt,
      fixtureId: record.fixtureId,
      fixtureRevision: 1,
      recordDigest: planQualityEvaluationDigest(record),
      recordedAt: now,
    });
    await expect(qualityRecovery({ state: "committed", receipt }, pending)).resolves.toMatchObject({
      state: "committed",
    });
    expect(qualityCommittedSnapshot(saved, pending, receipt).records[0]).toEqual(record);
    saved.records[0] = run.records[0];
    expect(() => qualityCommittedSnapshot(saved, pending, receipt)).toThrow();
  });

  it("사례 입력은 고정 manifest의 원문·후보·원고·rubric digest와 일치해야 한다", async () => {
    const { manifest } = fixture();
    const original = createPlanQualityFixtures()[0];
    const raw = {
      fixture: {
        id: original.id,
        label: original.label,
        synthetic: true,
        profile: original.company.profile,
        sources: original.company.sources,
        candidate: original.candidate,
        plan: original.plan,
        semanticRubric: original.semanticRubric,
        deterministicExpectation: original.deterministicExpectation,
      },
      template: emptyQualityEvaluation(manifest[0]),
    };
    await expect(qualityFixture(raw, manifest[0])).resolves.toMatchObject({
      template: raw.template,
    });
    raw.fixture.profile.technologySummary += "변경";
    await expect(qualityFixture(raw, manifest[0])).rejects.toThrow();
  });

  it("서버가 accepted:false로 확정 거절한 요청만 대기에서 해제한다", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ accepted: false, error: "최신 버전 필요" }), { status: 409 }),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(qualityPost("/api/studio/quality/runs", {})).rejects.toBeInstanceOf(
      QualityWriteRejection,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValue(
      new Response(JSON.stringify({ error: "결과 불명확" }), { status: 409 }),
    );
    try {
      await qualityPost("/api/studio/quality/runs", {});
    } catch (error) {
      expect(error).not.toBeInstanceOf(QualityWriteRejection);
    }
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("과거 revision 다운로드는 live 집계 없이 원래 JSON 바이트를 보존한다", async () => {
    const { run } = fixture();
    const archive = {
      ...planQualityRunSnapshotSchema
        .omit({ currentRevision: true, manifestCurrent: true, summary: true })
        .strip()
        .parse(run),
      schemaVersion: 1,
      notice:
        "사용자가 입력한 평가 기록입니다. 실제 실행·비용·독립 평가 완료를 자동으로 증명하지 않습니다.",
    };
    const body = JSON.stringify(archive, null, 2) + "\n";
    const filename = planQualityDownloadName(run.id, 0);
    const response = new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="download"; filename*=UTF-8''${filename}`,
      },
    });
    const downloaded = await qualityArchiveDownload(response, { id: run.id, revision: 0 });
    expect(downloaded.filename).toBe(filename);
    expect(await downloaded.blob.text()).toBe(body);
    expect(JSON.parse(await downloaded.blob.text())).not.toHaveProperty("summary");
    expect(JSON.parse(await downloaded.blob.text())).not.toHaveProperty("currentRevision");
  });

  it("다른 revision의 다운로드와 파일명 바꿔치기를 거부한다", async () => {
    const { run } = fixture();
    const filename = planQualityDownloadName(run.id, 0);
    const archive = {
      ...planQualityRunSnapshotSchema
        .omit({ currentRevision: true, manifestCurrent: true, summary: true })
        .strip()
        .parse(run),
      schemaVersion: 1,
      notice:
        "사용자가 입력한 평가 기록입니다. 실제 실행·비용·독립 평가 완료를 자동으로 증명하지 않습니다.",
    };
    const body = JSON.stringify(archive);
    await expect(
      qualityArchiveDownload(
        new Response(body, {
          headers: {
            "content-type": "application/json",
            "content-disposition": `attachment; filename="${filename}"`,
          },
        }),
        { id: run.id, revision: 1 },
      ),
    ).rejects.toThrow();
    await expect(
      qualityArchiveDownload(
        new Response(body, {
          headers: {
            "content-type": "application/json",
            "content-disposition": 'attachment; filename="other.json"',
          },
        }),
        { id: run.id, revision: 0 },
      ),
    ).rejects.toThrow();
  });

  it("첫 화면 SSR은 생성·AI·사람 검토를 실행하지 않고 기록 도구 범위를 안내한다", () => {
    const html = renderToStaticMarkup(createElement(QualityEvaluationWorkspace));
    expect(html).toContain("합성 자료 품질 검증");
    expect(html).toContain("이 도구는 AI를 실행하지 않으며");
    expect(html).toContain("실제 수행 여부를 확인하지 않습니다");
    expect(html).toContain("합성 50사례 회차 만들기");
    expect(qualityStatusLabels.passed).toBe("입력 기록의 점검 조건 일치");
    expect(fetchGuard).not.toHaveBeenCalled();
  });
});
