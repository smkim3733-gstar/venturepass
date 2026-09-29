import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import historicalSuites from "./scripts/provider-historical-test-suites.json" with { type: "json" };

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    restoreMocks: true,
    projects: [
      {
        extends: true,
        test: {
          name: "current",
          include: ["src/**/*.test.ts"],
          exclude: historicalSuites,
        },
      },
      {
        extends: true,
        test: {
          name: "provider-history-20260927",
          // Explicit frozen list. New suites use current evidence unless deliberately added here.
          include: historicalSuites,
          alias: [
            {
              find: /^(?:.*\/)studio-plan-quality-provider-configuration-current(?:\.ts)?$/,
              replacement: fileURLToPath(
                new URL(
                  "./src/lib/studio-plan-quality-provider-configuration-20260927-test-fixture.ts",
                  import.meta.url,
                ),
              ),
            },
          ],
        },
      },
    ],
  },
});
