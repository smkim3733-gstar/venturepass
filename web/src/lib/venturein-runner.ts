import "server-only";

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type JSHandle,
} from "playwright-core";
import { ventureinUrls, type VentureSessionStatus } from "./venturein-schema";
import { StudioError } from "./studio-http";
import { collectVentureScreen } from "./venturein-inspection-collector";
import { ventureInspectionRules } from "./venturein-inspection";
import {
  applyVentureTextInput,
  VentureTextInputError,
  type VentureTextInput,
  type VentureTextInputResult,
} from "./venturein-text-input";
import {
  compareVentureInputs,
  VentureComparisonError,
  type VentureComparisonInput,
  type VentureComparisonResult,
} from "./venturein-input-comparison";

const sessionLifetimeMs = 15 * 60 * 1000;
const operationTimeoutMs = 15_000;
const menuTimeoutMs = 3_000;
const officialLogin = new URL(ventureinUrls.login);
const officialSetup = new URL(ventureinUrls.securityInstall);
const applicationPrecheckUrl = `${ventureinUrls.application}/viewVniaBfrv`;
const applicationNoticeTitle = "안내사항";
const applicationNoticeBody =
  "안녕하세요. 벤처기업확인기관입니다. 벤처기업신청에 앞서 반드시 <가이드북>을 확인해 주시기 바랍니다. 또한, 사업계획서 및 첨부서류 미비한 경우 접수단계에서 보완요청이 진행 되며, 이에 따른 접수기간도 지연될 수 있으니, <필독 안내문(실수방지)>도 꼭 참고하신 후 신청해 주시기 바랍니다. 감사합니다.";
type NoticeAttempt = { attempted: boolean };
const applicationNoticeFailureMessages = {
  title_ambiguous: "안내사항 제목이 여러 개 보입니다.",
  authentication_unverified: "이 창에서 로그인 완료를 확인한 이력이 없습니다.",
  already_attempted: "이번 화면 확인에서 안내 확인을 이미 한 번 시도했습니다.",
  form_present: "안내 영역에 입력·동의 항목 또는 서식이 포함되어 있습니다.",
  scope_exceeded: "안내 영역이 허용된 탐색 범위를 벗어났습니다.",
  body_mismatch: "안내 본문이 확인된 준비 공지와 일치하지 않습니다.",
  confirmation_missing: "본문은 일치하지만 같은 안내 영역에서 확인 버튼을 찾지 못했습니다.",
  confirmation_ambiguous: "같은 안내 영역에 확인 버튼이 여러 개 보입니다.",
  other_actions: "안내 영역에 확인된 닫기·자료 보기 이외의 동작이 있습니다.",
  extra_text: "확인된 준비 공지 이외의 문구가 안내 영역에 남아 있습니다.",
  changed: "확인 중 안내 내용·주소 또는 연결 창이 바뀌었습니다.",
  precheck_query:
    "사전확인 화면 주소에 쿼리가 있습니다. 현재 창을 보존하고 현재 화면 읽기로 확인해 주세요.",
  precheck_hash:
    "사전확인 화면 주소에 해시가 있습니다. 현재 창을 보존하고 현재 화면 읽기로 확인해 주세요.",
  precheck_query_hash:
    "사전확인 화면 주소에 쿼리와 해시가 있습니다. 현재 창을 보존하고 현재 화면 읽기로 확인해 주세요.",
  precheck_variant:
    "사전확인 화면 주소가 확인된 기본 주소와 다릅니다. 현재 창을 보존하고 현재 화면 읽기로 확인해 주세요.",
  click_failed: "안내 확인 버튼 클릭을 완료하지 못했습니다.",
  close_unconfirmed: "확인 클릭 후 안내가 닫혔는지 확인하지 못했습니다.",
  read_failed: "안내 영역을 제한 시간 안에 읽지 못했습니다.",
} as const;
type NoticeFailure = keyof typeof applicationNoticeFailureMessages;
const inspectionPhaseLabels = {
  officialPage: "공식 화면 확인",
  loginForm: "로그인 입력란 확인",
  applicationNotice: "신청 준비 안내 확인",
  precheckDocument: "사전확인 문서 준비 대기",
  advancedLoginForm: "새 화면 로그인 입력란 확인",
  logout: "로그아웃 표시 확인",
  mobileMenu: "모바일 메뉴 로그인 표시 확인",
} as const;
type InspectionPhase = keyof typeof inspectionPhaseLabels;

function inspectionFailureReason(error: unknown) {
  if (error instanceof Error && error.name === "TimeoutError") return "제한 시간을 초과했습니다.";
  if (error instanceof Error && error.message.toLowerCase().includes("strict mode violation"))
    return "동일한 화면 요소가 여러 개여서 확인하지 못했습니다.";
  return "단계 처리를 완료하지 못했습니다.";
}

/** Classify the already-open page only; its query and hash never become navigation inputs. */
function isCurrentPrecheckPage(value: string) {
  try {
    const url = new URL(value);
    return isOfficialPage(value) && `${url.origin}${url.pathname}` === applicationPrecheckUrl;
  } catch {
    return false;
  }
}

function precheckAddressVariant(value: string) {
  try {
    const url = new URL(value);
    if (
      !isOfficialPage(value) ||
      `${url.origin}${url.pathname}` !== applicationPrecheckUrl ||
      value === applicationPrecheckUrl
    )
      return undefined;
    // Return presence only. Never expose the address suffix or its values.
    if (url.search && url.hash) return "precheck_query_hash" as const;
    if (url.search) return "precheck_query" as const;
    if (url.hash) return "precheck_hash" as const;
    return "precheck_variant" as const;
  } catch {
    return undefined;
  }
}

const failureMessages = {
  browser: "Edge 자동 연결 창을 시작하지 못했습니다. Edge 설치 상태와 실행 권한을 확인해 주세요.",
  context: "Edge에 임시 로그인 화면을 만들지 못했습니다. 연결 창을 닫고 다시 시도해 주세요.",
  navigation:
    "공식 벤처인 로그인 페이지를 불러오지 못했습니다. 네트워크와 벤처인 사이트 접속 상태를 확인해 주세요.",
  form: "벤처인 로그인 입력란 또는 버튼을 확인하지 못했습니다. 페이지 로딩 지연이나 화면 변경이 있는지 확인한 뒤 다시 시도해 주세요.",
  readiness: "벤처인 로그인 화면이 아직 입력할 준비가 되지 않았습니다.",
  idEntry: "벤처인 아이디 입력란에 자동 입력하지 못했습니다. 로그인 화면을 다시 연결해 주세요.",
  passwordEntry:
    "벤처인 비밀번호 입력란에 자동 입력하지 못했습니다. 로그인 화면을 다시 연결해 주세요.",
  loginAction:
    "벤처인 로그인 버튼 동작을 완료하지 못했습니다. 로그인 성공 여부는 확인되지 않았습니다. 다시 연결해 주세요.",
} as const;

class UnverifiedDestinationError extends Error {}
class SetupInterruptedError extends Error {}

const clickFailureMessages = {
  timeout: "로그인 버튼 처리 대기 시간이 초과되었습니다.",
  covered: "다른 화면 요소가 로그인 버튼을 가리고 있어 자동 클릭을 완료하지 못했습니다.",
  invisible: "로그인 버튼이 보이지 않아 자동 클릭을 완료하지 못했습니다.",
  detached: "로그인 버튼이 화면에서 변경되거나 사라져 자동 클릭을 완료하지 못했습니다.",
  navigation: "로그인 요청 후 화면 전환 확인을 완료하지 못했습니다.",
  other: "로그인 버튼 동작을 완료하지 못했습니다.",
} as const;

