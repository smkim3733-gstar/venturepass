import { appealPreparationContext, type AppealPreparation } from "./studio-appeal-types";
import { isApplicationSubmission } from "./studio-application-types";
import { claimReviewContext } from "./studio-claim-review-types";
import { numericCheckContext } from "./studio-numeric-check-types";
import { responsePreparationContext } from "./studio-response-preparation-types";
import { visitAnswerContext } from "./studio-visit-answer-types";
import type { StudioCase } from "./studio-schema";

export const sourceImpactLimit = 2000;
export const sourceImpactStateLabels = {
  changed: "연결 자료 변경 확인 · 재확인 필요",
  unknown: "연결 정보 부족 · 직접 확인 필요",
  current: "등록 버전·인용 일치",
} as const;
export type SourceImpactState = keyof typeof sourceImpactStateLabels;
export const sourceImpactKindLabels = {
  candidate: "현재 후보",
  fact: "분석 기재 내용",
  "candidate-selection": "선택 당시 후보",
  "plan-section": "원고 항목",
  diagnosis: "사전진단 항목",
  "plan-review": "검토 의견 처리",
  claim: "주장 검토",
  appeal: "소명 준비 사유",
  response: "보완답변 준비 항목",
  visit: "실사 답변 대조",
  numeric: "수치 대조 항목",
  agency: "기관 기록에 연결한 원본",
  submission: "수동 제출 기록의 근거",
} as const;
export type SourceImpactKind = keyof typeof sourceImpactKindLabels;
export const sourceImpactReasonLabels = {
  SOURCE_MISSING: "당시 연결한 자료 ID가 현재 자료함에 없습니다.",
  SOURCE_AMBIGUOUS: "현재 자료 ID가 중복되어 고유한 자료를 찾을 수 없습니다.",
  VERSION_CHANGED: "연결 당시와 현재 자료의 수정 시각이 다릅니다.",
  METADATA_CHANGED: "연결 당시와 현재 자료의 이름·추출 상태·원본 메타정보가 다릅니다.",
  QUOTE_MISSING: "저장된 정확한 인용을 현재 등록 본문에서 찾을 수 없습니다.",
  BODY_PENDING: "현재 자료는 본문 미추출 상태입니다.",
  VERSION_UNAVAILABLE:
    "이 연결에는 자료 버전이 없습니다. 인용이 남아 있어도 최신 근거라고 판단하지 않습니다.",
  SNAPSHOT_UNAVAILABLE: "필요한 자료 스냅샷이 없거나 중복됩니다.",
  SNAPSHOT_CONFLICT: "저장된 자료 버전 연결끼리 일치하지 않습니다.",
  PROFILE_UNVERSIONED: "기업정보 기재 연결이며 자료별 버전을 대조할 수 없습니다.",
  ID_ONLY: "자료 ID만 연결되어 있고 인용·버전 정보가 없습니다.",
  AUXILIARY_UNAVAILABLE: "연결한 보조 기록이 없거나 중복되어 자료를 특정할 수 없습니다.",
  AUXILIARY_CHANGED: "보조 기록의 저장 버전 연결이 달라져 자료를 특정할 수 없습니다.",
  AUXILIARY_NO_SOURCE: "보조 기록에 자료별 직접 연결이 없어 관련 자료를 특정할 수 없습니다.",
} as const;
export type SourceImpactReason = keyof typeof sourceImpactReasonLabels;
export type SourceImpactTarget = {
  kind: SourceImpactKind;
  id: string;
  partId: string | null;
  version: number | null;
  planId: string | null;
  sectionKey: string | null;
};
export type SourceImpactDestination = {
  tab: "analysis" | "diagnosis" | "plan" | "workflow";
  target: SourceImpactTarget;
};
export type SourceImpactVia = {
  kind: "numeric" | "plan-review";
  id: string;
  version: number;
  partId: string | null;
};
export type SourceImpactUnresolved = {
  key: string;
  target: SourceImpactTarget;
  title: string;
  state: "unknown";
  reason: "AUXILIARY_UNAVAILABLE" | "AUXILIARY_CHANGED" | "AUXILIARY_NO_SOURCE";
  via: SourceImpactVia;
  destination: SourceImpactDestination;
};
export type SourceImpactRow = {
  key: string;
  sourceId: string;
  target: SourceImpactTarget;
  title: string;
  excerpt: string;
  state: SourceImpactState;
  reasons: SourceImpactReason[];
  binding: "versioned-reference" | "quote-only" | "source-id-only";
  recordedUpdatedAt: string | null;
  currentUpdatedAt: string | null;
  quote: string;
  locator: string;
  historical: boolean;
  context: "current" | "stale" | "missing" | "unknown";
  destination: SourceImpactDestination;
  via: SourceImpactVia | null;
};
export type SourceImpactProjection = {
  caseId: string;
  revision: number;
  groups: {
    sourceId: string;
    sourceName: string;
    sourcePresent: boolean;
    rows: SourceImpactRow[];
  }[];
  counts: Record<SourceImpactState, number>;
  truncated: boolean;
  unresolved: SourceImpactUnresolved[];
};

