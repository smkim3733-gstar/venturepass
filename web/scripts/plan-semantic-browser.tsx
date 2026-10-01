// Isolated test harness: imports real UI, has no database/API or application route.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PlanLanguagePanel } from "../src/components/studio/plan-language-panel";
import { PlanReviewPanel } from "../src/components/studio/plan-review-panel";
import { PlanReviewDecisions } from "../src/components/studio/plan-review-decisions";
import {
  semanticContrastCases,
  semanticContrastFixture,
} from "../src/lib/studio-plan-semantic-test-fixture";
import type { StudioMutation } from "../src/components/studio/shared";

function CaseView({ id }: { id: string }) {
  const [fixture] = useState(() => semanticContrastFixture(id));
  const [content, setContent] = useState(fixture.plan.content);
  const [section, setSection] = useState("");
  const [dirty, setDirty] = useState(false);
  const [requests, setRequests] = useState<StudioMutation[]>([]);
  const contentDirty = JSON.stringify(content) !== JSON.stringify(fixture.plan.content);
  return (
    <main>
      <h1>
        {fixture.item.id} · {fixture.item.title}
      </h1>
      <p>합성 사례 · 실제 UI 구성 요소의 격리 시험 · 저장은 모의 응답 · AI 결과/사람 승인 아님</p>
      <details open>
        <summary>원문과 기대 판단</summary>
        <blockquote data-testid="source">{fixture.item.sources[0].text}</blockquote>
        <p>{fixture.item.expected.reason}</p>
        <p>{fixture.item.expected.action}</p>
      </details>
      <label htmlFor="draft">합성 원고 편집</label>
      <textarea
        id="draft"
        value={content.sections[0].content}
        onChange={(event) => {
          const next = structuredClone(content);
          next.sections[0].content = event.target.value;
          setContent(next);
        }}
      />
      <output data-testid="section">{section}</output>
      <PlanLanguagePanel content={content} onSection={setSection} />
      <div data-testid="reviews">
        <PlanReviewPanel plan={fixture.plan} onSection={setSection} />
      </div>
      <PlanReviewDecisions
        company={fixture.company}
        plan={fixture.plan}
        blockedReason={contentDirty ? "원고 수정 내용을 먼저 저장하거나 취소해 주세요." : ""}
        onDirtyChange={setDirty}
        mutate={async (request) => {
          setRequests((previous) => [...previous, structuredClone(request)]);
          return null; // Exercise a missing acknowledgement; never fabricate a saved decision.
        }}
      />
      <output data-testid="dirty">{String(dirty)}</output>
      <pre data-testid="requests">{JSON.stringify(requests)}</pre>
      <details>
        <summary>원래 저장 원고 / 확인 상태</summary>
        <pre data-testid="original">{JSON.stringify(fixture.plan)}</pre>
      </details>
    </main>
  );
}
function Harness() {
  const [id, setId] = useState("K1");
  return (
    <>
      <nav>
        <label htmlFor="case">대비 사례 선택 </label>
        <select id="case" value={id} onChange={(event) => setId(event.target.value)}>
          {semanticContrastCases.map((item) => (
            <option key={item.id} value={item.id}>
              {item.id} · {item.title}
            </option>
          ))}
        </select>
      </nav>
      <CaseView key={id} id={id} />
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
