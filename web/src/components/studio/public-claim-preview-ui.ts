import { canonicalSelectionValue as canonical } from "@/lib/studio-candidate-selection-types";
import { readManualPublicEvidence } from "@/lib/studio-public-evidence-export";
import { publicClaimComparisonBoundaries } from "@/lib/studio-public-claim-comparison-types";
import {
  publicClaimComparisonRequestAuthority,
  publicClaimComparisonRequestCommandSchema,
  publicClaimComparisonRequestPins,
  type PublicClaimComparisonRequestCommand,
} from "@/lib/studio-public-claim-comparison-request-types";
import type { PublicClaimComparisonRequestPreview } from "@/lib/studio-public-claim-comparison-request";
import type { PublicClaimComparisonPreparation } from "@/lib/studio-public-claim-comparison";
import type { StudioCase } from "@/lib/studio-schema";

const fail = (): never => {
  throw Error("원래 주장·선택 근거와 미리보기를 대조하지 못했습니다. 다시 선택해 주세요.");
};
function requireMatch(value: unknown): asserts value {
  if (!value) fail();
}
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const sha = async (s: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
const digest = (v: unknown) => sha(canonical(v));
export type PublicClaimPreviewView = {
  preview: PublicClaimComparisonRequestPreview;
  prepared: PublicClaimComparisonPreparation;
};

/** Checks a local response against the captured display snapshot; server owns the history audit. */
export async function publicClaimPreviewResponse(
  raw: unknown,
  snapshot: StudioCase,
  input: PublicClaimComparisonRequestCommand,
): Promise<PublicClaimPreviewView> {
  try {
    // Capture before the first await; no later caller mutations enter this comparison.
    const company = structuredClone(snapshot),
      command = publicClaimComparisonRequestCommandSchema.parse(input);
    const serialized = JSON.stringify(raw);
    requireMatch(serialized && new TextEncoder().encode(serialized).length <= 3 * 1024 * 1024);
    const p = JSON.parse(serialized) as PublicClaimComparisonRequestPreview;
    requireMatch(
      company.id === command.selection.companyId &&
        company.revision === command.selection.companyRevision,
    );
    const records = (company.claimReviews ?? []).filter(
      (r) => r.id === command.selection.claimRecordId,
    );
    requireMatch(records.length === 1);
    const record = records[0];
    requireMatch(
      record.version === command.selection.claimVersion &&
        record.inputDigest === command.selection.claimInputDigest,
    );
    const plans = company.plans.filter((p) => p.id === record.planId),
      plan = plans[0];
    requireMatch(plans.length === 1 && plan.version === record.planVersion);
    const sections = plan.content.sections.filter((s) => s.key === record.sectionKey);
    requireMatch(sections.length === 1 && sections[0].content.includes(record.claimQuote));
    const planHash = await sha(JSON.stringify(plan.content));
    requireMatch(record.planSnapshots[0].contentSha256 === planHash);
    const evidence = [];
    for (const sourceId of command.selection.sourceIds) {
      const sources = company.sources.filter((s) => s.id === sourceId),
        source = sources[0];
      const ref = record.references.find((r) => r.sourceId === sourceId),
        saved = record.sourceSnapshots.find((s) => s.sourceId === sourceId);
      requireMatch(sources.length === 1 && ref && saved);
      const draft = readManualPublicEvidence(source);
      const textSha256 = await sha(source.text);
      requireMatch(
        draft &&
          source.originalName === null &&
          source.mimeType === null &&
          saved.original === null &&
          source.updatedAt === ref.sourceUpdatedAt &&
          source.updatedAt === saved.sourceUpdatedAt &&
          source.name === saved.sourceName &&
          source.extraction === saved.extraction &&
          textSha256 === saved.textSha256 &&
          ref.quote.trim() &&
          draft.quote.includes(ref.quote),
      );
      evidence.push({
        sourceId,
        sourceUpdatedAt: source.updatedAt,
        textSha256,
        originalReference: { quote: ref.quote, locator: ref.locator },
        metadata: {
          title: draft.title,
          url: draft.url,
          publisher: draft.publisher,
          publishedOn: draft.publishedOn,
          period: draft.period,
          readOn: draft.readOn,
          sectionKey: draft.sectionKey,
        },
        excerpt: draft.quote,
        manualNotes: { relevance: draft.relevance, conflicts: draft.conflicts },
      });
    }
    const payload = {
      contractVersion: "public-claim-comparison-v1" as const,
      ...publicClaimComparisonBoundaries,
      selection: command.selection,
      binding: {
        claimId: record.claimId,
        claimRecordSha256: await sha(JSON.stringify(record)),
        planId: plan.id,
        planVersion: plan.version,
        planContentSha256: planHash,
      },
      input: {
        claimQuote: record.claimQuote,
        section: { key: sections[0].key, title: sections[0].title, content: sections[0].content },
        selectedEvidence: evidence,
        excludedSourceIds: record.references
          .filter((r) => !command.selection.sourceIds.includes(r.sourceId))
          .map((r) => r.sourceId),
      },
    };
    const prepared = {
      ...payload,
      preparationDigest: await sha(JSON.stringify(payload)),
      inputCharacters: JSON.stringify(payload).length,
    };
    requireMatch(prepared.inputCharacters <= 240000);
    const { contractDigest, ...contractFields } = p.contract;
    requireMatch(
      contractDigest === publicClaimComparisonRequestPins.contractDigest &&
        (await digest(contractFields)) === contractDigest &&
        p.contract.systemDigest === publicClaimComparisonRequestPins.systemDigest &&
        p.contract.schemaDigest === publicClaimComparisonRequestPins.schemaDigest,
    );
    const system = p.body.input[0].content;
    requireMatch(
      (await digest(system)) === publicClaimComparisonRequestPins.systemDigest &&
        (await digest(p.body.text.format)) === publicClaimComparisonRequestPins.schemaDigest,
    );
    const user = JSON.stringify(prepared);
    const body = {
      model: command.model,
      store: false as const,
      max_output_tokens: 16000 as const,
      input: [
        { role: "system" as const, content: system },
        { role: "user" as const, content: user },
      ],
      text: { format: p.body.text.format },
    };
    requireMatch(equal(p.body, body));
    const rawBody = JSON.stringify(body);
    requireMatch(rawBody.length <= 240000);
    const identity = {
      requestVersion: command.requestVersion,
      commandDigest: await digest(command),
      preparationDigest: prepared.preparationDigest,
      contractDigest,
      requestDigest: await digest(body),
      rawBodySha256: await sha(rawBody),
      requestCharacters: rawBody.length,
      requestUtf8Bytes: new TextEncoder().encode(rawBody).length,
    };
    const expected = {
      kind: "public-claim-comparison-request-preview",
      ...publicClaimComparisonRequestAuthority,
      evidenceOrigin: prepared.evidenceOrigin,
      source: "local-request-preparation",
      command,
      contract: p.contract,
      identity,
      body,
      rawBody,
      sizes: {
        preparationPayloadCharacters: prepared.inputCharacters,
        userMessageCharacters: user.length,
        systemMessageCharacters: system.length,
        messageContentCharacters: system.length + user.length,
        requestCharacters: identity.requestCharacters,
        requestUtf8Bytes: identity.requestUtf8Bytes,
        measuredIn: "utf16-code-units-and-utf8-bytes",
        estimatedTokens: null,
        estimatedCost: null,
        modelContextFits: null,
      },
    };
    requireMatch(equal(p, expected));
    return { preview: p, prepared };
  } catch {
    return fail();
  }
}
