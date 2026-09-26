import { describe, expect, it } from "vitest";
import type { BusinessPlan } from "./studio-schema";
import { compareStoredPlans, compareTextExact, planDiffLimits } from "./studio-plan-diff";

function plan(id: string, version = 1): BusinessPlan {
  return {
    id,
    version,
    generatedAt: "2026-09-25T00:00:00.000Z",
    mode: "assisted",
    candidateId: "candidate-one",
    sourceRevision: 1,
    confirmedAt: null,
    review: [],
    content: {
      title: "합성 원고",
      summary: "요약",
      sections: [
        {
          key: "technology",
          title: "기술",
          content: "첫째 줄\n둘째 줄\n",
          evidence: [{ sourceId: "synthetic-source", quote: "인용", locator: "1쪽" }],
          needsConfirmation: true,
        },
      ],
      actionItems: ["과제"],
      interviewQuestions: ["질문"],
    },
  };
}
function compare(left: BusinessPlan, right: BusinessPlan) {
  return compareStoredPlans([left, right], { leftPlanId: left.id, rightPlanId: right.id });
}
function reconstruct(left: string, right: string) {
  const result = compareTextExact(left, right);
  expect(result.complete).toBe(true);
  expect(
    result.spans
      .filter((span) => span.kind !== "added")
      .map((span) => span.text)
      .join(""),
  ).toBe(left);
  expect(
    result.spans
      .filter((span) => span.kind !== "removed")
      .map((span) => span.text)
      .join(""),
  ).toBe(right);
  return result;
}

describe("bounded exact text diff", () => {
  it.each([
    ["", ""],
    ["", "추가"],
    ["삭제", ""],
    ["same\n", "same\n"],
    ["공백", " 공백 "],
    ["a\r\nb\r", "a\nb\n"],
    ["마지막\n", "마지막"],
    ["🙂가🙂", "🙂나🙂"],
    ["<script>x()</script>", "<img onerror='x()'>"],
    ["가\n중복\n중복\n끝", "중복\n가\n중복\n끝"],
  ])("reconstructs both exact originals: %j -> %j", (left, right) => {
    reconstruct(left, right);
  });
  it("does not normalize Unicode or blank lines", () => {
    const result = reconstruct("é\n\n끝", "e\u0301\n끝");
    expect(result.state).toBe("changed");
  });
  it("uses a bounded block fallback above line/cell limits without losing text", () => {
    const left = Array.from({ length: 401 }, (_, i) => `${i}\n`).join("");
    const result = reconstruct(left, `${left}추가`);
    expect(result.mode).toBe("block");
    const cells = reconstruct("가\n".repeat(200), "나\n".repeat(200));
    expect(cells.mode).toBe("block");
    expect(cells.spans.length).toBeLessThanOrEqual(4);
  });
  it("block boundaries do not split an emoji sharing a high surrogate", () => {
    const repeated = "줄\n".repeat(401);
    const result = reconstruct(`${repeated}🙂끝`, `${repeated}🙃끝`);
    expect(result.spans.find((span) => span.kind === "removed")?.text).toBe("🙂");
    expect(result.spans.find((span) => span.kind === "added")?.text).toBe("🙃");
  });
  it("refuses oversized display even if both strings are identical", () => {
    const text = "a".repeat(planDiffLimits.text / 2 + 1);
    expect(compareTextExact(text, text)).toEqual({
      state: "limited",
      mode: "not-expanded",
      complete: false,
      spans: [],
    });
    expect(reconstruct(text.slice(1), text.slice(1)).state).toBe("same");
  });
  it("reconstructs many deterministic edits with bounded spans", () => {
    let seed = 11;
    const alphabet = ["가", "🙂", " ", "\r\n", "\n", "x", "<"];
    function text() {
      let output = "";
      for (let i = 0; i < 25; i++) {
        seed = (seed * 16807) % 2147483647;
        output += alphabet[seed % alphabet.length];
      }
      return output;
    }
    for (let i = 0; i < 100; i++)
      expect(reconstruct(text(), text()).spans.length).toBeLessThanOrEqual(planDiffLimits.spans);
  });
});

