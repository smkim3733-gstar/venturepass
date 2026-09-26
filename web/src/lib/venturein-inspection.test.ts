import { afterEach, describe, expect, it, vi } from "vitest";
import type { JSHandle, Page } from "playwright-core";

vi.mock("server-only", () => ({}));
import {
  captureVentureInspectionGuard,
  collectVentureScreen,
} from "./venturein-inspection-collector";
import {
  normalizeVentureBusinessNumber,
  validateVentureScreenSnapshot,
  verifyVentureCompany,
  type VentureScreenSnapshot,
} from "./venturein-inspection";

const applicationUrl = "https://www.smes.go.kr/venturein/aply/v2";
function snapshot(): VentureScreenSnapshot {
  return {
    id: "screen-1",
    observedAt: "2026-09-25T01:00:00.000Z",
    url: applicationUrl,
    title: "신청 정보",
    companyEvidence: [
      { kind: "businessNumber", label: "사업자등록번호", value: "123-45-67890", source: "table" },
    ],
    fields: [],
    truncated: false,
    warnings: [],
  };
}

type FakeElement = {
  tagName: string;
  id: string;
  name: string;
  type: string;
  innerText: string;
  visible: boolean;
  required: boolean;
  disabled: boolean;
  readOnly: boolean;
  maxLength: number;
  accept: string;
  multiple: boolean;
  labels: FakeElement[];
  options: { label: string; value: string; disabled: boolean }[];
  attributes: Record<string, string>;
  controls: FakeElement[];
  nextElementSibling: FakeElement | null;
  previousElementSibling: FakeElement | null;
  cell: FakeElement | null;
  form: FakeElement | null;
  authenticationForm: boolean;
  allowCompanyValue: boolean;
  suppliedValue: string;
  valueReads: number;
  readonly value: string;
  closest: (selector: string) => FakeElement | null;
  getAttribute: (name: string) => string | null;
  getClientRects: () => object[];
  matches: (selector: string) => boolean;
  querySelector: () => object | null;
  querySelectorAll: () => FakeElement[];
};

function element(change: Partial<FakeElement> = {}): FakeElement {
  const value: FakeElement = {
    tagName: "INPUT",
    id: "",
    name: "",
    type: "text",
    innerText: "",
    visible: true,
    required: false,
    disabled: false,
    readOnly: false,
    maxLength: -1,
    accept: "",
    multiple: false,
    labels: [],
    options: [],
    attributes: {},
    controls: [],
    nextElementSibling: null,
    previousElementSibling: null,
    cell: null,
    form: null,
    authenticationForm: false,
    allowCompanyValue: false,
    suppliedValue: "must-not-read",
    valueReads: 0,
    get value() {
      this.valueReads += 1;
      if (!this.allowCompanyValue) throw new Error("Forbidden arbitrary field value read");
      return this.suppliedValue;
    },
    closest(selector) {
      return selector === "form"
        ? this.form
        : selector === "td"
          ? this.cell
          : !this.visible
            ? this
            : null;
    },
    getAttribute(name) {
      return this.attributes[name] ?? null;
    },
    getClientRects() {
      return this.visible ? [{}] : [];
    },
    matches(selector) {
      return selector === ":disabled"
        ? this.disabled
        : selector === '[type="hidden"]' && this.type === "hidden";
    },
    querySelector() {
      return this.authenticationForm ? {} : null;
    },
    querySelectorAll() {
      return this.controls;
    },
  };
  Object.assign(value, change);
  return value;
}

const browserHandleValue = Symbol("browser handle value");
function unwrapBrowserHandles(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (browserHandleValue in value) return value[browserHandleValue];
  if (Array.isArray(value)) return value.map(unwrapBrowserHandles);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, unwrapBrowserHandles(entry)]),
  );
}
function browserHandle<T>(value: T) {
  return {
    [browserHandleValue]: value,
    evaluate: vi.fn(async (read: (value: T, argument: unknown) => unknown, argument?: unknown) =>
      read(value, unwrapBrowserHandles(argument)),
    ),
    dispose: vi.fn(async () => {}),
  };
}

