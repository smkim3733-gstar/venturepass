import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { caseSchema, emptyProfile, sourceSchema } from "@/lib/studio-schema";
import { sourceIntakeItemSchema } from "@/lib/studio-source-intake-types";
import {
  sourceIntakeExternalApprovalPreviewSchema,
  sourceIntakeExternalAttemptSchema,
  sourceIntakeExternalDestinations,
  sourceIntakeExternalPurposes,
  type SourceIntakeExternalEngine,
} from "@/lib/studio-source-intake-external-types";
import { IntakeExternalApprovalReview } from "./source-intake-external-review";
import {
  intakeCanPrepareExternal,
  intakeExternalCommand,
  intakeExternalPreviewProblem,
  validateIntakeExternalPreview,
  type IntakeExternalReview,
} from "./source-intake-external-ui";
import { SourceIntakesPanel, intakeReviewDraft, intakeReviewProblem } from "./source-intakes-panel";
import {
  intakeCanRead,
  intakeCanResume,
  intakeCommand,
  intakeErrorMessage,
  intakeFileError,
  intakePendingState,
  intakeReplayIsReadOnly,
  intakeRequestAcknowledged,
  sendIntakeRequest,
} from "./source-intakes-ui";

const id = (number: number) => `${String(number).padStart(8, "0")}-1111-4111-8111-111111111111`;
const now = "2026-09-25T00:00:00.000Z",
  sha = "a".repeat(64);
function fixture(engine: SourceIntakeExternalEngine = "ai-document") {
  const originalName = engine === "ai-document" ? "synthetic.pdf" : "synthetic.wav",
    mimeType = engine === "ai-document" ? "application/pdf" : "audio/wav";
  const source = sourceSchema.parse({
    id: id(3),
    name: "합성 원본",
    kind: "other",
    text: "",
    originalName,
    mimeType,
    extraction: "pending",
    warnings: [],
    createdAt: now,
    updatedAt: now,
  });
  const item = sourceIntakeItemSchema.parse({
    id: id(2),
    batchId: id(4),
    clientFileId: id(5),
    sourceId: source.id,
    version: 2,
    declared: { originalName, kind: "other", sizeBytes: 100 },
    original: { originalName, mimeType, sizeBytes: 100, sha256: sha, sourceUpdatedAt: now },
    phase: "original_stored",
    attempts: [],
    result: null,
    previousResults: [],
    adoption: null,
    requests: [],
    createdAt: now,
    updatedAt: now,
    code: null,
  });
  const company = caseSchema.parse({
    id: id(1),
    profile: { ...emptyProfile(), companyName: "합성 외부 판독 회사" },
    sources: [source],
    sourceIntakes: [item],
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: "preparing",
    revision: 3,
    createdAt: now,
    updatedAt: now,
  });
  const preview = sourceIntakeExternalApprovalPreviewSchema.parse({
    companyRevision: 3,
    approval: {
      version: 1,
      caseId: company.id,
      itemId: item.id,
      itemVersion: item.version,
      sourceId: source.id,
      sourceUpdatedAt: now,
      originalSha256: sha,
      originalName,
      mimeType,
      sizeBytes: 100,
      engine,
      provider: "openai",
      destination: sourceIntakeExternalDestinations[engine],
      model: engine === "ai-document" ? "synthetic-document-model" : "synthetic-transcribe-model",
      purpose: sourceIntakeExternalPurposes[engine],
    },
    requiresDuplicateAcknowledgement: false,
    externalTransmissionPerformed: false,
  });
  const review: IntakeExternalReview = {
    preview,
    clientRequestId: id(6),
    approved: false,
    acknowledgePossibleDuplicate: false,
  };
  return { company, item: company.sourceIntakes[0], source: company.sources[0], preview, review };
}
function attempt(
  review: IntakeExternalReview,
  status: "running" | "unknown" | "completed" = "unknown",
) {
  return sourceIntakeExternalAttemptSchema.parse({
    id: id(7),
    engine: review.preview.approval.engine,
    startedAt: now,
    finishedAt: status === "running" ? null : now,
    originalSha256: sha,
    sourceUpdatedAt: now,
    externalRequestStarted: true,
    externalApproval: review.preview.approval,
    approvalSha256: "b".repeat(64),
    clientRequestId: review.clientRequestId,
    acknowledgePossibleDuplicate: review.acknowledgePossibleDuplicate,
    status,
    code: status === "unknown" ? "INTAKE_EXTERNAL_RESULT_UNKNOWN" : null,
    resultId: status === "completed" ? id(8) : null,
  });
}
function unknownFixture() {
  const state = fixture();
  state.item.attempts.push(attempt(state.review));
  state.item.phase = "external_result_unknown";
  state.item.version++;
  state.preview.approval.itemVersion = state.item.version;
  state.preview.requiresDuplicateAcknowledgement = true;
  state.review.clientRequestId = id(16);
  return state;
}
afterEach(() => vi.unstubAllGlobals());

