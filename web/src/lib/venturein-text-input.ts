import "server-only";

import { createHash } from "node:crypto";
import type { ElementHandle, JSHandle, Page } from "playwright-core";
import {
  collectVentureScreen,
  captureVentureInspectionGuard,
} from "./venturein-inspection-collector";
import {
  validateVentureScreenSnapshot,
  ventureInspectionRules,
  verifyVentureCompany,
  type VentureScreenField,
  type VentureScreenSnapshot,
} from "./venturein-inspection";

export type VentureTextInput = {
  snapshot: VentureScreenSnapshot;
  sessionStartedAt: string;
  businessNumber: string;
  fields: { fieldKey: string; value: string }[];
  /** Present only for newly approved text recovery. Matched targets stay read-only. */
  preserveFieldKeys?: string[];
  attachments?: { fieldKey: string; files: { name: string; mimeType: string; buffer: Buffer }[] }[];
};
export type VentureTextInputResult = {
  status: "completed" | "stopped";
  completedFieldKeys: string[];
  touchedFieldKeys: string[];
  attemptedFieldKey: string | null;
  code: string | null;
};

export class VentureTextInputError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

const consentSource = "agree|consent|terms|signature|pledge|동의|약관|서명|확약|개인정보";
const allowedInputs = new Set(["text", "search", "tel", "url", "email", "number", "date"]);
const actionTimeoutMs = 3_000;
function fail(code: string): never {
  throw new VentureTextInputError(code);
}

function semantics(snapshot: VentureScreenSnapshot) {
  const { url, title, companyEvidence, fields, truncated, warnings } = snapshot;
  return JSON.stringify({ url, title, companyEvidence, fields, truncated, warnings });
}

function fieldSupported(field: VentureScreenField) {
  return (
    !field.disabled &&
    !field.readOnly &&
    !field.multiple &&
    !new RegExp(`${ventureInspectionRules.secretPatternSource}|${consentSource}`, "i").test(
      [field.id, field.name, ...field.labels].join(" "),
    ) &&
    (field.kind === "textarea" ||
      (field.kind === "select" && field.type === "select-one") ||
      (field.kind === "input" && allowedInputs.has(field.type)))
  );
}

type ApprovedFile = {
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  base64: string;
};
type FileExpectation = Omit<ApprovedFile, "base64">;

function acceptsFile(accept: string | null, name: string, mimeType: string) {
  if (!accept?.trim()) return true;
  const tokens = accept.split(",").map((token) => token.trim().toLowerCase());
  if (
    tokens.some(
      (token) =>
        !/^\.[a-z0-9][a-z0-9._-]*$/.test(token) &&
        !/^[a-z0-9!#$&^_.+-]+\/(?:[a-z0-9!#$&^_.+-]+|\*)$/.test(token),
    )
  )
    return false;
  return tokens.some((token) =>
    token.startsWith(".")
      ? name.toLowerCase().endsWith(token)
      : token.endsWith("/*")
        ? mimeType.startsWith(token.slice(0, -1))
        : token === mimeType,
  );
}

function attachmentTargets(input: VentureTextInput, snapshot: VentureScreenSnapshot) {
  const attachments = input.attachments ?? [];
  if (!Array.isArray(attachments) || attachments.length > 10) fail("INVALID_ATTACHMENT");
  let fileCount = 0;
  let totalBytes = 0;
  const result = attachments.map((attachment) => {
    const field = snapshot.fields.find((candidate) => candidate.key === attachment?.fieldKey);
    if (
      !field ||
      field.kind !== "file" ||
      field.type !== "file" ||
      field.disabled ||
      field.readOnly ||
      new RegExp(`${ventureInspectionRules.secretPatternSource}|${consentSource}`, "i").test(
        [field.id, field.name, ...field.labels].join(" "),
      )
    )
      fail("TARGET_FORBIDDEN");
    if (
      !Array.isArray(attachment.files) ||
      !attachment.files.length ||
      attachment.files.length > 10 ||
      (!field.multiple && attachment.files.length !== 1)
    )
      fail("INVALID_ATTACHMENT");
    const files: ApprovedFile[] = attachment.files.map((file) => {
      if (
        !file ||
        typeof file.name !== "string" ||
        !file.name.trim() ||
        file.name.length > 255 ||
        /[\\/:]/.test(file.name) ||
        [".", ".."].includes(file.name) ||
        Array.from(file.name).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) ||
        typeof file.mimeType !== "string" ||
        file.mimeType.length > 200 ||
        !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(file.mimeType) ||
        !Buffer.isBuffer(file.buffer)
      )
        fail("INVALID_ATTACHMENT");
      fileCount += 1;
      totalBytes += file.buffer.length;
      if (file.buffer.length > 12 * 1024 * 1024 || totalBytes > 24 * 1024 * 1024 || fileCount > 10)
        fail("ATTACHMENT_LIMIT");
      const mimeType = file.mimeType.toLowerCase();
      if (!acceptsFile(field.accept, file.name, mimeType)) fail("FILE_TYPE_REJECTED");
      // Copy before hashing/encoding so later caller mutations cannot change the approved payload.
      const bytes = Buffer.from(file.buffer);
      return {
        name: file.name,
        mimeType,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        base64: bytes.toString("base64"),
      };
    });
    if (new Set(files.map((file) => file.name.toLowerCase())).size !== files.length)
      fail("INVALID_ATTACHMENT");
    return { field, files };
  });
  return result;
}

