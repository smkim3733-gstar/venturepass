import { z } from "zod";

export const candidateClassifications = [
  "unknown",
  "current",
  "evidence-needed",
  "future-proposal",
] as const;
export const candidateClassificationSchema = z.enum(candidateClassifications);
export type CandidateClassification = z.infer<typeof candidateClassificationSchema>;
export const candidateClassificationLabels: Record<CandidateClassification, string> = {
  unknown: "후보 구분 미확인",
  current: "현재 신청 후보",
  "evidence-needed": "근거 확인 후 후보",
  "future-proposal": "향후 개발 제안",
};
export const candidateClassificationHelp: Record<CandidateClassification, string> = {
  unknown: "현재 자료만으로 후보의 현재·미래 구분을 정하지 않았습니다.",
  current:
    "현재 보유·개발 설명에 연결한 추천 후보입니다. 실제 역량·권리·자료를 별도로 확인해야 합니다.",
  "evidence-needed": "기업 설명과 관련 활동·권한·근거를 추가 확인한 뒤 검토할 후보입니다.",
  "future-proposal":
    "앞으로 수행할 확장 방향입니다. 이미 보유한 기술이나 달성한 성과로 사용하지 않습니다.",
};
export const candidateClassificationDisclaimer =
  "추천 분류이며 사실·기관 적합성·사용자 검토 완료를 뜻하지 않습니다.";

/** Display fallback only: never insert a default key into historical data or digest inputs. */
export function getCandidateClassification(candidate: {
  classification?: CandidateClassification;
}): CandidateClassification {
  return candidate.classification ?? "unknown";
}
