"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { StudioCase } from "@/lib/studio-schema";
import {
  certificateTaskContext,
  createCertificateTaskMutationSchema,
  latestCertificateNotices,
  type CertificateTask,
  type CreateCertificateTask,
} from "@/lib/studio-certificate-renewal-types";
import { Notice, useDirty } from "./shared";

type Mutation = Omit<CreateCertificateTask, "revision">;
type Props = {
  company: StudioCase;
  mutate: (mutation: Mutation) => Promise<StudioCase | null>;
  blockedReason: string;
  onDirtyChange: (dirty: boolean) => void;
};

export function certificateTaskAcknowledged(
  saved: StudioCase | null,
  companyId: string,
  input: Mutation,
  validUntil: string,
) {
  if (!saved || saved.id !== companyId) return false;
  const tasks: CertificateTask[] = saved.tasks;
  const matches = tasks.filter(
    (task) =>
      task.certificateOrigin?.noticeRecordId === input.noticeRecordId &&
      task.certificateOrigin.noticeVersionId === input.noticeVersionId,
  );
  return (
    matches.length === 1 &&
    matches[0].certificateOrigin?.category === "certificate" &&
    matches[0].certificateOrigin.validUntil === validUntil &&
    matches[0].certificateOrigin.preparationOn === input.preparationOn
  );
}

export function CertificateTaskReference({
  company,
  task,
}: {
  company: StudioCase;
  task: CertificateTask;
}) {
  const origin = task.certificateOrigin;
  if (!origin) return null;
  const context = certificateTaskContext(company, task);
  return (
    <div className="space-y-1 text-xs leading-6">
      <p>
        {context?.version ? (
          <a href={`#agency-record-${context.version.id}`} className="underline underline-offset-4">
            연결한 확인서 통보 v{context.version.version} 원문
          </a>
        ) : (
          "연결한 통보 원문 확인 필요"
        )}
      </p>
      <p>
        연결 당시 기재 유효종료일: {origin.validUntil || "미확인"} · 최초 사용자 준비일:{" "}
        {origin.preparationOn}
      </p>
      {context?.state === "updated" && (
        <p className="text-amber-900">
          통보가 정정되었거나 연결 내용이 바뀌었습니다. 기존 업무 날짜·완료 상태는 보존했습니다.
          최신 통보를 다시 확인해 주세요.
        </p>
      )}
      {context?.state === "missing" && (
        <p className="text-amber-900">
          연결한 확인서 통보 버전을 고유하게 찾지 못했습니다. 다른 기록으로 대체하지 않습니다.
        </p>
      )}
      <p className="text-muted-foreground">
        담당자 기록 기준입니다. 업무 완료는 재신청·기관 접수·확인서 효력 확인을 뜻하지 않습니다.
      </p>
    </div>
  );
}

export function CertificateRenewal(props: Props) {
  return (
    <CertificateRenewalEditor key={`${props.company.id}:${props.company.revision}`} {...props} />
  );
}

