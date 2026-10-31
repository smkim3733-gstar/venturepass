/**
 * Load pdf-parse for Node and serverless functions. The worker entry must load first: it
 * installs the @napi-rs/canvas polyfills (DOMMatrix, Path2D, ImageData) that pdfjs needs.
 * Without them the Vercel function cannot read any PDF text.
 */
export async function loadPdfParse() {
  const { CanvasFactory } = await import("pdf-parse/worker");
  const { PDFParse } = await import("pdf-parse");
  return { PDFParse, CanvasFactory };
}
