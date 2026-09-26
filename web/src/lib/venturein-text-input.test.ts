import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { File as NodeFile } from "node:buffer";
import { webcrypto } from "node:crypto";
import type { Page } from "playwright-core";
import type { VentureScreenField, VentureScreenSnapshot } from "./venturein-inspection";

vi.mock("server-only", () => ({}));
const { collect, captureGuard } = vi.hoisted(() => ({ collect: vi.fn(), captureGuard: vi.fn() }));
vi.mock("./venturein-inspection-collector", () => ({
  collectVentureScreen: collect,
  captureVentureInspectionGuard: captureGuard,
}));
import {
  applyVentureTextInput,
  VentureTextInputError,
  type VentureTextInput,
} from "./venturein-text-input";

function field(overrides: Partial<VentureScreenField> = {}): VentureScreenField {
  return {
    key: "field-1",
    kind: "input",
    id: "capital",
    name: "capital",
    type: "text",
    labels: ["자본금"],
    required: true,
    maxLength: 200,
    accept: null,
    multiple: false,
    disabled: false,
    readOnly: false,
    options: [],
    ...overrides,
  };
}
function fileList(files: File[] = []) {
  return Object.assign([...files], { item: (index: number) => files[index] ?? null });
}
function fileField(overrides: Partial<VentureScreenField> = {}) {
  return field({
    kind: "file",
    type: "file",
    id: "evidence",
    name: "evidence",
    labels: ["사업 자료"],
    maxLength: null,
    accept: ".pdf",
    ...overrides,
  });
}
function fixture(fields = [field()]) {
  const dom = {
    getElementById: () => null,
    querySelectorAll: (() => []) as (selector: string) => object[],
  };
  vi.stubGlobal("document", dom);
  vi.stubGlobal("location", { href: "https://www.smes.go.kr/venturein/aply/v2/viewVniaBfrv" });
  const snapshot: VentureScreenSnapshot = {
    id: "approved-snapshot",
    observedAt: "2026-09-25T00:00:00.000Z",
    url: "https://www.smes.go.kr/venturein/aply/v2/viewVniaBfrv",
    title: "신청 화면",
    companyEvidence: [
      { kind: "businessNumber", label: "사업자등록번호", value: "123-45-67890", source: "table" },
    ],
    fields,
    truncated: false,
    warnings: [],
  };
  const fresh = structuredClone(snapshot);
  const guardState = { authenticated: true };
  const semantics = () => {
    const { url, title, companyEvidence, fields, truncated, warnings } = fresh;
    return JSON.stringify({ url, title, companyEvidence, fields, truncated, warnings });
  };
  type Observation = { isCurrent: () => boolean };
  type Guard = { expectedSemantics: string; observations: Observation[] };
  const guardValid = (guard: Guard) =>
    guardState.authenticated &&
    semantics() === guard.expectedSemantics &&
    guard.observations.every((item) => item.isCurrent());
  const wrap = <T>(value: T) =>
    Object.assign(value as object, {
      evaluate: vi.fn(async (fn: (item: T) => unknown) => fn(value)),
      dispose: vi.fn(async () => {}),
    });
  captureGuard.mockImplementation(async (_page, guard: Guard) => {
    if (!guardValid(guard)) throw new Error("Synthetic context changed");
    return wrap({ isCurrent: () => guardValid(guard) });
  });
  collect.mockImplementation(async (_page, guard?: Guard) => {
    if (guard && !guardValid(guard)) throw new Error("Synthetic atomic guard changed");
    return { ...structuredClone(fresh), id: "fresh", observedAt: "2026-09-25T00:01:00.000Z" };
  });
  const controls = fields.map((metadata) => {
    let value = "";
    let files = fileList();
    const state = {
      count: 1,
      visible: true,
      form: null as null | object,
      valueReads: 0,
      attributes: {} as Record<string, string>,
      replaced: false,
    };
    const node = {
      tagName:
        metadata.kind === "textarea" ? "TEXTAREA" : metadata.kind === "select" ? "SELECT" : "INPUT",
      id: metadata.id || "",
      name: metadata.name || "",
      type: metadata.type,
      disabled: metadata.disabled,
      readOnly: metadata.readOnly,
      multiple: metadata.multiple,
      accept: metadata.accept ?? "",
      maxLength: metadata.maxLength ?? -1,
      required: metadata.required,
      options: structuredClone(metadata.options),
      isConnected: true,
      labels: metadata.labels.map((innerText) => ({ innerText })),
      ownerDocument: dom,
      nativeWrite: vi.fn((next: string) => {
        value = next;
      }),
      nativeFilesWrite: vi.fn((next: ReturnType<typeof fileList>) => {
        files = next;
      }),
      dispatchEvent: vi.fn<(event: Event) => boolean>(() => true),
      get value() {
        state.valueReads += 1;
        return value;
      },
      get selectedOptions() {
        return node.options.filter((option) => option.value === value);
      },
      get files() {
        return files;
      },
      getAttribute: (attribute: string) => state.attributes[attribute] || null,
      hasAttribute: (attribute: string) => attribute in state.attributes,
      closest: (selector: string) =>
        selector === "form" ? state.form : selector === "td" ? null : state.visible ? null : {},
      matches: () => false,
      getClientRects: () => (state.visible ? [{}] : []),
    };
    const handle = {
      evaluate: vi.fn(async (read: (element: Element, arg: unknown) => unknown, arg: unknown) =>
        read(node as unknown as Element, arg),
      ),
      evaluateHandle: vi.fn(
        async (read: (element: Element, arg: unknown) => unknown, arg: unknown) =>
          wrap(await read(node as unknown as Element, arg)),
      ),
      dispose: vi.fn(async () => {}),
    };
    const locator = {
      count: vi.fn(async () => state.count),
      elementHandle: vi.fn(async () => handle),
    };
    return {
      node,
      state,
      locator,
      handle,
      write: node.nativeWrite,
      filesWrite: node.nativeFilesWrite,
      setFiles: (next: File[]) => {
        files = fileList(next);
      },
      getFiles: () => files,
      setValue: (next: string) => {
        value = next;
      },
      getValue: () => value,
    };
  });
  const page = {
    url: () => snapshot.url,
    locator: vi.fn((selector: string) => {
      const attribute = selector.startsWith("[id=") ? "id" : "name";
      const match = selector.match(/="(.*)"\]/);
      const identity = match?.[1].replace(/\\([0-9a-f]+) /g, (_, hex) =>
        String.fromCodePoint(Number.parseInt(hex, 16)),
      );
      const index = fields.findIndex((candidate) => candidate[attribute] === identity);
      if (index < 0) throw new Error("Unknown synthetic target");
      return controls[index].locator;
    }),
  };
  dom.querySelectorAll = (selector: string) => {
    const locator = page.locator(selector);
    const control = controls.find((candidate) => candidate.locator === locator)!;
    return control.state.count === 1
      ? [control.state.replaced ? {} : control.node]
      : Array.from({ length: control.state.count }, () => ({}));
  };
  const input: VentureTextInput = {
    snapshot,
    sessionStartedAt: "2026-09-25T00:00:00.000Z",
    businessNumber: "1234567890",
    fields: fields.map((item) => ({
      fieldKey: item.key,
      value: item.kind === "select" ? "12" : "검토한 내용",
    })),
  };
  const current = vi.fn(() => {});
  const auth = vi.fn(async () => {});
  const run = () => applyVentureTextInput(page as unknown as Page, input, current, auth);
  return { input, fresh, controls, page, current, auth, guardState, run };
}