function valueValid(field: VentureScreenField, value: string) {
  if (
    !value.trim() ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
    })
  )
    return false;
  if (field.maxLength !== null && value.length > field.maxLength) return false;
  if (field.kind === "select")
    return (
      field.options.filter((option) => option.value === value && !option.disabled).length === 1 &&
      field.options.filter((option) => option.value === value).length === 1
    );
  if (field.kind !== "input") return true;
  if (/[\r\n]/.test(value)) return false;
  if (field.type === "number")
    return (
      /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value))
    );
  if (field.type === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  if (field.type === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (field.type === "url") {
    try {
      return value === value.trim() && Boolean(new URL(value).protocol);
    } catch {
      return false;
    }
  }
  return true;
}

// CSS string escapes prevent an id/name from becoming selector syntax.
function cssString(value: string) {
  return `"${Array.from(value, (character) => `\\${character.codePointAt(0)!.toString(16)} `).join("")}"`;
}

async function targetFor(page: Page, field: VentureScreenField) {
  if (!field.id && !field.name) fail("TARGET_UNSTABLE");
  const selector = field.id ? `[id=${cssString(field.id)}]` : `[name=${cssString(field.name!)}]`;
  const locator = page.locator(selector);
  if ((await locator.count()) !== 1) fail("TARGET_AMBIGUOUS");
  const handle = await locator.elementHandle({ timeout: actionTimeoutMs });
  if (!handle) fail("TARGET_CHANGED");
  return { handle, selector };
}

type BrowserObservation = { isCurrent: () => boolean; code?: string | null };
type TargetConfig = {
  field: VentureScreenField;
  expected: string | null;
  signature: string | null;
  writeValue: string | null;
  expectedFiles: FileExpectation[] | null;
  writeFiles: ApprovedFile[] | null;
  selector: string;
  rawUrl: string;
  forbidden: string;
  capture: boolean;
  guards: BrowserObservation[];
};
/** Self-contained browser callback: metadata and protected values are checked synchronously. */
async function evaluateTarget(
  element: HTMLElement | SVGElement,
  config: TargetConfig,
): Promise<{ code: string | null; signature: string | null; isCurrent?: () => boolean }> {
  const control = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  const refused = (code: string) => ({ code, signature: null as string | null });
  const identityMatches = () => {
    const matches = document.querySelectorAll(config.selector);
    return (
      location.href === config.rawUrl &&
      control.isConnected &&
      control.ownerDocument === document &&
      matches.length === 1 &&
      matches[0] === control
    );
  };
  const inspect = () => {
    if (!identityMatches()) return refused("TARGET_CHANGED");
    const visible = (node: Element) => {
      const style = getComputedStyle(node);
      return (
        !node.closest('[hidden], [aria-hidden="true"], [inert]') &&
        style.display !== "none" &&
        !["hidden", "collapse"].includes(style.visibility) &&
        node.getClientRects().length > 0
      );
    };
    const type =
      control.tagName === "TEXTAREA"
        ? "textarea"
        : control.tagName === "SELECT"
          ? (control as HTMLSelectElement).multiple
            ? "select-multiple"
            : "select-one"
          : (control as HTMLInputElement).type;
    const tag =
      config.field.kind === "textarea"
        ? "TEXTAREA"
        : config.field.kind === "select"
          ? "SELECT"
          : "INPUT";
    if (
      control.tagName !== tag ||
      type !== config.field.type ||
      (control.id || null) !== config.field.id ||
      (control.name || null) !== config.field.name ||
      !visible(control) ||
      control.disabled ||
      control.matches(":disabled") ||
      ("readOnly" in control && control.readOnly) ||
      ("multiple" in control && control.multiple !== config.field.multiple)
    )
      return refused("TARGET_CHANGED");
    const labels = Array.from(control.labels || []).map((label) => label.innerText.slice(0, 300));
    for (const id of (control.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 8)) {
      const label = control.ownerDocument.getElementById(id);
      if (label) labels.push(label.innerText.slice(0, 300));
    }
    const hints = [
      control.id,
      control.name,
      ...labels,
      ...["autocomplete", "title", "aria-label", "placeholder"].map((name) =>
        control.getAttribute(name),
      ),
    ].join(" ");
    if (new RegExp(config.forbidden, "i").test(hints)) return refused("TARGET_FORBIDDEN");
    const form = control.closest("form");
    if (
      form &&
      (form.querySelector(
        'input[type="password"],input[autocomplete="one-time-code"],input[autocomplete="current-password"],input[autocomplete="new-password"]',
      ) ||
        /login|sign.?in|\/auth(?:\/|$)/i.test(
          [form.id, form.getAttribute("name"), form.getAttribute("action")].join(" "),
        ))
    )
      return refused("TARGET_FORBIDDEN");
    const options =
      control.tagName === "SELECT"
        ? Array.from((control as HTMLSelectElement).options).map((option) => ({
            label: option.label.replace(/\s+/g, " ").trim(),
            value: option.value,
            disabled: option.disabled,
          }))
        : [];
    const maxLength = "maxLength" in control && control.maxLength >= 0 ? control.maxLength : null;
    if (
      maxLength !== config.field.maxLength ||
      JSON.stringify(options) !== JSON.stringify(config.field.options)
    )
      return refused("TARGET_CHANGED");
    const cell = control.closest("td");
    let previous = cell?.previousElementSibling;
    const headings: string[] = [];
    for (let step = 0; previous && step < 8; step += 1) {
      if (previous.tagName === "TH") {
        headings.push((previous as HTMLElement).innerText.slice(0, 300));
        break;
      }
      previous = previous.previousElementSibling;
    }
    const currentSignature = JSON.stringify({
      hints,
      headings,
      required: control.required,
      attributes: ["aria-required", "min", "max", "step", "pattern", "maxlength"].map((name) =>
        control.getAttribute(name),
      ),
      options,
      maxLength,
      accept: config.field.kind === "file" ? (control as HTMLInputElement).accept : null,
      multiple: "multiple" in control && control.multiple,
    });
    if (config.signature !== null && currentSignature !== config.signature)
      return refused("TARGET_CHANGED");

    return { code: null, signature: currentSignature };
  };
  const state = inspect();
  if (state.code) return state;
  const currentSignature = state.signature!;
  const guardsCurrent = () => {
    try {
      return config.guards.every((guard) => guard.isCurrent());
    } catch {
      return false;
    }
  };
  if (!guardsCurrent()) return refused("PRESERVED_TARGET_CHANGED");
  if (config.capture && config.field.kind !== "file") {
    if (config.expected === null) return refused("INVALID_INPUT");
    const selected =
      control.tagName === "SELECT"
        ? Array.from((control as HTMLSelectElement).selectedOptions)
        : [];
    const isCurrent = () => {
      const next = inspect();
      if (
        next.code ||
        next.signature !== currentSignature ||
        control.value !== config.expected ||
        !guardsCurrent()
      )
        return false;
      if (control.tagName !== "SELECT") return true;
      const selection = (control as HTMLSelectElement).selectedOptions;
      return (
        selected.length === 1 &&
        selection.length === 1 &&
        selection[0] === selected[0] &&
        selected[0].value === config.expected &&
        !selected[0].disabled &&
        !(
          selected[0].parentElement?.tagName === "OPTGROUP" &&
          (selected[0].parentElement as HTMLOptGroupElement).disabled
        )
      );
    };
    if (!isCurrent()) return refused("VALUE_UNCONFIRMED");
    return { code: null, signature: currentSignature, isCurrent };
  }
  if (config.field.kind === "file") {
    const fileInput = control as HTMLInputElement;
    if (
      fileInput.accept !== (config.field.accept ?? "") ||
      fileInput.hasAttribute("webkitdirectory") ||
      fileInput.hasAttribute("directory")
    )
      return refused("TARGET_CHANGED");
    if (!fileInput.files) return refused("FILE_UNCONFIRMED");
    if (config.expectedFiles !== null) {
      const files = Array.from(fileInput.files);
      if (files.length !== config.expectedFiles.length) return refused("FILE_UNCONFIRMED");
      const selectionMatches = () => {
        const next = inspect();
        return (
          !next.code &&
          next.signature === currentSignature &&
          !fileInput.hasAttribute("webkitdirectory") &&
          !fileInput.hasAttribute("directory") &&
          fileInput.files?.length === files.length &&
          files.every((file, index) => fileInput.files?.item(index) === file) &&
          guardsCurrent()
        );
      };
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const expected = config.expectedFiles[index];
        if (
          file.name !== expected.name ||
          file.type !== expected.mimeType ||
          file.size !== expected.size
        )
          return refused("FILE_UNCONFIRMED");
        if (!globalThis.crypto?.subtle) return refused("FILE_UNCONFIRMED");
        const bytes = await file.arrayBuffer();
        if (!selectionMatches() || bytes.byteLength !== expected.size)
          return refused("FILE_UNCONFIRMED");
        const hash = await crypto.subtle.digest("SHA-256", bytes);
        if (
          !selectionMatches() ||
          Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(
            "",
          ) !== expected.sha256
        )
          return refused("FILE_UNCONFIRMED");
      }
      if (!selectionMatches()) return refused("FILE_UNCONFIRMED");
      return config.capture
        ? { code: null, signature: currentSignature, isCurrent: selectionMatches }
        : { code: null, signature: currentSignature };
    }
    if (config.capture) return refused("INVALID_INPUT");
    if (fileInput.files.length !== 0) return refused("TARGET_NOT_EMPTY");
    // Check required browser capabilities during the all-target preflight too.
    if (
      typeof DataTransfer !== "function" ||
      typeof File !== "function" ||
      !globalThis.crypto?.subtle ||
      !Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")?.set
    )
      return refused("FILE_ASSIGNMENT_UNSUPPORTED");
    if (config.writeFiles !== null) {
      if (typeof DataTransfer !== "function" || typeof File !== "function")
        return refused("FILE_ASSIGNMENT_UNSUPPORTED");
      const transfer = new DataTransfer();
      for (const file of config.writeFiles) {
        const binary = atob(file.base64);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        if (bytes.length !== file.size) return refused("INVALID_ATTACHMENT");
        transfer.items.add(new File([bytes], file.name, { type: file.mimeType }));
      }
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")?.set;
      if (!setter) return refused("FILE_ASSIGNMENT_UNSUPPORTED");
      // This empty check, native FileList assignment and events have no asynchronous boundary.
      if (!identityMatches() || fileInput.files.length !== 0) return refused("TARGET_NOT_EMPTY");
      if (!guardsCurrent()) return refused("PRESERVED_TARGET_CHANGED");
      setter.call(fileInput, transfer.files);
      fileInput.dispatchEvent(new Event("input", { bubbles: true }));
      if (!identityMatches()) return refused("TARGET_CHANGED");
      if (!guardsCurrent()) return refused("PRESERVED_TARGET_CHANGED");
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      if (!identityMatches()) return refused("TARGET_CHANGED");
      if (!guardsCurrent()) return refused("PRESERVED_TARGET_CHANGED");
    }
    return { code: null, signature: currentSignature };
  }
  if (config.expected !== null)
    return {
      code: control.value === config.expected ? null : "VALUE_UNCONFIRMED",
      signature: currentSignature,
    };
  if (control.value !== "") return refused("TARGET_NOT_EMPTY");
  if (control.tagName === "SELECT") {
    const selected = (control as HTMLSelectElement).selectedOptions;
    if (selected.length !== 1 || selected[0].value !== "") return refused("TARGET_NOT_EMPTY");
  }
  if (config.writeValue !== null) {
    if (control.tagName === "SELECT") {
      const option = Array.from((control as HTMLSelectElement).options).find(
        (item) => item.value === config.writeValue,
      );
      if (
        !option ||
        option.disabled ||
        (option.parentElement?.tagName === "OPTGROUP" &&
          (option.parentElement as HTMLOptGroupElement).disabled)
      )
        return refused("TARGET_FORBIDDEN");
    }
    const prototype =
      control.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : control.tagName === "SELECT"
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (!setter) return refused("TARGET_FORBIDDEN");
    // No asynchronous boundary separates the final emptiness test and this native property write.
    if (!guardsCurrent()) return refused("PRESERVED_TARGET_CHANGED");
    setter.call(control, config.writeValue);
    control.dispatchEvent(new Event("input", { bubbles: true }));
    if (!identityMatches()) return refused("TARGET_CHANGED");
    if (!guardsCurrent()) return refused("PRESERVED_TARGET_CHANGED");
    control.dispatchEvent(new Event("change", { bubbles: true }));
    if (!identityMatches()) return refused("TARGET_CHANGED");
    if (!guardsCurrent()) return refused("PRESERVED_TARGET_CHANGED");
    if (control.value !== config.writeValue) return refused("VALUE_UNCONFIRMED");
  }
  return { code: null, signature: currentSignature };
}

