import "server-only";
import type { ElementHandle, JSHandle, Page } from "playwright-core";
import { collectVentureScreen } from "./venturein-inspection-collector";
import {
  validateVentureScreenSnapshot,
  ventureInspectionRules,
  verifyVentureCompany,
  type VentureScreenSnapshot,
} from "./venturein-inspection";
import type { VentureInputComparisonField } from "./venturein-execution-schema";

export type VentureComparisonInput = {
  snapshot: VentureScreenSnapshot;
  sessionStartedAt: string;
  businessNumber: string;
  fields: { fieldKey: string; value: string }[];
  attachments: {
    fieldKey: string;
    files: { name: string; mimeType: string; size: number; sha256: string }[];
  }[];
};
export type VentureComparisonResult = {
  status: "completed" | "stopped";
  fields: VentureInputComparisonField[];
  code: string | null;
  observedAt: string | null;
};
export class VentureComparisonError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
function fail(code: string): never {
  throw new VentureComparisonError(code);
}
const forbidden = `${ventureInspectionRules.secretPatternSource}|agree|consent|terms|signature|pledge|동의|약관|서명|확약|개인정보`;
const allowedTypes = new Set(["text", "search", "tel", "url", "email", "number", "date"]);
const semantics = ({
  url,
  title,
  companyEvidence,
  fields,
  truncated,
  warnings,
}: VentureScreenSnapshot) =>
  JSON.stringify({ url, title, companyEvidence, fields, truncated, warnings });
const cssString = (value: string) =>
  `"${Array.from(value, (character) => `\\${character.codePointAt(0)!.toString(16)} `).join("")}"`;

type Observation = {
  state: VentureInputComparisonField["state"];
  code: string | null;
  fatal: boolean;
  // Browser-only closure. No observed value, selected filename, file bytes or raw error is serialized.
  isCurrent: () => boolean;
};