beforeEach(() => {
  collect.mockReset();
  captureGuard.mockReset();
  vi.stubGlobal("getComputedStyle", () => ({ display: "block", visibility: "visible" }));
  class NativeControl {
    nativeWrite!: (value: string) => void;
    nativeFilesWrite!: (files: ReturnType<typeof fileList>) => void;
    set value(value: string) {
      this.nativeWrite(value);
    }
    set files(files: ReturnType<typeof fileList>) {
      this.nativeFilesWrite(files);
    }
  }
  vi.stubGlobal("HTMLInputElement", NativeControl);
  vi.stubGlobal("HTMLTextAreaElement", NativeControl);
  vi.stubGlobal("HTMLSelectElement", NativeControl);
  vi.stubGlobal("File", NodeFile);
  vi.stubGlobal("crypto", webcrypto);
  class SyntheticDataTransfer {
    private list: File[] = [];
    items = {
      add: (file: File) => {
        this.list.push(file);
      },
    };
    get files() {
      return fileList(this.list);
    }
  }
  vi.stubGlobal("DataTransfer", SyntheticDataTransfer);
});
afterEach(() => vi.unstubAllGlobals());

function attachmentFixture(fields = [fileField()]) {
  const result = fixture(fields);
  result.input.fields = result.input.fields.filter(
    (mapping) => fields.find((field) => field.key === mapping.fieldKey)?.kind !== "file",
  );
  result.input.attachments = fields
    .filter((field) => field.kind === "file")
    .map((field) => ({
      fieldKey: field.key,
      files: [
        {
          name: "approved.pdf",
          mimeType: "application/pdf",
          buffer: Buffer.from("approved fixture bytes"),
        },
      ],
    }));
  return result;
}

describe("최초 텍스트·첨부의 동기 회사·인증 보호 — 가상 DOM", () => {
  function normalFixture(kind: "text" | "file", multiple = false) {
    return kind === "file"
      ? attachmentFixture(
          multiple
            ? [fileField(), fileField({ key: "file-2", id: "second", name: "second" })]
            : undefined,
        )
      : fixture(
          multiple ? [field(), field({ key: "field-2", id: "second", name: "second" })] : undefined,
        );
  }
  it.each(["text", "file"] as const)(
    "%s 최초 실행도 문맥 guard를 사용하며 정상 값·FileList 할당은 허용한다",
    async (kind) => {
      const f = normalFixture(kind);
      expect(f.input.preserveFieldKeys).toBeUndefined();
      expect(await f.run()).toMatchObject({
        status: "completed",
        completedFieldKeys: ["field-1"],
        touchedFieldKeys: ["field-1"],
      });
      expect(captureGuard).toHaveBeenCalledOnce();
      expect(captureGuard.mock.calls[0][1].observations).toEqual([]);
      expect(
        kind === "file" ? f.controls[0].filesWrite : f.controls[0].write,
      ).toHaveBeenCalledOnce();
    },
  );
  it.each([
    ["text", "company"],
    ["text", "logout"],
    ["file", "company"],
    ["file", "logout"],
  ] as const)(
    "%s 최초 쓰기의 마지막 await 뒤 %s 변경은 setter 0회로 거부한다",
    async (kind, change) => {
      const f = normalFixture(kind);
      const evaluate = f.controls[0].handle.evaluate.getMockImplementation()!;
      f.controls[0].handle.evaluate.mockImplementation(async (read, arg) => {
        const config = arg as { writeValue?: string | null; writeFiles?: unknown[] | null };
        if (config.writeValue || config.writeFiles) {
          if (change === "company") f.fresh.companyEvidence[0].value = "987-65-43210";
          else f.guardState.authenticated = false;
        }
        return evaluate(read, arg);
      });
      expect(await f.run()).toMatchObject({
        status: "stopped",
        code: "PRESERVED_TARGET_CHANGED",
        completedFieldKeys: [],
        touchedFieldKeys: ["field-1"],
        attemptedFieldKey: "field-1",
      });
      expect(f.controls[0].write).not.toHaveBeenCalled();
      expect(f.controls[0].filesWrite).not.toHaveBeenCalled();
      expect(f.controls[0].node.dispatchEvent).not.toHaveBeenCalled();
    },
  );
  it.each(["company", "logout"])(
    "첨부 payload 생성 중 %s 변경도 native FileList setter 직전에 거부한다",
    async (change) => {
      const f = normalFixture("file");
      const decode = globalThis.atob;
      vi.stubGlobal("atob", (value: string) => {
        if (change === "company") f.fresh.companyEvidence[0].value = "987-65-43210";
        else f.guardState.authenticated = false;
        return decode(value);
      });
      expect(await f.run()).toMatchObject({
        status: "stopped",
        code: "PRESERVED_TARGET_CHANGED",
        completedFieldKeys: [],
        touchedFieldKeys: ["field-1"],
      });
      expect(f.controls[0].filesWrite).not.toHaveBeenCalled();
      expect(f.controls[0].node.dispatchEvent).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["text", "input", "company"],
    ["text", "change", "company"],
    ["text", "input", "logout"],
    ["text", "change", "logout"],
    ["file", "input", "company"],
    ["file", "change", "company"],
    ["file", "input", "logout"],
    ["file", "change", "logout"],
  ] as const)(
    "%s 최초 실행의 %s 이벤트에서 %s 변경 시 후속 이벤트·필드를 중단한다",
    async (kind, eventName, change) => {
      const f = normalFixture(kind, true);
      f.controls[0].node.dispatchEvent.mockImplementation((event) => {
        if (event.type === eventName) {
          if (change === "company") f.fresh.companyEvidence[0].value = "987-65-43210";
          else f.guardState.authenticated = false;
        }
        return true;
      });
      expect(await f.run()).toMatchObject({
        status: "stopped",
        code: "PRESERVED_TARGET_CHANGED",
        completedFieldKeys: [],
        touchedFieldKeys: ["field-1"],
        attemptedFieldKey: "field-1",
      });
      expect(
        kind === "file" ? f.controls[0].filesWrite : f.controls[0].write,
      ).toHaveBeenCalledOnce();
      expect(f.controls[0].node.dispatchEvent.mock.calls.map(([event]) => event.type)).toEqual(
        eventName === "input" ? ["input"] : ["input", "change"],
      );
      expect(f.controls[1].write).not.toHaveBeenCalled();
      expect(f.controls[1].filesWrite).not.toHaveBeenCalled();
    },
  );
  it.each(["text", "file"] as const)(
    "%s 최초 실행의 동기 이벤트에서 문서가 바뀌면 추가 이벤트를 보내지 않는다",
    async (kind) => {
      const f = normalFixture(kind, true);
      f.controls[0].node.dispatchEvent.mockImplementation(() => {
        vi.stubGlobal("document", { ...document });
        return true;
      });
      expect(await f.run()).toMatchObject({
        status: "stopped",
        code: "TARGET_CHANGED",
        completedFieldKeys: [],
        touchedFieldKeys: ["field-1"],
      });
      expect(f.controls[0].node.dispatchEvent.mock.calls.map(([event]) => event.type)).toEqual([
        "input",
      ]);
      expect(f.controls[1].write).not.toHaveBeenCalled();
      expect(f.controls[1].filesWrite).not.toHaveBeenCalled();
    },
  );
});

