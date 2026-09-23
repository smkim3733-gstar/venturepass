import "server-only";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { ventureinUrls, type VentureSessionStatus } from "./venturein-schema";

const sessionLifetimeMs = 15 * 60 * 1000;
const operationTimeoutMs = 15_000;
const officialLogin = new URL(ventureinUrls.login);
const officialSetup = new URL(ventureinUrls.securityInstall);

const failureMessages = {
  browser: "Edge 자동 연결 창을 시작하지 못했습니다. Edge 설치 상태와 실행 권한을 확인해 주세요.",
  context: "Edge에 임시 로그인 화면을 만들지 못했습니다. 연결 창을 닫고 다시 시도해 주세요.",
  navigation:
    "공식 벤처인 로그인 페이지를 불러오지 못했습니다. 네트워크와 벤처인 사이트 접속 상태를 확인해 주세요.",
  form: "벤처인 로그인 입력란 또는 버튼을 확인하지 못했습니다. 페이지 로딩 지연이나 화면 변경이 있는지 확인한 뒤 다시 시도해 주세요.",
  idEntry: "벤처인 아이디 입력란에 자동 입력하지 못했습니다. 로그인 화면을 다시 연결해 주세요.",
  passwordEntry:
    "벤처인 비밀번호 입력란에 자동 입력하지 못했습니다. 로그인 화면을 다시 연결해 주세요.",
  loginAction:
    "벤처인 로그인 버튼 동작을 완료하지 못했습니다. 로그인 성공 여부는 확인되지 않았습니다. 다시 연결해 주세요.",
} as const;

class UnverifiedDestinationError extends Error {}

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
  setupRequired?: boolean;
  browser?: Browser;
  context?: BrowserContext;
  page?: Page;
  timer?: ReturnType<typeof setTimeout>;
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
  if (!session.setupRequired && !isOfficialSetupPage(session.page.url())) return false;
  session.setupRequired = true;
  update(
    session,
    "awaiting_setup",
    "벤처인에서 TouchEn 보안 프로그램 설치를 요청했습니다. 열린 공식 설치 화면에서 설치를 완료한 뒤 앱에서 다시 연결해 주세요. 자동 로그인은 중단했으며 프로그램을 자동 설치하지 않습니다.",
  );
  return true;
}

function active(session: Session) {
  return !session.cancelled;
}

