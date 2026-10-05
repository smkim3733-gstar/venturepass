import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import {
  captureProviderResponse,
  reportedProviderResponseMetadata,
} from "../../scripts/local-data-quality-provider-usage.mjs";
import { inspectArchivedPublicClaimRequest } from "./studio-public-claim-comparison-request";
import { validatePreparedPublicClaimComparison } from "./studio-public-claim-comparison";
import { decodePublicClaimCapturedOutput } from "./studio-public-claim-comparison-capture";
import {
  publicClaimComparisonRequestAuthority,
  publicClaimComparisonRequestCommandSchema,
  publicClaimComparisonRequestIdentitySchema,
} from "./studio-public-claim-comparison-request-types";
import type { PublicComparisonBudgetSuffix } from "./studio-public-claim-comparison-budget";
const MiB = 1024 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  uuid = z.string().uuid();
const integer = z.number().int().nonnegative().safe(),
  time = z.string().datetime();
const units = z.string().regex(/^(0|[1-9][0-9]{0,29})$/);
const purpose = z.literal("compare-public-claim");
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
function invalid(): never {
  throw Error("PUBLIC_COMPARISON_NATIVE_INVALID");
}
const manifest = z
  .object({
    version: z.literal(1),
    purpose,
    coverageDigest: hash,
    scopeId: z.enum([
      "candidate-quality-provider-v2-live",
      "candidate-quality-provider-v2-synthetic",
    ]),
    environment: z.enum(["production", "synthetic-test"]),
    currency: z.string().min(1).max(10),
    unitScale: integer.max(12),
    expectedBudgetHead: z.object({ revision: integer, headDigest: hash }).strict(),
    reservedUnits: units.refine((v) => BigInt(v) > BigInt(0)),
    requestIdentityDigest: hash,
    contextSha256: hash,
    expiresAt: time,
    maxCalls: z.literal(1),
    automaticRetryLimit: z.literal(0),
    storageReservationBytes: z.literal(32 * MiB),
    selectedContentRetentionAcknowledged: z.literal(true),
    comparisonPurposeAcknowledged: z.literal(true),
  })
  .strict();
export const publicComparisonNativeRunSchema = z
  .object({
    schemaVersion: z.literal(3),
    archiveFormatVersion: z.literal(4),
    purpose,
    id: uuid,
    createdAt: time,
    command: publicClaimComparisonRequestCommandSchema,
    identity: publicClaimComparisonRequestIdentitySchema,
    manifest,
    manifestDigest: hash,
    runDigest: hash,
  })
  .strict();
const assessment = z
  .object({
    status: z.literal("known"),
    units,
    requestDigest: hash,
    dispatchEventDigest: hash,
    responseArtifactSha256: hash,
    requestedTier: z.null(),
    violations: z.array(z.string().min(1).max(200)).max(20),
  })
  .strict();
export const publicComparisonNativeEventSchema = z
  .object({
    schemaVersion: z.literal(3),
    purpose,
    runId: uuid,
    eventId: uuid,
    revision: integer.positive().max(32),
    previousDigest: hash,
    recordedAt: time,
    payload: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("reserved"), budgetEventDigest: hash }).strict(),
      z
        .object({
          kind: z.literal("dispatch-recorded"),
          reservationDigest: hash,
          requestDigest: hash,
          manifestDigest: hash,
        })
        .strict(),
      z
        .object({
          kind: z.literal("dispatch-unknown"),
          dispatchEventDigest: hash,
          reason: z.enum(["not-started-unconfirmed", "transport-unknown", "restart-unknown"]),
        })
        .strict(),
      z
        .object({
          kind: z.literal("cancelled"),
          reservationDigest: hash,
          reason: z.literal("not-dispatched"),
        })
        .strict(),
      z
        .object({
          kind: z.literal("response-captured"),
          dispatchEventDigest: hash,
          responseArtifactSha256: hash,
        })
        .strict(),
      z
        .object({
          kind: z.literal("comparison-recorded"),
          responseArtifactSha256: hash,
          validatedArtifactSha256: hash,
        })
        .strict(),
      z.object({ kind: z.literal("usage-assessed"), assessment }).strict(),
      z.object({ kind: z.literal("cost-settled"), budgetEventDigest: hash }).strict(),
      z.object({ kind: z.literal("finalized"), finalArtifactSha256: hash }).strict(),
    ]),
    eventDigest: hash,
  })
  .strict();
