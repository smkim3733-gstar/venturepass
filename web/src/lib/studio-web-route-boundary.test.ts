import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The web service cannot load playwright-core. A static import of the 벤처인 runner in a route
// the web uses made GET /api/studio/cases/[caseId] fail with 500 on Vercel (2026-10-31).
const webRoutes = [
  "src/app/api/studio/cases/[caseId]/route.ts",
  "src/app/api/studio/cases/route.ts",
];

describe("web routes keep the 벤처인 runner out of their static imports", () => {
  it.each(webRoutes)("%s", (route) => {
    const source = readFileSync(path.join(process.cwd(), route), "utf8");
    expect(source).not.toMatch(
      /^import[^;]*from "@\/lib\/venturein-(runner|service|workflow|execution)";/m,
    );
    expect(source).not.toMatch(/from "playwright-core"/);
  });
});
