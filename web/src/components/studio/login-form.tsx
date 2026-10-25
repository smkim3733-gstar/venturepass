"use client";

import { useState, type FormEvent } from "react";
import { LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Only same-site paths; never follow an absolute or protocol-relative "next" URL. */
export function safeNextPath(value: string | null) {
  return value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\")
    ? value
    : "/studio";
}

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setError(body.error || "로그인하지 못했습니다. 잠시 후 다시 시도해 주세요.");
        return;
      }
      setPassword("");
      window.location.assign(safeNextPath(new URLSearchParams(window.location.search).get("next")));
    } catch {
      setError("로그인하지 못했습니다. 연결 상태를 확인해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="main-content" className="flex min-h-[70vh] items-center justify-center px-4">
      <form
        onSubmit={(event) => void submit(event)}
        className="w-full max-w-sm space-y-5 rounded-2xl border bg-white p-6 sm:p-8"
      >
        <div>
          <h1 className="text-xl font-semibold">담당자 로그인</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            관리자가 승인한 담당자만 이용할 수 있습니다.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="login-email">이메일</Label>
          <Input
            id="login-email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="login-password">비밀번호</Label>
          <Input
            id="login-password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm leading-6 text-red-700">
            {error}
          </p>
        )}
        <Button type="submit" className="min-h-11 w-full" disabled={busy}>
          <LogIn />
          {busy ? "확인하는 중입니다" : "로그인"}
        </Button>
      </form>
    </main>
  );
}
