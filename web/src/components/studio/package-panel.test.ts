import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  caseSchema,
  emptyProfile,
  type BusinessPlan,
  type SourceDocument,
  type StudioCase,
} from "@/lib/studio-schema";
import { PACKAGE_DOWNLOAD_NAME, packageLimits } from "@/lib/studio-package-types";
import {
  PackagePanel,
  packageSources,
  readPackageDownload,
  selectedPackageSources,
} from "./package-panel";

const companyId = "11111111-1111-4111-8111-111111111111";
const planId = "22222222-2222-4222-8222-222222222222";
const sourceId = "33333333-3333-4333-8333-333333333333";
const now = "2026-09-25T00:00:00.000Z";
function plan(change: Partial<BusinessPlan> = {}): BusinessPlan {
  return {
    id: planId,
    version: 1,
    generatedAt: now,
    mode: "assisted",
    candidateId: "test-candidate",
    sourceRevision: 1,
    content: {
      title: "가상 원고",
      summary: "가상 설명",
      sections: [
        {
          key: "solution",
          title: "기술",
          content: "검토할 내용",
          evidence: [],
          needsConfirmation: true,
        },
      ],
      actionItems: [],
      interviewQuestions: [],
    },
    review: [],
    confirmedAt: null,
    ...change,
  };
}
function source(change: Partial<SourceDocument> = {}): SourceDocument {
  return {
    id: sourceId,
    name: "가상 기술자료",
    kind: "technology",
    text: "",
    originalName: "가상 원본.pdf",
    mimeType: "application/pdf",
    extraction: "pending",
    warnings: [],
    createdAt: now,
    updatedAt: now,
    ...change,
  };
}
function company(change: Partial<StudioCase> = {}): StudioCase {
  return caseSchema.parse({
    id: companyId,
    profile: { ...emptyProfile(), companyName: "가상 테스트 회사" },
    sources: [source()],
    plans: [plan()],
    analysis: null,
    selectedCandidateId: null,
    tasks: [],
    stage: "preparing",
    revision: 2,
    createdAt: now,
    updatedAt: now,
    ...change,
  });
}
function panel(record = company(), dirty = false, selectedPlan = record.plans[0]) {
  const onBusyChange = vi.fn();
  return {
    html: renderToStaticMarkup(
      createElement(PackagePanel, { company: record, plan: selectedPlan, dirty, onBusyChange }),
    ),
    onBusyChange,
  };
}
const zipStart = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]);
function headers(change: Record<string, string> = {}) {
  return {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${PACKAGE_DOWNLOAD_NAME}`,
    ...change,
  };
}

describe("preparation ZIP source selection", () => {
  it("includes only this company's stored originals, including unreviewed pending files", () => {
    const record = company({
      sources: [
        source(),
        source({ id: planId, originalName: null, extraction: "manual", text: "직접 입력" }),
      ],
    });
    expect(packageSources(record).map((item) => item.id)).toEqual([sourceId]);
    expect(selectedPackageSources(record, [sourceId])).toEqual([sourceId]);
  });
  it("permits zero originals and rejects missing, duplicate, or ambiguous source identifiers", () => {
    expect(selectedPackageSources(company(), [])).toEqual([]);
    expect(selectedPackageSources(company(), [planId])).toBeNull();
    expect(selectedPackageSources(company(), [sourceId, sourceId])).toBeNull();
    expect(
      selectedPackageSources(company({ sources: [source(), source()] }), [sourceId]),
    ).toBeNull();
  });
  it("enforces ten explicitly selected originals without picking any automatically", () => {
    const originals = Array.from({ length: 11 }, (_, index) =>
      source({ id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}` }),
    );
    const record = company({ sources: originals });
    expect(
      selectedPackageSources(
        record,
        originals.slice(0, 10).map((item) => item.id),
      ),
    ).toHaveLength(10);
    expect(
      selectedPackageSources(
        record,
        originals.map((item) => item.id),
      ),
    ).toBeNull();
    expect(panel(record).html).not.toContain('checked=""');
  });
});

