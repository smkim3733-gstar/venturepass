/** Public navigation only: never accepts company text, source objects or a free-form query. */
const topics = Object.freeze({
  manufacturing: "제조업",
  services: "서비스업",
  ict: "정보통신업",
  healthcare: "보건업",
  logistics: "운수업",
  ecommerce: "온라인쇼핑",
  energy: "신재생에너지",
  research: "연구개발",
});
export type PublicResearchTopic = keyof typeof topics;
export function publicResearchTopics() {
  return Object.entries(topics).map(([id, label]) => ({ id: id as PublicResearchTopic, label }));
}
export function publicStatisticsSearch(raw: unknown) {
  if (typeof raw !== "string" || !Object.hasOwn(topics, raw))
    throw Error("목록에서 공개 주제를 선택해 주세요.");
  const query = topics[raw as PublicResearchTopic];
  const url = new URL("https://kosis.kr/search/search.do");
  url.searchParams.set("query", query);
  return {
    topic: raw as PublicResearchTopic,
    query,
    href: url.href,
    provider: "KOSIS 국가통계포털" as const,
  };
}
/** Reject known discovery pages as original evidence; this is not a general source authenticity check. */
export function isPublicDiscoveryPage(raw: string) {
  try {
    const url = new URL(raw);
    if (!["kosis.kr", "www.kosis.kr"].includes(url.hostname)) return false;
    const path = decodeURIComponent(url.pathname).toLowerCase();
    return path === "/" || path === "/index/index.do" || path.startsWith("/search/");
  } catch {
    return false;
  }
}