type SourceSnapshot = AppealPreparation["sourceSnapshots"][number];
type Reference = {
  sourceId: string;
  sourceUpdatedAt?: string | null;
  sourceName?: string | null;
  quote?: string;
  locator?: string;
};
type Edge = {
  target: SourceImpactTarget;
  title: string;
  excerpt?: string;
  reference: Reference | null;
  via?: SourceImpactVia;
  unresolvedReason?: SourceImpactUnresolved["reason"];
  snapshots?: SourceSnapshot[];
  original?: { originalName: string; mimeType: string | null };
  historical?: boolean;
  context?: SourceImpactRow["context"];
  tab: SourceImpactDestination["tab"];
};
const target = (
  kind: SourceImpactKind,
  id: string,
  partId: string | null = null,
  version: number | null = null,
  planId: string | null = null,
  sectionKey: string | null = null,
): SourceImpactTarget => ({ kind, id, partId, version, planId, sectionKey });
const excerpt = (text: string) => (text.length > 300 ? `${text.slice(0, 300)}…` : text);
function latestIds<T extends { id: string }>(items: T[], root: (item: T) => string) {
  const roots = new Map<string, string>();
  for (const item of items) roots.set(root(item), item.id);
  return new Set(roots.values());
}

/** Explicit links only. A section-level reference does not identify an affected sentence. */
function* edges(company: StudioCase): Generator<Edge> {
  const analysis = company.analysis;
  if (analysis) {
    for (const candidate of analysis.candidates)
      for (const reference of candidate.evidence)
        yield {
          target: target("candidate", candidate.id),
          title: candidate.title,
          reference,
          tab: "analysis",
        };
    for (const fact of analysis.facts)
      for (const reference of fact.evidence)
        yield {
          target: target("fact", fact.id),
          title: "분석 기재 내용",
          excerpt: fact.statement,
          reference,
          tab: "analysis",
        };
  }
  for (const selection of company.candidateSelections ?? []) {
    for (const [partId, candidate] of [
      ["selected", selection.candidate],
      ["previous", selection.previousCandidate],
    ] as const) {
      if (!candidate) continue;
      for (const reference of candidate.evidence)
        yield {
          target: target("candidate-selection", selection.id, `${partId}:${candidate.id}`),
          title: candidate.title,
          reference,
          tab: "analysis",
          historical: true,
        };
    }
  }
  const latestPlanVersion = Math.max(0, ...company.plans.map((plan) => plan.version));
  for (const plan of company.plans)
    for (const section of plan.content.sections)
      for (const reference of section.evidence)
        yield {
          target: target("plan-section", plan.id, section.key, plan.version, plan.id, section.key),
          title: section.title,
          reference,
          tab: "plan",
          historical: plan.version !== latestPlanVersion,
        };
  for (const diagnosis of company.diagnoses ?? [])
    for (const item of diagnosis.items)
      for (const reference of item.evidence)
        yield {
          target: target("diagnosis", diagnosis.id, item.id, diagnosis.version),
          title: item.title,
          reference,
          context: diagnosis.stale ? "stale" : "current",
          historical: diagnosis.id !== company.diagnoses.at(-1)?.id,
          tab: "diagnosis",
        };
  const latestReviews = latestIds(company.planReviewDecisions ?? [], (record) => record.rootId);
  for (const record of company.planReviewDecisions ?? [])
    for (const sourceId of record.finding.sourceIds)
      yield {
        target: target(
          "plan-review",
          record.id,
          String(record.findingIndex),
          record.version,
          record.planId,
          record.finding.sectionKey,
        ),
        title: record.finding.category || "검토 의견",
        excerpt: record.finding.message,
        reference: { sourceId },
        context: record.stale ? "stale" : "current",
        historical: !latestReviews.has(record.id),
        tab: "plan",
      };
  const latestClaims = latestIds(company.claimReviews ?? [], (record) => record.claimId);
  for (const record of company.claimReviews ?? []) {
    const context = claimReviewContext(company, record).state;
    const claimEdge = {
      target: target(
        "claim",
        record.id,
        record.claimId,
        record.version,
        record.planId,
        record.sectionKey,
      ),
      title: "주장 검토",
      excerpt: record.claimQuote,
      context,
      historical: !latestClaims.has(record.id),
      tab: "plan" as const,
    };
    for (const reference of record.references)
      yield { ...claimEdge, reference, snapshots: record.sourceSnapshots };
    // Follow only explicit record ID/version links, never text similarity or section meaning.
    for (const kind of ["numeric", "plan-review"] as const) {
      for (const linked of kind === "numeric"
        ? record.numericReferences
        : record.planReviewReferences) {
        const matches =
          kind === "numeric"
            ? company.numericChecks.filter((item) => item.id === linked.id)
            : company.planReviewDecisions.filter((item) => item.id === linked.id);
        const bindings = record.auxiliarySnapshots.filter(
          (item) => item.kind === kind && item.id === linked.id,
        );
        const via: SourceImpactVia = { kind, id: linked.id, version: linked.version, partId: null };
        if (matches.length !== 1 || bindings.length !== 1) {
          yield { ...claimEdge, reference: null, via, unresolvedReason: "AUXILIARY_UNAVAILABLE" };
          continue;
        }
        const auxiliary = matches[0],
          binding = bindings[0];
        if (
          auxiliary.version !== linked.version ||
          binding.version !== linked.version ||
          auxiliary.inputDigest !== binding.inputDigest ||
          auxiliary.recordedAt !== binding.recordedAt ||
          ("planId" in auxiliary &&
            (auxiliary.planId !== record.planId || auxiliary.planVersion !== record.planVersion))
        ) {
          yield { ...claimEdge, reference: null, via, unresolvedReason: "AUXILIARY_CHANGED" };
          continue;
        }
        let foundSource = false;
        if ("observations" in auxiliary) {
          for (const observation of auxiliary.observations) {
            if (observation.reference?.kind !== "source") continue;
            foundSource = true;
            yield {
              ...claimEdge,
              reference: observation.reference,
              snapshots: auxiliary.sourceSnapshots,
              via: { ...via, partId: observation.id },
            };
          }
        } else {
          for (const sourceId of auxiliary.finding.sourceIds) {
            foundSource = true;
            yield {
              ...claimEdge,
              reference: { sourceId },
              via: { ...via, partId: String(auxiliary.findingIndex) },
            };
          }
        }
        if (!foundSource)
          yield { ...claimEdge, reference: null, via, unresolvedReason: "AUXILIARY_NO_SOURCE" };
      }
    }
  }
  const latestAppeals = latestIds(
    company.appealPreparations ?? [],
    (record) => record.preparationId,
  );
  for (const record of company.appealPreparations ?? []) {
    const context = appealPreparationContext(company, record).state;
    for (const reason of record.reasons)
      for (const reference of [...reason.evidence, ...reason.additionalEvidence])
        yield {
          target: target(
            "appeal",
            record.id,
            reason.id,
            record.version,
            reason.planClaim?.planId ?? null,
            reason.planClaim?.sectionKey ?? null,
          ),
          title: record.title,
          excerpt: reason.claim,
          reference,
          snapshots: record.sourceSnapshots,
          context,
          historical: !latestAppeals.has(record.id),
          tab: "workflow",
        };
  }
  const latestResponses = latestIds(
    company.responsePreparations ?? [],
    (record) => record.preparationId,
  );
  for (const record of company.responsePreparations ?? []) {
    const context = responsePreparationContext(company, record).state;
    for (const item of record.items)
      for (const reference of item.evidence)
        yield {
          target: target(
            "response",
            record.id,
            item.id,
            record.version,
            item.planClaim?.planId ?? null,
            item.planClaim?.sectionKey ?? null,
          ),
          title: item.summary,
          excerpt: item.draft,
          reference,
          snapshots: record.sourceSnapshots,
          context,
          historical: !latestResponses.has(record.id),
          tab: "workflow",
        };
  }
  const latestVisits = latestIds(company.visitAnswers ?? [], (record) => record.answerId);
  for (const record of company.visitAnswers ?? []) {
    const context = visitAnswerContext(company, record).state;
    for (const pair of record.pairs)
      for (const reference of pair.sources)
        yield {
          target: target(
            "visit",
            record.id,
            pair.id,
            record.version,
            record.planId,
            pair.planReference?.sectionKey ?? null,
          ),
          title: record.questionText,
          excerpt: pair.answerQuote,
          reference,
          snapshots: record.sourceSnapshots,
          context,
          historical: !latestVisits.has(record.id),
          tab: "workflow",
        };
  }
  const latestNumbers = latestIds(company.numericChecks ?? [], (record) => record.checkId);
  for (const record of company.numericChecks ?? []) {
    const context = numericCheckContext(company, record).state;
    for (const observation of record.observations)
      if (observation.reference?.kind === "source")
        yield {
          target: target("numeric", record.id, observation.id, record.version),
          title: observation.label,
          reference: observation.reference,
          snapshots: record.sourceSnapshots,
          context,
          historical: !latestNumbers.has(record.id),
          tab: "plan",
        };
  }
  for (const record of company.agencyRecords ?? [])
    for (const saved of record.evidence)
      yield {
        target: target("agency", record.id, saved.sourceId, record.version),
        title: record.title,
        reference: {
          sourceId: saved.sourceId,
          sourceUpdatedAt: saved.sourceUpdatedAt,
          sourceName: saved.sourceName,
        },
        original: saved,
        historical: true,
        tab: "workflow",
      };
  for (const record of company.applicationEvents ?? []) {
    if (!isApplicationSubmission(record)) continue;
    for (const reference of record.evidence)
      yield {
        target: target(
          "submission",
          record.id,
          reference.sectionKey,
          record.version,
          record.plan.id,
          reference.sectionKey,
        ),
        title: "수동 제출 당시 근거",
        reference,
        historical: true,
        tab: "workflow",
      };
    for (const saved of record.originals)
      yield {
        target: target(
          "submission",
          record.id,
          `original:${saved.sourceId}`,
          record.version,
          record.plan.id,
        ),
        title: "수동 제출 당시 선택 원본",
        reference: {
          sourceId: saved.sourceId,
          sourceUpdatedAt: saved.sourceUpdatedAt,
          sourceName: saved.sourceName,
        },
        original: saved,
        historical: true,
        tab: "workflow",
      };
  }
}

