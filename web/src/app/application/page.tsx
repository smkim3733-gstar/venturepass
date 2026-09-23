import type { Metadata } from "next";
import { ApplicationWorkspace } from "@/components/application-workspace";

export const metadata: Metadata = {
  title: "신청 준비",
  description: "혁신성장유형 기업 정보와 준비 경로, 근거자료 검토 현황을 관리합니다.",
};

export default function ApplicationPage() {
  return <ApplicationWorkspace />;
}