describe("stored plan comparison", () => {
  it("requires explicit distinct IDs from the supplied company's records", () => {
    const plans = [plan("one"), plan("two", 2)];
    expect(compareStoredPlans(plans, { leftPlanId: "", rightPlanId: "two" }).status).toBe(
      "not-selected",
    );
    expect(compareStoredPlans(plans, { leftPlanId: "one", rightPlanId: "one" }).status).toBe(
      "same-version",
    );
    expect(compareStoredPlans(plans, { leftPlanId: "foreign", rightPlanId: "two" }).status).toBe(
      "missing",
    );
    expect(
      compareStoredPlans([...plans, plan("one")], { leftPlanId: "one", rightPlanId: "two" }).status,
    ).toBe("ambiguous");
  });
  it("compares identical bodies without treating different version numbers as a body change", () => {
    const result = compare(plan("one"), plan("two", 2));
    expect(result.complete).toBe(true);
    expect(result.items.every((item) => item.state === "same")).toBe(true);
    expect(result.left?.id).toBe("one");
    expect(result.right?.version).toBe(2);
  });
  it("separates title, summary, evidence, confirmation and ordered lists", () => {
    const left = plan("one");
    const right = plan("two", 2);
    right.content.title = "새 제목";
    right.content.summary = "새 요약";
    right.content.sections[0].evidence[0].locator = "2쪽";
    right.content.sections[0].needsConfirmation = false;
    right.content.actionItems.push("추가 과제");
    right.content.interviewQuestions.push("추가 질문");
    const result = compare(left, right);
    for (const key of [
      "title",
      "summary",
      'section:"technology":evidence',
      'section:"technology":confirmation',
      "actions",
      "questions",
    ])
      expect(result.items.find((item) => item.key === key)?.state).toBe("changed");
    expect(result.items.find((item) => item.key.endsWith(":body"))?.state).toBe("same");
  });
  it("preserves duplicates and detects a pure reorder without fuzzy matching", () => {
    const left = plan("one");
    const right = plan("two");
    left.content.actionItems = ["A", "A", "B"];
    right.content.actionItems = ["B", "A", "A"];
    let item = compare(left, right).items.find((item) => item.key === "actions")!;
    expect(item.orderOnly).toBe(true);
    expect(item.left).toContain('2. "A"');
    right.content.actionItems = ["A", "B", "B"];
    item = compare(left, right).items.find((item) => item.key === "actions")!;
    expect(item.orderOnly).toBe(false);
  });
  it("treats renamed section keys as removal plus addition", () => {
    const left = plan("one");
    const right = plan("two");
    right.content.sections[0].key = "renamed";
    const result = compare(left, right);
    expect(result.items.find((item) => item.key === 'section:"technology":body')?.state).toBe(
      "removed",
    );
    expect(result.items.find((item) => item.key === 'section:"renamed":body')?.state).toBe("added");
  });
  it("marks duplicate section groups ambiguous, preserving all entries and other unique groups", () => {
    const left = plan("one");
    const right = plan("two");
    left.content.sections.push({
      ...left.content.sections[0],
      title: "중복 둘째",
      content: "둘째 본문",
    });
    right.content.sections.push({ ...right.content.sections[0], key: "unique", title: "독립" });
    const result = compare(left, right);
    const ambiguous = result.items.find((item) => item.state === "ambiguous")!;
    expect(result.complete).toBe(false);
    expect(ambiguous.left).toContain("둘째 본문");
    expect(ambiguous.left).toContain('"position":2');
    expect(
      result.items.some((item) => item.key === 'section:"unique":body' && item.state === "added"),
    ).toBe(true);
    expect(result.items.some((item) => item.key === 'section:"technology":body')).toBe(false);
  });
  it("keeps section order independent of unchanged body content", () => {
    const left = plan("one");
    const right = plan("two");
    left.content.sections.push({ ...left.content.sections[0], key: "second", title: "둘째" });
    right.content.sections = structuredClone(left.content.sections).reverse();
    const result = compare(left, right);
    expect(result.items.find((item) => item.key === "section-order")?.orderOnly).toBe(true);
    expect(
      result.items
        .filter((item) => item.key.endsWith(":body"))
        .every((item) => item.state === "same"),
    ).toBe(true);
  });
  it("records every review field and context separately from content", () => {
    const left = plan("one");
    const right = plan("two");
    right.candidateId = "candidate-two";
    right.sourceRevision = 2;
    right.mode = "manual";
    right.generatedAt = "2026-09-26T00:00:00.000Z";
    right.confirmedAt = right.generatedAt;
    right.review = [
      {
        id: "check",
        severity: "warning",
        category: "synthetic",
        message: "점검",
        action: "확인",
        sectionKey: "technology",
        sourceIds: ["source"],
      },
    ];
    const result = compare(left, right);
    expect(result.warnings).toEqual(["서로 다른 아이템에서 작성된 원고입니다."]);
    expect(
      result.items
        .filter((item) => item.group === "content")
        .every((item) => item.state === "same"),
    ).toBe(true);
    expect(result.items.find((item) => item.key === "review")?.right).toContain(
      '"sourceIds":["source"]',
    );
    expect(
      result.items
        .filter((item) => item.group !== "content")
        .every((item) => item.state === "changed"),
    ).toBe(true);
  });
  it("does not silently ignore excessive evidence or nested review arrays", () => {
    const left = plan("one");
    const right = plan("two");
    left.content.sections[0].evidence = Array.from({ length: 201 }, () => ({
      sourceId: "s",
      quote: "q",
      locator: "p",
    }));
    right.review = [
      {
        id: "r",
        severity: "info",
        category: "test",
        message: "m",
        action: "a",
        sectionKey: null,
        sourceIds: Array(201).fill("s"),
      },
    ];
    const result = compare(left, right);
    expect(result.complete).toBe(false);
    expect(result.items.find((item) => item.key.endsWith(":evidence"))?.state).toBe("limited");
    expect(result.items.find((item) => item.key === "review")?.state).toBe("limited");
  });
  it("caps total output and per-item excerpts without splitting a surrogate pair", () => {
    const left = plan("one");
    const right = plan("two");
    left.content.sections = Array.from({ length: 20 }, (_, i) => ({
      ...left.content.sections[0],
      key: String(i),
      content: "🙂".repeat(9000),
    }));
    right.content.sections = structuredClone(left.content.sections);
    const result = compare(left, right);
    expect(result.complete).toBe(false);
    expect(result.items.some((item) => item.state === "limited")).toBe(true);
    expect(
      result.items.reduce(
        (sum, item) => sum + (item.left?.length ?? 0) + (item.right?.length ?? 0),
        0,
      ),
    ).toBeLessThanOrEqual(planDiffLimits.totalText);
    for (const item of result.items) {
      expect((item.left?.length ?? 0) + (item.right?.length ?? 0)).toBeLessThanOrEqual(
        planDiffLimits.text,
      );
      for (const value of [item.left, item.right])
        expect(value ?? "").not.toMatch(/[\uD800-\uDBFF]$/);
    }
  });
  it("does not mutate either version, including review state", () => {
    const left = plan("one");
    const right = plan("two");
    const before = JSON.stringify([left, right]);
    compare(left, right);
    expect(JSON.stringify([left, right])).toBe(before);
  });
});
