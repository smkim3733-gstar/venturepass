import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const scope = vi.hoisted(() => ({ root: "" }));
vi.mock("node:os", async (original) => {
  const actual = await original<typeof import("node:os")>();
  return { ...actual, tmpdir: () => scope.root || actual.tmpdir() };
});
import { runWindowsOcr } from "./studio-windows-ocr";

function syntheticPdf() {
  const content = "BT /F1 36 Tf 40 700 Td (VENTURE 2026) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n `)
    .join("\n")}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
describe.skipIf(process.platform !== "win32" || process.env.VENTURE_TEST_OCR !== "1")(
  "Windows ko 실제 runtime — 합성 문서만",
  () => {
    beforeAll(() => {
      scope.root = mkdtempSync(path.join(tmpdir(), "venturepass-ocr-smoke-"));
    });
    afterAll(() => {
      for (const name of ["make.png.ps1", "synthetic.png"]) {
        try {
          unlinkSync(path.join(scope.root, name));
        } catch {}
      }
      rmdirSync(scope.root);
      scope.root = "";
    });
    it("합성 PDF 페이지를 로컬 렌더하고 주요 영문·숫자를 판독한다", async () => {
      const result = await runWindowsOcr(syntheticPdf(), "application/pdf");
      expect(result.pages).toHaveLength(1);
      expect(result.pages[0].text).toMatch(/VENTURE/i);
      expect(result.pages[0].text).toContain("2026");
      expect(readdirSync(scope.root)).toEqual([]);
    }, 40_000);
    it("합성 PNG의 한국어·숫자를 로컬 판독하고 임시 OCR 원본을 제거한다", async () => {
      const program = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap(1600, 500)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$font = New-Object System.Drawing.Font('Malgun Gothic', 70)
try {
    $graphics.Clear([System.Drawing.Color]::White)
    $graphics.DrawString('벤처기업 2026', $font, [System.Drawing.Brushes]::Black, 60, 150)
    $bitmap.Save((Join-Path $PSScriptRoot 'synthetic.png'), [System.Drawing.Imaging.ImageFormat]::Png)
} finally { $font.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
`;
      const script = path.join(scope.root, "make.png.ps1");
      writeFileSync(script, `\uFEFF${program}`);
      execFileSync(
        path.join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
        { windowsHide: true, stdio: "ignore", timeout: 20_000 },
      );
      const result = await runWindowsOcr(
        readFileSync(path.join(scope.root, "synthetic.png")),
        "image/png",
      );
      expect(result.pages).toHaveLength(1);
      expect(result.pages[0].text).toContain("2026");
      expect(result.pages[0].text.replace(/\s/g, "")).toContain("벤처기업");
      expect(readdirSync(scope.root).sort()).toEqual(["make.png.ps1", "synthetic.png"]);
    }, 40_000);
  },
);
