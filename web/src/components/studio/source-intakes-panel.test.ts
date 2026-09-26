import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  caseSchema,
  emptyProfile,
  type StudioCase,
  type SourceDocument,
} from "@/lib/studio-schema";
import { sourceIntakeItemSchema, type SourceIntakeItem } from "@/lib/studio-source-intake-types";
import {
  IntakeResultReview,
  SourceIntakesPanel,
  intakeReviewDraft,
  intakeReviewProblem,
} from "./source-intakes-panel";
import {
  IntakeHttpError,
  intakeBatchError,
  intakeCanRead,
  intakeCanResume,
  intakeCanUpload,
  intakeCanCancel,
  intakeCommand,
  intakeErrorMessage,
  intakeFileError,
  intakePendingState,
  intakeRequestAcknowledged,
  sendIntakeRequest,
  validateIntakeResponse,
  validateIntakeStatus,
  type IntakePending,
} from "./source-intakes-ui";

const id = (value: number) => `${String(value).padStart(8, "0")}-1111-4111-8111-111111111111`;
const now = "2026-09-25T00:00:00.000Z",
  hash = "a".repeat(64),
  nonce = id(6);
function item(changes: Partial<SourceIntakeItem> = {}): SourceIntakeItem {
  return sourceIntakeItemSchema.parse({
    id: id(2),
    batchId: id(3),
    clientFileId: id(4),
    sourceId: id(5),
    version: 1,
    declared: { originalName: "sample.txt", kind: "technology", sizeBytes: 3 },
    original: null,
    phase: "awaiting_original",
    attempts: [],
    result: null,
    previousResults: [],
    adoption: null,
    requests: [],
    createdAt: now,
    updatedAt: now,
    code: null,
    ...changes,
  });
}
function company(changes: Partial<StudioCase> = {}): StudioCase {
  return caseSchema.parse({
    id: id(1),
    profile: { ...emptyProfile(), companyName: "가상 접수 기업" },
    sources: [],
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: "preparing",
    revision: 2,
    createdAt: now,
    updatedAt: now,
    ...changes,
  });
}
function source(changes: Partial<SourceDocument> = {}): SourceDocument {
  return {
    id: id(5),
    name: "가상 원본",
    kind: "technology",
    text: "",
    originalName: "sample.txt",
    mimeType: "text/plain",
    extraction: "pending",
    warnings: [],
    createdAt: now,
    updatedAt: now,
    ...changes,
  };
}
function original(): NonNullable<SourceIntakeItem["original"]> {
  return {
    originalName: "sample.txt",
    mimeType: "text/plain",
    sizeBytes: 3,
    sha256: hash,
    sourceUpdatedAt: now,
  };
}
function result(): NonNullable<SourceIntakeItem["result"]> {
  return {
    id: id(7),
    attemptId: id(8),
    engine: "local-document",
    generatedAt: now,
    originalSha256: hash,
    sourceUpdatedAt: now,
    textSha256: hash,
    content: { kind: "plain", text: "가상 판독문" },
    warnings: [],
    reviewStatus: "unreviewed",
    discardedAt: null,
  };
}
function reviewCompany() {
  return company({
    sourceIntakes: [
      item({ version: 3, phase: "awaiting_review", original: original(), result: result() }),
    ],
    sources: [source()],
  });
}
function requestCreate(): IntakePending {
  return intakeCommand({
    action: "create",
    revision: 1,
    clientRequestId: nonce,
    files: [{ clientFileId: id(4), originalName: "sample.txt", kind: "technology", sizeBytes: 3 }],
  });
}
function receipt(action: SourceIntakeItem["requests"][number]["action"], clientRequestId = nonce) {
  return { clientRequestId, inputDigest: hash, action };
}
function requestOriginal(): IntakePending {
  return {
    kind: "original",
    itemId: id(2),
    input: { revision: 1, clientRequestId: nonce, expectedItemVersion: 1 },
    file: new File(["abc"], "sample.txt", { type: "text/plain" }),
  };
}
function requestAdopt(): IntakePending {
  return intakeCommand({
    action: "adopt",
    revision: 2,
    clientRequestId: nonce,
    itemId: id(2),
    expectedItemVersion: 3,
    resultId: id(7),
    sourceUpdatedAt: now,
    originalSha256: hash,
    text: "교정 본문",
    reviewed: true,
  });
}
function adopted(): StudioCase {
  return company({
    revision: 3,
    sourceIntakes: [
      item({
        version: 4,
        phase: "adopted",
        original: original(),
        result: result(),
        requests: [receipt("adopt")],
        adoption: {
          id: id(9),
          clientRequestId: nonce,
          inputDigest: hash,
          resultId: id(7),
          resultTextSha256: hash,
          adoptedTextSha256: hash,
          sourceUpdatedAt: now,
          adoptedAt: now,
        },
      }),
    ],
    sources: [source({ text: "교정 본문", extraction: "manual" })],
  });
}
afterEach(() => vi.unstubAllGlobals());