function inspectEdge(company: StudioCase, edge: Edge, ref: Reference) {
  const sources = company.sources.filter((source) => source.id === ref.sourceId);
  const source = sources.length === 1 ? sources[0] : undefined;
  const snapshots = edge.snapshots?.filter((saved) => saved.sourceId === ref.sourceId);
  const snapshot = snapshots?.length === 1 ? snapshots[0] : undefined;
  const recordedUpdatedAt = ref.sourceUpdatedAt || snapshot?.sourceUpdatedAt || null;
  const reasons: SourceImpactReason[] = [];
  const binding: SourceImpactRow["binding"] = recordedUpdatedAt
    ? "versioned-reference"
    : ref.quote
      ? "quote-only"
      : "source-id-only";
  let state: SourceImpactState = "current";
  if (ref.sourceId === "profile") {
    state = "unknown";
    reasons.push("PROFILE_UNVERSIONED");
  } else if (sources.length > 1) {
    state = "unknown";
    reasons.push("SOURCE_AMBIGUOUS");
  } else if (edge.snapshots && snapshots?.length !== 1) {
    state = "unknown";
    reasons.push("SNAPSHOT_UNAVAILABLE");
  } else if (snapshot && ref.sourceUpdatedAt && snapshot.sourceUpdatedAt !== ref.sourceUpdatedAt) {
    state = "unknown";
    reasons.push("SNAPSHOT_CONFLICT");
  } else if (!source) {
    state = recordedUpdatedAt ? "changed" : "unknown";
    reasons.push("SOURCE_MISSING");
  } else {
    if (recordedUpdatedAt && source.updatedAt !== recordedUpdatedAt)
      reasons.push("VERSION_CHANGED");
    if (
      (snapshot &&
        (source.name !== snapshot.sourceName ||
          source.extraction !== snapshot.extraction ||
          source.originalName !== (snapshot.original?.originalName ?? null) ||
          (snapshot.original && source.mimeType !== snapshot.original.mimeType))) ||
      (ref.sourceName && ref.sourceName !== source.name) ||
      (edge.original &&
        (source.originalName !== edge.original.originalName ||
          source.mimeType !== edge.original.mimeType))
    )
      reasons.push("METADATA_CHANGED");
    if (ref.quote) {
      if (source.extraction === "pending") reasons.push("BODY_PENDING");
      else if (!source.text.includes(ref.quote)) reasons.push("QUOTE_MISSING");
    }
    if (reasons.length) state = "changed";
    else if (!recordedUpdatedAt) {
      state = "unknown";
      reasons.push(ref.quote ? "VERSION_UNAVAILABLE" : "ID_ONLY");
    }
  }
  return {
    state,
    reasons,
    binding,
    recordedUpdatedAt,
    currentUpdatedAt: source?.updatedAt ?? null,
  };
}