describe("최초 실행 완료 직전의 원자적 전체 대조 — 가상 DOM", () => {
  it("뒤 파일의 최종 해시 중 앞 값까지 변경되면 임시 완료 후보를 남기지 않는다", async () => {
    const f = attachmentFixture([field(), fileField({ key: "file-2" })]);
    let digests = 0;
    vi.stubGlobal("crypto", {
      subtle: {
        digest: async (algorithm: string, bytes: BufferSource) => {
          const hash = await webcrypto.subtle.digest(algorithm, bytes);
          if (++digests === 2) {
            f.controls[0].setValue("CHANGED_DURING_LAST_CAPTURE");
            f.controls[1].setFiles([]);
          }
          return hash;
        },
      },
    });
    expect(await f.run()).toEqual({
      status: "stopped",
      completedFieldKeys: [],
      touchedFieldKeys: ["field-1", "file-2"],
      attemptedFieldKey: "file-2",
      code: "FILE_UNCONFIRMED",
    });
  });

  const changes = [
    "text",
    "select-value",
    "select-option",
    "files-empty",
    "files-replaced",
    "files-reordered",
    "target-replaced",
    "document-replaced",
  ] as const;
  it.each(
    changes.flatMap((change) =>
      ["final-auth", "final-collector"].map((timing) => ({ change, timing })),
    ),
  )("$timing에서 $change 변경은 완료 목록을 복원하지 않는다", async ({ change, timing }) => {
    const isFile = change.startsWith("files-");
    const f = isFile
      ? attachmentFixture([fileField({ multiple: true })])
      : change.startsWith("select-")
        ? fixture([
            field({
              kind: "select",
              type: "select-one",
              maxLength: null,
              options: [
                { label: "선택", value: "", disabled: false },
                { label: "12월", value: "12", disabled: false },
                { label: "11월", value: "11", disabled: false },
              ],
            }),
          ])
        : fixture();
    if (change === "files-reordered")
      f.input.attachments![0].files.push({
        name: "second.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("second approved bytes"),
      });
    const control = f.controls[0];
    let changed = false;
    const mutate = () => {
      if (changed || !control.handle.evaluateHandle.mock.calls.length) return;
      changed = true;
      if (change === "text" || change === "select-value")
        control.setValue(change === "text" ? "AFTER_FINAL_READBACK" : "11");
      if (change === "select-option") control.node.options[1] = { ...control.node.options[1] };
      if (change === "files-empty") control.setFiles([]);
      if (change === "files-replaced")
        control.setFiles(
          f.input.attachments![0].files.map(
            (file) => new File([Uint8Array.from(file.buffer)], file.name, { type: file.mimeType }),
          ),
        );
      if (change === "files-reordered") control.setFiles([...control.getFiles()].reverse());
      if (change === "target-replaced") control.state.replaced = true;
      if (change === "document-replaced") vi.stubGlobal("document", { ...document });
    };
    if (timing === "final-auth") f.auth.mockImplementation(async () => mutate());
    else {
      const originalCollect = collect.getMockImplementation()!;
      collect.mockImplementation(async (page, guard) => {
        if (guard?.observations.length > 1) mutate();
        return originalCollect(page, guard);
      });
    }
    const result = await f.run();
    expect(changed).toBe(true);
    expect(result).toMatchObject({
      status: "stopped",
      completedFieldKeys: [],
      touchedFieldKeys: ["field-1"],
      attemptedFieldKey: "field-1",
    });
    expect(isFile ? control.filesWrite : control.write).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toMatch(/AFTER_FINAL_READBACK|approved\.pdf|approved bytes/);
  });

  it.each(["replacement", "metadata", "reorder"])(
    "마지막 파일 capture 해시 await 중 %s 변경도 완료를 거부한다",
    async (change) => {
      const f = attachmentFixture([fileField({ multiple: true })]);
      f.input.attachments![0].files.push({
        name: "second.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("second approved bytes"),
      });
      let digests = 0;
      vi.stubGlobal("crypto", {
        subtle: {
          digest: async (algorithm: string, bytes: BufferSource) => {
            const hash = await webcrypto.subtle.digest(algorithm, bytes);
            if (++digests === 3) {
              if (change === "replacement")
                f.controls[0].setFiles(
                  f.input.attachments![0].files.map(
                    (file) =>
                      new File([Uint8Array.from(file.buffer)], file.name, { type: file.mimeType }),
                  ),
                );
              if (change === "metadata")
                f.controls[0].state.attributes["aria-label"] = "변경된 자료";
              if (change === "reorder")
                f.controls[0].setFiles([...f.controls[0].getFiles()].reverse());
            }
            return hash;
          },
        },
      });
      expect(await f.run()).toMatchObject({
        status: "stopped",
        completedFieldKeys: [],
        touchedFieldKeys: ["field-1"],
        attemptedFieldKey: "field-1",
        code: "FILE_UNCONFIRMED",
      });
      expect(f.controls[0].filesWrite).toHaveBeenCalledOnce();
    },
  );
});

