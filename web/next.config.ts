import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["pdf-parse", "mammoth", "exceljs", "playwright-core"],
  outputFileTracingIncludes: { "/*": ["./data/*.json"] },
};

export default nextConfig;
