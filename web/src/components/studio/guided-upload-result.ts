import { caseSchema, type StudioCase } from "@/lib/studio-schema";

/** A successful HTTP response must contain the newly stored file, not a stale case. */
export function guidedUploadResult(value: unknown, base: StudioCase, fileName: string) {
  const parsed = caseSchema.safeParse(value);
  if (!parsed.success) return null;
  const company = parsed.data;
  if (
    company.id !== base.id ||
    company.revision <= base.revision ||
    company.sources.length !== base.sources.length + 1 ||
    base.sources.some((source) => !company.sources.some((item) => item.id === source.id))
  )
    return null;
  const source = company.sources.find((item) => !base.sources.some((old) => old.id === item.id));
  if (!source || source.originalName !== fileName.trim()) return null;
  return { company, source };
}
