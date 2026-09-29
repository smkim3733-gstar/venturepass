import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("No external access");
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
import { actualTestRegistry } from "@/lib/studio-plan-quality-actual-test-helpers";
import {
  createProviderConfigurationProposalView,
  getProviderConfigurationProposal,
} from "@/lib/studio-plan-quality-provider-configuration";
import {
  QualityProviderProposalDetails,
  QualityProviderExpiredDetails,
  qualityProviderMoney,
} from "./quality-provider-proposal-details";
import {
  providerReviewExpiredViewSchema,
  providerExpiredBlockerCodes,
  providerExpiredBlockerMessages,
} from "@/lib/studio-plan-quality-provider-review-types";

const registry = actualTestRegistry();
const proposal = () => {
  const value = createProviderConfigurationProposalView({
    registry,
    candidateId: registry.entries[0].candidateId,
    inspectedAt: "2026-09-26T23:58:00.000Z",
    configuration: getProviderConfigurationProposal(),
  });
  if (!value) throw new Error("Expected proposal fixture");
  return value;
};
const decode = (html: string) =>
  html
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("proposal details preserve approval and evidence boundaries", () => {
  it("shows internal expiry without reusing the previous model, reservation or transmission controls", () => {
    vi.stubGlobal("fetch", forbidden);
    const { proposal: previous, ...base } = proposal();
    const view = providerReviewExpiredViewSchema.parse({
      ...base,
      viewVersion: 3,
      state: "configuration-expired",
      inspectedAt: "2030-01-01T00:00:00.000Z",
      model: null,
      financialBasis: null,
      retention: null,
      expiry: {
        configurationDigest: previous.configurationDigest,
        validUntil: previous.sources[0].validUntil,
      },
      blockers: providerExpiredBlockerCodes.map((code) => ({
        code,
        message: providerExpiredBlockerMessages[code],
      })),
    });
    const html = renderToStaticMarkup(createElement(QualityProviderExpiredDetails, { view }));
    expect(html).toContain("내부 재확인 기한이 지났습니다");
    expect(html).toContain(view.expiry.validUntil);
    expect(html).toContain(view.expiry.configurationDigest);
    expect(html).toContain("공급자의 가격 보증일이 아닙니다");
    expect(html).not.toMatch(/<button|<form|USD|gpt-5\.4|전송할 내용/);
  });
  it("shows reservation calculation and proposed cap with no adopted budget or transmission control", () => {
    vi.stubGlobal("fetch", forbidden);
    const view = proposal();
    const html = renderToStaticMarkup(createElement(QualityProviderProposalDetails, { view }));
    expect(html).toContain("gpt-5.4-2026-03-05");
    expect(html).toContain("USD 11.22");
    expect(html).toContain("USD 5.61");
    expect(html).toContain("USD 15");
    expect(html).toContain("제안 누적 한도 · 미승인");
    expect(html).toContain("설정하거나 전송을 승인하지 않습니다");
    expect(html).toContain("실제 사용량·견적이나 모든");
    expect(html).not.toMatch(/<button|<form|승인 완료|예산 설정 완료/);
    expect(view.budget).toBeNull();
    expect(view.preparation).toBeNull();
    expect(view.transmissionManifest).toBeNull();
    expect(view.actualExecutionEnabled).toBe(false);
  });
  it("renders exact generation JSON and distinguishes the unfinished review derivation", () => {
    const view = proposal();
    const html = renderToStaticMarkup(createElement(QualityProviderProposalDetails, { view }));
    const pre = [...html.matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre>/g)].map((match) =>
      decode(match[1]),
    );
    expect(pre[0]).toBe(JSON.stringify(view.proposal.requestReview.generation.body));
    expect(JSON.parse(pre[1])).toEqual(view.proposal.requestReview.reviewTemplate);
    expect(html).toContain(view.proposal.requestReview.generation.sha256);
    expect(html).toContain("아직 생성되지");
    expect(html).toContain("않은 검토 본문을 확정하거나 승인한 것이 아닙니다");
    expect(html).toContain("https://api.openai.com/v1/responses");
    expect(html).toContain("등록한 합성 후보 한 건");
  });
  it("distinguishes curated evidence hashes, internal expiry and provider retention from zero retention", () => {
    const view = proposal();
    const html = renderToStaticMarkup(createElement(QualityProviderProposalDetails, { view }));
    expect(decode(html)).toContain(view.retention.notice);
    expect(html).toContain("30일");
    expect(html).toContain("24시간");
    expect(html).toContain("별도 원문 바이트 미보관");
    expect(html).toContain("공급자의 가격 보증일이 아닙니다");
    for (const source of view.proposal.sources) {
      expect(html).toContain(source.recordDigest);
      expect(html).toContain(source.reviewedAt);
      expect(html).toContain(source.validUntil);
      expect(html).toContain(`href="${source.url.replace(/&/g, "&amp;")}"`);
    }
    expect(html).not.toContain("보관하지 않습니다");
  });
  it("escapes source text without treating reviewed content as markup", () => {
    const view = proposal();
    view.proposal.sources[0].title = '<img src=x onerror="attack()">';
    view.proposal.sources[0].excerpt = "<script>attack()</script>";
    const html = renderToStaticMarkup(createElement(QualityProviderProposalDetails, { view }));
    expect(html).toContain("&lt;script&gt;attack()&lt;/script&gt;");
    expect(html).toContain("&lt;img");
    expect(html).not.toMatch(/<script|<img/);
  });
});

describe("exact financial display", () => {
  it.each([
    ["11220000", 6, "USD", "USD 11.22"],
    ["1", 6, "USD", "USD 0.000001"],
    ["0", 6, "USD", "USD 0"],
    ["100000000000000000001", 6, "USD", "USD 100,000,000,000,000.000001"],
    ["9007199254740993", 0, "KRW", "KRW 9,007,199,254,740,993"],
  ])("preserves %s scale %i without floating point", (units, scale, currency, expected) => {
    expect(qualityProviderMoney(units as string, scale as number, currency as string)).toBe(
      expected,
    );
  });
  it.each(["01", "-1", "1.5", "NaN", "1e6"])("rejects ambiguous units %s", (units) => {
    expect(() => qualityProviderMoney(units, 6, "USD")).toThrow();
  });
  it.each([-1, 13, 1.5, NaN])("rejects invalid scale %s", (scale) => {
    expect(() => qualityProviderMoney("1", scale, "USD")).toThrow();
  });
});
