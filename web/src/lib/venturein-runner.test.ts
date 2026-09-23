import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("playwright-core", () => ({ chromium: { launch } }));

import {
  getVentureSession,
  resumeVentureSession,
  startVentureSession,
  stopVentureSession,
} from "./venturein-runner";
import { ventureinUrls } from "./venturein-schema";

const account = () => ({ loginId: "test-account-sensitive", password: "test-password-sensitive" });
const cases = new Set<string>();
let sequence = 0;
function caseId() {
  const id = `runner-mock-${sequence++}`;
  cases.add(id);
  return id;
}

function browserFixture() {
  const browserEvents = new Map<string, () => void>();
  const pageEvents = new Map<string, () => void>();
  let url: string = ventureinUrls.login;
  let closed = false;
  const fields = {
    idVisible: true,
    passwordVisible: true,
    buttonVisible: true,
    logoutVisible: false,
  };
  const loginId = {
    isVisible: vi.fn(async () => fields.idVisible),
    waitFor: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
  };
  const password = {
    isVisible: vi.fn(async () => fields.passwordVisible),
    waitFor: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
  };
  const loginButton = {
    isVisible: vi.fn(async () => fields.buttonVisible),
    waitFor: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
  };
  const logout = {
    isVisible: vi.fn(async () => fields.logoutVisible),
    or: vi.fn(() => logout),
    first: vi.fn(() => logout),
  };
  const page = {
    on: vi.fn((event: string, handler: () => void) => pageEvents.set(event, handler)),
    goto: vi.fn(async () => null),
    url: vi.fn(() => url),
    isClosed: vi.fn(() => closed),
    getByRole: vi.fn((_role: string, options: { name: string }) => {
      if (options.name === "로그인") return loginButton;
      if (options.name === "로그아웃") return logout;
      throw new Error("Unexpected locator");
    }),
    getByLabel: vi.fn(() => {
      throw new Error("Public login inputs have title attributes, not labels");
    }),
    getByPlaceholder: vi.fn((name: string) => {
      if (name === "아이디") return loginId;
      if (name === "비밀번호") return password;
      throw new Error("Unexpected placeholder");
    }),
  };
  const context = {
    setDefaultTimeout: vi.fn(),
    newPage: vi.fn(async () => page),
    route: vi
      .fn<(url: string, handler: (route: unknown) => Promise<void>) => Promise<void>>()
      .mockResolvedValue(undefined),
  };
  const browser = {
    on: vi.fn((event: string, handler: () => void) => browserEvents.set(event, handler)),
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => {
      closed = true;
      browserEvents.get("disconnected")?.();
    }),
  };
  return {
    browser,
    context,
    page,
    fields,
    loginId,
    password,
    loginButton,
    navigate: (next: string) => {
      url = next;
      pageEvents.get("framenavigated")?.();
    },
    showDialog: () => pageEvents.get("dialog")?.(),
    closeWindow: () => {
      closed = true;
      pageEvents.get("close")?.();
    },
  };
}

