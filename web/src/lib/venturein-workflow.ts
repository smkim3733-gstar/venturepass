import "server-only";

import { z } from "zod";
import { getStudioStore, type StudioStore } from "./studio-storage";
import { StudioError } from "./studio-http";
import { getVentureAccountStatus } from "./venturein-vault";
import { getVentureSession, inspectVentureApplication } from "./venturein-runner";
import { validateVentureScreenSnapshot, type VentureScreenSnapshot } from "./venturein-inspection";
import {
  buildVenturePreflight,
  ventureSubmissionDraftSchema,
  type VentureBoundSnapshot,
  type VentureOriginalMetadata,
  type VenturePreflightReport,
  type VentureSubmissionDraft,
} from "./venturein-preflight";
import type { VentureSessionStatus } from "./venturein-schema";
import {
  ventureExecutionRecordSchema,
  type VentureExecutionRecord,
} from "./venturein-execution-schema";
import {
  appendVentureJourney,
  buildVentureJourney,
  ventureJourneyHistorySchema,
  type VentureJourney,
} from "./venturein-journey";

const revision = z.number().int().nonnegative().safe();
const screenSchema = z.custom<VentureScreenSnapshot>((value) => {
  try {
    validateVentureScreenSnapshot(value);
    return true;
  } catch {
    return false;
  }
}, "공식 화면 기록을 확인할 수 없습니다.");
const boundSchema = z
  .object({
    screen: screenSchema,
    caseId: z.string().uuid(),
    sessionStartedAt: z.string().datetime(),
    accountRevision: revision,
  })
  .strict();
const storedSchema = z
  .object({
    snapshot: boundSchema.nullable(),
    draft: ventureSubmissionDraftSchema.nullable(),
    execution: ventureExecutionRecordSchema.nullable().default(null),
    history: ventureJourneyHistorySchema.default([]),
  })
  .strict();

export type VentureWorkflowStatus = {
  revision: number;
  updatedAt: string | null;
  snapshot: VentureBoundSnapshot | null;
  draft: VentureSubmissionDraft | null;
  report: VenturePreflightReport;
  originalFiles: VentureOriginalMetadata[];
  accountRevision: number;
  session: VentureSessionStatus;
  execution: VentureExecutionRecord | null;
  journey: VentureJourney;
};

export const inspectWorkflowSchema = z
  .object({
    action: z.literal("inspect"),
    destination: z.enum(["application", "current", "innovation"]),
    revision,
    accountRevision: revision,
    companyRevision: revision,
  })
  .strict();
export const saveWorkflowSchema = z
  .object({
    revision,
    accountRevision: revision,
    companyRevision: revision,
    draft: ventureSubmissionDraftSchema,
  })
  .strict();

export function readVentureWorkflowStored(store: StudioStore, caseId: string) {
  const envelope = store.getVentureWorkflowEnvelope(caseId);
  const data = envelope.body
    ? storedSchema.parse(JSON.parse(envelope.body))
    : { snapshot: null, draft: null, execution: null, history: [] };
  if (data.snapshot && data.snapshot.caseId !== caseId)
    throw new StudioError(
      "다른 기업의 신청 연결 기록입니다. 현재 화면을 다시 확인해 주세요.",
      409,
      "WORKFLOW_CASE_MISMATCH",
    );
  return { envelope, data };
}

export function getVentureWorkflow(caseId: string): VentureWorkflowStatus {
  const store = getStudioStore();
  const company = store.get(caseId);
  const { envelope, data } = readVentureWorkflowStored(store, caseId);
  const accountRevision = getVentureAccountStatus(store, caseId).revision;
  const session = getVentureSession(caseId);
  const originalFiles = company.sources
    .filter((source) => source.originalName)
    .map((source) => store.originalMetadata(caseId, source.id));
  const plan = company.plans.find((item) => item.id === data.draft?.planId) ?? company.plans.at(-1);
  const report = buildVenturePreflight({
    company,
    ...data,
    session,
    accountRevision,
    planIsCurrent: Boolean(plan && store.isPlanCurrent(caseId, plan)),
    originalFiles,
  });
  return {
    revision: envelope.revision,
    updatedAt: envelope.updatedAt,
    ...data,
    originalFiles,
    accountRevision,
    session,
    report,
    journey: buildVentureJourney({
      ...data,
      session,
      accountRevision,
      companyRevision: company.revision,
      report,
    }),
  };
}

export function assertVentureWorkflowVersions(
  caseId: string,
  input: { revision: number; accountRevision: number; companyRevision: number },
) {
  const store = getStudioStore();
  if (getVentureAccountStatus(store, caseId).revision !== input.accountRevision)
    throw new StudioError(
      "저장 계정이 변경되었습니다. 연결 상태를 새로 불러와 주세요.",
      409,
      "STALE_ACCOUNT",
    );
  if (store.get(caseId).revision !== input.companyRevision)
    throw new StudioError(
      "기업자료가 변경되었습니다. 기업 화면을 새로 불러와 주세요.",
      409,
      "STALE_REVISION",
    );
  if (store.getVentureWorkflowEnvelope(caseId).revision !== input.revision)
    throw new StudioError(
      "신청 연결 기록이 변경되었습니다. 다시 불러와 주세요.",
      409,
      "STALE_WORKFLOW",
    );
  return store;
}

export async function inspectVentureWorkflow(
  caseId: string,
  input: z.infer<typeof inspectWorkflowSchema>,
) {
  assertVentureWorkflowVersions(caseId, input);
  const observed = await inspectVentureApplication(caseId, input.destination);
  const store = assertVentureWorkflowVersions(caseId, input);
  const snapshot: VentureBoundSnapshot = {
    ...observed,
    caseId,
    accountRevision: input.accountRevision,
  };
  // A new observation invalidates old field selections even if its URL happens to be the same.
  const { data: previous } = readVentureWorkflowStored(store, caseId);
  const history = appendVentureJourney(previous.history, previous.snapshot, previous.execution);
  const data = storedSchema.parse({
    snapshot,
    draft: null,
    execution: previous.execution,
    history: appendVentureJourney(history, snapshot, null),
  });
  store.saveVentureWorkflowEnvelope(caseId, input.revision, JSON.stringify(data));
  return getVentureWorkflow(caseId);
}

export function saveVentureWorkflow(caseId: string, input: z.infer<typeof saveWorkflowSchema>) {
  const store = assertVentureWorkflowVersions(caseId, input);
  const { data } = readVentureWorkflowStored(store, caseId);
  const snapshot = data.snapshot;
  const draft = input.draft;
  if (
    !snapshot ||
    draft.caseId !== caseId ||
    draft.snapshotId !== snapshot.screen.id ||
    draft.sessionStartedAt !== snapshot.sessionStartedAt ||
    draft.accountRevision !== snapshot.accountRevision ||
    draft.accountRevision !== input.accountRevision ||
    draft.companyRevision !== input.companyRevision
  )
    throw new StudioError(
      "현재 기업·계정·공식 화면에 맞는 연결안을 다시 작성해 주세요.",
      409,
      "STALE_MAPPING",
    );
  store.saveVentureWorkflowEnvelope(
    caseId,
    input.revision,
    JSON.stringify(
      storedSchema.parse({ snapshot, draft, execution: data.execution, history: data.history }),
    ),
  );
  return getVentureWorkflow(caseId);
}
