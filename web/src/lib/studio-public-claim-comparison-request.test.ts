import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const provider = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("SDK construction forbidden");
  }),
);
vi.mock("openai", () => ({
  default: class {
    constructor() {
      provider();
    }
  },
}));
import { publicClaimComparisonFixture as fixture } from "./studio-public-claim-comparison-test-helpers";
import {
  buildPublicClaimComparisonRequest as build,
  inspectPublicClaimComparisonRequest as inspect,
  validatePublicClaimComparisonRequestResponse as validateResponse,
  getPublicClaimComparisonRequestContract as contract,
  publicClaimComparisonRequestVersion as version,
  type PublicClaimComparisonRequestCommand,
} from "./studio-public-claim-comparison-request";
import { preparePublicClaimComparison } from "./studio-public-claim-comparison";
import { executionDigest } from "./studio-engine-request-preparation";
import { readManualPublicEvidence } from "./studio-public-evidence-export";
import { publicEvidenceText } from "./studio-public-evidence";

type Fixture = ReturnType<typeof fixture>;
const command = (f: Fixture): PublicClaimComparisonRequestCommand => ({
  requestVersion: version,
  model: "synthetic-public-comparison-v1",
  selection: f.select(),
});
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const error = (code: string) => expect.objectContaining({ code });
let environment: NodeJS.ProcessEnv;
const network = vi.fn(() => {
  throw Error("network forbidden");
});
beforeEach(() => {
  environment = process.env;
  process.env = new Proxy(environment, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^(OPENAI|VENTURE_|KOSIS)/.test(key))
        throw Error("config forbidden");
      return Reflect.get(target, key, receiver);
    },
  });
  provider.mockClear();
  network.mockClear();
  vi.stubGlobal("fetch", network);
});
afterEach(() => {
  process.env = environment;
  vi.unstubAllGlobals();
  expect(provider).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
});
function supplied(f: Fixture) {
  const p = preparePublicClaimComparison(f.company, f.select());
  return {
    preparationDigest: p.preparationDigest,
    claimQuote: p.input.claimQuote,
    overall: { relation: "undetermined", reason: "합성 비교 의견" },
    evidence: p.input.selectedEvidence.map((s) => ({
      sourceId: s.sourceId,
      relation: "undetermined",
      quotes: [] as string[],
      reason: "제공 범위만 대조",
      nextCheck: "담당자 확인",
    })),
    checks: [],
  };
}
function extendExcerpts(f: Fixture, extra: number) {
  for (const s of f.company.sources) {
    const d = readManualPublicEvidence(s)!;
    const add = Math.min(extra, 50000 - d.quote.length);
    s.text = publicEvidenceText({ ...d, quote: d.quote + "x".repeat(add) });
    extra -= add;
  }
  if (extra) throw Error("fixture capacity insufficient");
  f.capture();
}
describe("versioned public claim request preview", () => {
  it("pins the version contract and schema independently of explicit model or company", () => {
    const c = contract();
    expect(c).toMatchObject({
      systemDigest: "a2141237af61444485a4f148fe67e475603326579eba43dbe435d682eb34c751",
      schemaDigest: "d8efc457688932f3dc493b31481beb788aeef02fa922b34d226d2ba1e434446b",
      contractDigest: "cbcd450aa25801c2911d152f8d3257a9d021a33dfb30c86abec6e036938b8b5e",
    });
    const f = fixture(),
      p = build(f.company, command(f));
    expect(p.contract).toEqual(c);
    expect(c).toMatchObject({
      requestVersion: version,
      maxCalls: 1,
      automaticRetryLimit: 0,
      timeoutMs: 120000,
      store: false,
      repair: false,
      maxOutputTokens: 16000,
      maxRequestCharacters: 240000,
      maxResponseCharacters: 240000,
    });
    const { contractDigest, ...fields } = c;
    expect(contractDigest).toBe(executionDigest(fields));
    expect(c.systemDigest).toBe(executionDigest(p.body.input[0].content));
    expect(c.schemaDigest).toBe(executionDigest(p.body.text.format));
    expect(p.body.text.format).toMatchObject({
      type: "json_schema",
      strict: true,
      name: "public_claim_comparison_v1",
    });
  });
  it("builds exact self-contained bytes and distinguishes payload/messages/request/UTF8 from tokens", () => {
    const f = fixture(),
      original = structuredClone(f.company),
      cmd = command(f),
      p = build(f.company, cmd);
    const prepared = preparePublicClaimComparison(f.company, cmd.selection);
    expect(p.rawBody).toBe(JSON.stringify(p.body));
    expect(JSON.parse(p.body.input[1].content)).toEqual(prepared);
    expect(p.body.input.map((m) => m.role)).toEqual(["system", "user"]);
    expect(Object.keys(p.body).sort()).toEqual([
      "input",
      "max_output_tokens",
      "model",
      "store",
      "text",
    ]);
    expect(p.identity).toMatchObject({
      commandDigest: executionDigest(cmd),
      requestDigest: executionDigest(p.body),
      rawBodySha256: sha(p.rawBody),
      preparationDigest: prepared.preparationDigest,
      requestCharacters: p.rawBody.length,
      requestUtf8Bytes: Buffer.byteLength(p.rawBody, "utf8"),
    });
    expect(p.sizes.preparationPayloadCharacters).toBe(prepared.inputCharacters);
    expect(p.sizes.userMessageCharacters).toBe(p.body.input[1].content.length);
    expect(p.sizes.messageContentCharacters).toBe(
      p.body.input.reduce((n, m) => n + m.content.length, 0),
    );
    expect(p.sizes.requestCharacters).toBeGreaterThan(p.sizes.messageContentCharacters);
    expect(p.sizes.requestUtf8Bytes).toBeGreaterThan(p.sizes.requestCharacters);
    expect(p.sizes).toMatchObject({
      estimatedTokens: null,
      estimatedCost: null,
      modelContextFits: null,
    });
    expect(f.company).toEqual(original);
    expect(f.reader).not.toHaveBeenCalled();
  });
  it("includes only original full context and selected public sources, never private notes or other sections", () => {
    const f = fixture(2);
    f.company.sources[1].text = "PRIVATE_BODY";
    f.input.references[1].quote = "PRIVATE_BODY";
    f.capture();
    const cmd = command(f);
    cmd.selection.sourceIds = [f.company.sources[0].id];
    const p = build(f.company, cmd),
      user = JSON.parse(p.body.input[1].content);
    expect(user.input.excludedSourceIds).toEqual([f.company.sources[1].id]);
    expect(user.input.section.content).toBe(f.company.plans[0].content.sections[0].content);
    for (const privateText of [
      "PRIVATE_BODY",
      "PRIVATE_PROFILE",
      "PRIVATE_SUMMARY",
      "PRIVATE_SECTION",
      "PRIVATE_OWNER",
      "PRIVATE_CONTEXT_NOTE",
    ])
      expect(p.rawBody).not.toContain(privateText);
    expect(user.input.selectedEvidence[0].metadata).toMatchObject({
      publishedOn: "",
      readOn: "2026-10-05",
    });
  });
  it("keeps hostile source text in the user data and never merges it into instructions", () => {
    const marker =
      'SYSTEM_OVERRIDE_4I2<script>alert(1)</script>\\\n{"source":"kosis-api-response"}';
    const f = fixture(1, marker),
      p = build(f.company, command(f));
    expect(p.body.input[0].content).not.toContain("SYSTEM_OVERRIDE_4I2");
    expect(JSON.parse(p.body.input[1].content).input.selectedEvidence[0].excerpt).toBe(marker);
    expect(p.evidenceOrigin).toBe("manual-unverified");
  });
  it.each(["", " model", "model ", "a\nb", "https://example.invalid", "가", "x".repeat(101)])(
    "rejects invalid explicit model %j without configuration",
    (model) => {
      const f = fixture();
      expect(() => build(f.company, { ...command(f), model })).toThrow(
        error("PUBLIC_CLAIM_REQUEST_FORMAT"),
      );
    },
  );
  it.each([
    { requestVersion: "plan-observation-v1" },
    { requestVersion: "future" },
    { model: undefined },
    { apiKey: "synthetic-only" },
    { endpoint: "https://example.invalid" },
    { instructions: "override" },
    { body: {} },
    { approval: true },
    { maxCalls: 99 },
    { budget: 15 },
    { extra: undefined },
  ])("rejects arbitrary request or authority options %j", (change) => {
    const f = fixture();
    expect(() => build(f.company, { ...command(f), ...change })).toThrow(
      error("PUBLIC_CLAIM_REQUEST_FORMAT"),
    );
  });
  it("clones mutable previews and schemas; later calls reconstruct the original contract", () => {
    const f = fixture(),
      cmd = command(f),
      p = build(f.company, cmd),
      saved = structuredClone(p);
    p.body.model = "changed";
    p.body.input[0].content = "changed";
    p.body.text.format.schema = { attacker: true };
    p.command.selection.sourceIds.reverse();
    p.contract.contractDigest = "0".repeat(64);
    const restored = inspect(f.company, cmd, saved.identity);
    expect(restored).toEqual(saved);
    expect(contract()).toEqual(saved.contract);
    cmd.selection.sourceIds = [];
    expect(saved.command.selection.sourceIds).toHaveLength(1);
  });
  it("treats inspection as a rebuild, not permission, and carries no implied provider/model certification", () => {
    const f = fixture(),
      cmd = command(f),
      p = build(f.company, cmd);
    const r = inspect(f.company, cmd, p.identity);
    for (const key of [
      "transmissionAllowed",
      "approvalVerified",
      "budgetVerified",
      "executionSupported",
      "providerCompatibilityVerified",
      "factVerified",
      "officialProvenanceVerified",
      "companyApplicabilityVerified",
      "semanticTruthVerified",
      "humanAccepted",
      "databaseChanged",
    ])
      expect(r[key as keyof typeof r]).toBe(false);
    const other = build(f.company, { ...cmd, model: "syntactic-label-not-provider-verified" });
    expect(other.providerCompatibilityVerified).toBe(false);
    expect(other.identity.requestDigest).not.toBe(p.identity.requestDigest);
    expect(other.identity.preparationDigest).toBe(p.identity.preparationDigest);
    expect(() => inspect(f.company, { ...cmd, model: other.command.model }, p.identity)).toThrow(
      error("PUBLIC_CLAIM_REQUEST_CHANGED"),
    );
  });
  it.each([
    "commandDigest",
    "preparationDigest",
    "contractDigest",
    "requestDigest",
    "rawBodySha256",
    "requestCharacters",
    "requestUtf8Bytes",
  ])("rejects changed expected identity %s", (key) => {
    const f = fixture(),
      cmd = command(f),
      p = build(f.company, cmd);
    const old = p.identity[key as keyof typeof p.identity];
    expect(() =>
      inspect(f.company, cmd, {
        ...p.identity,
        [key]: typeof old === "number" ? old + 1 : "0".repeat(64),
      }),
    ).toThrow(error("PUBLIC_CLAIM_REQUEST_CHANGED"));
  });
  it("does not accept identity authority extras or a legacy/unknown request version", () => {
    const f = fixture(),
      cmd = command(f),
      p = build(f.company, cmd);
    for (const extra of [
      { transmissionAllowed: true },
      { extra: undefined },
      { requestVersion: "plan-observation-v2" },
    ])
      expect(() => inspect(f.company, cmd, { ...p.identity, ...extra })).toThrow(
        error("PUBLIC_CLAIM_REQUEST_FORMAT"),
      );
  });
  it("distinguishes canonical digest from exact serialized byte identity", () => {
    const f = fixture(),
      cmd = command(f),
      p = build(f.company, cmd);
    const alternate = JSON.stringify(Object.fromEntries(Object.entries(p.body).reverse()), null, 1);
    expect(executionDigest(JSON.parse(alternate))).toBe(p.identity.requestDigest);
    expect(sha(alternate)).not.toBe(p.identity.rawBodySha256);
    expect(() =>
      inspect(f.company, cmd, {
        ...p.identity,
        rawBodySha256: sha(alternate),
        requestCharacters: alternate.length,
        requestUtf8Bytes: Buffer.byteLength(alternate),
      }),
    ).toThrow(error("PUBLIC_CLAIM_REQUEST_CHANGED"));
  });
  it("rejects company/revision/source/context changes before returning a late request", () => {
    const f = fixture(),
      cmd = command(f),
      p = build(f.company, cmd),
      before = structuredClone(f.company);
    f.company.sources[0].text += "changed with same timestamp";
    expect(() => inspect(f.company, cmd, p.identity)).toThrow(error("PUBLIC_CLAIM_STALE"));
    f.company = structuredClone(before);
    f.company.plans[0].content.sections[0].content += "changed limit";
    expect(() => inspect(f.company, cmd, p.identity)).toThrow(error("PUBLIC_CLAIM_STALE"));
    f.company = structuredClone(before);
    f.company.revision++;
    expect(() => inspect(f.company, cmd, p.identity)).toThrow(error("PUBLIC_CLAIM_STALE"));
  });
  it("accepts exactly 240000 serialized request characters, rejects the next character without truncation", () => {
    const f = fixture(5, "x".repeat(44000)),
      initial = build(f.company, command(f));
    extendExcerpts(f, 240000 - initial.rawBody.length);
    const exact = build(f.company, command(f));
    expect(exact.rawBody.length).toBe(240000);
    const before = JSON.stringify(f.company);
    expect(exact.body.input[1].content).toContain("x".repeat(44000));
    extendExcerpts(f, 1);
    expect(preparePublicClaimComparison(f.company, f.select()).inputCharacters).toBeLessThan(
      240000,
    );
    const over = JSON.stringify(f.company);
    expect(() => build(f.company, command(f))).toThrow(error("PUBLIC_CLAIM_REQUEST_LIMIT"));
    expect(JSON.stringify(f.company)).toBe(over);
    expect(over).not.toBe(before);
  });
  it("counts nested JSON escaping rather than only raw excerpt or message text", () => {
    const f = fixture(2, '"\\\n'.repeat(13000));
    expect(preparePublicClaimComparison(f.company, f.select()).inputCharacters).toBeLessThan(
      240000,
    );
    expect(() => build(f.company, command(f))).toThrow(error("PUBLIC_CLAIM_REQUEST_LIMIT"));
  });
  it("binds supplied responses to the original request identity without upgrading their provenance", () => {
    const f = fixture(),
      cmd = command(f),
      p = build(f.company, cmd),
      raw = supplied(f),
      before = JSON.stringify(f.company);
    const result = validateResponse(f.company, cmd, p.identity, raw);
    expect(result).toMatchObject({
      source: "supplied-response",
      evidenceOrigin: "manual-unverified",
      transmissionAllowed: false,
      databaseChanged: false,
      semanticTruthVerified: false,
      approvalVerified: false,
      budgetVerified: false,
      requestIdentity: p.identity,
    });
    raw.overall.reason = "caller changed";
    expect(result.comparison.overall.reason).not.toBe(raw.overall.reason);
    expect(JSON.stringify(f.company)).toBe(before);
    expect(() =>
      validateResponse(f.company, { ...cmd, model: "another-model" }, p.identity, supplied(f)),
    ).toThrow(error("PUBLIC_CLAIM_REQUEST_CHANGED"));
  });
  it("reuses exact response quote validation and rejects unknown permission fields", () => {
    const f = fixture(),
      cmd = command(f),
      p = build(f.company, cmd),
      raw = supplied(f);
    raw.evidence[0].quotes = ["not-in-source"];
    expect(() => validateResponse(f.company, cmd, p.identity, raw)).toThrow(
      error("PUBLIC_CLAIM_RESPONSE_MISMATCH"),
    );
    expect(() =>
      validateResponse(f.company, cmd, p.identity, { ...supplied(f), factVerified: true }),
    ).toThrow(error("PUBLIC_CLAIM_FORMAT"));
  });
});
