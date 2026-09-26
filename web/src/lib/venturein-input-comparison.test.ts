import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { File as NodeFile } from "node:buffer";
import { createHash, webcrypto } from "node:crypto";
import type { Page } from "playwright-core";
import type { VentureScreenField, VentureScreenSnapshot } from "./venturein-inspection";

vi.mock("server-only", () => ({}));
const { collect } = vi.hoisted(() => ({ collect: vi.fn() }));
vi.mock("./venturein-inspection-collector", () => ({ collectVentureScreen: collect }));
import {
  compareVentureInputs,
  VentureComparisonError,
  type VentureComparisonInput,
} from "./venturein-input-comparison";

const field = (overrides: Partial<VentureScreenField> = {}): VentureScreenField => ({
  key: "capital",
  id: "capital",
  name: "capital",
  kind: "input",
  type: "text",
  labels: ["자본금"],
  required: false,
  maxLength: 100,
  accept: null,
  multiple: false,
  disabled: false,
  readOnly: false,
  options: [],
  ...overrides,
});
const attachmentField = (overrides: Partial<VentureScreenField> = {}) =>
  field({
    key: "evidence",
    id: "evidence",
    name: "evidence",
    kind: "file",
    type: "file",
    labels: ["증빙자료"],
    maxLength: null,
    accept: ".pdf",
    ...overrides,
  });
const fileBytes = Buffer.from("synthetic approved document");
const expectedFile = {
  name: "approved.pdf",
  mimeType: "application/pdf",
  size: fileBytes.length,
  sha256: createHash("sha256").update(fileBytes).digest("hex"),
};
const file = (bytes = fileBytes) =>
  new NodeFile([bytes], expectedFile.name, { type: expectedFile.mimeType }) as unknown as File;

