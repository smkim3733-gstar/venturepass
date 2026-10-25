"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowLeft, KeyRound, UserPlus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { StudioMember } from "@/lib/studio-members";
import type { StudioStatus } from "@/lib/studio-schema";
import {
  fieldClass,
  jsonBody,
  Loading,
  Notice,
  PanelHeading,
  selectClass,
  studioFetch,
} from "./shared";

type Role = StudioMember["role"];
type Status = StudioMember["status"];
export const roleLabels: Record<Role, string> = {
  admin: "관리자",
  editor: "작성 담당",
  viewer: "조회 전용",
};
export const statusLabels: Record<Status, string> = {
  active: "사용 중",
  pending: "승인 대기",
  disabled: "사용 중지",
};
const roles = Object.keys(roleLabels) as Role[];
const statuses = Object.keys(statusLabels) as Status[];
const emptyForm = { displayName: "", email: "", role: "editor" as Role, password: "" };

/** Why the page cannot be used, or null when the signed-in user is a web-service admin. */
export function membersBlockedReason(status: StudioStatus | null) {
  if (!status) return null;
  if (status.storage !== "server") return "담당자 관리는 웹 서비스에서만 사용합니다.";
  if (status.user?.role !== "admin") return "관리자만 담당자를 관리할 수 있습니다.";
  return null;
}

