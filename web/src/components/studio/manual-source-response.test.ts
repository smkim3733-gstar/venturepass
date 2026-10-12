import { describe, it, expect } from "vitest";
import { manualSourceSaveAcknowledged } from "./manual-source-response";
import {
  manualSourceFixture,
  manualSourceResult,
  manualId,
} from "../../../scripts/fixtures/manual-source-receipt";
import type { StudioCase } from "@/lib/studio-schema";
describe("manual source acknowledgement", () => {
  for (const operation of ["create", "edit"] as const) {
    it(`accepts exact ${operation}, raw body and original input unchanged`, () => {
      const f = manualSourceFixture();
      const before = JSON.stringify(f);
      expect(
        manualSourceSaveAcknowledged(
          manualSourceResult(f.company, f[operation]),
          f.company,
          f[operation],
        ),
      ).toBe(true);
      expect(JSON.stringify(f)).toBe(before);
    });
    const changes: [string, (c: StudioCase, id: string) => void][] = [
      [
        "missing target",
        (c, id) => {
          c.sources = c.sources.filter((s) => s.id !== id);
        },
      ],
      [
        "wrong name",
        (c, id) => {
          c.sources.find((s) => s.id === id)!.name = "다른 제목";
        },
      ],
      [
        "wrong kind",
        (c, id) => {
          c.sources.find((s) => s.id === id)!.kind = "finance";
        },
      ],
      [
        "trimmed body",
        (c, id) => {
          c.sources.find((s) => s.id === id)!.text = c.sources
            .find((s) => s.id === id)!
            .text.trim();
        },
      ],
      [
        "other original",
        (c, id) => {
          c.sources.find((s) => s.id === id)!.originalName = "different.pdf";
        },
      ],
      [
        "other mime",
        (c, id) => {
          c.sources.find((s) => s.id === id)!.mimeType = "image/png";
        },
      ],
      [
        "AI extraction",
        (c, id) => {
          c.sources.find((s) => s.id === id)!.extraction = "ai";
        },
      ],
      [
        "wrong warning",
        (c, id) => {
          c.sources.find((s) => s.id === id)!.warnings = ["다른 안내"];
        },
      ],
      [
        "creation changed",
        (c, id) => {
          c.sources.find((s) => s.id === id)!.createdAt = "2000-01-01T00:00:00.000Z";
        },
      ],
      [
        "invalid saved time",
        (c, id) => {
          c.sources.find((s) => s.id === id)!.updatedAt = "invalid";
        },
      ],
      [
        "other source changed",
        (c) => {
          c.sources[1].text = "변경";
        },
      ],
      [
        "reordered sources",
        (c) => {
          c.sources.reverse();
        },
      ],
      [
        "extra source",
        (c) => {
          c.sources.push({ ...c.sources[1], id: manualId(99) });
        },
      ],
      [
        "duplicate source id",
        (c) => {
          c.sources[1].id = c.sources[0].id;
        },
      ],
      [
        "different company",
        (c) => {
          c.id = manualId(99);
        },
      ],
      [
        "same revision",
        (c) => {
          c.revision = 4;
        },
      ],
    ];
    for (const [label, change] of changes)
      it(`rejects ${operation} ${label}`, () => {
        const f = manualSourceFixture();
        const result = manualSourceResult(f.company, f[operation]);
        change(result, f[operation].id);
        expect(manualSourceSaveAcknowledged(result, f.company, f[operation])).toBe(false);
      });
  }
  it("allows new source at empty company", () => {
    const f = manualSourceFixture();
    f.company.sources = [];
    expect(
      manualSourceSaveAcknowledged(manualSourceResult(f.company, f.create), f.company, f.create),
    ).toBe(true);
  });
  it("rejects one more source at 100", () => {
    const f = manualSourceFixture();
    f.company.sources = Array.from({ length: 100 }, (_, i) => ({
      ...f.company.sources[1],
      id: manualId(i + 100),
    }));
    const result = structuredClone(f.company);
    result.revision++;
    result.sources[0] = { ...f.create };
    expect(manualSourceSaveAcknowledged(result, f.company, f.create)).toBe(false);
  });
  it("permits edit at 100", () => {
    const f = manualSourceFixture();
    f.company.sources.push(
      ...Array.from({ length: 98 }, (_, i) => ({ ...f.company.sources[1], id: manualId(i + 100) })),
    );
    expect(
      manualSourceSaveAcknowledged(manualSourceResult(f.company, f.edit), f.company, f.edit),
    ).toBe(true);
  });
  it("rejects old edited timestamp", () => {
    const f = manualSourceFixture();
    const c = manualSourceResult(f.company, f.edit);
    c.sources[0].updatedAt = f.company.sources[0].updatedAt;
    expect(manualSourceSaveAcknowledged(c, f.company, f.edit)).toBe(false);
  });
  it("rejects negative original revision", () => {
    const f = manualSourceFixture();
    const c = manualSourceResult(f.company, f.create);
    f.company.revision = -1;
    expect(manualSourceSaveAcknowledged(c, f.company, f.create)).toBe(false);
  });
  it("rejects null", () => {
    const f = manualSourceFixture();
    expect(manualSourceSaveAcknowledged(null, f.company, f.create)).toBe(false);
  });
  it("rejects blank body", () => {
    const f = manualSourceFixture();
    expect(
      manualSourceSaveAcknowledged(manualSourceResult(f.company, f.create), f.company, {
        ...f.create,
        text: "  ",
      }),
    ).toBe(false);
  });
});
