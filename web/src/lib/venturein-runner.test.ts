import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { launch, collectScreen, applyText, compareInputs } = vi.hoisted(() => ({
  launch: vi.fn(),
  collectScreen: vi.fn(),
  applyText: vi.fn(),
  compareInputs: vi.fn(),
}));
vi.mock("playwright-core", () => ({ chromium: { launch } }));
vi.mock("./venturein-inspection-collector", () => ({ collectVentureScreen: collectScreen }));
vi.mock("./venturein-text-input", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./venturein-text-input")>()),
  applyVentureTextInput: applyText,
}));
vi.mock("./venturein-input-comparison", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./venturein-input-comparison")>()),
  compareVentureInputs: compareInputs,
}));

import {
  continueVentureSession,
  getVentureSession,
  inspectVentureApplication,
  fillVentureApplication,
  compareVentureApplication,
  previewVentureApplication,
  resumeVentureSession,
  startVentureSession,
  stopVentureSession,
} from "./venturein-runner";
import { ventureinUrls } from "./venturein-schema";

const account = () => ({ loginId: "test-account-sensitive", password: "test-password-sensitive" });
const knownNoticeBody =
  "안녕하세요. 벤처기업확인기관입니다. 벤처기업신청에 앞서 반드시 <가이드북>을 확인해 주시기 바랍니다. 또한, 사업계획서 및 첨부서류 미비한 경우 접수단계에서 보완요청이 진행 되며, 이에 따른 접수기간도 지연될 수 있으니, <필독 안내문(실수방지)>도 꼭 참고하신 후 신청해 주시기 바랍니다. 감사합니다.";
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
    mobileOpenerVisible: false,
    mobileMenuExpanded: false,
    mobileLogoutVisible: false,
    mobileControls: "mobileGnb",
    mobilePopup: "dialog",
    authenticationVisibleCount: 0,
    innovationLinkCount: 0,
    innovationText: "혁신성장유형\n바로가기",
    innovationHref: "#",
    innovationTitleCount: 0,
    innovationCardLinks: 1,
    innovationCardOtherTypes: 0,
    innovationCardTag: "DIV",
    noticeTitleCount: 0,
    noticeConfirmationCount: 1,
    documentCurrent: true,
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
  const trialClick = vi
    .fn<(options: { trial?: boolean; timeout?: number }) => Promise<void>>()
    .mockResolvedValue(undefined);
  const loginLocator = {
    ...loginButton,
    click: (options: { trial?: boolean; timeout?: number }) =>
      options.trial ? trialClick(options) : loginButton.click(),
  };
  const logout = {
    filter: vi.fn(() => logout),
    count: vi.fn(async () =>
      fields.logoutVisible || (fields.mobileMenuExpanded && fields.mobileLogoutVisible) ? 1 : 0,
    ),
    waitFor: vi.fn(async (options: { state: "visible"; timeout: number }) => {
      if (
        options.state !== "visible" ||
        !(fields.logoutVisible || (fields.mobileMenuExpanded && fields.mobileLogoutVisible))
      )
        throw new Error("Logout not visible");
    }),
    isVisible: vi.fn(
      async () => fields.logoutVisible || (fields.mobileMenuExpanded && fields.mobileLogoutVisible),
    ),
    or: vi.fn(() => logout),
    first: vi.fn(() => logout),
  };
  const menuOpener = {
    waitFor: vi.fn(async (options: { state: "visible"; timeout: number }) => {
      if (options.state !== "visible" || !fields.mobileOpenerVisible)
        throw new Error("Mobile opener not visible");
    }),
    isVisible: vi.fn(async () => fields.mobileOpenerVisible),
    getAttribute: vi.fn(async (name: string) => {
      if (name === "aria-expanded") return String(fields.mobileMenuExpanded);
      if (name === "aria-controls") return fields.mobileControls;
      if (name === "aria-haspopup") return fields.mobilePopup;
      return null;
    }),
    click: vi.fn(async () => {
      fields.mobileMenuExpanded = true;
    }),
    first: vi.fn(() => menuOpener),
  };
  const menuCloser = {
    isVisible: vi.fn(async () => fields.mobileMenuExpanded),
    waitFor: vi.fn(async () => {
      if (!fields.mobileMenuExpanded) throw new Error("Menu not visible");
    }),
    click: vi.fn(async () => {
      fields.mobileMenuExpanded = false;
    }),
    first: vi.fn(() => menuCloser),
  };
  const authenticationFields = {
    filter: vi.fn(() => authenticationFields),
    count: vi.fn(async () => fields.authenticationVisibleCount),
    evaluateAll: vi
      .fn<
        (read: (elements: Element[], source: string) => boolean, source: string) => Promise<boolean>
      >()
      .mockResolvedValue(false),
  };
  const innovationChoice = {
    filter: vi.fn(() => innovationChoice),
    count: vi.fn(async () => fields.innovationLinkCount),
    innerText: vi.fn(async () => fields.innovationText),
    getAttribute: vi.fn(async () => fields.innovationHref),
    click: vi.fn(async () => {
      url = `${ventureinUrls.application}/viewVniaBfrv`;
      pageEvents.get("framenavigated")?.();
    }),
  };
  const cardChoice = {
    ...innovationChoice,
    filter: vi.fn(() => cardChoice),
    count: vi.fn(async () => fields.innovationCardLinks),
    innerText: vi.fn(async () => "바로가기"),
  };
  const otherCardTypes = {
    filter: vi.fn(() => otherCardTypes),
    count: vi.fn(async () => fields.innovationCardOtherTypes),
  };
  const innovationCard = {
    evaluate: vi.fn(async () => fields.innovationCardTag),
    locator: vi.fn(() => innovationCard),
    getByRole: vi.fn(() => cardChoice),
    getByText: vi.fn(() => otherCardTypes),
  };
  const innovationTitle = {
    filter: vi.fn(() => innovationTitle),
    count: vi.fn(async () => fields.innovationTitleCount),
    locator: vi.fn(() => innovationCard),
  };
  const noticeData = {
    tagName: "DIV",
    text: `안내사항\n${knownNoticeBody}\n확인\nX`,
    unsafe: false,
    actions: [
      { tag: "BUTTON", role: null as string | null, text: "확인", name: "확인", submits: false },
      { tag: "BUTTON", role: null as string | null, text: "X", name: "X", submits: false },
    ],
  };
  const noticeConfirmation = {
    or: vi.fn(() => noticeConfirmation),
    filter: vi.fn(() => noticeConfirmation),
    count: vi.fn(async () => fields.noticeConfirmationCount),
    click: vi.fn(async () => {
      fields.noticeTitleCount = 0;
    }),
  };
  const noticeContainer = {
    evaluate: vi.fn<(read: (element: HTMLElement) => unknown) => Promise<typeof noticeData>>(
      async () => noticeData,
    ),
    locator: vi.fn(() => noticeContainer),
    getByRole: vi.fn(() => noticeConfirmation),
  };
  const noticeTitle = {
    filter: vi.fn(() => noticeTitle),
    count: vi.fn(async () => fields.noticeTitleCount),
    locator: vi.fn(() => noticeContainer),
    waitFor: vi.fn(async (options: { state: "visible" | "hidden"; timeout: number }) => {
      if (options.state === "visible" ? !fields.noticeTitleCount : fields.noticeTitleCount)
        throw new Error("Notice visibility did not match");
    }),
  };
  const documentHandle = {
    evaluate: vi.fn(async () => fields.documentCurrent),
    dispose: vi.fn(async () => {}),
  };
  const page = {
    evaluateHandle: vi.fn(async () => documentHandle),
    on: vi.fn((event: string, handler: () => void) => pageEvents.set(event, handler)),
    goto: vi.fn(async () => null),
    waitForURL: vi.fn<
      (
        predicate: (value: URL) => boolean,
        options: { waitUntil: "commit"; timeout: number },
      ) => Promise<void>
    >(async (predicate) => {
      if (!predicate(new URL(url))) throw new Error("Expected page did not arrive");
    }),
    waitForLoadState: vi
      .fn<(state: "domcontentloaded", options: { timeout: number }) => Promise<void>>()
      .mockResolvedValue(undefined),
    url: vi.fn(() => url),
    isClosed: vi.fn(() => closed),
    getByRole: vi.fn((_role: string, options: { name: string | RegExp }) => {
      if (options.name instanceof RegExp && options.name.test("혁신성장유형 바로가기"))
        return innovationChoice;
      if (options.name === "로그인") return loginLocator;
      if (options.name === "로그아웃") return logout;
      if (options.name === "모바일 주 메뉴 열기") return menuOpener;
      if (options.name === "모바일 주 메뉴 닫기") return menuCloser;
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
    getByText: vi.fn((text: string | RegExp) =>
      text === "안내사항" ? noticeTitle : innovationTitle,
    ),
    locator: vi.fn(() => authenticationFields),
    screenshot: vi.fn(async () => Buffer.from([137, 80, 78, 71])),
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
    logout,
    trialClick,
    menuOpener,
    menuCloser,
    authenticationFields,
    innovationChoice,
    noticeData,
    noticeConfirmation,
    noticeContainer,
    noticeTitle,
    documentHandle,
    openPopup: () => pageEvents.get("popup")?.(),
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
  collectScreen.mockReset();
  applyText.mockReset();
  compareInputs.mockReset();
  collectScreen.mockResolvedValue({
    id: "inspection-test",
    observedAt: "2026-09-25T01:00:00.000Z",
    url: ventureinUrls.application,
    title: "가상 공식 신청 화면",
    companyEvidence: [],
    fields: [],
    truncated: false,
    warnings: [],
  });
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
    expect(fixture.trialClick).toHaveBeenCalledTimes(1);
    expect(fixture.trialClick).toHaveBeenCalledWith({ trial: true, timeout: 15_000 });
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

  it("첨부 전용 승인 Buffer는 기존 인증·문서 검사를 통과한 helper에 그대로 전달한다", async () => {
    const { id, input } = await textInputFixture();
    const fileInput: Parameters<typeof fillVentureApplication>[1] = {
      ...input,
      snapshot: {
        ...input.snapshot,
        id: "file-snapshot",
        fields: [
          {
            ...input.snapshot.fields[0],
            kind: "file",
            type: "file",
            maxLength: null,
            accept: ".pdf",
          },
        ],
      },
      fields: [],
      attachments: [
        {
          fieldKey: "field-1",
          files: [
            {
              name: "approved.pdf",
              mimeType: "application/pdf",
              buffer: Buffer.from("fixture bytes"),
            },
          ],
        },
      ],
    };
    collectScreen.mockResolvedValue(fileInput.snapshot);
    await inspectVentureApplication(id, "current");
    expect(await fillVentureApplication(id, fileInput, () => {})).toMatchObject({
      status: "completed",
    });
    expect(applyText).toHaveBeenCalledWith(
      expect.anything(),
      fileInput,
      expect.any(Function),
      expect.any(Function),
    );
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
      expect(status.state).toBe(phase === "loginAction" ? "awaiting_auth" : "awaiting_setup");
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
      expect((await resumeVentureSession(id)).state).toBe(
        phase === "loginAction" ? "awaiting_auth" : "awaiting_setup",
      );
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
    expect((await resumeVentureSession(id)).state).toBe("awaiting_login");
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
    expect((await resumeVentureSession(id)).state).toBe("awaiting_auth");
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

  it("권한·로딩 화면이 버튼을 가리면 계정을 입력하지 않고 같은 창에서 명시적으로 이어간다", async () => {
    const fixture = browserFixture();
    const id = caseId();
    const covered = new Error(
      `tk_overdiv intercepts pointer events ${account().password} token=private`,
    );
    fixture.trialClick.mockRejectedValueOnce(covered);
    launch.mockResolvedValue(fixture.browser);
    const waiting = await startVentureSession(id, account());
    expect(waiting.state).toBe("awaiting_login");
    expect(waiting.message).toContain("계정정보는 입력하지 않았습니다");
    expect(JSON.stringify(waiting)).not.toContain(account().password);
    expect(JSON.stringify(waiting)).not.toContain("token=private");
    expect(fixture.loginId.fill).not.toHaveBeenCalled();
    expect(fixture.password.fill).not.toHaveBeenCalled();
    expect(fixture.loginButton.click).not.toHaveBeenCalled();
    expect(fixture.browser.close).not.toHaveBeenCalled();

    expect((await resumeVentureSession(id)).state).toBe("awaiting_login");
    expect(fixture.trialClick).toHaveBeenCalledTimes(1);
    expect(fixture.loginButton.click).not.toHaveBeenCalled();
    const continued = await continueVentureSession(id, account());
    expect(continued.state).toBe("awaiting_auth");
    expect(continued.startedAt).toBe(waiting.startedAt);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(fixture.browser.newContext).toHaveBeenCalledTimes(1);
    expect(fixture.context.newPage).toHaveBeenCalledTimes(1);
    expect(fixture.page.goto).toHaveBeenCalledTimes(1);
    expect(fixture.trialClick).toHaveBeenCalledTimes(2);
    expect(fixture.loginId.fill).toHaveBeenCalledTimes(1);
    expect(fixture.password.fill).toHaveBeenCalledTimes(1);
    expect(fixture.loginButton.click).toHaveBeenCalledTimes(1);
    await continueVentureSession(id, account());
    await startVentureSession(id, account());
    expect(fixture.loginButton.click).toHaveBeenCalledTimes(1);
  });

  it("설치 완료 후 기존 컨텍스트의 로그인 페이지로 돌아가며 재접속·권한 초기화를 하지 않는다", async () => {
    const fixture = browserFixture();
    const id = caseId();
    fixture.page.goto
      .mockImplementationOnce(async () => {
        fixture.navigate(ventureinUrls.securityInstall);
        return null;
      })
      .mockImplementationOnce(async () => {
        fixture.navigate(ventureinUrls.login);
        return null;
      });
    launch.mockResolvedValue(fixture.browser);
    expect((await startVentureSession(id, account())).state).toBe("awaiting_setup");
    expect(fixture.loginId.fill).not.toHaveBeenCalled();
    expect((await continueVentureSession(id, account())).state).toBe("awaiting_auth");
    expect(launch).toHaveBeenCalledTimes(1);
    expect(fixture.browser.newContext).toHaveBeenCalledTimes(1);
    expect(fixture.page.goto).toHaveBeenCalledTimes(2);
    expect(fixture.page.goto).toHaveBeenLastCalledWith(ventureinUrls.login, expect.any(Object));
    expect(fixture.loginButton.click).toHaveBeenCalledTimes(1);
    expect(fixture.browser.close).not.toHaveBeenCalled();
  });

  it("설치 화면에서 같은 창으로 수동 로그인했다면 상태만 확인하고 재입력하지 않는다", async () => {
    const fixture = browserFixture();
    const id = caseId();
    fixture.page.goto.mockImplementation(async () => {
      fixture.navigate(ventureinUrls.securityInstall);
      return null;
    });
    launch.mockResolvedValue(fixture.browser);
    await startVentureSession(id, account());
    fixture.navigate("https://www.smes.go.kr/venturein/main");
    fixture.fields.idVisible = false;
    fixture.fields.passwordVisible = false;
    fixture.fields.logoutVisible = true;
    expect((await continueVentureSession(id, account())).state).toBe("connected_unmapped");
    expect((await resumeVentureSession(id)).state).toBe("connected_unmapped");
    expect(fixture.loginId.fill).not.toHaveBeenCalled();
    expect(fixture.password.fill).not.toHaveBeenCalled();
    expect(fixture.loginButton.click).not.toHaveBeenCalled();
    expect(fixture.page.goto).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it.each(["navigation", "idEntry", "passwordEntry"] as const)(
    "%s 중 설치로 이탈한 뒤에는 수동 로그인의 공식 탐색을 차단하지 않는다",
    async (phase) => {
      const fixture = browserFixture();
      const id = caseId();
      const navigateToSetup = async () => fixture.navigate(ventureinUrls.securityInstall);
      if (phase === "navigation")
        fixture.page.goto.mockImplementation(async () => {
          await navigateToSetup();
          return null;
        });
      if (phase === "idEntry") fixture.loginId.fill.mockImplementation(navigateToSetup);
      if (phase === "passwordEntry") fixture.password.fill.mockImplementation(navigateToSetup);
      launch.mockResolvedValue(fixture.browser);
      expect((await startVentureSession(id, account())).state).toBe("awaiting_setup");
      const abort = vi.fn(async () => {});
      const proceed = vi.fn(async () => {});
      await fixture.context.route.mock.calls[0][1]({
        request: () => ({
          isNavigationRequest: () => true,
          url: () => "https://www.smes.go.kr/venturein/auth/login",
        }),
        abort,
        continue: proceed,
      });
      expect(abort).not.toHaveBeenCalled();
      expect(proceed).toHaveBeenCalledTimes(1);
      expect(fixture.loginButton.click).not.toHaveBeenCalled();
    },
  );

  it("입력 중 설치 화면을 잠시 거쳐 로그인 화면으로 돌아와도 현재 자동 입력은 중단한다", async () => {
    const fixture = browserFixture();
    const id = caseId();
    fixture.loginId.fill.mockImplementationOnce(async () => {
      fixture.navigate(ventureinUrls.securityInstall);
      fixture.navigate(ventureinUrls.login);
    });
    launch.mockResolvedValue(fixture.browser);
    expect((await startVentureSession(id, account())).state).toBe("awaiting_login");
    expect(fixture.password.fill).not.toHaveBeenCalled();
    expect(fixture.loginButton.click).not.toHaveBeenCalled();
    expect((await continueVentureSession(id, account())).state).toBe("awaiting_auth");
    expect(fixture.password.fill).toHaveBeenCalledTimes(1);
    expect(fixture.loginButton.click).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("같은 창 재개 요청이 겹쳐도 로그인 클릭을 한 번만 전송한다", async () => {
    const fixture = browserFixture();
    const id = caseId();
    fixture.trialClick.mockRejectedValueOnce(new Error("element intercepts pointer events"));
    launch.mockResolvedValue(fixture.browser);
    await startVentureSession(id, account());
    await Promise.all([
      continueVentureSession(id, account()),
      continueVentureSession(id, account()),
    ]);
    expect(getVentureSession(id).state).toBe("awaiting_auth");
    expect(fixture.loginId.fill).toHaveBeenCalledTimes(1);
    expect(fixture.password.fill).toHaveBeenCalledTimes(1);
    expect(fixture.loginButton.click).toHaveBeenCalledTimes(1);
  });

  it("재개 상태를 검사하는 동안 창이 닫히면 계정 입력을 시작하지 않는다", async () => {
    const fixture = browserFixture();
    const id = caseId();
    fixture.trialClick.mockRejectedValueOnce(new Error("element intercepts pointer events"));
    launch.mockResolvedValue(fixture.browser);
    await startVentureSession(id, account());
    fixture.loginId.isVisible.mockImplementationOnce(async () => {
      fixture.closeWindow();
      return true;
    });
    expect((await continueVentureSession(id, account())).state).toBe("stopped");
    expect(fixture.loginId.fill).not.toHaveBeenCalled();
    expect(fixture.password.fill).not.toHaveBeenCalled();
    expect(fixture.loginButton.click).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("이전 코드의 로그인 시도 플래그 없는 세션을 재입력 가능 상태로 바꾸지 않는다", async () => {
    const fixture = browserFixture();
    const id = caseId();
    launch.mockResolvedValue(fixture.browser);
    await startVentureSession(id, account());
    const globalSessions = globalThis as typeof globalThis & {
      __ventureinSessions?: Map<string, { loginAttempted?: boolean }>;
    };
    delete globalSessions.__ventureinSessions!.get(id)!.loginAttempted;
    expect((await resumeVentureSession(id)).state).toBe("awaiting_auth");
    expect((await continueVentureSession(id, account())).state).toBe("awaiting_auth");
    expect(fixture.loginButton.click).toHaveBeenCalledTimes(1);
    expect(fixture.loginId.fill).toHaveBeenCalledTimes(1);
  });

  it("실제 클릭 뒤 설치 화면이 나타나도 같은 창 재개로 로그인을 다시 전송하지 않는다", async () => {
    const fixture = browserFixture();
    const id = caseId();
    fixture.loginButton.click.mockImplementation(async () => {
      fixture.navigate(ventureinUrls.securityInstall);
      throw new Error("Navigation timeout");
    });
    launch.mockResolvedValue(fixture.browser);
    expect((await startVentureSession(id, account())).state).toBe("awaiting_auth");
    await continueVentureSession(id, account());
    fixture.navigate(ventureinUrls.login);
    await continueVentureSession(id, account());
    expect((await resumeVentureSession(id)).state).toBe("awaiting_auth");
    expect(fixture.loginButton.click).toHaveBeenCalledTimes(1);
    expect(fixture.loginId.fill).toHaveBeenCalledTimes(1);
    expect(fixture.page.goto).toHaveBeenCalledTimes(1);
  });

  it("동일 창 재개도 디버그 환경에서는 계정정보를 입력하지 않는다", async () => {
    const fixture = browserFixture();
    const id = caseId();
    fixture.trialClick.mockRejectedValueOnce(new Error("element intercepts pointer events"));
    launch.mockResolvedValue(fixture.browser);
    await startVentureSession(id, account());
    vi.stubEnv("DEBUG", "pw:*");
    expect((await continueVentureSession(id, account())).state).toBe("login_failed");
    expect(fixture.loginId.fill).not.toHaveBeenCalled();
    expect(fixture.password.fill).not.toHaveBeenCalled();
    expect(fixture.loginButton.click).not.toHaveBeenCalled();
    expect(fixture.browser.close).toHaveBeenCalledTimes(1);
  });

  it("동일 창 재개는 15분 만료 시간을 연장하거나 만료 후 새 창을 열지 않는다", async () => {
    vi.useFakeTimers();
    const fixture = browserFixture();
    const id = caseId();
    fixture.trialClick.mockRejectedValueOnce(new Error("element intercepts pointer events"));
    launch.mockResolvedValue(fixture.browser);
    await startVentureSession(id, account());
    await vi.advanceTimersByTimeAsync(14 * 60 * 1000);
    await continueVentureSession(id, account());
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect((await continueVentureSession(id, account())).state).toBe("stopped");
    expect(fixture.browser.close).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(fixture.loginButton.click).toHaveBeenCalledTimes(1);
  });

  it("준비 확인 중 외부 주소로 이동하면 계정 입력 전에 창을 닫는다", async () => {
    const fixture = browserFixture();
    fixture.trialClick.mockImplementation(async () => {
      fixture.navigate("https://attacker.test/login");
    });
    launch.mockResolvedValue(fixture.browser);
    expect((await startVentureSession(caseId(), account())).state).toBe("login_failed");
    expect(fixture.loginId.fill).not.toHaveBeenCalled();
    expect(fixture.password.fill).not.toHaveBeenCalled();
    expect(fixture.loginButton.click).not.toHaveBeenCalled();
    expect(fixture.browser.close).toHaveBeenCalledTimes(1);
  });

  async function mobileHomeFixture() {
    const fixture = browserFixture();
    const id = caseId();
    launch.mockResolvedValue(fixture.browser);
    await startVentureSession(id, account());
    fixture.fields.idVisible = false;
    fixture.fields.passwordVisible = false;
    fixture.fields.mobileOpenerVisible = true;
    fixture.navigate("https://www.smes.go.kr/venturein/home/viewHome");
    return { fixture, id };
  }

  it("명시적 상태 확인은 접힌 공식 모바일 메뉴의 로그아웃을 확인하고 자신이 연 메뉴를 닫는다", async () => {
    const { fixture, id } = await mobileHomeFixture();
    fixture.fields.mobileLogoutVisible = true;
    expect((await resumeVentureSession(id)).state).toBe("connected_unmapped");
    expect(fixture.menuOpener.click).toHaveBeenCalledWith({ timeout: 3_000 });
    expect(fixture.menuCloser.click).toHaveBeenCalledWith({ timeout: 3_000 });
    expect(fixture.fields.mobileMenuExpanded).toBe(false);
    expect(fixture.loginButton.click).toHaveBeenCalledTimes(1);
    expect(fixture.loginId.fill).toHaveBeenCalledTimes(1);
    expect(fixture.page.goto).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("공개 HOME의 모바일 메뉴에 로그아웃이 없으면 로그인 성공으로 추정하지 않는다", async () => {
    const { fixture, id } = await mobileHomeFixture();
    expect((await resumeVentureSession(id)).state).toBe("awaiting_auth");
    expect(fixture.menuOpener.click).toHaveBeenCalledTimes(1);
    expect(fixture.menuCloser.click).toHaveBeenCalledTimes(1);
    expect(fixture.loginButton.click).toHaveBeenCalledTimes(1);
  });

  it("메뉴를 열어 열기 버튼이 숨겨져도 자신이 연 메뉴는 닫는다", async () => {
    const { fixture, id } = await mobileHomeFixture();
    fixture.fields.mobileLogoutVisible = true;
    fixture.menuOpener.getAttribute.mockImplementation(async (name) => {
      if (fixture.fields.mobileMenuExpanded)
        throw new Error("Opener is hidden from role selectors");
      if (name === "aria-expanded") return "false";
      if (name === "aria-controls") return "mobileGnb";
      if (name === "aria-haspopup") return "dialog";
      return null;
    });
    expect((await resumeVentureSession(id)).state).toBe("connected_unmapped");
    expect(fixture.menuCloser.click).toHaveBeenCalledTimes(1);
    expect(fixture.fields.mobileMenuExpanded).toBe(false);
  });

  it.each([true, false])(
    "사용자가 이미 연 모바일 메뉴는 그대로 둔다: 로그아웃=%s",
    async (logout) => {
      const { fixture, id } = await mobileHomeFixture();
      fixture.fields.mobileMenuExpanded = true;
      fixture.fields.mobileLogoutVisible = logout;
      expect((await resumeVentureSession(id)).state).toBe(
        logout ? "connected_unmapped" : "awaiting_auth",
      );
      expect(fixture.menuOpener.click).not.toHaveBeenCalled();
      expect(fixture.menuCloser.click).not.toHaveBeenCalled();
      expect(fixture.fields.mobileMenuExpanded).toBe(true);
    },
  );

  it.each(["external", "form", "unknown-controls", "unknown-popup"])(
    "%s 조건에서는 모바일 메뉴를 조작하지 않는다",
    async (condition) => {
      const { fixture, id } = await mobileHomeFixture();
      if (condition === "external")
        fixture.navigate("https://attacker.test/venturein/home/viewHome");
      if (condition === "form") fixture.fields.idVisible = true;
      if (condition === "unknown-controls") fixture.fields.mobileControls = "unknown";
      if (condition === "unknown-popup") fixture.fields.mobilePopup = "menu";
      expect((await resumeVentureSession(id)).state).toBe("awaiting_auth");
      expect(fixture.menuOpener.click).not.toHaveBeenCalled();
      expect(fixture.menuCloser.click).not.toHaveBeenCalled();
    },
  );

  it("메뉴 열기 실패는 원문을 노출하거나 계정 동작을 재시도하지 않는다", async () => {
    const { fixture, id } = await mobileHomeFixture();
    fixture.menuOpener.click.mockRejectedValue(new Error(`private ${account().password}`));
    const status = await resumeVentureSession(id);
    expect(status.state).toBe("awaiting_auth");
    expect(JSON.stringify(status)).not.toContain(account().password);
    expect(fixture.menuCloser.click).not.toHaveBeenCalled();
    expect(fixture.loginButton.click).toHaveBeenCalledTimes(1);
  });

  it("메뉴가 열린 뒤 클릭 완료가 실패해도 같은 페이지에서 자신이 연 메뉴만 복원한다", async () => {
    const { fixture, id } = await mobileHomeFixture();
    fixture.menuOpener.click.mockImplementation(async () => {
      fixture.fields.mobileMenuExpanded = true;
      throw new Error("Action completion timed out");
    });
    expect((await resumeVentureSession(id)).state).toBe("awaiting_auth");
    expect(fixture.menuCloser.click).toHaveBeenCalledTimes(1);
    expect(fixture.fields.mobileMenuExpanded).toBe(false);
  });

  it.each(["official-navigation", "external-navigation", "close"])(
    "메뉴 확인 중 %s 발생 시 추가 클릭과 성공 판정을 중단한다",
    async (event) => {
      const { fixture, id } = await mobileHomeFixture();
      fixture.fields.mobileLogoutVisible = true;
      fixture.menuOpener.click.mockImplementation(async () => {
        fixture.fields.mobileMenuExpanded = true;
        if (event === "close") fixture.closeWindow();
        else
          fixture.navigate(
            event === "official-navigation"
              ? "https://www.smes.go.kr/venturein/another"
              : "https://attacker.test/venturein/home/viewHome",
          );
      });
      expect((await resumeVentureSession(id)).state).toBe(
        event === "close" ? "stopped" : "awaiting_auth",
      );
      expect(fixture.menuCloser.click).not.toHaveBeenCalled();
      expect(fixture.loginButton.click).toHaveBeenCalledTimes(1);
    },
  );

  it("동시에 요청한 상태 확인은 모바일 메뉴를 한 번만 열고 닫는다", async () => {
    const { fixture, id } = await mobileHomeFixture();
    fixture.fields.mobileLogoutVisible = true;
    await Promise.all([resumeVentureSession(id), resumeVentureSession(id)]);
    expect(getVentureSession(id).state).toBe("connected_unmapped");
    expect(fixture.menuOpener.click).toHaveBeenCalledTimes(1);
    expect(fixture.menuCloser.click).toHaveBeenCalledTimes(1);
  });

  async function authenticatedFixture() {
    const result = await mobileHomeFixture();
    result.fixture.fields.logoutVisible = true;
    await resumeVentureSession(result.id);
    return result;
  }

  async function noticeFixture() {
    const result = await authenticatedFixture();
    const { fixture } = result;
    fixture.navigate(ventureinUrls.application);
    fixture.fields.noticeTitleCount = 1;
    fixture.fields.logoutVisible = false;
    fixture.fields.mobileLogoutVisible = true;
    return result;
  }

  it("사전 로그인 확인 이력이 있으면 정확한 준비 공지만 한 번 닫고 모바일 메뉴로 로그인 상태를 확인한다", async () => {
    const { fixture, id } = await noticeFixture();
    expect((await resumeVentureSession(id)).state).toBe("connected_unmapped");
    expect(fixture.noticeConfirmation.click).toHaveBeenCalledExactlyOnceWith({ timeout: 3_000 });
    expect(fixture.noticeConfirmation.click.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.menuOpener.click.mock.invocationCallOrder[0],
    );
    expect(fixture.loginId.fill).toHaveBeenCalledTimes(1);
    expect(fixture.password.fill).toHaveBeenCalledTimes(1);
    expect(fixture.loginButton.click).toHaveBeenCalledTimes(1);
    expect(fixture.page.goto).toHaveBeenCalledTimes(1);
  });

  it("공지 본문에 관찰된 두 자료 링크는 클릭하지 않고 확인만 누른다", async () => {
    const { fixture, id } = await noticeFixture();
    fixture.noticeData.actions.push(
      ...["가이드북", "필독 안내문(실수방지)"].map((text) => ({
        tag: "A",
        role: null,
        text,
        name: text,
        submits: false,
      })),
    );
    expect((await resumeVentureSession(id)).state).toBe("connected_unmapped");
    expect(fixture.noticeConfirmation.click).toHaveBeenCalledTimes(1);
  });

  it.each(
    ["click", "click-completion-error", "close-wait"].flatMap((phase) =>
      ["", "?unknown=private-value", "?unknown=private-value#section"].map((suffix) => ({
        phase,
        suffix,
      })),
    ),
  )(
    "공지 확인의 $phase 뒤 사전확인 화면$suffix에서 새 로그인 표시를 검사한다",
    async ({ phase, suffix }) => {
      const { fixture, id } = await noticeFixture();
      const currentUrl = `${ventureinUrls.application}/viewVniaBfrv${suffix}`;
      const advance = () => {
        fixture.fields.noticeTitleCount = 0;
        fixture.navigate(currentUrl);
      };
      fixture.noticeConfirmation.click.mockImplementationOnce(async () => {
        if (phase !== "close-wait") advance();
        if (phase === "click-completion-error")
          throw new Error("Navigation completion interrupted");
      });
      if (phase === "close-wait")
        fixture.noticeTitle.waitFor.mockImplementationOnce(async () => {
          advance();
        });
      expect((await resumeVentureSession(id)).state).toBe("connected_unmapped");
      expect(fixture.noticeConfirmation.click).toHaveBeenCalledTimes(1);
      expect(fixture.menuOpener.click).toHaveBeenCalledTimes(1);
      expect(fixture.loginButton.click).toHaveBeenCalledTimes(1);
      expect(fixture.page.url()).toBe(currentUrl);
      expect(fixture.page.goto).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(getVentureSession(id))).not.toContain("private-value");
    },
  );

  it.each(
    ["missing-logout", "login-form"].flatMap((condition) =>
      ["", "?unknown=private-value"].map((suffix) => ({ condition, suffix })),
    ),
  )(
    "사전확인 화면$suffix라도 $condition이면 로그인 완료로 인정하지 않는다",
    async ({ condition, suffix }) => {
      const { fixture, id } = await noticeFixture();
      fixture.noticeConfirmation.click.mockImplementationOnce(async () => {
        fixture.fields.noticeTitleCount = 0;
        fixture.navigate(`${ventureinUrls.application}/viewVniaBfrv${suffix}`);
        if (condition === "missing-logout") fixture.fields.mobileLogoutVisible = false;
        else fixture.fields.idVisible = true;
      });
      expect((await resumeVentureSession(id)).state).toBe("awaiting_auth");
      expect(fixture.loginButton.click).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    `${ventureinUrls.application}/viewVniaBfrv/other?unknown=private-value`,
    "https://attacker.test/venturein/aply/v2/viewVniaBfrv?unknown=private-value",
    "http://www.smes.go.kr/venturein/aply/v2/viewVniaBfrv?unknown=private-value",
    "https://account@www.smes.go.kr/venturein/aply/v2/viewVniaBfrv?unknown=private-value",
  ])(
    "공지 확인 뒤 다른 origin·path인 %s로 바뀌면 현재 읽기로 진행하지 않는다",
    async (destination) => {
      const { fixture, id } = await noticeFixture();
      fixture.noticeConfirmation.click.mockImplementationOnce(async () => {
        fixture.navigate(destination);
      });
      const status = await resumeVentureSession(id);
      expect(status.state).toBe("awaiting_auth");
      expect(status.message).toContain("내용·주소 또는 연결 창이 바뀌었습니다");
      expect(status.message).not.toContain("private-value");
      expect(fixture.menuOpener.click).not.toHaveBeenCalled();
    },
  );

  it("문서 전체가 로딩되지 않아도 검증된 모바일 헤더 준비 뒤 실제 로그아웃 표시를 확인한다", async () => {
    const { fixture, id } = await noticeFixture();
    const url = `${ventureinUrls.application}/viewVniaBfrv?unknown=private-value`;
    fixture.noticeConfirmation.click.mockImplementationOnce(async () => {
      fixture.fields.noticeTitleCount = 0;
      fixture.fields.mobileLogoutVisible = false;
      fixture.navigate(url);
    });
    fixture.page.waitForLoadState.mockRejectedValue(new Error("DOMContentLoaded never completes"));
    fixture.menuOpener.waitFor.mockImplementationOnce(async () => {
      fixture.fields.mobileLogoutVisible = true;
    });
    fixture.logout.isVisible.mockClear();
    expect((await resumeVentureSession(id)).state).toBe("connected_unmapped");
    expect(fixture.page.waitForLoadState).not.toHaveBeenCalled();
    expect(fixture.menuOpener.waitFor).toHaveBeenCalledExactlyOnceWith({
      state: "visible",
      timeout: expect.any(Number),
    });
    expect(fixture.menuOpener.waitFor.mock.calls[0][0].timeout).toBeLessThanOrEqual(15_000);
    expect(fixture.menuOpener.waitFor.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.logout.isVisible.mock.invocationCallOrder[0],
    );
    expect(fixture.page.url()).toBe(url);
    expect(fixture.page.goto).toHaveBeenCalledTimes(1);
  });

  it.each(["login-form", "missing-logout", "wrong-controls", "wrong-popup", "expanded"])(
    "사전확인 헤더가 표시되어도 %s이면 실제 로그인 성공으로 처리하거나 수집하지 않는다",
    async (condition) => {
      const { fixture, id } = await noticeFixture();
      fixture.noticeConfirmation.click.mockImplementationOnce(async () => {
        fixture.fields.noticeTitleCount = 0;
        fixture.navigate(`${ventureinUrls.application}/viewVniaBfrv?unknown=private-value`);
        if (condition === "login-form") {
          fixture.fields.idVisible = true;
          fixture.fields.logoutVisible = true;
        } else {
          fixture.fields.mobileLogoutVisible = false;
          if (condition === "wrong-controls") fixture.fields.mobileControls = "differentMenu";
          if (condition === "wrong-popup") fixture.fields.mobilePopup = "menu";
          if (condition === "expanded") fixture.fields.mobileMenuExpanded = true;
        }
      });
      await expect(inspectVentureApplication(id, "innovation")).rejects.toMatchObject({
        status: 409,
      });
      expect(fixture.noticeConfirmation.click).toHaveBeenCalledTimes(1);
      expect(fixture.page.waitForLoadState).not.toHaveBeenCalled();
      expect(fixture.page.goto).toHaveBeenCalledTimes(1);
      expect(fixture.innovationChoice.click).not.toHaveBeenCalled();
      expect(collectScreen).not.toHaveBeenCalled();
      if (condition !== "missing-logout") expect(fixture.menuOpener.click).not.toHaveBeenCalled();
    },
  );

  it("모바일 헤더 준비가 늦으면 기다리며 준비 신호 뒤에만 실제 로그인을 다시 확인한다", async () => {
    const { fixture, id } = await noticeFixture();
    let ready: (() => void) | undefined;
    fixture.noticeConfirmation.click.mockImplementationOnce(async () => {
      fixture.fields.noticeTitleCount = 0;
      fixture.navigate(`${ventureinUrls.application}/viewVniaBfrv?unknown=private-value`);
    });
    fixture.menuOpener.waitFor.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
    );
    fixture.logout.isVisible.mockClear();
    const pending = inspectVentureApplication(id, "innovation");
    await vi.waitFor(() => expect(fixture.menuOpener.waitFor).toHaveBeenCalledTimes(1));
    expect(fixture.logout.isVisible).not.toHaveBeenCalled();
    expect(collectScreen).not.toHaveBeenCalled();
    ready?.();
    await pending;
    expect(fixture.logout.isVisible).toHaveBeenCalled();
    expect(collectScreen).toHaveBeenCalledExactlyOnceWith(fixture.page);
  });

  it.each([
    {
      phase: "login-form",
      kind: "strict",
      label: "로그인 입력란 확인",
      reason: "동일한 화면 요소가 여러 개",
    },
    { phase: "notice", kind: "timeout", label: "신청 준비 안내 확인", reason: "제한 시간을 초과" },
    {
      phase: "document",
      kind: "timeout",
      label: "사전확인 문서 준비 대기",
      reason: "제한 시간을 초과",
    },
    {
      phase: "advanced-form",
      kind: "strict",
      label: "새 화면 로그인 입력란 확인",
      reason: "동일한 화면 요소가 여러 개",
    },
    {
      phase: "logout",
      kind: "other",
      label: "로그아웃 표시 확인",
      reason: "단계 처리를 완료하지 못했습니다",
    },
    {
      phase: "login-form",
      kind: "non-error",
      label: "로그인 입력란 확인",
      reason: "단계 처리를 완료하지 못했습니다",
    },
  ])(
    "$phase 검사 실패는 고정 단계와 $kind 분류만 반환한다",
    async ({ phase, kind, label, reason }) => {
      const { fixture, id } =
        phase === "document" || phase === "advanced-form"
          ? await noticeFixture()
          : await authenticatedFixture();
      fixture.navigate(ventureinUrls.application);
      const privateText = `private-query-value ${account().loginId} ${account().password}`;
      const failure =
        kind === "non-error"
          ? privateText
          : new Error(`${kind === "strict" ? "strict mode violation " : ""}${privateText}`);
      if (failure instanceof Error && kind === "timeout") failure.name = "TimeoutError";
      if (phase === "login-form") fixture.loginId.isVisible.mockRejectedValueOnce(failure);
      if (phase === "notice") fixture.noticeTitle.count.mockRejectedValueOnce(failure);
      if (phase === "logout") fixture.logout.isVisible.mockRejectedValueOnce(failure);
      if (phase === "document" || phase === "advanced-form") {
        fixture.noticeConfirmation.click.mockImplementationOnce(async () => {
          fixture.fields.noticeTitleCount = 0;
          fixture.navigate(`${ventureinUrls.application}/viewVniaBfrv?case=private-query-value`);
        });
        if (phase === "document") {
          fixture.logout.waitFor.mockRejectedValueOnce(failure);
          fixture.menuOpener.waitFor.mockRejectedValueOnce(failure);
        } else
          fixture.menuOpener.waitFor.mockImplementationOnce(async () => {
            fixture.loginId.isVisible.mockRejectedValueOnce(failure);
          });
      }
      const status = await resumeVentureSession(id);
      expect(status.state).toBe("awaiting_auth");
      expect(status.message).toContain(`확인 단계: ${label}`);
      expect(status.message).toContain(reason);
      for (const secret of ["private-query-value", account().loginId, account().password])
        expect(JSON.stringify(status)).not.toContain(secret);
      expect(fixture.loginButton.click).toHaveBeenCalledTimes(1);
      expect(collectScreen).not.toHaveBeenCalled();
    },
  );

  it.each(["timeout", "query-change", "external", "closed"])(
    "공지 후 문서 준비 대기 중 %s이면 새 로그인 확인이나 수집을 진행하지 않는다",
    async (condition) => {
      const { fixture, id } = await noticeFixture();
      fixture.noticeConfirmation.click.mockImplementationOnce(async () => {
        fixture.fields.noticeTitleCount = 0;
        fixture.navigate(`${ventureinUrls.application}/viewVniaBfrv?unknown=private-value`);
      });
      fixture.menuOpener.waitFor.mockImplementationOnce(async () => {
        if (condition === "timeout") throw new Error("DOMContentLoaded timeout");
        if (condition === "query-change")
          fixture.navigate(`${ventureinUrls.application}/viewVniaBfrv?changed=1`);
        if (condition === "external")
          fixture.navigate("https://attacker.test/venturein/aply/v2/viewVniaBfrv");
        if (condition === "closed") fixture.closeWindow();
      });
      fixture.logout.isVisible.mockClear();
      await expect(inspectVentureApplication(id, "innovation")).rejects.toMatchObject({
        status: 409,
      });
      if (condition !== "closed")
        expect(getVentureSession(id).message).toContain("확인 단계: 사전확인 문서 준비 대기");
      expect(fixture.logout.isVisible).not.toHaveBeenCalled();
      expect(fixture.noticeConfirmation.click).toHaveBeenCalledTimes(1);
      expect(fixture.page.goto).toHaveBeenCalledTimes(1);
      expect(collectScreen).not.toHaveBeenCalled();
    },
  );

  it("확인 클릭 전 사전확인 주소로 바뀌면 관찰된 확인 동작으로 간주하지 않는다", async () => {
    const { fixture, id } = await noticeFixture();
    fixture.noticeContainer.evaluate.mockImplementationOnce(async () => {
      fixture.navigate(`${ventureinUrls.application}/viewVniaBfrv`);
      return fixture.noticeData;
    });
    const status = await resumeVentureSession(id);
    expect(status.state).toBe("awaiting_auth");
    expect(fixture.noticeConfirmation.click).not.toHaveBeenCalled();
  });

  it("혁신성장 검사 시작의 공지에서 쿼리가 있는 사전확인 화면으로 넘어가면 현재 화면을 보존한다", async () => {
    const { fixture, id } = await noticeFixture();
    fixture.noticeConfirmation.click.mockImplementationOnce(async () => {
      fixture.fields.noticeTitleCount = 0;
      fixture.navigate(`${ventureinUrls.application}/viewVniaBfrv?unknown=private-value`);
    });
    await inspectVentureApplication(id, "innovation");
    expect(fixture.page.goto).toHaveBeenCalledTimes(1);
    expect(fixture.innovationChoice.click).not.toHaveBeenCalled();
    expect(collectScreen).toHaveBeenCalledExactlyOnceWith(fixture.page);
  });

  it("이미 사전확인 화면인 혁신성장 검사는 새 로그인 확인만 하고 같은 화면을 읽는다", async () => {
    const { fixture, id } = await authenticatedFixture();
    fixture.navigate(`${ventureinUrls.application}/viewVniaBfrv`);
    await inspectVentureApplication(id, "innovation");
    expect(fixture.page.goto).toHaveBeenCalledTimes(1);
    expect(fixture.innovationChoice.click).not.toHaveBeenCalled();
    expect(collectScreen).toHaveBeenCalledExactlyOnceWith(fixture.page);
  });

  it.each(["?case=private-value", "#private-value", "?case=private-value#private-value"])(
    "이미 열린 사전확인 주소의 %s를 그대로 보존하고 혁신성장 명령을 현재 읽기로 처리한다",
    async (suffix) => {
      const { fixture, id } = await authenticatedFixture();
      const url = `${ventureinUrls.application}/viewVniaBfrv${suffix}`;
      fixture.navigate(url);
      const status = await resumeVentureSession(id);
      expect(status.state).toBe("connected_unmapped");
      expect(status.message).not.toContain("private-value");
      fixture.logout.isVisible.mockClear();
      await inspectVentureApplication(id, "innovation");
      expect(fixture.logout.isVisible).toHaveBeenCalledTimes(2);
      expect(fixture.page.goto).toHaveBeenCalledTimes(1);
      expect(fixture.page.url()).toBe(url);
      expect(fixture.innovationChoice.click).not.toHaveBeenCalled();
      expect(collectScreen).toHaveBeenCalledExactlyOnceWith(fixture.page);
      expect(fixture.noticeConfirmation.click).not.toHaveBeenCalled();
      expect(fixture.loginId.fill).toHaveBeenCalledTimes(1);
      expect(fixture.password.fill).toHaveBeenCalledTimes(1);
      expect(fixture.loginButton.click).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["missing-logout", "login-form", "external", "closed"])(
    "기존 쿼리 사전확인 화면이라도 %s이면 혁신성장 현재 읽기를 시작하지 않는다",
    async (condition) => {
      const { fixture, id } = await authenticatedFixture();
      fixture.navigate(`${ventureinUrls.application}/viewVniaBfrv?unknown=private-value`);
      if (condition === "missing-logout") fixture.fields.logoutVisible = false;
      if (condition === "login-form") fixture.fields.idVisible = true;
      if (condition === "external")
        fixture.navigate(
          "https://attacker.test/venturein/aply/v2/viewVniaBfrv?unknown=private-value",
        );
      if (condition === "closed") fixture.closeWindow();
      await expect(inspectVentureApplication(id, "innovation")).rejects.toMatchObject({
        status: 409,
      });
      expect(fixture.page.goto).toHaveBeenCalledTimes(1);
      expect(fixture.innovationChoice.click).not.toHaveBeenCalled();
      expect(collectScreen).not.toHaveBeenCalled();
    },
  );

  it.each(["first-auth", "second-auth", "collection"])(
    "기존 사전확인 화면의 %s 도중 쿼리가 바뀌면 새 페이지로 이동하거나 이전 결과를 반환하지 않는다",
    async (phase) => {
      const { fixture, id } = await authenticatedFixture();
      const initialUrl = `${ventureinUrls.application}/viewVniaBfrv?unknown=private-value`;
      fixture.navigate(initialUrl);
      const change = () => fixture.navigate(`${initialUrl}&changed=1`);
      if (phase === "collection") {
        collectScreen.mockImplementationOnce(async () => {
          change();
          return { id: "changed-snapshot" };
        });
      } else {
        if (phase === "second-auth") fixture.logout.isVisible.mockResolvedValueOnce(true);
        fixture.logout.isVisible.mockImplementationOnce(async () => {
          change();
          return true;
        });
      }
      await expect(inspectVentureApplication(id, "innovation")).rejects.toMatchObject({
        code: phase === "first-auth" ? "VENTURE_NOT_CONNECTED" : "VENTURE_SCREEN_CHANGED",
      });
      expect(fixture.page.goto).toHaveBeenCalledTimes(1);
      expect(fixture.innovationChoice.click).not.toHaveBeenCalled();
      expect(collectScreen).toHaveBeenCalledTimes(phase === "collection" ? 1 : 0);
      expect(JSON.stringify(getVentureSession(id))).not.toContain("private-value");
    },
  );

  it("공지 확인 뒤 쿼리 화면의 새 로그인 검사 중 주소가 다시 바뀌면 수집하지 않는다", async () => {
    const { fixture, id } = await noticeFixture();
    const initialUrl = `${ventureinUrls.application}/viewVniaBfrv?unknown=private-value`;
    fixture.noticeConfirmation.click.mockImplementationOnce(async () => {
      fixture.fields.noticeTitleCount = 0;
      fixture.navigate(initialUrl);
    });
    fixture.logout.isVisible.mockImplementationOnce(async () => {
      fixture.navigate(`${initialUrl}&changed=1`);
      return true;
    });
    await expect(inspectVentureApplication(id, "innovation")).rejects.toMatchObject({
      status: 409,
    });
    expect(fixture.noticeConfirmation.click).toHaveBeenCalledTimes(1);
    expect(fixture.page.goto).toHaveBeenCalledTimes(1);
    expect(fixture.innovationChoice.click).not.toHaveBeenCalled();
    expect(collectScreen).not.toHaveBeenCalled();
  });

  it.each([
    "extra-text",
    "changed-body",
    "duplicate-title",
    "duplicate-confirmation",
    "input",
    "extra-action",
    "submit",
    "agreement",
    "unknown-action",
  ])("공지의 %s 조건은 확인과 모바일 메뉴 동작 없이 거부한다", async (condition) => {
    const { fixture, id } = await noticeFixture();
    if (condition === "extra-text") fixture.noticeData.text += " 개인정보 제공에 동의합니다.";
    if (condition === "changed-body")
      fixture.noticeData.text = fixture.noticeData.text.replace("반드시", "선택적으로");
    if (condition === "duplicate-title") fixture.fields.noticeTitleCount = 2;
    if (condition === "duplicate-confirmation") fixture.fields.noticeConfirmationCount = 2;
    if (condition === "input") fixture.noticeData.unsafe = true;
    if (condition === "submit") fixture.noticeData.actions[0].submits = true;
    if (condition === "agreement") fixture.noticeData.actions[0].name = "동의 및 신청";
    if (condition === "unknown-action") fixture.noticeData.actions[0].tag = "DIV";
    if (condition === "extra-action")
      fixture.noticeData.actions.push({
        tag: "BUTTON",
        role: null,
        name: "동의",
        text: "동의",
        submits: false,
      });
    const status = await resumeVentureSession(id);
    expect(status.state).toBe("awaiting_auth");
    const reasons: Record<string, string> = {
      "extra-text": "준비 공지 이외의 문구",
      "changed-body": "안내 본문이 확인된 준비 공지와 일치하지 않습니다",
      "duplicate-title": "안내사항 제목이 여러 개",
      "duplicate-confirmation": "확인 버튼이 여러 개",
      input: "입력·동의 항목 또는 서식",
      submit: "입력·동의 항목 또는 서식",
      agreement: "확인된 닫기·자료 보기 이외의 동작",
      "unknown-action": "확인된 닫기·자료 보기 이외의 동작",
      "extra-action": "확인된 닫기·자료 보기 이외의 동작",
    };
    expect(status.message).toContain(reasons[condition]);
    expect(fixture.noticeConfirmation.click).not.toHaveBeenCalled();
    expect(fixture.menuOpener.click).not.toHaveBeenCalled();
  });

  it.each(["container", "locator"])(
    "본문과 확인 버튼 영역이 달라 %s에서 버튼이 없으면 고정 사유를 표시한다",
    async (missingAt) => {
      const { fixture, id } = await noticeFixture();
      if (missingAt === "container")
        fixture.noticeData.actions = fixture.noticeData.actions.filter(
          (action) => action.text !== "확인",
        );
      else fixture.fields.noticeConfirmationCount = 0;
      const status = await resumeVentureSession(id);
      expect(status.message).toContain(
        "본문은 일치하지만 같은 안내 영역에서 확인 버튼을 찾지 못했습니다",
      );
      expect(status.message).not.toContain(knownNoticeBody);
      expect(fixture.noticeConfirmation.click).not.toHaveBeenCalled();
    },
  );

  it("최초 로그인 표시를 확인하기 전에는 안내문이 정확해도 자동 닫지 않는다", async () => {
    const { fixture, id } = await mobileHomeFixture();
    fixture.navigate(ventureinUrls.application);
    fixture.fields.noticeTitleCount = 1;
    expect((await resumeVentureSession(id)).state).toBe("awaiting_auth");
    expect(fixture.noticeConfirmation.click).not.toHaveBeenCalled();
  });

  it.each(["?step=2", "#notice", "/other"])(
    "공지 주소가 %s 만큼 달라지면 자동 닫지 않는다",
    async (suffix) => {
      const { fixture, id } = await noticeFixture();
      fixture.navigate(`${ventureinUrls.application}${suffix}`);
      await resumeVentureSession(id);
      expect(fixture.noticeConfirmation.click).not.toHaveBeenCalled();
      expect(fixture.noticeContainer.evaluate).not.toHaveBeenCalled();
    },
  );

  it("한 신청 화면 검사에서 공지가 다시 나타나도 확인을 두 번 누르지 않는다", async () => {
    const { fixture, id } = await noticeFixture();
    fixture.menuCloser.click.mockImplementation(async () => {
      fixture.fields.mobileMenuExpanded = false;
      fixture.fields.noticeTitleCount = 1;
    });
    await expect(inspectVentureApplication(id, "current")).rejects.toMatchObject({
      code: "VENTURE_SCREEN_UNAVAILABLE",
    });
    expect(fixture.noticeConfirmation.click).toHaveBeenCalledTimes(1);
    expect(collectScreen).not.toHaveBeenCalled();
  });

  it.each(["navigation-before", "close-before", "navigation-after", "close-after", "failure"])(
    "공지 처리 중 %s 발생 시 추가 동작과 성공 판정을 중단한다",
    async (condition) => {
      const { fixture, id } = await noticeFixture();
      const change = () =>
        condition.startsWith("close")
          ? fixture.closeWindow()
          : fixture.navigate(`${ventureinUrls.application}?changed=1`);
      if (condition.endsWith("before"))
        fixture.noticeContainer.evaluate.mockImplementationOnce(async () => {
          change();
          return fixture.noticeData;
        });
      else
        fixture.noticeConfirmation.click.mockImplementationOnce(async () => {
          if (condition === "failure") throw new Error(`private ${account().password}`);
          change();
        });
      const status = await resumeVentureSession(id);
      expect(status.state).toBe(condition.startsWith("close") ? "stopped" : "awaiting_auth");
      expect(fixture.noticeConfirmation.click).toHaveBeenCalledTimes(
        condition.endsWith("before") ? 0 : 1,
      );
      expect(fixture.menuOpener.click).not.toHaveBeenCalled();
      expect(JSON.stringify(status)).not.toContain(account().password);
      if (condition === "failure")
        expect(status.message).toContain("안내 확인 버튼 클릭을 완료하지 못했습니다");
    },
  );

  it("공지가 상위 다섯 요소 안에 없으면 더 넓은 본문을 탐색하지 않는다", async () => {
    const { fixture, id } = await noticeFixture();
    fixture.noticeData.text = "안내사항";
    const status = await resumeVentureSession(id);
    expect(status.message).toContain("안내 영역이 허용된 탐색 범위를 벗어났습니다");
    expect(fixture.noticeContainer.evaluate).toHaveBeenCalledTimes(5);
    expect(fixture.noticeConfirmation.click).not.toHaveBeenCalled();
  });

  it.each(["text", "controls"])(
    "확인 버튼을 찾는 동안 공지의 %s가 바뀌면 누르지 않는다",
    async (change) => {
      const { fixture, id } = await noticeFixture();
      fixture.noticeConfirmation.count.mockImplementationOnce(async () => {
        if (change === "text") fixture.noticeData.text += " 동의합니다.";
        else fixture.noticeData.unsafe = true;
        return 1;
      });
      await resumeVentureSession(id);
      expect(fixture.noticeConfirmation.click).not.toHaveBeenCalled();
      expect(fixture.menuOpener.click).not.toHaveBeenCalled();
    },
  );

  it.each(["BODY", "HTML", "MAIN", "FORM"])(
    "공지 후보가 %s이면 내용 읽기 전에 멈춘다",
    async (tagName) => {
      const { fixture, id } = await noticeFixture();
      fixture.noticeContainer.evaluate.mockImplementation(async (read) => {
        const element = {
          tagName,
          get innerText() {
            throw new Error("Broad scope must not be read");
          },
        };
        return read(element as unknown as HTMLElement) as typeof fixture.noticeData;
      });
      await resumeVentureSession(id);
      expect(fixture.noticeContainer.evaluate).toHaveBeenCalledTimes(1);
      expect(fixture.noticeConfirmation.click).not.toHaveBeenCalled();
    },
  );

  it("입력 요소가 든 공지 후보는 본문이나 입력 내용을 읽기 전에 거부한다", async () => {
    const { fixture, id } = await noticeFixture();
    fixture.noticeContainer.evaluate.mockImplementation(async (read) => {
      const element = {
        tagName: "DIV",
        querySelectorAll: () => [],
        closest: () => null,
        matches: () => false,
        querySelector: () => ({ tagName: "TEXTAREA" }),
        get innerText() {
          throw new Error("Unverified editable content must not be read");
        },
      };
      return read(element as unknown as HTMLElement) as typeof fixture.noticeData;
    });
    await resumeVentureSession(id);
    expect(fixture.noticeContainer.evaluate).toHaveBeenCalledTimes(1);
    expect(fixture.noticeConfirmation.click).not.toHaveBeenCalled();
  });

  it("공지 확인이 진행 중일 때 중복 상태 확인은 두 번째 클릭을 시작하지 않는다", async () => {
    const { fixture, id } = await noticeFixture();
    let release: (() => void) | undefined;
    fixture.noticeConfirmation.click.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            fixture.fields.noticeTitleCount = 0;
            resolve();
          };
        }),
    );
    const pending = resumeVentureSession(id);
    await vi.waitFor(() => expect(fixture.noticeConfirmation.click).toHaveBeenCalledTimes(1));
    await resumeVentureSession(id);
    expect(fixture.noticeConfirmation.click).toHaveBeenCalledTimes(1);
    release?.();
    expect((await pending).state).toBe("connected_unmapped");
  });

  it("공식 신청 화면 검사는 고정 주소로 한 번 이동한 뒤 현재 창의 메타데이터만 읽는다", async () => {
    const { fixture, id } = await authenticatedFixture();
    fixture.page.goto.mockImplementation(async () => {
      fixture.navigate(ventureinUrls.application);
      return null;
    });
    const result = await inspectVentureApplication(id, "application");
    expect(result.screen.id).toBe("inspection-test");
    expect(result.sessionStartedAt).toBe(getVentureSession(id).startedAt);
    expect(fixture.page.goto).toHaveBeenCalledTimes(2);
    expect(fixture.page.goto).toHaveBeenLastCalledWith(ventureinUrls.application, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    expect(collectScreen).toHaveBeenCalledExactlyOnceWith(fixture.page);
    expect(fixture.loginId.fill).toHaveBeenCalledTimes(1);
    expect(fixture.password.fill).toHaveBeenCalledTimes(1);
    expect(fixture.loginButton.click).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("현재 화면 검사는 다시 이동하거나 로그인하지 않는다", async () => {
    const { fixture, id } = await authenticatedFixture();
    fixture.navigate(ventureinUrls.application);
    await inspectVentureApplication(id, "current");
    expect(fixture.page.goto).toHaveBeenCalledTimes(1);
    expect(fixture.loginButton.click).toHaveBeenCalledTimes(1);
    expect(collectScreen).toHaveBeenCalledExactlyOnceWith(fixture.page);
  });

  it.each(["missing", "logged-out", "closed", "external", "auth"])(
    "%s 세션의 공식 화면을 수집하지 않는다",
    async (condition) => {
      const { fixture, id } = await authenticatedFixture();
      if (condition === "logged-out") fixture.fields.logoutVisible = false;
      if (condition === "closed") fixture.closeWindow();
      if (condition === "external") fixture.navigate("https://attacker.test/venturein/aply");
      if (condition === "auth") fixture.navigate(ventureinUrls.login);
      await expect(
        inspectVentureApplication(condition === "missing" ? caseId() : id, "current"),
      ).rejects.toMatchObject({ status: 409 });
      expect(collectScreen).not.toHaveBeenCalled();
      expect(fixture.loginButton.click).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["navigation", "closed"])(
    "수집 도중 %s 발생 시 그 결과를 반환하지 않는다",
    async (condition) => {
      const { fixture, id } = await authenticatedFixture();
      collectScreen.mockImplementationOnce(async () => {
        if (condition === "closed") fixture.closeWindow();
        else fixture.navigate("https://www.smes.go.kr/venturein/changed");
        return { id: "stale-snapshot" };
      });
      await expect(inspectVentureApplication(id, "current")).rejects.toMatchObject({
        code: "VENTURE_SCREEN_CHANGED",
      });
      expect(fixture.loginButton.click).toHaveBeenCalledTimes(1);
    },
  );

  it("수집 오류는 비밀을 노출하지 않고 작업 잠금을 해제한다", async () => {
    const { id } = await authenticatedFixture();
    collectScreen.mockRejectedValueOnce(new Error(`private ${account().password}`));
    await expect(inspectVentureApplication(id, "current")).rejects.toMatchObject({
      code: "VENTURE_INSPECTION_FAILED",
      message: "공식 화면 정보를 읽지 못했습니다. 열린 Edge 창의 안내를 확인해 주세요.",
    });
    expect((await inspectVentureApplication(id, "current")).screen.id).toBe("inspection-test");
  });

  it("수집 중 두 번째 검사는 거부하고 완료 후 잠금을 해제한다", async () => {
    const { id } = await authenticatedFixture();
    let release: ((value: { id: string }) => void) | undefined;
    collectScreen.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = inspectVentureApplication(id, "current");
    await vi.waitFor(() => expect(collectScreen).toHaveBeenCalledTimes(1));
    await expect(inspectVentureApplication(id, "current")).rejects.toMatchObject({
      code: "VENTURE_BUSY",
    });
    release?.({ id: "first" });
    await pending;
    expect((await inspectVentureApplication(id, "current")).screen.id).toBe("inspection-test");
  });

  it("로컬 미리보기는 현재 뷰포트 바이트만 반환하고 파일 경로나 계정 동작을 사용하지 않는다", async () => {
    const { fixture, id } = await authenticatedFixture();
    fixture.navigate(ventureinUrls.application);
    const image = await previewVentureApplication(
      id,
      getVentureSession(id).startedAt!,
      ventureinUrls.application,
    );
    expect(image).toEqual(Buffer.from([137, 80, 78, 71]));
    expect(fixture.page.screenshot).toHaveBeenCalledExactlyOnceWith({
      type: "png",
      fullPage: false,
      timeout: 10_000,
      mask: [fixture.authenticationFields, fixture.authenticationFields],
      maskColor: "#000000",
    });
    expect(fixture.page.goto).toHaveBeenCalledTimes(1);
    expect(fixture.loginButton.click).toHaveBeenCalledTimes(1);
    expect(collectScreen).not.toHaveBeenCalled();
  });

  it.each([
    "missing",
    "stale-session",
    "closed",
    "logged-out",
    "different-path",
    "external",
    "login",
    "setup",
    "auth-input",
  ])("%s 상태에서는 미리보기 캡처를 시작하지 않는다", async (condition) => {
    const { fixture, id } = await authenticatedFixture();
    fixture.navigate(ventureinUrls.application);
    const startedAt = getVentureSession(id).startedAt!;
    if (condition === "closed") fixture.closeWindow();
    if (condition === "logged-out") fixture.fields.logoutVisible = false;
    if (condition === "different-path") fixture.navigate("https://www.smes.go.kr/venturein/other");
    if (condition === "external") fixture.navigate("https://attacker.test/venturein/aply/v2");
    if (condition === "login") fixture.navigate(ventureinUrls.login);
    if (condition === "setup") fixture.navigate(ventureinUrls.securityInstall);
    if (condition === "auth-input") fixture.fields.authenticationVisibleCount = 1;
    await expect(
      previewVentureApplication(
        condition === "missing" ? caseId() : id,
        condition === "stale-session" ? "older-session" : startedAt,
        ventureinUrls.application,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(fixture.page.screenshot).not.toHaveBeenCalled();
  });

  it.each(["navigation", "closed"])(
    "인증 입력 검사 중 %s 발생 시 미리보기 촬영 전에 중단한다",
    async (condition) => {
      const { fixture, id } = await authenticatedFixture();
      fixture.navigate(ventureinUrls.application);
      fixture.authenticationFields.count.mockImplementationOnce(async () => {
        if (condition === "closed") fixture.closeWindow();
        else fixture.navigate(ventureinUrls.login);
        return 0;
      });
      await expect(
        previewVentureApplication(id, getVentureSession(id).startedAt!, ventureinUrls.application),
      ).rejects.toMatchObject({ code: "VENTURE_SCREEN_CHANGED" });
      expect(fixture.page.screenshot).not.toHaveBeenCalled();
    },
  );

  it.each(["navigation", "auth-input"])(
    "촬영 도중 %s 발생 시 이미지를 반환하지 않는다",
    async (condition) => {
      const { fixture, id } = await authenticatedFixture();
      fixture.navigate(ventureinUrls.application);
      fixture.page.screenshot.mockImplementationOnce(async () => {
        if (condition === "navigation") fixture.navigate(`${ventureinUrls.application}?changed=1`);
        else fixture.fields.authenticationVisibleCount = 1;
        return Buffer.from([137, 80, 78, 71]);
      });
      await expect(
        previewVentureApplication(id, getVentureSession(id).startedAt!, ventureinUrls.application),
      ).rejects.toMatchObject({
        code: condition === "navigation" ? "VENTURE_SCREEN_CHANGED" : "AUTHENTICATION_SCREEN",
      });
    },
  );

  it("미리보기 오류는 비밀을 노출하지 않고 다음 요청을 허용한다", async () => {
    const { fixture, id } = await authenticatedFixture();
    fixture.navigate(ventureinUrls.application);
    fixture.page.screenshot.mockRejectedValueOnce(new Error(`private ${account().password}`));
    await expect(
      previewVentureApplication(id, getVentureSession(id).startedAt!, ventureinUrls.application),
    ).rejects.toMatchObject({
      code: "VENTURE_PREVIEW_FAILED",
      message: "공식 화면 미리보기를 만들지 못했습니다. 현재 화면을 다시 읽어 주세요.",
    });
    await expect(
      previewVentureApplication(id, getVentureSession(id).startedAt!, ventureinUrls.application),
    ).resolves.toBeInstanceOf(Buffer);
  });

  it.each([
    ["name", "password"],
    ["id", "otpCode"],
    ["title", "인증번호"],
    ["placeholder", "비밀번호"],
    ["aria-label", "보안문자"],
    ["name", "csrfToken"],
  ])(
    "미리보기는 text형 인증 입력도 값 읽기 없이 %s=%s 메타데이터로 거부한다",
    async (attribute, content) => {
      const { fixture, id } = await authenticatedFixture();
      fixture.navigate(ventureinUrls.application);
      const control = {
        getAttribute: (name: string) => (name === attribute ? content : null),
        labels: [],
        get value() {
          throw new Error("Field values must never be read");
        },
      } as unknown as Element;
      fixture.authenticationFields.evaluateAll.mockImplementationOnce(async (read, source) =>
        read([control], source),
      );
      await expect(
        previewVentureApplication(id, getVentureSession(id).startedAt!, ventureinUrls.application),
      ).rejects.toMatchObject({ code: "AUTHENTICATION_SCREEN" });
      expect(fixture.page.screenshot).not.toHaveBeenCalled();
    },
  );

  it("대기 14분 후 처음 확인한 로그인에만 15분을 주고 나중 검사로 만료를 연장하지 않는다", async () => {
    vi.useFakeTimers();
    const fixture = browserFixture();
    const id = caseId();
    launch.mockResolvedValue(fixture.browser);
    await startVentureSession(id, account());
    const startedAt = getVentureSession(id).startedAt;
    await vi.advanceTimersByTimeAsync(14 * 60 * 1000);
    fixture.fields.idVisible = false;
    fixture.fields.passwordVisible = false;
    fixture.fields.logoutVisible = true;
    fixture.navigate(ventureinUrls.application);
    expect((await resumeVentureSession(id)).state).toBe("connected_unmapped");
    expect(getVentureSession(id).startedAt).toBe(startedAt);
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(getVentureSession(id).state).toBe("connected_unmapped");
    expect(fixture.browser.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(13 * 60 * 1000);
    await resumeVentureSession(id);
    await inspectVentureApplication(id, "current");
    await previewVentureApplication(id, startedAt!, ventureinUrls.application);
    fixture.fields.logoutVisible = false;
    await resumeVentureSession(id);
    fixture.fields.logoutVisible = true;
    await resumeVentureSession(id);
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(getVentureSession(id).state).toBe("stopped");
    expect(fixture.browser.close).toHaveBeenCalledTimes(1);
    expect(getVentureSession(id).startedAt).toBe(startedAt);
  });

  async function innovationFixture() {
    const result = await authenticatedFixture();
    result.fixture.fields.innovationLinkCount = 1;
    result.fixture.page.goto.mockImplementation(async () => {
      result.fixture.navigate(ventureinUrls.application);
      return null;
    });
    return result;
  }

  it("카드 클릭 뒤 늦게 뜨는 공지를 기다리며 재클릭과 중복 검사를 시작하지 않는다", async () => {
    const { fixture, id } = await innovationFixture();
    let reveal: (() => void) | undefined;
    fixture.innovationChoice.click.mockImplementationOnce(async () => {
      fixture.fields.logoutVisible = false;
      fixture.fields.mobileLogoutVisible = true;
    });
    fixture.noticeTitle.waitFor.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          reveal = () => {
            fixture.fields.noticeTitleCount = 1;
            resolve();
          };
        }),
    );
    fixture.noticeConfirmation.click.mockImplementationOnce(async () => {
      fixture.fields.noticeTitleCount = 0;
      fixture.navigate(`${ventureinUrls.application}/viewVniaBfrv?unknown=private-value`);
    });
    const pending = inspectVentureApplication(id, "innovation");
    await vi.waitFor(() => expect(fixture.noticeTitle.waitFor).toHaveBeenCalledTimes(1));
    expect(collectScreen).not.toHaveBeenCalled();
    expect(fixture.noticeConfirmation.click).not.toHaveBeenCalled();
    await expect(inspectVentureApplication(id, "innovation")).rejects.toMatchObject({
      code: "VENTURE_BUSY",
    });
    reveal?.();
    await pending;
    expect(fixture.innovationChoice.click).toHaveBeenCalledTimes(1);
    expect(fixture.noticeConfirmation.click).toHaveBeenCalledTimes(1);
    expect(fixture.noticeTitle.waitFor).toHaveBeenCalledWith({ state: "visible", timeout: 3_000 });
    expect(collectScreen).toHaveBeenCalledExactlyOnceWith(fixture.page);
  });

  it("카드에서 바로 이동한 사전확인 문서의 준비 뒤에 로그인 상태를 확인한다", async () => {
    const { fixture, id } = await innovationFixture();
    fixture.innovationChoice.click.mockImplementationOnce(async () => {
      fixture.fields.logoutVisible = false;
      fixture.navigate(`${ventureinUrls.application}/viewVniaBfrv?unknown=private-value`);
    });
    fixture.page.waitForURL.mockImplementationOnce(async () => {
      fixture.fields.logoutVisible = true;
    });
    await inspectVentureApplication(id, "innovation");
    expect(fixture.page.waitForURL).toHaveBeenCalledWith(expect.any(Function), {
      waitUntil: "commit",
      timeout: 3_000,
    });
    expect(fixture.innovationChoice.click).toHaveBeenCalledTimes(1);
    expect(collectScreen).toHaveBeenCalledExactlyOnceWith(fixture.page);
  });

  it.each(["timeout", "unknown-path", "external", "closed"])(
    "카드 클릭 뒤 읽기 준비 대기 중 %s이면 다시 누르거나 화면을 수집하지 않는다",
    async (condition) => {
      const { fixture, id } = await innovationFixture();
      fixture.innovationChoice.click.mockImplementationOnce(async () => {});
      fixture.page.waitForURL.mockImplementationOnce(async () => {
        if (condition === "timeout") throw new Error("Readiness timeout");
        if (condition === "unknown-path") fixture.navigate(`${ventureinUrls.application}/unknown`);
        if (condition === "external")
          fixture.navigate("https://attacker.test/venturein/aply/v2/viewVniaBfrv");
        if (condition === "closed") fixture.closeWindow();
      });
      await expect(inspectVentureApplication(id, "innovation")).rejects.toMatchObject({
        code: "VENTURE_INNOVATION_UNAVAILABLE",
      });
      expect(fixture.innovationChoice.click).toHaveBeenCalledTimes(1);
      expect(fixture.noticeConfirmation.click).not.toHaveBeenCalled();
      expect(collectScreen).not.toHaveBeenCalled();
    },
  );

  it.each(["", "?unknown=private-value#section"])(
    "혁신성장 카드 뒤 공지 확인으로 사전확인 화면%s에 도착하면 카드나 확인을 반복하지 않는다",
    async (suffix) => {
      const { fixture, id } = await innovationFixture();
      fixture.innovationChoice.click.mockImplementationOnce(async () => {
        fixture.fields.noticeTitleCount = 1;
      });
      fixture.noticeConfirmation.click.mockImplementationOnce(async () => {
        fixture.fields.noticeTitleCount = 0;
        fixture.navigate(`${ventureinUrls.application}/viewVniaBfrv${suffix}`);
      });
      await inspectVentureApplication(id, "innovation");
      expect(fixture.page.goto).toHaveBeenCalledTimes(2);
      expect(fixture.innovationChoice.click).toHaveBeenCalledTimes(1);
      expect(fixture.noticeConfirmation.click).toHaveBeenCalledTimes(1);
      expect(fixture.page.url()).toBe(`${ventureinUrls.application}/viewVniaBfrv${suffix}`);
      expect(collectScreen).toHaveBeenCalledExactlyOnceWith(fixture.page);
    },
  );

  it.each(["application", "innovation"] as const)(
    "정확한 유형 선택 주소의 %s 검사는 화면을 다시 불러오지 않는다",
    async (destination) => {
      const { fixture, id } = await innovationFixture();
      fixture.navigate(ventureinUrls.application);
      fixture.page.goto.mockImplementation(async () => {
        fixture.fields.logoutVisible = false;
        return null;
      });
      await inspectVentureApplication(id, destination);
      expect(fixture.page.goto).toHaveBeenCalledTimes(1);
      expect(getVentureSession(id).state).toBe("connected_unmapped");
      expect(fixture.innovationChoice.click).toHaveBeenCalledTimes(
        destination === "innovation" ? 1 : 0,
      );
      expect(collectScreen).toHaveBeenCalledExactlyOnceWith(fixture.page);
      expect(fixture.loginButton.click).toHaveBeenCalledTimes(1);
      expect(fixture.loginId.fill).toHaveBeenCalledTimes(1);
      expect(fixture.password.fill).toHaveBeenCalledTimes(1);
    },
  );

  it.each(
    (["application", "innovation"] as const).flatMap((destination) =>
      ["?step=2", "#step2", "/other"].map((suffix) => ({ destination, suffix })),
    ),
  )(
    "$destination 검사는 원본 주소가 $suffix 만큼 다르면 고정 주소로 이동한다",
    async ({ destination, suffix }) => {
      const { fixture, id } = await innovationFixture();
      fixture.navigate(`${ventureinUrls.application}${suffix}`);
      await inspectVentureApplication(id, destination);
      expect(fixture.page.goto).toHaveBeenCalledTimes(2);
      expect(fixture.page.goto).toHaveBeenLastCalledWith(ventureinUrls.application, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
      expect(collectScreen).toHaveBeenCalledExactlyOnceWith(fixture.page);
    },
  );

  it.each(["application", "innovation"] as const)(
    "정확한 유형 선택 주소라도 로그아웃 표시를 잃으면 %s 검사를 진행하지 않는다",
    async (destination) => {
      const { fixture, id } = await innovationFixture();
      fixture.navigate(ventureinUrls.application);
      fixture.fields.logoutVisible = false;
      await expect(inspectVentureApplication(id, destination)).rejects.toMatchObject({
        code: "VENTURE_NOT_CONNECTED",
      });
      expect(fixture.page.goto).toHaveBeenCalledTimes(1);
      expect(fixture.innovationChoice.click).not.toHaveBeenCalled();
      expect(collectScreen).not.toHaveBeenCalled();
    },
  );

  it.each(["#", "javascript:void(0);", "/venturein/aply/v2/innovation"])(
    "공식 유형 선택에서 확인된 혁신성장 바로가기만 한 번 누른다: %s",
    async (href) => {
      const { fixture, id } = await innovationFixture();
      fixture.fields.innovationHref = href;
      await inspectVentureApplication(id, "innovation");
      expect(fixture.innovationChoice.click).toHaveBeenCalledExactlyOnceWith({ timeout: 15_000 });
      expect(fixture.page.goto).toHaveBeenLastCalledWith(
        ventureinUrls.application,
        expect.any(Object),
      );
      expect(fixture.loginButton.click).toHaveBeenCalledTimes(1);
      expect(collectScreen).toHaveBeenCalledExactlyOnceWith(fixture.page);
    },
  );

  it.each(["missing", "ambiguous", "wrong-label", "external-href", "empty-href", "wrong-page"])(
    "유형 선택의 %s 조건에서는 클릭하거나 수집하지 않는다",
    async (condition) => {
      const { fixture, id } = await innovationFixture();
      if (condition === "missing") fixture.fields.innovationLinkCount = 0;
      if (condition === "ambiguous") fixture.fields.innovationLinkCount = 2;
      if (condition === "wrong-label") fixture.fields.innovationText = "예비벤처유형 바로가기";
      if (condition === "external-href")
        fixture.fields.innovationHref = "https://attacker.test/venturein/aply";
      if (condition === "empty-href") fixture.fields.innovationHref = "";
      if (condition === "wrong-page")
        fixture.page.goto.mockImplementation(async () => {
          fixture.navigate("https://www.smes.go.kr/venturein/other");
          return null;
        });
      await expect(inspectVentureApplication(id, "innovation")).rejects.toMatchObject({
        code: "VENTURE_INNOVATION_UNAVAILABLE",
      });
      expect(fixture.innovationChoice.click).not.toHaveBeenCalled();
      expect(collectScreen).not.toHaveBeenCalled();
    },
  );

  it("유형 링크 검사 중 페이지가 바뀌면 클릭을 시작하지 않는다", async () => {
    const { fixture, id } = await innovationFixture();
    fixture.innovationChoice.getAttribute.mockImplementationOnce(async () => {
      fixture.navigate("https://attacker.test/venturein/aply");
      return "#";
    });
    await expect(inspectVentureApplication(id, "innovation")).rejects.toMatchObject({
      code: "VENTURE_INNOVATION_UNAVAILABLE",
    });
    expect(fixture.innovationChoice.click).not.toHaveBeenCalled();
    expect(collectScreen).not.toHaveBeenCalled();
  });

  it("제목과 바로가기 링크가 분리된 혁신성장 카드도 정확한 제목과 단일 링크로 한정한다", async () => {
    const { fixture, id } = await innovationFixture();
    fixture.fields.innovationLinkCount = 0;
    fixture.fields.innovationTitleCount = 1;
    await inspectVentureApplication(id, "innovation");
    expect(fixture.page.getByText).toHaveBeenCalledWith("혁신성장유형", { exact: true });
    expect(fixture.innovationChoice.click).toHaveBeenCalledTimes(1);
    expect(collectScreen).toHaveBeenCalledTimes(1);
  });

  it.each(["duplicate-title", "multiple-links", "other-types", "body-ancestor"])(
    "분리된 카드의 %s 모호성이 있으면 클릭하지 않는다",
    async (condition) => {
      const { fixture, id } = await innovationFixture();
      fixture.fields.innovationLinkCount = 0;
      fixture.fields.innovationTitleCount = condition === "duplicate-title" ? 2 : 1;
      if (condition === "multiple-links") fixture.fields.innovationCardLinks = 2;
      if (condition === "other-types") fixture.fields.innovationCardOtherTypes = 1;
      if (condition === "body-ancestor") fixture.fields.innovationCardTag = "BODY";
      await expect(inspectVentureApplication(id, "innovation")).rejects.toMatchObject({
        code: "VENTURE_INNOVATION_UNAVAILABLE",
      });
      expect(fixture.innovationChoice.click).not.toHaveBeenCalled();
      expect(collectScreen).not.toHaveBeenCalled();
    },
  );

  it("유형 선택 뒤 외부 화면이나 인증 화면으로 이동하면 자료를 읽지 않는다", async () => {
    const { fixture, id } = await innovationFixture();
    fixture.innovationChoice.click.mockImplementationOnce(async () => {
      fixture.navigate("https://attacker.test/venturein/aply");
    });
    await expect(inspectVentureApplication(id, "innovation")).rejects.toMatchObject({
      code: "VENTURE_INNOVATION_UNAVAILABLE",
    });
    expect(collectScreen).not.toHaveBeenCalled();
  });

  async function textInputFixture() {
    const { fixture, id } = await authenticatedFixture();
    fixture.navigate(`${ventureinUrls.application}/viewVniaBfrv?opaque=fixture`);
    collectScreen.mockResolvedValue({
      id: "approved-input",
      observedAt: new Date().toISOString(),
      url: `${ventureinUrls.application}/viewVniaBfrv`,
      title: "신청 화면",
      companyEvidence: [
        { kind: "businessNumber", label: "사업자등록번호", value: "1234567890", source: "table" },
      ],
      fields: [
        {
          key: "field-1",
          kind: "input",
          id: "capital",
          name: "capital",
          type: "text",
          labels: ["자본금"],
          required: true,
          maxLength: 100,
          accept: null,
          multiple: false,
          disabled: false,
          readOnly: false,
          options: [],
        },
      ],
      truncated: false,
      warnings: [],
    });
    const inspected = await inspectVentureApplication(id, "current");
    const input = {
      snapshot: inspected.screen,
      sessionStartedAt: inspected.sessionStartedAt!,
      businessNumber: "1234567890",
      fields: [{ fieldKey: "field-1", value: "100" }],
    };
    applyText.mockImplementation(
      async (_page, _input, current: () => void, verify: () => Promise<void>) => {
        current();
        await verify();
        current();
        return {
          status: "completed",
          completedFieldKeys: ["field-1"],
          attemptedFieldKey: null,
          code: null,
        };
      },
    );
    return { fixture, id, input };
  }

  async function comparisonFixture() {
    const result = await textInputFixture();
    compareInputs.mockImplementation(
      async (
        _page,
        _input,
        current: () => void,
        verify: () => Promise<void>,
        finalize: () => void,
      ) => {
        current();
        await verify();
        finalize();
        await verify();
        current();
        return {
          status: "completed",
          code: null,
          observedAt: new Date().toISOString(),
          fields: [{ fieldKey: "field-1", kind: "text", state: "matched", code: null }],
        };
      },
    );
    return { ...result, input: { ...result.input, attachments: [] } };
  }

  it("읽기 대조는 정확한 문서에서만 동작하며 입력·메뉴·공지·이동을 재실행하지 않는다", async () => {
    const { fixture, id, input } = await comparisonFixture();
    const before = {
      goto: fixture.page.goto.mock.calls.length,
      menu: fixture.menuOpener.click.mock.calls.length,
      notice: fixture.noticeConfirmation.click.mock.calls.length,
      login: fixture.loginButton.click.mock.calls.length,
      id: fixture.loginId.fill.mock.calls.length,
    };
    const finalized = vi.fn();
    expect(await compareVentureApplication(id, input, () => {}, finalized)).toMatchObject({
      status: "completed",
      fields: [{ fieldKey: "field-1", state: "matched" }],
    });
    expect(finalized).toHaveBeenCalledOnce();
    expect(fixture.page.goto).toHaveBeenCalledTimes(before.goto);
    expect(fixture.menuOpener.click).toHaveBeenCalledTimes(before.menu);
    expect(fixture.noticeConfirmation.click).toHaveBeenCalledTimes(before.notice);
    expect(fixture.loginButton.click).toHaveBeenCalledTimes(before.login);
    expect(fixture.loginId.fill).toHaveBeenCalledTimes(before.id);
    expect(applyText).not.toHaveBeenCalled();
  });

  it.each(["missing", "session", "snapshot", "legacy", "expired"])(
    "대조의 %s 연결·binding 검증 실패는 조회 전에 거부한다",
    async (kind) => {
      const { id, input } = await comparisonFixture();
      if (kind === "session") input.sessionStartedAt = "2000-01-01T00:00:00.000Z";
      if (kind === "snapshot") input.snapshot.id = "different";
      const shared = globalThis as typeof globalThis & {
        __ventureinSessions: Map<string, { textInputTracking?: true; authenticatedAt?: string }>;
      };
      if (kind === "legacy") shared.__ventureinSessions.get(id)!.textInputTracking = undefined;
      if (kind === "expired")
        shared.__ventureinSessions.get(id)!.authenticatedAt = new Date(
          Date.now() - 16 * 60_000,
        ).toISOString();
      expect(
        await compareVentureApplication(kind === "missing" ? caseId() : id, input, () => {}),
      ).toMatchObject({ status: "stopped", fields: [], observedAt: null });
    },
  );

  it.each([
    "query",
    "reload",
    "document",
    "popup",
    "external",
    "login",
    "setup",
    "dialog",
    "closed",
  ])("대조 전 %s 화면 변화는 결과를 반환하지 않는다", async (kind) => {
    const { fixture, id, input } = await comparisonFixture();
    if (kind === "query") fixture.navigate(`${fixture.page.url()}&changed=yes`);
    if (kind === "reload") fixture.navigate(fixture.page.url());
    if (kind === "document") fixture.fields.documentCurrent = false;
    if (kind === "popup") fixture.openPopup();
    if (kind === "external") fixture.navigate("https://external.example/");
    if (kind === "login") fixture.navigate(ventureinUrls.login);
    if (kind === "setup") fixture.navigate(ventureinUrls.securityInstall);
    if (kind === "dialog") fixture.showDialog();
    if (kind === "closed") fixture.closeWindow();
    expect(await compareVentureApplication(id, input, () => {})).toMatchObject({
      status: "stopped",
      fields: [],
    });
  });

  it.each(["logout", "id", "password", "unsafe", "debug", "pwdebug"])(
    "대조도 %s 인증·디버깅 검사를 새로 한다",
    async (kind) => {
      const { fixture, id, input } = await comparisonFixture();
      if (kind === "logout") fixture.fields.logoutVisible = false;
      if (kind === "id") fixture.fields.idVisible = true;
      if (kind === "password") fixture.fields.passwordVisible = true;
      if (kind === "unsafe") fixture.fields.authenticationVisibleCount = 1;
      if (kind === "debug") vi.stubEnv("DEBUG", "pw:api");
      if (kind === "pwdebug") vi.stubEnv("PWDEBUG", "1");
      expect(await compareVentureApplication(id, input, () => {})).toMatchObject({
        status: "stopped",
        fields: [],
      });
    },
  );

  it("원본 최종 재검사 중 문서 변경도 대조 lock이 유지된 채 차단된다", async () => {
    const { fixture, id, input } = await comparisonFixture();
    expect(
      await compareVentureApplication(
        id,
        input,
        () => {},
        () => fixture.navigate(fixture.page.url()),
      ),
    ).toMatchObject({ status: "stopped", fields: [] });
  });

  it("중복 대조·입력을 막고 예외 후 operation lock을 해제한다", async () => {
    const { id, input } = await comparisonFixture();
    let reject: (reason: Error) => void = () => {};
    compareInputs.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const first = compareVentureApplication(id, input, () => {});
    await vi.waitFor(() => expect(compareInputs).toHaveBeenCalledOnce());
    expect(await compareVentureApplication(id, input, () => {})).toMatchObject({
      code: "SESSION_BUSY",
    });
    expect(await fillVentureApplication(id, input, () => {})).toMatchObject({
      code: "SESSION_BUSY",
    });
    reject(new Error("private error text"));
    expect(await first).toMatchObject({ status: "stopped", code: "COMPARE_FAILED", fields: [] });
    expect(await compareVentureApplication(id, input, () => {})).toMatchObject({
      status: "completed",
    });
  });

  it("입력 실행은 같은 문서에서 read-only auth를 검사하며 이동·메뉴·공지·로그인을 재실행하지 않는다", async () => {
    const { fixture, id, input } = await textInputFixture();
    const before = {
      goto: fixture.page.goto.mock.calls.length,
      menu: fixture.menuOpener.click.mock.calls.length,
      notice: fixture.noticeConfirmation.click.mock.calls.length,
      idFill: fixture.loginId.fill.mock.calls.length,
      login: fixture.loginButton.click.mock.calls.length,
    };
    const current = vi.fn();
    expect(await fillVentureApplication(id, input, current)).toMatchObject({
      status: "completed",
      completedFieldKeys: ["field-1"],
    });
    expect(current).toHaveBeenCalled();
    expect(fixture.page.goto).toHaveBeenCalledTimes(before.goto);
    expect(fixture.menuOpener.click).toHaveBeenCalledTimes(before.menu);
    expect(fixture.noticeConfirmation.click).toHaveBeenCalledTimes(before.notice);
    expect(fixture.loginId.fill).toHaveBeenCalledTimes(before.idFill);
    expect(fixture.loginButton.click).toHaveBeenCalledTimes(before.login);
    expect(fixture.page.url()).toContain("?opaque=fixture");
  });

  it.each([
    "missing",
    "different-session",
    "stopped",
    "different-snapshot",
    "uninspected",
    "legacy-session",
  ])("입력 승인과 현재 연결 %s 불일치를 거부한다", async (kind) => {
    const { id, input } = await textInputFixture();
    if (kind === "different-session") input.sessionStartedAt = "2000-01-01T00:00:00.000Z";
    if (kind === "different-snapshot") input.snapshot.id = "old-snapshot";
    if (kind === "stopped") await stopVentureSession(id);
    if (kind === "uninspected" || kind === "legacy-session") {
      const globalSessions = globalThis as typeof globalThis & {
        __ventureinSessions: Map<string, { inspectionBinding?: unknown; textInputTracking?: true }>;
      };
      if (kind === "uninspected")
        globalSessions.__ventureinSessions.get(id)!.inspectionBinding = undefined;
      else globalSessions.__ventureinSessions.get(id)!.textInputTracking = undefined;
    }
    expect(
      await fillVentureApplication(kind === "missing" ? caseId() : id, input, () => {}),
    ).toMatchObject({ status: "stopped", attemptedFieldKey: null });
    expect(applyText).not.toHaveBeenCalled();
  });

  it.each(["query", "same-url-reload", "document", "popup", "external", "login", "setup"])(
    "입력 전 %s 변화는 rawURL·문서 binding으로 차단한다",
    async (kind) => {
      const { fixture, id, input } = await textInputFixture();
      if (kind === "query")
        fixture.navigate(`${ventureinUrls.application}/viewVniaBfrv?opaque=changed`);
      if (kind === "same-url-reload") fixture.navigate(fixture.page.url());
      if (kind === "document") fixture.fields.documentCurrent = false;
      if (kind === "popup") fixture.openPopup();
      if (kind === "external") fixture.navigate("https://attacker.test/");
      if (kind === "login") fixture.navigate(ventureinUrls.login);
      if (kind === "setup") fixture.navigate(ventureinUrls.securityInstall);
      expect(await fillVentureApplication(id, input, () => {})).toMatchObject({
        status: "stopped",
        attemptedFieldKey: null,
      });
    },
  );

  it.each([
    "logout-missing",
    "login-visible",
    "password-visible",
    "authentication-control",
    "debug",
    "pwdebug",
  ])("입력 시 %s 상태를 새로 검사한다", async (kind) => {
    const { fixture, id, input } = await textInputFixture();
    if (kind === "logout-missing") fixture.fields.logoutVisible = false;
    if (kind === "login-visible") fixture.fields.idVisible = true;
    if (kind === "password-visible") fixture.fields.passwordVisible = true;
    if (kind === "authentication-control") fixture.fields.authenticationVisibleCount = 1;
    if (kind === "debug") vi.stubEnv("DEBUG", "pw:api");
    if (kind === "pwdebug") vi.stubEnv("PWDEBUG", "1");
    expect(await fillVentureApplication(id, input, () => {})).toMatchObject({
      status: "stopped",
      attemptedFieldKey: null,
    });
  });

  it("준비 후 승인 자료 변경은 raw error나 값을 노출하지 않는다", async () => {
    const { id, input } = await textInputFixture();
    const result = await fillVentureApplication(id, input, () => {
      throw new Error("SECRET BODY");
    });
    expect(result).toMatchObject({ status: "stopped", code: "INPUT_FAILED" });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("입력 중 중복 실행을 막고 helper 부분 결과를 보존한 뒤 lock을 해제한다", async () => {
    const { id, input } = await textInputFixture();
    let release: (() => void) | undefined;
    const partial = {
      status: "stopped",
      completedFieldKeys: [],
      attemptedFieldKey: "field-1",
      code: "INPUT_FAILED",
    };
    applyText.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return partial;
    });
    const pending = fillVentureApplication(id, input, () => {});
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(await fillVentureApplication(id, input, () => {})).toMatchObject({
      code: "SESSION_BUSY",
    });
    release?.();
    expect(await pending).toEqual(partial);
    expect(await fillVentureApplication(id, input, () => {})).toMatchObject({
      status: "completed",
    });
  });

  it("입력 도중 닫힌 창·dialog·같은 주소 reload는 즉시 중단한다", async () => {
    for (const kind of ["close", "dialog", "reload"]) {
      const { fixture, id, input } = await textInputFixture();
      applyText.mockImplementationOnce(
        async (_page, _input, current: () => void, verify: () => Promise<void>) => {
          await verify();
          if (kind === "close") fixture.closeWindow();
          if (kind === "dialog") fixture.showDialog();
          if (kind === "reload") fixture.navigate(fixture.page.url());
          current();
          throw new Error("Guard must have stopped");
        },
      );
      expect(await fillVentureApplication(id, input, () => {})).toMatchObject({
        status: "stopped",
        attemptedFieldKey: null,
      });
    }
  });

  it("화면을 재조회하면 이전 Document handle을 해제하고 승인 binding을 바꾼다", async () => {
    const { fixture, id, input } = await textInputFixture();
    collectScreen.mockResolvedValue({ ...input.snapshot, id: "newer-screen" });
    await inspectVentureApplication(id, "current");
    expect(fixture.documentHandle.dispose).toHaveBeenCalled();
    expect(await fillVentureApplication(id, input, () => {})).toMatchObject({
      code: "SCREEN_CHANGED",
    });
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
