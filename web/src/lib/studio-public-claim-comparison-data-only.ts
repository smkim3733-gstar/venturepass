import "server-only";
function invalid(code = "PUBLIC_COMPARISON_ARCHIVE_INVALID"): never { throw new Error(code); }

/** Reject accessors, hooks, cycles and oversized supplied copies before schema parsing.
 * Repeated references are allowed; they are copied by the schemas, never treated as authority. */
export function assertPublicComparisonDataOnly(value: unknown, limit = 600 * 1024 * 1024) {
  let size = 0, nodes = 0;
  const seen = new Set<object>();
  function visit(v: unknown, depth: number) {
    if (++nodes > 1000000 || depth > 100) invalid();
    if (typeof v === "string") size += Buffer.byteLength(v);
    else if (typeof v === "number") { if (!Number.isFinite(v)) invalid(); }
    else if (v === null || typeof v === "boolean") { /* JSON scalar */ }
    else if (typeof v === "object") {
      if (v instanceof Uint8Array) {
        if (![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(v))) invalid();
        for (const key of Reflect.ownKeys(v)) {
          if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) invalid();
        }
        size += v.byteLength;
      }
      else {
        if (seen.has(v) || (!Array.isArray(v) && ![Object.prototype, null].includes(Object.getPrototypeOf(v)))) invalid();
        seen.add(v);
        for (const key of Reflect.ownKeys(v)) {
          if (typeof key !== "string") invalid();
          const d = Object.getOwnPropertyDescriptor(v, key)!;
          if (!("value" in d) || (!d.enumerable && !(Array.isArray(v) && key === "length"))) invalid();
          if (Array.isArray(v) && key === "length") continue;
          if (Array.isArray(v) && !/^(0|[1-9][0-9]*)$/.test(key)) invalid();
          size += Buffer.byteLength(key);
          visit(d.value, depth + 1);
        }
        seen.delete(v);
      }
    } else invalid();
    if (size > limit) invalid("PUBLIC_COMPARISON_ARCHIVE_LIMIT");
  }
  visit(value, 0);
}
