import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("External access forbidden");
  }),
);
vi.mock("openai", () => ({
  default: class {
    constructor() {
      forbidden();
    }
  },
}));
vi.mock("@/lib/studio-storage", () => ({ getStudioStore: forbidden, StudioStore: forbidden }));
import { PlanQualityStore } from "@/lib/studio-plan-quality-store";
import { actualTestNow, actualTestPlan } from "@/lib/studio-plan-quality-actual-test-helpers";
import {
  providerTestConfigure,
  providerTestStartInput,
} from "@/lib/studio-plan-quality-provider-test-helpers";
import {
  providerExecutionTestApproval,
  providerExecutionTestResponse,
} from "@/lib/studio-plan-quality-provider-execution-test-helpers";
import { runQualityProviderSimulation } from "@/lib/studio-plan-quality-provider-runner";
import type { CandidateRegistrySnapshot } from "@/lib/studio-plan-quality-candidate-registry-types";
import type { ProviderSnapshot } from "@/lib/studio-plan-quality-provider-types";
import {
  QualityProviderRecordDetails,
  QualityProviderReviewPanel,
} from "./quality-provider-review-panel";

let directory: string, store: PlanQualityStore, registry: CandidateRegistrySnapshot;
const snapshots: Record<string, ProviderSnapshot> = {};
const decode = (html: string) =>
  html
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
const narrative = (html: string) =>
  decode(html.replace(/<pre\b[\s\S]*?<\/pre>/g, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const headline = (html: string) =>
  decode(html.match(/<p\b[^>]*role="status"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "").replace(
    /<[^>]+>/g,
    "",
  );
const details = (snapshot: ProviderSnapshot) =>
  renderToStaticMarkup(createElement(QualityProviderRecordDetails, { snapshot }));

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(actualTestNow));
  vi.stubGlobal("fetch", forbidden);
  directory = mkdtempSync(join(tmpdir(), "venturepass-provider-ssr-"));
  store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
  registry = store.candidateRegistryRegister({
    clientRequestId: randomUUID(),
    expectedVersion: 0,
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  }).snapshot;
  providerTestConfigure(store);
  for (const [index, name] of [
    "reserved",
    "cancelled",
    "completed",
    "unknown",
    "late",
    "overusage",
  ].entries()) {
    vi.setSystemTime(new Date(actualTestNow));
    const start = store.providerStart(providerTestStartInput(store, index)),
      id = start.snapshot.run.id;
    if (name === "reserved") {
      snapshots[name] = start.snapshot;
      continue;
    }
    if (name === "cancelled") {
      snapshots[name] = store.providerCancel(id, {
        clientRequestId: randomUUID(),
        expectedRevision: 0,
        reason: "test-cleanup",
      }).snapshot;
      continue;
    }
    if (name === "completed") snapshots["completed-r0"] = start.snapshot;
    const approval = providerExecutionTestApproval(store, id);
    const result = await runQualityProviderSimulation(store, id, approval, {
      transport: {
        provenance: "synthetic-test",
        model: "synthetic-provider-model",
        contractDigest: approval.payload.manifest.executionContract.contractDigest,
        send: async ({ request }) => {
          vi.setSystemTime(new Date(Date.now() + 1000));
          const response = providerExecutionTestResponse(
            request.phase === "generation" ? actualTestPlan(registry, index) : { findings: [] },
          );
          if (name === "unknown") delete (response as { usage?: unknown }).usage;
          if (name === "overusage")
            response.usage = { input_tokens: 3000000, output_tokens: 1, total_tokens: 3000001 };
          if (name === "late")
            store.providerRecordFinish(id, {
              clientRequestId: randomUUID(),
              expectedRevision: store.providerGet(id).revision,
              payload: {
                kind: "execution-stopped",
                outcome: "result-unobserved",
                failureCode: "INTERRUPTED",
                finalArtifactSha256: null,
              },
            });
          return response;
        },
      },
    });
    snapshots[name] = result.snapshot;
  }
  expect(snapshots.completed.state).toBe("completed");
  expect(snapshots.unknown.state).toBe("needs-cost-review");
  expect(snapshots.late.state).toBe("result-unobserved");
  expect(snapshots.overusage.state).toBe("bound-breached");
}, 30000);
afterEach(() => expect(forbidden).not.toHaveBeenCalled());
afterAll(() => {
  store?.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  const target = resolve(directory),
    rel = relative(resolve(tmpdir()), target);
  if (!rel.startsWith("venturepass-provider-ssr-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(target, { recursive: true, force: true });
});

describe("v2 record explanations", () => {
  it.each(["reserved", "cancelled", "completed", "unknown", "late", "overusage"])(
    "keeps %s evidence read-only and synthetic",
    (name) => {
      const html = details(snapshots[name]),
        text = narrative(html);
      expect(headline(html)).toContain("합성 연결시험");
      expect(text).toContain("실제 AI 성능·운영 견적을 뜻하지 않습니다");
      expect(text).toContain("전송 의도 기록은 공급자의 수신·청구 확인과 다릅니다");
      expect(text).toContain("생성 1회 + 검토 1회 · 자동 재시도 없음");
      expect(html).not.toMatch(/<(button|form)\b/);
      expect(headline(html)).not.toMatch(/품질 합격|벤처확인 승인|운영 준비 완료|실제 AI 완료/);
    },
  );
  it("shows a reserved amount without treating reservation consent as transmission approval", () => {
    const html = details(snapshots.reserved),
      text = narrative(html);
    expect(headline(html)).toContain("예약 기록");
    expect(text).toContain("예약 전용 동의");
    expect(text).toContain("미정산 예약 4");
    expect(text).not.toContain("별도 전송 승인 기록");
    expect(text).not.toContain("응답·사용량 보관");
  });
  it("keeps unknown usage visible instead of presenting zero as a free completed run", () => {
    const html = details(snapshots.unknown),
      text = narrative(html);
    expect(headline(html)).toContain("비용 확인 필요 · 중단");
    expect(text).toContain("미정산 예약 2");
    expect(text).toContain("비용 확정 전");
    expect(headline(html)).not.toContain("완료");
    expect(text).not.toContain("무료 실행");
  });
  it("shows a settled late response while preserving the original stop", () => {
    const html = details(snapshots.late),
      text = narrative(html);
    expect(headline(html)).toContain("늦은 응답 보관 · 비용 확인");
    expect(text).toContain("실행을 재개하거나 완료로 바꾸지 않습니다");
    expect(text).toContain("미정산 예약 0");
    expect(headline(html)).not.toContain("완료");
  });
  it("shows observed excess in full without granting another call", () => {
    const html = details(snapshots.overusage),
      text = narrative(html);
    expect(headline(html)).toContain("예약 상한 초과 · 중단");
    expect(text).toContain("확인된 사용량 비용 4");
    expect(text).toContain("미정산 예약 0");
    expect(html).not.toMatch(/<(button|form)\b/);
  });
  it("does not label interruption after response as a known bad plan", () => {
    // Display-only contract variant. Domain/ledger admissibility is tested by core/helper suites.
    const value = structuredClone(snapshots.completed);
    if (value.archiveFormatVersion !== 3) throw new Error("execution fixture required");
    const stop = value.events.find((event) => event.payload.kind === "execution-stopped");
    if (!stop || stop.payload.kind !== "execution-stopped") throw new Error("stop required");
    value.state = "output-invalid";
    stop.payload.outcome = "output-invalid";
    stop.payload.failureCode = "INTERRUPTED";
    stop.payload.finalArtifactSha256 = null;
    const html = details(value),
      text = narrative(html);
    expect(headline(html)).toContain("원고 검증 중단");
    expect(text).toContain("원고 내용이 잘못됐다는 뜻은 아닙니다");
    expect(headline(html)).not.toMatch(/검증 실패|원고 불량/);
  });
  it("uses the selected prefix time and does not expose later approval/response metadata", () => {
    const old = snapshots["completed-r0"],
      current = snapshots.completed;
    const oldHtml = details(old),
      currentHtml = details(current);
    expect(narrative(oldHtml)).toContain(`기록 r0 · 마지막 기록 시각 ${old.run.recordedAt}`);
    expect(narrative(currentHtml)).toContain(
      `기록 r${current.revision} · 마지막 기록 시각 ${current.events.at(-1)!.recordedAt}`,
    );
    expect(oldHtml).not.toContain(current.events.at(-1)!.eventDigest);
    expect(currentHtml).toContain(current.events.at(-1)!.eventDigest);
    expect(narrative(oldHtml)).not.toMatch(
      /별도 전송 승인 기록|응답·사용량 보관|출력 구조·근거 검증/,
    );
    expect(narrative(currentHtml)).toContain("별도 전송 승인 기록");
  });
  it("renders stored evidence as escaped text rather than active markup", () => {
    const value = structuredClone(snapshots.reserved);
    value.run.preparation.retention.notice = "<script>unexpected()</script>";
    const html = details(value);
    expect(html).toContain("&lt;script&gt;unexpected()&lt;/script&gt;");
    expect(html).not.toContain("<script>unexpected()</script>");
  });
});

describe("v2 empty and blocked panel", () => {
  it("requires a registered candidate and exposes no execution controls", () => {
    const html = renderToStaticMarkup(
      createElement(QualityProviderReviewPanel, { registry: null }),
    );
    expect(narrative(html)).toContain("먼저 보관한 후보 등록 버전을 열어 주세요");
    expect(narrative(html)).toContain("AI 호출·비용 예약이 없습니다");
    expect(html).not.toMatch(/<(button|select|form)\b/);
  });
  it("disables initial inspection until one exact candidate is selected", () => {
    const html = renderToStaticMarkup(createElement(QualityProviderReviewPanel, { registry }));
    expect(html.match(/<button\b[^>]*>/g)).toHaveLength(1);
    expect(html.match(/<button\b[^>]*>/)?.[0]).toContain('disabled=""');
    expect(html.match(/<select\b[^>]*>/)?.[0]).not.toContain('disabled=""');
    expect(narrative(html)).not.toMatch(/실제 실행 시작|전송 승인하기|예약 생성/);
  });
  it("respects a competing editor lock without hiding why inspection is unavailable", () => {
    const reason = "다른 평가 기록의 편집을 먼저 마쳐 주세요.";
    const html = renderToStaticMarkup(
      createElement(QualityProviderReviewPanel, { registry, blockedReason: reason }),
    );
    expect(narrative(html)).toContain(reason);
    expect(html.match(/<select\b[^>]*>/)?.[0]).toContain('disabled=""');
    for (const button of html.match(/<button\b[^>]*>/g) ?? [])
      expect(button).toContain('disabled=""');
    expect(html).not.toContain("<form");
  });
});
