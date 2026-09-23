export type EvaluationFocusItem = {
  id: string;
  title: string;
  question: string;
  evidence: string[];
  sectionKeys: string[];
  visitAction: string;
};

/**
 * Preparation guidance reconstructed from the supplied 2026 guidebook, printed p.36,
 * and its business-plan guidance. These six groups are not official scoring items.
 * Evidence and visit actions are practical examples, not universally required documents.
 * Deliberately contains no points, thresholds, or approval predictions.
 */
export const evaluationFocusItems: EvaluationFocusItem[] = [
  {
    id: "technology-problem-fit",
    title: "고객 문제와 신청기술의 연결",
    question:
      "어떤 고객의 어떤 문제를 신청기술의 어느 기능·구조로 해결하나요? 사업계획서의 제품·서비스와 실제 개발 대상이 같은가요?",
    evidence: [
      "고객 상담·현장 문제 기록",
      "제품·기술 구성 설명",
      "신청기술과 사업계획 항목의 연결표",
    ],
    sectionKeys: ["problem", "solution", "commercialization"],
    visitAction:
      "고객 문제부터 기술의 작동 방식, 실제 제품·서비스로 이어지는 설명을 준비하고 해당 원문을 바로 찾을 수 있게 정리하세요.",
  },
  {
    id: "objective-differentiation",
    title: "비교 조건을 갖춘 기술 차별성",
    question:
      "어떤 기존 기술·제품과 무엇이 다른가요? 비교 대상·측정 조건·기간·방법이 같고, 주장한 차이를 확인할 원자료가 있나요?",
    evidence: [
      "경쟁 대안·기술 비교표",
      "해당 시 시험·측정 조건과 원자료",
      "차이를 확인할 도면·개발·고객 검증 기록",
    ],
    sectionKeys: ["differentiation", "solution", "ip"],
    visitAction:
      "우수성 표현에 대응하는 비교 대상과 조건을 설명하세요. 검증하지 않은 성능은 목표로 구분하고, 시험자료가 없다면 확인 방법과 보강 과제를 준비하세요.",
  },
  {
    id: "sustainable-capability",
    title: "자사 개발 범위와 지속적인 혁신 역량",
    question:
      "회사가 직접 개발·유지·개선하는 부분은 무엇이고 외부 기술·외주 범위는 어디까지인가요? 이를 담당할 인력과 실제 사용 가능한 인프라는 무엇인가요?",
    evidence: [
      "핵심 인력의 역할·경력·참여 기록",
      "자사·외부 개발 범위 및 해당 시 계약·사용 권한",
      "실제로 이용하는 개발환경·장비·협업 근거",
    ],
    sectionKeys: ["solution", "team", "ip", "development"],
    visitAction:
      "기술 담당자가 현재 개발 범위와 외부 의존 부분을 설명하고, 개발·개선 활동에 참여한 인력과 사용 환경을 관련 자료로 확인할 수 있도록 준비하세요.",
  },
  {
    id: "development-progress",
    title: "개발 완료 사실과 향후 계획의 구분",
    question:
      "현재 구현·검증된 기능과 앞으로 개발할 기능은 각각 무엇인가요? 완료했다고 기재한 단계와 날짜를 뒷받침할 기록이 있나요?",
    evidence: [
      "개발 이력·버전·시제품 기록",
      "현재 검증·시연 가능한 범위",
      "단계별 개발 목표·담당자·검증 일정",
    ],
    sectionKeys: ["development", "solution", "performance"],
    visitAction:
      "현재 가능한 기능과 한계를 구분해 설명하세요. 시연이 적절한 경우 환경을 점검하고, 아직 구현하지 않은 기능을 완료된 것처럼 제시하지 않도록 준비하세요.",
  },
  {
    id: "market-expansion",
    title: "신청기술을 중심으로 한 시장확대 전략",
    question:
      "어떤 고객이 왜 이 기술을 선택하며, 최초 고객 확보부터 시장확대까지 어떻게 연결되나요? 일반적인 홍보 계획을 넘어 구매·도입 경로를 설명할 수 있나요?",
    evidence: [
      "고객 수요·구매 검토·도입 과정의 자료",
      "시장 자료의 출처·기준기간",
      "해당 시 계약·납품·협업 근거와 판매 계획",
    ],
    sectionKeys: ["market", "commercialization", "problem", "performance"],
    visitAction:
      "신청기술의 고객 가치, 판매 방식과 확대 단계를 실제 자료에 맞춰 설명하세요. 확정 계약·협의 중 사항·향후 목표를 구분하세요.",
  },
  {
    id: "execution-consistency",
    title: "인력·자금·일정의 실행 가능성과 일치",
    question:
      "개발·사업화 일정에 필요한 인력과 비용이 반영되어 있나요? 확보한 자금과 조달 예정 자금을 구분하고 자료의 기간·수치가 서로 일치하나요?",
    evidence: [
      "개발·사업화 일정과 인력 투입 계획",
      "자금 소요·조달 시기·확정 여부",
      "기간별 재무·사업성과와 산정 근거",
    ],
    sectionKeys: ["funding", "development", "team", "performance"],
    visitAction:
      "일정·담당 인력·비용·조달 시기를 같은 기준으로 대조하세요. 가정과 미확정 조달은 계획으로 표시하고 담당자가 산정 근거를 설명할 수 있도록 준비하세요.",
  },
];

