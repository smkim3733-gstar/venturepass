import { describe, expect, it } from "vitest";
import { localOcrSaveAcknowledged } from "./local-ocr-response";
import {
  ocrReceiptFixture,
  ocrReceiptResult,
  ocrId,
} from "../../../scripts/fixtures/local-ocr-receipt";
import type { StudioCase } from "@/lib/studio-schema";
describe("local OCR correction acknowledgement", () => {
  it("accepts exact trimmed correction and preserves the request", async () => {
    const f = await ocrReceiptFixture();
    const original = JSON.stringify(f);
    expect(await localOcrSaveAcknowledged(f.result, f.company, f.command)).toBe(true);
    expect(JSON.stringify(f)).toBe(original);
  });
  it("accepts a first review", async () => {
    const f = await ocrReceiptFixture();
    f.company.sourceOcrReviews = [];
    expect(
      await localOcrSaveAcknowledged(
        await ocrReceiptResult(f.company, f.command),
        f.company,
        f.command,
      ),
    ).toBe(true);
  });
  const changes: [string, (c: StudioCase) => void][] = [
    [
      "missing receipt",
      (c) => {
        c.sourceOcrReviews.pop();
      },
    ],
    [
      "extra receipt",
      (c) => {
        c.sourceOcrReviews.push({
          ...c.sourceOcrReviews[1],
          id: ocrId(98),
          clientRequestId: ocrId(99),
        });
      },
    ],
    [
      "past receipt changed",
      (c) => {
        c.sourceOcrReviews[0].textSha256 = "e".repeat(64);
      },
    ],
    [
      "receipt order",
      (c) => {
        c.sourceOcrReviews.reverse();
      },
    ],
    [
      "duplicate receipt id",
      (c) => {
        c.sourceOcrReviews[1].id = c.sourceOcrReviews[0].id;
      },
    ],
    [
      "duplicate nonce",
      (c) => {
        c.sourceOcrReviews[1].clientRequestId = c.sourceOcrReviews[0].clientRequestId;
      },
    ],
    [
      "other nonce",
      (c) => {
        c.sourceOcrReviews[1].clientRequestId = ocrId(50);
      },
    ],
    [
      "other receipt source",
      (c) => {
        c.sourceOcrReviews[1].sourceId = ocrId(2);
      },
    ],
    [
      "other original hash",
      (c) => {
        c.sourceOcrReviews[1].originalSha256 = "f".repeat(64);
      },
    ],
    [
      "other text hash",
      (c) => {
        c.sourceOcrReviews[1].textSha256 = "f".repeat(64);
      },
    ],
    [
      "other input hash",
      (c) => {
        c.sourceOcrReviews[1].inputDigest = "f".repeat(64);
      },
    ],
    [
      "other receipt timestamp",
      (c) => {
        c.sourceOcrReviews[1].sourceUpdatedAt = "2026-10-12T06:00:00.000Z";
      },
    ],
    [
      "different text",
      (c) => {
        c.sources[0].text += "다른 본문";
      },
    ],
    [
      "untrimmed text",
      (c) => {
        c.sources[0].text = " " + c.sources[0].text;
      },
    ],
    [
      "unreviewed source",
      (c) => {
        c.sources[0].extraction = "pending";
        c.sources[0].text = "";
      },
    ],
    [
      "wrong extraction",
      (c) => {
        c.sources[0].extraction = "ai";
      },
    ],
    [
      "missing warning",
      (c) => {
        c.sources[0].warnings = [];
      },
    ],
    [
      "extra warning",
      (c) => {
        c.sources[0].warnings.push("다른 안내");
      },
    ],
    [
      "other original name",
      (c) => {
        c.sources[0].originalName = "other.pdf";
      },
    ],
    [
      "other mime",
      (c) => {
        c.sources[0].mimeType = "image/png";
      },
    ],
    [
      "other source title",
      (c) => {
        c.sources[0].name = "다른 제목";
      },
    ],
    [
      "other source kind",
      (c) => {
        c.sources[0].kind = "finance";
      },
    ],
    [
      "other creation time",
      (c) => {
        c.sources[0].createdAt = "2026-10-12T00:00:00.000Z";
      },
    ],
    [
      "same source time",
      (c) => {
        c.sources[0].updatedAt = "2026-10-11T00:00:00.000Z";
      },
    ],
    [
      "invalid source time",
      (c) => {
        c.sources[0].updatedAt = "invalid";
      },
    ],
    [
      "earlier source time",
      (c) => {
        c.sources[0].updatedAt = "2026-10-10T00:00:00.000Z";
      },
    ],
    [
      "other source changed",
      (c) => {
        c.sources[1].text = "달라진 자료";
      },
    ],
    [
      "missing source",
      (c) => {
        c.sources.pop();
      },
    ],
    [
      "extra source",
      (c) => {
        c.sources.push({ ...c.sources[1], id: ocrId(33) });
      },
    ],
    [
      "source order",
      (c) => {
        c.sources.reverse();
      },
    ],
    [
      "duplicate source",
      (c) => {
        c.sources[1].id = c.sources[0].id;
      },
    ],
    [
      "other company",
      (c) => {
        c.id = ocrId(99);
      },
    ],
    [
      "same revision",
      (c) => {
        c.revision = 4;
      },
    ],
    [
      "unsafe revision",
      (c) => {
        c.revision = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
  ];
  for (const [name, change] of changes)
    it(`rejects ${name}`, async () => {
      const f = await ocrReceiptFixture();
      change(f.result);
      expect(await localOcrSaveAcknowledged(f.result, f.company, f.command)).toBe(false);
    });
  it("rejects missing source in original", async () => {
    const f = await ocrReceiptFixture();
    f.company.sources.shift();
    expect(await localOcrSaveAcknowledged(f.result, f.company, f.command)).toBe(false);
  });
  it("rejects stale command", async () => {
    const f = await ocrReceiptFixture();
    f.command.sourceUpdatedAt = "older";
    expect(await localOcrSaveAcknowledged(f.result, f.company, f.command)).toBe(false);
  });
  it("rejects old command revision", async () => {
    const f = await ocrReceiptFixture();
    f.command.revision--;
    expect(await localOcrSaveAcknowledged(f.result, f.company, f.command)).toBe(false);
  });
  it("rejects negative original revision", async () => {
    const f = await ocrReceiptFixture();
    f.company.revision = -1;
    expect(await localOcrSaveAcknowledged(f.result, f.company, f.command)).toBe(false);
  });
  it("rejects already reviewed original", async () => {
    const f = await ocrReceiptFixture();
    f.company.sources[0].extraction = "manual";
    expect(await localOcrSaveAcknowledged(f.result, f.company, f.command)).toBe(false);
  });
  it("rejects absent original file reference", async () => {
    const f = await ocrReceiptFixture();
    f.company.sources[0].originalName = null;
    expect(await localOcrSaveAcknowledged(f.result, f.company, f.command)).toBe(false);
  });
  it("rejects reused original nonce", async () => {
    const f = await ocrReceiptFixture();
    f.company.sourceOcrReviews[0].clientRequestId = f.command.clientRequestId;
    expect(await localOcrSaveAcknowledged(f.result, f.company, f.command)).toBe(false);
  });
  it("rejects malformed response", async () => {
    const f = await ocrReceiptFixture();
    expect(await localOcrSaveAcknowledged(null, f.company, f.command)).toBe(false);
  });
  it("rejects unchecked review", async () => {
    const f = await ocrReceiptFixture();
    expect(
      await localOcrSaveAcknowledged(f.result, f.company, { ...f.command, reviewed: false }),
    ).toBe(false);
  });
  it("rejects blank correction", async () => {
    const f = await ocrReceiptFixture();
    expect(await localOcrSaveAcknowledged(f.result, f.company, { ...f.command, text: "  " })).toBe(
      false,
    );
  });
});
