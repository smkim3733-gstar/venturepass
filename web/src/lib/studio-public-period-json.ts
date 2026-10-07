/** Only after bounded UTF-8 decoding and JSON.parse.
 * PRD supports arrays of flat records. Count original row properties so
 * duplicate names (including escaped names) cannot disappear during parsing.
 * Unsupported/nested shapes remain the strict decoder's responsibility.
 */
export function hasDuplicatePublicPeriodProperties(text: string, body: unknown): boolean {
  if (!Array.isArray(body)) return false;
  if (body.some((row) => !row || typeof row !== "object" || Array.isArray(row))) return false;
  const uniqueProperties = body.reduce((sum, row) => sum + Object.keys(row).length, 0);
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
    else if (char === ":" && depth === 2) properties++;
  }
  return properties !== uniqueProperties;
}
