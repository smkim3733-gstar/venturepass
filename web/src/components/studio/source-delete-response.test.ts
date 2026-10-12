import { describe, expect, it } from "vitest";
import { sourceDeleteAcknowledged } from "./source-delete-response";
import { sourceDeleteFixture, sourceDeleteResult } from "../../../scripts/fixtures/source-delete-receipt";
import type { StudioCase } from "@/lib/studio-schema";

describe("source deletion acknowledgement", () => {
  it("accepts only the selected ID among identical titles without changing input", () => {
    const f = sourceDeleteFixture(); const frozen = JSON.stringify(f);
    expect(sourceDeleteAcknowledged(sourceDeleteResult(f.company, f.sourceId), f.company, f.sourceId)).toBe(true);
    expect(JSON.stringify(f)).toBe(frozen);
  });
  const changes: [string, (next: StudioCase, before: StudioCase) => void][] = [
    ["target remains", (n,b) => { n.sources = structuredClone(b.sources); }],
    ["different source removed", (n,b) => { n.sources = b.sources.filter(s => s.id !== b.sources[2].id); }],
    ["another source also removed", n => { n.sources.pop(); }],
    ["remaining source order", n => { n.sources.reverse(); }],
    ["body whitespace", n => { n.sources[1].text += " "; }],
    ["remaining name", n => { n.sources[1].name = "다른 이름"; }],
    ["remaining kind", n => { n.sources[1].kind = "finance"; }],
    ["original link", n => { n.sources[0].originalName = null; }],
    ["original mime", n => { n.sources[0].mimeType = "image/png"; }],
    ["warning", n => { n.sources[0].warnings = []; }],
    ["extraction", n => { n.sources[0].extraction = "manual"; }],
    ["created time", n => { n.sources[0].createdAt = "2000-01-01"; }],
    ["updated time", n => { n.sources[0].updatedAt = "2000-01-01"; }],
    ["extra source", (n,b) => { n.sources.push({...b.sources[1]}); }],
    ["duplicate returned ID", n => { n.sources[1].id = n.sources[0].id; }],
    ["company", (n,b) => { n.id = b.sources[0].id; }],
    ["same revision", (n,b) => { n.revision = b.revision; }],
    ["older revision", (n,b) => { n.revision = b.revision - 1; }],
    ["unsafe revision", n => { n.revision = Number.MAX_SAFE_INTEGER + 1; }],
  ];
  for (const [label, change] of changes) it(`rejects ${label}`, () => {
    const f=sourceDeleteFixture();const n=sourceDeleteResult(f.company,f.sourceId);change(n,f.company);
    expect(sourceDeleteAcknowledged(n,f.company,f.sourceId)).toBe(false);
  });
  it("allows removing the last source", () => {
    const f=sourceDeleteFixture();f.company.sources=[f.company.sources[1]];
    expect(sourceDeleteAcknowledged(sourceDeleteResult(f.company,f.sourceId),f.company,f.sourceId)).toBe(true);
  });
  it("rejects a missing original ID", () => {
    const f=sourceDeleteFixture();expect(sourceDeleteAcknowledged(sourceDeleteResult(f.company,f.sourceId),f.company,"missing")).toBe(false);
  });
  it("rejects a duplicate original ID", () => {
    const f=sourceDeleteFixture();f.company.sources[2].id=f.sourceId;
    expect(sourceDeleteAcknowledged(sourceDeleteResult(f.company,f.sourceId),f.company,f.sourceId)).toBe(false);
  });
  it("rejects a duplicate other original ID", () => {
    const f=sourceDeleteFixture();f.company.sources.push({...f.company.sources[0]});
    expect(sourceDeleteAcknowledged(sourceDeleteResult(f.company,f.sourceId),f.company,f.sourceId)).toBe(false);
  });
  it("rejects a negative original revision", () => {
    const f=sourceDeleteFixture();const n=sourceDeleteResult(f.company,f.sourceId);f.company.revision=-1;
    expect(sourceDeleteAcknowledged(n,f.company,f.sourceId)).toBe(false);
  });
  it("rejects null response", () => {
    const f=sourceDeleteFixture();expect(sourceDeleteAcknowledged(null,f.company,f.sourceId)).toBe(false);
  });
  it("rejects malformed source data", () => {
    const f=sourceDeleteFixture();const n=sourceDeleteResult(f.company,f.sourceId);
    expect(sourceDeleteAcknowledged({...n,sources:[{}]},f.company,f.sourceId)).toBe(false);
  });
});
