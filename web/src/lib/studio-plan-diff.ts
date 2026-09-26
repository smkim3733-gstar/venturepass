import type { BusinessPlan } from "./studio-schema";

export const planDiffLimits = {
  lines: 400,
  cells: 40_000,
  spans: 400,
  text: 40_000,
  array: 200,
  totalText: 400_000,
} as const;

export type TextSpan = { kind: "same" | "added" | "removed"; text: string };
export type TextComparison = {
  state: "same" | "changed" | "limited";
  mode: "line" | "block" | "not-expanded";
  complete: boolean;
  spans: TextSpan[];
};

// Never split a surrogate pair when showing a bounded excerpt.
function prefix(text: string, length: number) {
  let end = Math.min(text.length, Math.max(0, length));
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return text.slice(0, end);
}

function blockDiff(left: string, right: string): TextSpan[] {
  const a = Array.from(left);
  const b = Array.from(right);
  let start = 0;
  let end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  const spans: TextSpan[] = [
    { kind: "same", text: a.slice(0, start).join("") },
    { kind: "removed", text: a.slice(start, a.length - end).join("") },
    { kind: "added", text: b.slice(start, b.length - end).join("") },
    { kind: "same", text: end ? a.slice(a.length - end).join("") : "" },
  ];
  return spans.filter((span) => span.text.length > 0);
}

export function compareTextExact(left: string, right: string): TextComparison {
  if (left.length + right.length > planDiffLimits.text)
    return { state: "limited", mode: "not-expanded", complete: false, spans: [] };
  if (left === right)
    return {
      state: "same",
      mode: "line",
      complete: true,
      spans: left ? [{ kind: "same", text: left }] : [],
    };
  // Preserve CRLF, LF, CR and the presence/absence of the final newline exactly.
  const a = left.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
  const b = right.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
  if (
    a.length > planDiffLimits.lines ||
    b.length > planDiffLimits.lines ||
    (a.length + 1) * (b.length + 1) > planDiffLimits.cells
  )
    return { state: "changed", mode: "block", complete: true, spans: blockDiff(left, right) };
  const width = b.length + 1;
  const table = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i * width + j] =
        a[i] === b[j]
          ? 1 + table[(i + 1) * width + j + 1]
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  const spans: TextSpan[] = [];
  function append(kind: TextSpan["kind"], text: string) {
    const last = spans[spans.length - 1];
    if (last?.kind === kind) last.text += text;
    else spans.push({ kind, text });
  }
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      append("same", a[i++]);
      j++;
    } else if (
      i < a.length &&
      (j === b.length || table[(i + 1) * width + j] >= table[i * width + j + 1])
    )
      append("removed", a[i++]);
    else append("added", b[j++]);
  }
  if (spans.length > planDiffLimits.spans)
    return { state: "changed", mode: "block", complete: true, spans: blockDiff(left, right) };
  return { state: "changed", mode: "line", complete: true, spans };
}

export type PlanChangeState = "same" | "added" | "removed" | "changed" | "ambiguous" | "limited";
export type PlanComparisonItem = {
  key: string;
  title: string;
  group: "content" | "context" | "review";
  state: PlanChangeState;
  left: string | null;
  right: string | null;
  leftLength: number;
  rightLength: number;
  orderOnly: boolean;
  note: string | null;
};
type PlanComparisonMetadata = Pick<BusinessPlan, "id" | "version" | "generatedAt">;
export type StoredPlanComparison = {
  status: "ready" | "not-selected" | "same-version" | "missing" | "ambiguous";
  complete: boolean;
  left: PlanComparisonMetadata | null;
  right: PlanComparisonMetadata | null;
  items: PlanComparisonItem[];
  warnings: string[];
};

