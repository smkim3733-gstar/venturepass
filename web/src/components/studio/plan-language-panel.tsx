"use client";

import { Badge } from "@/components/ui/badge";
import { planLanguageSuggestions } from "@/lib/studio-plan-editorial";
import type { PlanContent } from "@/lib/studio-schema";

export function PlanLanguagePanel({
  content,
  onSection,
}: {
  content: PlanContent;
  onSection: (key: string) => void;
}) {
  const suggestions = planLanguageSuggestions(content);
  return (
    <section aria-label="한국어 표현 점검" className="rounded-2xl border bg-muted/25 p-4">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-bold">
        한국어 표현 점검 <Badge variant="secondary">{suggestions.length}</Badge>
      </h3>
      <p className="text-xs leading-6 text-muted-foreground">
        편집 중인 원고에서 분류용 영어 표현을 찾습니다. 문맥에 맞게 직접 수정하고, 인용 원문과
        고유명사는 유지해 주세요. 문서 기재나 담당자 설명을 사실 확인 완료로 바꾸지 않습니다.
      </p>
      {suggestions.length === 0 ? (
        <p className="mt-3 text-xs leading-6 text-muted-foreground">
          점검 대상 영어 표현이 없습니다. 문장 의미와 사실관계는 별도로 확인해 주세요.
        </p>
      ) : (
        <ul className="mt-3 max-h-80 space-y-3 overflow-y-auto">
          {suggestions.map((item, index) => (
            <li key={index} className="rounded-xl border bg-white p-3 text-xs leading-6">
              <p className="font-semibold">{item.location}</p>
              <p>
                <code>{item.term}</code> · {item.count}곳
              </p>
              <p className="text-muted-foreground">표현 예: {item.suggestion}</p>
              {item.sectionKey !== null && (
                <button
                  type="button"
                  className="mt-1 font-semibold text-primary hover:underline"
                  onClick={() => onSection(item.sectionKey!)}
                >
                  해당 항목 보기 →
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