function CertificateRenewalEditor({ company, mutate, blockedReason, onDirtyChange }: Props) {
  const id = useId();
  const [form, setForm] = useState<{
    input: Mutation;
    validUntil: string;
    attempted: boolean;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useDirty(form !== null || saving, onDirtyChange);
  const notices = latestCertificateNotices(company);
  const tasks: CertificateTask[] = company.tasks;
  const linked = tasks.filter((task) => task.certificateOrigin);
  const blocked = !!blockedReason || saving;
  async function save() {
    if (!form || blocked || pending.current) return;
    const parsed = createCertificateTaskMutationSchema.safeParse({
      ...form.input,
      revision: company.revision,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message || "준비 날짜를 확인해 주세요.");
      return;
    }
    const input = form.input;
    pending.current = true;
    setSaving(true);
    setForm({ ...form, attempted: true });
    setError("");
    try {
      const saved = await mutate(input);
      if (!mounted.current) return;
      if (certificateTaskAcknowledged(saved, company.id, input, form.validUntil)) setForm(null);
      else
        setError(
          "업무 생성 결과를 확인하지 못했습니다. 같은 입력으로 재확인하거나 최신 업무 목록을 확인해 주세요.",
        );
    } catch {
      if (mounted.current)
        setError(
          "업무 생성 결과를 확인하지 못했습니다. 입력 날짜를 보존했습니다. 같은 입력으로 재확인해 주세요.",
        );
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  return (
    <section aria-label="확인서 기록과 차기 준비" className="my-6 space-y-4 rounded-2xl border p-5">
      <h3 className="font-bold">확인서 기록·차기 준비</h3>
      <Notice>
        유효기간은 담당자가 기관 통보에 입력한 기록입니다. 확인서의 진위·현재 효력·취소 여부를 자동
        판단하지 않습니다. 준비 업무 날짜는 직접 정하며 법정 갱신기한을 계산하거나 자동 입력하지
        않습니다.
      </Notice>
      {blockedReason && <p className="text-sm text-amber-900">{blockedReason}</p>}
      {!notices.length && (
        <p className="text-sm text-muted-foreground">
          최신 분류가 ‘확인서 관련 통보’인 기록이 없습니다. 위 기관 통보에서 원문과 유효기간을 먼저
          기록해 주세요.
        </p>
      )}
      {notices.map((notice) => {
        if (notice.details.category !== "certificate") return null;
        const details = notice.details;
        const existing = linked.filter(
          (task) =>
            task.certificateOrigin?.noticeRecordId === notice.noticeRecordId &&
            task.certificateOrigin.noticeVersionId === notice.id,
        );
        return (
          <article key={notice.id} className="space-y-3 rounded-xl border p-4">
            <h4 className="text-sm font-semibold">
              <a href={`#agency-record-${notice.id}`} className="underline underline-offset-4">
                {notice.title} · 통보 v{notice.version}
              </a>
            </h4>
            <p className="text-sm">
              기재된 유효기간: {details.validFrom || "시작일 미확인"} ~{" "}
              {details.validUntil || "종료일 미확인"}
            </p>
            <p className="whitespace-pre-wrap text-xs">
              담당자 입력 상태: {details.statusText || "미기재"}
            </p>
            <details>
              <summary className="cursor-pointer text-xs underline">현재 통보 원문 읽기</summary>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">
                {notice.body}
              </pre>
            </details>
            {existing.length > 0 ? (
              <p className="text-xs">
                이 통보 버전의 준비 업무가 있습니다. 날짜·완료 표시는 아래 연결 업무에서 확인하거나
                업무 화면에서 수정하세요.
              </p>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={blocked || form !== null || tasks.length >= 200}
                onClick={() => {
                  if (blocked || form || pending.current) return;
                  setForm({
                    input: {
                      action: "create-certificate-task",
                      noticeRecordId: notice.noticeRecordId,
                      noticeVersionId: notice.id,
                      preparationOn: "",
                    },
                    validUntil: details.validUntil,
                    attempted: false,
                  });
                  setError("");
                }}
              >
                준비일 직접 정해 업무 연결
              </Button>
            )}
          </article>
        );
      })}
      {form && (
        <fieldset disabled={blocked} className="space-y-3 rounded-xl border border-primary/30 p-4">
          <legend className="px-2 text-sm font-semibold">사용자가 정하는 차기 준비일</legend>
          <Label htmlFor={`${id}-date`}>준비 업무 날짜 *</Label>
          <Input
            id={`${id}-date`}
            type="date"
            value={form.input.preparationOn}
            disabled={form.attempted}
            onInput={(event) => {
              if (!pending.current && !form.attempted)
                setForm({
                  ...form,
                  input: { ...form.input, preparationOn: event.currentTarget.value },
                });
            }}
            onChange={(event) => {
              if (!pending.current && !form.attempted)
                setForm({ ...form, input: { ...form.input, preparationOn: event.target.value } });
            }}
          />
          <p className="text-xs text-muted-foreground">
            통보에 기재한 유효종료일: {form.validUntil || "미확인"}. 이 날짜를 준비일이나 법정
            신청기한으로 복사하지 않습니다.
          </p>
          {form.attempted && (
            <p className="text-xs text-amber-900">
              이미 요청한 입력은 보존합니다. 다른 날짜로 바꾸려면 최신 업무 목록을 확인한 후 기존
              업무를 편집해 주세요.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={!form.input.preparationOn || tasks.length >= 200}
              onClick={() => void save()}
            >
              {saving
                ? "저장 중"
                : form.attempted
                  ? "같은 입력으로 생성 결과 재확인"
                  : "이 날짜로 준비 업무 생성"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (pending.current) return;
                if (
                  (form.attempted || form.input.preparationOn) &&
                  !window.confirm(
                    form.attempted
                      ? "업무가 이미 생성되었을 수 있습니다. 입력 창을 닫고 최신 업무 목록을 확인할까요?"
                      : "입력한 준비일을 취소할까요?",
                  )
                )
                  return;
                setForm(null);
                setError("");
              }}
            >
              입력 창 닫기
            </Button>
          </div>
        </fieldset>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!!linked.length && (
        <div className="space-y-3">
          <h4 className="text-sm font-semibold">연결한 준비 업무 · 이전 통보 기준 업무 포함</h4>
          {linked.map((task) => (
            <article key={task.id} className="space-y-2 rounded-xl bg-muted/25 p-4">
              <a
                href={`#workflow-task-${task.id}`}
                className="text-sm font-semibold underline underline-offset-4"
              >
                {task.title} · 업무로 이동
              </a>
              <p className="text-xs">
                현재 업무 날짜: {task.dueDate || "미기재"} · 상태:{" "}
                {task.status === "done" ? "담당자 표시 완료" : "진행 필요"}
              </p>
              <CertificateTaskReference company={company} task={task} />
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
