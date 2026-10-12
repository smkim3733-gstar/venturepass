import { beforeAll, describe, expect, it } from "vitest";
import { criteriaSaveAcknowledged } from "./criteria-versions-ui";
import {
  criteriaReceiptFixture,
  criteriaReceiptResult,
  criteriaReceiptPin,
  linkId,
} from "../../../scripts/fixtures/criteria-receipt";
import { type StudioCase } from "@/lib/studio-schema";
let fixture: Awaited<ReturnType<typeof criteriaReceiptFixture>>;
let append: StudioCase, pin: StudioCase, pinInput: ReturnType<typeof criteriaReceiptPin>;
beforeAll(async () => {
  fixture = await criteriaReceiptFixture();
  append = await criteriaReceiptResult(fixture.company, fixture.input, fixture.nonce);
  pinInput = criteriaReceiptPin(append, linkId(532));
  pin = await criteriaReceiptResult(append, pinInput, linkId(533), linkId(534));
});
function setPath(record: unknown, path: string, value: unknown) {
  const keys = path.split(".");
  let object = record as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) object = object[key] as Record<string, unknown>;
  object[keys.at(-1)!] = value;
}
for (const mode of ["append", "pin"] as const)
  describe(mode, () => {
    const values = () =>
      mode === "append"
        ? { base: fixture.company, result: append, input: fixture.input, nonce: fixture.nonce }
        : { base: append, result: pin, input: pinInput, nonce: linkId(533) };
    it("accepts exact next version and preserves input/base", async () => {
      const v = values(),
        before = structuredClone(v);
      expect(await criteriaSaveAcknowledged(v.result, v.base, v.nonce, v.input)).toBe(true);
      expect(v).toEqual(before);
    });
    for (const kind of [
      "missing",
      "nonce",
      "digest",
      "duplicate across record kinds",
      "other company",
      "previous revision",
      "null",
      "invalid shape",
    ])
      it(`rejects ${kind}`, async () => {
        const v = values();
        let next: unknown = structuredClone(v.result);
        const c = next as StudioCase;
        const r =
          mode === "append" ? c.criteriaVersions.at(-1)! : c.applicationCriteriaBindings.at(-1)!;
        if (kind === "missing") {
          if (mode === "append") c.criteriaVersions.pop();
          else c.applicationCriteriaBindings.pop();
        }
        if (kind === "nonce") r.clientRequestId = linkId(599);
        if (kind === "digest") r.inputDigest = "f".repeat(64);
        if (kind === "duplicate across record kinds") {
          if (mode === "append") c.applicationCriteriaBindings[0].clientRequestId = v.nonce;
          else c.criteriaVersions[0].clientRequestId = v.nonce;
        }
        if (kind === "other company") c.id = linkId(599);
        if (kind === "previous revision") c.revision = v.base.revision - 1;
        if (kind === "null") next = null;
        if (kind === "invalid shape") setPath(r, "origin", "automatic");
        expect(await criteriaSaveAcknowledged(next, v.base, v.nonce, v.input)).toBe(false);
      });
  });