async function closeSession(session: Session, state: "stopped" | "login_failed", message: string) {
  session.cancelled = true;
  update(session, state, message);
  if (session.timer) clearTimeout(session.timer);
  const browser = session.browser;
  session.page = undefined;
  session.context = undefined;
  session.browser = undefined;
  // Browser errors can contain URLs, field values and execution details. Never expose them.
  if (browser) await browser.close().catch(() => undefined);
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
  let clickFailure: keyof typeof clickFailureMessages = "other";
  try {
    // Playwright debug output can include action arguments. Refuse credential entry when enabled.
    if (process.env.DEBUG?.trim() || (process.env.PWDEBUG && process.env.PWDEBUG !== "0")) {
      await closeSession(
        session,
        "login_failed",
        "자동화 디버그 환경에서는 계정정보를 입력하지 않습니다. DEBUG·PWDEBUG 설정을 해제하고 앱을 다시 시작해 주세요.",
      );
      return getVentureSession(caseId);
    }
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
      markSetupIfNeeded(session);
    });
    page.on("close", () => {
      if (active(session))
        void closeSession(session, "stopped", "벤처인 연결 창이 닫혔습니다. 다시 연결해 주세요.");
    });

    let fillingCredentials = true;
    // A redirect during credential entry must not move the form to an unverified destination.
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (
        fillingCredentials &&
        request.isNavigationRequest() &&
        !isLoginUrl(request.url()) &&
        !isOfficialSetupPage(request.url())
      ) {
        await route.abort();
        return;
      }
      await route.continue();
    });

    let resolveDialog: (() => void) | undefined;
    const dialogAppeared = new Promise<void>((resolve) => {
      resolveDialog = resolve;
    });
    page.on("dialog", () => {
      // Keep native dialogs for the user. Do not read their contents or accept them automatically.
      if (active(session) && !markSetupIfNeeded(session))
        update(
          session,
          "awaiting_auth",
          "벤처인 창의 안내를 직접 확인해 주세요. 로그인 결과와 추가 인증은 아직 확인되지 않았습니다.",
        );
      resolveDialog?.();
    });

    phase = "navigation";
    await page.goto(ventureinUrls.login, {
      waitUntil: "domcontentloaded",
      timeout: operationTimeoutMs,
    });
    if (markSetupIfNeeded(session)) return getVentureSession(caseId);
    // The public form has title attributes, but no labels or aria-labels.
    const loginId = page.getByPlaceholder("아이디", { exact: true });
    const password = page.getByPlaceholder("비밀번호", { exact: true });
    const loginButton = page.getByRole("button", { name: "로그인", exact: true });
    const assertLoginDestination = () => {
      if (!active(session) || session.setupRequired || !isLoginUrl(page.url()))
        throw new UnverifiedDestinationError();
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
    phase = "idEntry";
    await loginId.fill(credentials.loginId);
    assertLoginDestination();
    phase = "passwordEntry";
    await password.fill(credentials.password);
    assertLoginDestination();
    fillingCredentials = false;
    phase = "loginAction";
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
    if (!active(session)) return getVentureSession(caseId);
    if (markSetupIfNeeded(session)) return getVentureSession(caseId);
    if (!clicked) throw new Error("Login action incomplete");
    update(
      session,
      "awaiting_auth",
      "벤처인 창에서 로그인 결과와 추가 인증을 확인한 뒤 ‘인증 완료 후 상태 확인’을 눌러 주세요. 로그인·신청·제출 완료로 처리하지 않았습니다.",
    );
  } catch (error) {
    if (markSetupIfNeeded(session)) return getVentureSession(caseId);
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
      return getVentureSession(caseId);
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
  }
  return getVentureSession(caseId);
}

export async function resumeVentureSession(caseId: string): Promise<VentureSessionStatus> {
  const session = sessions.get(caseId);
  if (!session || !active(session) || session.status.state === "starting")
    return getVentureSession(caseId);
  const page = session.page;
  if (!page || page.isClosed()) {
    await closeSession(session, "stopped", "벤처인 연결 창이 없습니다. 다시 연결해 주세요.");
    return getVentureSession(caseId);
  }
  try {
    if (markSetupIfNeeded(session)) return getVentureSession(caseId);
    if (!isOfficialPage(page.url())) {
      update(
        session,
        "awaiting_auth",
        "공식 벤처인 화면에서 로그인 상태를 확인할 수 없습니다. 연결 창에서 인증을 마치고 벤처인 화면으로 돌아와 주세요.",
      );
      return getVentureSession(caseId);
    }
    const hasLoginForm =
      (await page.getByPlaceholder("아이디", { exact: true }).isVisible()) ||
      (await page.getByPlaceholder("비밀번호", { exact: true }).isVisible());
    const hasLogout = await page
      .getByRole("link", { name: "로그아웃", exact: true })
      .or(page.getByRole("button", { name: "로그아웃", exact: true }))
      .first()
      .isVisible();
    if (!active(session)) return getVentureSession(caseId);
    if (markSetupIfNeeded(session)) return getVentureSession(caseId);
    if (!hasLoginForm && hasLogout && isOfficialPage(page.url())) {
      update(
        session,
        "connected_unmapped",
        "로그아웃 표시를 확인했습니다. 계정·신청 기업의 일치 여부와 신청 화면 연결은 검증되지 않았습니다. 자동 입력·첨부·제출은 진행하지 않았습니다.",
      );
    } else {
      update(
        session,
        "awaiting_auth",
        "로그인 완료 표시를 아직 확인하지 못했습니다. 벤처인 창에서 로그인 결과 또는 추가 인증을 확인해 주세요.",
      );
    }
  } catch {
    if (markSetupIfNeeded(session)) return getVentureSession(caseId);
    if (active(session))
      update(
        session,
        "awaiting_auth",
        "벤처인 로그인 상태를 확인하지 못했습니다. 연결 창의 안내를 확인한 뒤 다시 시도해 주세요.",
      );
  }
  return getVentureSession(caseId);
}