/** This helper contains no setters, events, input methods, click, navigation or submission. */
export async function compareVentureInputs(
  page: Page,
  input: VentureComparisonInput,
  assertCurrent: () => void,
  verifyCurrent: () => Promise<void>,
  finalizeCurrent: () => void = () => {},
): Promise<VentureComparisonResult> {
  const handles: (JSHandle | ElementHandle)[] = [];
  try {
    const rawUrl = page.url();
    const snapshot = validateVentureScreenSnapshot(input.snapshot);
    const keys = [
      ...input.fields.map((field) => field.fieldKey),
      ...input.attachments.map((field) => field.fieldKey),
    ];
    if (
      !keys.length ||
      keys.length > 50 ||
      new Set(keys).size !== keys.length ||
      input.fields.some(
        (field) =>
          typeof field.value !== "string" || !field.value.trim() || field.value.length > 20_000,
      ) ||
      input.fields.reduce((sum, field) => sum + field.value.length, 0) > 100_000
    )
      fail("INVALID_INPUT");
    const files = input.attachments.flatMap((attachment) => attachment.files);
    if (
      files.length > 10 ||
      files.reduce((sum, file) => sum + file.size, 0) > 24 * 1024 * 1024 ||
      files.some(
        (file) =>
          !Number.isSafeInteger(file.size) ||
          file.size <= 0 ||
          file.size > 12 * 1024 * 1024 ||
          !/^[a-f0-9]{64}$/.test(file.sha256) ||
          !file.name ||
          /[\\/:]/.test(file.name) ||
          !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(file.mimeType),
      )
    )
      fail("INVALID_ATTACHMENT");
    if (snapshot.truncated) fail("SCREEN_INCOMPLETE");
    if (verifyVentureCompany(snapshot, input.businessNumber).status !== "matched")
      fail("COMPANY_UNVERIFIED");
    const targets = keys.map((key) => {
      const field = snapshot.fields.find((candidate) => candidate.key === key);
      const expectedFiles =
        input.attachments.find((attachment) => attachment.fieldKey === key)?.files ?? null;
      if (
        !field ||
        field.disabled ||
        field.readOnly ||
        new RegExp(forbidden, "i").test([field.id, field.name, ...field.labels].join(" "))
      )
        fail("TARGET_FORBIDDEN");
      if (expectedFiles) {
        if (
          field.kind !== "file" ||
          field.type !== "file" ||
          !expectedFiles.length ||
          (!field.multiple && expectedFiles.length !== 1)
        )
          fail("TARGET_FORBIDDEN");
      } else if (
        field.multiple ||
        !(
          field.kind === "textarea" ||
          (field.kind === "select" && field.type === "select-one") ||
          (field.kind === "input" && allowedTypes.has(field.type))
        )
      )
        fail("TARGET_FORBIDDEN");
      if (!field.id && !field.name) fail("TARGET_UNSTABLE");
      return {
        field,
        expectedFiles,
        expectedValue: input.fields.find((item) => item.fieldKey === key)?.value ?? null,
      };
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
    const observations: JSHandle<Observation>[] = [];
    const results: VentureInputComparisonField[] = [];
    for (const { field, expectedFiles, expectedValue } of targets) {
      assertCurrent();
      const selector = field.id
        ? `[id=${cssString(field.id)}]`
        : `[name=${cssString(field.name!)}]`;
      const locator = page.locator(selector);
      if ((await locator.count()) !== 1) fail("TARGET_CHANGED");
      const handle = await locator.elementHandle({ timeout: 3_000 });
      if (!handle) fail("TARGET_CHANGED");
      handles.push(handle);
      let observation: JSHandle<Observation>;
      try {
        observation = await handle.evaluateHandle(
          async (element, config): Promise<Observation> => {
            const control = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
            const metadata = () => {
              const matches = document.querySelectorAll(config.selector);
              const style = getComputedStyle(control);
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
                location.href !== config.rawUrl ||
                !control.isConnected ||
                control.ownerDocument !== document ||
                matches.length !== 1 ||
                matches[0] !== control ||
                control.tagName !== tag ||
                type !== config.field.type ||
                (control.id || null) !== config.field.id ||
                (control.name || null) !== config.field.name ||
                control.closest('[hidden], [aria-hidden="true"], [inert]') ||
                style.display === "none" ||
                ["hidden", "collapse"].includes(style.visibility) ||
                !control.getClientRects().length ||
                control.disabled ||
                control.matches(":disabled") ||
                ("readOnly" in control && control.readOnly) ||
                ("multiple" in control && control.multiple !== config.field.multiple)
              )
                return null;
              const labels = Array.from(control.labels ?? []).map((label) =>
                label.innerText.slice(0, 300),
              );
              for (const id of (control.getAttribute("aria-labelledby") || "")
                .split(/\s+/)
                .filter(Boolean)
                .slice(0, 8)) {
                const label = document.getElementById(id);
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
              if (new RegExp(config.forbidden, "i").test(hints)) return null;
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
                return null;
              const options =
                control.tagName === "SELECT"
                  ? Array.from((control as HTMLSelectElement).options).map((option) => ({
                      label: option.label.replace(/\s+/g, " ").trim(),
                      value: option.value,
                      disabled: option.disabled,
                    }))
                  : [];
              const optionGroups =
                control.tagName === "SELECT"
                  ? Array.from((control as HTMLSelectElement).options).map((option) =>
                      Boolean(
                        option.parentElement?.tagName === "OPTGROUP" &&
                        (option.parentElement as HTMLOptGroupElement).disabled,
                      ),
                    )
                  : [];
              const maxLength =
                "maxLength" in control && control.maxLength >= 0 ? control.maxLength : null;
              if (
                JSON.stringify(options) !== JSON.stringify(config.field.options) ||
                maxLength !== config.field.maxLength
              )
                return null;
              if (
                config.field.kind === "file" &&
                ((control as HTMLInputElement).accept !== (config.field.accept ?? "") ||
                  control.hasAttribute("webkitdirectory") ||
                  control.hasAttribute("directory"))
              )
                return null;
              let previous = control.closest("td")?.previousElementSibling;
              const headings: string[] = [];
              for (let step = 0; previous && step < 8; step++) {
                if (previous.tagName === "TH") {
                  headings.push((previous as HTMLElement).innerText.slice(0, 300));
                  break;
                }
                previous = previous.previousElementSibling;
              }
              return JSON.stringify({
                hints,
                headings,
                options,
                optionGroups,
                maxLength,
                required: control.required,
                attributes: ["aria-required", "min", "max", "step", "pattern", "maxlength"].map(
                  (name) => control.getAttribute(name),
                ),
                accept: config.field.kind === "file" ? (control as HTMLInputElement).accept : null,
              });
            };
            const signature = metadata();
            if (signature === null)
              return {
                state: "unknown",
                code: "TARGET_CHANGED",
                fatal: true,
                isCurrent: () => false,
              };
            const fileInput = control as HTMLInputElement;
            const originalFiles =
              config.expectedFiles === null
                ? null
                : fileInput.files
                  ? Array.from(fileInput.files)
                  : null;
            const originalValue = config.expectedFiles === null ? control.value : null;
            const selected =
              control.tagName === "SELECT"
                ? Array.from((control as HTMLSelectElement).selectedOptions)
                : null;
            const isCurrent = () =>
              metadata() === signature &&
              (config.expectedFiles === null
                ? control.value === originalValue &&
                  (!selected ||
                    ((control as HTMLSelectElement).selectedOptions.length === selected.length &&
                      selected.every(
                        (option, index) =>
                          (control as HTMLSelectElement).selectedOptions[index] === option,
                      )))
                : originalFiles !== null &&
                  fileInput.files !== null &&
                  fileInput.files.length === originalFiles.length &&
                  originalFiles.every((file, index) => fileInput.files![index] === file));
            const result = (
              state: Observation["state"],
              code: string | null = null,
            ): Observation => ({ state, code, fatal: false, isCurrent });
            if (config.expectedFiles === null) {
              if (originalValue === config.expectedValue) return result("matched");
              if (
                originalValue === "" &&
                (!selected || (selected.length === 1 && selected[0].value === ""))
              )
                return result("empty");
              return result("conflict");
            }
            if (!originalFiles) return result("unknown", "FILE_UNREADABLE");
            if (!originalFiles.length) return result("empty");
            if (
              originalFiles.length > 10 ||
              originalFiles.reduce((sum, file) => sum + file.size, 0) > 24 * 1024 * 1024 ||
              originalFiles.some((file) => file.size > 12 * 1024 * 1024)
            )
              return result("unknown", "FILE_LIMIT");
            if (
              originalFiles.length !== config.expectedFiles.length ||
              originalFiles.some((file, index) => {
                const expected = config.expectedFiles![index];
                return (
                  file.name !== expected.name ||
                  file.type !== expected.mimeType ||
                  file.size !== expected.size
                );
              })
            )
              return result("conflict");
            if (!globalThis.crypto?.subtle) return result("unknown", "FILE_HASH_UNAVAILABLE");
            const bounded = async <T>(operation: Promise<T>): Promise<T> => {
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                return await Promise.race([
                  operation,
                  new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error("READ_TIMEOUT")), 3_000);
                  }),
                ]);
              } finally {
                if (timer !== undefined) clearTimeout(timer);
              }
            };
            try {
              for (let index = 0; index < originalFiles.length; index++) {
                const bytes = await bounded(originalFiles[index].arrayBuffer());
                if (!isCurrent()) return { ...result("unknown", "FIELD_CHANGED"), fatal: true };
                if (bytes.byteLength !== config.expectedFiles[index].size)
                  return result("unknown", "FILE_UNREADABLE");
                const digest = await bounded(crypto.subtle.digest("SHA-256", bytes));
                if (!isCurrent()) return { ...result("unknown", "FIELD_CHANGED"), fatal: true };
                if (
                  Array.from(new Uint8Array(digest), (byte) =>
                    byte.toString(16).padStart(2, "0"),
                  ).join("") !== config.expectedFiles[index].sha256
                )
                  return result("conflict");
              }
            } catch {
              return result("unknown", "FILE_UNREADABLE");
            }
            return result("matched");
          },
          { field, selector, rawUrl, forbidden, expectedFiles, expectedValue },
        );
      } catch {
        // An isolated read failure is unknown only while every global guard still holds.
        await verify();
        results.push({
          fieldKey: field.key,
          kind: expectedFiles ? "file" : "text",
          state: "unknown",
          code: "FIELD_UNREADABLE",
        });
        continue;
      }
      handles.push(observation);
      observations.push(observation);
      const safe = await observation.evaluate(({ state, code, fatal }) => ({ state, code, fatal }));
      if (safe.fatal) fail("TARGET_CHANGED");
      assertCurrent();
      results.push({
        fieldKey: field.key,
        kind: expectedFiles ? "file" : "text",
        state: safe.state,
        code: safe.code,
      });
    }
    finalizeCurrent();
    assertCurrent();
    await verifyCurrent();
    assertCurrent();
    // The existing collector binds company/auth/metadata and values in the same synchronous DOM task.
    const final = validateVentureScreenSnapshot(
      await collectVentureScreen(page, {
        rawUrl,
        expectedSemantics: semantics(snapshot),
        observations,
      }),
    );
    assertCurrent();
    if (
      semantics(final) !== semantics(snapshot) ||
      verifyVentureCompany(final, input.businessNumber).status !== "matched"
    )
      fail("SCREEN_CHANGED");
    return { status: "completed", fields: results, code: null, observedAt: final.observedAt };
  } catch (error) {
    return {
      status: "stopped",
      fields: [],
      observedAt: null,
      code: error instanceof VentureComparisonError ? error.code : "COMPARE_FAILED",
    };
  } finally {
    await Promise.all(handles.map((handle) => handle.dispose().catch(() => undefined)));
  }
}
