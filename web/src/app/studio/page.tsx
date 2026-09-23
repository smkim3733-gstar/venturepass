import type { Metadata } from "next";
import { StudioWorkspace } from "@/components/studio/studio-workspace";

export const metadata: Metadata = {
  title: "사업계획서 스튜디오",
  description: "기업 자료를 근거로 혁신성장유형 신청 아이템과 사업계획서를 준비합니다.",
};
export default function StudioPage() {
  return <StudioWorkspace />;
}
