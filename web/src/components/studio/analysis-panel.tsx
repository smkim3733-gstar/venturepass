"use client";

import { ArrowRight, Check, CircleHelp, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyPanel, ModeBadge, Notice, PanelHeading, formatDate, type PanelProps } from "./shared";
import { EvidenceList } from "./evidence";
import { EvaluationFocusGuide } from "./evaluation-preparation";

export function AnalysisPanel({
  company,
  mutate,
  generate,
  goToPlan,
}: PanelProps & { generate: () => void; goToPlan: () => void }) {
  const analysis = company.analysis;
  const factLabels = {
    documented: "문서 근거",
    reported: "기업 설명",
    planned: "향후 계획",
    unverified: "확인 필요",
  };
  return (
    <div>
      <PanelHeading
        title="우리 기업에 맞는 신청 아이템"
        description="보유기술과 고객의 문제를 연결합니다. 추천 근거와 부족한 자료를 확인한 뒤 신청 아이템을 선택하세요."
        actions={
          <Button className="h-10" onClick={generate}>
            <Sparkles />
            {analysis ? "자료 다시 분석" : "아이템 분석 시작"}
          </Button>
        }
      />
      <EvaluationFocusGuide />
      {!analysis ? (
        <EmptyPanel
          title="회사의 강점에서 신청 아이템을 찾습니다"
          description="기업정보와 자료함을 분석하면 아이템 후보, 추천 이유, 추가로 확인할 질문이 이곳에 나타납니다."
        />
      ) : (
        <div className="space-y-6">
          <div className="rounded-2xl border bg-primary/[.035] p-5">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <h3 className="font-bold">기업 역량 분석</h3>
              <ModeBadge mode={analysis.mode} />
              <span className="text-xs text-muted-foreground">
                {formatDate(analysis.generatedAt)}
              </span>
            </div>
            <p className="whitespace-pre-wrap text-sm leading-7">{analysis.summary}</p>
          </div>
          {analysis.warnings.length > 0 && (
            <Notice tone="warning">
              <ul className="list-inside list-disc space-y-1">
                {analysis.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </Notice>
          )}
          <div className="grid gap-4">
            {analysis.candidates.map((candidate, index) => {
              const selected = candidate.id === company.selectedCandidateId;
              return (
                <article
                  key={candidate.id}
                  className={`overflow-hidden rounded-2xl border ${selected ? "border-primary/70 bg-primary/[.025] shadow-sm" : "bg-white"}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b p-5">
                    <div>
                      <div className="mb-2 text-xs font-semibold text-primary">
                        아이템 후보 {String(index + 1).padStart(2, "0")}
                      </div>
                      <h3 className="text-lg font-bold">{candidate.title}</h3>
                    </div>
                    <Button
                      variant={selected ? "secondary" : "outline"}
                      disabled={selected}
                      onClick={() =>
                        mutate({ action: "select-candidate", candidateId: candidate.id })
                      }
                    >
                      {selected ? <Check /> : <ArrowRight />}
                      {selected ? "선택한 아이템" : "이 아이템 선택"}
                    </Button>
                  </div>
                  <div className="grid gap-6 p-5 xl:grid-cols-[1fr_280px]">
                    <div className="space-y-4">
                      {[
                        ["고객의 문제", candidate.problem],
                        ["기술과 해결방법", candidate.solution],
                        ["차별성", candidate.differentiation],
                        ["대상 고객", candidate.targetCustomer],
                        [
                          "개발 단계·사업모델",
                          [candidate.stage, candidate.businessModel].filter(Boolean).join("\n"),
                        ],
                        ["추천 이유", candidate.recommendation],
                      ].map(([label, value]) => (
                        <div key={label}>
                          <h4 className="mb-1 text-xs font-semibold text-muted-foreground">
                            {label}
                          </h4>
                          <p className="whitespace-pre-wrap text-sm leading-7">
                            {value || "추가 확인이 필요합니다."}
                          </p>
                        </div>
                      ))}
                      {candidate.gaps.length > 0 && (
                        <div className="rounded-xl bg-amber-50 p-4">
                          <h4 className="mb-2 text-xs font-semibold text-amber-900">
                            아이템을 구체화할 자료
                          </h4>
                          <ul className="list-inside list-disc space-y-1 text-sm leading-6 text-amber-950">
                            {candidate.gaps.map((gap, item) => (
                              <li key={item}>{gap}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                    <aside>
                      <h4 className="mb-3 text-xs font-bold">추천에 사용한 근거</h4>
                      <EvidenceList company={company} evidence={candidate.evidence} />
                    </aside>
                  </div>
                </article>
              );
            })}
          </div>
          {analysis.facts.length > 0 && (
            <details className="rounded-2xl border p-5">
              <summary className="cursor-pointer font-semibold">
                자료에서 확인한 사실 {analysis.facts.length}개
              </summary>
              <div className="mt-4 space-y-4">
                {analysis.facts.map((fact) => (
                  <div key={fact.id} className="border-t pt-4">
                    <Badge variant="outline">{factLabels[fact.status]}</Badge>
                    <p className="my-3 text-sm leading-7">{fact.statement}</p>
                    <EvidenceList company={company} evidence={fact.evidence} />
                  </div>
                ))}
              </div>
            </details>
          )}
          {analysis.questions.length > 0 && (
            <section>
              <h3 className="mb-3 flex items-center gap-2 font-semibold">
                <CircleHelp className="size-5 text-primary" />
                대표·담당자에게 확인할 질문
              </h3>
              <p className="mb-4 text-sm text-muted-foreground">
                답변과 증빙을 기업정보 또는 자료함에 추가한 후 다시 분석해 주세요.
              </p>
              <div className="space-y-3">
                {analysis.questions.map((question, index) => (
                  <div key={question.id} className="flex gap-3 rounded-xl border p-4">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                      {index + 1}
                    </span>
                    <div>
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold">{question.question}</p>
                        {question.priority === "high" && (
                          <Badge variant="outline" className="border-amber-200 text-amber-800">
                            우선 확인
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs leading-6 text-muted-foreground">{question.reason}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
          {company.selectedCandidateId && (
            <div className="flex justify-end">
              <Button className="h-10" onClick={goToPlan}>
                선택한 아이템으로 사업계획서 작성
                <ArrowRight />
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
