import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
// Server wiring: the Postgres client, auth and storage keys must never be bundled for browsers.
const serverOnly = [
  "lib/studio-route.ts",
  "lib/studio-server-bootstrap.ts",
  "lib/studio-supabase-auth.ts",
  "lib/studio-postgres-repository.ts",
];
const serverPackages = ["postgres", "@electric-sql/pglite"];

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}
function resolveLocal(from: string, specifier: string) {
  const base = specifier.startsWith("@/")
    ? join(root, specifier.slice(2))
    : resolve(dirname(from), specifier);
  return ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]
    .map((suffix) => base + suffix)
    .find((path) => existsSync(path) && statSync(path).isFile());
}
/** Value imports only (static, dynamic and re-exports); `import type` is erased by the compiler. */
function imports(path: string) {
  const source = readFileSync(path, "utf8");
  const found: string[] = [];
  const pattern =
    /(?:^|\n)\s*(import|export)\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(pattern)) found.push(match[2] ?? match[3]);
  return found;
}

describe("browser bundle boundary", () => {
  it("keeps server wiring out of every client component's import graph", () => {
    const entries = files(join(root, "components"))
      .concat(files(join(root, "app")))
      .filter((path) => /^["']use client["']/.test(readFileSync(path, "utf8").trimStart()));
    expect(entries.length).toBeGreaterThan(10);
    const leaks: string[] = [];
    const seen = new Set<string>();
    const queue = entries.map((path) => ({ path, chain: [relative(root, path)] }));
    while (queue.length) {
      const { path, chain } = queue.shift()!;
      if (seen.has(path)) continue;
      seen.add(path);
      for (const specifier of imports(path)) {
        if (serverPackages.includes(specifier)) {
          leaks.push([...chain, specifier].join(" -> "));
          continue;
        }
        if (!specifier.startsWith(".") && !specifier.startsWith("@/")) continue;
        const target = resolveLocal(path, specifier);
        if (!target) continue;
        const name = relative(root, target).replaceAll("\\", "/");
        if (serverOnly.includes(name)) leaks.push([...chain, name].join(" -> "));
        else queue.push({ path: target, chain: [...chain, name] });
      }
    }
    expect(leaks).toEqual([]);
  });
});