describe("정확 원본의 외부 전송 승인 UI 계약", () => {
  it("서버 미리보기와 현재 자료가 정확히 같아야 채택하며 기본동의는 없다", () => {
    const state = fixture();
    expect(
      validateIntakeExternalPreview(state.preview, state.company, state.item, "ai-document"),
    ).toEqual(state.preview);
    expect(intakeExternalCommand(state.company, state.review)).toBeNull();
    state.review.approved = true;
    expect(intakeExternalCommand(state.company, state.review)).toMatchObject({
      action: "run-external",
      clientRequestId: id(6),
      approved: true,
      approval: state.preview.approval,
    });
  });
  it.each([
    "case",
    "revision",
    "item",
    "item-version",
    "source",
    "source-time",
    "sha",
    "name",
    "mime",
    "size",
    "engine",
    "destination",
    "purpose",
    "provider",
    "extra",
    "transmitted",
  ])("승인 미리보기 %s 불일치를 버린다", (change) => {
    const state = fixture(),
      raw = structuredClone(state.preview) as unknown as Record<string, unknown>,
      approval = raw.approval as Record<string, unknown>;
    if (change === "case") approval.caseId = id(99);
    if (change === "revision") raw.companyRevision = 2;
    if (change === "item") approval.itemId = id(99);
    if (change === "item-version") approval.itemVersion = 3;
    if (change === "source") approval.sourceId = id(99);
    if (change === "source-time") approval.sourceUpdatedAt = "2026-09-26T00:00:00.000Z";
    if (change === "sha") approval.originalSha256 = "f".repeat(64);
    if (change === "name") approval.originalName = "different.pdf";
    if (change === "mime") approval.mimeType = "image/png";
    if (change === "size") approval.sizeBytes = 200;
    if (change === "engine") approval.engine = "ai-transcription";
    if (change === "destination") approval.destination = "https://example.invalid/upload";
    if (change === "purpose") approval.purpose = "audio-transcription";
    if (change === "provider") approval.provider = "another-provider";
    if (change === "extra") approval.apiKey = "synthetic-secret";
    if (change === "transmitted") raw.externalTransmissionPerformed = true;
    expect(validateIntakeExternalPreview(raw, state.company, state.item, "ai-document")).toBeNull();
  });
  it.each(["company-revision", "source-text", "source-extraction", "phase", "original", "attempt"])(
    "검토 이후 %s 변경은 이전동의 재사용을 막는다",
    (change) => {
      const state = fixture();
      state.review.approved = true;
      if (change === "company-revision") state.company.revision++;
      if (change === "source-text") state.source.text = "등록된 본문";
      if (change === "source-extraction") state.source.extraction = "manual";
      if (change === "phase") state.item.phase = "requesting_external";
      if (change === "original") state.item.original!.sha256 = "f".repeat(64);
      if (change === "attempt") state.item.attempts.push(attempt(state.review));
      expect(intakeExternalPreviewProblem(state.company, state.preview)).not.toBe("");
      expect(intakeExternalCommand(state.company, state.review)).toBeNull();
    },
  );
  it("이전 미확인 요청 뒤 재전송은 별도 중복 비용 확인도 필요하다", () => {
    const state = unknownFixture();
    state.review.approved = true;
    expect(intakeExternalCommand(state.company, state.review)).toBeNull();
    state.review.acknowledgePossibleDuplicate = true;
    expect(intakeExternalCommand(state.company, state.review)).toMatchObject({
      clientRequestId: id(16),
      acknowledgePossibleDuplicate: true,
    });
  });
  it("결과/채택된 항목은 외부미리보기도 자동재전송도 허용하지 않는다", () => {
    const state = fixture();
    state.item.result = {
      id: id(8),
      attemptId: id(7),
      engine: "ai-document",
      generatedAt: now,
      originalSha256: sha,
      sourceUpdatedAt: now,
      textSha256: sha,
      content: { kind: "plain", text: "저장된 미검토 판독문" },
      warnings: [],
      reviewStatus: "unreviewed",
      discardedAt: null,
    };
    expect(intakeCanPrepareExternal(state.item)).toBe(false);
    state.item.result = null;
    state.item.phase = "adopted";
    expect(intakeCanPrepareExternal(state.item)).toBe(false);
  });
  it("12MiB 내 지원 음성은 원본접수만 허용되며 로컬문서로 처리하지 않는다", () => {
    for (const name of ["sample.mp3", "sample.m4a", "sample.wav", "sample.webm"])
      expect(intakeFileError({ name, size: 100 })).toBe("");
    const state = fixture("ai-transcription");
    expect(
      validateIntakeExternalPreview(state.preview, state.company, state.item, "ai-transcription"),
    ).not.toBeNull();
    expect(intakeExternalCommand(state.company, state.review)).toBeNull();
  });
});

