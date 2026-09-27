import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  caseSchema,
  emptyProfile,
  type SourceDocument,
  type StudioCase,
} from "@/lib/studio-schema";
import type { LocalOcrPreview } from "@/lib/studio-local-ocr-types";
import {
  GuidedSourceReview,
  guidedSourceReviewBindingReason,
  guidedSourceReviewMutation,
  guidedSourceReviewReducer,
  guidedSourceReviewSaved,
  type GuidedSourceReviewBinding,
  type GuidedSourceReviewDraft,
} from "./guided-source-review";

const companyId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const foreignId = "44444444-4444-4444-8444-444444444444";
const now = "2026-09-26T02:00:00.000Z";
const later = "2026-09-26T02:01:00.000Z";
const hash = "a".repeat(64);

function source(change: Partial<SourceDocument> = {}): SourceDocument {
  return {
    id: sourceId,
    name: "합성 스캔 기술자료",
    kind: "technology",
    text: "",
    originalName: "synthetic-scan.pdf",
    mimeType: "application/pdf",
    extraction: "pending",
    warnings: ["합성 원본 보관 안내"],
    createdAt: now,
    updatedAt: now,
    ...change,
  };
}
function company(sources = [source()]): StudioCase {
  return caseSchema.parse({
    id: companyId,
    profile: { ...emptyProfile(), companyName: "합성 교정 화면 기업" },
    sources,
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: "preparing",
    revision: 3,
    createdAt: now,
    updatedAt: now,
  });
}
function binding(value = source()): GuidedSourceReviewBinding {
  return { caseId: companyId, revision: 3, source: structuredClone(value) };
}
function preview(): LocalOcrPreview {
  return {
    caseRevision: 3,
    sourceId,
    sourceUpdatedAt: now,
    original: {
      originalName: "synthetic-scan.pdf",
      mimeType: "application/pdf",
      sizeBytes: 256,
      sha256: hash,
    },
    engine: "windows-ko",
    observedAt: now,
    pages: [{ pageNumber: 1, text: "합성 판독문" }],
    text: "[페이지 1]\n합성 판독문",
    warnings: [],
    reviewStatus: "unreviewed",
    sourceChanged: false,
    externalTransmission: false,
  };
}
function draft(ocr = false): GuidedSourceReviewDraft {
  return {
    text: "원본과 대조해 교정한 합성 본문",
    reviewed: true,
    preview: ocr ? preview() : null,
    clientRequestId: ocr ? requestId : null,
  };
}
function saved(ocr = false): StudioCase {
  const value = company([source({ text: draft().text, extraction: "manual", updatedAt: later })]);
  value.revision = 4;
  if (ocr)
    value.sourceOcrReviews = [
      {
        id: foreignId,
        clientRequestId: requestId,
        inputDigest: hash,
        sourceId,
        originalSha256: hash,
        textSha256: hash,
        reviewedAt: later,
        sourceUpdatedAt: later,
      },
    ];
  return value;
}
function render(change: Partial<ComponentProps<typeof GuidedSourceReview>> = {}) {
  const callbacks = {
    onBusyChange: vi.fn(),
    mutate: vi.fn(),
    onClose: vi.fn(),
    onDirtyChange: vi.fn(),
  };
  const html = renderToStaticMarkup(
    createElement(GuidedSourceReview, {
      company: company(),
      source: source(),
      busy: false,
      blockedReason: "",
      ...callbacks,
      ...change,
    }),
  );
  for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
  return html;
}
const fetchGuard = vi.fn(() => {
  throw new Error("합성 본문 교정 시험에서 실제 OCR·AI 호출을 실행하면 안 됩니다.");
});
beforeEach(() => {
  fetchGuard.mockClear();
  vi.stubGlobal("fetch", fetchGuard);
});
afterEach(() => {
  expect(fetchGuard).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("자료 본문 확인 화면", () => {
  it("원본 대기 자료는 직접 입력과 명시적인 로컬 글자 읽기를 제공하고 자동 호출하지 않는다", () => {
    const html = render();
    expect(html).toContain("이 PC에서 글자 읽기");
    expect(html).toContain("원본을 외부 AI로 보내지 않습니다");
    expect(html).toContain("직접 본문을 입력해도 됩니다");
    expect(html).toContain(`/api/studio/cases/${companyId}/sources/${sourceId}`);
    expect(html).toContain("원본 내려받아 대조");
    expect(html).toContain("보관한 원본은 유지됩니다");
    expect(html).not.toMatch(/<input[^>]*\schecked=""/);
    const primary = [...html.matchAll(/<button\b[^>]*class="[^"]*primary[^\"]*"[^>]*>/g)];
    expect(primary).toHaveLength(1);
    expect(primary[0][0]).toContain('disabled=""');
    expect(html).not.toContain("AI로 읽기");
  });

  it("기존 본문은 안전하게 표시하고 로컬 OCR을 다시 실행하는 경로를 만들지 않는다", () => {
    const current = source({ text: "합성 본문 <script>실행 금지</script>", extraction: "manual" });
    const html = render({ company: company([current]), source: current });
    expect(html).toContain("합성 본문 &lt;script&gt;실행 금지&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("이 PC에서 글자 읽기");
    expect(html).toContain("원본과 대조해 저장할 본문을 확인했습니다");
  });

  it("이 기업에 없는 자료는 교정 입력과 저장·판독을 막는다", () => {
    const html = render({ company: company([]) });
    expect(html).toContain("기업 또는 자료 버전이 바뀌어 저장을 멈췄습니다");
    expect(html).toMatch(/<textarea[^>]*readOnly=""/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>이 PC에서 글자 읽기/);
  });

  it("다른 작업 진행 중에는 본문 변경과 닫기를 잠근다", () => {
    const html = render({ busy: true });
    expect(html).toMatch(/<textarea[^>]*readOnly=""/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>닫기/);
    expect(html).toMatch(/<input[^>]*disabled=""/);
  });

  it("외부 차단 사유를 지속적으로 표시한다", () => {
    const html = render({ blockedReason: "기관 작업 확인 중입니다." });
    expect(html).toContain('role="alert"');
    expect(html).toContain("기관 작업 확인 중입니다");
    expect(html).toMatch(/<textarea[^>]*readOnly=""/);
  });
});

describe("교정 초안과 대조 확인", () => {
  it("본문을 한 글자라도 고치면 기존 대조 확인을 해제하고 OCR 원본 바인딩은 유지한다", () => {
    const initial = draft(true);
    const next = guidedSourceReviewReducer(initial, { type: "text", text: "다시 교정한 본문" });
    expect(next.reviewed).toBe(false);
    expect(next.text).toBe("다시 교정한 본문");
    expect(next.preview).toBe(initial.preview);
    expect(next.clientRequestId).toBe(requestId);
    expect(initial.reviewed).toBe(true);
    expect(() => guidedSourceReviewMutation(company(), source(), binding(), next)).toThrow("대조");
  });

  it("로컬 판독 결과는 항상 미확인 초안으로 시작한다", () => {
    const next = guidedSourceReviewReducer(draft(), {
      type: "preview",
      preview: preview(),
      clientRequestId: requestId,
    });
    expect(next.text).toBe(preview().text);
    expect(next.reviewed).toBe(false);
    expect(next.clientRequestId).toBe(requestId);
    expect(() => guidedSourceReviewMutation(company(), source(), binding(), next)).toThrow("대조");
    const confirmed = guidedSourceReviewReducer(next, { type: "reviewed", reviewed: true });
    expect(guidedSourceReviewMutation(company(), source(), binding(), confirmed).action).toBe(
      "review-local-ocr",
    );
  });

  it.each(["", " ", "a".repeat(100001)])(
    "확인해도 빈 본문이나 한도 초과 본문은 저장하지 않는다 (%#)",
    (text) => {
      expect(() =>
        guidedSourceReviewMutation(company(), source(), binding(), { ...draft(), text }),
      ).toThrow();
    },
  );

  it("다른 작업·차단 사유가 생기면 확인한 교정 본문도 저장하지 않는다", () => {
    expect(() =>
      guidedSourceReviewMutation(company(), source(), binding(), draft(), "외부 작업 대기"),
    ).toThrow("외부 작업 대기");
    expect(() =>
      guidedSourceReviewMutation(company(), source(), binding(), draft(), "", true),
    ).toThrow("저장하고 있습니다");
  });
});

describe("본문 저장의 기업·자료 버전 바인딩", () => {
  it.each([
    [
      "다른 기업",
      (value: StudioCase) => {
        value.id = foreignId;
      },
    ],
    [
      "새 revision",
      (value: StudioCase) => {
        value.revision += 1;
      },
    ],
    [
      "자료 삭제",
      (value: StudioCase) => {
        value.sources = [];
      },
    ],
    [
      "중복 자료 ID",
      (value: StudioCase) => {
        value.sources.push(structuredClone(value.sources[0]));
      },
    ],
    [
      "수정 시각 변경",
      (value: StudioCase) => {
        value.sources[0].updatedAt = later;
      },
    ],
    [
      "본문 변경",
      (value: StudioCase) => {
        value.sources[0].text = "다른 본문";
      },
    ],
    [
      "추출 상태 변경",
      (value: StudioCase) => {
        value.sources[0].extraction = "manual";
      },
    ],
    [
      "원본 변경",
      (value: StudioCase) => {
        value.sources[0].originalName = "another.pdf";
      },
    ],
    [
      "원본 형식 변경",
      (value: StudioCase) => {
        value.sources[0].mimeType = "image/png";
      },
    ],
  ] as const)("%s이면 저장을 거부하고 교정 본문을 보존한다", (_, change) => {
    const value = company();
    const edited = draft(true);
    const before = structuredClone(edited);
    change(value);
    expect(guidedSourceReviewBindingReason(value, source(), binding())).toContain("유지했습니다");
    expect(() => guidedSourceReviewMutation(value, source(), binding(), edited)).toThrow(
      "저장을 멈췄습니다",
    );
    expect(edited).toEqual(before);
  });

  it("선택한 자료 props가 바뀌어도 이전 교정 내용을 새 자료에 저장하지 않는다", () => {
    expect(() =>
      guidedSourceReviewMutation(company(), source({ id: foreignId }), binding(), draft()),
    ).toThrow();
    expect(() =>
      guidedSourceReviewMutation(company(), source({ updatedAt: later }), binding(), draft()),
    ).toThrow();
  });

  it("직접 입력은 원본 메타데이터와 기존 경고를 보존한 source mutation만 만든다", () => {
    const initial = source();
    const before = structuredClone(initial);
    const mutation = guidedSourceReviewMutation(company(), initial, binding(initial), draft());
    expect(mutation.action).toBe("source");
    if (mutation.action !== "source") throw new Error("직접 입력 mutation 누락");
    expect(mutation.source).toMatchObject({
      ...initial,
      text: draft().text,
      extraction: "manual",
      updatedAt: expect.any(String),
    });
    expect(initial).toEqual(before);
  });

  it("판독 초안은 일반 source 저장을 우회하고 원본 hash·시각·nonce를 포함한 검토 저장만 만든다", () => {
    const mutation = guidedSourceReviewMutation(company(), source(), binding(), draft(true));
    expect(mutation).toEqual({
      action: "review-local-ocr",
      clientRequestId: requestId,
      sourceId,
      sourceUpdatedAt: now,
      originalSha256: hash,
      text: draft().text,
      reviewed: true,
    });
  });

  it.each([
    [
      "다른 자료",
      (value: LocalOcrPreview) => {
        value.sourceId = foreignId;
      },
    ],
    [
      "이전 버전",
      (value: LocalOcrPreview) => {
        value.caseRevision = 2;
      },
    ],
    [
      "다른 원본",
      (value: LocalOcrPreview) => {
        value.original.originalName = "another.pdf";
      },
    ],
    [
      "외부 전송",
      (value: LocalOcrPreview) => {
        Object.assign(value, { externalTransmission: true });
      },
    ],
    [
      "확인 완료 사칭",
      (value: LocalOcrPreview) => {
        Object.assign(value, { reviewStatus: "reviewed" });
      },
    ],
  ] as const)("%s 판독 응답은 대조 확인을 체크해도 저장하지 않는다", (_, change) => {
    const value = draft(true);
    change(value.preview!);
    expect(() => guidedSourceReviewMutation(company(), source(), binding(), value)).toThrow(
      "일치하지 않습니다",
    );
  });

  it.each([null, "", "bad-request-id"])(
    "판독 저장의 유효한 요청 식별자가 없으면 저장을 막는다 (%s)",
    (clientRequestId) => {
      expect(() =>
        guidedSourceReviewMutation(company(), source(), binding(), {
          ...draft(true),
          clientRequestId,
        }),
      ).toThrow("저장 요청");
    },
  );
});

describe("저장 성공 응답을 확인한 뒤에만 교정 화면 종료", () => {
  it.each([false, true])("일치하는 직접/OCR 저장만 완료로 판정한다 (%s)", (ocr) => {
    expect(guidedSourceReviewSaved(saved(ocr), binding(), draft(ocr))).toBe(true);
  });

  it.each([
    [
      "기업 불일치",
      (value: StudioCase) => {
        value.id = foreignId;
      },
    ],
    [
      "이전 revision",
      (value: StudioCase) => {
        value.revision = 3;
      },
    ],
    [
      "본문 누락",
      (value: StudioCase) => {
        value.sources[0].text = "이전 본문";
      },
    ],
    [
      "수동 확인 아님",
      (value: StudioCase) => {
        value.sources[0].extraction = "ai";
      },
    ],
    [
      "이전 시각",
      (value: StudioCase) => {
        value.sources[0].updatedAt = now;
      },
    ],
    [
      "원본 누락",
      (value: StudioCase) => {
        value.sources[0].originalName = null;
      },
    ],
    [
      "자료 제목 변경",
      (value: StudioCase) => {
        value.sources[0].name = "다른 제목";
      },
    ],
    [
      "자료 분류 변경",
      (value: StudioCase) => {
        value.sources[0].kind = "other";
      },
    ],
    [
      "원본 생성시각 변경",
      (value: StudioCase) => {
        value.sources[0].createdAt = later;
      },
    ],
  ] as const)("%s 응답은 완료로 처리하지 않는다", (_, change) => {
    const value = saved();
    change(value);
    expect(guidedSourceReviewSaved(value, binding(), draft())).toBe(false);
  });

  it("빈 응답은 교정 본문을 닫거나 저장 성공으로 바꾸지 않는다", () => {
    expect(guidedSourceReviewSaved(null, binding(), draft())).toBe(false);
  });

  it.each([
    [
      "검토 기록 없음",
      (value: StudioCase) => {
        value.sourceOcrReviews = [];
      },
    ],
    [
      "다른 nonce",
      (value: StudioCase) => {
        value.sourceOcrReviews[0].clientRequestId = foreignId;
      },
    ],
    [
      "다른 자료",
      (value: StudioCase) => {
        value.sourceOcrReviews[0].sourceId = foreignId;
      },
    ],
    [
      "다른 hash",
      (value: StudioCase) => {
        value.sourceOcrReviews[0].originalSha256 = "b".repeat(64);
      },
    ],
    [
      "다른 저장 시각",
      (value: StudioCase) => {
        value.sourceOcrReviews[0].sourceUpdatedAt = now;
      },
    ],
    [
      "중복 검토 기록",
      (value: StudioCase) => {
        value.sourceOcrReviews.push(structuredClone(value.sourceOcrReviews[0]));
      },
    ],
  ] as const)("OCR %s 응답은 성공으로 판정하지 않는다", (_, change) => {
    const value = saved(true);
    change(value);
    expect(guidedSourceReviewSaved(value, binding(), draft(true))).toBe(false);
  });
});
