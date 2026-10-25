import type { Metadata } from "next";
import { MembersPanel } from "@/components/studio/members-panel";

export const metadata: Metadata = {
  title: "담당자 관리",
  description: "벤처패스 웹 서비스 담당자 추가와 권한 관리",
};
export default function MembersPage() {
  return <MembersPanel />;
}
