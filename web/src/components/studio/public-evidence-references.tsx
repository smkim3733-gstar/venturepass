import type { BusinessPlan, StudioCase } from "@/lib/studio-schema";
import {
  publicEvidenceExportEntries,
  PUBLIC_EVIDENCE_EXPORT_NOTICE,
  PUBLIC_EVIDENCE_EXPORT_TITLE,
} from "@/lib/studio-public-evidence-export";

/** Read only: the same manual-source projection as exports, for the exact saved plan. */
export function PublicEvidenceReferences({
  company,
  plan,
}: {
  company: StudioCase;
  plan: BusinessPlan;
}) {
  const stored = company.plans.filter((item) => item.id === plan.id);
  if (stored.length !== 1 || JSON.stringify(stored[0]) !== JSON.stringify(plan)) return null;
  const entries = publicEvidenceExportEntries(company, plan);
  if (!entries.length) return null;
  return (
    <details
      key={`${company.id}:${company.revision}:${plan.id}`}
      className="min-w-0 rounded-xl border p-4 text-sm [overflow-wrap:anywhere]"
      aria-label={`${PUBLIC_EVIDENCE_EXPORT_TITLE} · 원고 v${plan.version}`}
    >
      <summary className="cursor-pointer py-2 font-semibold">
        {PUBLIC_EVIDENCE_EXPORT_TITLE} · {entries.length}개
      </summary>
      <p className="mt-3 leading-6 text-muted-foreground">
        저장한 원고 v{plan.version}의 인용입니다. 아직 저장하지 않은 편집 내용은 포함하지 않습니다.
      </p>
      <p className="mt-2 leading-6 text-muted-foreground">{PUBLIC_EVIDENCE_EXPORT_NOTICE}</p>
      {entries.map((entry) => (
        <article key={entry.sourceId} className="mt-4 min-w-0 border-t pt-4">
          <h4 className="whitespace-pre-wrap font-semibold">{entry.title}</h4>
          <p className="mt-1 text-xs text-muted-foreground">
            {entry.parsed ? "담당자의 수동 출처 기록" : "수동 기록 형식 확인 필요"}
          </p>
          <div className="mt-3 space-y-2 leading-6">
            {entry.lines.map((line, index) => (
              <p key={index} className="whitespace-pre-wrap">
                {line}
              </p>
            ))}
          </div>
        </article>
      ))}
    </details>
  );
}