beforeEach(() => {
  launch.mockReset();
});
afterEach(async () => {
  await Promise.all([...cases].map(stopVentureSession));
  cases.clear();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("벤처인 임시 로그인 실행기 — 브라우저 모의 테스트", () => {
  it("별도 Edge와 임시 컨텍스트를 열고 로그인 클릭을 한 번만 수행하며 성공을 추정하지 않는다", async () => {
    const id = caseId();
    const fixture = browserFixture();
    launch.mockResolvedValue(fixture.browser);
    const status = await startVentureSession(id, account());
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "msedge",
        headless: false,
        timeout: 15_000,
        env: expect.objectContaining({ DEBUG: "", PWDEBUG: "0" }),
      }),
    );
    expect(fixture.browser.newContext).toHaveBeenCalledWith({
      acceptDownloads: true,
      serviceWorkers: "block",
    });
    expect(fixture.page.goto).toHaveBeenCalledWith(ventureinUrls.login, expect.any(Object));
    expect(fixture.loginId.fill).toHaveBeenCalledWith(account().loginId);
    expect(fixture.password.fill).toHaveBeenCalledWith(account().password);
    expect(fixture.page.getByLabel).not.toHaveBeenCalled();
    expect(fixture.page.getByPlaceholder).toHaveBeenCalledWith("아이디", { exact: true });
    expect(fixture.page.getByPlaceholder).toHaveBeenCalledWith("비밀번호", { exact: true });
    expect(fixture.loginButton.click).toHaveBeenCalledTimes(1);
    expect(status.state).toBe("awaiting_auth");
    expect(status.startedAt).not.toBeNull();
    expect(JSON.stringify(status)).not.toContain(account().password);
    expect(JSON.stringify(status)).not.toContain(account().loginId);
    expect(fixture.page.goto).toHaveBeenCalledTimes(1);
  });

  it("지연해서 표시되는 로그인폼을 기다린 뒤 입력한다", async () => {
    const fixture = browserFixture();
    fixture.fields.idVisible = false;
    fixture.fields.passwordVisible = false;
    fixture.fields.buttonVisible = false;
    fixture.loginId.waitFor.mockImplementation(async () => {
      fixture.fields.idVisible = true;
    });
    fixture.password.waitFor.mockImplementation(async () => {
      fixture.fields.passwordVisible = true;
    });
    fixture.loginButton.waitFor.mockImplementation(async () => {
      fixture.fields.buttonVisible = true;
    });
    launch.mockResolvedValue(fixture.browser);
    expect((await startVentureSession(caseId(), account())).state).toBe("awaiting_auth");
    for (const locator of [fixture.loginId, fixture.password, fixture.loginButton]) {
      expect(locator.waitFor).toHaveBeenCalledWith({ state: "visible", timeout: 15_000 });
    }
    expect(fixture.loginId.fill).toHaveBeenCalledTimes(1);
    expect(fixture.password.fill).toHaveBeenCalledTimes(1);
  });

  it.each([
    "https://www.smes.go.kr.attacker.test/venturein/auth/viewLogin",
    "http://www.smes.go.kr/venturein/auth/viewLogin",
    "https://www.smes.go.kr/other-login",
    "https://user:secret@www.smes.go.kr/venturein/auth/viewLogin",
  ])("예상하지 못한 로그인 목적지에는 자격정보를 입력하지 않는다: %s", async (url) => {
    const fixture = browserFixture();
    fixture.navigate(url);
    launch.mockResolvedValue(fixture.browser);
    const status = await startVentureSession(caseId(), account());
    expect(status.state).toBe("login_failed");
    expect(fixture.loginId.fill).not.toHaveBeenCalled();
    expect(fixture.password.fill).not.toHaveBeenCalled();
    expect(fixture.loginButton.click).not.toHaveBeenCalled();
    expect(fixture.browser.close).toHaveBeenCalledTimes(1);
    expect(status.message).not.toContain(url);
  });

  it("아이디 입력 중 화면이 바뀌면 비밀번호를 쓰지 않는다", async () => {
    const fixture = browserFixture();
    fixture.loginId.fill.mockImplementation(async () => {
      fixture.navigate("https://attacker.test/");
    });
    launch.mockResolvedValue(fixture.browser);
    expect((await startVentureSession(caseId(), account())).state).toBe("login_failed");
    expect(fixture.password.fill).not.toHaveBeenCalled();
    expect(fixture.loginButton.click).not.toHaveBeenCalled();
  });

  it("자격정보 입력 중 미검증 주소로 향하는 탐색 요청을 차단한다", async () => {
    const fixture = browserFixture();
    const abort = vi.fn(async () => {});
    const proceed = vi.fn(async () => {});
    fixture.loginId.fill.mockImplementation(async () => {
      const handler = fixture.context.route.mock.calls[0][1];
      await handler({
        request: () => ({ isNavigationRequest: () => true, url: () => "https://attacker.test/" }),
        abort,
        continue: proceed,
      });
    });
    launch.mockResolvedValue(fixture.browser);
    await startVentureSession(caseId(), account());
    expect(abort).toHaveBeenCalledTimes(1);
    expect(proceed).not.toHaveBeenCalled();
  });

  it.each(["DEBUG", "PWDEBUG"])(
    "%s 디버그 환경에서는 계정정보가 라이브러리 로그에 기록되지 않도록 시작하지 않는다",
    async (name) => {
      vi.stubEnv(name, "*");
      const status = await startVentureSession(caseId(), account());
      expect(status.state).toBe("login_failed");
      expect(status.message).toContain("디버그 환경");
      expect(launch).not.toHaveBeenCalled();
    },
  );

  it("로그인폼이 없거나 실행 오류가 나면 원문 오류와 비밀을 노출하지 않는다", async () => {
    const fixture = browserFixture();
    fixture.fields.passwordVisible = false;
    launch
      .mockResolvedValueOnce(fixture.browser)
      .mockRejectedValueOnce(new Error(`${account().loginId} ${account().password}`));
    const statuses = [
      await startVentureSession(caseId(), account()),
      await startVentureSession(caseId(), account()),
    ];
    expect(statuses.every((status) => status.state === "login_failed")).toBe(true);
    expect(JSON.stringify(statuses)).not.toContain(account().loginId);
    expect(JSON.stringify(statuses)).not.toContain(account().password);
    expect(fixture.loginId.fill).not.toHaveBeenCalled();
  });

  it.each([
    ["browser", "Edge 자동 연결 창"],
    ["context", "임시 로그인 화면"],
    ["navigation", "로그인 페이지"],
    ["form", "로그인 입력란 또는 버튼"],
    ["idEntry", "아이디 입력란에 자동 입력"],
    ["passwordEntry", "비밀번호 입력란에 자동 입력"],
    ["loginAction", "로그인 버튼 동작"],
  ] as const)("%s 단계 실패를 비밀정보 없는 고정 안내로 구분한다", async (phase, expected) => {
    const fixture = browserFixture();
    const privateError = new Error(
      `${account().loginId} ${account().password} https://example.test/?token=private`,
    );
    launch.mockResolvedValue(fixture.browser);
    if (phase === "browser") launch.mockRejectedValue(privateError);
    if (phase === "context") fixture.browser.newContext.mockRejectedValue(privateError);
    if (phase === "navigation") fixture.page.goto.mockRejectedValue(privateError);
    if (phase === "form") fixture.password.waitFor.mockRejectedValue(privateError);
    if (phase === "idEntry") fixture.loginId.fill.mockRejectedValue(privateError);
    if (phase === "passwordEntry") fixture.password.fill.mockRejectedValue(privateError);
    if (phase === "loginAction") fixture.loginButton.click.mockRejectedValue(privateError);
    const status = await startVentureSession(caseId(), account());
    expect(status.state).toBe(phase === "loginAction" ? "awaiting_auth" : "login_failed");
    expect(status.message).toContain(expected);
    expect(JSON.stringify(status)).not.toContain(account().loginId);
    expect(JSON.stringify(status)).not.toContain(account().password);
    expect(JSON.stringify(status)).not.toContain("token=private");
  });

  it.each([
    ["TimeoutError", "action timed out", "대기 시간이 초과"],
    ["TimeoutError", "element intercepts pointer events", "버튼을 가리고"],
    ["TimeoutError", "element is not visible", "버튼이 보이지"],
    ["Error", "element detached", "변경되거나 사라져"],
    ["TimeoutError", "waiting for scheduled navigations", "화면 전환 확인"],
    ["Error", "unrecognized detail", "로그인 버튼 동작"],
  ])(
    "로그인 클릭 오류 %s/%s는 분류만 안내하고 공식 창을 유지한다",
    async (name, detail, expected) => {
      const fixture = browserFixture();
      const id = caseId();
      const error = new Error(
        `${detail}: ${account().loginId} ${account().password} https://example.test/?token=private`,
      );
      error.name = name;
      fixture.loginButton.click.mockRejectedValue(error);
      launch.mockResolvedValue(fixture.browser);
      const status = await startVentureSession(id, account());
      expect(status.state).toBe("awaiting_auth");
      expect(status.message).toContain(expected);
      expect(status.message).toContain("로그인 성공 여부는 확인되지 않았으며");
      expect(JSON.stringify(status)).not.toContain(account().loginId);
      expect(JSON.stringify(status)).not.toContain(account().password);
      expect(JSON.stringify(status)).not.toContain("token=private");
      expect(fixture.browser.close).not.toHaveBeenCalled();
      await startVentureSession(id, account());
      expect(fixture.loginButton.click).toHaveBeenCalledTimes(1);
      expect(launch).toHaveBeenCalledTimes(1);
    },
  );

  it("로그인 클릭 실패 뒤 비공식 화면이면 창을 유지하지 않는다", async () => {
    const fixture = browserFixture();
    fixture.loginButton.click.mockImplementation(async () => {
      fixture.navigate("https://attacker.test/venturein/login?secret=private");
      throw new Error("waiting for scheduled navigations");
    });
    launch.mockResolvedValue(fixture.browser);
    const status = await startVentureSession(caseId(), account());
    expect(status.state).toBe("login_failed");
    expect(status.message).not.toContain("secret=private");
    expect(fixture.browser.close).toHaveBeenCalledTimes(1);
  });

  it("동시 시작을 합치고 시작 중 중단되면 늦게 열린 브라우저도 닫는다", async () => {
    const id = caseId();
    const fixture = browserFixture();
    let finishLaunch: ((value: typeof fixture.browser) => void) | undefined;
    launch.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishLaunch = resolve;
        }),
    );
    const starting = startVentureSession(id, account());
    expect((await startVentureSession(id, account())).state).toBe("starting");
    expect(launch).toHaveBeenCalledTimes(1);
    expect((await stopVentureSession(id)).state).toBe("stopped");
    finishLaunch?.(fixture.browser);
    expect((await starting).state).toBe("stopped");
    expect(fixture.browser.close).toHaveBeenCalledTimes(1);
    expect(fixture.browser.newContext).not.toHaveBeenCalled();
  });

  it("다른 기업의 컨텍스트와 종료 상태를 분리한다", async () => {
    const first = browserFixture();
    const second = browserFixture();
    const firstId = caseId();
    const secondId = caseId();
    launch.mockResolvedValueOnce(first.browser).mockResolvedValueOnce(second.browser);
    await Promise.all([
      startVentureSession(firstId, account()),
      startVentureSession(secondId, account()),
    ]);
    await stopVentureSession(firstId);
    expect(getVentureSession(firstId).state).toBe("stopped");
    expect(getVentureSession(secondId).state).toBe("awaiting_auth");
    expect(second.browser.close).not.toHaveBeenCalled();
  });

  it("로그인폼 부재와 공식 화면의 로그아웃 표시를 함께 확인해도 제출 상태는 만들지 않는다", async () => {
    const fixture = browserFixture();
    const id = caseId();
    launch.mockResolvedValue(fixture.browser);
    await startVentureSession(id, account());
    fixture.fields.logoutVisible = true;
    expect((await resumeVentureSession(id)).state).toBe("awaiting_auth");
    fixture.fields.idVisible = false;
    fixture.fields.passwordVisible = false;
    fixture.navigate("https://attacker.test/venturein/home");
    expect((await resumeVentureSession(id)).state).toBe("awaiting_auth");
    fixture.navigate("https://www.smes.go.kr/venturein/home");
    const status = await resumeVentureSession(id);
    expect(status.state).toBe("connected_unmapped");
    expect(status.message).toContain("계정·신청 기업의 일치 여부");
    expect(status.message).toContain("제출은 진행하지 않았습니다");
    fixture.fields.logoutVisible = false;
    expect((await resumeVentureSession(id)).state).toBe("awaiting_auth");
    expect(fixture.loginButton.click).toHaveBeenCalledTimes(1);
    expect(fixture.page.getByLabel).not.toHaveBeenCalled();
    expect(fixture.page.getByPlaceholder).toHaveBeenCalledWith("아이디", { exact: true });
    expect(fixture.page.getByPlaceholder).toHaveBeenCalledWith("비밀번호", { exact: true });
  });

  it("창을 닫으면 연결 성공 표시를 남기지 않는다", async () => {
    const fixture = browserFixture();
    const id = caseId();
    launch.mockResolvedValue(fixture.browser);
    await startVentureSession(id, account());
    fixture.closeWindow();
    expect(getVentureSession(id).state).toBe("stopped");
    expect((await resumeVentureSession(id)).state).toBe("stopped");
  });

  it("15분 후 임시 창을 닫고 새 연결은 새 브라우저로 시작한다", async () => {
    vi.useFakeTimers();
    const first = browserFixture();
    const second = browserFixture();
    const id = caseId();
    launch.mockResolvedValueOnce(first.browser).mockResolvedValueOnce(second.browser);
    await startVentureSession(id, account());
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(getVentureSession(id).state).toBe("stopped");
    expect(first.browser.close).toHaveBeenCalledTimes(1);
    expect((await startVentureSession(id, account())).state).toBe("awaiting_auth");
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it.each(["navigation", "form", "loginAction"] as const)(
    "%s 중 공식 보안 설치 화면으로 이동하면 창을 유지하고 설치 대기로 표시한다",
    async (phase) => {
      const fixture = browserFixture();
      const id = caseId();
      const setupUrl = `${ventureinUrls.securityInstall}?url=return-target`;
      if (phase === "navigation")
        fixture.page.goto.mockImplementation(async () => {
          fixture.navigate(setupUrl);
          return null;
        });
      if (phase === "form")
        fixture.password.waitFor.mockImplementation(async () => {
          fixture.navigate(setupUrl);
          throw new Error("Form no longer available");
        });
      if (phase === "loginAction")
        fixture.loginButton.click.mockImplementation(async () => {
          fixture.navigate(setupUrl);
          throw new Error("Navigation timeout");
        });
      launch.mockResolvedValue(fixture.browser);
      const status = await startVentureSession(id, account());
      expect(status.state).toBe("awaiting_setup");
      expect(status.message).toContain("TouchEn");
      expect(status.message).not.toContain("return-target");
      expect(fixture.browser.close).not.toHaveBeenCalled();
      if (phase !== "loginAction") {
        expect(fixture.loginId.fill).not.toHaveBeenCalled();
        expect(fixture.password.fill).not.toHaveBeenCalled();
        expect(fixture.loginButton.click).not.toHaveBeenCalled();
      }
      fixture.fields.idVisible = false;
      fixture.fields.passwordVisible = false;
      fixture.fields.logoutVisible = true;
      expect((await resumeVentureSession(id)).state).toBe("awaiting_setup");
    },
  );

  it("입력 중 공식 설치 페이지 이동은 허용하고 나머지 자격정보 입력을 멈춘다", async () => {
    const fixture = browserFixture();
    const abort = vi.fn(async () => {});
    const proceed = vi.fn(async () => {});
    fixture.loginId.fill.mockImplementation(async () => {
      await fixture.context.route.mock.calls[0][1]({
        request: () => ({
          isNavigationRequest: () => true,
          url: () => ventureinUrls.securityInstall,
        }),
        abort,
        continue: proceed,
      });
      fixture.navigate(ventureinUrls.securityInstall);
    });
    launch.mockResolvedValue(fixture.browser);
    const id = caseId();
    expect((await startVentureSession(id, account())).state).toBe("awaiting_setup");
    expect(abort).not.toHaveBeenCalled();
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(fixture.password.fill).not.toHaveBeenCalled();
    expect(fixture.loginButton.click).not.toHaveBeenCalled();
    fixture.navigate(ventureinUrls.login);
    expect((await resumeVentureSession(id)).state).toBe("awaiting_setup");
    await startVentureSession(id, account());
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it.each([
    "https://attacker.test/venturein/resources/raonnx/install/install.html",
    "https://www.smes.go.kr/venturein/resources/raonnx/install/other.html",
  ])("유사한 설치 주소는 허용 목록에 포함하지 않는다: %s", async (url) => {
    const fixture = browserFixture();
    const abort = vi.fn(async () => {});
    const proceed = vi.fn(async () => {});
    fixture.loginId.fill.mockImplementation(async () => {
      await fixture.context.route.mock.calls[0][1]({
        request: () => ({ isNavigationRequest: () => true, url: () => url }),
        abort,
        continue: proceed,
      });
    });
    launch.mockResolvedValue(fixture.browser);
    expect((await startVentureSession(caseId(), account())).state).toBe("awaiting_auth");
    expect(abort).toHaveBeenCalledTimes(1);
    expect(proceed).not.toHaveBeenCalled();
  });

  it("인증 확인 시 설치 화면을 새로 발견하면 로그인 성공으로 처리하지 않는다", async () => {
    const fixture = browserFixture();
    const id = caseId();
    launch.mockResolvedValue(fixture.browser);
    await startVentureSession(id, account());
    fixture.navigate(ventureinUrls.securityInstall);
    fixture.fields.idVisible = false;
    fixture.fields.passwordVisible = false;
    fixture.fields.logoutVisible = true;
    expect((await resumeVentureSession(id)).state).toBe("awaiting_setup");
    expect(fixture.browser.close).not.toHaveBeenCalled();
  });

  it("사용자 확인 대화상자를 자동 수락하지 않고 인증 확인 단계에 남긴다", async () => {
    const fixture = browserFixture();
    fixture.loginButton.click.mockImplementation(async () => {
      fixture.showDialog();
      await new Promise<void>(() => {});
    });
    launch.mockResolvedValue(fixture.browser);
    expect((await startVentureSession(caseId(), account())).state).toBe("awaiting_auth");
    expect(fixture.loginButton.click).toHaveBeenCalledTimes(1);
  });

  it("새 프로세스에 해당하는 메모리 상태에는 이전 연결을 복원하지 않는다", async () => {
    const id = caseId();
    const fixture = browserFixture();
    launch.mockResolvedValue(fixture.browser);
    await startVentureSession(id, account());
    const globalSessions = globalThis as typeof globalThis & { __ventureinSessions?: unknown };
    const previous = globalSessions.__ventureinSessions;
    try {
      delete globalSessions.__ventureinSessions;
      vi.resetModules();
      const restarted = await import("./venturein-runner");
      expect(restarted.getVentureSession(id).state).toBe("idle");
      expect((await restarted.resumeVentureSession(id)).state).toBe("idle");
    } finally {
      globalSessions.__ventureinSessions = previous;
    }
  });
});
