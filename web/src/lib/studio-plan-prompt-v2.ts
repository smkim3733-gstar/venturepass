import type { PlanPromptDefinition } from "./studio-plan-prompt-versions";
import { getV1PlanPromptDefinition } from "./studio-plan-prompt-v1";

// A separate revision; changes here never rewrite the archived v1 instructions or schemas.
const proseInstructions = `독자에게 보이는 제목·요약·항목 본문·보강 과제·실사 준비 질문은 자연스러운 한국어로 작성한다. documented는 "문서에 기재됨", reported는 "담당자 설명", planned는 "향후 계획", unverified는 "근거 미확인"의 의미로 설명하고 사실 확인 완료로 바꾸지 않는다. current/evidence-needed/future-proposal/unknown과 classification도 본문에서 회사의 현재 설명·증빙 확인 필요·향후 제안·분류 미확인의 의미로 풀어 쓴다. 이 규칙은 구조화 enum/key/sourceId/locator를 번역하거나 evidence.quote 원문·고유명사를 치환하라는 뜻이 아니다.
자금 메모·잔액·자기자금 배정은 원문의 기준일과 기재 범위에 한정한다. 단순 잔액 메모만으로 현재 가용 현금·용도 제한 없음·다른 집행 의무 없음·집행 가능·외부 조달 불필요·조달 확정·투자 적정성을 단정하지 않는다. 관련 증빙이 있으면 확인되는 범위만 설명하고, 가용성·집행 의무·조달 시기 등이 확인되지 않으면 필요한 확인 질문으로 남긴다. 모든 자금이 불확실하다고 일괄 단정하지도 않는다.
제공된 자료에 없는 실사 빈도·기관 선호·심사에 유리함·일률적 현장 필수요건을 만들지 않는다. 실사 준비 제안과 확인 질문은 실제 기관의 확정 질문이나 요구와 구분한다. 원문에 없는 현장 상태를 사실로 쓰지 않는다.`;

const generationInstructions = `제출 준비용 원고에서 내부 영어 분류값을 독자가 이해할 한국어 설명으로 풀어 쓰되, 문서 기재·담당자 설명·계획·미확인의 차이는 유지하라. 인용문과 구조화 식별자는 그대로 보존하라. 잔액 메모와 자금 배정만 보고 "외부 조달 불확실성 없이 실행 가능"처럼 근거보다 강한 결론을 내리지 마라. 조달을 입증하는 자료가 있다면 그 기준일과 범위를 특정하라. 심사 또는 실사에 관한 조언은 회사 원문에 맞는 준비 제안으로 표현하고 확인되지 않은 빈도나 유리함을 덧붙이지 마라.`;

const reviewInstructions = `지적하기 전에 문제되는 문장뿐 아니라 해당 항목 전체와 이미 기재된 제한·확인 질문을 함께 읽어라. 본문이 미확인 범위나 향후 계획임을 정확히 밝혔다는 이유만으로 그 제한을 다시 오류로 만들지 마라. 다만 다른 문장이 그 제한과 충돌하거나 사실을 과도하게 확정하면 충돌하는 문장과 원문이 허용하는 범위를 특정해 지적하라.
같은 항목·주장·근거·원인·수정 행동을 표현만 바꿔 반복한 의견은 하나로 정리하라. 주장이나 근거, 필요한 행동이 다르면 각각 유지하라. 개수를 채우기 위한 일반 조언은 만들지 말고 실제 문제가 없으면 빈 배열을 반환하라. 이미 완료된 조치를 그대로 다시 요구하지 말고 실제 남은 수정 또는 확인을 action에 기재하라.
자금 메모를 집행 가능성·조달 확실성으로 확대하거나 원문에 없는 실사 빈도·기관 선호·심사 유리함을 단정한 문장을 대조하라. 특정 단어가 있다는 이유만으로 오류를 만들지 말고 해당 문장의 주장과 근거 범위 차이를 message에 구체적으로 설명하라. 자료로 판단할 수 없는 사안은 확인 의견으로 구분하고, 원문 충돌처럼 명확한 문제와 동일하게 단정하지 마라.`;

export function getV2PlanPromptDefinition(): PlanPromptDefinition {
  const legacy = getV1PlanPromptDefinition();
  return {
    ...legacy,
    engineVersion: "plan-observation-v2",
    systemPrompt: `${legacy.systemPrompt}\n\n${proseInstructions}`,
    generationInstruction: `${legacy.generationInstruction}\n\n${generationInstructions}`,
    reviewInstruction: `${legacy.reviewInstruction}\n\n${reviewInstructions}`,
  };
}