function fixture(metadata = [field()]) {
  const document = {
    getElementById: () => null,
    querySelectorAll: (() => []) as (selector: string) => object[],
  };
  const url = "https://www.smes.go.kr/venturein/aply/v2/viewVniaBfrv?preserved=yes";
  vi.stubGlobal("document", document);
  vi.stubGlobal("location", { href: url });
  const snapshot: VentureScreenSnapshot = {
    id: "snapshot",
    observedAt: "2026-09-25T00:00:00.000Z",
    url: url.split("?")[0],
    title: "공식 신청 화면",
    companyEvidence: [
      { kind: "businessNumber", label: "사업자등록번호", value: "123-45-67890", source: "table" },
    ],
    fields: metadata,
    truncated: false,
    warnings: [],
  };
  const fresh = structuredClone(snapshot);
  collect.mockImplementation(
    async (_page, guard?: { observations: { object: { isCurrent: () => boolean } }[] }) => {
      if (guard && !guard.observations.every((observation) => observation.object.isCurrent()))
        throw new VentureComparisonError("TARGET_CHANGED");
      return { ...structuredClone(fresh), id: "fresh", observedAt: "2026-09-25T00:01:00.000Z" };
    },
  );
  const controls = metadata.map((meta) => {
    const state = {
      value: "",
      files: [] as File[],
      count: 1,
      visible: true,
      replaced: false,
      attributes: {} as Record<string, string>,
      form: null as object | null,
      selectedCount: 1,
    };
    const reads = vi.fn();
    const node = {
      tagName: meta.kind === "select" ? "SELECT" : meta.kind === "textarea" ? "TEXTAREA" : "INPUT",
      id: meta.id ?? "",
      name: meta.name ?? "",
      type: meta.type,
      required: meta.required,
      maxLength: meta.maxLength ?? -1,
      disabled: false,
      readOnly: false,
      multiple: meta.multiple,
      accept: meta.accept ?? "",
      options: structuredClone(meta.options),
      ownerDocument: document,
      isConnected: true,
      labels: meta.labels.map((innerText) => ({ innerText })),
      get value() {
        reads("value");
        return state.value;
      },
      set value(_value: string) {
        throw new Error("Unexpected DOM mutation");
      },
      get files() {
        reads("files");
        return state.files;
      },
      get selectedOptions() {
        return state.selectedCount ? [{ value: state.value }] : [];
      },
      getAttribute: (name: string) => state.attributes[name] ?? null,
      hasAttribute: (name: string) => name in state.attributes,
      matches: () => false,
      closest: (selector: string) =>
        selector === "form" ? state.form : selector === "td" ? null : state.visible ? null : {},
      getClientRects: () => (state.visible ? [{}] : []),
      dispatchEvent: vi.fn(() => {
        throw new Error("Unexpected event");
      }),
    };
    const observationHandles: { object: unknown; dispose: ReturnType<typeof vi.fn> }[] = [];
    const handle = {
      evaluateHandle: vi.fn(
        async (callback: (element: Element, config: unknown) => unknown, config: unknown) => {
          const object = await callback(node as unknown as Element, config);
          const result = {
            object,
            evaluate: vi.fn(async (read: (value: unknown) => unknown) => read(object)),
            dispose: vi.fn(async () => {}),
          };
          observationHandles.push(result);
          return result;
        },
      ),
      dispose: vi.fn(async () => {}),
    };
    const locator = {
      count: vi.fn(async () => state.count),
      elementHandle: vi.fn(async () => handle),
      fill: vi.fn(),
      click: vi.fn(),
      selectOption: vi.fn(),
      setInputFiles: vi.fn(),
    };
    return { node, state, reads, handle, locator, observationHandles };
  });
  const selector = (value: string) =>
    `"${Array.from(value, (character) => `\\${character.codePointAt(0)!.toString(16)} `).join("")}"`;
  const indexFor = (query: string) =>
    metadata.findIndex(
      (meta) =>
        query === (meta.id ? `[id=${selector(meta.id)}]` : `[name=${selector(meta.name!)}]`),
    );
  document.querySelectorAll = (query) => {
    const control = controls[indexFor(query)];
    return control
      ? Array.from({ length: control.state.count }, () =>
          control.state.replaced ? {} : control.node,
        )
      : [];
  };
  const page = {
    url: vi.fn(() => location.href),
    locator: vi.fn((query: string) => controls[indexFor(query)]?.locator),
    evaluate: vi.fn(
      async (callback: (records: unknown[]) => unknown, records: { object: unknown }[]) =>
        callback(records.map((record) => record.object)),
    ),
    goto: vi.fn(),
  };
  const input: VentureComparisonInput = {
    snapshot,
    sessionStartedAt: "2026-09-25T00:00:00.000Z",
    businessNumber: "1234567890",
    fields: metadata
      .filter((item) => item.kind !== "file")
      .map((item) => ({ fieldKey: item.key, value: "100" })),
    attachments: metadata
      .filter((item) => item.kind === "file")
      .map((item) => ({ fieldKey: item.key, files: [{ ...expectedFile }] })),
  };
  const assertCurrent = vi.fn(() => {});
  const verifyCurrent = vi.fn(async () => {});
  const run = (finalizeCurrent: () => void = () => {}) =>
    compareVentureInputs(
      page as unknown as Page,
      input,
      assertCurrent,
      verifyCurrent,
      finalizeCurrent,
    );
  return { snapshot, fresh, input, controls, page, run, assertCurrent, verifyCurrent };
}
beforeEach(() => {
  collect.mockReset();
  vi.stubGlobal("getComputedStyle", () => ({ display: "block", visibility: "visible" }));
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => vi.unstubAllGlobals());

describe("현재 연결안의 읽기 전용 필드 대조", () => {
  it.each([
    ["100", "matched"],
    ["", "empty"],
    ["  ", "conflict"],
    ["0100", "conflict"],
    ["different-private-value", "conflict"],
  ])("문자열을 정규화하지 않고 %j → %s", async (value, state) => {
    const f = fixture();
    f.controls[0].state.value = value;
    const result = await f.run();
    expect(result).toEqual({
      status: "completed",
      code: null,
      observedAt: expect.any(String),
      fields: [{ fieldKey: "capital", kind: "text", state, code: null }],
    });
    expect(JSON.stringify(result)).not.toContain("different-private-value");
    expect(f.controls[0].node.dispatchEvent).not.toHaveBeenCalled();
    for (const action of ["click", "fill", "selectOption", "setInputFiles"] as const)
      expect(f.controls[0].locator[action]).not.toHaveBeenCalled();
    expect(f.page.goto).not.toHaveBeenCalled();
    expect(f.controls[0].handle.dispose).toHaveBeenCalled();
  });

  it.each([
    ["", 1, "empty"],
    ["", 0, "conflict"],
    ["2", 1, "matched"],
  ] as const)("단일 select %j·선택%d → %s", async (value, selectedCount, state) => {
    const f = fixture([
      field({
        kind: "select",
        type: "select-one",
        maxLength: null,
        options: [
          { label: "선택", value: "", disabled: false },
          { label: "2월", value: "2", disabled: false },
        ],
      }),
    ]);
    f.input.fields[0].value = "2";
    f.controls[0].state.value = value;
    f.controls[0].state.selectedCount = selectedCount;
    // Browser selectedOptions contains stable option elements.
    const selected = selectedCount ? [{ value }] : [];
    Object.defineProperty(f.controls[0].node, "selectedOptions", { get: () => selected });
    expect((await f.run()).fields[0].state).toBe(state);
  });

  it.each(["secret", "consent", "duplicate", "replacement", "disabled", "option", "type"])(
    "위험·변경 대상 %s는 값 읽기 전에 차단한다",
    async (kind) => {
      const f = fixture();
      if (kind === "secret") f.controls[0].state.attributes.title = "인증번호";
      if (kind === "consent") f.controls[0].state.attributes["aria-label"] = "개인정보 동의";
      if (kind === "duplicate") f.controls[0].state.count = 2;
      if (kind === "replacement") f.controls[0].state.replaced = true;
      if (kind === "disabled") f.controls[0].node.disabled = true;
      if (kind === "option") f.controls[0].node.maxLength = 3;
      if (kind === "type") f.controls[0].node.type = "password";
      expect((await f.run()).status).toBe("stopped");
      expect(f.controls[0].reads).not.toHaveBeenCalled();
    },
  );

  it.each(["snapshot", "company", "truncated", "metadata", "auth"])(
    "전체 검증 %s 실패 시 모든 결과를 폐기한다",
    async (change) => {
      const f = fixture();
      if (change === "snapshot") f.input.snapshot.url = "https://external.example/";
      if (change === "company") f.input.businessNumber = "0000000000";
      if (change === "truncated") f.snapshot.truncated = true;
      if (change === "metadata") f.fresh.fields[0].required = true;
      if (change === "auth")
        f.verifyCurrent.mockRejectedValue(new VentureComparisonError("AUTH_UNVERIFIED"));
      expect(await f.run()).toMatchObject({ status: "stopped", fields: [] });
      expect(f.controls[0].reads).not.toHaveBeenCalled();
    },
  );

  it("개별 읽기 예외는 원문 없이 unknown, 전체 guard 실패면 결과를 폐기한다", async () => {
    const f = fixture();
    f.controls[0].handle.evaluateHandle.mockRejectedValue(new Error("private field raw failure"));
    expect(await f.run()).toEqual({
      status: "completed",
      code: null,
      observedAt: expect.any(String),
      fields: [{ fieldKey: "capital", kind: "text", state: "unknown", code: "FIELD_UNREADABLE" }],
    });
    f.verifyCurrent.mockRejectedValue(new VentureComparisonError("SESSION_CHANGED"));
    expect(await f.run()).toMatchObject({ status: "stopped", fields: [] });
  });

  it("마지막 인증 검사 중 앞선 값이 바뀌면 단일 최종 대조에서 폐기한다", async () => {
    const f = fixture();
    f.controls[0].state.value = "100";
    f.verifyCurrent.mockImplementation(async () => {
      if (f.verifyCurrent.mock.calls.length > 1) f.controls[0].state.value = "changed";
    });
    expect(await f.run()).toMatchObject({ status: "stopped", fields: [], code: "TARGET_CHANGED" });
  });

  it.each(["value", "url", "metadata"])(
    "원본 최종 재확인 callback 중 %s 변경도 마지막 관측 전에 차단한다",
    async (kind) => {
      const f = fixture();
      f.controls[0].state.value = "100";
      const result = await f.run(() => {
        if (kind === "value") f.controls[0].state.value = "changed";
        if (kind === "url") Object.assign(location, { href: `${location.href}&changed=1` });
        if (kind === "metadata") f.controls[0].node.required = true;
      });
      expect(result).toMatchObject({ status: "stopped", fields: [], observedAt: null });
    },
  );
});

describe("선택 파일의 읽기 전용 SHA256 대조", () => {
  it.each(["matched", "empty", "content-conflict", "metadata-conflict"])(
    "파일 상태 %s: 현재 파일·해시를 외부에 반환하지 않는다",
    async (state) => {
      const f = fixture([attachmentField()]);
      if (state === "matched") f.controls[0].state.files = [file()];
      if (state === "content-conflict")
        f.controls[0].state.files = [file(Buffer.alloc(fileBytes.length, 65))];
      if (state === "metadata-conflict")
        f.controls[0].state.files = [
          new NodeFile([fileBytes], "other.pdf", { type: "application/pdf" }) as unknown as File,
        ];
      const result = await f.run();
      expect(result.fields[0]).toMatchObject({
        fieldKey: "evidence",
        kind: "file",
        state: state.endsWith("conflict") ? "conflict" : state,
      });
      expect(JSON.stringify(result)).not.toContain(".pdf");
      expect(JSON.stringify(result)).not.toContain(expectedFile.sha256);
      expect(JSON.stringify(f.controls[0].handle.evaluateHandle.mock.calls[0][1])).not.toContain(
        "base64",
      );
      expect(JSON.stringify(f.controls[0].handle.evaluateHandle.mock.calls[0][1])).not.toContain(
        "buffer",
      );
    },
  );

  it("12MiB 초과 현재 파일은 바이트를 읽지 않고 unknown으로 둔다", async () => {
    const f = fixture([attachmentField()]);
    const large = {
      name: "large.pdf",
      type: "application/pdf",
      size: 13 * 1024 * 1024,
      arrayBuffer: vi.fn(),
    };
    f.controls[0].state.files = [large as unknown as File];
    expect((await f.run()).fields[0]).toMatchObject({ state: "unknown", code: "FILE_LIMIT" });
    expect(large.arrayBuffer).not.toHaveBeenCalled();
  });

  it.each(["files", "metadata", "url", "earlier-value"])(
    "파일 읽기 await 동안 %s 변경 시 모든 관측을 폐기한다",
    async (change) => {
      const f = fixture([field(), attachmentField()]);
      f.controls[0].state.value = "100";
      const selected = file();
      f.controls[1].state.files = [selected];
      vi.spyOn(selected, "arrayBuffer").mockImplementation(async () => {
        if (change === "files") f.controls[1].state.files = [file()];
        if (change === "metadata") f.controls[1].node.accept = ".txt";
        if (change === "url") Object.assign(location, { href: `${location.href}&changed=1` });
        if (change === "earlier-value") f.controls[0].state.value = "";
        return Uint8Array.from(fileBytes).buffer;
      });
      expect(await f.run()).toMatchObject({ status: "stopped", fields: [] });
    },
  );

  it("파일 digest await 이후 옵션·readonly 변화도 최종 검증에서 거부한다", async () => {
    const f = fixture([attachmentField()]);
    f.controls[0].state.files = [file()];
    vi.stubGlobal("crypto", {
      subtle: {
        digest: async () => {
          f.controls[0].node.readOnly = true;
          return webcrypto.subtle.digest("SHA-256", fileBytes);
        },
      },
    });
    expect(await f.run()).toMatchObject({ status: "stopped", fields: [] });
  });

  it("파일 API 읽기 실패는 오류 원문 없이 unknown으로 반환한다", async () => {
    const f = fixture([attachmentField()]);
    const selected = file();
    f.controls[0].state.files = [selected];
    vi.spyOn(selected, "arrayBuffer").mockRejectedValue(new Error("sensitive source path"));
    const result = await f.run();
    expect(result.fields[0]).toMatchObject({ state: "unknown", code: "FILE_UNREADABLE" });
    expect(JSON.stringify(result)).not.toContain("sensitive");
  });
});