describe("외부 요청의 정확한 저장 확인과 재전송 방지", () => {
  function sent() {
    const state = fixture();
    state.review.approved = true;
    const command = intakeExternalCommand(state.company, state.review)!;
    state.item.version++;
    state.item.phase = "external_result_unknown";
    state.item.attempts.push(attempt(state.review));
    state.item.requests.push({
      clientRequestId: command.clientRequestId,
      inputDigest: "c".repeat(64),
      action: "run-external",
    });
    state.company.revision++;
    return { ...state, request: intakeCommand(command) };
  }
  it("외부 pending은 동일nonce라도 POST replay를 하지 않고 GET만 확인한다", () => {
    const state = sent();
    expect(intakeReplayIsReadOnly(state.request)).toBe(true);
    expect(
      intakeReplayIsReadOnly(
        intakeCommand({
          action: "resume",
          revision: 3,
          clientRequestId: id(13),
          itemId: state.item.id,
          expectedItemVersion: state.item.version,
        }),
      ),
    ).toBe(false);
  });
  it("정확한 승인·시도의 durable nonce는 미확인 결과로 보존해 ACK한다", () => {
    const state = sent();
    expect(intakeRequestAcknowledged(state.company, state.company.id, state.request)).toBe(true);
    expect(intakePendingState(state.company, state.company.id, state.request, false, [])).toBe(
      "acknowledged",
    );
    expect(state.item.phase).toBe("external_result_unknown");
  });
  it.each([
    "attempt-missing",
    "attempt-duplicate",
    "nonce",
    "approval",
    "engine",
    "duplicate-ack",
    "item-version",
  ])("다른 외부 시도 %s는 ACK로 인정하지 않는다", (change) => {
    const state = sent(),
      saved = state.item.attempts[0];
    if (!saved.externalRequestStarted) throw new Error("fixture");
    if (change === "attempt-missing") state.item.attempts = [];
    if (change === "attempt-duplicate") state.item.attempts.push(saved);
    if (change === "nonce") saved.clientRequestId = id(90);
    if (change === "approval") saved.externalApproval.model = "different-model";
    if (change === "engine") saved.engine = "ai-transcription";
    if (change === "duplicate-ack") saved.acknowledgePossibleDuplicate = true;
    if (change === "item-version") state.item.version--;
    expect(intakeRequestAcknowledged(state.company, state.company.id, state.request)).toBe(false);
  });
  it("외부 네트워크 결과 미확인+GET 영수증 부재는 새승인 가능으로 자동 해제하지 않는다", () => {
    const state = sent();
    state.item.requests = [];
    state.item.attempts = [];
    expect(intakePendingState(state.company, state.company.id, state.request, false, [])).toBe(
      "unknown",
    );
    expect(
      intakePendingState(state.company, state.company.id, state.request, true, [state.item.id]),
    ).toBe("unknown");
  });
  it("requesting_external만 재개 정리하며 unknown에서는 새승인만 준비한다", () => {
    const state = fixture();
    state.item.phase = "requesting_external";
    expect(intakeCanResume(state.item)).toBe(true);
    expect(intakeCanPrepareExternal(state.item)).toBe(false);
    expect(intakeCanRead(state.item)).toBe(false);
    state.item.phase = "external_result_unknown";
    expect(intakeCanResume(state.item)).toBe(false);
    expect(intakeCanPrepareExternal(state.item)).toBe(true);
  });
  it("외부 명시 명령은 정확한 승인 JSON으로 한 번만 API에 요청한다", async () => {
    const state = fixture();
    state.review.approved = true;
    const command = intakeExternalCommand(state.company, state.review)!,
      fetcher = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await sendIntakeRequest("/synthetic/source-intakes", intakeCommand(command));
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe("/synthetic/source-intakes");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual(command);
    expect(options.body).not.toContain("apiKey");
  });
  it("외부 판독문도 수동 교정·확인 전에는 본문 채택 불가다", () => {
    const state = fixture();
    state.item.phase = "awaiting_review";
    state.item.result = {
      id: id(8),
      attemptId: id(7),
      engine: "ai-document",
      generatedAt: now,
      originalSha256: sha,
      sourceUpdatedAt: now,
      textSha256: sha,
      content: { kind: "plain", text: "교정 전 판독문" },
      warnings: [],
      reviewStatus: "unreviewed",
      discardedAt: null,
    };
    const draft = intakeReviewDraft(state.company, state.item)!;
    expect(draft.reviewed).toBe(false);
    expect(intakeReviewProblem(state.company, draft)).toContain("확인 항목");
    expect(state.source.text).toBe("");
    expect(state.source.extraction).toBe("pending");
  });
});