export const visitPreparationItems: { id: string; title: string; notes: string }[] = [
  {
    id: "visit-coordination",
    title: "기관 요청·실사 일정·장소 확인",
    notes:
      "배정 기관의 개별 안내에 따라 일정·실사 장소·요청자료를 확인하세요. 본사와 실사 장소가 다르면 벤처인 사업장 정보와 신청 시 선택한 장소를 확인하고, 이전 예정이면 기관에 문의하세요.",
  },
  {
    id: "visit-submitted-version",
    title: "실제 제출본과 보완본 대조",
    notes:
      "벤처인에 실제 제출한 사업계획서·첨부자료·보완 답변의 최종본을 확인하세요. 앱 초안과 실제 제출본을 구분하고 달라진 수치·기술 범위·일정을 정리하세요.",
  },
  {
    id: "visit-explanation-roles",
    title: "사업·기술·재무 설명 역할 준비",
    notes:
      "기관의 참석 안내를 확인한 뒤 사업, 기술, 재무 질문에 답할 담당자를 정하세요. 대표 참석이나 발표자료를 모든 기업의 일률적인 필수조건으로 가정하지 마세요.",
  },
  {
    id: "visit-current-technology",
    title: "현재 개발 단계와 시연 가능 범위 점검",
    notes:
      "현재 구현한 기능·검증 범위와 향후 계획을 구분하세요. 시연이 적절하거나 요청된 경우 장비·접속·환경을 점검하고, 시연이 어려운 부분은 이유와 설명 가능한 개발 기록을 준비하세요.",
  },
  {
    id: "visit-comparison-records",
    title: "차별성 비교 조건과 원자료 정리",
    notes:
      "기술 우수성을 설명한 문장마다 비교 대상·기간·조건·측정방법과 관련 원자료를 연결하세요. 시험성적서 보유를 모든 기업의 필수조건으로 정하지 않고, 미검증 사항은 보강 과제로 구분하세요.",
  },
  {
    id: "visit-team-and-outsourcing",
    title: "참여 인력·개발환경·외부 개발 범위 확인",
    notes:
      "핵심 인력의 실제 역할과 개발 참여, 사용 가능한 환경을 확인하세요. 자사 개발·외주·라이선스 범위 및 해당 시 계약·사용 권한을 구분하고 설명자료와 실제 상태를 대조하세요.",
  },
  {
    id: "visit-market-finance-performance",
    title: "시장·자금·사업성과의 근거 대조",
    notes:
      "신청기술과 목표고객·시장진입 전략의 연결, 개발 일정과 인력·소요자금·조달 시기의 일치를 확인하세요. 확정 실적·진행 중 사항·목표를 구분하고 재확인은 이전 기간의 개선·성과 자료도 확인하세요.",
  },
  {
    id: "visit-rehearsal-followup",
    title: "자료 기반 모의 질의응답과 추가 요청 기록",
    notes:
      "회사 원문과 실제 제출본의 확인 필요 사항으로 질문을 만들고 답변과 근거 위치를 연습하세요. 앱의 질문은 기관이 확정한 실제 질문이 아닙니다. 실사 후 요청은 내용·담당자·기한으로 기록하세요.",
  },
];

export const evaluationSources: { label: string; url: string }[] = [
  {
    label: "공식 혁신성장유형 안내",
    url: "https://www.smes.go.kr/venturein/institution/requireGuide?rgCd=C",
  },
  {
    label: "공식 확인절차 · 현장실제조사",
    url: "https://www.smes.go.kr/venturein/institution/processGuide",
  },
  {
    label: "공식 FAQ · 실사 사업장 안내",
    url: "https://www.smes.go.kr/venturein/board/viewFaqBoardList?bbsSn=23&totalSearchYn=Y",
  },
];
