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
import { VentureinWorkflowPanel } from "./venturein-workflow-panel";
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
  awaiting_login: "로그인 화면 준비 대기",
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
  const [workflowDirty, setWorkflowDirty] = useState(false);
  const endpoint = `/api/studio/cases/${company.id}/venturein`;
  useDirty(Boolean(loginId || password || busy || workflowDirty), setDirty);
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
  async function command(action: "start" | "continue" | "resume" | "stop", current = connection) {
    if (!current) return;
    setBusy(
      action === "start"
        ? "별도 Edge 창에서 벤처인 로그인을 시작하고 있습니다"
        : action === "continue"
          ? "열린 Edge 창에서 로그인을 이어가고 있습니다"
          : "로그인 연결 상태를 확인하고 있습니다",
    );
    setError("");
    try {
      const result = await studioFetch<VentureConnectionStatus>(endpoint, {
        method: "POST",
        ...jsonBody({
          action,
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
    [
      "starting",
      "awaiting_setup",
      "awaiting_login",
      "awaiting_auth",
      "connected_unmapped",
    ].includes(connection.session.state);
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
        로그인 후 신청기업을 대조하고, 공식 항목과 원고·원본 파일을 연결해 제출 전 점검을
        진행합니다. 점검을 통과한 연결안은 정확한 값과 첨부 파일을 검토하고 전송을 승인한 뒤 한 번
        실행할 수 있습니다. 저장·동의·제출 버튼은 자동 실행하지 않습니다.
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
                  설치가 끝나면 ‘설치 완료 후 로그인 계속’을 누르세요. 같은 창에서 로그인 화면을
                  다시 확인합니다. 계정을 다시 저장할 필요는 없습니다.
                </Notice>
              </div>
            )}
            {["awaiting_login", "awaiting_auth"].includes(connection.session.state) && (
              <div className="mt-3">
                <Notice>
                  <p className="font-semibold">
                    {connection.session.state === "awaiting_login"
                      ? "Edge에 앱·서비스 접근 권한 요청이 표시되나요?"
                      : "열린 Edge 창의 안내를 확인해 주세요"}
                  </p>
                  {connection.session.state === "awaiting_login" ? (
                    <p className="mt-2">
                      ‘이 장치에서 다른 앱 및 서비스에 액세스’는 사이트가 이 PC의 앱·서비스에
                      연결하도록 허용하는 권한입니다. 요청 사이트가 www.smes.go.kr인지 확인하고, 이
                      연결에 동의하면 열린 Edge 창에서 직접 ‘허용’을 선택하세요. 앱은 권한을 대신
                      허용하지 않습니다.
                    </p>
                  ) : (
                    <p className="mt-2">
                      로그인 결과, 신청 준비 공지 또는 추가 인증이 표시될 수 있습니다. 열린 안내를
                      확인한 뒤 ‘인증 완료 후 상태 확인’을 눌러 주세요.
                    </p>
                  )}
                  <p className="mt-2">
                    {connection.session.state === "awaiting_login"
                      ? "회색 로딩 화면이 사라지면 아래 ‘권한·로딩 확인 후 로그인 계속’을 누르세요. 열린 창에서 저장한 계정으로 로그인을 이어갑니다."
                      : "로그인 화면이 그대로라면 사이트 안내를 확인하고 같은 창에서 직접 로그인한 뒤 상태를 확인하세요. 이미 시작한 로그인 요청을 자동으로 반복하지 않습니다."}
                  </p>
                  {connection.session.state === "awaiting_auth" && (
                    <details className="mt-3 rounded-lg border p-3">
                      <summary className="cursor-pointer text-xs font-semibold">
                        앱·서비스 접근 권한 요청이 실제로 표시되는 경우
                      </summary>
                      <p className="mt-2">
                        Edge의 ‘이 장치에서 다른 앱 및 서비스에 액세스’ 요청은 사이트가 이 PC의
                        앱·서비스에 연결하도록 허용하는 권한입니다. 요청 사이트가 www.smes.go.kr인지
                        확인하고, 이 연결에 동의하면 열린 Edge 창에서 직접 ‘허용’을 선택하세요. 앱은
                        권한을 대신 허용하지 않습니다.
                      </p>
                    </details>
                  )}
                  <p className="mt-2 text-xs">
                    {connection.session.state === "awaiting_login"
                      ? "현재 Edge 창을 유지해 주세요. 새로 연결하면 임시 브라우저가 바뀌므로 권한을 다시 요청할 수 있습니다."
                      : "현재 Edge 창을 유지해 주세요. 같은 창에서 안내와 로그인 결과를 확인합니다."}
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
              {["awaiting_setup", "awaiting_login", "awaiting_auth"].includes(
                connection.session.state,
              ) && (
                <Button variant="outline" onClick={() => command("resume")}>
                  <RefreshCw />
                  인증 완료 후 상태 확인
                </Button>
              )}
              {["awaiting_setup", "awaiting_login"].includes(connection.session.state) && (
                <Button
                  disabled={!connection.account.saved || !!loginId || !!password}
                  onClick={() => command("continue")}
                >
                  <RefreshCw />
                  {connection.session.state === "awaiting_setup"
                    ? "설치 완료 후 로그인 계속"
                    : "권한·로딩 확인 후 로그인 계속"}
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
          <VentureinWorkflowPanel
            company={company}
            connection={connection}
            executionBlocked={Boolean(loginId || password || busy)}
            onDirtyChange={setWorkflowDirty}
          />
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
