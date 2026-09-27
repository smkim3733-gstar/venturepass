import { caseSchema, type StudioCase } from "@/lib/studio-schema";

/** Validate the company before its response can replace the open editor. */
export function studioMutationResponse(
  value: unknown,
  binding: Pick<StudioCase, "id" | "revision">,
): StudioCase {
  const parsed = caseSchema.safeParse(value);
  // Idempotent replays may return the same revision. Operation-specific receipts
  // and source changes are checked by the caller before closing its draft.
  if (!parsed.success || parsed.data.id !== binding.id || parsed.data.revision < binding.revision)
    throw new Error("저장 응답이 현재 기업·버전과 일치하지 않습니다. 입력 내용을 유지했습니다.");
  return parsed.data;
}