export function MembersPanel() {
  const [status, setStatus] = useState<StudioStatus | null>(null);
  const [members, setMembers] = useState<StudioMember[] | null>(null);
  const [selfUserId, setSelfUserId] = useState("");
  const [form, setForm] = useState(emptyForm);
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    studioFetch<StudioStatus>("/api/studio/status")
      .then(async (current) => {
        if (!active) return;
        setStatus(current);
        if (membersBlockedReason(current)) return;
        const body = await studioFetch<{ members: StudioMember[]; selfUserId: string }>(
          "/api/studio/members",
        );
        if (!active) return;
        setMembers(body.members);
        setSelfUserId(body.selfUserId);
      })
      .catch((caught: unknown) => {
        if (active)
          setError(caught instanceof Error ? caught.message : "담당자 목록을 불러오지 못했습니다.");
      });
    return () => {
      active = false;
    };
  }, []);

  async function run(action: () => Promise<string>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      setMessage(await action());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "처리하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  function add(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const created = await studioFetch<StudioMember>("/api/studio/members", {
        method: "POST",
        ...jsonBody(form),
      });
      setMembers((current) => [...(current ?? []), created]);
      setForm(emptyForm);
      return `${created.displayName} 담당자를 추가했습니다. 처음 비밀번호는 직접 전달해 주세요.`;
    });
  }

  function change(member: StudioMember, patch: { role?: Role; status?: Status }) {
    void run(async () => {
      const updated = await studioFetch<StudioMember>(`/api/studio/members/${member.userId}`, {
        method: "PATCH",
        ...jsonBody(patch),
      });
      setMembers((current) =>
        (current ?? []).map((item) => (item.userId === updated.userId ? updated : item)),
      );
      return `${updated.displayName}: ${roleLabels[updated.role]} · ${statusLabels[updated.status]}`;
    });
  }

  function resetPassword(event: FormEvent, member: StudioMember) {
    event.preventDefault();
    void run(async () => {
      await studioFetch(`/api/studio/members/${member.userId}/password`, {
        method: "POST",
        ...jsonBody({ password: newPassword }),
      });
      setNewPassword("");
      setResetFor(null);
      return `${member.displayName} 담당자의 비밀번호를 새로 정했습니다.`;
    });
  }

  const blocked = membersBlockedReason(status);
  return (
    <main id="main-content" className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <Link
        href="/studio"
        className="mb-6 inline-flex h-11 items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        신청 준비로 돌아가기
      </Link>
      <PanelHeading
        title="담당자 관리"
        description="담당자를 추가하고 역할과 사용 여부를 정합니다. 사용 중지된 담당자는 바로 로그인이 막힙니다."
      />
      <div aria-live="polite" className="mb-4 space-y-3">
        {error && <Notice tone="warning">{error}</Notice>}
        {message && <Notice>{message}</Notice>}
      </div>
      {!status && !error && <Loading />}
      {blocked && <Notice tone="warning">{blocked}</Notice>}
      {!blocked && status && (
        <div className="space-y-8">
          <form onSubmit={add} className="space-y-4 rounded-2xl border bg-white p-5 sm:p-6">
            <h3 className="font-semibold">담당자 추가</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className={fieldClass}>
                <Label htmlFor="member-name">이름</Label>
                <Input
                  id="member-name"
                  required
                  maxLength={100}
                  value={form.displayName}
                  onChange={(event) => setForm({ ...form, displayName: event.target.value })}
                />
              </div>
              <div className={fieldClass}>
                <Label htmlFor="member-email">이메일(로그인 아이디)</Label>
                <Input
                  id="member-email"
                  type="email"
                  required
                  autoComplete="off"
                  value={form.email}
                  onChange={(event) => setForm({ ...form, email: event.target.value })}
                />
              </div>
              <div className={fieldClass}>
                <Label htmlFor="member-role">역할</Label>
                <select
                  id="member-role"
                  className={selectClass}
                  value={form.role}
                  onChange={(event) => setForm({ ...form, role: event.target.value as Role })}
                >
                  {roles.map((role) => (
                    <option key={role} value={role}>
                      {roleLabels[role]}
                    </option>
                  ))}
                </select>
              </div>
              <div className={fieldClass}>
                <Label htmlFor="member-password">처음 비밀번호(10자 이상)</Label>
                <Input
                  id="member-password"
                  type="password"
                  required
                  minLength={10}
                  maxLength={72}
                  autoComplete="new-password"
                  value={form.password}
                  onChange={(event) => setForm({ ...form, password: event.target.value })}
                />
              </div>
            </div>
            <p className="text-sm leading-6 text-muted-foreground">
              작성 담당은 자료를 올리고 계획서를 고칠 수 있고, 조회 전용은 보기만 합니다.
            </p>
            <Button type="submit" className="h-11" disabled={busy}>
              <UserPlus />
              담당자 추가
            </Button>
          </form>

          <section className="space-y-3">
            <h3 className="font-semibold">담당자 목록</h3>
            {!members && <Loading />}
            {members?.map((member) => {
              const self = member.userId === selfUserId;
              return (
                <div
                  key={member.userId}
                  className="space-y-3 rounded-2xl border bg-white p-4 sm:flex sm:flex-wrap sm:items-end sm:gap-4 sm:space-y-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{member.displayName}</span>
                      {member.status !== "active" && (
                        <Badge variant="outline">{statusLabels[member.status]}</Badge>
                      )}
                    </div>
                    <p className="mt-1 break-all text-sm text-muted-foreground">{member.email}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:w-80">
                    <div className={fieldClass}>
                      <Label htmlFor={`role-${member.userId}`}>역할</Label>
                      <select
                        id={`role-${member.userId}`}
                        className={selectClass}
                        disabled={busy || self}
                        value={member.role}
                        onChange={(event) => change(member, { role: event.target.value as Role })}
                      >
                        {roles.map((role) => (
                          <option key={role} value={role}>
                            {roleLabels[role]}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className={fieldClass}>
                      <Label htmlFor={`status-${member.userId}`}>상태</Label>
                      <select
                        id={`status-${member.userId}`}
                        className={selectClass}
                        disabled={busy || self}
                        value={member.status}
                        onChange={(event) =>
                          change(member, { status: event.target.value as Status })
                        }
                      >
                        {statuses.map((value) => (
                          <option key={value} value={value}>
                            {statusLabels[value]}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {resetFor === member.userId ? (
                    <form
                      onSubmit={(event) => resetPassword(event, member)}
                      className="flex w-full flex-wrap items-end gap-3"
                    >
                      <div className={`${fieldClass} min-w-0 flex-1`}>
                        <Label htmlFor={`password-${member.userId}`}>새 비밀번호(10자 이상)</Label>
                        <Input
                          id={`password-${member.userId}`}
                          type="password"
                          required
                          minLength={10}
                          maxLength={72}
                          autoComplete="new-password"
                          value={newPassword}
                          onChange={(event) => setNewPassword(event.target.value)}
                        />
                      </div>
                      <Button type="submit" className="h-11" disabled={busy}>
                        저장
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-11"
                        onClick={() => {
                          setResetFor(null);
                          setNewPassword("");
                        }}
                      >
                        취소
                      </Button>
                    </form>
                  ) : (
                    <Button
                      variant="outline"
                      className="h-11"
                      disabled={busy}
                      onClick={() => {
                        setResetFor(member.userId);
                        setNewPassword("");
                      }}
                    >
                      <KeyRound />
                      비밀번호 다시 정하기
                    </Button>
                  )}
                </div>
              );
            })}
          </section>
        </div>
      )}
    </main>
  );
}
