"use client";

import { useState } from "react";
import { ArrowUpRight, ClipboardCheck, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  evaluationFocusItems,
  evaluationSources,
  visitPreparationItems,
} from "@/lib/evaluation-guide";
import type { StudioCase } from "@/lib/studio-schema";
import { EvidenceList } from "./evidence";
import { Notice, selectClass } from "./shared";

function GuideSources() {
  return (
    <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
      {evaluationSources.map((source) => (
        <a
          key={source.url}
          href={source.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 underline underline-offset-4"
        >
          {source.label}
          <ArrowUpRight className="size-3" />
        </a>
      ))}
    </div>
  );
}

export function EvaluationFocusGuide() {
  return (
    <details className="mb-6 rounded-2xl border bg-primary/[.025] p-5">
      <summary className="cursor-pointer text-sm font-semibold">
        심사에서 설명해야 할 내용과 증빙 보기
      </summary>
      <p className="mt-3 text-xs leading-6 text-muted-foreground">
        공식 심의 중점사항을 바탕으로 정리한 준비 안내입니다. 질문과 자료는 준비 예시이며, 개별
        기업의 평가 결과나 기관의 필수자료 목록이 아닙니다.
      </p>
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {evaluationFocusItems.map((item) => (
          <article key={item.id} className="min-w-0 rounded-xl border bg-white p-4">
            <h3 className="text-sm font-semibold">{item.title}</h3>
            <p className="mt-2 text-sm leading-6">{item.question}</p>
            <p className="mt-3 text-xs leading-6 text-muted-foreground">
              근거 예시: {item.evidence.join(" · ")}
            </p>
          </article>
        ))}
      </div>
      <GuideSources />
    </details>
  );
}

export function VisitPreparation({
  company,
  onPrepare,
}: {
  company: StudioCase;
  onPrepare: (title: string, notes: string) => void;
}) {
  const [planId, setPlanId] = useState(company.plans.at(-1)?.id || "");
  const plan = company.plans.find((item) => item.id === planId);
  const atLimit = company.tasks.length >= 200;
  function prepareButton(title: string, notes: string) {
    const existing = company.tasks.find(
      (item) => item.category === "visit" && item.title === title,
    );
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="mt-3"
        disabled={atLimit || !!existing}
        onClick={() => onPrepare(title, notes)}
      >
        {existing ? <ClipboardCheck /> : <Plus />}
        {existing
          ? existing.status === "done"
            ? "업무 완료 기록 있음"
            : "업무 등록됨"
          : "준비 업무 만들기"}
      </Button>
    );
  }
  return (
    <section aria-label="실사 준비 도우미" className="mt-6 rounded-2xl border p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-bold">제출 내용에서 현장 설명까지</h3>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            기술·사람·자료를 연결해 실사를 준비하세요. 기관에서 별도로 안내한 준비사항을 먼저
            확인하세요.
          </p>
        </div>
        <Badge variant="outline">실사 준비</Badge>
      </div>

      <details className="mt-4 rounded-xl border bg-muted/20 p-4">
        <summary className="cursor-pointer text-sm font-semibold">
          실사 준비목록 · {visitPreparationItems.length}가지
        </summary>
        <p className="mt-2 text-xs leading-6 text-muted-foreground">
          회사 상황에 따라 선택하는 준비 예시입니다. 기관의 공통 필수자료 목록은 아닙니다. 필요한
          항목을 업무로 등록하고 담당자·기한·확인 결과를 기록하세요.
        </p>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {visitPreparationItems.map((item) => (
            <article key={item.id} className="min-w-0 rounded-xl border bg-white p-4">
              <h4 className="text-sm font-semibold">{item.title}</h4>
              <p className="mt-2 whitespace-pre-wrap text-xs leading-6 text-muted-foreground">
                {item.notes}
              </p>
              {prepareButton(
                item.title,
                `${item.notes}\n\n담당자:\n확인할 자료·위치:\n기관 요청사항:\n준비 결과:`,
              )}
            </article>
          ))}
        </div>
      </details>

      <div className="mt-5 space-y-2">
        <Label htmlFor="visit-plan">실사 준비에 참고할 작성본</Label>
        <select
          id="visit-plan"
          className={selectClass}
          value={planId}
          onChange={(event) => setPlanId(event.target.value)}
          disabled={!company.plans.length}
        >
          <option value="">작성본 선택</option>
          {[...company.plans].reverse().map((item) => (
            <option key={item.id} value={item.id}>
              v{item.version} · {item.content.title}
            </option>
          ))}
        </select>
        <p className="text-xs leading-6 text-muted-foreground">
          앱은 기관에 실제 제출한 버전을 자동 확인하지 않습니다. 제출본·보완본과 같은 버전인지
          확인한 뒤 선택하세요.
        </p>
      </div>
      {plan ? (
        <div className="mt-4 space-y-4">
          <Notice tone="warning">
            v{plan.version} 작성 당시의 내용과 인용을 보여줍니다. 자료·인력·주소·개발 상태가
            바뀌었다면 변경 내용을 별도로 확인하세요. 예상 질문은 준비용이며 기관이 미리 제공한
            질문이 아닙니다.
          </Notice>
          <details className="rounded-xl border p-4">
            <summary className="cursor-pointer text-sm font-semibold">
              심사 관점별 작성 내용·연결 근거
            </summary>
            <p className="mt-2 text-xs leading-6 text-muted-foreground">
              작성 항목별로 모은 인용입니다. 해당 인용이 문장 전체를 입증하는지는 원본과 대조해야
              합니다.
            </p>
            <div className="mt-4 space-y-3">
              {evaluationFocusItems.map((focus) => {
                const sections = plan.content.sections.filter((section) =>
                  focus.sectionKeys.includes(section.key),
                );
                return (
                  <details key={focus.id} className="rounded-xl border bg-muted/15 p-4">
                    <summary className="cursor-pointer text-sm font-semibold">
                      {focus.title}
                    </summary>
                    <p className="mt-3 text-sm leading-6">{focus.question}</p>
                    <p className="mt-2 text-xs leading-6 text-primary">
                      현장 준비: {focus.visitAction}
                    </p>
                    {sections.map((section) => (
                      <div key={section.key} className="mt-4 min-w-0 border-t pt-4">
                        <h5 className="mb-2 text-xs font-semibold">{section.title}</h5>
                        <p className="mb-3 max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-muted-foreground">
                          {section.content}
                        </p>
                        <EvidenceList company={company} evidence={section.evidence} />
                      </div>
                    ))}
                  </details>
                );
              })}
            </div>
          </details>
          <details className="rounded-xl border p-4">
            <summary className="cursor-pointer text-sm font-semibold">
              작성본 기반 예상 질문 · {plan.content.interviewQuestions.length}개
            </summary>
            <div className="mt-4 space-y-3">
              {plan.content.interviewQuestions.map((question, index) => (
                <article key={`${plan.id}-${index}`} className="rounded-xl bg-muted/30 p-4">
                  <p className="whitespace-pre-wrap break-words text-sm leading-7">
                    {index + 1}. {question}
                  </p>
                  {prepareButton(
                    `v${plan.version} 실사 질문 ${index + 1}: ${question.slice(0, 180)}`,
                    `참고 작성본: v${plan.version} · ${plan.content.title}\n준비용 예상 질문: ${question}\n\n기관에 제출한 버전과 일치 여부:\n설명 담당자:\n답변 요점:\n원본 증빙·위치:\n추가 확인할 사항:`,
                  )}
                </article>
              ))}
              {!plan.content.interviewQuestions.length && (
                <p className="text-sm text-muted-foreground">
                  이 작성본에는 예상 질문이 없습니다. 심사 관점별 내용과 준비목록부터 확인하세요.
                </p>
              )}
            </div>
          </details>
        </div>
      ) : (
        <p className="mt-4 text-sm leading-6 text-muted-foreground">
          사업계획서를 작성하면 해당 작성본의 질문과 연결된 근거를 이곳에서 함께 확인할 수 있습니다.
        </p>
      )}
      {atLimit && (
        <p className="mt-3 text-xs text-destructive">
          기업당 업무 200개 한도에 도달했습니다. 기존 업무를 정리한 뒤 추가하세요.
        </p>
      )}
      <GuideSources />
    </section>
  );
}