describe("외부 승인과 미확인 결과 UI", () => {
  const render = (state: ReturnType<typeof fixture>, disabled = false) =>
    renderToStaticMarkup(
      createElement(IntakeExternalApprovalReview, {
        company: state.company,
        review: state.review,
        disabled,
        onChange: vi.fn(),
        onExecute: vi.fn(),
        onClose: vi.fn(),
      }),
    );
  it("원본·크기·형식·SHA·모델·목적지를 표시하고 동의는 기본 미선택이다", () => {
    const state = fixture(),
      html = render(state);
    for (const value of [
      state.preview.approval.originalName,
      state.preview.approval.mimeType!,
      sha,
      state.preview.approval.model,
      state.preview.approval.destination,
      "100바이트",
      "openai",
    ])
      expect(html).toContain(value);
    expect(html).not.toContain('checked=""');
    expect(html).toMatch(/disabled=""[^>]*>승인한 원본 외부 전송 1회 실행/);
    expect(html).toContain("이 미리보기는 전송하지 않으며");
  });
  it("음성 결과에 실제 시간정보가 없으면 임의 타임스탬프를 붙이지 않는다", () => {
    expect(render(fixture("ai-transcription"))).toContain(
      "실제 시간 정보가 없으면 타임스탬프를 만들어 넣지 않습니다",
    );
  });
  it("새 전송 검토는 미확인 비용·중복동의를 별도로 보여준다", () => {
    const state = unknownFixture(),
      html = render(state);
    expect((html.match(/type="checkbox"/g) ?? []).length).toBe(2);
    expect(html).toContain("이전 외부 요청이 이미 처리됐을 수 있습니다");
    expect(html).toContain("중복 처리·중복 비용");
    expect(html).not.toContain('checked=""');
  });
  it("회사 revision이 바뀌면 이전 체크 표시와 실행 가능 상태를 폐기한다", () => {
    const state = fixture();
    state.review.approved = true;
    state.company.revision++;
    const html = render(state);
    expect(html).not.toContain('checked=""');
    expect(html).toContain("기업 버전이 바뀌었습니다");
    expect(html).toMatch(/disabled=""[^>]*>승인한 원본 외부 전송 1회 실행/);
  });
  it("처리중/다른편집에서는 승인영역을 비활성하고 외부 fetch를 하지 않는다", () => {
    const state = fixture();
    state.review.approved = true;
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const html = render(state, true);
    expect(html).toContain('<fieldset disabled=""');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("영속 unknown 시도는 실패·미전송으로 축약하지 않으며 정확한 과거 승인을 표시한다", () => {
    const state = unknownFixture();
    state.item.code = "INTAKE_EXTERNAL_RESULT_UNKNOWN";
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const html = renderToStaticMarkup(
      createElement(SourceIntakesPanel, {
        company: state.company,
        busy: false,
        onBusyChange: vi.fn(),
        onCompany: vi.fn(),
        onDirtyChange: vi.fn(),
      }),
    );
    expect(html).toContain("외부 처리 결과 미확인 · 미전송 증명 아님");
    expect(html).toContain("외부 요청은 이미 처리·과금됐을 수 있습니다");
    expect(html).toContain(state.preview.approval.model);
    expect(html).toContain("OpenAI 문서 판독 전송 검토");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    "INTAKE_EXTERNAL_RESULT_UNKNOWN",
    "INTAKE_EXTERNAL_RECOVERY_REQUIRED",
    "INTAKE_EXTERNAL_DUPLICATE_ACK_REQUIRED",
    "INTAKE_EXTERNAL_APPROVAL_STALE",
    "INTAKE_AI_NOT_CONFIGURED",
  ])("%s 오류는 내부코드 대신 행동·상태를 설명한다", (code) => {
    const message = intakeErrorMessage(code);
    expect(message).not.toContain(code);
    expect(message).not.toBe(intakeErrorMessage("UNMAPPED_ERROR"));
  });
});