function browserFixture(
  controls: FakeElement[] = [],
  semanticLabels: FakeElement[] = [],
  initialUrl = applicationUrl,
  embedded: FakeElement[] = [],
  actions: FakeElement[] = [],
) {
  let url = initialUrl;
  let closed = false;
  vi.stubGlobal("location", new URL(url));
  const documentFixture = {
    title: "공식 신청 화면",
    querySelectorAll: (selector: string) =>
      selector === "th, dt"
        ? semanticLabels
        : selector === "input, textarea, select"
          ? controls
          : selector === 'a, button, [role="link"], [role="button"]'
            ? actions
            : embedded,
    getElementById: (id: string) =>
      [...controls, ...semanticLabels].find((item) => item.id === id) ?? null,
  };
  vi.stubGlobal("document", documentFixture);
  vi.stubGlobal("getComputedStyle", (node: FakeElement) => ({
    display: node.visible ? "block" : "none",
    visibility: "visible",
  }));
  const evaluate = vi.fn(async (read: (argument: unknown) => unknown, argument: unknown) =>
    read(unwrapBrowserHandles(argument)),
  );
  const evaluateHandle = vi.fn(async (read: (argument: unknown) => unknown, argument: unknown) =>
    browserHandle(read(unwrapBrowserHandles(argument))),
  );
  const page = { url: () => url, isClosed: () => closed, evaluate, evaluateHandle };
  return {
    page: page as unknown as Page,
    evaluate,
    evaluateHandle,
    replaceDocument() {
      vi.stubGlobal("document", { ...documentFixture });
    },
    navigate(next: string) {
      url = next;
      vi.stubGlobal("location", new URL(next));
    },
    close() {
      closed = true;
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("대조용 마지막 기업·로그인·값 관측의 원자성", () => {
  async function atomicFixture() {
    const companyValue = element({ tagName: "TD", innerText: "123-45-67890" });
    const companyLabel = element({
      tagName: "TH",
      innerText: "사업자등록번호",
      nextElementSibling: companyValue,
    });
    const target = element({
      id: "capital",
      name: "capital",
      labels: [element({ tagName: "LABEL", innerText: "자본금" })],
    });
    const logout = element({ tagName: "A", innerText: "로그아웃", attributes: { href: "#" } });
    const fixture = browserFixture([target], [companyLabel], applicationUrl, [], [logout]);
    const initial = await collectVentureScreen(fixture.page);
    const { url, title, companyEvidence, fields, truncated, warnings } = initial;
    const observation = { isCurrent: vi.fn(() => true) };
    const guard = {
      rawUrl: applicationUrl,
      expectedSemantics: JSON.stringify({
        url,
        title,
        companyEvidence,
        fields,
        truncated,
        warnings,
      }),
      observations: [observation as unknown as JSHandle<{ isCurrent: () => boolean }>],
    };
    return { fixture, target, companyValue, logout, observation, guard };
  }

  it("기존 수집 evaluate 한 번 안에서 기업·전체 메타·로그인·관측을 확인한다", async () => {
    const f = await atomicFixture();
    const before = f.fixture.evaluate.mock.calls.length;
    const snapshot = await collectVentureScreen(f.fixture.page, f.guard);
    expect(f.fixture.evaluate).toHaveBeenCalledTimes(before + 1);
    expect(f.observation.isCurrent).toHaveBeenCalledOnce();
    expect(verifyVentureCompany(snapshot, "1234567890").status).toBe("matched");
    expect(Number.isFinite(Date.parse(snapshot.observedAt))).toBe(true);
    expect(f.target.valueReads).toBe(0);
  });

  it.each(["company", "logout", "href", "role", "metadata", "secret", "value", "query"])(
    "직전 검사 뒤 %s만 바뀌어도 성공 관측을 반환하지 않는다",
    async (kind) => {
      const f = await atomicFixture();
      if (kind === "company") f.companyValue.innerText = "987-65-43210";
      if (kind === "logout") f.logout.visible = false;
      if (kind === "href") delete f.logout.attributes.href;
      if (kind === "role") f.logout.attributes.role = "presentation";
      if (kind === "metadata") f.target.required = true;
      if (kind === "secret") f.target.attributes.title = "인증번호";
      if (kind === "value") f.observation.isCurrent.mockReturnValue(false);
      if (kind === "query") f.fixture.navigate(`${applicationUrl}?changed=yes`);
      await expect(collectVentureScreen(f.fixture.page, f.guard)).rejects.toThrow(
        "공식 화면의 표시 항목",
      );
      expect(f.target.valueReads).toBe(0);
    },
  );

  it("옵션 없는 일반 화면 조회에는 로그인·관측 조건을 새로 강제하지 않는다", async () => {
    const f = await atomicFixture();
    f.logout.visible = false;
    const screen = await collectVentureScreen(f.fixture.page);
    expect(screen.fields).toHaveLength(1);
    expect(f.observation.isCurrent).not.toHaveBeenCalled();
  });

  it("쓰기 검증 핸들은 중첩된 관측 핸들을 풀어 사용하고 boolean 이외 자료를 노출하지 않는다", async () => {
    const f = await atomicFixture();
    const observationHandle = browserHandle(f.observation);
    f.guard.observations = [observationHandle as unknown as JSHandle<{ isCurrent: () => boolean }>];
    const handle = await captureVentureInspectionGuard(f.fixture.page, f.guard);
    expect(f.fixture.evaluateHandle).toHaveBeenCalledOnce();
    expect(f.observation.isCurrent).toHaveBeenCalledOnce();
    expect(await handle.evaluate((guard) => Object.keys(guard))).toEqual(["isCurrent"]);
    expect(await handle.evaluate((guard) => guard.isCurrent())).toBe(true);
    expect(await handle.evaluate((guard) => guard.isCurrent())).toBe(true);
    expect(f.observation.isCurrent).toHaveBeenCalledTimes(3);
    expect(f.target.valueReads).toBe(0);
  });

  it.each([
    "company",
    "logout",
    "href",
    "role",
    "metadata",
    "secret",
    "value",
    "query",
    "document",
    "observation-error",
  ])("핸들 생성 후 %s 변경은 동기 검증 false로 차단한다", async (kind) => {
    const f = await atomicFixture();
    const handle = await captureVentureInspectionGuard(f.fixture.page, f.guard);
    if (kind === "company") f.companyValue.innerText = "987-65-43210";
    if (kind === "logout") f.logout.visible = false;
    if (kind === "href") delete f.logout.attributes.href;
    if (kind === "role") f.logout.attributes.role = "presentation";
    if (kind === "metadata") f.target.required = true;
    if (kind === "secret") f.target.attributes.title = "인증번호";
    if (kind === "value") f.observation.isCurrent.mockReturnValue(false);
    if (kind === "query") f.fixture.navigate(`${applicationUrl}?changed=yes`);
    if (kind === "document") f.fixture.replaceDocument();
    if (kind === "observation-error")
      f.observation.isCurrent.mockImplementation(() => {
        throw new Error("private observation must not escape");
      });
    expect(await handle.evaluate((guard) => guard.isCurrent())).toBe(false);
    expect(f.target.valueReads).toBe(0);
  });

  it.each(["company", "logout", "metadata", "value"])(
    "핸들 생성 시 %s 불일치는 사용할 핸들을 반환하지 않는다",
    async (kind) => {
      const f = await atomicFixture();
      if (kind === "company") f.companyValue.innerText = "987-65-43210";
      if (kind === "logout") f.logout.visible = false;
      if (kind === "metadata") f.target.required = true;
      if (kind === "value") f.observation.isCurrent.mockReturnValue(false);
      await expect(captureVentureInspectionGuard(f.fixture.page, f.guard)).rejects.toThrow(
        "공식 화면의 표시 항목",
      );
      expect(f.target.valueReads).toBe(0);
    },
  );

  it.each(["foreign-origin", "query", "closed"])(
    "핸들 생성 전 %s 상태는 DOM 접근 전에 거부한다",
    async (kind) => {
      const f = await atomicFixture();
      if (kind === "foreign-origin") f.fixture.navigate("https://attacker.test/venturein/aply");
      if (kind === "query") f.fixture.navigate(`${applicationUrl}?changed=yes`);
      if (kind === "closed") f.fixture.close();
      await expect(captureVentureInspectionGuard(f.fixture.page, f.guard)).rejects.toThrow(
        "공식 벤처인 신청 화면",
      );
      expect(f.fixture.evaluateHandle).not.toHaveBeenCalled();
    },
  );

  it.each(["navigation", "closed"])(
    "핸들 생성 대기 중 %s 발생 시 만들어진 핸들도 폐기한다",
    async (kind) => {
      const f = await atomicFixture();
      const evaluateHandle = f.fixture.evaluateHandle.getMockImplementation()!;
      const dispose = vi.fn(async () => {});
      f.fixture.evaluateHandle.mockImplementationOnce(async (read, argument) => {
        const handle = await evaluateHandle(read, argument);
        handle.dispose = dispose;
        if (kind === "navigation") f.fixture.navigate(`${applicationUrl}?changed=yes`);
        else f.fixture.close();
        return handle;
      });
      await expect(captureVentureInspectionGuard(f.fixture.page, f.guard)).rejects.toThrow(
        "공식 화면의 표시 항목",
      );
      expect(dispose).toHaveBeenCalledOnce();
    },
  );

  it("브라우저 핸들 오류는 원문 대신 고정 오류로 반환한다", async () => {
    const f = await atomicFixture();
    f.fixture.evaluateHandle.mockRejectedValueOnce(new Error("token=private credential=secret"));
    await expect(captureVentureInspectionGuard(f.fixture.page, f.guard)).rejects.toThrow(
      "공식 화면의 표시 항목을 확인하지 못했습니다. 같은 화면을 유지한 뒤 다시 확인해 주세요.",
    );
  });
});

describe("공식 화면 검사 자료 계약과 기업 일치", () => {
  it.each(["1234567890", "123-45-67890", "123 45 67890"])(
    "10자리 등록번호의 표시 기호만 정규화한다: %s",
    (value) => {
      expect(normalizeVentureBusinessNumber(value)).toBe("1234567890");
    },
  );
  it.each([
    "123-45-*****",
    "123456789",
    "등록번호 1234567890",
    "１２３４５６７８９０",
    "1234567890x",
  ])("부분 일치·가림·유사 숫자는 승인하지 않는다: %s", (value) => {
    expect(normalizeVentureBusinessNumber(value)).toBeNull();
  });
  it("정확한 일치와 불일치를 구분한다", () => {
    expect(verifyVentureCompany(snapshot(), "1234567890").status).toBe("matched");
    expect(verifyVentureCompany(snapshot(), "9876543210").status).toBe("mismatch");
  });
  it.each(["missing", "masked", "ambiguous", "truncated", "invalid-expected"])(
    "%s이면 기업 일치를 확정하지 않는다",
    (condition) => {
      const value = snapshot();
      if (condition === "missing") value.companyEvidence = [];
      if (condition === "masked") value.companyEvidence[0].value = "123-45-*****";
      if (condition === "ambiguous")
        value.companyEvidence.push({ ...value.companyEvidence[0], value: "987-65-43210" });
      if (condition === "truncated") value.truncated = true;
      expect(
        verifyVentureCompany(value, condition === "invalid-expected" ? "" : "1234567890").status,
      ).toBe("unverified");
    },
  );
  it("동일 번호의 중복 표시만 있으면 서로 다른 기업으로 판단하지 않는다", () => {
    const value = snapshot();
    value.companyEvidence.push({
      ...value.companyEvidence[0],
      value: "1234567890",
      source: "input",
    });
    expect(verifyVentureCompany(value, "1234567890").status).toBe("matched");
  });
  it.each([
    "https://attacker.test/venturein/aply",
    `${applicationUrl}?token=secret`,
    `${applicationUrl}#secret`,
    "https://user:secret@www.smes.go.kr/venturein/aply/v2",
    "https://www.smes.go.kr/venturein/auth/viewLogin",
  ])("비공식·인증·정리되지 않은 URL 거부: %s", (url) => {
    expect(() => validateVentureScreenSnapshot({ ...snapshot(), url })).toThrow("수집 범위");
  });
  it("의도하지 않은 필드 값과 비밀 관련 컨트롤을 계약 단계에서도 거부한다", () => {
    const field = {
      key: "field-1",
      kind: "input",
      id: "description",
      name: "description",
      type: "text",
      labels: ["설명"],
      required: false,
      maxLength: null,
      accept: null,
      multiple: false,
      disabled: false,
      readOnly: false,
      options: [],
    };
    expect(() =>
      validateVentureScreenSnapshot({ ...snapshot(), fields: [{ ...field, value: "private" }] }),
    ).toThrow();
    expect(() =>
      validateVentureScreenSnapshot({ ...snapshot(), fields: [{ ...field, name: "csrfToken" }] }),
    ).toThrow();
    expect(() =>
      validateVentureScreenSnapshot({ ...snapshot(), fields: [field, field] }),
    ).toThrow();
  });
});

describe("공식 화면 읽기 전용 수집 — 합성 DOM", () => {
  it("일반 값·비밀·파일명·선택 상태를 읽지 않고 표시된 메타데이터만 수집한다", async () => {
    const label = element({ tagName: "LABEL", innerText: "기술 설명" });
    const ordinary = element({
      id: "description",
      name: "description",
      labels: [label],
      required: true,
      maxLength: 500,
    });
    const file = element({
      type: "file",
      accept: ".pdf,.docx",
      multiple: true,
      attributes: { "aria-label": "증빙 파일" },
    });
    const select = element({
      tagName: "SELECT",
      options: [
        { label: "선택", value: "", disabled: false },
        { label: "혁신성장", value: "C", disabled: false },
      ],
    });
    const hidden = element({ type: "hidden", name: "csrfToken" });
    const password = element({ type: "password" });
    const token = element({ name: "api_key" });
    const invisible = element({ visible: false });
    const { page } = browserFixture([ordinary, file, select, hidden, password, token, invisible]);
    const result = await collectVentureScreen(page);
    expect(result.fields).toHaveLength(3);
    expect(result.fields[0]).toMatchObject({
      labels: ["기술 설명"],
      required: true,
      maxLength: 500,
    });
    expect(result.fields[1]).toMatchObject({ kind: "file", accept: ".pdf,.docx", multiple: true });
    expect(result.fields[2].options).toHaveLength(2);
    expect(
      [ordinary, file, select, hidden, password, token, invisible].every(
        (item) => item.valueReads === 0,
      ),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain("must-not-read");
  });
  it("정확한 표시 레이블에 연결된 고정 기업명·사업자번호 값만 예외적으로 읽는다", async () => {
    const company = element({
      attributes: { "aria-label": "기업명" },
      allowCompanyValue: true,
      suppliedValue: "가상 기업",
      readOnly: true,
    });
    const business = element({
      labels: [element({ tagName: "LABEL", innerText: "사업자등록번호" })],
      allowCompanyValue: true,
      suppliedValue: "123-45-67890",
      disabled: true,
    });
    const near = element({ attributes: { "aria-label": "대표자 기업명 참고" } });
    const { page } = browserFixture([company, business, near]);
    const result = await collectVentureScreen(page);
    expect(result.companyEvidence.map((item) => item.value)).toEqual(["가상 기업", "123-45-67890"]);
    expect(company.valueReads).toBe(1);
    expect(business.valueReads).toBe(1);
    expect(near.valueReads).toBe(0);
    expect(verifyVentureCompany(result, "1234567890").status).toBe("matched");
  });
  it("수정 가능한 기업번호 입력은 기업 일치의 근거로 읽지 않는다", async () => {
    const mutable = element({ attributes: { "aria-label": "사업자등록번호" } });
    const cell = element({ tagName: "TD", controls: [mutable] });
    const heading = element({
      tagName: "TH",
      innerText: "사업자등록번호",
      nextElementSibling: cell,
    });
    cell.previousElementSibling = heading;
    mutable.cell = cell;
    const { page } = browserFixture([mutable], [heading]);
    const result = await collectVentureScreen(page);
    expect(result.fields[0].labels).toContain("사업자등록번호");
    expect(result.companyEvidence).toEqual([]);
    expect(mutable.valueReads).toBe(0);
    expect(verifyVentureCompany(result, "1234567890").status).toBe("unverified");
  });
  it("label이 없는 컨트롤도 title·placeholder·같은 표의 앞선 th로 이름을 안내한다", async () => {
    const titled = element({ attributes: { title: "담당 부서" } });
    const placeholder = element({ attributes: { placeholder: "기술 설명" } });
    const business = element({
      readOnly: true,
      allowCompanyValue: true,
      suppliedValue: "123-45-67890",
    });
    const heading = element({ tagName: "TH", innerText: "사업자번호" });
    const cell = element({ tagName: "TD", previousElementSibling: heading, controls: [business] });
    heading.nextElementSibling = cell;
    business.cell = cell;
    const { page } = browserFixture([titled, placeholder, business], [heading]);
    const result = await collectVentureScreen(page);
    expect(result.fields.map((field) => field.labels)).toEqual([
      ["담당 부서"],
      ["기술 설명"],
      ["사업자번호"],
    ]);
    expect(verifyVentureCompany(result, "1234567890").status).toBe("matched");
    expect(titled.valueReads + placeholder.valueReads).toBe(0);
  });
  it("HTML required가 없는 사전확인 자본금·결산월의 직접 대응 표 제목을 필수 근거로 읽는다", async () => {
    const capital = element({ attributes: { title: "납입자본금 입력" } });
    const month = element({ tagName: "SELECT", attributes: { title: "결산월 선택" } });
    const headings = ["자본금 (주1) * 필수입력", "결산월 * 필수입력"].map((innerText, index) => {
      const control = [capital, month][index];
      const heading = element({ tagName: "TH", innerText });
      const cell = element({ tagName: "TD", previousElementSibling: heading, controls: [control] });
      heading.nextElementSibling = cell;
      control.cell = cell;
      return heading;
    });
    const { page } = browserFixture([capital, month], headings, `${applicationUrl}/viewVniaBfrv`);
    const result = await collectVentureScreen(page);
    expect(result.fields.map((field) => field.required)).toEqual([true, true]);
    expect(result.fields.map((field) => field.labels)).toEqual([
      ["납입자본금 입력", "자본금 (주1) * 필수입력"],
      ["결산월 선택", "결산월 * 필수입력"],
    ]);
    expect(result.warnings).toEqual([]);
    expect(capital.valueReads + month.valueReads).toBe(0);
  });
  it.each([
    ["label", "기술 설명 [필수]"],
    ["aria-label", "결산월 (필수)"],
    ["aria-labelledby", "자본금 ＊ 필수 입력"],
    ["title", "담당자 [ 필수 ]"],
    ["placeholder", "기술 설명 필수입력"],
  ])("연결된 %s의 명확한 필수 표지만 인정한다", async (source, labelText) => {
    const label = element({ tagName: "LABEL", id: "field-label", innerText: labelText });
    const control = element({
      labels: source === "label" ? [label] : [],
      attributes:
        source === "label" ? {} : { [source]: source === "aria-labelledby" ? label.id : labelText },
    });
    const { page } = browserFixture([control], [label]);
    const result = await collectVentureScreen(page);
    expect(result.fields[0].required).toBe(true);
    expect(control.valueReads).toBe(0);
  });
  it.each([
    ["담당 부서 필수 아님", false],
    ["결산월 선택", false],
    ["설명 선택 사항", false],
    ["기술 설명 *", true],
    ["담당자 필수", true],
    ["담당자 * 필수입력 아님", true],
    ["담당자 [필수] 아님", true],
    ["담당자 (필수) 항목이 아닙니다", true],
    ["*필수기술 참고", true],
    ["담당자 [필수] 선택 사항", true],
    ["해당 시 담당자 [필수]", true],
    ["신청하는 경우 담당자 (필수)", true],
  ])("선택·부정·모호한 표시를 필수로 단정하지 않는다: %s", async (labelText, warning) => {
    const control = element({ labels: [element({ tagName: "LABEL", innerText: labelText })] });
    const { page } = browserFixture([control]);
    const result = await collectVentureScreen(page);
    expect(result.fields[0].required).toBe(false);
    expect(result.warnings.some((item) => item.startsWith("AMBIGUOUS_REQUIRED_LABEL:"))).toBe(
      warning,
    );
  });
  it("다른 필드·일반 본문·숨겨진 라벨의 필수 표지를 전파하지 않는다", async () => {
    const heading = element({ tagName: "TH", innerText: "대표자 [필수]" });
    const first = element({ tagName: "TD", previousElementSibling: heading });
    const second = element({ tagName: "TD", previousElementSibling: first });
    const control = element({
      attributes: { title: "선택 부서" },
      labels: [element({ tagName: "LABEL", innerText: "이전 필드 [필수]", visible: false })],
      cell: second,
    });
    second.controls = [control];
    const unrelated = element({ tagName: "TH", innerText: "나머지 내용 [필수]" });
    const fixture = browserFixture([control], [heading, unrelated]);
    const result = await collectVentureScreen(fixture.page);
    expect(result.fields[0].required).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(control.valueReads).toBe(0);
  });
  it("여러 입력이 공유하는 표 제목의 필수 표지는 개별 필수 대신 경고로 남긴다", async () => {
    const heading = element({ tagName: "TH", innerText: "연락처 * 필수입력" });
    const controls = [
      element({ attributes: { title: "전화" } }),
      element({ attributes: { title: "팩스" } }),
    ];
    const cell = element({ tagName: "TD", previousElementSibling: heading, controls });
    controls.forEach((control) => {
      control.cell = cell;
    });
    const { page } = browserFixture(controls, [heading]);
    const result = await collectVentureScreen(page);
    expect(result.fields.map((field) => field.required)).toEqual([false, false]);
    expect(result.warnings.some((item) => item.startsWith("AMBIGUOUS_REQUIRED_LABEL:"))).toBe(true);
    expect(controls.every((control) => control.valueReads === 0)).toBe(true);
  });
  it("명시적인 HTML 필수 속성은 유지하고 동의 필드의 연결된 필수 표지도 경고에 반영한다", async () => {
    const native = element({ required: true, attributes: { title: "기술 설명" } });
    const aria = element({ attributes: { "aria-required": "true", title: "담당 부서" } });
    const agreement = element({
      type: "checkbox",
      labels: [element({ tagName: "LABEL", innerText: "자료 확인 [필수]" })],
    });
    const { page } = browserFixture([native, aria, agreement]);
    const result = await collectVentureScreen(page);
    expect(result.fields.map((field) => field.required)).toEqual([true, true, true]);
    expect(result.warnings.some((item) => item.startsWith("UNSUPPORTED_REQUIRED_CONTROL:"))).toBe(
      true,
    );
    expect([native, aria, agreement].every((control) => control.valueReads === 0)).toBe(true);
  });
  it("표·정의목록에서 정확한 기업 식별 레이블의 직접 대응값만 읽는다", async () => {
    const business = element({
      tagName: "TH",
      innerText: "사업자번호",
      nextElementSibling: element({ tagName: "TD", innerText: "123-45-67890" }),
    });
    const company = element({
      tagName: "DT",
      innerText: "상호",
      nextElementSibling: element({ tagName: "DD", innerText: "가상기업" }),
    });
    const unrelated = element({
      tagName: "TH",
      innerText: "계좌번호",
      nextElementSibling: element({ tagName: "TD", innerText: "must-not-read" }),
    });
    const { page } = browserFixture([], [business, company, unrelated]);
    const result = await collectVentureScreen(page);
    expect(result.companyEvidence).toHaveLength(2);
    expect(result.companyEvidence.map((item) => item.source)).toEqual(["table", "definition"]);
    expect(JSON.stringify(result)).not.toContain("must-not-read");
  });
  it("인증 폼의 일반 입력도 포함하지 않는다", async () => {
    const form = element({ tagName: "FORM", authenticationForm: true });
    const control = element({ name: "company", attributes: { "aria-label": "기업명" }, form });
    const { page } = browserFixture([control]);
    expect((await collectVentureScreen(page)).fields).toEqual([]);
    expect(control.valueReads).toBe(0);
  });
  it("동의·선택 컨트롤은 값이나 체크 여부를 읽지 않고 메타데이터와 필수 여부 경고만 남긴다", async () => {
    const required = element({ type: "checkbox", required: true });
    const optional = element({ type: "radio" });
    const { page } = browserFixture([required, optional]);
    const result = await collectVentureScreen(page);
    expect(result.fields.map((field) => field.type)).toEqual(["checkbox", "radio"]);
    expect(result.warnings.some((item) => item.startsWith("UNSUPPORTED_REQUIRED_CONTROL:"))).toBe(
      true,
    );
    expect(required.valueReads + optional.valueReads).toBe(0);
  });
  it("수집된 URL에서는 query·fragment를 제거한다", async () => {
    const { page } = browserFixture([], [], `${applicationUrl}?token=private#secret`);
    const result = await collectVentureScreen(page);
    expect(result.url).toBe(applicationUrl);
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("150개 필드 한도를 넘으면 잘림을 표시하고 기업 일치를 승인하지 않는다", async () => {
    const { page } = browserFixture(Array.from({ length: 151 }, () => element()));
    const result = await collectVentureScreen(page);
    expect(result.fields).toHaveLength(150);
    expect(result.truncated).toBe(true);
    expect(verifyVentureCompany(result, "1234567890").status).toBe("unverified");
  });
  it("선택지 수집 한도 초과를 표시한다", async () => {
    const select = element({
      tagName: "SELECT",
      options: Array.from({ length: 101 }, (_, index) => ({
        label: String(index),
        value: String(index),
        disabled: false,
      })),
    });
    const { page } = browserFixture([select]);
    const result = await collectVentureScreen(page);
    expect(result.fields[0].options).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(select.valueReads).toBe(0);
  });
  it.each(["IFRAME", "DIV"])(
    "표시된 외부 프레임·별도 편집 영역은 완전한 검사로 처리하지 않는다: %s",
    async (tagName) => {
      const { page } = browserFixture([], [], applicationUrl, [element({ tagName })]);
      const result = await collectVentureScreen(page);
      expect(result.truncated).toBe(true);
      expect(
        result.warnings.some((warning) => warning.startsWith("UNINSPECTED_EMBEDDED_CONTROL:")),
      ).toBe(true);
    },
  );
  it.each([
    "https://attacker.test/venturein/aply",
    "https://www.smes.go.kr/venturein/auth/viewLogin",
    "https://www.smes.go.kr/venturein/resources/raonnx/install/install.html",
  ])("%s 화면은 DOM을 읽기 전에 거부한다", async (url) => {
    const fixture = browserFixture([], [], url);
    await expect(collectVentureScreen(fixture.page)).rejects.toThrow("공식 벤처인 신청 화면");
    expect(fixture.evaluate).not.toHaveBeenCalled();
  });
  it.each(["navigation", "closed", "error"])(
    "수집 중 %s 발생 시 원문·비밀을 노출하지 않고 실패한다",
    async (condition) => {
      const fixture = browserFixture();
      fixture.evaluate.mockImplementationOnce(async (read, argument) => {
        if (condition === "error") throw new Error("token=private credential=secret");
        const result = read(argument);
        if (condition === "closed") fixture.close();
        else fixture.navigate("https://attacker.test/venturein/aply");
        return result;
      });
      await expect(collectVentureScreen(fixture.page)).rejects.toThrow("공식 화면의 표시 항목");
    },
  );
});
