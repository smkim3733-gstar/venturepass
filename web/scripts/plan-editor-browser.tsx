// Browser-only synthetic harness for the actual PlanEditor. No database, key or API.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PlanEditor } from "../src/components/studio/plan-editor";
import { semanticContrastFixture } from "../src/lib/studio-plan-semantic-test-fixture";
import { caseSchema } from "../src/lib/studio-schema";
import type { StudioMutation } from "../src/components/studio/shared";

function initial() {
  const { company } = semanticContrastFixture("R1");
  const main = company.plans[0];
  main.version = 2;
  main.content.title = "future-proposal 원고";
  main.content.summary =
    "현재 후보(current). 문서 기재(documented), 담당자 설명(reported), 향후 계획(planned), 근거 미확인(unverified).";
  main.content.sections = [
    {
      key: "problem",
      title: "고객 문제",
      content: "합성 고객 설명",
      evidence: [],
      needsConfirmation: true,
    },
    {
      key: "funding",
      title: "unknown 자금 계획",
      content: "reported 자금 메모, 현재 가용성은 확인 필요.",
      evidence: [{ sourceId: "synthetic", quote: "reported는 인용 원문", locator: "합성 인용" }],
      needsConfirmation: false,
    },
  ];
  main.content.actionItems = ["근거 메모 대조", "planned 비용 점검"];
  main.content.interviewQuestions = ["unverified 권리는?"];
  const old = structuredClone(main);
  old.id = "00000000-0000-4000-8000-000000000403";
  old.version = 1;
  old.content.title = "이전 한국어 원고";
  company.plans.unshift(old);
  return caseSchema.parse(company);
}
const baseline = initial();
function Harness() {
  const [company, setCompany] = useState(() => structuredClone(baseline));
  const [dirty, setDirty] = useState(false);
  const [requests, setRequests] = useState<StudioMutation[]>([]);
  const [ack, setAck] = useState("missing");
  const [epoch, setEpoch] = useState(0);
  return (
    <main>
      <h1>합성 입력 · 실제 편집기 · 저장 응답 모의 · 사람 승인 아님</h1>
      <button
        id="reset"
        onClick={() => {
          setCompany(structuredClone(baseline));
          setRequests([]);
          setDirty(false);
          setEpoch(epoch + 1);
        }}
      >
        시험 초기화
      </button>
      <select id="ack" value={ack} onChange={(e) => setAck(e.target.value)}>
        <option value="missing">저장 응답 없음</option>
        <option value="saved">저장 응답 반환</option>
      </select>
      <PlanEditor
        key={epoch + ":" + company.revision}
        company={company}
        setDirty={setDirty}
        mutate={async (request) => {
          setRequests((previous) => [...previous, structuredClone(request)]);
          if (ack === "missing" || request.action !== "save-plan") return null;
          const old = company.plans.find((p) => p.id === request.planId)!;
          const next = caseSchema.parse({
            ...company,
            revision: company.revision + 1,
            plans: [
              ...company.plans,
              {
                ...old,
                id: "00000000-0000-4000-8000-000000000404",
                version: 3,
                mode: "manual",
                content: structuredClone(request.content),
                confirmedAt: null,
              },
            ],
          });
          setCompany(next);
          return next;
        }}
        generate={() => {
          throw new Error("Generation not permitted in this harness");
        }}
        goToAnalysis={() => {}}
        onBusyChange={() => {}}
      />
      <pre data-testid="requests" hidden>
        {JSON.stringify(requests)}
      </pre>
      <pre data-testid="saved" hidden>
        {JSON.stringify(company)}
      </pre>
      <output data-testid="dirty" hidden>
        {String(dirty)}
      </output>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