type PinnedTarget = { handle: ElementHandle<HTMLElement | SVGElement>; selector: string };
/** Existing values never leave the page. Final empty check and native write run without an await. */
async function checkTarget(
  target: PinnedTarget,
  field: VentureScreenField,
  rawUrl: string,
  expected: string | null,
  signature: string | null = null,
  writeValue: string | null = null,
  expectedFiles: FileExpectation[] | null = null,
  writeFiles: ApprovedFile[] | null = null,
  guards: JSHandle<BrowserObservation>[] = [],
) {
  const result = await target.handle.evaluate(evaluateTarget, {
    capture: false,
    guards,
    field,
    expected,
    signature,
    writeValue,
    expectedFiles,
    writeFiles,
    selector: target.selector,
    rawUrl,
    forbidden: `${ventureInspectionRules.secretPatternSource}|${consentSource}`,
  });
  if (result.code) fail(result.code);
  return result.signature!;
}

async function captureTarget(
  target: PinnedTarget,
  field: VentureScreenField,
  rawUrl: string,
  expected: string | null,
  signature: string,
  expectedFiles: FileExpectation[] | null = null,
) {
  return target.handle.evaluateHandle(evaluateTarget, {
    field,
    rawUrl,
    expected,
    signature,
    capture: true,
    guards: [],
    writeValue: null,
    expectedFiles,
    writeFiles: null,
    selector: target.selector,
    forbidden: `${ventureInspectionRules.secretPatternSource}|${consentSource}`,
  }) as Promise<JSHandle<BrowserObservation>>;
}

