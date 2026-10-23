import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { guidedDeadlineFixture } from "../../scripts/fixtures/guided-procedure-deadlines";
import { answerWorkflowSource } from "../../scripts/fixtures/guided-answer-workflow";
import {
  procedureReceiptResult,
  linkId,
  procedureReceiptHash,
} from "../../scripts/fixtures/application-procedure-receipt";
import { resolveGuidedProcedureDeadlines } from "./studio-guided-procedure-deadlines";
import { deriveGuidedFollowup } from "./studio-guided-followup";
import { deriveGuidedFlow } from "./studio-guided-flow";
import { GuidedFollowupStatus } from "../components/studio/guided-followup-status";

const today = "2026-10-14";
const get = async () => {
  const f = await guidedDeadlineFixture();
  const resolved = await resolveGuidedProcedureDeadlines(f.company);
  return { ...f, resolved };
};
describe("요청에 연결한 수동 절차 기한", () => {
  it("절차에 날짜가 없으면 원문 날짜와 그 출처를 함께 유지한다", async () => {
    const { base, input } = await get();
    const company = await procedureReceiptResult(
      base,
      {
        ...input,
        dueOn: "",
        extendedDueOn: "",
        extensionStatus: "unknown",
      },
      linkId(431),
    );
    const resolved = await resolveGuidedProcedureDeadlines(company);
    expect(
      deriveGuidedFollowup(company, { today, procedureDeadlines: resolved }).primary,
    ).toMatchObject({
      dueOn: "2026-10-13",
      dueNote: "합성 요청 원문의 기한",
      procedureDeadline: { message: expect.stringContaining("절차에 별도 기한이 없어") },
    });
  });
  it("연장된 요청보다 먼저 오는 다른 요청을 우선하고 담당자 업무 기한은 별도로 보존한다", async () => {
    const { company } = await get();
    const root = company.agencyRecords.find((r) => r.kind === "request")!;
    if (root.kind !== "request") throw Error("fixture");
    company.agencyRecords.push({
      ...root,
      id: linkId(970),
      requestRecordId: linkId(970),
      requestVersionId: linkId(970),
      clientRequestId: linkId(971),
      title: "먼저 답할 요청",
      dueOn: "2026-10-20",
    });
    const options = { today, procedureDeadlines: await resolveGuidedProcedureDeadlines(company) };
    expect(deriveGuidedFollowup(company, options).primary?.title).toBe("먼저 답할 요청");
    company.tasks.push({
      id: linkId(972),
      title: "담당자 업무",
      category: "supplement",
      dueDate: "2026-10-15",
      status: "pending",
      notes: "",
    });
    const summary = deriveGuidedFollowup(company, options);
    expect(summary.primary).toMatchObject({ kind: "task", dueOn: "2026-10-15" });
    expect(summary.items.find((item) => item.procedureDeadline)?.dueOn).toBe("2026-11-03");
  });
  it("현재 연장 기한을 요약과 주 행동 순서에 사용하고 원문/업무/회사 기록을 보존한다", async () => {
    const { company } = await get();
    const before = structuredClone(company);
    const resolved = await resolveGuidedProcedureDeadlines(company);
    expect(resolved.entries[0]).toMatchObject({
      state: "current",
      dueOn: "2026-11-03",
      record: { version: 2, recordedBy: "새 기록 담당자" },
    });
    const summary = deriveGuidedFollowup(company, { today, procedureDeadlines: resolved });
    expect(summary.primary).toMatchObject({
      dueOn: "2026-11-03",
      deadlineStatus: "upcoming",
      procedureDeadline: { originalDueOn: "2026-10-13" },
    });
    expect(deriveGuidedFlow(company, { today, procedureDeadlines: resolved }).followup).toEqual(
      summary,
    );
    expect(company).toEqual(before);
    const html = renderToStaticMarkup(
      createElement(GuidedFollowupStatus, {
        company,
        stage: company.stage,
        summary,
        disabled: false,
        onNavigate: () => {},
      }),
    );
    expect(html).toContain("연장 허용으로 기록한 날짜");
    expect(html).toContain("요청 원문 기한:");
    expect(html).toContain("합성 연장 허용 메모");
    expect(html).not.toContain("날짜 지남");
  });
  it("대조 전에는 원문 날짜를 보존하되 적용 기한/지연 상태를 단정하지 않는다", async () => {
    const { company } = await get();
    expect(deriveGuidedFollowup(company, { today }).primary).toMatchObject({
      dueOn: null,
      deadlineStatus: "unknown",
      procedureDeadline: { state: "pending", originalDueOn: "2026-10-13" },
    });
  });
  it.each(["object", "revision", "case"] as const)(
    "다른 %s 문맥의 비동기 결과를 적용하지 않는다",
    async (change) => {
      const { company, resolved } = await get();
      const next = change === "object" ? structuredClone(company) : company;
      if (change === "revision") next.revision++;
      if (change === "case") next.id = linkId(900);
      expect(
        deriveGuidedFollowup(next, { today, procedureDeadlines: resolved }).primary
          ?.procedureDeadline?.state,
      ).toBe("pending");
    },
  );
  it.each(["unknown", "reported_requested", "reported_denied"] as const)(
    "연장 %s 기록은 연장 날짜 없이 원래 절차 기한을 안내한다",
    async (extensionStatus) => {
      const { base, input } = await get();
      const company = await procedureReceiptResult(
        base,
        {
          ...input,
          extensionStatus,
          extendedDueOn: "",
        },
        linkId(431),
      );
      const resolved = await resolveGuidedProcedureDeadlines(company);
      expect(resolved.entries[0]).toMatchObject({ state: "current", dueOn: "2026-10-13" });
    },
  );
  it("후속 정정에서 연장 날짜를 철회하면 이전 연장을 재사용하지 않는다", async () => {
    const { company, input } = await get();
    const record = company.applicationProcedures.at(-1)!;
    const next = await procedureReceiptResult(
      company,
      {
        ...input,
        previousVersionId: record.id,
        extendedDueOn: "",
        extensionStatus: "reported_denied",
      },
      linkId(435),
      linkId(436),
    );
    expect((await resolveGuidedProcedureDeadlines(next)).entries[0]).toMatchObject({
      state: "current",
      dueOn: "2026-10-13",
      record: { version: 3 },
    });
  });
  it.each([
    "cycle",
    "link",
    "agency",
    "chain",
    "duplicate",
    "multiple",
    "hash",
    "basis",
    "not-allowed",
    "missing-link",
  ])("%s 변경/불명확한 연결을 원문 기한으로 되돌리고 경고한다", async (change) => {
    const { company } = await get();
    const record = company.applicationProcedures.at(-1)!;
    if (change === "cycle")
      company.applications.find((a) => a.id === record.applicationId)!.title += " 바뀜";
    if (change === "link") {
      const link = company.applicationEvents.find((e) => e.id === record.linkEventId)!;
      if (link.kind !== "agency-link" && link.kind !== "agency-link-correction")
        throw Error("Synthetic link required");
      link.note += " 바뀜";
    }
    if (change === "agency") company.agencyRecords.at(-1)!.body += " 바뀜";
    if (change === "chain") record.previousVersionId = linkId(950);
    if (change === "duplicate") company.applicationProcedures.push(structuredClone(record));
    if (change === "multiple")
      company.applicationProcedures.push({
        ...record,
        id: linkId(951),
        procedureId: linkId(951),
        version: 1,
        previousVersionId: null,
      });
    if (change === "hash") record.inputDigest = "0".repeat(64);
    if (change === "basis") record.extensionBasis = "";
    if (change === "not-allowed") record.extensionStatus = "reported_requested";
    if (change === "missing-link") company.applicationEvents = [];
    const resolved = await resolveGuidedProcedureDeadlines(company);
    expect(resolved.entries[0].state).toBe("review");
    expect(
      deriveGuidedFollowup(company, { today, procedureDeadlines: resolved }).primary,
    ).toMatchObject({
      dueOn: "2026-10-13",
      deadlineStatus: "overdue",
      procedureDeadline: { state: "review" },
    });
  });
  it("추가 증빙의 본문이 바뀌면 같은 ID/시각이라도 연장을 적용하지 않는다", async () => {
    const { company } = await get();
    const source = answerWorkflowSource();
    company.sources.push(source);
    company.applicationProcedures.at(-1)!.sourceSnapshots.push({
      sourceId: source.id,
      sourceUpdatedAt: source.updatedAt,
      sourceName: source.name,
      extraction: source.extraction,
      textSha256: await procedureReceiptHash(source.text),
      original: null,
    });
    const resolved = await resolveGuidedProcedureDeadlines(company);
    expect(resolved.entries[0].state).toBe("current");
    source.text += " 추가 변경";
    expect((await resolveGuidedProcedureDeadlines(company)).entries[0].state).toBe("review");
  });
  it("보관된 최신 요청이 정정되면 이전 연장 날짜를 적용하지 않는다", async () => {
    const { company } = await get();
    const prev = company.agencyRecords.at(-1)!;
    if (prev.kind !== "request-correction") throw Error("fixture");
    company.agencyRecords.push({
      ...prev,
      id: linkId(960),
      requestVersionId: linkId(960),
      previousVersionId: prev.id,
      version: 3,
    });
    expect((await resolveGuidedProcedureDeadlines(company)).entries[0].state).toBe("review");
  });
  it("절차가 없는 요청은 기존 원문 기한/동작을 유지한다", async () => {
    const { company } = await get();
    company.applicationProcedures = [];
    const result = deriveGuidedFollowup(company, { today });
    expect(result.primary?.dueOn).toBe("2026-10-13");
    expect(result.primary?.procedureDeadline).toBeUndefined();
  });
  it("해시 대조 불능은 오류를 던지지 않고 재확인 상태로 반환한다", async () => {
    const { company } = await get();
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {
        subtle: {
          digest: () => {
            throw Error("offline");
          },
        },
      },
    });
    try {
      expect((await resolveGuidedProcedureDeadlines(company)).entries[0].state).toBe("review");
    } finally {
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: original });
    }
  });
});