describe("새 승인 텍스트 복구의 지속 보호 — 가상 DOM", () => {
  function recoveryFixture() {
    const f = fixture([
      field(),
      field({
        key: "field-2",
        id: "description",
        name: "description",
        kind: "textarea",
        type: "textarea",
      }),
      field({ key: "field-3", id: "market", name: "market" }),
    ]);
    f.input.preserveFieldKeys = ["field-1"];
    f.controls[0].setValue(f.input.fields[0].value);
    return f;
  }

  it("기존 일치 값에는 setter·event를 보내지 않고 새 입력만 완료·시도 목록에 남긴다", async () => {
    const f = recoveryFixture();
    expect(await f.run()).toEqual({
      status: "completed",
      completedFieldKeys: ["field-2", "field-3"],
      touchedFieldKeys: ["field-2", "field-3"],
      attemptedFieldKey: null,
      code: null,
    });
    expect(f.controls[0].write).not.toHaveBeenCalled();
    expect(f.controls[0].node.dispatchEvent).not.toHaveBeenCalled();
    expect(f.controls[1].write).toHaveBeenCalledTimes(1);
    expect(f.controls[2].write).toHaveBeenCalledTimes(1);
    expect(captureGuard).toHaveBeenCalledTimes(1);
  });

  it.each(["value", "label", "node", "hidden", "readonly", "company", "logout"])(
    "마지막 await 뒤 보호 %s 변경은 같은 평가의 setter 직전 차단한다",
    async (kind) => {
      const f = recoveryFixture();
      const evaluate = f.controls[1].handle.evaluate.getMockImplementation()!;
      f.controls[1].handle.evaluate.mockImplementation(async (read, arg) => {
        if ((arg as { writeValue?: string }).writeValue) {
          if (kind === "value") f.controls[0].setValue("수동 변경");
          if (kind === "label") f.controls[0].node.labels[0].innerText = "다른 항목";
          if (kind === "node") f.controls[0].state.replaced = true;
          if (kind === "hidden") f.controls[0].state.visible = false;
          if (kind === "readonly") f.controls[0].node.readOnly = true;
          if (kind === "company") f.fresh.companyEvidence[0].value = "987-65-43210";
          if (kind === "logout") f.guardState.authenticated = false;
        }
        return evaluate(read, arg);
      });
      expect(await f.run()).toMatchObject({
        status: "stopped",
        code: "PRESERVED_TARGET_CHANGED",
        completedFieldKeys: [],
        touchedFieldKeys: ["field-2"],
      });
      for (const control of f.controls) expect(control.write).not.toHaveBeenCalled();
    },
  );

  it("입력 이벤트가 보호값을 지우면 다음 이벤트·필드 입력을 멈추고 시도 근거를 보존한다", async () => {
    const f = recoveryFixture();
    f.controls[1].node.dispatchEvent.mockImplementation(() => {
      f.controls[0].setValue("");
      return true;
    });
    expect(await f.run()).toMatchObject({
      status: "stopped",
      code: "PRESERVED_TARGET_CHANGED",
      touchedFieldKeys: ["field-2"],
      completedFieldKeys: [],
    });
    expect(f.controls[1].node.dispatchEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "input",
    ]);
    expect(f.controls[2].write).not.toHaveBeenCalled();
    expect(f.controls[0].write).not.toHaveBeenCalled();
  });

  it("이번에 쓴 값도 다음 입력부터 보호한다", async () => {
    const f = recoveryFixture();
    const evaluate = f.controls[2].handle.evaluate.getMockImplementation()!;
    f.controls[2].handle.evaluate.mockImplementation(async (read, arg) => {
      if ((arg as { writeValue?: string }).writeValue) f.controls[1].setValue("");
      return evaluate(read, arg);
    });
    expect(await f.run()).toMatchObject({
      status: "stopped",
      code: "PRESERVED_TARGET_CHANGED",
      touchedFieldKeys: ["field-2", "field-3"],
    });
    expect(f.controls[1].write).toHaveBeenCalledTimes(1);
    expect(f.controls[2].write).not.toHaveBeenCalled();
  });

  it("일치 선택값을 보존하며 optgroup 비활성화 시 후속 입력을 차단한다", async () => {
    const f = fixture([
      field({
        kind: "select",
        type: "select-one",
        maxLength: null,
        options: [{ label: "12월", value: "12", disabled: false }],
      }),
      field({ key: "field-2", id: "next", name: "next" }),
    ]);
    f.input.preserveFieldKeys = ["field-1"];
    f.controls[0].setValue("12");
    const group = { tagName: "OPTGROUP", disabled: false };
    Object.assign(f.controls[0].node.options[0], { parentElement: group });
    const evaluate = f.controls[1].handle.evaluate.getMockImplementation()!;
    f.controls[1].handle.evaluate.mockImplementation(async (read, arg) => {
      if ((arg as { writeValue?: string }).writeValue) group.disabled = true;
      return evaluate(read, arg);
    });
    expect(await f.run()).toMatchObject({ status: "stopped", code: "PRESERVED_TARGET_CHANGED" });
    expect(f.controls[1].write).not.toHaveBeenCalled();
  });

  it.each(["all", "duplicate", "unknown", "attachment"])(
    "유효하지 않은 보호 목록 %s는 쓰기 전에 거부한다",
    async (kind) => {
      const f = recoveryFixture();
      if (kind === "all") f.input.preserveFieldKeys = f.input.fields.map((field) => field.fieldKey);
      if (kind === "duplicate") f.input.preserveFieldKeys = ["field-1", "field-1"];
      if (kind === "unknown") f.input.preserveFieldKeys = ["other"];
      if (kind === "attachment") f.input.attachments = [{ fieldKey: "file", files: [] }];
      expect(await f.run()).toMatchObject({
        status: "stopped",
        code: "INVALID_INPUT",
        touchedFieldKeys: [],
      });
      for (const control of f.controls) expect(control.write).not.toHaveBeenCalled();
    },
  );

  it("보호할 기존 일치값이 없어도 새 텍스트 승인에는 원자적 회사 확인을 적용한다", async () => {
    const f = fixture();
    f.input.preserveFieldKeys = [];
    expect(await f.run()).toMatchObject({ status: "completed", touchedFieldKeys: ["field-1"] });
    expect(captureGuard).toHaveBeenCalledTimes(1);
  });
});