describe("복수 접수 파일 선택 경계", () => {
  it.each(["../sample.txt", "sample.exe", "sample.flac", "CON.txt", "sample.txt "])(
    "지원하지 않는 이름 %s은 개별 접수에서 제외한다",
    (name) => expect(intakeFileError({ name, size: 3 })).not.toBe(""),
  );
  it("파일당 한도와 묶음 합계를 분리한다", () => {
    expect(intakeFileError({ name: "a.PDF", size: 12 * 1024 * 1024 })).toBe("");
    expect(intakeFileError({ name: "a.pdf", size: 0 })).not.toBe("");
    expect(intakeFileError({ name: "a.pdf", size: 12 * 1024 * 1024 + 1 })).not.toBe("");
    const files = Array.from({ length: 3 }, (_, i) => ({
      clientFileId: id(20 + i),
      file: new File([new Uint8Array(8 * 1024 * 1024)], `file-${i}.txt`),
      kind: "technology" as const,
    }));
    expect(intakeBatchError(files)).toBe("");
    expect(intakeBatchError([...files, { ...files[0], clientFileId: id(30) }])).toContain("24MiB");
    expect(intakeBatchError([files[0], files[0]])).toContain("식별자");
    expect(intakeBatchError([])).not.toBe("");
    expect(
      intakeBatchError(
        Array.from({ length: 11 }, (_, i) => ({ ...files[0], clientFileId: id(30 + i) })),
      ),
    ).toContain("10개");
  });
});
describe("접수 응답과 저장된 요청 확인", () => {
  it("묶음 첫 항목의 create nonce만으로 정확한 전체 묶음을 확인한다", () => {
    const request = requestCreate(),
      saved = company({ sourceIntakes: [item({ requests: [receipt("create")] })] });
    expect(
      validateIntakeResponse({ company: saved, batchId: id(3), item: null }, id(1), request),
    ).toEqual(saved);
    expect(
      validateIntakeResponse({ company: saved, batchId: id(4), item: null }, id(1), request),
    ).toBeNull();
    expect(
      validateIntakeResponse(
        { company: saved, batchId: id(3), item: saved.sourceIntakes[0] },
        id(1),
        request,
      ),
    ).toBeNull();
  });
  it.each(["company", "revision", "nonce", "action", "name", "size", "kind", "duplicate", "extra"])(
    "create 응답의 %s 불일치를 수락하지 않는다",
    (mutation) => {
      const saved = company({ sourceIntakes: [item({ requests: [receipt("create")] })] });
      if (mutation === "company") saved.id = id(99);
      if (mutation === "revision") saved.revision = 0;
      if (mutation === "nonce") saved.sourceIntakes[0].requests[0].clientRequestId = id(99);
      if (mutation === "action") saved.sourceIntakes[0].requests[0].action = "resume";
      if (mutation === "name") saved.sourceIntakes[0].declared.originalName = "changed.txt";
      if (mutation === "size") saved.sourceIntakes[0].declared.sizeBytes = 4;
      if (mutation === "kind") saved.sourceIntakes[0].declared.kind = "finance";
      if (mutation === "duplicate") saved.sourceIntakes[0].requests.push(receipt("create"));
      if (mutation === "extra")
        saved.sourceIntakes.push(item({ id: id(10), clientFileId: id(11) }));
      expect(intakeRequestAcknowledged(saved, id(1), requestCreate())).toBe(false);
    },
  );
  it("개별 원본 저장은 대상 항목·버전·선택 파일의 이름·크기를 확인한다", () => {
    const saved = company({
      sourceIntakes: [
        item({
          version: 2,
          original: original(),
          phase: "original_stored",
          requests: [receipt("original")],
        }),
      ],
    });
    expect(
      validateIntakeResponse(
        { company: saved, batchId: id(3), item: saved.sourceIntakes[0] },
        id(1),
        requestOriginal(),
      ),
    ).toEqual(saved);
    expect(
      validateIntakeResponse(
        { company: saved, batchId: id(3), item: { ...saved.sourceIntakes[0], version: 3 } },
        id(1),
        requestOriginal(),
      ),
    ).toBeNull();
    const request = requestOriginal();
    if (request.kind !== "original") throw Error();
    request.itemId = id(99);
    expect(intakeRequestAcknowledged(saved, id(1), request)).toBe(false);
  });
  it("완료한 채택은 동일 nonce·결과·manual 본문을 모두 확인한다", () => {
    const saved = adopted();
    expect(intakeRequestAcknowledged(saved, id(1), requestAdopt())).toBe(true);
    saved.sources[0].text = "다른 본문";
    expect(intakeRequestAcknowledged(saved, id(1), requestAdopt())).toBe(false);
    saved.sources[0].text = "교정 본문";
    saved.sources[0].extraction = "pending";
    expect(intakeRequestAcknowledged(saved, id(1), requestAdopt())).toBe(false);
    saved.sources[0].extraction = "manual";
    saved.sourceIntakes[0].adoption!.resultId = id(99);
    expect(intakeRequestAcknowledged(saved, id(1), requestAdopt())).toBe(false);
  });
  it("판독문 폐기는 본문 null·정확 결과·폐기시각까지 확인한다", () => {
    const request = intakeCommand({
      action: "discard-result",
      revision: 1,
      clientRequestId: nonce,
      itemId: id(2),
      expectedItemVersion: 1,
      resultId: id(7),
      confirmed: true,
    });
    const saved = company({
      sourceIntakes: [
        item({
          result: { ...result(), content: null, discardedAt: now },
          requests: [receipt("discard-result")],
        }),
      ],
    });
    expect(intakeRequestAcknowledged(saved, id(1), request)).toBe(true);
    saved.sourceIntakes[0].result!.content = { kind: "plain", text: "아직 있음" };
    expect(intakeRequestAcknowledged(saved, id(1), request)).toBe(false);
  });
  it("GET은 회사·최소 revision·실행 항목 ID를 확인한다", () => {
    const saved = company({ sourceIntakes: [item()] });
    expect(
      validateIntakeStatus({ company: saved, activeItemIds: [id(2)] }, id(1), 2),
    ).not.toBeNull();
    for (const activeItemIds of [[id(99)], [id(2), id(2)], null])
      expect(validateIntakeStatus({ company: saved, activeItemIds }, id(1), 2)).toBeNull();
    expect(validateIntakeStatus({ company: saved, activeItemIds: [] }, id(99), 2)).toBeNull();
    expect(validateIntakeStatus({ company: saved, activeItemIds: [] }, id(1), 3)).toBeNull();
  });
  it("응답 유실은 GET에 기록이 없다는 이유만으로 재시도 허용하지 않는다", () => {
    const saved = company();
    expect(intakePendingState(saved, id(1), requestCreate(), false, [])).toBe("unknown");
    expect(intakePendingState(saved, id(1), requestCreate(), true, [id(2)])).toBe("unknown");
    expect(intakePendingState(saved, id(1), requestCreate(), true, [])).toBe("rejected");
    expect(intakePendingState(saved, id(99), requestCreate(), true, [])).toBe("unknown");
    expect(intakePendingState(adopted(), id(1), requestAdopt(), false, [])).toBe("acknowledged");
  });
});
describe("성공 단계 재실행과 판독문 채택 경계", () => {
  it("미접수 취소는 원본과 시도가 없는 항목만 허용하며 저장 증가 버전을 확인한다", () => {
    const request = intakeCommand({
      action: "cancel-awaiting-original",
      revision: 1,
      clientRequestId: nonce,
      itemId: id(2),
      expectedItemVersion: 1,
      confirmed: true,
    });
    expect(intakeCanCancel(item())).toBe(true);
    expect(intakeCanCancel(item({ phase: "original_stored", original: original() }))).toBe(false);
    expect(intakeCanCancel(adopted().sourceIntakes[0])).toBe(false);
    const saved = company({
      sourceIntakes: [
        item({ phase: "cancelled", version: 2, requests: [receipt("cancel-awaiting-original")] }),
      ],
    });
    expect(intakeRequestAcknowledged(saved, id(1), request)).toBe(true);
    saved.sourceIntakes[0].version = 1;
    expect(intakeRequestAcknowledged(saved, id(1), request)).toBe(false);
    saved.sourceIntakes[0].version = 2;
    saved.sourceIntakes[0].phase = "awaiting_original";
    expect(intakeRequestAcknowledged(saved, id(1), request)).toBe(false);
  });
  it("채택 본문을 유지한 판독 초안 비우기도 정확한 폐기 결과로 확인한다", () => {
    const request = intakeCommand({
      action: "discard-result",
      revision: 3,
      clientRequestId: id(15),
      itemId: id(2),
      expectedItemVersion: 4,
      resultId: id(7),
      confirmed: true,
    });
    const saved = adopted();
    saved.revision = 4;
    saved.sourceIntakes[0].version = 5;
    saved.sourceIntakes[0].requests.push(receipt("discard-result", id(15)));
    saved.sourceIntakes[0].result!.content = null;
    saved.sourceIntakes[0].result!.discardedAt = now;
    expect(intakeRequestAcknowledged(saved, id(1), request)).toBe(true);
    expect(saved.sources[0].text).toBe("교정 본문");
    expect(saved.sourceIntakes[0].phase).toBe("adopted");
    expect(intakeCanRead(saved.sourceIntakes[0])).toBe(false);
  });
  it("처리 중 최신 회사 응답보다 늦게 도착한 이전 응답은 반영하지 않는다", () => {
    const saved = company({ sourceIntakes: [item({ requests: [receipt("create")] })] });
    expect(
      validateIntakeResponse(
        { company: saved, batchId: id(3), item: null },
        id(1),
        requestCreate(),
        3,
      ),
    ).toBeNull();
  });
  it("미접수는 원본 접수만, 중단 단계는 재개만, 채택은 모두 차단한다", () => {
    expect(intakeCanUpload(item())).toBe(true);
    expect(intakeCanResume(item())).toBe(false);
    expect(intakeCanResume(item({ phase: "extracting_local" }))).toBe(true);
    expect(intakeCanRead(item({ phase: "original_stored", original: original() }))).toBe(true);
    const stored = reviewCompany().sourceIntakes[0];
    expect(intakeCanRead(stored)).toBe(false);
    expect(intakeCanResume(stored)).toBe(false);
    const done = adopted().sourceIntakes[0];
    expect(intakeCanRead(done)).toBe(false);
    expect(intakeCanUpload(done)).toBe(false);
    expect(intakeCanResume(done)).toBe(false);
    expect(
      intakeCanRead(
        item({
          phase: "result_discarded",
          original: original(),
          result: { ...result(), content: null, discardedAt: now },
        }),
      ),
    ).toBe(true);
  });
  it("교정은 처음 미확인이며 원본/결과/회사 binding과 수동 대조를 요구한다", () => {
    const saved = reviewCompany(),
      draft = intakeReviewDraft(saved, saved.sourceIntakes[0])!;
    expect(draft.reviewed).toBe(false);
    expect(intakeReviewProblem(saved, draft)).toContain("대조");
    expect(intakeReviewProblem(saved, { ...draft, reviewed: true })).toBe("");
    expect(intakeReviewProblem(saved, { ...draft, reviewed: true, text: "  " })).toContain("본문");
    expect(
      intakeReviewProblem(saved, { ...draft, reviewed: true, text: "x".repeat(100001) }),
    ).toContain("100,000");
  });
  it.each([
    "revision",
    "version",
    "result",
    "hash",
    "timestamp",
    "source-text",
    "source-state",
    "source-missing",
  ])("교정 중 %s 변경은 채택을 차단한다", (change) => {
    const saved = reviewCompany(),
      draft = { ...intakeReviewDraft(saved, saved.sourceIntakes[0])!, reviewed: true };
    if (change === "revision") saved.revision++;
    if (change === "version") saved.sourceIntakes[0].version++;
    if (change === "result") saved.sourceIntakes[0].result!.id = id(99);
    if (change === "hash") saved.sourceIntakes[0].original!.sha256 = "b".repeat(64);
    if (change === "timestamp") saved.sources[0].updatedAt = "2026-09-26T00:00:00.000Z";
    if (change === "source-text") saved.sources[0].text = "별도로 등록한 본문";
    if (change === "source-state") saved.sources[0].extraction = "manual";
    if (change === "source-missing") saved.sources = [];
    expect(intakeReviewProblem(saved, draft)).not.toBe("");
  });
});
describe("명시적 접수 요청 전송", () => {
  it("확장자·실제 형식 거절은 응답 유실로 표현하지 않고 파일 확인·취소를 안내한다", () => {
    const message = intakeErrorMessage("INTAKE_ORIGINAL_FORMAT");
    expect(message).toContain("확장자와 실제 파일 형식이 달라");
    expect(message).toContain("미접수 항목을 취소");
    expect(message).not.toContain("요청 결과를 확인하지 못했습니다");
  });
  it("PUT은 같은 선택 File과 nonce 및 최신 호출 revision만 보낸다", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const request = requestOriginal();
    if (request.kind !== "original") throw Error();
    request.input.revision = 17;
    await sendIntakeRequest("/intakes", request);
    const [url, options] = fetcher.mock.calls[0] as [string, RequestInit];
    const body = options.body as FormData;
    expect(url).toBe(`/intakes/${id(2)}/original`);
    expect(options.method).toBe("PUT");
    expect([...body.keys()]).toEqual([
      "file",
      "revision",
      "clientRequestId",
      "expectedItemVersion",
    ]);
    expect(body.get("file")).toBe(request.file);
    expect(body.get("revision")).toBe("17");
    expect(body.get("clientRequestId")).toBe(nonce);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("POST은 승인하지 않은 외부 AI 옵션을 추가하지 않는다", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const request = intakeCommand({
      action: "run-next",
      revision: 3,
      clientRequestId: nonce,
      itemId: id(2),
      expectedItemVersion: 2,
      engine: "windows-ko",
    });
    await sendIntakeRequest("/intakes", request);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(
      request.kind === "command" ? request.command : null,
    );
    expect(fetcher.mock.calls[0][1].body).not.toContain("allowAi");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("네트워크 실패를 자동 재요청하지 않는다", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("network"));
    vi.stubGlobal("fetch", fetcher);
    await expect(sendIntakeRequest("/intakes", requestCreate())).rejects.toThrow("network");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("서버 원문/파일명 오류를 노출하지 않고 명시 거절 여부만 분류한다", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "PRIVATE-FILENAME / SECRET",
          code: "INTAKE_ORIGINAL_INVALID",
          accepted: false,
        }),
        { status: 400 },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const error = await sendIntakeRequest("/intakes", requestCreate()).catch((value) => value);
    expect(error).toBeInstanceOf(IntakeHttpError);
    if (!(error instanceof IntakeHttpError)) throw new Error("HTTP error type missing");
    expect(error.accepted).toBe(false);
    expect(error.message).not.toMatch(/PRIVATE|SECRET/);
    expect(intakeErrorMessage(error.code)).toContain("형식");
  });
  it("불량 오류 코드는 고정 진단 코드로 바꾸며 accepted를 추정하지 않는다", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ code: "private.txt", accepted: "false" }), { status: 500 }),
        ),
    );
    const error = await sendIntakeRequest("/intakes", requestCreate()).catch((value) => value);
    if (!(error instanceof IntakeHttpError)) throw new Error("HTTP error type missing");
    expect(error.code).toBe("INTAKE_RESPONSE_FAILED");
    expect(error.accepted).toBeNull();
    expect(intakeErrorMessage("INTAKE_RECOVERY_REQUIRED")).toContain("반복 접수하지 마세요");
  });
});
describe("복수 접수 화면 의미", () => {
  it("채택 결과도 초안 공간을 비울 수 있으며 자료 본문 보존을 명시한다", () => {
    const html = renderToStaticMarkup(
      createElement(SourceIntakesPanel, {
        company: adopted(),
        busy: false,
        onCompany: vi.fn(),
        onBusyChange: vi.fn(),
        onDirtyChange: vi.fn(),
      }),
    );
    expect(html).toContain("채택한 본문은 유지하고 판독 초안 비우기");
    expect(html).toContain("판독 초안을 비워도 채택한 자료 본문은 유지됩니다");
    expect(html).not.toContain("원본 미접수 항목 취소</button>");
  });
  it("취소 항목은 이력만 보여주며 원본 업로드나 판독을 제안하지 않는다", () => {
    const saved = company({ sourceIntakes: [item({ phase: "cancelled" })] });
    const html = renderToStaticMarkup(
      createElement(SourceIntakesPanel, {
        company: saved,
        busy: false,
        onCompany: vi.fn(),
        onBusyChange: vi.fn(),
        onDirtyChange: vi.fn(),
      }),
    );
    expect(html).toContain("원본 접수 전에 취소했습니다");
    expect(html).not.toContain("미접수 원본 다시 선택");
    expect(html).not.toContain("로컬 문서 판독</button>");
    expect(html).not.toContain("원본 미접수 항목 취소</button>");
  });
  it("초기 SSR는 아무 요청도 실행하지 않으며 상태 조회 전 쓰기를 비활성화한다", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const callbacks = { onCompany: vi.fn(), onBusyChange: vi.fn(), onDirtyChange: vi.fn() };
    const html = renderToStaticMarkup(
      createElement(SourceIntakesPanel, { company: company(), busy: false, ...callbacks }),
    );
    expect(html).toContain('multiple=""');
    expect(html).toContain("외부 AI로");
    expect(html).toContain("판독은 외부 AI로 전송하지 않습니다");
    expect(html).toContain("동의한 요청만 전송합니다");
    expect(html).toContain("저장 상태 확인 전에는");
    expect(html).toMatch(/<fieldset[^>]*disabled=""/);
    expect(fetcher).not.toHaveBeenCalled();
    for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
  });
  it("미접수는 파일 재선택, 현재 판독 결과는 교정, 채택 완료는 덮어쓰기 금지를 표시한다", () => {
    const saved = company({
      sourceIntakes: [
        item(),
        item({ ...reviewCompany().sourceIntakes[0], id: id(20), clientFileId: id(21) }),
        item({ ...adopted().sourceIntakes[0], id: id(22), clientFileId: id(23) }),
      ],
    });
    const html = renderToStaticMarkup(
      createElement(SourceIntakesPanel, {
        company: saved,
        busy: false,
        onCompany: vi.fn(),
        onBusyChange: vi.fn(),
        onDirtyChange: vi.fn(),
      }),
    );
    expect(html).toContain("파일 다시 선택 필요");
    expect(html).toContain("저장 판독문 교정·확인");
    expect(html).toContain("덮어쓰지 않습니다");
    expect(html).not.toContain("저장된 로컬 단계 재개");
  });
  it("페이지/위치를 유지하고 미확인 체크와 안전하게 escaped 본문을 보여준다", () => {
    const saved = reviewCompany();
    saved.sourceIntakes[0].result!.content = {
      kind: "pages",
      pages: [
        { pageNumber: 1, text: "<script>sample</script>" },
        { pageNumber: 2, text: "가상 두 번째 페이지" },
      ],
    };
    const draft = intakeReviewDraft(saved, saved.sourceIntakes[0])!;
    const html = renderToStaticMarkup(
      createElement(IntakeResultReview, {
        company: saved,
        item: saved.sourceIntakes[0],
        draft,
        disabled: false,
        error: "",
        onChange: vi.fn(),
        onSave: vi.fn(),
        onClose: vi.fn(),
      }),
    );
    expect(html).toContain("원본 1페이지");
    expect(html).toContain("원본 2페이지");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0]).not.toContain('checked=""');
    expect(html).toContain("아직 분석 근거가 아닙니다");
    expect(html).toContain(`/api/studio/cases/${id(1)}/sources/${id(5)}`);
  });
  it("다른 자료를 편집 중이면 사유를 유지하고 새 접수 입력을 막는다", () => {
    const html = renderToStaticMarkup(
      createElement(SourceIntakesPanel, {
        company: company(),
        busy: false,
        blockedReason: "기존 자료 편집을 먼저 저장하거나 취소해 주세요.",
        onCompany: vi.fn(),
        onBusyChange: vi.fn(),
        onDirtyChange: vi.fn(),
      }),
    );
    expect(html).toContain("기존 자료 편집을 먼저");
    expect(html).toMatch(/<fieldset[^>]*disabled=""/);
  });
});
