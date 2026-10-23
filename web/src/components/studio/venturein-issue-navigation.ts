import type { VentureScreenField } from "@/lib/venturein-inspection";
import { ventureFieldSupport } from "@/lib/venturein-preflight";

/** Resolve against the entire observed screen; never guess from a repeated label or key. */
export function ventureIssueFieldTarget(fields: VentureScreenField[], fieldKey?: string) {
  if (!fieldKey) return null;
  const matches = fields.filter((field) => field.key === fieldKey);
  if (matches.length !== 1) return null;
  const field = matches[0];
  const kind = ventureFieldSupport(field);
  if (kind === "unsupported") return null;
  const index = fields.filter((item) => ventureFieldSupport(item) === kind).indexOf(field);
  return {
    id: `venture-${kind}-${index}`,
    label: field.labels.join(" · ") || field.name || field.id || "이름 없는 항목",
  };
}
