/** Fixed application guidance; provider messages must never be displayed. */
export const publicCommentNoResultsCode = "PUBLIC_COMMENT_NO_RESULTS";
export const publicCommentNoResultsMessage =
  "KOSIS가 이번 주석 요청에 조회결과 없음 오류를 반환했습니다. 주석 원문은 읽지 못했으며, 표 전체에 주석이 없다는 뜻은 아닙니다. 필요하면 통계표 원문에서 확인해 주세요.";

/** Called only after bounded, fatal UTF-8 decoding and strict JSON.parse.
 * Accept just err:"30" with an optional string errMsg; never use its text.
 * Counting top-level properties in the original JSON rejects duplicates that
 * JSON.parse otherwise discards, including escaped property names.
 */
export function isSupportedCommentNoResults(text: string, body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  const keys = Object.keys(value);
  if (
    !Object.hasOwn(value, "err") ||
    value.err !== "30" ||
    keys.some((key) => key !== "err" && key !== "errMsg") ||
    (Object.hasOwn(value, "errMsg") && typeof value.errMsg !== "string")
  )
    return false;
  let depth = 0;
  let inString = false;
  let properties = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === "\\") i++;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
    else if (char === ":" && depth === 1) properties++;
  }
  return properties === keys.length;
}
