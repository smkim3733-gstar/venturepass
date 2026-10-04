import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { caseSchema, emptyProfile } from "@/lib/studio-schema";
import { GuidedBulkUpload, bulkUploadPresentation } from "./guided-bulk-upload";
import type { IntakeBulkView } from "./source-intake-bulk-queue";
const company = caseSchema.parse({
  id: "11111111-1111-4111-8111-111111111111",
  profile: { ...emptyProfile(), companyName: "합성 대량 화면 검증" },
  sources: [],
  analysis: null,
  selectedCandidateId: null,
  plans: [],
  tasks: [],
  stage: "preparing",
  revision: 1,
  createdAt: "2026-10-04T00:00:00Z",
  updatedAt: "2026-10-04T00:00:00Z",
});
describe("guided durable upload presentation", () => {
  it("initial HTML offers visible file selection and recovery without performing I/O or claiming adoption", () => {
    const callbacks = { onCompany: vi.fn(), onBusyChange: vi.fn(), onReviewSources: vi.fn() };
    const html = renderToStaticMarkup(
      createElement(GuidedBulkUpload, { company, locked: false, ...callbacks }),
    );
    expect(html).toContain("회사 자료 파일 선택");
    expect(html).toContain("저장 상태 확인");
    expect(html).toContain("원본 보관 후 본문을 판독·검토합니다");
    expect(html).toContain("원본 저장은 본문 채택이나 사실 확인 완료가 아닙니다");
    expect(html).toMatch(/type="file"[^>]*disabled/);
    for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
  });
  it("shows stored originals, uncertain requests, remaining files and cancellations separately", () => {
    const view: IntakeBulkView = {
      company,
      queue: null,
      activeItemIds: [],
      complete: false,
      files: ["stored", "confirmation", "remaining", "cancelled"].map((state, i) => ({
        clientFileId: String(i),
        name: `synthetic-${i}.pdf`,
        size: 24,
        state: state as IntakeBulkView["files"][number]["state"],
      })),
    };
    const before = JSON.stringify(view),
      result = bulkUploadPresentation(view);
    expect(result).toMatchObject({
      stored: 1,
      confirmation: 1,
      remaining: 1,
      cancelled: 1,
      closable: false,
    });
    expect(result.rows.map((row) => row.label)).toEqual([
      "원본 저장됨",
      "저장 여부 확인 필요",
      "남은 파일",
      "접수 취소됨",
    ]);
    expect(result.rows.map((row) => row.cardState)).toEqual([
      "saved",
      "unknown",
      "waiting",
      "waiting",
    ]);
    expect(JSON.stringify(view)).toBe(before);
  });
});
