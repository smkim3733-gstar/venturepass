"use client";

import type { ReactNode } from "react";
import type { VentureGuidedSection } from "@/lib/venturein-guided-navigation";

export type VentureDisclosureSection = VentureGuidedSection | "attachments";

// Native details keeps children mounted. The constant initial open prop is never
// changed by React; native toggles and the one-time guided entry own disclosure only.
export function VentureinDisclosure({
  section,
  label,
  title,
  badge,
  children,
}: {
  section: VentureDisclosureSection;
  label: string;
  title: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      data-venture-section={section}
      tabIndex={-1}
      aria-label={label}
      className="min-w-0 rounded-2xl border p-5"
    >
      <details open data-venture-disclosure={section} className="group/venture-step min-w-0">
        <summary className="cursor-pointer rounded text-sm font-bold focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary">
          {title} {badge}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            <span className="group-open/venture-step:hidden">펼치기</span>
            <span className="hidden group-open/venture-step:inline">접기</span>
          </span>
        </summary>
        <div className="mt-4 min-w-0 space-y-4">{children}</div>
      </details>
    </section>
  );
}

export function ventureDisclosureSections(
  section: VentureGuidedSection,
): VentureDisclosureSection[] {
  return section === "mapping" ? ["mapping", "attachments"] : [section];
}

export function showVentureDisclosureStep(root: HTMLElement, section: VentureGuidedSection) {
  const destination = root.querySelector<HTMLElement>(`[data-venture-section="${section}"]`);
  const target = root.querySelector<HTMLDetailsElement>(
    `details[data-venture-disclosure="${section}"]`,
  );
  if (!destination || !target) return null;
  const visible = ventureDisclosureSections(section);
  root.querySelectorAll<HTMLDetailsElement>("details[data-venture-disclosure]").forEach((node) => {
    node.open = visible.includes(node.dataset.ventureDisclosure as VentureDisclosureSection);
  });
  return destination;
}

export function expandVentureDisclosures(root: HTMLElement | null) {
  root?.querySelectorAll<HTMLDetailsElement>("details[data-venture-disclosure]").forEach((node) => {
    node.open = true;
  });
}
