import "server-only";

import { randomUUID } from "node:crypto";
import type { JSHandle, Page } from "playwright-core";
import {
  VentureInspectionError,
  validateVentureScreenSnapshot,
  sanitizeVentureInspectionUrl,
  ventureInspectionRules,
  type VentureScreenSnapshot,
  type VentureScreenField,
  type VentureCompanyEvidence,
} from "./venturein-inspection";

const { companyLabels, inputTypes } = ventureInspectionRules;
const secretPattern = new RegExp(ventureInspectionRules.secretPatternSource, "i");

export type VentureAtomicInspectionGuard = {
  rawUrl: string;
  expectedSemantics: string;
  observations: JSHandle<{ isCurrent: () => boolean }>[];
};

type VentureBrowserInspectionGuard = { isCurrent: () => boolean };
type VentureBrowserInspectionConfig = {
  url: string;
  companyLabels: typeof companyLabels;
  inputTypes: readonly string[];
  secretSource: string;
  guard: {
    rawUrl: string;
    expectedSemantics: string;
    observations: VentureBrowserInspectionGuard[];
  } | null;
  capture: boolean;
};

// This self-contained callback runs in the browser. Both APIs use the same synchronous reader.
function readInspectionInBrowser(
  config: VentureBrowserInspectionConfig,
): Omit<VentureScreenSnapshot, "id"> | VentureBrowserInspectionGuard {
  const capturedDocument = document;
  const read = () => {
    if (document !== capturedDocument) throw new Error("Screen changed");
    const safeUrl = () => `${location.origin}${location.pathname}`;
    if (safeUrl() !== config.url) throw new Error("Screen changed");
    const secret = new RegExp(config.secretSource, "i");
    let truncated = false;
    const limit = (value: string, max: number) => {
      if (value.length > max) truncated = true;
      return value.slice(0, max);
    };
    const clean = (value: string) => value.replace(/\s+/g, " ").trim();
    const visible = (element: Element) => {
      if (element.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
      const style = getComputedStyle(element);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.visibility !== "collapse" &&
        element.getClientRects().length > 0
      );
    };
    const text = (element: Element, max = 300) =>
      limit(clean((element as HTMLElement).innerText || ""), max);
    const authContext = (element: Element) => {
      const form = element.closest("form");
      if (!form) return false;
      return (
        Boolean(
          form.querySelector(
            'input[type="password"],input[autocomplete="one-time-code"],input[autocomplete="current-password"],input[autocomplete="new-password"]',
          ),
        ) ||
        /login|sign.?in|\/auth(?:\/|$)/i.test(
          [form.id, form.getAttribute("name"), form.getAttribute("action")].join(" "),
        )
      );
    };
    const labelsFor = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) => {
      const labels: string[] = [];
      const requiredLabels: string[] = [];
      let sharedRequiredLabel = false;
      const addLabel = (value: string) => {
        labels.push(value);
        requiredLabels.push(value);
      };
      for (const label of Array.from(element.labels || []))
        if (visible(label)) addLabel(text(label));
      const aria = element.getAttribute("aria-label");
      if (aria) addLabel(limit(clean(aria), 300));
      for (const reference of (element.getAttribute("aria-labelledby") || "")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 8)) {
        const label = document.getElementById(reference);
        if (label && visible(label)) addLabel(text(label));
      }
      if (!labels.some(Boolean)) {
        for (const attribute of ["title", "placeholder"]) {
          const fallback = element.getAttribute(attribute);
          if (fallback) addLabel(limit(clean(fallback), 300));
        }
      }
      // Generic table semantics only; no portal-specific field selectors are assumed.
      const cell = element.closest("td");
      let previous = cell?.previousElementSibling;
      for (let step = 0; previous && step < 8; step += 1) {
        if (previous.tagName === "TH") {
          if (visible(previous)) {
            const heading = text(previous);
            labels.push(heading);
            // A shared or more distant header cannot establish one control's requirement.
            if (step === 0 && cell) {
              const controls = Array.from(cell.querySelectorAll("input, textarea, select")).filter(
                (control) => visible(control) && !control.matches('[type="hidden"]'),
              );
              if (controls.length === 1 && controls[0] === element) requiredLabels.push(heading);
              else if (/필수|[*＊]/.test(heading)) sharedRequiredLabel = true;
            }
          }
          break;
        }
        previous = previous.previousElementSibling;
      }
      const unique = [...new Set(labels.filter(Boolean))];
      if (unique.length > 8) truncated = true;
      return { labels: unique.slice(0, 8), requiredLabels, sharedRequiredLabel };
    };
    const requiredLabelStatus = (labels: string[], shared: boolean) => {
      const explicit = labels.some((label) =>
        /[*＊]\s*필수\s*(?:입력|선택)?(?=$|[\s·:：()[\]])|\[\s*필수(?:\s*(?:입력|선택))?\s*\]|\(\s*필수(?:\s*(?:입력|선택))?\s*\)|(?:^|\s)필수\s*입력(?=$|\s)/.test(
          label,
        ),
      );
      const negative = labels.some(
        (label) =>
          /필수[^·:：]{0,16}(?:아님|아니|아닌|아닙|없|않)/.test(label.replace(/[()[\]]/g, "")) ||
          /선택\s*(?:사항|입력|항목)|\[\s*선택\s*\]|\(\s*선택\s*\)/.test(label),
      );
      const conditional = labels.some((label) =>
        /경우|조건|해당\s*시|필요\s*시|일\s*때|라면/.test(label),
      );
      return {
        required: explicit && !negative && !conditional,
        ambiguous:
          shared ||
          (explicit && (negative || conditional)) ||
          (!explicit && !negative && labels.some((label) => /필수|[*＊]/.test(label))),
      };
    };
    const safeControl = (
      element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
      labels: string[],
    ) => {
      if (!visible(element) || authContext(element)) return false;
      return !secret.test(
        [element.id, element.name, element.getAttribute("autocomplete"), ...labels].join(" "),
      );
    };
    const disabledControl = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) =>
      element.disabled || element.matches(":disabled");
    const fixedCompanyControl = (
      element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    ) => disabledControl(element) || ("readOnly" in element && element.readOnly);
    const companyEvidence: VentureCompanyEvidence[] = [];
    const addEvidence = (
      label: string,
      value: string,
      source: VentureCompanyEvidence["source"],
    ) => {
      const kind = (Object.keys(config.companyLabels) as VentureCompanyEvidence["kind"][]).find(
        (key) => (config.companyLabels[key] as readonly string[]).includes(label),
      );
      const cleaned = clean(value);
      if (!kind || !cleaned) return;
      if (companyEvidence.length >= 20) {
        truncated = true;
        return;
      }
      const result = { kind, label, value: limit(cleaned, 200), source };
      if (
        !companyEvidence.some(
          (item) =>
            item.kind === kind &&
            item.label === label &&
            item.value === result.value &&
            item.source === source,
        )
      )
        companyEvidence.push(result);
    };
    const knownLabel = (label: string) =>
      Object.values(config.companyLabels).some((list) =>
        (list as readonly string[]).includes(label),
      );
    const fields: VentureScreenField[] = [];
    let unsupportedRequired = false;
    let unsupportedOptional = false;
    let ambiguousRequired = false;
    let remainingOptions = 500;
    const candidateControls = Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        "input, textarea, select",
      ),
    );
    if (candidateControls.length > 1200) truncated = true;
    for (const element of candidateControls.slice(0, 1200)) {
      const type =
        element.tagName === "TEXTAREA"
          ? "textarea"
          : element.tagName === "SELECT"
            ? (element as HTMLSelectElement).multiple
              ? "select-multiple"
              : "select-one"
            : (element as HTMLInputElement).type.toLowerCase();
      if (element.tagName === "INPUT" && type !== "file" && !config.inputTypes.includes(type))
        continue;
      const { labels, requiredLabels, sharedRequiredLabel } = labelsFor(element);
      if (!safeControl(element, labels)) continue;
      const labelRequirement = requiredLabelStatus(requiredLabels, sharedRequiredLabel);
      if (labelRequirement.ambiguous) ambiguousRequired = true;
      const required =
        element.required ||
        element.getAttribute("aria-required") === "true" ||
        labelRequirement.required;
      if (["checkbox", "radio"].includes(type)) {
        if (required) unsupportedRequired = true;
        else unsupportedOptional = true;
      }
      if (fields.length >= 150) {
        truncated = true;
        break;
      }
      const kind =
        type === "file"
          ? "file"
          : element.tagName === "TEXTAREA"
            ? "textarea"
            : element.tagName === "SELECT"
              ? "select"
              : "input";
      const options: VentureScreenField["options"] = [];
      if (kind === "select") {
        const select = element as HTMLSelectElement;
        const count = Math.min(100, remainingOptions);
        if (select.options.length > count) truncated = true;
        for (const option of Array.from(select.options).slice(0, count))
          options.push({
            label: limit(clean(option.label), 300),
            value: limit(option.value, 300),
            disabled: option.disabled,
          });
        remainingOptions -= options.length;
      }
      const maxLength =
        "maxLength" in element && typeof element.maxLength === "number" && element.maxLength >= 0
          ? element.maxLength
          : null;
      fields.push({
        key: `field-${fields.length + 1}`,
        kind,
        id: element.id ? limit(element.id, 200) : null,
        name: element.name ? limit(element.name, 200) : null,
        type,
        labels,
        required,
        maxLength,
        accept: kind === "file" ? limit((element as HTMLInputElement).accept, 500) : null,
        multiple: "multiple" in element && Boolean(element.multiple),
        disabled: disabledControl(element),
        readOnly: "readOnly" in element && Boolean(element.readOnly),
        options,
      });
      // These are the only ordinary field values this collector is allowed to read.
      if (kind === "input" && !["checkbox", "radio"].includes(type) && fixedCompanyControl(element))
        for (const label of labels)
          if (knownLabel(label)) addEvidence(label, element.value, "input");
    }
    const semanticLabels = Array.from(document.querySelectorAll("th, dt"));
    if (semanticLabels.length > 1200) truncated = true;
    for (const labelElement of semanticLabels.slice(0, 1200)) {
      if (!visible(labelElement) || authContext(labelElement)) continue;
      const label = text(labelElement);
      if (!knownLabel(label)) continue;
      const valueElement = labelElement.nextElementSibling;
      if (
        !valueElement ||
        !visible(valueElement) ||
        (labelElement.tagName === "TH"
          ? valueElement.tagName !== "TD"
          : valueElement.tagName !== "DD")
      )
        continue;
      const controls = Array.from(
        valueElement.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
          "input, textarea, select",
        ),
      );
      let value = "";
      if (controls.length === 0) value = text(valueElement, 200);
      else if (controls.length === 1) {
        const control = controls[0];
        if (
          control.tagName === "INPUT" &&
          config.inputTypes.includes((control as HTMLInputElement).type) &&
          !["checkbox", "radio"].includes((control as HTMLInputElement).type) &&
          safeControl(control, [label]) &&
          fixedCompanyControl(control)
        )
          value = control.value;
      }
      addEvidence(label, value, labelElement.tagName === "TH" ? "table" : "definition");
    }
    if (safeUrl() !== config.url) throw new Error("Screen changed");
    const warnings: string[] = [];
    const inaccessibleControls = Array.from(
      document.querySelectorAll('iframe, [contenteditable]:not([contenteditable="false"])'),
    );
    if (inaccessibleControls.length > 200) truncated = true;
    if (inaccessibleControls.slice(0, 200).some(visible)) {
      truncated = true;
      warnings.push(
        "UNINSPECTED_EMBEDDED_CONTROL: 표시된 외부 프레임·편집 영역을 확인하지 못했습니다. 공식 화면에서 별도 확인이 필요합니다.",
      );
    }
    if (unsupportedRequired)
      warnings.push("UNSUPPORTED_REQUIRED_CONTROL: 필수 선택·동의 항목은 별도 확인이 필요합니다.");
    if (unsupportedOptional)
      warnings.push(
        "UNSUPPORTED_CONTROL: 선택·동의 항목은 자동 처리하지 않으며 공식 화면에서 별도 확인이 필요합니다.",
      );
    if (ambiguousRequired)
      warnings.push(
        "AMBIGUOUS_REQUIRED_LABEL: 일부 항목의 필수 표시가 조건부이거나 여러 입력에 걸쳐 있어 확정하지 못했습니다. 공식 화면에서 별도 확인해 주세요.",
      );
    const title = limit(clean(document.title), 200);
    if (truncated)
      warnings.push("화면 수집 한도를 초과한 내용이 있습니다. 일부 항목을 확인하지 못했습니다.");
    const screen = { url: safeUrl(), title, companyEvidence, fields, truncated, warnings };
    if (config.guard) {
      // One synchronous browser task binds authentication, company evidence, complete metadata,
      // and every selected value/File identity. No company selectors are duplicated by callers.
      const actions = Array.from(
        document.querySelectorAll('a, button, [role="link"], [role="button"]'),
      );
      const accessibleName = (element: Element) => {
        const explicit = element.getAttribute("aria-label");
        if (explicit) return clean(explicit);
        const references = (element.getAttribute("aria-labelledby") || "")
          .split(/\s+/)
          .filter(Boolean);
        if (references.length)
          return clean(
            references
              .slice(0, 8)
              .map((id) => {
                const label = document.getElementById(id);
                return label ? (label as HTMLElement).innerText : "";
              })
              .join(" "),
          );
        return clean((element as HTMLElement).innerText || "");
      };
      const hasLogout =
        actions.length <= 1200 &&
        actions.some((element) => {
          const role = element.getAttribute("role");
          const semanticAction =
            role !== null
              ? ["link", "button"].includes(clean(role))
              : element.tagName === "BUTTON" ||
                (element.tagName === "A" && element.getAttribute("href") !== null);
          return semanticAction && visible(element) && accessibleName(element) === "로그아웃";
        });
      const hasAuthentication =
        candidateControls.length > 1200 ||
        candidateControls.some(
          (element) =>
            visible(element) &&
            ((element as HTMLInputElement).type === "password" ||
              authContext(element) ||
              secret.test(
                [
                  element.id,
                  element.name,
                  ...labelsFor(element).labels,
                  ...["autocomplete", "title", "aria-label", "placeholder"].map((name) =>
                    element.getAttribute(name),
                  ),
                ].join(" "),
              )),
        );
      if (
        location.href !== config.guard.rawUrl ||
        !hasLogout ||
        hasAuthentication ||
        truncated ||
        inaccessibleControls.some(visible) ||
        JSON.stringify(screen) !== config.guard.expectedSemantics ||
        !config.guard.observations.every((observation) => observation.isCurrent())
      )
        throw new Error("Atomic comparison changed");
    }
    return { ...screen, observedAt: new Date().toISOString() };
  };
  if (!config.capture) return read();
  if (!config.guard) throw new Error("Atomic guard required");
  read();
  return {
    isCurrent: () => {
      try {
        read();
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Read only semantic labels and control metadata. No arbitrary input values, HTML or browser storage. */
export async function collectVentureScreen(
  page: Page,
  guard?: VentureAtomicInspectionGuard,
): Promise<VentureScreenSnapshot> {
  const initialUrl = sanitizeVentureInspectionUrl(page.url());
  if (!initialUrl || page.isClosed())
    throw new VentureInspectionError(
      "UNVERIFIED_SCREEN",
      "열린 공식 벤처인 신청 화면에서만 확인할 수 있습니다. 로그인·보안 설치 화면에서는 수집하지 않습니다.",
    );
  try {
    const observed = await page.evaluate(readInspectionInBrowser, {
      url: initialUrl,
      companyLabels,
      inputTypes,
      secretSource: secretPattern.source,
      guard: guard ?? null,
      capture: false,
    });
    if (
      !("observedAt" in observed) ||
      page.isClosed() ||
      sanitizeVentureInspectionUrl(page.url()) !== initialUrl ||
      (guard && page.url() !== guard.rawUrl)
    )
      throw new Error("Screen changed");
    return validateVentureScreenSnapshot({
      ...observed,
      id: randomUUID(),
      observedAt: guard ? observed.observedAt : new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof VentureInspectionError) throw error;
    throw new VentureInspectionError(
      "SCREEN_READ_FAILED",
      "공식 화면의 표시 항목을 확인하지 못했습니다. 같은 화면을 유지한 뒤 다시 확인해 주세요.",
    );
  }
}

/** Capture a browser-only context check for the same task as a native value setter. */
export async function captureVentureInspectionGuard(
  page: Page,
  guard: VentureAtomicInspectionGuard,
): Promise<JSHandle<{ isCurrent: () => boolean }>> {
  const initialUrl = sanitizeVentureInspectionUrl(page.url());
  if (!initialUrl || page.isClosed() || page.url() !== guard.rawUrl)
    throw new VentureInspectionError(
      "UNVERIFIED_SCREEN",
      "열린 공식 벤처인 신청 화면에서만 확인할 수 있습니다. 로그인·보안 설치 화면에서는 수집하지 않습니다.",
    );
  let captured: JSHandle<Omit<VentureScreenSnapshot, "id"> | VentureBrowserInspectionGuard> | null =
    null;
  try {
    captured = await page.evaluateHandle(readInspectionInBrowser, {
      url: initialUrl,
      companyLabels,
      inputTypes,
      secretSource: secretPattern.source,
      guard,
      capture: true,
    });
    if (
      page.isClosed() ||
      sanitizeVentureInspectionUrl(page.url()) !== initialUrl ||
      page.url() !== guard.rawUrl
    )
      throw new Error("Screen changed");
    // capture:true returns only this closure; screen evidence never leaves the browser.
    return captured as JSHandle<VentureBrowserInspectionGuard>;
  } catch {
    await captured?.dispose().catch(() => {});
    throw new VentureInspectionError(
      "SCREEN_READ_FAILED",
      "공식 화면의 표시 항목을 확인하지 못했습니다. 같은 화면을 유지한 뒤 다시 확인해 주세요.",
    );
  }
}