type Value = { text: string | null; limited?: boolean; entries?: string[] };
function scalar(text: string | null): Value {
  return { text };
}
function list<T>(
  values: readonly T[] | undefined,
  format: (value: T) => unknown = (value) => value,
): Value {
  if (!values) return scalar(null);
  if (values.length > planDiffLimits.array)
    return { text: `항목 ${values.length}개 · 상세 표시 한도 초과`, limited: true };
  const entries: string[] = [];
  let length = 0;
  for (const original of values) {
    const value = format(original);
    // Bound nested arrays before serialization (review.sourceIds, section.evidence).
    let oversized = false;
    JSON.stringify(value, (_key, entry: unknown) => {
      if (Array.isArray(entry) && entry.length > planDiffLimits.array) {
        oversized = true;
        return null;
      }
      if (typeof entry === "string") length += entry.length;
      return length > planDiffLimits.text ? null : entry;
    });
    if (oversized || length > planDiffLimits.text)
      return { text: `항목 ${values.length}개 · 상세 표시 한도 초과`, limited: true };
    const serialized = JSON.stringify(value);
    entries.push(serialized);
  }
  return { text: entries.map((entry, i) => `${i + 1}. ${entry}`).join("\n"), entries };
}
function sameMembers(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((entry, i) => entry === b[i]);
}