it.each([
  ["criteriaId", "ffffffff-2222-4222-8222-222222222222"],
  ["previousVersionId", "ffffffff-2222-4222-8222-222222222222"],
  ["version", 4],
  ["caseId", "ffffffff-2222-4222-8222-222222222222"],
  ["recordedBy", "다른 담당"],
  ["reason", "다른 이유"],
  ["contentSha256", "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"],
  ["details.title", "다른 제목"],
  ["details.versionLabel", "다른 표기"],
  ["details.applicationPath", "다른 경로"],
  ["details.checkedOn", "2026-10-13"],
  ["details.sources.1.title", "다른 출처"],
  ["details.sources.0.url", "https://example.invalid/other"],
  ["details.sources.1.quote", "다른 인용"],
  ["details.sources.1.note", "다른 메모"],
  ["details.documents.1.id", "ffffffff-2222-4222-8222-222222222222"],
  ["details.documents.1.name", "다른 서류"],
  ["details.documents.1.appliesTo", "다른 대상"],
  ["details.documents.1.period", "다른 기간"],
  ["details.documents.1.issueDateCondition", "다른 발급"],
  ["details.documents.1.alternativeCondition", "다른 대체"],
  ["details.documents.1.autoLinkGuidance", "다른 연계"],
  ["details.documents.1.note", "다른 확인"],
])("rejects append changed %s", async (path, value) => {
  const next = structuredClone(append);
  setPath(next.criteriaVersions.at(-1), String(path), value);
  expect(await criteriaSaveAcknowledged(next, fixture.company, fixture.nonce, fixture.input)).toBe(
    false,
  );
});
it.each([
  ["applicationId", "ffffffff-2222-4222-8222-222222222222"],
  ["previousBindingId", "ffffffff-2222-4222-8222-222222222222"],
  ["version", 4],
  ["criteriaId", "ffffffff-2222-4222-8222-222222222222"],
  ["criteriaVersionId", "ffffffff-2222-4222-8222-222222222222"],
  ["criteriaVersion", 1],
  ["criteriaContentSha256", "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"],
  ["caseId", "ffffffff-2222-4222-8222-222222222222"],
  ["recordedBy", "다른 담당"],
  ["reason", "다른 이유"],
  ["criteriaSummary.title", "다른 제목"],
  ["criteriaSummary.versionLabel", "다른 표기"],
  ["criteriaSummary.applicationPath", "다른 경로"],
  ["criteriaSummary.checkedOn", "2026-10-13"],
  ["applicationSnapshot.metadataVersionId", "ffffffff-2222-4222-8222-222222222222"],
  ["applicationSnapshot.title", "다른 회차"],
  ["applicationSnapshot.kind", "renewal"],
  ["applicationSnapshot.plannedOn", "2026-11-04"],
  ["applicationSnapshot.criteriaNote", "다른 기준"],
  ["applicationSnapshot.previousApplicationId", "ffffffff-2222-4222-8222-222222222222"],
  ["companySnapshot.revision", 0],
  ["companySnapshot.companyName", "다른 회사"],
  ["companySnapshot.businessNumber", "9999999999"],
])("rejects pin changed %s", async (path, value) => {
  const next = structuredClone(pin);
  setPath(next.applicationCriteriaBindings.at(-1), String(path), value);
  expect(await criteriaSaveAcknowledged(next, append, linkId(533), pinInput)).toBe(false);
});
it.each(["sources", "documents"] as const)("rejects reordered %s", async (key) => {
  const next = structuredClone(append);
  next.criteriaVersions.at(-1)!.details[key].reverse();
  expect(await criteriaSaveAcknowledged(next, fixture.company, fixture.nonce, fixture.input)).toBe(
    false,
  );
});
it("accepts initial manually unverified criteria with optional values explicitly empty", async () => {
  const base = structuredClone(fixture.company);
  base.criteriaVersions = [];
  base.applicationCriteriaBindings = [];
  const raw = structuredClone(fixture.raw);
  raw.criteriaId = null;
  raw.previousVersionId = null;
  raw.details.applicationPath = "";
  raw.details.checkedOn = "";
  raw.details.sources = [];
  raw.details.documents = [];
  const result = await criteriaReceiptResult(base, raw, fixture.nonce);
  expect(await criteriaSaveAcknowledged(result, base, fixture.nonce, raw)).toBe(true);
});
it("accepts first explicit pin to the selected second application", async () => {
  const base = structuredClone(append);
  base.applicationCriteriaBindings = [];
  const input = criteriaReceiptPin(base, linkId(532));
  const result = await criteriaReceiptResult(base, input, linkId(533), linkId(534));
  expect(await criteriaSaveAcknowledged(result, base, linkId(533), input)).toBe(true);
});
