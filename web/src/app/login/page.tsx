import type { Metadata } from "next";
import { LoginForm } from "@/components/studio/login-form";

export const metadata: Metadata = {
  title: "로그인",
  description: "벤처패스 담당자 로그인",
};
export default function LoginPage() {
  return <LoginForm />;
}