export function compareStoredPlans(
  plans: readonly BusinessPlan[],
  selection: { leftPlanId: string; rightPlanId: string },
): StoredPlanComparison {
  const result: StoredPlanComparison = {
    status: "not-selected",
    complete: false,
    left: null,
    right: null,
    items: [],
    warnings: [],
  };
  if (!selection.leftPlanId || !selection.rightPlanId) return result;
  const a = plans.filter((plan) => plan.id === selection.leftPlanId);
  const b = plans.filter((plan) => plan.id === selection.rightPlanId);
  if (a.length > 1 || b.length > 1) return { ...result, status: "ambiguous" };
  if (a.length !== 1 || b.length !== 1) return { ...result, status: "missing" };
  if (a[0].id === b[0].id) return { ...result, status: "same-version" };
  const left = a[0];
  const right = b[0];
  const metadata = (plan: BusinessPlan): PlanComparisonMetadata => ({
    id: plan.id,
    version: plan.version,
    generatedAt: plan.generatedAt,
  });
  result.status = "ready";
  result.complete = true;
  result.left = metadata(left);
  result.right = metadata(right);
  let remaining = planDiffLimits.totalText as number;
  function add(
    key: string,
    title: string,
    l: Value,
    r: Value,
    group: PlanComparisonItem["group"] = "content",
    ambiguous = false,
  ) {
    const leftLength = l.text?.length ?? 0;
    const rightLength = r.text?.length ?? 0;
    const limit = Math.min(planDiffLimits.text, remaining);
    const limited = l.limited || r.limited || leftLength + rightLength > limit;
    let leftText = l.text;
    let rightText = r.text;
    if (leftLength + rightLength > limit) {
      const leftBudget = Math.min(leftLength, Math.floor(limit / 2));
      const rightBudget = Math.min(rightLength, limit - leftBudget);
      leftText = l.text === null ? null : prefix(l.text, Math.min(leftLength, limit - rightBudget));
      rightText = r.text === null ? null : prefix(r.text, rightBudget);
    }
    remaining -= (leftText?.length ?? 0) + (rightText?.length ?? 0);
    const state: PlanChangeState = ambiguous
      ? "ambiguous"
      : limited
        ? "limited"
        : l.text === r.text
          ? "same"
          : l.text === null
            ? "added"
            : r.text === null
              ? "removed"
              : "changed";
    if (ambiguous || limited) result.complete = false;
    result.items.push({
      key,
      title,
      group,
      state,
      left: leftText,
      right: rightText,
      leftLength,
      rightLength,
      orderOnly:
        !ambiguous &&
        !limited &&
        state === "changed" &&
        !!l.entries &&
        !!r.entries &&
        sameMembers(l.entries, r.entries),
      note: ambiguous
        ? "같은 항목 키가 중복되어 일대일로 연결하지 않았습니다. 배열 위치를 포함한 원문을 각각 확인하세요."
        : limited
          ? "표시·비교 한도를 넘었습니다. 생략된 범위를 원고 화면에서 직접 확인하세요."
          : null,
    });
  }
  add("title", "원고 제목", scalar(left.content.title), scalar(right.content.title));
  add("summary", "핵심 요약", scalar(left.content.summary), scalar(right.content.summary));
  const leftSections = left.content.sections;
  const rightSections = right.content.sections;
  add(
    "section-order",
    "항목 구성·순서",
    list(leftSections, (s) => s.key),
    list(rightSections, (s) => s.key),
  );
  if (leftSections.length > planDiffLimits.array || rightSections.length > planDiffLimits.array) {
    result.complete = false;
    result.warnings.push("항목 수가 한도를 넘어 항목별 비교를 생략했습니다.");
  } else {
    const keys = [...new Set([...leftSections, ...rightSections].map((section) => section.key))];
    for (const key of keys) {
      const ls = leftSections.flatMap((section, index) =>
        section.key === key ? [{ ...section, position: index + 1 }] : [],
      );
      const rs = rightSections.flatMap((section, index) =>
        section.key === key ? [{ ...section, position: index + 1 }] : [],
      );
      const itemTitle = (rs[0] ?? ls[0]).title;
      const path = `section:${JSON.stringify(key)}`;
      if (ls.length > 1 || rs.length > 1) {
        add(path, `${itemTitle} · 중복 항목`, list(ls), list(rs), "content", true);
        continue;
      }
      const l = ls[0];
      const r = rs[0];
      add(
        `${path}:title`,
        `${itemTitle} · 항목 제목`,
        scalar(l?.title ?? null),
        scalar(r?.title ?? null),
      );
      add(
        `${path}:body`,
        `${itemTitle} · 본문`,
        scalar(l?.content ?? null),
        scalar(r?.content ?? null),
      );
      add(
        `${path}:evidence`,
        `${itemTitle} · 연결 근거`,
        list(l?.evidence, (e) => ({ sourceId: e.sourceId, quote: e.quote, locator: e.locator })),
        list(r?.evidence, (e) => ({ sourceId: e.sourceId, quote: e.quote, locator: e.locator })),
      );
      add(
        `${path}:confirmation`,
        `${itemTitle} · 확인 필요 표시`,
        scalar(l ? (l.needsConfirmation ? "확인 필요" : "항목 확인 표시 있음") : null),
        scalar(r ? (r.needsConfirmation ? "확인 필요" : "항목 확인 표시 있음") : null),
      );
    }
  }
  add(
    "actions",
    "보강할 자료·실행 과제",
    list(left.content.actionItems),
    list(right.content.actionItems),
  );
  add(
    "questions",
    "실사 준비 질문",
    list(left.content.interviewQuestions),
    list(right.content.interviewQuestions),
  );
  add("candidate", "아이템 식별값", scalar(left.candidateId), scalar(right.candidateId), "context");
  add(
    "source-revision",
    "작성 기준 근거 버전",
    scalar(String(left.sourceRevision)),
    scalar(String(right.sourceRevision)),
    "context",
  );
  add("mode", "작성 방식", scalar(left.mode), scalar(right.mode), "context");
  add("generated", "작성 시각", scalar(left.generatedAt), scalar(right.generatedAt), "context");
  add(
    "confirmation",
    "현재 저장된 내부 검토 시각",
    scalar(left.confirmedAt ?? "내부 검토 기록 없음"),
    scalar(right.confirmedAt ?? "내부 검토 기록 없음"),
    "review",
  );
  const reviewEntry = (item: BusinessPlan["review"][number]) => ({
    id: item.id,
    severity: item.severity,
    category: item.category,
    message: item.message,
    action: item.action,
    sectionKey: item.sectionKey,
    sourceIds: item.sourceIds,
  });
  add(
    "review",
    "현재 저장된 검토 의견",
    list(left.review, reviewEntry),
    list(right.review, reviewEntry),
    "review",
  );
  if (left.candidateId !== right.candidateId)
    result.warnings.push("서로 다른 아이템에서 작성된 원고입니다.");
  return result;
}
