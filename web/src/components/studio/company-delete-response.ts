/** A successful route acknowledgement, not proof of database or original-file removal. */
export function companyDeletionAcknowledged(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    "ok" in value &&
    value.ok === true
  );
}
