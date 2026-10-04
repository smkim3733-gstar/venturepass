import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import {
  publicResearchTopics,
  publicStatisticsSearch,
  isPublicDiscoveryPage,
} from "./studio-public-research";
import { emptyPublicEvidence, publicEvidenceDraftSchema } from "./studio-public-evidence";
import { PublicResearchLinks } from "@/components/studio/public-research-links";
it.each(publicResearchTopics())(
  "fixed topic $id sends only its public keyword to the official search origin",
  (topic) => {
    const value = publicStatisticsSearch(topic.id),
      url = new URL(value.href);
    expect(url.origin).toBe("https://kosis.kr");
    expect(url.pathname).toBe("/search/search.do");
    expect([...url.searchParams.entries()]).toEqual([["query", topic.label]]);
    expect(url.username + url.password + url.hash).toBe("");
  },
);
it.each([
  "PRIVATE_COMPANY",
  { topic: "manufacturing", company: "PRIVATE_COMPANY" },
  "manufacturing&query=PRIVATE",
  "__proto__",
  "constructor",
  [],
  null,
])("rejects arbitrary search or customer input %j", (input) => {
  expect(() => publicStatisticsSearch(input)).toThrow();
});
it("returns isolated options/results and does not let caller mutation change outbound queries", () => {
  const options = publicResearchTopics();
  Object.assign(options[0], { label: "PRIVATE" });
  options.splice(1);
  const result = publicStatisticsSearch("manufacturing");
  Object.assign(result, { query: "PRIVATE" });
  result.href = "https://evil.invalid";
  expect(publicStatisticsSearch("manufacturing").query).toBe("제조업");
  expect(publicResearchTopics()).toHaveLength(8);
});
it.each([
  "https://kosis.kr/search/search.do?query=a",
  "https://www.kosis.kr/SEARCH/search.do",
  "https://kosis.kr/%73earch/search.do",
  "https://kosis.kr/",
  "https://kosis.kr/index/index.do",
])("known discovery URL cannot be stored as original evidence %s", (url) => {
  expect(isPublicDiscoveryPage(url)).toBe(true);
  expect(
    publicEvidenceDraftSchema.safeParse({
      ...emptyPublicEvidence,
      title: "통계",
      url,
      quote: "수치",
      readOn: "2026-10-05",
    }).success,
  ).toBe(false);
});
it("allows an individual table URL without pretending it has been fetched or verified", () => {
  const url = "https://kosis.kr/statHtml/statHtml.do?orgId=101&tblId=SYNTHETIC";
  expect(isPublicDiscoveryPage(url)).toBe(false);
  expect(
    publicEvidenceDraftSchema.safeParse({
      ...emptyPublicEvidence,
      title: "합성 표",
      url,
      quote: "수치",
      readOn: "2026-10-05",
    }).success,
  ).toBe(true);
  expect(isPublicDiscoveryPage("https://kosis.kr.evil.invalid/search/search.do")).toBe(false);
});
it("SSR and disabled rendering have no outbound links, automatic search, or callbacks", () => {
  const fetchSpy = vi.fn(() => {
    throw Error("network forbidden");
  });
  vi.stubGlobal("fetch", fetchSpy);
  try {
    for (const disabled of [true, false]) {
      const html = renderToStaticMarkup(createElement(PublicResearchLinks, { disabled }));
      expect(html).not.toContain("href=");
      expect(html).toContain("자동 수집되지 않습니다");
      expect(html).not.toContain("checked=");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