function classifyClickFailure(error: unknown): keyof typeof clickFailureMessages {
  if (!(error instanceof Error)) return "other";
  // Inspect known categories only. Never return the source error or its action arguments.
  const message = error.message.toLowerCase();
  if (message.includes("intercepts pointer events")) return "covered";
  if (message.includes("not visible")) return "invisible";
  if (message.includes("detached")) return "detached";
  if (message.includes("waiting for scheduled navigations")) return "navigation";
  if (error.name === "TimeoutError") return "timeout";
  return "other";
}

type Session = {
  status: VentureSessionStatus;
  cancelled: boolean;
  operationInProgress?: boolean;
  setupObservedDuringAttempt?: boolean;
  fillingCredentials?: boolean;
  loginAttempted?: boolean;
  authenticatedAt?: string;
  notifyDialog?: () => void;
  browser?: Browser;
  context?: BrowserContext;
  page?: Page;
  timer?: ReturnType<typeof setTimeout>;
  documentRevision?: number;
  textInputTracking?: true;
  inspectionBinding?: {
    snapshotId: string;
    rawUrl: string;
    document: JSHandle<Document>;
    revision: number;
  };
};

// Share sessions between Next route bundles in this process, never across restarts.
const processState = globalThis as typeof globalThis & {
  __ventureinSessions?: Map<string, Session>;
};
const sessions = (processState.__ventureinSessions ??= new Map<string, Session>());

function idleStatus(): VentureSessionStatus {
  return {
    state: "idle",
    message: "연결된 벤처인 창이 없습니다. 앱을 다시 시작하면 새로 연결해야 합니다.",
    startedAt: null,
    updatedAt: null,
  };
}

function update(session: Session, state: VentureSessionStatus["state"], message: string) {
  // Permission/installation waiting must not consume the authenticated working window.
  // Renew once on the first verified login only; polling and later inspections never extend it.
  if (state === "connected_unmapped" && !session.authenticatedAt) {
    session.authenticatedAt = new Date().toISOString();
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      if (active(session))
        void closeSession(
          session,
          "stopped",
          "로그인 확인 후 15분이 지나 임시 벤처인 창을 닫았습니다. 다시 연결해 주세요.",
        );
    }, sessionLifetimeMs);
    session.timer.unref?.();
  }
  session.status = { ...session.status, state, message, updatedAt: new Date().toISOString() };
}

function isLoginUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.origin === officialLogin.origin &&
      url.pathname === officialLogin.pathname &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function isOfficialPage(value: string) {
  try {
    const url = new URL(value);
    return (
      url.origin === officialLogin.origin &&
      url.pathname.startsWith("/venturein/") &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function isOfficialSetupPage(value: string) {
  try {
    const url = new URL(value);
    return (
      url.origin === officialSetup.origin &&
      url.pathname === officialSetup.pathname &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function markSetupIfNeeded(session: Session) {
  if (!active(session) || !session.page) return false;
  if (!isOfficialSetupPage(session.page.url())) return false;
  if (session.operationInProgress) session.setupObservedDuringAttempt = true;
  update(
    session,
    hasAttemptedLogin(session) ? "awaiting_auth" : "awaiting_setup",
    hasAttemptedLogin(session)
      ? "로그인 시도 후 벤처인에서 TouchEn 보안 프로그램 설치를 요청했습니다. 같은 창에서 공식 안내를 처리하고 로그인 결과를 직접 확인해 주세요. 앱은 로그인을 다시 전송하지 않습니다."
      : "벤처인에서 TouchEn 보안 프로그램 설치를 요청했습니다. 열린 공식 설치 화면에서 설치를 완료한 뒤 같은 창에서 로그인을 이어가세요. 자동 로그인은 중단했으며 프로그램을 자동 설치하지 않습니다.",
  );
  return true;
}

function waitForLogin(session: Session, message: string) {
  update(session, "awaiting_login", message);
}

async function refuseDebugMode(session: Session) {
  if (!process.env.DEBUG?.trim() && (!process.env.PWDEBUG || process.env.PWDEBUG === "0"))
    return false;
  await closeSession(
    session,
    "login_failed",
    "자동화 디버그 환경에서는 계정정보를 입력하지 않습니다. DEBUG·PWDEBUG 설정을 해제하고 앱을 다시 시작해 주세요.",
  );
  return true;
}

function active(session: Session) {
  return !session.cancelled;
}

function hasAttemptedLogin(session: Session) {
  // A hot-reloaded session from older code has no attempt flag. Do not reinterpret it as safe to retry.
  return (
    session.loginAttempted ??
    ["awaiting_auth", "connected_unmapped", "awaiting_setup"].includes(session.status.state)
  );
}

async function closeSession(session: Session, state: "stopped" | "login_failed", message: string) {
  session.cancelled = true;
  session.fillingCredentials = false;
  update(session, state, message);
  if (session.timer) clearTimeout(session.timer);
  const browser = session.browser;
  const binding = session.inspectionBinding;
  session.inspectionBinding = undefined;
  session.page = undefined;
  session.context = undefined;
  session.browser = undefined;
  // Browser errors can contain URLs, field values and execution details. Never expose them.
  if (browser) await browser.close().catch(() => undefined);
  if (binding) await binding.document.dispose().catch(() => undefined);
}

export function getVentureSession(caseId: string): VentureSessionStatus {
  const session = sessions.get(caseId);
  return session ? { ...session.status } : idleStatus();
}

export async function stopVentureSession(caseId: string): Promise<VentureSessionStatus> {
  const session = sessions.get(caseId);
  if (session && active(session)) {
    await closeSession(
      session,
      "stopped",
      "벤처인 연결 창을 닫았습니다. 임시 로그인 세션은 종료됩니다.",
    );
  }
  return getVentureSession(caseId);
}

export async function startVentureSession(
  caseId: string,
  credentials: { loginId: string; password: string },
): Promise<VentureSessionStatus> {
  const previous = sessions.get(caseId);
  if (previous && active(previous)) return { ...previous.status };

  const now = new Date().toISOString();
  const session: Session = {
    cancelled: false,
    loginAttempted: false,
    operationInProgress: true,
    status: {
      state: "starting",
      message: "별도 Edge 창에서 공식 벤처인 로그인 화면을 확인하고 있습니다.",
      startedAt: now,
      updatedAt: now,
    },
  };
  // Reserve before the first await so concurrent starts cannot submit the login twice.
  sessions.set(caseId, session);
  session.timer = setTimeout(() => {
    if (active(session)) {
      void closeSession(
        session,
        "stopped",
        "15분 연결 시간이 지나 임시 벤처인 창을 닫았습니다. 다시 연결해 주세요.",
      );
    }
  }, sessionLifetimeMs);
  session.timer.unref?.();

  let phase: keyof typeof failureMessages = "browser";
  try {
    // Playwright debug output can include action arguments. Refuse credential entry when enabled.
    if (await refuseDebugMode(session)) return getVentureSession(caseId);
    if (!credentials.loginId || !credentials.password) throw new Error("Missing credentials");
    // Playwright creates a temporary profile; never reuse the user's personal Edge profile.
    const browser = await chromium.launch({
      channel: "msedge",
      headless: false,
      timeout: operationTimeoutMs,
      env: { ...process.env, DEBUG: "", PWDEBUG: "0" },
    });
    if (!active(session)) {
      await browser.close().catch(() => undefined);
      return getVentureSession(caseId);
    }
    session.browser = browser;
    browser.on("disconnected", () => {
      if (active(session))
        void closeSession(
          session,
          "stopped",
          "벤처인 연결 창이 종료되었습니다. 다시 연결해 주세요.",
        );
    });
    phase = "context";
    const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: "block" });
    if (!active(session)) return getVentureSession(caseId);
    session.context = context;
    context.setDefaultTimeout(operationTimeoutMs);
    const page = await context.newPage();
    if (!active(session)) return getVentureSession(caseId);
    session.page = page;
    page.on("framenavigated", () => {
      session.documentRevision = (session.documentRevision ?? 0) + 1;
      if (!active(session) || markSetupIfNeeded(session)) return;
      if (session.status.state === "awaiting_setup")
        waitForLogin(
          session,
          "설치 화면에서 돌아왔습니다. 같은 Edge 창에서 권한·화면 준비를 마친 뒤 로그인을 이어가거나, 직접 로그인했다면 상태를 확인해 주세요.",
        );
    });
    page.on("popup", () => {
      // A child window can be an application transition, even while this page's URL stays fixed.
      session.documentRevision = (session.documentRevision ?? 0) + 1;
    });
    session.textInputTracking = true;
    page.on("close", () => {
      if (active(session))
        void closeSession(session, "stopped", "벤처인 연결 창이 닫혔습니다. 다시 연결해 주세요.");
    });

    // A redirect during credential entry must not move the form to an unverified destination.
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (
        session.fillingCredentials &&
        request.isNavigationRequest() &&
        !isLoginUrl(request.url()) &&
        !isOfficialSetupPage(request.url())
      ) {
        await route.abort();
        return;
      }
      await route.continue();
    });

    page.on("dialog", () => {
      // Keep native dialogs for the user. Do not read their contents or accept them automatically.
      if (active(session) && !markSetupIfNeeded(session))
        update(
          session,
          hasAttemptedLogin(session) ? "awaiting_auth" : "awaiting_login",
          "벤처인 창의 안내를 직접 확인해 주세요. 로그인 결과와 추가 인증은 아직 확인되지 않았습니다.",
        );
      session.notifyDialog?.();
    });

    await enterCredentialsAndLogin(session, credentials, true);
  } catch {
    if (active(session)) await closeSession(session, "login_failed", failureMessages[phase]);
  } finally {
    session.fillingCredentials = false;
    session.operationInProgress = false;
  }
  return getVentureSession(caseId);
}

async function enterCredentialsAndLogin(
  session: Session,
  credentials: { loginId: string; password: string },
  navigateToLogin: boolean,
) {
  const page = session.page!;
  let phase: keyof typeof failureMessages = "navigation";
  let clickFailure: keyof typeof clickFailureMessages = "other";
  let dialogObserved = false;
  const dialogAppeared = new Promise<void>((resolve) => {
    session.notifyDialog = () => {
      dialogObserved = true;
      resolve();
    };
  });
  session.setupObservedDuringAttempt = false;
  try {
    if (await refuseDebugMode(session)) return;
    if (!active(session)) return;
    if (!credentials.loginId || !credentials.password) throw new Error("Missing credentials");

    if (navigateToLogin)
      await page.goto(ventureinUrls.login, {
        waitUntil: "domcontentloaded",
        timeout: operationTimeoutMs,
      });
    if (markSetupIfNeeded(session)) return;
    // The public form has title attributes, but no labels or aria-labels.
    const loginId = page.getByPlaceholder("아이디", { exact: true });
    const password = page.getByPlaceholder("비밀번호", { exact: true });
    const loginButton = page.getByRole("button", { name: "로그인", exact: true });
    const assertLoginDestination = () => {
      if (!active(session) || !isLoginUrl(page.url())) throw new UnverifiedDestinationError();
      if (session.setupObservedDuringAttempt) throw new SetupInterruptedError();
    };
    assertLoginDestination();
    phase = "form";
    await Promise.all([
      loginId.waitFor({ state: "visible", timeout: operationTimeoutMs }),
      password.waitFor({ state: "visible", timeout: operationTimeoutMs }),
      loginButton.waitFor({ state: "visible", timeout: operationTimeoutMs }),
    ]);
    if (
      !(await loginId.isVisible()) ||
      !(await password.isVisible()) ||
      !(await loginButton.isVisible())
    ) {
      throw new Error("Login form unavailable");
    }
    assertLoginDestination();
    // Trial performs actionability checks only; it never clicks or grants browser permissions.
    phase = "readiness";
    await loginButton.click({ trial: true, timeout: operationTimeoutMs });
    assertLoginDestination();
    session.fillingCredentials = true;
    phase = "idEntry";
    await loginId.fill(credentials.loginId);
    assertLoginDestination();
    phase = "passwordEntry";
    await password.fill(credentials.password);
    assertLoginDestination();
    session.fillingCredentials = false;
    phase = "loginAction";
    // Never repeat a real click in this session, even if its result is uncertain.
    session.loginAttempted = true;
    const clicked = await Promise.race([
      loginButton.click({ timeout: operationTimeoutMs }).then(
        () => true,
        (error: unknown) => {
          clickFailure = classifyClickFailure(error);
          return false;
        },
      ),
      dialogAppeared.then(() => true),
    ]);
    if (!active(session)) return;
    if (markSetupIfNeeded(session)) return;
    if (!clicked) throw new Error("Login action incomplete");
    update(
      session,
      "awaiting_auth",
      "벤처인 창에서 로그인 결과와 추가 인증을 확인한 뒤 ‘인증 완료 후 상태 확인’을 눌러 주세요. 로그인·신청·제출 완료로 처리하지 않았습니다.",
    );
  } catch (error) {
    if (!active(session) || markSetupIfNeeded(session)) return;
    if (
      !hasAttemptedLogin(session) &&
      isLoginUrl(page.url()) &&
      (phase === "readiness" || session.setupObservedDuringAttempt || dialogObserved)
    ) {
      waitForLogin(
        session,
        phase === "readiness"
          ? `${clickFailureMessages[classifyClickFailure(error)]} 계정정보는 입력하지 않았습니다. 같은 Edge 창에서 권한·안내와 회색 로딩 화면을 처리한 뒤 로그인을 이어가세요.`
          : "설치·권한 안내 중 자동 입력을 중단했습니다. 같은 Edge 창에서 화면 준비를 마친 뒤 로그인을 이어가세요. 로그인은 전송하지 않았습니다.",
      );
      return;
    }
    if (
      active(session) &&
      phase === "loginAction" &&
      session.page &&
      isOfficialPage(session.page.url())
    ) {
      const category = clickFailure === "other" ? classifyClickFailure(error) : clickFailure;
      update(
        session,
        "awaiting_auth",
        `${clickFailureMessages[category]} 열린 벤처인 창의 안내를 직접 확인해 주세요. 로그인 성공 여부는 확인되지 않았으며 자동 재시도하지 않습니다. 확인을 마친 뒤 ‘인증 완료 후 상태 확인’을 눌러 주세요.`,
      );
      return;
    }
    if (active(session)) {
      await closeSession(
        session,
        "login_failed",
        error instanceof UnverifiedDestinationError
          ? "확인된 공식 로그인 주소와 다른 화면으로 이동하여 계정정보 입력을 중단했습니다. 벤처인 로그인 화면을 다시 연결해 주세요."
          : failureMessages[phase],
      );
    }
  } finally {
    // Early setup redirects must not leave a guard blocking the user's later manual login.
    session.fillingCredentials = false;
    session.notifyDialog = undefined;
  }
}

export async function resumeVentureSession(caseId: string): Promise<VentureSessionStatus> {
  const session = sessions.get(caseId);
  if (!session || !active(session) || session.operationInProgress) return getVentureSession(caseId);
  // Explicit status checks can inspect the mobile menu; serialize that brief UI operation too.
  session.operationInProgress = true;
  try {
    return await inspectVentureSession(caseId, true);
  } finally {
    session.operationInProgress = false;
  }
}

/** Observe application metadata in the existing authenticated window. Never fill, upload or submit. */
export async function inspectVentureApplication(
  caseId: string,
  destination: "application" | "innovation" | "current",
) {
  const session = sessions.get(caseId);
  if (!session || !active(session) || !session.page || !session.status.startedAt)
    throw new StudioError(
      "벤처인에 로그인한 뒤 신청 화면을 확인해 주세요.",
      409,
      "VENTURE_NOT_CONNECTED",
    );
  if (session.operationInProgress)
    throw new StudioError("벤처인 연결 작업이 진행 중입니다.", 409, "VENTURE_BUSY");
  session.operationInProgress = true;
  const noticeAttempt = { attempted: false };
  try {
    await inspectVentureSession(caseId, true, noticeAttempt);
    if (!active(session) || session.status.state !== "connected_unmapped" || !session.page)
      throw new StudioError(
        "현재 창의 로그인 표시를 확인한 뒤 다시 시도해 주세요.",
        409,
        "VENTURE_NOT_CONNECTED",
      );
    const page = session.page;
    // Reuse current-screen inspection after fresh authentication. Preserve the opened URL verbatim.
    const preservedPrecheckUrl =
      destination === "innovation" && session.authenticatedAt && isCurrentPrecheckPage(page.url())
        ? page.url()
        : null;
    const inspectionDestination = preservedPrecheckUrl ? "current" : destination;
    if (
      (inspectionDestination === "application" || inspectionDestination === "innovation") &&
      page.url() !== ventureinUrls.application
    )
      await page.goto(ventureinUrls.application, {
        waitUntil: "domcontentloaded",
        timeout: operationTimeoutMs,
      });
    if (!active(session) || page.isClosed() || session.page !== page)
      throw new StudioError(
        "연결 창이 종료되었습니다. 다시 연결해 주세요.",
        409,
        "VENTURE_NOT_CONNECTED",
      );
    await inspectVentureSession(caseId, true, noticeAttempt);
    if (preservedPrecheckUrl && page.url() !== preservedPrecheckUrl)
      throw new StudioError(
        "확인 중 화면이 바뀌었습니다. 현재 화면을 다시 확인해 주세요.",
        409,
        "VENTURE_SCREEN_CHANGED",
      );
    if (
      inspectionDestination === "innovation" &&
      !(session.authenticatedAt && isCurrentPrecheckPage(page.url()))
    ) {
      if (!active(session) || session.status.state !== "connected_unmapped")
        throw new StudioError(
          "공식 화면의 로그인 표시를 먼저 확인해 주세요.",
          409,
          "VENTURE_NOT_CONNECTED",
        );
      await openInnovationApplication(session, page);
      await inspectVentureSession(caseId, true, noticeAttempt);
    }
    const observedUrl = page.url();
    if (
      !active(session) ||
      session.status.state !== "connected_unmapped" ||
      !isOfficialPage(observedUrl) ||
      isLoginUrl(observedUrl) ||
      isOfficialSetupPage(observedUrl)
    )
      throw new StudioError(
        "공식 신청 화면을 확인할 수 없습니다. 열린 Edge 창의 안내를 확인해 주세요.",
        409,
        "VENTURE_SCREEN_UNAVAILABLE",
      );
    const documentHandle = await page.evaluateHandle(() => document);
    const revision = session.documentRevision ?? 0;
    try {
      const screen = await collectVentureScreen(page);
      if (
        !active(session) ||
        page.isClosed() ||
        session.page !== page ||
        page.url() !== observedUrl ||
        (session.documentRevision ?? 0) !== revision ||
        !(await documentHandle.evaluate((observedDocument) => observedDocument === document))
      )
        throw new StudioError(
          "확인 중 화면이 바뀌었습니다. 현재 화면을 다시 확인해 주세요.",
          409,
          "VENTURE_SCREEN_CHANGED",
        );
      const previous = session.inspectionBinding;
      session.inspectionBinding = {
        snapshotId: screen.id,
        rawUrl: observedUrl,
        document: documentHandle,
        revision,
      };
      if (previous) await previous.document.dispose().catch(() => undefined);
      return { screen, sessionStartedAt: session.status.startedAt };
    } catch (error) {
      await documentHandle.dispose().catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (error instanceof StudioError) throw error;
    throw new StudioError(
      "공식 화면 정보를 읽지 못했습니다. 열린 Edge 창의 안내를 확인해 주세요.",
      502,
      "VENTURE_INSPECTION_FAILED",
    );
  } finally {
    session.operationInProgress = false;
  }
}

/** Apply explicitly approved text/files in the already inspected document only. */
export async function fillVentureApplication(
  caseId: string,
  input: VentureTextInput,
  assertCurrent: () => void,
): Promise<VentureTextInputResult> {
  const stopped = (code: string): VentureTextInputResult => ({
    status: "stopped",
    completedFieldKeys: [],
    touchedFieldKeys: [],
    attemptedFieldKey: null,
    code,
  });
  const session = sessions.get(caseId);
  if (
    !session ||
    !active(session) ||
    !session.page ||
    !session.textInputTracking ||
    !session.authenticatedAt ||
    session.status.startedAt !== input.sessionStartedAt
  )
    return stopped("SESSION_CHANGED");
  if (session.operationInProgress) return stopped("SESSION_BUSY");
  const page = session.page;
  const binding = session.inspectionBinding;
  if (!binding || binding.snapshotId !== input.snapshot.id) return stopped("SCREEN_CHANGED");
  session.operationInProgress = true;
  try {
    const checkCurrent = () => {
      assertCurrent();
      if (process.env.DEBUG?.trim() || (process.env.PWDEBUG && process.env.PWDEBUG !== "0"))
        throw new VentureTextInputError("DEBUG_ENABLED");
      if (
        !active(session) ||
        session.page !== page ||
        page.isClosed() ||
        session.status.startedAt !== input.sessionStartedAt ||
        session.status.state !== "connected_unmapped" ||
        !session.authenticatedAt ||
        Date.now() >= Date.parse(session.authenticatedAt) + sessionLifetimeMs
      )
        throw new VentureTextInputError("SESSION_CHANGED");
      if (
        session.inspectionBinding !== binding ||
        page.url() !== binding.rawUrl ||
        (session.documentRevision ?? 0) !== binding.revision ||
        !isOfficialPage(page.url()) ||
        isLoginUrl(page.url()) ||
        isOfficialSetupPage(page.url())
      )
        throw new VentureTextInputError("SCREEN_CHANGED");
    };
    const verifyCurrent = async () => {
      checkCurrent();
      if (!(await binding.document.evaluate((observedDocument) => observedDocument === document)))
        throw new VentureTextInputError("SCREEN_CHANGED");
      checkCurrent();
      // Read only. Never dismiss notices, open menus or retry credentials during an input batch.
      const hasLogin =
        (await page.getByPlaceholder("아이디", { exact: true }).isVisible()) ||
        (await page.getByPlaceholder("비밀번호", { exact: true }).isVisible());
      const unsafeControls = await page
        .locator(
          'input[type="password"], input[autocomplete="one-time-code"], input[autocomplete="current-password"], input[autocomplete="new-password"], iframe, [contenteditable]:not([contenteditable="false"])',
        )
        .filter({ visible: true })
        .count();
      const hasLogout = await page
        .getByRole("link", { name: "로그아웃", exact: true })
        .or(page.getByRole("button", { name: "로그아웃", exact: true }))
        .filter({ visible: true })
        .count();
      checkCurrent();
      if (hasLogin || unsafeControls || !hasLogout)
        throw new VentureTextInputError("AUTH_UNVERIFIED");
    };
    return await applyVentureTextInput(page, input, checkCurrent, verifyCurrent);
  } catch (error) {
    return stopped(error instanceof VentureTextInputError ? error.code : "INPUT_FAILED");
  } finally {
    session.operationInProgress = false;
  }
}

/** Read the currently selected mapping only. No notices, menus, credentials or navigation. */
export async function compareVentureApplication(
  caseId: string,
  input: VentureComparisonInput,
  assertCurrent: () => void,
  finalizeCurrent: () => void = () => {},
): Promise<VentureComparisonResult> {
  const stopped = (code: string): VentureComparisonResult => ({
    status: "stopped",
    fields: [],
    code,
    observedAt: null,
  });
  const session = sessions.get(caseId);
  if (
    !session ||
    !active(session) ||
    !session.page ||
    !session.textInputTracking ||
    !session.authenticatedAt ||
    session.status.startedAt !== input.sessionStartedAt
  )
    return stopped("SESSION_CHANGED");
  if (session.operationInProgress) return stopped("SESSION_BUSY");
  const page = session.page;
  const binding = session.inspectionBinding;
  if (!binding || binding.snapshotId !== input.snapshot.id) return stopped("SCREEN_CHANGED");
  session.operationInProgress = true;
  try {
    const checkCurrent = () => {
      assertCurrent();
      if (process.env.DEBUG?.trim() || (process.env.PWDEBUG && process.env.PWDEBUG !== "0"))
        throw new VentureComparisonError("DEBUG_ENABLED");
      if (
        !active(session) ||
        session.page !== page ||
        page.isClosed() ||
        session.status.startedAt !== input.sessionStartedAt ||
        session.status.state !== "connected_unmapped" ||
        !session.authenticatedAt ||
        Date.now() >= Date.parse(session.authenticatedAt) + sessionLifetimeMs
      )
        throw new VentureComparisonError("SESSION_CHANGED");
      if (
        session.inspectionBinding !== binding ||
        page.url() !== binding.rawUrl ||
        (session.documentRevision ?? 0) !== binding.revision ||
        !isOfficialPage(page.url()) ||
        isLoginUrl(page.url()) ||
        isOfficialSetupPage(page.url())
      )
        throw new VentureComparisonError("SCREEN_CHANGED");
    };
    const verifyCurrent = async () => {
      checkCurrent();
      if (!(await binding.document.evaluate((observedDocument) => observedDocument === document)))
        throw new VentureComparisonError("SCREEN_CHANGED");
      checkCurrent();
      const hasLogin =
        (await page.getByPlaceholder("아이디", { exact: true }).isVisible()) ||
        (await page.getByPlaceholder("비밀번호", { exact: true }).isVisible());
      const unsafe = await page
        .locator(
          'input[type="password"], input[autocomplete="one-time-code"], input[autocomplete="current-password"], input[autocomplete="new-password"], iframe, [contenteditable]:not([contenteditable="false"])',
        )
        .filter({ visible: true })
        .count();
      const hasLogout = await page
        .getByRole("link", { name: "로그아웃", exact: true })
        .or(page.getByRole("button", { name: "로그아웃", exact: true }))
        .filter({ visible: true })
        .count();
      checkCurrent();
      if (hasLogin || unsafe || !hasLogout) throw new VentureComparisonError("AUTH_UNVERIFIED");
    };
    const result = await compareVentureInputs(
      page,
      input,
      checkCurrent,
      verifyCurrent,
      finalizeCurrent,
    );
    checkCurrent();
    return result;
  } catch (error) {
    return stopped(error instanceof VentureComparisonError ? error.code : "COMPARE_FAILED");
  } finally {
    session.operationInProgress = false;
  }
}

async function openInnovationApplication(session: Session, page: Page) {
  const initialUrl = page.url();
  const url = new URL(initialUrl);
  const current = () =>
    active(session) && session.page === page && !page.isClosed() && page.url() === initialUrl;
  const unavailable = () =>
    new StudioError(
      "공식 유형 선택 화면에서 혁신성장유형의 바로가기를 확인하지 못했습니다. 열린 Edge 창에서 해당 유형을 직접 선택한 뒤 현재 화면을 다시 읽어 주세요.",
      409,
      "VENTURE_INNOVATION_UNAVAILABLE",
    );
  if (
    !current() ||
    !isOfficialPage(initialUrl) ||
    `${url.origin}${url.pathname}` !== ventureinUrls.application
  )
    throw unavailable();
  let choice = page
    .getByRole("link", { name: /^혁신성장유형\s*바로가기$/ })
    .filter({ visible: true });
  const directCount = await choice.count();
  if (directCount > 1 || !current()) throw unavailable();
  let expectedText = "혁신성장유형바로가기";
  let fallbackTitle: Locator | undefined;
  if (directCount === 0) {
    const title = page.getByText("혁신성장유형", { exact: true }).filter({ visible: true });
    if ((await title.count()) !== 1 || !current()) throw unavailable();
    let card = title;
    let found = false;
    // Some cards keep the heading outside their link. Inspect at most four generic ancestors.
    for (let depth = 0; depth < 4; depth += 1) {
      card = card.locator("xpath=..");
      const tagName = await card.evaluate((element) => element.tagName, undefined, {
        timeout: menuTimeoutMs,
      });
      if (!current() || ["BODY", "HTML", "MAIN", "FORM"].includes(tagName)) throw unavailable();
      if (
        await card
          .getByText(/^(벤처투자유형|연구개발유형|예비벤처유형)$/)
          .filter({ visible: true })
          .count()
      )
        throw unavailable();
      const links = card.getByRole("link").filter({ visible: true });
      const target = card
        .getByRole("link", { name: "바로가기", exact: true })
        .filter({ visible: true });
      const [linkCount, targetCount] = await Promise.all([links.count(), target.count()]);
      if (!current() || linkCount > 1 || targetCount > 1) throw unavailable();
      if (linkCount === 1 && targetCount === 1) {
        choice = target;
        expectedText = "바로가기";
        fallbackTitle = title;
        found = true;
        break;
      }
    }
    if (!found) throw unavailable();
  }
  const text = await choice.innerText({ timeout: menuTimeoutMs });
  const href = (await choice.getAttribute("href", { timeout: menuTimeoutMs }))?.trim();
  if (fallbackTitle && (await fallbackTitle.count()) !== 1) throw unavailable();
  if (!current() || text.replace(/\s+/g, "") !== expectedText || !href) throw unavailable();
  if (!href.startsWith("#") && !/^javascript:/i.test(href)) {
    let destination: URL;
    try {
      destination = new URL(href, initialUrl);
    } catch {
      throw unavailable();
    }
    if (!isOfficialPage(destination.href)) throw unavailable();
  }
  if (!current()) throw unavailable();
  // This is only the observed application-type navigation; never invoke agreement or submit controls.
  await choice.click({ timeout: operationTimeoutMs });
  if (!active(session) || session.page !== page || page.isClosed() || !isOfficialPage(page.url()))
    throw unavailable();
  // The type card may reveal its notice asynchronously. Wait for an observed next-step signal,
  // not the header that was already visible before the click; never repeat the card action.
  const preparedUrl = await Promise.any([
    page
      .getByText(applicationNoticeTitle, { exact: true })
      .filter({ visible: true })
      .waitFor({ state: "visible", timeout: menuTimeoutMs })
      .then(() => {
        const observedUrl = page.url();
        if (observedUrl !== ventureinUrls.application) throw unavailable();
        return observedUrl;
      }),
    page
      .waitForURL((value) => isCurrentPrecheckPage(value.href), {
        waitUntil: "commit",
        timeout: menuTimeoutMs,
      })
      .then(() => {
        const observedUrl = page.url();
        if (!isCurrentPrecheckPage(observedUrl)) throw unavailable();
        return observedUrl;
      }),
  ]).catch(() => {
    throw unavailable();
  });
  if (!active(session) || session.page !== page || page.isClosed() || page.url() !== preparedUrl)
    throw unavailable();
  if (isCurrentPrecheckPage(preparedUrl)) await waitForPrecheckUi(session, page, preparedUrl);
}

/** Wait for the controls needed by the next inspection, never infer login from readiness alone. */
async function waitForPrecheckUi(session: Session, page: Page, expectedUrl: string) {
  const current = () =>
    active(session) &&
    session.page === page &&
    !page.isClosed() &&
    page.url() === expectedUrl &&
    isCurrentPrecheckPage(expectedUrl);
  const unavailable = () => new UnverifiedDestinationError();
  if (!current()) throw unavailable();
  const deadline = Date.now() + operationTimeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  const logoutReady = async () => {
    await page
      .getByRole("link", { name: "로그아웃", exact: true })
      .or(page.getByRole("button", { name: "로그아웃", exact: true }))
      .first()
      .waitFor({ state: "visible", timeout: remaining() });
    if (!current()) throw unavailable();
  };
  const mobileReady = async () => {
    const opener = page.getByRole("button", { name: "모바일 주 메뉴 열기", exact: true }).first();
    await opener.waitFor({ state: "visible", timeout: remaining() });
    if (!current()) throw unavailable();
    const [expanded, controls, popup] = await Promise.all([
      opener.getAttribute("aria-expanded", { timeout: remaining() }),
      opener.getAttribute("aria-controls", { timeout: remaining() }),
      opener.getAttribute("aria-haspopup", { timeout: remaining() }),
    ]);
    if (!current() || expanded !== "false" || controls !== "mobileGnb" || popup !== "dialog")
      throw unavailable();
  };
  try {
    await Promise.any([logoutReady(), mobileReady()]);
  } catch (error) {
    if (
      error instanceof AggregateError &&
      error.errors.length &&
      error.errors.every((item) => item instanceof Error && item.name === "TimeoutError")
    ) {
      const timeout = new Error("Precheck controls were not ready");
      timeout.name = "TimeoutError";
      throw timeout;
    }
    throw unavailable();
  }
  if (!current()) throw unavailable();
}

export async function continueVentureSession(
  caseId: string,
  credentials: { loginId: string; password: string },
): Promise<VentureSessionStatus> {
  const session = sessions.get(caseId);
  if (
    !session ||
    !active(session) ||
    session.operationInProgress ||
    hasAttemptedLogin(session) ||
    !["awaiting_setup", "awaiting_login"].includes(session.status.state)
  )
    return getVentureSession(caseId);

  // Reserve before checking the page; two explicit continuation requests cannot both submit.
  session.operationInProgress = true;
  try {
    await inspectVentureSession(caseId);
    if (
      !active(session) ||
      !session.page ||
      !["awaiting_setup", "awaiting_login"].includes(session.status.state)
    )
      return getVentureSession(caseId);
    const setupPage = isOfficialSetupPage(session.page.url());
    if (!setupPage && !isLoginUrl(session.page.url())) return getVentureSession(caseId);
    await enterCredentialsAndLogin(session, credentials, setupPage);
  } finally {
    session.fillingCredentials = false;
    session.operationInProgress = false;
  }
  return getVentureSession(caseId);
}

/** A local, on-demand preview of the verified application window; never persisted or sent to AI. */
export async function previewVentureApplication(
  caseId: string,
  expectedStartedAt: string,
  expectedUrl: string,
) {
  const session = sessions.get(caseId);
  if (
    !session ||
    !active(session) ||
    !session.page ||
    session.status.startedAt !== expectedStartedAt
  )
    throw new StudioError(
      "현재 연결에서 공식 화면을 다시 확인해 주세요.",
      409,
      "VENTURE_NOT_CONNECTED",
    );
  if (session.operationInProgress)
    throw new StudioError("벤처인 연결 작업이 진행 중입니다.", 409, "VENTURE_BUSY");
  session.operationInProgress = true;
  try {
    await inspectVentureSession(caseId, true);
    const page = session.page;
    if (
      !active(session) ||
      session.status.state !== "connected_unmapped" ||
      !page ||
      page.isClosed()
    )
      throw new StudioError(
        "로그인 상태를 확인한 뒤 미리보기를 여세요.",
        409,
        "VENTURE_NOT_CONNECTED",
      );
    const rawUrl = page.url();
    const url = new URL(rawUrl);
    if (
      !isOfficialPage(rawUrl) ||
      `${url.origin}${url.pathname}` !== expectedUrl ||
      isLoginUrl(rawUrl) ||
      isOfficialSetupPage(rawUrl)
    )
      throw new StudioError(
        "공식 화면이 변경되었습니다. 현재 화면을 다시 읽어 주세요.",
        409,
        "VENTURE_SCREEN_CHANGED",
      );
    const authenticationFields = page.locator(
      'input[type="password"], input[autocomplete="one-time-code"], input[autocomplete="current-password"], input[autocomplete="new-password"], iframe, [contenteditable]:not([contenteditable="false"])',
    );
    const visibleAuthenticationFields = authenticationFields.filter({ visible: true });
    const visibleControls = page.locator("input, textarea, select").filter({ visible: true });
    const assertCurrent = () => {
      if (!active(session) || page.isClosed() || session.page !== page || page.url() !== rawUrl)
        throw new StudioError(
          "확인 중 화면이 바뀌었습니다. 다시 확인해 주세요.",
          409,
          "VENTURE_SCREEN_CHANGED",
        );
    };
    const verifyPreviewFields = async () => {
      const forbidden = () =>
        new StudioError(
          "인증 입력이나 외부 편집 영역이 표시된 화면에서는 미리보기를 제공하지 않습니다. 열린 Edge 창에서 직접 확인해 주세요.",
          409,
          "AUTHENTICATION_SCREEN",
        );
      if (await visibleAuthenticationFields.count()) throw forbidden();
      assertCurrent();
      const sensitive = await visibleControls.evaluateAll((elements, source) => {
        if (elements.length > 300) return true;
        const pattern = new RegExp(source, "i");
        return elements.some((element) => {
          const control = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
          const labels = Array.from(control.labels || [])
            .slice(0, 8)
            .map((label) => label.innerText.slice(0, 300));
          for (const id of (element.getAttribute("aria-labelledby") || "")
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 8)) {
            const label = element.ownerDocument.getElementById(id);
            if (label) labels.push(label.innerText.slice(0, 300));
          }
          return pattern.test(
            [
              ...["id", "name", "autocomplete", "title", "aria-label", "placeholder"].map((name) =>
                element.getAttribute(name),
              ),
              ...labels,
            ].join(" "),
          );
        });
      }, ventureInspectionRules.secretPatternSource);
      assertCurrent();
      if (sensitive) throw forbidden();
    };
    await verifyPreviewFields();
    // Mask all control contents as a second layer, including previously unknown authentication widgets.
    const image = await page.screenshot({
      type: "png",
      fullPage: false,
      timeout: 10_000,
      mask: [visibleControls, visibleAuthenticationFields],
      maskColor: "#000000",
    });
    assertCurrent();
    await verifyPreviewFields();
    return image;
  } catch (error) {
    if (error instanceof StudioError) throw error;
    throw new StudioError(
      "공식 화면 미리보기를 만들지 못했습니다. 현재 화면을 다시 읽어 주세요.",
      502,
      "VENTURE_PREVIEW_FAILED",
    );
  } finally {
    session.operationInProgress = false;
  }
}

async function dismissKnownApplicationNotice(
  session: Session,
  attempt: NoticeAttempt,
): Promise<"absent" | "dismissed" | "advanced" | NoticeFailure> {
  const page = session.page!;
  const initialUrl = page.url();
  const current = () =>
    active(session) && session.page === page && !page.isClosed() && page.url() === initialUrl;
  const advanced = () =>
    active(session) &&
    session.page === page &&
    !page.isClosed() &&
    !!session.authenticatedAt &&
    isCurrentPrecheckPage(page.url());
  const changed = () => precheckAddressVariant(page.url()) ?? "changed";
  if (initialUrl !== ventureinUrls.application || !current()) return "absent";
  const title = page.getByText(applicationNoticeTitle, { exact: true }).filter({ visible: true });
  const count = await title.count();
  if (!current()) return changed();
  if (!count) return "absent";
  if (count !== 1) return "title_ambiguous";
  if (!session.authenticatedAt) return "authentication_unverified";
  if (attempt.attempted) return "already_attempted";
  const normalize = (value: string) => value.replace(/\s+/g, "");
  const body = normalize(applicationNoticeBody);
  const readNotice = (element: Element) => {
    const scope = element as HTMLElement;
    const tagName = scope.tagName;
    if (["BODY", "HTML", "MAIN"].includes(tagName))
      return {
        tagName,
        text: "",
        unsafe: true,
        blockReason: "scope_exceeded" as const,
        actions: [],
      };
    if (tagName === "FORM")
      return { tagName, text: "", unsafe: true, blockReason: "form_present" as const, actions: [] };
    const children = scope.querySelectorAll("*");
    if (children.length > 200)
      return {
        tagName,
        text: "",
        unsafe: true,
        blockReason: "scope_exceeded" as const,
        actions: [],
      };
    if (scope.closest("form"))
      return { tagName, text: "", unsafe: true, blockReason: "form_present" as const, actions: [] };
    const inputSelector =
      "input, textarea, select, form, iframe, [contenteditable]:not([contenteditable='false']), [role='checkbox'], [role='radio'], [role='switch']";
    if (scope.matches(inputSelector) || scope.querySelector(inputSelector))
      return { tagName, text: "", unsafe: true, blockReason: "form_present" as const, actions: [] };
    const text = scope.innerText;
    if (text.length > 1_500)
      return {
        tagName,
        text: "",
        unsafe: true,
        blockReason: "scope_exceeded" as const,
        actions: [],
      };
    const actions = [
      ...scope.querySelectorAll<HTMLElement>(
        "a, button, [role='button'], [role='link'], [onclick], [tabindex]:not([tabindex='-1'])",
      ),
    ]
      .filter((node) => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      })
      .map((node) => ({
        tag: node.tagName,
        role: node.getAttribute("role"),
        text: node.innerText,
        name: node.getAttribute("aria-label") || node.getAttribute("title") || node.innerText,
        submits: node.getAttribute("type") === "submit" || !!(node as HTMLButtonElement).form,
      }));
    return { tagName, text, unsafe: false, actions };
  };
  let container = title;
  let sawBody = false;
  let failure: NoticeFailure = "read_failed";
  try {
    for (let depth = 0; depth < 5; depth += 1) {
      container = container.locator("xpath=..");
      const observed = await container.evaluate(readNotice, undefined, { timeout: menuTimeoutMs });
      const fingerprint = JSON.stringify(observed);
      if (!current()) return changed();
      if (observed.unsafe) return observed.blockReason ?? "form_present";
      const text = normalize(observed.text);
      if (text.replace(normalize(applicationNoticeTitle), "").length > 30) sawBody = true;
      if (!text.includes(body)) continue;
      let confirmations = 0;
      let closes = 0;
      const texts: string[] = [];
      for (const action of observed.actions) {
        const name = normalize(action.name);
        const actionText = normalize(action.text);
        const isButton = action.tag === "BUTTON" || action.role === "button";
        const isLink = action.tag === "A" || action.role === "link";
        if (action.submits) return "form_present";
        if (!isButton && !isLink) return "other_actions";
        if (name === "확인" && actionText === "확인") confirmations += 1;
        else if (
          ["닫기", "X", "×", "close"].includes(name) &&
          (!actionText || ["닫기", "X", "×", "close"].includes(actionText))
        )
          closes += 1;
        else if (
          isLink &&
          ["가이드북", "<가이드북>", "필독안내문(실수방지)", "<필독안내문(실수방지)>"].includes(
            name,
          ) &&
          name === actionText
        )
          continue;
        else return "other_actions";
        texts.push(actionText);
      }
      if (!confirmations) return "confirmation_missing";
      if (confirmations > 1) return "confirmation_ambiguous";
      if (closes > 1) return "other_actions";
      let remainder = text.replace(normalize(applicationNoticeTitle), "").replace(body, "");
      for (const actionText of texts) if (actionText) remainder = remainder.replace(actionText, "");
      if (remainder) return "extra_text";
      const confirmation = container
        .getByRole("button", { name: "확인", exact: true })
        .or(container.getByRole("link", { name: "확인", exact: true }))
        .filter({ visible: true });
      const confirmationCount = await confirmation.count();
      if (!current()) return changed();
      if (!confirmationCount) return "confirmation_missing";
      if (confirmationCount > 1) return "confirmation_ambiguous";
      if ((await title.count()) !== 1 || !current()) return changed();
      const verified = await container.evaluate(readNotice, undefined, { timeout: menuTimeoutMs });
      if (!current() || JSON.stringify(verified) !== fingerprint) return changed();
      attempt.attempted = true;
      failure = "click_failed";
      await confirmation.click({ timeout: menuTimeoutMs });
      if (advanced()) return "advanced";
      if (!current()) return changed();
      failure = "close_unconfirmed";
      await title.waitFor({ state: "hidden", timeout: menuTimeoutMs });
      if (advanced()) return "advanced";
      return current() ? "dismissed" : changed();
    }
  } catch {
    if (attempt.attempted && advanced()) return "advanced";
    return current() ? failure : changed();
  }
  return sawBody ? "body_mismatch" : "scope_exceeded";
}

async function hasVisibleLogout(page: Page) {
  return page
    .getByRole("link", { name: "로그아웃", exact: true })
    .or(page.getByRole("button", { name: "로그아웃", exact: true }))
    .first()
    .isVisible();
}

async function inspectMobileMenuLogout(session: Session) {
  const page = session.page!;
  const initialUrl = page.url();
  const stillCurrent = () =>
    active(session) &&
    session.page === page &&
    !page.isClosed() &&
    page.url() === initialUrl &&
    isOfficialPage(initialUrl);
  const opener = page.getByRole("button", { name: "모바일 주 메뉴 열기", exact: true }).first();
  const closer = page.getByRole("button", { name: "모바일 주 메뉴 닫기", exact: true }).first();
  let openingAttempted = false;
  try {
    if (!stillCurrent() || !(await opener.isVisible())) return false;
    const [expanded, controls, popup] = await Promise.all([
      opener.getAttribute("aria-expanded", { timeout: menuTimeoutMs }),
      opener.getAttribute("aria-controls", { timeout: menuTimeoutMs }),
      opener.getAttribute("aria-haspopup", { timeout: menuTimeoutMs }),
    ]);
    if (!stillCurrent() || expanded !== "false" || controls !== "mobileGnb" || popup !== "dialog")
      return false;
    openingAttempted = true;
    await opener.click({ timeout: menuTimeoutMs });
    if (!stillCurrent()) return false;
    await closer.waitFor({ state: "visible", timeout: menuTimeoutMs });
    if (!stillCurrent()) return false;
    return await hasVisibleLogout(page);
  } catch {
    // A menu interaction is only an additional observation; never infer authentication from it.
    return false;
  } finally {
    if (openingAttempted && stillCurrent()) {
      try {
        // The opener can leave the accessibility tree while its dialog is open.
        if ((await closer.isVisible()) && stillCurrent())
          await closer.click({ timeout: menuTimeoutMs });
      } catch {
        // Leave the official page usable if its menu changed; do not retry clicks or expose errors.
      }
    }
  }
}

async function inspectVentureSession(
  caseId: string,
  inspectMobileMenu = false,
  noticeAttempt: NoticeAttempt = { attempted: false },
): Promise<VentureSessionStatus> {
  const session = sessions.get(caseId);
  if (!session || !active(session) || session.status.state === "starting")
    return getVentureSession(caseId);
  const page = session.page;
  if (!page || page.isClosed()) {
    await closeSession(session, "stopped", "벤처인 연결 창이 없습니다. 다시 연결해 주세요.");
    return getVentureSession(caseId);
  }
  let phase: InspectionPhase = "officialPage";
  const changedMessage = () =>
    `상태 확인 중 벤처인 화면이 바뀌었습니다. 확인 단계: ${inspectionPhaseLabels[phase]}. 같은 창의 안내를 확인한 뒤 상태 확인을 다시 눌러 주세요.`;
  try {
    if (markSetupIfNeeded(session)) return getVentureSession(caseId);
    if (!isOfficialPage(page.url())) {
      update(
        session,
        hasAttemptedLogin(session) ? "awaiting_auth" : "awaiting_login",
        "공식 벤처인 화면에서 로그인 상태를 확인할 수 없습니다. 연결 창에서 인증을 마치고 벤처인 화면으로 돌아와 주세요.",
      );
      return getVentureSession(caseId);
    }
    let inspectedUrl = page.url();
    phase = "loginForm";
    let hasLoginForm =
      (await page.getByPlaceholder("아이디", { exact: true }).isVisible()) ||
      (await page.getByPlaceholder("비밀번호", { exact: true }).isVisible());
    if (inspectMobileMenu && !hasLoginForm) {
      phase = "applicationNotice";
      const notice = await dismissKnownApplicationNotice(session, noticeAttempt);
      if (!active(session)) return getVentureSession(caseId);
      if (notice === "advanced") {
        // Continue through the same fresh-authentication checks as a current-screen read.
        // Never rebuild or navigate to the already-open page's query/hash suffix.
        phase = "precheckDocument";
        inspectedUrl = page.url();
        if (
          session.page !== page ||
          page.isClosed() ||
          !session.authenticatedAt ||
          !isCurrentPrecheckPage(inspectedUrl)
        ) {
          update(
            session,
            hasAttemptedLogin(session) ? "awaiting_auth" : "awaiting_login",
            changedMessage(),
          );
          return getVentureSession(caseId);
        }
        await waitForPrecheckUi(session, page, inspectedUrl);
        if (!active(session)) return getVentureSession(caseId);
        if (session.page !== page || page.isClosed() || page.url() !== inspectedUrl) {
          update(
            session,
            hasAttemptedLogin(session) ? "awaiting_auth" : "awaiting_login",
            changedMessage(),
          );
          return getVentureSession(caseId);
        }
        phase = "advancedLoginForm";
        hasLoginForm =
          (await page.getByPlaceholder("아이디", { exact: true }).isVisible()) ||
          (await page.getByPlaceholder("비밀번호", { exact: true }).isVisible());
      } else if (notice !== "absent" && notice !== "dismissed") {
        update(
          session,
          hasAttemptedLogin(session) ? "awaiting_auth" : "awaiting_login",
          `신청 준비 안내를 자동으로 확인하지 못했습니다. ${applicationNoticeFailureMessages[notice]} 열린 벤처인 창의 안내를 직접 확인한 뒤 상태 확인을 다시 눌러 주세요.`,
        );
        return getVentureSession(caseId);
      }
    }
    phase = "logout";
    let hasLogout = await hasVisibleLogout(page);
    if (
      inspectMobileMenu &&
      !hasLoginForm &&
      !hasLogout &&
      active(session) &&
      page.url() === inspectedUrl
    ) {
      phase = "mobileMenu";
      hasLogout = await inspectMobileMenuLogout(session);
    }
    if (!active(session)) return getVentureSession(caseId);
    if (markSetupIfNeeded(session)) return getVentureSession(caseId);
    if (page.url() !== inspectedUrl) {
      update(
        session,
        hasAttemptedLogin(session) ? "awaiting_auth" : "awaiting_login",
        changedMessage(),
      );
      return getVentureSession(caseId);
    }
    if (!hasLoginForm && hasLogout && isOfficialPage(page.url())) {
      update(
        session,
        "connected_unmapped",
        "로그아웃 표시를 확인했습니다. 계정·신청 기업의 일치 여부와 신청 화면 연결은 검증되지 않았습니다. 자동 입력·첨부·제출은 진행하지 않았습니다.",
      );
    } else {
      update(
        session,
        hasAttemptedLogin(session) ? "awaiting_auth" : "awaiting_login",
        hasAttemptedLogin(session)
          ? "로그인 완료 표시를 아직 확인하지 못했습니다. 벤처인 창에서 로그인 결과 또는 추가 인증을 확인해 주세요."
          : "로그인 완료 표시를 아직 확인하지 못했습니다. 같은 Edge 창에서 권한·안내를 처리한 뒤 로그인을 이어가세요. 상태 확인만으로는 계정정보를 입력하거나 로그인을 전송하지 않습니다.",
      );
    }
  } catch (error) {
    if (markSetupIfNeeded(session)) return getVentureSession(caseId);
    if (active(session))
      update(
        session,
        hasAttemptedLogin(session) ? "awaiting_auth" : "awaiting_login",
        `벤처인 로그인 상태를 확인하지 못했습니다. 확인 단계: ${inspectionPhaseLabels[phase]}. ${inspectionFailureReason(error)} 연결 창의 안내를 확인한 뒤 다시 시도해 주세요.`,
      );
  }
  return getVentureSession(caseId);
}