describe("승인된 서버 Buffer 첨부 — 가상 DOM", () => {
  it("첨부만 실행해 이름·MIME·크기·SHA256을 재확인하고 완료 key만 반환한다", async () => {
    const f = attachmentFixture();
    expect(await f.run()).toEqual({
      status: "completed",
      completedFieldKeys: ["field-1"],
      touchedFieldKeys: ["field-1"],
      attemptedFieldKey: null,
      code: null,
    });
    expect(f.controls[0].filesWrite).toHaveBeenCalledTimes(1);
    expect(f.controls[0].state.valueReads).toBe(0);
    expect(f.controls[0].write).not.toHaveBeenCalled();
    expect(f.controls[0].getFiles()[0].name).toBe("approved.pdf");
    expect(await f.controls[0].getFiles()[0].text()).toBe("approved fixture bytes");
    expect(f.controls[0].node.dispatchEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "input",
      "change",
    ]);
  });

  it("multiple input에는 승인된 파일 목록을 한 번의 native setter로 전달한다", async () => {
    const f = attachmentFixture([fileField({ multiple: true, accept: ".pdf,image/*" })]);
    f.input.attachments![0].files.push({
      name: "graph.png",
      mimeType: "image/png",
      buffer: Buffer.from([1, 2, 3]),
    });
    expect(await f.run()).toMatchObject({ status: "completed" });
    expect(f.controls[0].filesWrite).toHaveBeenCalledTimes(1);
    expect(f.controls[0].getFiles().map((file) => file.name)).toEqual([
      "approved.pdf",
      "graph.png",
    ]);
  });

  it("기존 파일이 선택되어 있으면 앞 텍스트도 입력하지 않는다", async () => {
    const f = attachmentFixture([field(), fileField({ key: "file-2" })]);
    f.controls[1].setFiles([new File(["manual"], "manual.pdf", { type: "application/pdf" })]);
    expect(await f.run()).toMatchObject({
      status: "stopped",
      completedFieldKeys: [],
      attemptedFieldKey: null,
      code: "TARGET_NOT_EMPTY",
    });
    expect(f.controls[0].write).not.toHaveBeenCalled();
    expect(f.controls[1].filesWrite).not.toHaveBeenCalled();
  });

  it.each(["bytes", "name", "mime", "size", "removed"])(
    "change 이벤트의 %s 변조는 readback에서 실패한다",
    async (kind) => {
      const f = attachmentFixture();
      f.controls[0].node.dispatchEvent.mockImplementation((event) => {
        if (event.type === "change") {
          const original = f.input.attachments![0].files[0];
          f.controls[0].setFiles(
            kind === "removed"
              ? []
              : [
                  new File(
                    [
                      kind === "size"
                        ? "short"
                        : kind === "bytes"
                          ? "x".repeat(original.buffer.length)
                          : Uint8Array.from(original.buffer),
                    ],
                    kind === "name" ? "other.pdf" : original.name,
                    { type: kind === "mime" ? "text/plain" : original.mimeType },
                  ),
                ],
          );
        }
        return true;
      });
      const result = await f.run();
      expect(result).toEqual({
        status: "stopped",
        completedFieldKeys: [],
        touchedFieldKeys: ["field-1"],
        attemptedFieldKey: "field-1",
        code: "FILE_UNCONFIRMED",
      });
      expect(JSON.stringify(result)).not.toContain("approved.pdf");
      expect(JSON.stringify(result)).not.toContain("fixture bytes");
      expect(f.controls[0].filesWrite).toHaveBeenCalledTimes(1);
    },
  );

  it("해시를 읽는 중 같은 metadata 파일로 선택이 바뀌어도 완료하지 않는다", async () => {
    const f = attachmentFixture();
    f.controls[0].node.dispatchEvent.mockImplementation((event) => {
      if (event.type === "change") {
        const file = f.controls[0].getFiles()[0];
        const originalRead = file.arrayBuffer.bind(file);
        file.arrayBuffer = async () => {
          f.controls[0].setFiles([
            new File(["approved fixture bytes"], "approved.pdf", { type: "application/pdf" }),
          ]);
          return originalRead();
        };
      }
      return true;
    });
    expect(await f.run()).toMatchObject({
      status: "stopped",
      code: "FILE_UNCONFIRMED",
      completedFieldKeys: [],
    });
  });

  it("마지막 해시 await 동안 accept가 바뀌면 파일 관측 자체가 완료를 거부한다", async () => {
    const f = attachmentFixture();
    let digests = 0;
    vi.stubGlobal("crypto", {
      subtle: {
        digest: async (algorithm: string, bytes: BufferSource) => {
          const hash = await webcrypto.subtle.digest(algorithm, bytes);
          digests += 1;
          if (digests === 2) {
            f.controls[0].node.accept = ".xlsx";
            f.fresh.fields[0].accept = ".xlsx";
          }
          return hash;
        },
      },
    });
    expect(await f.run()).toEqual({
      status: "stopped",
      completedFieldKeys: [],
      touchedFieldKeys: ["field-1"],
      attemptedFieldKey: "field-1",
      code: "FILE_UNCONFIRMED",
    });
    expect(f.controls[0].filesWrite).toHaveBeenCalledTimes(1);
  });

  it("후속 첨부 이벤트가 앞 텍스트를 지우면 최종 전체 확인에서 중단한다", async () => {
    const f = attachmentFixture([field(), fileField({ key: "file-2" })]);
    f.controls[1].node.dispatchEvent.mockImplementation((event) => {
      if (event.type === "change") f.controls[0].setValue("");
      return true;
    });
    expect(await f.run()).toEqual({
      status: "stopped",
      completedFieldKeys: [],
      touchedFieldKeys: ["field-1", "file-2"],
      attemptedFieldKey: "file-2",
      code: "VALUE_UNCONFIRMED",
    });
  });

  it("후속 첨부가 앞 첨부를 비우면 최종 전체 파일 확인에서 중단한다", async () => {
    const f = attachmentFixture([
      fileField(),
      fileField({ key: "file-2", id: "second", name: "second" }),
    ]);
    f.controls[1].node.dispatchEvent.mockImplementation((event) => {
      if (event.type === "change") f.controls[0].setFiles([]);
      return true;
    });
    expect(await f.run()).toEqual({
      status: "stopped",
      completedFieldKeys: [],
      touchedFieldKeys: ["field-1", "file-2"],
      attemptedFieldKey: "file-2",
      code: "FILE_UNCONFIRMED",
    });
  });

  it.each([
    "selected",
    "replacement",
    "accept",
    "multiple",
    "disabled",
    "readonly",
    "consent",
    "directory",
    "duplicate",
  ])("마지막 파일 쓰기 직전 %s 경합은 기존 선택을 보존한다", async (kind) => {
    const f = attachmentFixture();
    f.controls[0].handle.evaluate.mockImplementation(async (read, arg) => {
      if ((arg as { writeFiles: unknown }).writeFiles !== null) {
        if (kind === "selected") f.controls[0].setFiles([new File(["manual"], "manual.pdf")]);
        if (kind === "replacement") f.controls[0].state.replaced = true;
        if (kind === "accept") f.controls[0].node.accept = ".xlsx";
        if (kind === "multiple") f.controls[0].node.multiple = true;
        if (kind === "disabled") f.controls[0].node.disabled = true;
        if (kind === "readonly") f.controls[0].node.readOnly = true;
        if (kind === "consent") f.controls[0].state.attributes["aria-label"] = "자료 제공 동의";
        if (kind === "directory") f.controls[0].state.attributes.webkitdirectory = "";
        if (kind === "duplicate") f.controls[0].state.count = 2;
      }
      return read(f.controls[0].node as unknown as Element, arg);
    });
    expect(await f.run()).toMatchObject({ status: "stopped", completedFieldKeys: [] });
    expect(f.controls[0].filesWrite).not.toHaveBeenCalled();
    expect(f.controls[0].node.dispatchEvent).not.toHaveBeenCalled();
    if (kind === "selected") expect(f.controls[0].getFiles()[0].name).toBe("manual.pdf");
  });

  it("native FileList setter 실패는 시도 key를 남기고 재시도하지 않는다", async () => {
    const f = attachmentFixture();
    f.controls[0].filesWrite.mockImplementation(() => {
      throw new Error("SECRET BUFFER FAILURE");
    });
    const result = await f.run();
    expect(result).toEqual({
      status: "stopped",
      completedFieldKeys: [],
      touchedFieldKeys: ["field-1"],
      attemptedFieldKey: "field-1",
      code: "INPUT_FAILED",
    });
    expect(f.controls[0].filesWrite).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it.each([
    "paths",
    "not-buffer",
    "name-control",
    "mime",
    "extension",
    "accept-token",
    "duplicate-name",
    "single-multiple",
    "empty-list",
    "non-file",
    "overlap",
  ])("승인 payload의 %s는 브라우저 처리 전에 거부한다", async (kind) => {
    const f = attachmentFixture();
    const item = f.input.attachments![0].files[0];
    if (kind === "paths") item.name = "C:\\private\\secret.pdf";
    if (kind === "not-buffer") item.buffer = "C:\\private\\secret.pdf" as unknown as Buffer;
    if (kind === "name-control") item.name = "bad\nname.pdf";
    if (kind === "mime") item.mimeType = "application/pdf; secret=value";
    if (kind === "extension") item.name = "wrong.exe";
    if (kind === "accept-token") f.input.snapshot.fields[0].accept = ".pdf,??";
    if (kind === "duplicate-name") {
      f.input.snapshot.fields[0].multiple = true;
      f.input.attachments![0].files.push({ ...item });
    }
    if (kind === "single-multiple")
      f.input.attachments![0].files.push({ ...item, name: "second.pdf" });
    if (kind === "empty-list") f.input.attachments![0].files = [];
    if (kind === "non-file") {
      f.input.snapshot.fields[0].kind = "input";
      f.input.snapshot.fields[0].type = "text";
      f.input.snapshot.fields[0].accept = null;
    }
    if (kind === "overlap") f.input.fields = [{ fieldKey: "field-1", value: "bad" }];
    expect(await f.run()).toMatchObject({
      status: "stopped",
      attemptedFieldKey: null,
      completedFieldKeys: [],
    });
    expect(collect).not.toHaveBeenCalled();
    expect(f.controls[0].filesWrite).not.toHaveBeenCalled();
  });

  it.each(["one-file", "total-bytes", "total-files"])(
    "첨부 %s 한도를 초과하면 아무것도 입력하지 않는다",
    async (kind) => {
      const f = attachmentFixture([
        fileField({ multiple: true }),
        fileField({ key: "file-2", id: "second", name: "second", multiple: true }),
      ]);
      if (kind === "one-file")
        f.input.attachments![0].files[0].buffer = Buffer.alloc(12 * 1024 * 1024 + 1);
      if (kind === "total-bytes")
        f.input.attachments![0].files = Array.from({ length: 3 }, (_, index) => ({
          name: `large-${index}.pdf`,
          mimeType: "application/pdf",
          buffer: Buffer.alloc(9 * 1024 * 1024),
        }));
      if (kind === "total-files")
        for (const [group, attachment] of f.input.attachments!.entries())
          attachment.files = Array.from({ length: group ? 5 : 6 }, (_, index) => ({
            name: `part-${group}-${index}.pdf`,
            mimeType: "application/pdf",
            buffer: Buffer.from("tiny"),
          }));
      expect(await f.run()).toMatchObject({
        status: "stopped",
        code: "ATTACHMENT_LIMIT",
        attemptedFieldKey: null,
      });
      expect(collect).not.toHaveBeenCalled();
    },
  );

  it("준비 후 원본 Buffer가 바뀌어도 이미 복사한 승인 bytes만 전달한다", async () => {
    const f = attachmentFixture();
    f.auth.mockImplementationOnce(async () => {
      f.input.attachments![0].files[0].buffer.fill(120);
    });
    expect(await f.run()).toMatchObject({ status: "completed" });
    expect(await f.controls[0].getFiles()[0].text()).toBe("approved fixture bytes");
  });

  it.each(["DataTransfer", "crypto"])(
    "%s가 없는 환경은 앞 텍스트도 변경하지 않는다",
    async (capability) => {
      const f = attachmentFixture([field(), fileField({ key: "file-2" })]);
      vi.stubGlobal(capability, undefined);
      expect(await f.run()).toMatchObject({
        status: "stopped",
        code: "FILE_ASSIGNMENT_UNSUPPORTED",
      });
      expect(f.controls[0].write).not.toHaveBeenCalled();
      expect(f.controls[1].filesWrite).not.toHaveBeenCalled();
    },
  );
});

describe("승인된 빈 텍스트·단일 선택 입력 — 가상 DOM", () => {
  it("텍스트·textarea·빈 placeholder select에 한 번씩 입력하고 확인된 key만 반환한다", async () => {
    const f = fixture([
      field(),
      field({ key: "field-2", id: "plan", name: "plan", kind: "textarea", type: "textarea" }),
      field({
        key: "field-3",
        id: "closingMonth",
        name: null,
        kind: "select",
        type: "select-one",
        maxLength: null,
        options: [
          { label: "선택", value: "", disabled: true },
          { label: "12월", value: "12", disabled: false },
        ],
      }),
    ]);
    expect(await f.run()).toEqual({
      status: "completed",
      completedFieldKeys: ["field-1", "field-2", "field-3"],
      touchedFieldKeys: ["field-1", "field-2", "field-3"],
      attemptedFieldKey: null,
      code: null,
    });
    expect(f.controls[0].write).toHaveBeenCalledExactlyOnceWith("검토한 내용");
    expect(f.controls[1].write).toHaveBeenCalledTimes(1);
    expect(f.controls[2].write).toHaveBeenCalledExactlyOnceWith("12");
    for (const control of f.controls) {
      expect(control.node.dispatchEvent.mock.calls.map(([event]) => event.type)).toEqual([
        "input",
        "change",
      ]);
      expect(control.handle.dispose).toHaveBeenCalledTimes(1);
    }
    expect(f.auth).toHaveBeenCalledTimes(9);
    expect(JSON.stringify(await f.run())).not.toContain("검토한 내용");
  });

  it.each(["기존 입력", " "])(
    "뒤 target에 기존 값 %j가 있으면 첫 target도 수정하지 않는다",
    async (value) => {
      const f = fixture([field(), field({ key: "field-2", id: "second", name: "second" })]);
      f.controls[1].setValue(value);
      expect(await f.run()).toMatchObject({
        status: "stopped",
        code: "TARGET_NOT_EMPTY",
        completedFieldKeys: [],
        attemptedFieldKey: null,
      });
      expect(f.controls[0].write).not.toHaveBeenCalled();
    },
  );

  it.each([0, 2])("target 일치 %i개면 값을 읽거나 입력하지 않는다", async (count) => {
    const f = fixture();
    f.controls[0].state.count = count;
    expect(await f.run()).toMatchObject({ code: "TARGET_AMBIGUOUS", attemptedFieldKey: null });
    expect(f.controls[0].state.valueReads).toBe(0);
  });

  it("id/name 없는 수집순번은 DOM 식별자로 사용하지 않는다", async () => {
    const f = fixture([field({ id: null, name: null })]);
    expect(await f.run()).toMatchObject({ code: "TARGET_UNSTABLE" });
    expect(f.page.locator).not.toHaveBeenCalled();
  });

  it("특수문자 id는 CSS escape로 정확히 조회한다", async () => {
    const f = fixture([field({ id: 'a"] *, [id="other', name: null })]);
    expect(await f.run()).toMatchObject({ status: "completed" });
    expect(f.page.locator.mock.calls[0][0]).not.toContain("*,");
  });

  it.each([
    { kind: "file", type: "file", accept: ".pdf" },
    { type: "checkbox" },
    { type: "radio" },
    { readOnly: true },
    { disabled: true },
    { multiple: true },
    { labels: ["약관 동의"] },
    { name: "consentText" },
    { type: "month" },
  ] as Partial<VentureScreenField>[])(
    "허용되지 않은 필드 %j는 수정하지 않는다",
    async (metadata) => {
      const f = fixture([field(metadata)]);
      expect(await f.run()).toMatchObject({ status: "stopped", attemptedFieldKey: null });
      expect(f.page.locator).not.toHaveBeenCalled();
    },
  );

  it.each(["type", "label", "option", "required", "warning", "company", "title", "truncate"])(
    "새 화면 %s 변경을 거부한다",
    async (change) => {
      const f = fixture();
      if (change === "type") f.fresh.fields[0].type = "email";
      if (change === "label") f.fresh.fields[0].labels = ["다른 항목"];
      if (change === "option") f.fresh.fields[0].maxLength = 150;
      if (change === "required") f.fresh.fields[0].required = false;
      if (change === "warning") f.fresh.warnings.push("변경됨");
      if (change === "company") f.fresh.companyEvidence[0].value = "999-99-99999";
      if (change === "title") f.fresh.title = "다른 화면";
      if (change === "truncate") f.fresh.truncated = true;
      expect(await f.run()).toMatchObject({ status: "stopped", attemptedFieldKey: null });
      expect(f.controls[0].write).not.toHaveBeenCalled();
    },
  );

  it.each(["missing", "masked", "different", "ambiguous"])(
    "기업 증거 %s는 입력 승인으로 사용하지 않는다",
    async (kind) => {
      const f = fixture();
      if (kind === "missing") f.input.snapshot.companyEvidence = [];
      if (kind === "masked") f.input.snapshot.companyEvidence[0].value = "123-**-*****";
      if (kind === "different") f.input.businessNumber = "9999999999";
      if (kind === "ambiguous")
        f.input.snapshot.companyEvidence.push({
          kind: "businessNumber",
          label: "사업자번호",
          value: "9999999999",
          source: "definition",
        });
      expect(await f.run()).toMatchObject({ code: "COMPANY_UNVERIFIED" });
      expect(f.page.locator).not.toHaveBeenCalled();
    },
  );

  it.each(["autocomplete", "title", "aria-label", "placeholder"])(
    "DOM의 %s 인증 표지가 바뀌면 값 getter 전에 거부한다",
    async (attribute) => {
      const f = fixture();
      f.controls[0].state.attributes[attribute] = "인증번호";
      expect(await f.run()).toMatchObject({ code: "TARGET_FORBIDDEN" });
      expect(f.controls[0].state.valueReads).toBe(0);
    },
  );

  it("인증 form에 옮겨진 target의 값을 읽지 않는다", async () => {
    const f = fixture();
    f.controls[0].state.form = { querySelector: () => ({}), id: "", getAttribute: () => null };
    expect(await f.run()).toMatchObject({ code: "TARGET_FORBIDDEN" });
    expect(f.controls[0].state.valueReads).toBe(0);
  });

  it("첫 입력 뒤 두 번째 target을 사용자가 채우면 덮어쓰지 않고 부분 결과로 멈춘다", async () => {
    const f = fixture([field(), field({ key: "field-2", id: "second", name: "second" })]);
    f.controls[0].write.mockImplementation((value) => {
      f.controls[0].setValue(value);
      f.controls[1].setValue("직접 입력");
    });
    expect(await f.run()).toMatchObject({
      status: "stopped",
      completedFieldKeys: ["field-1"],
      attemptedFieldKey: "field-2",
      code: "TARGET_NOT_EMPTY",
    });
    expect(f.controls[1].write).not.toHaveBeenCalled();
  });

  it.each(["replacement", "same-element-value", "duplicate-id", "detached", "options", "required"])(
    "최종 쓰기 직전 %s race도 원자적 재검사로 덮어쓰기 없이 중단한다",
    async (kind) => {
      const f = fixture([
        field({
          kind: "select",
          type: "select-one",
          maxLength: null,
          options: [
            { label: "선택", value: "", disabled: false },
            { label: "12월", value: "12", disabled: false },
          ],
        }),
      ]);
      f.controls[0].handle.evaluate.mockImplementation(async (read, arg) => {
        if ((arg as { writeValue: string | null }).writeValue !== null) {
          if (kind === "replacement") f.controls[0].state.replaced = true;
          if (kind === "same-element-value") f.controls[0].setValue("사용자 선입력");
          if (kind === "duplicate-id") f.controls[0].state.count = 2;
          if (kind === "detached") f.controls[0].node.isConnected = false;
          if (kind === "options") f.controls[0].node.options[1].disabled = true;
          if (kind === "required") f.controls[0].node.required = false;
        }
        return read(f.controls[0].node as unknown as Element, arg);
      });
      expect(await f.run()).toMatchObject({
        status: "stopped",
        completedFieldKeys: [],
        attemptedFieldKey: "field-1",
      });
      expect(f.controls[0].write).not.toHaveBeenCalled();
      expect(f.controls[0].node.dispatchEvent).not.toHaveBeenCalled();
      if (kind === "same-element-value") expect(f.controls[0].getValue()).toBe("사용자 선입력");
    },
  );

  it("input 이벤트가 문서를 바꾸면 change를 보내지 않고 부분 가능성으로 정지한다", async () => {
    const f = fixture();
    f.controls[0].node.dispatchEvent.mockImplementation((event) => {
      if (event.type === "input") f.controls[0].node.isConnected = false;
      return true;
    });
    expect(await f.run()).toMatchObject({
      status: "stopped",
      attemptedFieldKey: "field-1",
      code: "TARGET_CHANGED",
    });
    expect(f.controls[0].node.dispatchEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "input",
    ]);
  });

  it("disabled optgroup의 option은 native setter로도 선택하지 않는다", async () => {
    const f = fixture([
      field({
        kind: "select",
        type: "select-one",
        maxLength: null,
        options: [
          { label: "선택", value: "", disabled: false },
          { label: "12월", value: "12", disabled: false },
        ],
      }),
    ]);
    Object.assign(f.controls[0].node.options[1], {
      parentElement: { tagName: "OPTGROUP", disabled: true },
    });
    expect(await f.run()).toMatchObject({ status: "stopped", code: "TARGET_FORBIDDEN" });
    expect(f.controls[0].write).not.toHaveBeenCalled();
  });

  it("뒤 필드 change가 앞 필드를 지우면 최종 전체 readback에서 completed를 거부한다", async () => {
    const f = fixture([field(), field({ key: "field-2", id: "second", name: "second" })]);
    f.controls[1].node.dispatchEvent.mockImplementation((event) => {
      if (event.type === "change") f.controls[0].setValue("");
      return true;
    });
    expect(await f.run()).toEqual({
      status: "stopped",
      completedFieldKeys: [],
      touchedFieldKeys: ["field-1", "field-2"],
      attemptedFieldKey: "field-2",
      code: "VALUE_UNCONFIRMED",
    });
    expect(f.controls[0].write).toHaveBeenCalledTimes(1);
    expect(f.controls[1].write).toHaveBeenCalledTimes(1);
    expect(f.controls[0].getValue()).toBe("");
  });

  it("fill이 값을 쓴 뒤 실패해도 해당 key는 가능성으로 남기고 재시도하지 않는다", async () => {
    const f = fixture();
    f.controls[0].write.mockImplementation((value) => {
      f.controls[0].setValue(value);
      throw new Error(`SECRET ${value}`);
    });
    const result = await f.run();
    expect(result).toEqual({
      status: "stopped",
      completedFieldKeys: [],
      touchedFieldKeys: ["field-1"],
      attemptedFieldKey: "field-1",
      code: "INPUT_FAILED",
    });
    expect(f.controls[0].write).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("입력 후 readback 불일치는 완료로 기록하지 않는다", async () => {
    const f = fixture();
    f.controls[0].write.mockImplementation(() => {});
    expect(await f.run()).toMatchObject({
      attemptedFieldKey: "field-1",
      completedFieldKeys: [],
      code: "VALUE_UNCONFIRMED",
    });
  });

  it("입력 직전 승인 취소는 첫 변경 없이 정지한다", async () => {
    const f = fixture();
    f.auth
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => {
        throw new VentureTextInputError("APPROVAL_CHANGED");
      });
    expect(await f.run()).toMatchObject({ attemptedFieldKey: null, code: "APPROVAL_CHANGED" });
    expect(f.controls[0].write).not.toHaveBeenCalled();
  });

  it("입력 이벤트에서 화면·세션이 바뀌면 readback 전 정지한다", async () => {
    const f = fixture();
    let changed = false;
    f.current.mockImplementation(() => {
      if (changed) throw new VentureTextInputError("SCREEN_CHANGED");
    });
    f.controls[0].write.mockImplementation((value) => {
      f.controls[0].setValue(value);
      changed = true;
    });
    expect(await f.run()).toMatchObject({
      attemptedFieldKey: "field-1",
      completedFieldKeys: [],
      code: "SCREEN_CHANGED",
    });
  });

  it.each(["duplicate", "too-many", "long", "total", "empty"])(
    "입력 범위 %s를 첫 브라우저 동작 전에 거부한다",
    async (kind) => {
      const f = fixture();
      if (kind === "duplicate") f.input.fields.push({ ...f.input.fields[0] });
      if (kind === "too-many")
        f.input.fields = Array.from({ length: 51 }, (_, index) => ({
          fieldKey: `key-${index}`,
          value: "a",
        }));
      if (kind === "long") f.input.fields[0].value = "a".repeat(20_001);
      if (kind === "total")
        f.input.fields = Array.from({ length: 6 }, (_, index) => ({
          fieldKey: `key-${index}`,
          value: "a".repeat(20_000),
        }));
      if (kind === "empty") f.input.fields = [];
      expect(await f.run()).toMatchObject({ code: "INVALID_INPUT" });
      expect(collect).not.toHaveBeenCalled();
    },
  );

  it.each(["disabled", "duplicate", "missing", "already-selected"])(
    "select option %s는 선택하지 않는다",
    async (kind) => {
      const f = fixture([
        field({
          kind: "select",
          type: "select-one",
          maxLength: null,
          options: [
            { label: "선택", value: "", disabled: false },
            { label: "12월", value: "12", disabled: kind === "disabled" },
          ],
        }),
      ]);
      if (kind === "duplicate")
        f.input.snapshot.fields[0].options.push({
          label: "또 다른 선택",
          value: "12",
          disabled: false,
        });
      if (kind === "missing") f.input.fields[0].value = "99";
      if (kind === "already-selected") f.controls[0].setValue("1");
      expect(await f.run()).toMatchObject({ status: "stopped", attemptedFieldKey: null });
      expect(f.controls[0].write).not.toHaveBeenCalled();
    },
  );
});