/** No network, hashing, original-file reads, inference, or mutation. 'current' means registered metadata/quote checks only. */
export function buildSourceImpact(company: StudioCase): SourceImpactProjection {
  const groups = new Map<string, SourceImpactProjection["groups"][number]>();
  for (const source of company.sources)
    if (!groups.has(source.id))
      groups.set(source.id, {
        sourceId: source.id,
        sourceName: source.name,
        sourcePresent: true,
        rows: [],
      });
  const counts: SourceImpactProjection["counts"] = { current: 0, changed: 0, unknown: 0 };
  const unresolved: SourceImpactUnresolved[] = [];
  let count = 0;
  let truncated = false;
  const seen = new Set<string>();
  for (const edge of edges(company)) {
    const key = JSON.stringify([edge.target, edge.reference, edge.via]);
    if (seen.has(key)) continue;
    if (count >= sourceImpactLimit) {
      truncated = true;
      break;
    }
    seen.add(key);
    count += 1;
    if (!edge.reference) {
      if (edge.via && edge.unresolvedReason) {
        unresolved.push({
          key: `impact-${count}`,
          target: edge.target,
          title: edge.title,
          state: "unknown",
          reason: edge.unresolvedReason,
          via: edge.via,
          destination: { tab: edge.tab, target: edge.target },
        });
        counts.unknown += 1;
      }
      continue;
    }
    const inspected = inspectEdge(company, edge, edge.reference);
    const row: SourceImpactRow = {
      key: `impact-${count}`,
      sourceId: edge.reference.sourceId,
      target: edge.target,
      title: excerpt(edge.title),
      excerpt: excerpt(edge.excerpt ?? ""),
      ...inspected,
      quote: excerpt(edge.reference.quote ?? ""),
      locator: edge.reference.locator ?? "",
      historical: edge.historical ?? false,
      context: edge.context ?? "unknown",
      destination: { tab: edge.tab, target: edge.target },
      via: edge.via ?? null,
    };
    const group = groups.get(row.sourceId) ?? {
      sourceId: row.sourceId,
      sourceName:
        row.sourceId === "profile"
          ? "기업정보 기재"
          : edge.reference.sourceName || "현재 자료함에 없는 연결",
      sourcePresent: false,
      rows: [],
    };
    group.rows.push(row);
    groups.set(row.sourceId, group);
    counts[row.state] += 1;
  }
  const rank = { changed: 0, unknown: 1, current: 2 };
  for (const group of groups.values()) group.rows.sort((a, b) => rank[a.state] - rank[b.state]);
  return {
    caseId: company.id,
    revision: company.revision,
    groups: [...groups.values()],
    counts,
    truncated,
    unresolved,
  };
}

/** Recompute membership before navigation; do not redirect an old target to a newer record. */
export function sourceImpactDestinationExists(
  company: StudioCase,
  destination: SourceImpactDestination,
): boolean {
  const projection = buildSourceImpact(company);
  const exact = (row: { destination: SourceImpactDestination }) =>
    JSON.stringify(row.destination) === JSON.stringify(destination);
  return (
    projection.unresolved.some(exact) || projection.groups.some((group) => group.rows.some(exact))
  );
}

export function sourceImpactNavigationIsCurrent(
  company: StudioCase,
  input: { caseId: string; revision: number; destination: SourceImpactDestination },
): boolean {
  return (
    company.id === input.caseId &&
    company.revision === input.revision &&
    sourceImpactDestinationExists(company, input.destination)
  );
}