export const publicComparisonNativeReceiptSchema = z
  .object({
    schemaVersion: z.literal(3),
    purpose,
    runId: uuid,
    clientRequestId: uuid,
    inputDigest: hash,
    eventRevision: integer.positive(),
    operationDigest: hash,
    budgetOperationDigest: hash.nullable(),
    recordedAt: time,
  })
  .strict();
const artifact = z
  .object({
    runId: uuid,
    key: z.enum([
      "comparison-context",
      "comparison-request",
      "comparison-response",
      "comparison-validated",
      "final-result",
    ]),
    body: z.string().max(4 * MiB),
    sha256: hash,
    sizeBytes: integer.positive(),
  })
  .strict();
export const publicComparisonNativeRecordsSchema = z
  .object({
    runs: z.array(publicComparisonNativeRunSchema).max(20),
    events: z.array(publicComparisonNativeEventSchema).max(640),
    receipts: z.array(publicComparisonNativeReceiptSchema).max(1000),
    artifacts: z.array(artifact).max(140),
  })
  .strict();
export type PublicComparisonNativeRecords = z.infer<typeof publicComparisonNativeRecordsSchema>;
export type PublicComparisonNativeEvent = z.infer<typeof publicComparisonNativeEventSchema>;
export function publicComparisonNativeInputDigest(e: PublicComparisonNativeEvent) {
  return digest({
    schemaVersion: 3,
    purpose: e.purpose,
    runId: e.runId,
    expectedHead: { revision: e.revision - 1, headDigest: e.previousDigest },
    payload: e.payload,
  });
}
export function createPublicComparisonNativeEvent(
  raw: Omit<PublicComparisonNativeEvent, "eventDigest">,
) {
  return publicComparisonNativeEventSchema.parse({ ...raw, eventDigest: digest(raw) });
}
export function createPublicComparisonNativeRun(
  raw: Omit<z.infer<typeof publicComparisonNativeRunSchema>, "runDigest">,
) {
  return publicComparisonNativeRunSchema.parse({ ...raw, runDigest: digest(raw) });
}
/** Internal structural read, called only after the outer budget boundary's data-only guard.
 * Supplied records cannot establish a COMMIT, real transmission, price or human consent. */
