"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowLeft, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { StudioStatus } from "@/lib/studio-schema";
import { fieldClass, Loading, Notice, PanelHeading, studioFetch } from "./shared";
import { roleLabels } from "./members-panel";

type PasswordForm = { currentPassword: string; newPassword: string; confirmPassword: string };
const emptyForm: PasswordForm = { currentPassword: "", newPassword: "", confirmPassword: "" };

/** Why the page cannot be used, or null for a signed-in member of the web service. */
export function accountBlockedReason(status: StudioStatus | null) {
  if (!status) return null;
  if (status.storage !== "server" || !status.user)
    return "내 계정 설정은 웹 서비스에 로그인했을 때만 사용합니다.";
  return null;
}

/** Checks the browser can make before sending anything; the server checks again. */
export function passwordFormProblem(form: PasswordForm) {
  if (!form.currentPassword) return "지금 비밀번호를 입력해 주세요.";
  if (form.newPassword.length < 10) return "새 비밀번호는 10자 이상으로 정해 주세요.";
  if (form.newPassword.length > 72) return "새 비밀번호는 72자 이하로 정해 주세요.";
  if (form.newPassword !== form.confirmPassword) return "새 비밀번호와 확인 입력이 서로 다릅니다.";
  if (form.newPassword === form.currentPassword) return "지금과 다른 비밀번호로 정해 주세요.";
  return null;
}

export function AccountPanel() {
  const [status, setStatus] = useState<StudioStatus | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [relogin, setRelogin] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    studioFetch<StudioStatus>("/api/studio/status")
      .then((current) => {
        if (active) setStatus(current);
      })
      .catch((caught: unknown) => {
        if (active)
          setError(caught instanceof Error ? caught.message : "계정 정보를 불러오지 못했습니다.");
      });
    return () => {
      active = false;
    };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    setMessage("");
    setRelogin(false);
    const problem = passwordFormProblem(form);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: form.currentPassword,
          newPassword: form.newPassword,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        otherSessionsSignedOut?: boolean;
      };
      if (!response.ok) {
        setError(body.error || "비밀번호를 바꾸지 못했습니다. 잠시 후 다시 시도해 주세요.");
        setRelogin(response.status === 401);
        return;
      }
      setForm(emptyForm);
      setMessage(
        body.otherSessionsSignedOut
          ? "비밀번호를 바꿨습니다. 다른 컴퓨터·휴대폰의 로그인은 모두 끝냈습니다."
          : "비밀번호를 바꿨습니다. 다른 기기의 로그인은 끝내지 못했으니, 그 기기에서 직접 로그아웃해 주세요.",
      );
    } catch {
      setError("서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  const blocked = accountBlockedReason(status);
  const field = (key: keyof PasswordForm, label: string, autoComplete: string) => (
    <div className={fieldClass}>
      <Label htmlFor={`account-${key}`}>{label}</Label>
      <Input
        id={`account-${key}`}
        type="password"
        required
        maxLength={key === "currentPassword" ? 200 : 72}
        autoComplete={autoComplete}
        value={form[key]}
        onChange={(event) => setForm({ ...form, [key]: event.target.value })}
      />
    </div>
  );
  return (
    <main id="main-content" className="mx-auto w-full max-w-xl px-4 py-8 sm:px-6">
      <Link
        href="/studio"
        className="mb-6 inline-flex h-11 items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        신청 준비로 돌아가기
      </Link>
      <PanelHeading
        title="내 계정"
        description="로그인 비밀번호를 직접 바꿉니다. 바꾸면 다른 기기의 로그인은 끝납니다."
      />
      <div aria-live="polite" className="mb-4 space-y-3">
        {error && (
          <Notice tone="warning">
            {error}
            {relogin && (
              <>
                {" "}
                <Link href="/login?next=/studio/account" className="underline">
                  다시 로그인
                </Link>
              </>
            )}
          </Notice>
        )}
        {message && <Notice>{message}</Notice>}
      </div>
      {!status && !error && <Loading />}
      {blocked && <Notice tone="warning">{blocked}</Notice>}
      {!blocked && status?.user && (
        <form onSubmit={submit} className="space-y-4 rounded-2xl border bg-white p-5 sm:p-6">
          <p className="text-sm text-muted-foreground">
            {status.user.displayName} · {roleLabels[status.user.role]}
          </p>
          {field("currentPassword", "지금 비밀번호", "current-password")}
          {field("newPassword", "새 비밀번호(10자 이상)", "new-password")}
          {field("confirmPassword", "새 비밀번호 확인", "new-password")}
          <Button type="submit" className="h-11" disabled={busy}>
            <KeyRound />
            비밀번호 바꾸기
          </Button>
        </form>
      )}
    </main>
  );
}
