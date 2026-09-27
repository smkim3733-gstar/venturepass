import type { Metadata } from "next";
import { StudioWorkspace } from "@/components/studio/studio-workspace";

export const metadata: Metadata = {
  title: "벤처확인 신청 준비",
  description: "회사 자료를 올리고, AI 사업계획서를 검토한 뒤 혁신성장유형 신청을 준비합니다.",
};
export default function StudioPage() {
  return <StudioWorkspace />;
}