/** Apply approved text and files to blank controls. Never click, submit, retry or roll back. */
export async function applyVentureTextInput(
  page: Page,
  input: VentureTextInput,
  assertCurrent: () => void,
  verifyCurrent: () => Promise<void>,
): Promise<VentureTextInputResult> {
  const completedFieldKeys: string[] = [];
  const touchedFieldKeys: string[] = [];
  const guards: JSHandle<BrowserObservation>[] = [];
  let attemptedFieldKey: string | null = null;
  const pinned: PinnedTarget[] = [];
  try {
    const rawUrl = page.url();
    const snapshot = validateVentureScreenSnapshot(input.snapshot);
    if (
      !Array.isArray(input.fields) ||
      input.fields.length > 50 ||
      input.fields.some(
        (item) =>
          typeof item?.fieldKey !== "string" ||
          typeof item?.value !== "string" ||
          item.value.length > 20_000,
      ) ||
      input.fields.reduce((size, item) => size + item.value.length, 0) > 100_000 ||
      new Set(input.fields.map((item) => item.fieldKey)).size !== input.fields.length
    )
      fail("INVALID_INPUT");
    const recovery = input.preserveFieldKeys !== undefined;
    const preserved = input.preserveFieldKeys ?? [];
    if (
      !Array.isArray(preserved) ||
      preserved.some(
        (key) => typeof key !== "string" || !input.fields.some((field) => field.fieldKey === key),
      ) ||
      new Set(preserved).size !== preserved.length ||
      (recovery &&
        ((input.attachments?.length ?? 0) > 0 || preserved.length >= input.fields.length))
    )
      fail("INVALID_INPUT");
    const attachments = attachmentTargets(input, snapshot);
    const allKeys = [
      ...input.fields.map((field) => field.fieldKey),
      ...attachments.map(({ field }) => field.key),
    ];
    if (!allKeys.length || allKeys.length > 50 || new Set(allKeys).size !== allKeys.length)
      fail("INVALID_INPUT");
    if (snapshot.truncated) fail("SCREEN_INCOMPLETE");
    if (verifyVentureCompany(snapshot, input.businessNumber).status !== "matched")
      fail("COMPANY_UNVERIFIED");
    const fields = input.fields.map(({ fieldKey, value }) => {
      const field = snapshot.fields.find((candidate) => candidate.key === fieldKey);
      if (!field || !fieldSupported(field)) fail("TARGET_FORBIDDEN");
      if (!valueValid(field, value)) fail("INVALID_VALUE");
      return { field, value };
    });
    const verify = async () => {
      assertCurrent();
      await verifyCurrent();
      assertCurrent();
      const fresh = validateVentureScreenSnapshot(await collectVentureScreen(page));
      assertCurrent();
      if (semantics(fresh) !== semantics(snapshot)) fail("SCREEN_CHANGED");
      if (verifyVentureCompany(fresh, input.businessNumber).status !== "matched")
        fail("COMPANY_UNVERIFIED");
    };
    await verify();
    // Preflight every target before the first mutation, avoiding a preventable partial fill.
    const prepared: {
      field: VentureScreenField;
      value: string;
      target: PinnedTarget;
      signature: string;
      files?: ApprovedFile[];
      preserved?: boolean;
    }[] = [];
    for (const { field, value } of fields) {
      const target = await targetFor(page, field);
      pinned.push(target);
      const preserve = preserved.includes(field.key);
      const signature = await checkTarget(target, field, rawUrl, preserve ? value : null);
      assertCurrent();
      prepared.push({ field, value, target, signature, preserved: preserve });
      if (preserve) {
        const guard = await captureTarget(target, field, rawUrl, value, signature);
        guards.push(guard);
        if (
          !(await guard.evaluate(
            (observation) => typeof observation.isCurrent === "function" && observation.isCurrent(),
          ))
        )
          fail("PRESERVED_TARGET_CHANGED");
      }
    }
    for (const { field, files } of attachments) {
      const target = await targetFor(page, field);
      pinned.push(target);
      const signature = await checkTarget(target, field, rawUrl, null);
      assertCurrent();
      prepared.push({ field, value: "", target, signature, files });
    }
    // Initial writes need the same synchronous company/authentication guard as recovery writes.
    // Only metadata is captured here: legitimate value/FileList writes must not invalidate it.
    guards.push(
      await captureVentureInspectionGuard(page, {
        rawUrl,
        expectedSemantics: semantics(snapshot),
        observations: [],
      }),
    );
    const verifyProtected = async () => {
      await collectVentureScreen(page, {
        rawUrl,
        expectedSemantics: semantics(snapshot),
        observations: guards,
      });
      assertCurrent();
    };
    const expectedFiles = (files: ApprovedFile[]) =>
      files.map(({ name, mimeType, size, sha256 }) => ({ name, mimeType, size, sha256 }));
    for (const { field, value, target, signature, files } of prepared.filter(
      (item) => !item.preserved,
    )) {
      await verify();
      await verifyProtected();
      assertCurrent();
      attemptedFieldKey = field.key;
      // Record before the asynchronous write call; uncertain results never lose this evidence.
      touchedFieldKeys.push(field.key);
      if (files)
        await checkTarget(target, field, rawUrl, null, signature, null, null, files, guards);
      else await checkTarget(target, field, rawUrl, null, signature, value, null, null, guards);
      assertCurrent();
      await verify();
      if (files)
        await checkTarget(target, field, rawUrl, null, signature, null, expectedFiles(files));
      else await checkTarget(target, field, rawUrl, value, signature);
      assertCurrent();
      await verifyProtected();
      if (recovery) {
        const observation = await captureTarget(target, field, rawUrl, value, signature);
        guards.push(observation);
        if (
          !(await observation.evaluate(
            (item) => typeof item.isCurrent === "function" && item.isCurrent(),
          ))
        )
          fail("PRESERVED_TARGET_CHANGED");
      }
      completedFieldKeys.push(field.key);
      attemptedFieldKey = null;
    }
    // A later control's change handler may alter an earlier control. Reconfirm the whole batch.
    attemptedFieldKey = touchedFieldKeys.at(-1) ?? null;
    completedFieldKeys.length = 0;
    const finallyConfirmed: string[] = [];
    await verify();
    for (const { field, value, target, signature, files, preserved: preserve } of prepared) {
      // Keep the exact readback values/File objects until the final atomic collector check.
      const observation = await captureTarget(
        target,
        field,
        rawUrl,
        files ? null : value,
        signature,
        files ? expectedFiles(files) : null,
      );
      guards.push(observation);
      const readback = await observation.evaluate((item) => ({
        code: item.code ?? null,
        current: typeof item.isCurrent === "function" && item.isCurrent(),
      }));
      if (readback.code) fail(readback.code);
      if (!readback.current) fail("PRESERVED_TARGET_CHANGED");
      assertCurrent();
      if (!preserve) finallyConfirmed.push(field.key);
    }
    // File hashing yields to the page. Recheck authentication/company/metadata after the final hash too.
    await verify();
    await verifyProtected();
    completedFieldKeys.push(...finallyConfirmed);
    return {
      status: "completed",
      completedFieldKeys,
      touchedFieldKeys,
      attemptedFieldKey: null,
      code: null,
    };
  } catch (error) {
    return {
      status: "stopped",
      completedFieldKeys,
      touchedFieldKeys,
      attemptedFieldKey,
      code: error instanceof VentureTextInputError ? error.code : "INPUT_FAILED",
    };
  } finally {
    for (const guard of guards) await guard.dispose().catch(() => undefined);
    for (const target of pinned) await target.handle.dispose().catch(() => undefined);
  }
}
