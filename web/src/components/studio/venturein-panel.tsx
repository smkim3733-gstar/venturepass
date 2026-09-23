"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ArrowUpRight,
  KeyRound,
  LockKeyhole,
  Play,
  RefreshCw,
  Save,
  Square,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  ventureinUrls,
  type VentureConnectionStatus,
  type VentureSessionState,
} from "@/lib/venturein-schema";
import {
  Loading,
  Notice,
  PanelHeading,
  formatDate,
  jsonBody,
  studioFetch,
  useDirty,
  type PanelProps,
} from "./shared";

const sessionLabels: Record<VentureSessionState, string> = {
  idle: "연결 전",
  starting: "로그인 연결 중",
  awaiting_setup: "보안 프로그램 설치 필요",
  awaiting_auth: "로그인·추가 인증 확인 대기",
  connected_unmapped: "로그인 표시 확인 · 제출 연결 미검증",
  login_failed: "연결 확인 필요",
  stopped: "연결 종료",
};

export function VentureinPanel({ company, setDirty }: PanelProps) {
  const [connection, setConnection] = useState<VentureConnectionStatus | null>(null);
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const endpoint = `/api/studio/cases/${company.id}/venturein`;
  useDirty(Boolean(loginId || password || busy), setDirty);
  useEffect(() => {
    let active = true;
    studioFetch<VentureConnectionStatus>(endpoint)
      .then((value) => {
        if (active) setConnection(value);
      })
      .catch((caught: unknown) => {
        if (active)
          setError(
            caught instanceof Error ? caught.message : "계정 연결 상태를 불러오지 못했습니다.",
          );
      });
    return () => {
      active = false;
    };
  }, [endpoint]);
  const refresh = useCallback(async () => {
    setBusy("연결 상태를 확인하고 있습니다");
    try {
      setConnection(await studioFetch<VentureConnectionStatus>(endpoint));
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "연결 상태를 확인하지 못했습니다.");
    } finally {
      setBusy("");
    }
  }, [endpoint]);
  function report(caught: unknown) {
    const message = caught instanceof Error ? caught.message : "요청을 처리하지 못했습니다.";
    setError(message);
    toast.error(message);
  }
  async function command(action: "start" | "resume" | "stop" | "restart", current = connection) {
    if (!current) return;
    setBusy(
      action === "start" || action === "restart"
        ? "별도 Edge 창에서 벤처인 로그인을 시작하고 있습니다"
        : "로그인 연결 상태를 확인하고 있습니다",
    );
    setError("");
    try {
      if (action === "restart") {
        await studioFetch<VentureConnectionStatus>(endpoint, {
          method: "POST",
          ...jsonBody({ action: "stop", accountRevision: current.account.revision }),
        });
      }
      const result = await studioFetch<VentureConnectionStatus>(endpoint, {
        method: "POST",
        ...jsonBody({
          action: action === "restart" ? "start" : action,
          accountRevision: current.account.revision,
        }),
      });
      setConnection(result);
      if (result.session.state === "login_failed") toast.error(result.session.message);
    } catch (caught) {
      report(caught);
    } finally {
      setBusy("");
    }
  }
  async function save(andStart: boolean) {
    if (!connection) return;
    setBusy("계정 정보를 암호화하여 저장하고 있습니다");
    setError("");
    let saved: VentureConnectionStatus | null = null;
    try {
      saved = await studioFetch<VentureConnectionStatus>(endpoint, {
        method: "PUT",
        ...jsonBody({ loginId, password, revision: connection.account.revision }),
      });
      setConnection(saved);
      setLoginId("");
      setPassword("");
      toast.success("계정을 암호화해 저장했습니다. 로그인 성공 여부는 연결 시작 후 확인합니다.");
    } catch (caught) {
      report(caught);
    } finally {
      setBusy("");
    }
    if (andStart && saved) await command("start", saved);
  }
  async function removeAccount() {
    if (!connection) return;
    setBusy("계정 연결을 해제하고 있습니다");
    setError("");
    try {
      const result = await studioFetch<VentureConnectionStatus>(endpoint, {
        method: "DELETE",
        ...jsonBody({ revision: connection.account.revision }),
      });
      setConnection(result);
      setLoginId("");
      setPassword("");
      toast.success("저장된 계정과 로그인 연결을 해제했습니다.");
    } catch (caught) {
      report(caught);
    } finally {
      setBusy("");
    }
  }
  const activeSession =
    connection &&
    ["starting", "awaiting_setup", "awaiting_auth", "connected_unmapped"].includes(
      connection.session.state,
    );
  useEffect(() => {
    if (!activeSession || busy) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await studioFetch<VentureConnectionStatus>(endpoint);
        if (active) setConnection(result);
      } catch {
        // Keep the last known status; explicit refresh still reports connection errors.
      }
      if (active) timer = setTimeout(poll, 3000);
    }
    timer = setTimeout(poll, 3000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [activeSession, busy, endpoint]);
  const canSave = connection?.credentialStorage === "windows-dpapi" && loginId.trim() && password;
  return (
    <div>
      <PanelHeading
        title="벤처인 계정 연결과 제출 준비"
        description="기업별 계정을 한 번 저장하고 로그인 연결에 사용하세요. 작성본과 원본 파일을 같은 기업 작업공간에서 확인합니다."
        actions={
          <Button variant="outline" disabled={!!busy} onClick={refresh}>
            <RefreshCw />
            상태 새로고침
          </Button>
        }
      />
      <Notice tone="warning">
        현재는 계정 암호화 저장과 자동 로그인 연결을 제공합니다. 로그인 후 기업 확인·신청
        항목·첨부·최종 제출 화면의 연결 검증이 남아 있어 실제 자동 제출은 아직 실행되지 않습니다.
      </Notice>
      {error && (
        <div
          role="alert"
          className="my-4 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm leading-6 text-destructive"
        >
          {error}
        </div>
      )}
      {busy && (
        <div className="my-4">
          <Loading text={busy} />
        </div>
      )}
      {!connection ? (
        !error && (
          <div className="mt-5">
            <Loading />
          </div>
        )
      ) : (
        <fieldset disabled={!!busy} className="mt-5 min-w-0 space-y-5">
          <section aria-label="벤처인 계정 저장" className="rounded-2xl border p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="flex items-center gap-2 font-bold">
                <LockKeyhole className="size-4 text-primary" />
                기업별 로그인 계정
              </h3>
              <Badge variant="outline">
                {connection.account.saved ? "암호화 저장됨" : "계정 미등록"}
              </Badge>
            </div>
            {connection.account.saved && (
              <p className="mt-3 break-all text-sm leading-6">
                저장 아이디: <strong>{connection.account.maskedLoginId}</strong>
                <span className="ml-2 text-xs text-muted-foreground">
                  {connection.account.updatedAt && formatDate(connection.account.updatedAt)}
                </span>
              </p>
            )}
            <p className="mt-3 text-xs leading-6 text-muted-foreground">
              아이디와 비밀번호는 이 PC의 Windows 사용자 계정으로 암호화해 보관합니다. 일반
              기업자료·AI 입력·다운로드 파일에는 포함하지 않습니다. 계정 저장 자체는 로그인 검증이
              아닙니다.
            </p>
            {connection.credentialStorage === "unavailable" && (
              <p className="mt-3 text-sm text-destructive">
                이 설치의 계정 보관 기능은 Windows에서 사용할 수 있습니다.
              </p>
            )}
            <form
              className="mt-4 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void save(false);
              }}
              autoComplete="off"
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="venture-login-id">벤처인 아이디</Label>
                  <Input
                    id="venture-login-id"
                    name="venture-login-id"
                    value={loginId}
                    onChange={(event) => setLoginId(event.target.value)}
                    maxLength={200}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={
                      connection.account.saved ? "변경할 아이디 입력" : "공식 벤처인 계정 아이디"
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="venture-password">벤처인 비밀번호</Label>
                  <Input
                    id="venture-password"
                    name="venture-password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    maxLength={512}
                    autoComplete="new-password"
                    placeholder="비밀번호 입력"
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="outline" disabled={!canSave}>
                  <Save />
                  계정 저장
                </Button>
                <Button type="button" disabled={!canSave} onClick={() => save(true)}>
                  <Play />
                  저장하고 로그인 시작
                </Button>
                {connection.account.saved && (
                  <Button type="button" variant="ghost" onClick={removeAccount}>
                    <Trash2 />
                    저장 계정 삭제
                  </Button>
                )}
              </div>
            </form>
          </section>
          <section aria-label="벤처인 로그인 연결" className="rounded-2xl border p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="flex items-center gap-2 font-bold">
                <KeyRound className="size-4 text-primary" />
                로그인 연결
              </h3>
              <Badge variant="outline">{sessionLabels[connection.session.state]}</Badge>
            </div>
            <p
              role={connection.session.state === "login_failed" ? "alert" : "status"}
              className={
                connection.session.state === "login_failed"
                  ? "mt-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm leading-7 text-destructive"
                  : "mt-3 text-sm leading-7"
              }
            >
              {connection.session.message}
            </p>
            {connection.session.state === "login_failed" && connection.account.saved && (
              <p className="mt-2 text-xs leading-6 text-muted-foreground">
                계정은 암호화해 저장되어 있습니다. 계정을 다시 입력하지 않고 아래 버튼으로 연결을
                재시도할 수 있습니다.
              </p>
            )}
            {connection.session.state === "awaiting_setup" && (
              <div className="mt-3">
                <Notice tone="warning">
                  열린 Edge 창에서 벤처인 공식 안내에 따라 TouchEn 보안 프로그램을 설치해 주세요.
                  설치가 끝나면 ‘설치 완료 후 다시 연결’을 누르세요. 보안 프로그램 설치는 최초 사용
                  PC에서 필요할 수 있으며, 계정을 다시 저장할 필요는 없습니다.
                </Notice>
              </div>
            )}
            {connection.session.state === "awaiting_auth" && (
              <div className="mt-3">
                <Notice>
                  <p className="font-semibold">Edge에 앱·서비스 접근 권한 요청이 표시되나요?</p>
                  <p className="mt-2">
                    ‘이 장치에서 다른 앱 및 서비스에 액세스’는 사이트가 이 PC의 앱·서비스에
                    연결하도록 허용하는 권한입니다. 요청 사이트가 www.smes.go.kr인지 확인하고, 이
                    연결에 동의하면 열린 Edge 창에서 직접 ‘허용’을 선택하세요.
                  </p>
                  <p className="mt-2">
                    회색 로딩 화면이 사라진 뒤 벤처인 페이지의 ‘로그인’을 누르세요. 추가 인증까지
                    완료했다면 아래 ‘인증 완료 후 상태 확인’을 누르세요. 앱은 권한을 대신 허용하거나
                    로그인을 자동 재시도하지 않습니다.
                  </p>
                  <p className="mt-2 text-xs">
                    현재 Edge 창을 유지해 주세요. 새로 연결하면 임시 브라우저가 바뀌므로 권한을 다시
                    요청할 수 있습니다.
                  </p>
                </Notice>
              </div>
            )}
            <p className="mt-2 text-xs leading-6 text-muted-foreground">
              이 PC에 설치된 Microsoft Edge의 별도 창을 사용합니다. 추가 인증이 나타나면 그 창에서
              직접 완료한 뒤 아래 버튼으로 확인하세요. 연결 창을 닫거나 서버를 재시작하면 다시
              연결해야 합니다.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                disabled={!connection.account.saved || !!activeSession || !!loginId || !!password}
                onClick={() => command("start")}
              >
                <Play />
                {connection.session.state === "login_failed"
                  ? "저장한 계정으로 다시 연결"
                  : "저장한 계정으로 로그인"}
              </Button>
              {connection.session.state === "awaiting_auth" && (
                <Button variant="outline" onClick={() => command("resume")}>
                  <RefreshCw />
                  인증 완료 후 상태 확인
                </Button>
              )}
              {connection.session.state === "awaiting_setup" && (
                <Button
                  disabled={!connection.account.saved || !!loginId || !!password}
                  onClick={() => command("restart")}
                >
                  <RefreshCw />
                  설치 완료 후 다시 연결
                </Button>
              )}
              {activeSession && (
                <Button variant="outline" onClick={() => command("stop")}>
                  <Square />
                  연결 창 닫기
                </Button>
              )}
              <Button asChild variant="ghost">
                <a href={ventureinUrls.login} target="_blank" rel="noreferrer">
                  공식 로그인 화면
                  <ArrowUpRight />
                </a>
              </Button>
            </div>
          </section>
          <section aria-label="자동 제출 연결 준비" className="rounded-2xl border p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="font-bold">신청서·첨부자료 연결 준비</h3>
              <Badge variant="outline">실제 제출 연결 미검증</Badge>
            </div>
            <p className="mt-3 break-words text-sm leading-7">
              {connection.preparation.planTitle
                ? `v${connection.preparation.planVersion} · ${connection.preparation.planTitle}`
                : "작성본을 준비하면 항목별 원고가 이곳에 연결됩니다."}
            </p>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-xs leading-6 text-muted-foreground">
              {connection.preparation.blockers.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
            <details className="mt-4 rounded-xl border p-4">
              <summary className="cursor-pointer text-sm font-semibold">
                입력 원고 · {connection.preparation.sections.length}개 항목
              </summary>
              <p className="mt-2 text-xs leading-6 text-muted-foreground">
                현재 앱의 작성 항목입니다. 공식 신청 화면의 항목·글자 수와 대조하기 전이며, 기관에
                입력한 내용은 아닙니다.
              </p>
              <div className="mt-3 space-y-3">
                {connection.preparation.sections.map((section) => (
                  <details key={section.key} className="rounded-lg bg-muted/30 p-3">
                    <summary className="cursor-pointer text-sm">
                      {section.title}
                      {section.needsConfirmation && " · 확인 필요"}
                    </summary>
                    <p className="mt-3 whitespace-pre-wrap break-words text-xs leading-6">
                      {section.content}
                    </p>
                  </details>
                ))}
              </div>
            </details>
            <details className="mt-3 rounded-xl border p-4">
              <summary className="cursor-pointer text-sm font-semibold">
                보관 중인 원본 파일 · {connection.preparation.attachments.length}개
              </summary>
              <p className="mt-2 text-xs leading-6 text-muted-foreground">
                원본 보관 목록입니다. 기업별 필수서류 완비 여부와 제출할 파일 선택은 별도 확인이
                필요합니다.
              </p>
              <ul className="mt-3 space-y-2 text-sm">
                {connection.preparation.attachments.map((file) => (
                  <li key={file.id} className="break-all">
                    <a
                      className="underline underline-offset-4"
                      href={`/api/studio/cases/${company.id}/sources/${file.id}`}
                      download
                    >
                      {file.originalName}
                    </a>
                  </li>
                ))}
              </ul>
            </details>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button disabled>
                <LockKeyhole />
                자동 등록·제출 · 연결 검증 필요
              </Button>
              <Button asChild variant="outline">
                <a href={ventureinUrls.application} target="_blank" rel="noreferrer">
                  공식 신청 화면
                  <ArrowUpRight />
                </a>
              </Button>
            </div>
          </section>
          <p className="text-xs leading-6 text-muted-foreground">
            벤처인 이용약관 제20조에는 계정의 제3자 이용 및 사전 승낙 없는 영리 이용에 관한 제한이
            있습니다. 상용 서비스의 자동 연동 범위를 확인해야 합니다.{" "}
            <a
              href={ventureinUrls.terms}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-4"
            >
              공식 이용약관
            </a>
          </p>
        </fieldset>
      )}
    </div>
  );
}