export function inspectPublicComparisonNativeRecords(
  raw: unknown,
  financial: Pick<PublicComparisonBudgetSuffix, "events" | "receipts">,
  coverageDigest: string,
) {
  const n = publicComparisonNativeRecordsSchema.parse(raw);
  const runIds = new Set(n.runs.map((v) => v.id));
  if (
    runIds.size !== n.runs.length ||
    n.events.some((v) => !runIds.has(v.runId)) ||
    n.receipts.some((v) => !runIds.has(v.runId)) ||
    n.artifacts.some((v) => !runIds.has(v.runId)) ||
    n.receipts.length !== n.events.length ||
    financial.events.some((v) => !runIds.has(v.payload.runId))
  )
    invalid();
  const receipts = new Map(n.receipts.map((v) => [v.operationDigest, v]));
  const artifactKeys = new Set(n.artifacts.map((v) => v.runId + ":" + v.key));
  if (
    receipts.size !== n.receipts.length ||
    artifactKeys.size !== n.artifacts.length ||
    new Set(n.receipts.map((v) => v.clientRequestId)).size !== n.receipts.length ||
    new Set(n.events.map((v) => v.eventId)).size !== n.events.length
  )
    invalid();
  const budgetEvents = new Map(financial.events.map((v) => [v.eventDigest, v]));
  const budgetReceipts = new Map(financial.receipts.map((v) => [v.operationDigest, v]));
  const usedBudget = new Set<string>(),
    usedArtifacts = new Set<string>();
  const evidence: PublicComparisonBudgetSuffix["evidence"] = [];
  const summaries = [];
  const extraReceipts = [];
  let totalUsed = 0,
    heldBytes = 0,
    eventSlots = 0,
    budgetSlots = 0,
    receiptSlots = 0,
    artifactSlots = 0;
  for (const run of n.runs) {
    const { runDigest, ...unsigned } = run,
      m = run.manifest;
    if (
      runDigest !== digest(unsigned) ||
      run.manifestDigest !== digest(m) ||
      m.coverageDigest !== coverageDigest ||
      m.requestIdentityDigest !== digest(run.identity) ||
      Date.parse(m.expiresAt) <= Date.parse(run.createdAt) ||
      bytes(run) > 32768
    )
      invalid();
    const artifacts = n.artifacts.filter((v) => v.runId === run.id);
    let artifactBytes = 0;
    for (const a of artifacts) {
      const limit = a.key === "comparison-response" || a.key === "final-result" ? 4 * MiB : 2 * MiB;
      if (
        a.sha256 !== sha(a.body) ||
        a.sizeBytes !== Buffer.byteLength(a.body) ||
        a.sizeBytes > limit
      )
        invalid();
      artifactBytes += a.sizeBytes;
    }
    if (artifactBytes > 20 * MiB) invalid();
    const take = (key: z.infer<typeof artifact>["key"], expected?: string) => {
      const a = artifacts.find((v) => v.key === key);
      if (!a || (expected !== undefined && a.sha256 !== expected)) invalid();
      usedArtifacts.add(run.id + ":" + key);
      return a;
    };
    const context = take("comparison-context", m.contextSha256);
    const original = inspectArchivedPublicClaimRequest(run.command, context.body);
    if (
      digest(original.request.identity) !== digest(run.identity) ||
      take("comparison-request", run.identity.rawBodySha256).body !== original.request.rawBody
    )
      invalid();
    const proof: PublicComparisonBudgetSuffix["evidence"][number] = {
      runId: run.id,
      requestDigest: run.identity.requestDigest,
      manifestDigest: run.manifestDigest,
      dispatchEventDigest: null,
      responseArtifactSha256: null,
      cancellationEventDigest: null,
      assessment: null,
    };
    const events = n.events.filter((v) => v.runId === run.id);
    if (!events.length) invalid();
    let head = run.runDigest,
      revision = 0,
      at = run.createdAt,
      reservation: string | null = null;
    let unknown = false,
      settled = false,
      finalized = false,
      comparisonRecorded = false,
      comparisonState: string | null = null;
    let comparisonValue: unknown = null;
    let responseMetadata: ReturnType<typeof reportedProviderResponseMetadata> | null = null;
    const runBudget = financial.events.filter((v) => v.payload.runId === run.id);
    let financialCursor = 0;
    const money = (
      event: PublicComparisonNativeEvent,
      receipt: z.infer<typeof publicComparisonNativeReceiptSchema>,
      key: string,
    ) => {
      const b = budgetEvents.get(key),
        r = budgetReceipts.get(key);
      if (
        !b ||
        !r ||
        usedBudget.has(key) ||
        b.payload.runId !== run.id ||
        r.runId !== run.id ||
        runBudget[financialCursor++]?.eventDigest !== key ||
        b.scopeId !== m.scopeId ||
        b.environment !== m.environment ||
        b.currency !== m.currency ||
        b.unitScale !== m.unitScale ||
        receipt.budgetOperationDigest !== key ||
        receipt.clientRequestId !== r.clientRequestId ||
        receipt.inputDigest !== r.inputDigest ||
        receipt.recordedAt !== r.recordedAt ||
        b.recordedAt !== event.recordedAt
      )
        invalid();
      usedBudget.add(key);
      return b;
    };
    for (const e of events) {
      const { eventDigest, ...body } = e,
        p = e.payload,
        r = receipts.get(e.eventDigest);
      if (
        finalized ||
        e.revision !== ++revision ||
        e.previousDigest !== head ||
        digest(body) !== eventDigest ||
        Date.parse(e.recordedAt) < Date.parse(at) ||
        bytes(e) > 32768 ||
        !r ||
        bytes(r) > 4096 ||
        r.runId !== run.id ||
        r.eventRevision !== e.revision ||
        r.recordedAt !== e.recordedAt
      )
        invalid();
      head = eventDigest;
      at = e.recordedAt;
      const paired = ["reserved", "cancelled", "cost-settled"].includes(p.kind);
      if (!paired) {
        if (
          r.budgetOperationDigest !== null ||
          r.inputDigest !== publicComparisonNativeInputDigest(e)
        )
          invalid();
        extraReceipts.push(r);
      }
      if (p.kind === "reserved") {
        if (revision !== 1 || reservation !== null || e.recordedAt !== run.createdAt) invalid();
        const b = money(e, r, p.budgetEventDigest);
        if (
          b.payload.kind !== "reserve-comparison" ||
          b.payload.requestDigest !== proof.requestDigest ||
          b.payload.manifestDigest !== proof.manifestDigest ||
          b.payload.reservedUnits !== m.reservedUnits ||
          b.revision !== m.expectedBudgetHead.revision + 1 ||
          b.previousDigest !== m.expectedBudgetHead.headDigest
        )
          invalid();
        reservation = b.eventDigest;
      } else {
        if (!reservation) invalid();
        switch (p.kind) {
          case "dispatch-recorded":
            if (
              proof.dispatchEventDigest ||
              proof.cancellationEventDigest ||
              settled ||
              p.reservationDigest !== reservation ||
              p.requestDigest !== proof.requestDigest ||
              p.manifestDigest !== proof.manifestDigest ||
              Date.parse(e.recordedAt) >= Date.parse(m.expiresAt)
            )
              invalid();
            proof.dispatchEventDigest = eventDigest;
            break;
          case "dispatch-unknown":
            if (
              !proof.dispatchEventDigest ||
              p.dispatchEventDigest !== proof.dispatchEventDigest ||
              proof.responseArtifactSha256 ||
              unknown ||
              settled
            )
              invalid();
            unknown = true;
            break;
          case "cancelled": {
            if (
              proof.dispatchEventDigest ||
              proof.cancellationEventDigest ||
              settled ||
              p.reservationDigest !== reservation ||
              !r.budgetOperationDigest
            )
              invalid();
            proof.cancellationEventDigest = eventDigest;
            const b = money(e, r, r.budgetOperationDigest);
            if (
              b.payload.kind !== "release-comparison" ||
              b.payload.cancellationEventDigest !== eventDigest ||
              b.payload.reservationDigest !== reservation
            )
              invalid();
            settled = true;
            break;
          }
          case "response-captured": {
            if (
              !proof.dispatchEventDigest ||
              p.dispatchEventDigest !== proof.dispatchEventDigest ||
              proof.responseArtifactSha256 ||
              settled
            )
              invalid();
            const a = take("comparison-response", p.responseArtifactSha256);
            const parsed: unknown = JSON.parse(a.body),
              capture = captureProviderResponse(parsed);
            // No dropped unknown fields, alternate JSON, credentials or SDK helper properties.
            if (JSON.stringify(capture) !== a.body) invalid();
            responseMetadata = reportedProviderResponseMetadata(capture);
            const decoded = decodePublicClaimCapturedOutput(capture, run.command.model);
            comparisonState = decoded.state;
            if (decoded.state === "parsed") {
              try {
                comparisonValue = validatePreparedPublicClaimComparison(
                  original.prepared,
                  decoded.output,
                );
                comparisonState = "comparison-ready";
              } catch {
                comparisonState = "comparison-rejected";
              }
            }
            proof.responseArtifactSha256 = a.sha256;
            break;
          }
          case "comparison-recorded": {
            if (
              !proof.responseArtifactSha256 ||
              p.responseArtifactSha256 !== proof.responseArtifactSha256 ||
              comparisonRecorded
            )
              invalid();
            const expected = {
              source: "supplied-response",
              evidenceOrigin: "manual-unverified",
              ...publicClaimComparisonRequestAuthority,
              currentContextVerified: false,
              requestIdentity: run.identity,
              responseArtifactSha256: proof.responseArtifactSha256,
              state: comparisonState,
              comparison: comparisonValue,
            };
            if (
              take("comparison-validated", p.validatedArtifactSha256).body !==
              JSON.stringify(expected)
            )
              invalid();
            comparisonRecorded = true;
            break;
          }
          case "usage-assessed":
            if (
              !proof.responseArtifactSha256 ||
              proof.assessment ||
              settled ||
              p.assessment.requestDigest !== proof.requestDigest ||
              p.assessment.dispatchEventDigest !== proof.dispatchEventDigest ||
              p.assessment.responseArtifactSha256 !== proof.responseArtifactSha256
            )
              invalid();
            proof.assessment = p.assessment;
            break;
          case "cost-settled": {
            if (!proof.assessment || settled) invalid();
            const b = money(e, r, p.budgetEventDigest);
            if (
              b.payload.kind !== "recognize-comparison-usage" ||
              b.payload.usageAssessmentDigest !== digest(proof.assessment) ||
              b.payload.reservationDigest !== reservation
            )
              invalid();
            settled = true;
            break;
          }
          case "finalized": {
            if (
              !settled ||
              (!proof.cancellationEventDigest &&
                (!proof.responseArtifactSha256 || !comparisonRecorded))
            )
              invalid();
            const expected = {
              schemaVersion: 3,
              purpose: "compare-public-claim",
              runId: run.id,
              requestDigest: proof.requestDigest,
              manifestDigest: proof.manifestDigest,
              cancelled: proof.cancellationEventDigest !== null,
              responseArtifactSha256: proof.responseArtifactSha256,
              comparisonState,
              assessmentDigest: proof.assessment ? digest(proof.assessment) : null,
              costSettled: true,
              source: "supplied-native-archive",
              currentContextVerified: false,
              dispatchAllowed: false,
              costAssessmentVerified: false,
            };
            if (take("final-result", p.finalArtifactSha256).body !== JSON.stringify(expected))
              invalid();
            finalized = true;
            break;
          }
        }
      }
    }
    if (financialCursor !== runBudget.length) invalid();
    const used =
      bytes(run) +
      events.reduce((v, e) => v + bytes(e), 0) +
      n.receipts.filter((v) => v.runId === run.id).reduce((v, r) => v + bytes(r), 0) +
      runBudget.reduce((v, b) => v + bytes(b), 0) +
      artifacts.reduce(
        (v, a) =>
          v +
          a.sizeBytes +
          bytes({ runId: a.runId, key: a.key, sha256: a.sha256, sizeBytes: a.sizeBytes }),
        0,
      );
    if (
      used > 32 * MiB ||
      events.length > 32 ||
      runBudget.length > 16 ||
      events.length > 64 ||
      artifacts.length > 7
    )
      invalid();
    totalUsed += used;
    if (!finalized) {
      heldBytes += 32 * MiB - used;
      eventSlots += 32 - events.length;
      budgetSlots += 16 - runBudget.length;
      receiptSlots += 64 - events.length;
      artifactSlots += 7 - artifacts.length;
    }
    evidence.push(proof);
    summaries.push({
      runId: run.id,
      revision,
      headDigest: head,
      dispatchRecorded: proof.dispatchEventDigest !== null,
      dispatchUnknown: unknown,
      responseCaptured: proof.responseArtifactSha256 !== null,
      comparisonState,
      comparisonRecorded,
      costSettled: settled,
      finalized,
      usedBytes: used,
      heldBytes: finalized ? 0 : 32 * MiB - used,
      responseMetadata,
      currentContextVerified: false as const,
      owner: null,
    });
  }
  if (usedBudget.size !== financial.events.length || usedArtifacts.size !== n.artifacts.length)
    invalid();
  return {
    records: n,
    evidence,
    summaries,
    extraReceipts,
    totalUsed,
    heldBytes,
    reservedEventSlots: eventSlots,
    reservedBudgetSlots: budgetSlots,
    reservedReceiptSlots: receiptSlots,
    reservedArtifactSlots: artifactSlots,
  };
}
