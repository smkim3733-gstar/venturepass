import { inspectActualLedger } from "./local-data-quality-actual.mjs";
import { inspectProviderPolicyLedger } from "./local-data-quality-provider-policy.mjs";

const invalid = () => {
  throw new Error("QUALITY_LEDGER_INVALID");
};
const array = (value) => {
  if (!Array.isArray(value)) invalid();
  return value;
};
const version = (value, run = false) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  if (value.schemaVersion === 2) return 2;
  if (run ? value.schemaVersion === 1 : !Object.hasOwn(value, "schemaVersion")) return 1;
  return invalid();
};

/** Runs must be in the database's immutable insertion order, not UUID/time order. */
export function inspectQualityLedgers(input) {
  const runs = array(input.runs),
    events = array(input.events),
    artifacts = array(input.artifacts);
  const budgetEvents = array(input.budgetEvents),
    receipts = array(input.receipts);
  if (
    runs.length > 20 ||
    events.length > 640 ||
    artifacts.length > 140 ||
    budgetEvents.length > 1000 ||
    receipts.length > 1000
  )
    invalid();
  const owners = new Map();
  runs.forEach((run, index) => {
    const v = version(run, true);
    if (typeof run.id !== "string" || owners.has(run.id)) invalid();
    if (v === 2 && run.expectedGlobalRunCount !== index) invalid();
    owners.set(run.id, v);
  });
  const otherNonces = array(input.otherNonces ?? []),
    policies = array(input.policies === undefined ? [] : input.policies);
  const nonces = new Set(otherNonces);
  if (nonces.size !== otherNonces.length) invalid();
  for (const policy of policies) {
    if (typeof policy?.clientRequestId !== "string" || nonces.has(policy.clientRequestId))
      invalid();
    nonces.add(policy.clientRequestId);
  }
  for (const receipt of receipts) {
    version(receipt);
    if (typeof receipt.clientRequestId !== "string" || nonces.has(receipt.clientRequestId))
      invalid();
    nonces.add(receipt.clientRequestId);
    if (receipt.runId !== null && owners.get(receipt.runId) !== version(receipt)) invalid();
  }
  for (const event of events) if (owners.get(event.runId) !== version(event)) invalid();
  for (const event of budgetEvents) version(event);
  for (const artifact of artifacts) if (!owners.has(artifact.runId)) invalid();
  const pick = (v) => ({
    runs: runs.filter((row) => version(row, true) === v),
    events: events.filter((row) => version(row) === v),
    budgetEvents: budgetEvents.filter((row) => version(row) === v),
    receipts: receipts.filter((row) => version(row) === v),
    artifacts: artifacts.filter((row) => owners.get(row.runId) === v),
    registries: input.registries,
    otherNonces: [...otherNonces, ...policies.map((row) => row.clientRequestId)],
  });
  const legacyInput = pick(1),
    providerInput = pick(2);
  const legacy = { ...legacyInput, ...inspectActualLedger(legacyInput) };
  const policy = inspectProviderPolicyLedger({
    records: policies,
    registries: input.registries,
    provider: providerInput,
    otherNonces,
  });
  const provider = { ...providerInput, ...policy.provider };
  const reservedBytes = legacy.reservedBytes + provider.reservedBytes;
  const reservedBudgetEventSlots =
    legacy.reservedBudgetEventSlots + provider.reservedBudgetEventSlots;
  const reservedReceiptSlots = legacy.reservedReceiptSlots + provider.reservedReceiptSlots;
  const usedBytes = legacy.usedBytes + provider.usedBytes + policy.usedBytes;
  if (
    !Number.isSafeInteger(reservedBytes) ||
    reservedBytes < 0 ||
    usedBytes + reservedBytes > 256 * 1024 * 1024 ||
    budgetEvents.length + reservedBudgetEventSlots > 1000 ||
    receipts.length + reservedReceiptSlots > 1000
  )
    invalid();
  return {
    legacy,
    provider,
    policy,
    reservedBytes,
    reservedBudgetEventSlots,
    reservedReceiptSlots,
    usedBytes,
    globalRunCount: runs.length,
  };
}
