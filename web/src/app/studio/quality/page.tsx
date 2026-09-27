import type { Metadata } from "next";
import { QualityEvaluationWorkspace } from "@/components/studio/quality-evaluation-workspace";

export const metadata: Metadata = {
  title: "합성 자료 품질 검증",
  description: "개발·검토용 합성 사례의 평가 기록을 이 컴퓨터에 보관하고 비교합니다.",
  robots: { index: false, follow: false },
};

export default function QualityEvaluationPage() {
  return <QualityEvaluationWorkspace />;
}