describe("bounded ZIP response validation", () => {
  it("accepts the server's exact RFC5987 attachment header and ZIP bytes", async () => {
    const result = await readPackageDownload(
      new Response(zipStart, { headers: headers({ "Content-Length": "5" }) }),
    );
    expect(result.filename).toBe(PACKAGE_DOWNLOAD_NAME);
    expect(result.blob.type).toBe("application/zip");
    expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(zipStart);
  });
  it("also accepts the exact ASCII fallback filename", async () => {
    const result = await readPackageDownload(
      new Response(zipStart, {
        headers: headers({
          "Content-Disposition": `attachment; filename="${PACKAGE_DOWNLOAD_NAME}"`,
        }),
      }),
    );
    expect(result.filename).toBe(PACKAGE_DOWNLOAD_NAME);
  });
  it("shows HTTP errors and never treats a JSON error as a download", async () => {
    await expect(
      readPackageDownload(
        new Response(JSON.stringify({ error: "자료 버전이 바뀌었습니다." }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ).rejects.toThrow("자료 버전이 바뀌었습니다");
    await expect(readPackageDownload(new Response("not-json", { status: 500 }))).rejects.toThrow(
      "만들지 못했습니다",
    );
  });
  it.each(["application/json", "text/html", "application/octet-stream"])(
    "rejects successful %s responses",
    async (type) => {
      await expect(
        readPackageDownload(new Response(zipStart, { headers: headers({ "Content-Type": type }) })),
      ).rejects.toThrow("ZIP 형식");
    },
  );
  it.each([
    "inline",
    'attachment; filename="../secret.zip"',
    'attachment; filename="unrelated.zip"',
    'attachment; filename="package.html"',
    "attachment; filename=\"download\"; filename*=UTF-8''%2e%2e%2fsecret.zip",
    `attachment; filename="${PACKAGE_DOWNLOAD_NAME}"; filename*=UTF-8''different.zip`,
  ])("rejects unexpected attachment filenames: %s", async (disposition) => {
    await expect(
      readPackageDownload(
        new Response(zipStart, { headers: headers({ "Content-Disposition": disposition }) }),
      ),
    ).rejects.toThrow("파일 이름");
  });
  it.each(["-1", "5e2", "0", String(packageLimits.zipBytes + 1)])(
    "rejects invalid declared size %s",
    async (size) => {
      await expect(
        readPackageDownload(
          new Response(zipStart, { headers: headers({ "Content-Length": size }) }),
        ),
      ).rejects.toThrow("크기");
    },
  );
  it("rejects truncated files and non-ZIP bytes even with accepted headers", async () => {
    await expect(
      readPackageDownload(new Response(zipStart, { headers: headers({ "Content-Length": "6" }) })),
    ).rejects.toThrow("완전하지 않습니다");
    await expect(
      readPackageDownload(new Response("<html>bad</html>", { headers: headers() })),
    ).rejects.toThrow("시작 형식");
    await expect(readPackageDownload(new Response(null, { headers: headers() }))).rejects.toThrow(
      "파일 내용",
    );
  });
  it("bounds undeclared streaming data and cancels before accepting an oversized archive", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(packageLimits.zipBytes + 1));
      },
      cancel,
    });
    await expect(readPackageDownload(new Response(body, { headers: headers() }))).rejects.toThrow(
      "크기가 허용 범위",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("package download UI", () => {
  it("binds the selected plan version and keeps DRAFT boundaries explicit", () => {
    const output = panel();
    expect(output.html).toContain("선택한 원고 v1");
    expect(output.html).toContain("DRAFT · 담당자 검토 필요");
    expect(output.html).toContain("기관 전송·접수나 내부 검토 완료 기록은 생성하지 않습니다");
    expect(output.html).toContain("본문 확인 필요 · 원본만 포함");
    expect(output.html).toContain("합계 24MiB");
    expect(output.html).not.toContain('checked=""');
    expect(output.onBusyChange).not.toHaveBeenCalled();
  });
  it("does not substitute the latest plan for the explicitly selected old version", () => {
    const record = company({ plans: [plan(), plan({ id: sourceId, version: 2 })] });
    const html = panel(record).html;
    expect(html).toContain("현재 선택은 원고 v1");
    expect(html).toContain("최신 v2으로 바꾸지 않고 선택한 버전을 묶습니다");
    expect(html).toContain("원고 v1 제출 준비 ZIP 내려받기");
    expect(html).toContain("DRAFT · 담당자 검토 필요");
  });
  it("blocks package download and original selection while the plan is dirty", () => {
    const html = panel(company(), true).html;
    expect(html).toContain("원고 수정본을 먼저 저장하거나 편집을 취소");
    const controls = html.match(/<(?:button|input)\b[^>]*>/g) ?? [];
    expect(controls.length).toBeGreaterThan(0);
    expect(controls.every((control) => control.includes('disabled=""'))).toBe(true);
  });
  it("requires server recheck even when the plan already has a manual review mark", () => {
    const html = panel(
      company({
        analysis: {
          summary: "가상 분석",
          generatedAt: now,
          sourceRevision: 1,
          mode: "assisted",
          facts: [],
          candidates: [],
          questions: [],
          warnings: [],
        },
        selectedCandidateId: "test-candidate",
        plans: [plan({ confirmedAt: now, content: { ...plan().content, sections: [] } })],
      }),
    ).html;
    expect(html).toContain("생성 시 현재성·검토 상태 재점검");
    expect(html).not.toContain("제출 준비 완료");
  });
  it("allows a document-only package with no original files and escapes names", () => {
    expect(panel(company({ sources: [] })).html).toContain("보관한 원본 파일이 없습니다");
    const html = panel(company({ sources: [source({ name: "<script>fake</script>" })] })).html;
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});
