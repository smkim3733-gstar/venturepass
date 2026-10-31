import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["pdf-parse", "@napi-rs/canvas", "mammoth", "exceljs", "playwright-core"],
  outputFileTracingIncludes: {
    "/*": ["./data/*.json"],
    // pdfjs loads the canvas polyfill with a runtime require that tracing cannot see.
    "/api/studio/**": ["./node_modules/@napi-rs/**", "./node_modules/.pnpm/@napi-rs+canvas*/**"],
  },
};

export default nextConfig;
