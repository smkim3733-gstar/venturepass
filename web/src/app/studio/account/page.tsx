import type { Metadata } from "next";
import { AccountPanel } from "@/components/studio/account-panel";

export const metadata: Metadata = {
  title: "내 계정",
  description: "벤처패스 웹 서비스 담당자 본인 비밀번호 변경",
};
export default function AccountPage() {
  return <AccountPanel />;
}
