import { z } from "zod";
import { caseSchema, planContentSchema, type StudioCase } from "@/lib/studio-schema";
import {
  planSupplementInputSchema,
  type PlanSupplementInput,
} from "@/lib/studio-plan-supplement-types";
import {
  planSupplementExecutionApprovalSchema,
  planSupplementExecutionCommandSchema,
  type PlanSupplementExecutionCommand,
} from "@/lib/studio-plan-supplement-execution-types";
import {
  planSupplementAdoptionCommandSchema,
  planSupplementAdoptionInspectionSchema,
  type PlanSupplementAdoptionInspection,
  planSupplementAdoptionSelectionSchema,
  type PlanSupplementAdoptionCommand,
} from "@/lib/studio-plan-supplement-adoption-types";
import type { PlanSupplementService } from "@/lib/studio-plan-supplement-service";
import type { preparePlanSupplementAdoption } from "@/lib/studio-plan-supplement-adoption";
import { answerSuggestionInput, validateBinding } from "./answer-suggestions-ui";
import { suggestionTextHash as sha } from "./source-suggestions-ui";

export type SupplementStatus = ReturnType<PlanSupplementService["status"]>;
export type SupplementPreview = ReturnType<PlanSupplementService["preview"]>;
export type SupplementComparison = ReturnType<typeof preparePlanSupplementAdoption>;
export type SupplementCommand = PlanSupplementExecutionCommand | PlanSupplementAdoptionCommand;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function fail(): never {
  throw Error("원래 회사·원고·요청과 응답이 일치하지 않습니다. 저장 상태를 확인해 주세요.");
}
export async function supplementInput(
  company: StudioCase,
  questionIndex: number,
  sectionKey: PlanSupplementInput["sectionKey"],
  sourceIds: string[],
) {
  const plan = company.plans.at(-1);
  if (!plan) return null;
  const questionText = plan.content.interviewQuestions[questionIndex];
  if (!questionText) return null;
  const base = await answerSuggestionInput(
    company,
    {
      kind: "visit-question",
      planId: plan.id,
      planVersion: plan.version,
      questionIndex,
      questionText,
    },
    sourceIds,
    null,
  );
  return base
    ? planSupplementInputSchema.parse({
        ...base,
        sectionKey,
        baseContentSha256: await sha(JSON.stringify(plan.content)),
      })
    : null;
}
export async function validateSupplementPreview(
  raw: unknown,
  company: StudioCase,
  input: PlanSupplementInput,
): Promise<SupplementPreview> {
  const value = raw as SupplementPreview;
  const approval = planSupplementExecutionApprovalSchema.parse(value?.approval);
  const plan = company.plans.at(-1);
  const target = input.target;
  const section = plan?.content.sections.find((item) => item.key === input.sectionKey);
  if (
    !plan ||
    !section ||
    target.kind !== "visit-question" ||
    plan.id !== target.planId ||
    value.transmissionAllowed !== false ||
    value.databaseChanged !== false ||
    typeof value.aiConfigured !== "boolean" ||
    value.actualTokenCountMeasured !== false ||
    value.contextFitVerified !== false ||
    value.characterLimit !== 240000 ||
    !equal(value.binding, approval.binding) ||
    !(await validateBinding(company, input, approval.binding.answer)) ||
    input.baseContentSha256 !== (await sha(JSON.stringify(plan.content)))
  )
    fail();
  const payload = JSON.stringify({
    purpose: "propose-one-section-supplement",
    question: target.questionText,
    section: { key: section!.key, title: section!.title, content: section!.content },
    sources: input.sourceSelections.map((selection) => {
      const source = company.sources.find((item) => item.id === selection.sourceId)!;
      return { sourceId: source.id, sourceName: source.name, text: source.text };
    }),
  });
  const { review, ...identity } = plan!;
  void review;
  const { inputSha256, ...binding } = approval.binding;
  if (
    value.payload !== payload ||
    value.characters !== payload.length ||
    payload.length > 240000 ||
    approval.payloadSha256 !== (await sha(payload)) ||
    binding.payloadSha256 !== approval.payloadSha256 ||
    binding.sectionKey !== input.sectionKey ||
    binding.basePlanSha256 !== (await sha(JSON.stringify(identity))) ||
    inputSha256 !== (await sha(JSON.stringify(binding))) ||
    !equal(value.retainedEvidence, section!.evidence)
  )
    fail();
  return structuredClone(value);
}
export async function validateSupplementStatus(
  raw: unknown,
  caseId: string,
  minimumRevision = 0,
): Promise<SupplementStatus> {
  const value = raw as SupplementStatus;
  const company = caseSchema.parse(value?.company);
  if (
    company.id !== caseId ||
    company.revision < minimumRevision ||
    value.transmissionAllowed !== false ||
    typeof value.active !== "boolean" ||
    typeof value.retainedCapture !== "boolean" ||
    !Array.isArray(value.executions) ||
    !equal(
      value.executions.map((item) => item.record),
      company.planSupplementExecutions ?? [],
    )
  )
    fail();
  for (const { record } of value.executions) {
    if (
      record.command.approval.binding.answer.caseId !== caseId ||
      record.commandSha256 !== (await sha(JSON.stringify(record.command))) ||
      (record.capture && record.captureSha256 !== (await sha(JSON.stringify(record.capture))))
    )
      fail();
  }
  return structuredClone(value);
}
export async function validateSupplementComparison(
  raw: unknown,
  status: SupplementStatus,
  executionId: string,
): Promise<SupplementComparison> {
  const value = raw as SupplementComparison;
  const selection = planSupplementAdoptionSelectionSchema.parse(value?.selection);
  const run = status.executions.find((item) => item.record.id === executionId);
  const proposal = run?.proposal;
  const company = status.company;
  if (
    !proposal ||
    run?.state !== "comparison-ready" ||
    value.databaseChanged !== false ||
    value.transmissionAllowed !== false ||
    selection.caseId !== company.id ||
    selection.revision !== company.revision ||
    selection.executionId !== executionId ||
    selection.executionCommandSha256 !== run.record.commandSha256 ||
    selection.captureSha256 !== run.record.captureSha256 ||
    selection.proposalSha256 !== proposal.proposalSha256 ||
    selection.comparisonSha256 !== (await sha(JSON.stringify(proposal))) ||
    !equal(value.proposal, proposal)
  )
    fail();
  const p = value.proposal,
    plan = company.plans.at(-1);
  const content = planContentSchema.parse(p.content);
  const before = plan?.content.sections.find((item) => item.key === p.sectionKey);
  const after = content.sections.find((item) => item.key === p.sectionKey);
  const restored = {
    ...content,
    sections: content.sections.map((item) => (item.key === p.sectionKey ? before : item)),
  };
  if (
    !plan ||
    p.origin !== "captured-sdk-draft" ||
    p.executionId !== executionId ||
    p.captureSha256 !== selection.captureSha256 ||
    p.basePlanId !== plan.id ||
    p.basePlanVersion !== plan.version ||
    p.sectionKey !== run!.record.command.input.sectionKey ||
    !equal(p.binding, run!.record.command.approval.binding) ||
    !equal(before, p.before) ||
    !equal(after, p.after) ||
    !equal(restored, plan.content) ||
    after?.needsConfirmation !== true ||
    p.factVerified !== false ||
    p.semanticQualityVerified !== false ||
    p.reviewStatus !== "unreviewed" ||
    p.databaseChanged !== false ||
    p.transmissionAllowed !== false
  )
    fail();
  return structuredClone(value);
}

export async function validateSupplementInspection(
  raw: unknown,
  status: SupplementStatus,
  command: PlanSupplementAdoptionCommand,
) {
  const value = planSupplementAdoptionInspectionSchema.parse(raw);
  const company = status.company;
  if (
    value.caseId !== company.id ||
    value.revision !== company.revision ||
    !equal(value.command, command) ||
    value.commandSha256 !== (await sha(JSON.stringify(command)))
  )
    fail();
  const receipt =
    company.planSupplementAdoptions?.find(
      (item) => item.command.clientRequestId === command.clientRequestId,
    ) ?? null;
  if (!equal(value.receipt, receipt) || (receipt && !equal(receipt.command, command))) fail();
  if (value.canClose) {
    const run = company.planSupplementExecutions?.find((item) => item.id === command.executionId);
    const target = run?.command.input.target;
    const base =
      target?.kind === "visit-question"
        ? company.plans.find((item) => item.id === target.planId)
        : undefined;
    if (
      receipt ||
      !run ||
      run.capture?.kind !== "response" ||
      command.executionCommandSha256 !== run.commandSha256 ||
      command.captureSha256 !== run.captureSha256 ||
      command.revision !== run.finishedRevision ||
      run.finishedRevision !== run.reservationRevision + 1 ||
      target?.kind !== "visit-question" ||
      !base ||
      base.version !== target.planVersion ||
      (await sha(JSON.stringify(base.content))) !== run.command.input.baseContentSha256 ||
      company.planSupplementExecutions?.some(
        (item) => item.command.clientRequestId === command.clientRequestId,
      )
    )
      fail();
  }
  return value;
}

const commandSchema = z.union([
  planSupplementExecutionCommandSchema,
  planSupplementAdoptionCommandSchema,
]);
const journalSchema = z
  .object({
    format: z.literal("supplement-request-v1"),
    caseId: z.string().uuid(),
    command: commandSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type SupplementTransport = (
  path: "execution" | "adoption",
  command?: unknown,
) => Promise<unknown>;
export type SupplementLock = <T>(name: string, task: () => Promise<T>) => Promise<T>;
export class SupplementHttpError extends Error {
  constructor(
    message: string,
    readonly accepted: boolean | undefined,
  ) {
    super(message);
  }
}
/** Stores identities and the exact command, never source bytes, manuscript bodies, keys or responses. */
export class SupplementRequestJournal {
  private key: string;
  constructor(
    readonly caseId: string,
    private storage: StoragePort,
    private lock: SupplementLock,
    private transport: SupplementTransport,
  ) {
    z.string().uuid().parse(caseId);
    this.key = `venturepass:plan-supplement:v1:${caseId}`;
  }
  async pending(): Promise<SupplementCommand | null> {
    const text = this.storage.getItem(this.key);
    if (text === null) return null;
    if (text.length > 32768) fail();
    const entry = journalSchema.parse(JSON.parse(text));
    const caseId =
      entry.command.action === "propose-section"
        ? entry.command.approval.binding.answer.caseId
        : entry.command.caseId;
    if (
      entry.caseId !== this.caseId ||
      caseId !== this.caseId ||
      entry.sha256 !== (await sha(JSON.stringify(entry.command)))
    )
      fail();
    return structuredClone(entry.command);
  }
  private async save(command: SupplementCommand) {
    const entry = journalSchema.parse({
      format: "supplement-request-v1",
      caseId: this.caseId,
      command,
      sha256: await sha(JSON.stringify(command)),
    });
    const text = JSON.stringify(entry);
    if (text.length > 32768) fail();
    this.storage.setItem(this.key, text);
    if (!equal(await this.pending(), command)) fail();
  }
  private async remove(command: SupplementCommand) {
    if (!equal(await this.pending(), command)) fail();
    this.storage.removeItem(this.key);
    if (this.storage.getItem(this.key) !== null) fail();
  }
  private async inspect(): Promise<SupplementStatus> {
    const status = await validateSupplementStatus(await this.transport("execution"), this.caseId);
    const command = await this.pending();
    if (!command) return status;
    if (command.action === "adopt-section-supplement") {
      const audit = (await this.transport("adoption")) as {
        caseId: string;
        revision: number;
        receipts: unknown;
        databaseChanged: false;
        transmissionAllowed: false;
      };
      if (
        audit.caseId !== this.caseId ||
        audit.revision !== status.company.revision ||
        audit.databaseChanged !== false ||
        audit.transmissionAllowed !== false ||
        !equal(audit.receipts, status.company.planSupplementAdoptions ?? [])
      )
        fail();
    }
    const run =
      command.action === "propose-section"
        ? status.executions.find(
            (item) => item.record.command.clientRequestId === command.clientRequestId,
          )?.record
        : status.company.planSupplementAdoptions?.find(
            (item) => item.command.clientRequestId === command.clientRequestId,
          );
    if (run) {
      if (
        !equal(run.command, command) ||
        run.commandSha256 !== (await sha(JSON.stringify(command)))
      )
        fail();
      if (command.action === "adopt-section-supplement") {
        const receipt = status.company.planSupplementAdoptions!.find(
          (item) => item.command.clientRequestId === command.clientRequestId,
        )!;
        const plan = status.company.plans.find((item) => item.id === receipt.planId);
        if (!plan || plan.version !== receipt.planVersion) fail();
        const { review, confirmedAt, ...identity } = plan;
        void review;
        void confirmedAt;
        if (receipt.planIdentitySha256 !== (await sha(JSON.stringify(identity)))) fail();
      }
      await this.remove(command);
    }
    return status;
  }
  /** Opening/reloading is GET only. No automatic resend, adoption or capture recovery. */
  read() {
    return this.lock(this.key, () => this.inspect());
  }
  execute(raw: SupplementCommand, retry = false) {
    // Snapshot before awaiting the lock: callers cannot replace a command mid-flight.
    const command = commandSchema.parse(structuredClone(raw));
    return this.lock(this.key, async () => {
      const caseId =
        command.action === "propose-section"
          ? command.approval.binding.answer.caseId
          : command.caseId;
      if (caseId !== this.caseId) fail();
      const pending = await this.pending();
      if (pending && (!retry || !equal(pending, command))) fail();
      if (retry && !pending) fail();
      if (!pending) await this.save(command);
      const path = command.action === "propose-section" ? "execution" : "adoption";
      try {
        await this.transport(path, structuredClone(command));
      } catch (error) {
        // Only a direct first response under the exclusive lock proves non-acceptance.
        if (!retry && error instanceof SupplementHttpError && error.accepted === false)
          await this.remove(command);
        throw error;
      }
      return this.inspect();
    });
  }
  /** Explicit local read; mounting still uses GET only. No automatic closure. */
  inspectClosure(raw: PlanSupplementAdoptionCommand) {
    const command = planSupplementAdoptionCommandSchema.parse(structuredClone(raw));
    return this.lock(this.key, async () => {
      if (!equal(await this.pending(), command)) fail();
      const status = await this.inspect();
      if (!(await this.pending())) return { status, inspection: null };
      const inspection = await validateSupplementInspection(
        await this.transport("adoption", { action: "inspect-adoption", command }),
        status,
        command,
      );
      return { status, inspection };
    });
  }
  closeUnadopted(raw: PlanSupplementAdoptionInspection, confirmed: boolean) {
    const expected = planSupplementAdoptionInspectionSchema.parse(structuredClone(raw));
    if (!confirmed || !expected.canClose || expected.caseId !== this.caseId) fail();
    return this.lock(this.key, async () => {
      if (!equal(await this.pending(), expected.command)) fail();
      const status = await this.inspect();
      if (!(await this.pending())) return { status, outcome: "adopted" as const };
      const inspection = await validateSupplementInspection(
        await this.transport("adoption", { action: "inspect-adoption", command: expected.command }),
        status,
        expected.command,
      );
      if (!inspection.canClose || !equal(inspection, expected)) fail();
      await this.remove(expected.command);
      return { status, outcome: "closed-without-adoption" as const };
    });
  }
  recover(raw: PlanSupplementExecutionCommand) {
    const command = planSupplementExecutionCommandSchema.parse(structuredClone(raw));
    return this.lock(this.key, async () => {
      const status = await this.inspect();
      const original = status.executions.find((item) => equal(item.record.command, command));
      if (!original || status.active || command.approval.binding.answer.caseId !== this.caseId)
        fail();
      await this.transport("execution", { action: "recover", command });
      return this.inspect();
    });
  }
}
export const supplementBrowserLock: SupplementLock = async (name, task) => {
  if (!navigator.locks) throw Error("이 브라우저에서는 요청 잠금을 사용할 수 없습니다.");
  return navigator.locks.request(name, { mode: "exclusive", ifAvailable: true }, async (lock) => {
    if (!lock) throw Error("다른 창에서 이 회사의 수정안을 처리 중입니다.");
    return task();
  });
};
export function supplementTransport(caseId: string): SupplementTransport {
  return async (path, command) => {
    const response = await fetch(`/api/studio/cases/${caseId}/plan-supplements/${path}`, {
      cache: "no-store",
      ...(command
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(command),
          }
        : {}),
    });
    const value = await response.json();
    if (!response.ok)
      throw new SupplementHttpError(
        value.error ?? "수정안 요청의 저장 상태를 확인해 주세요.",
        typeof value.accepted === "boolean" ? value.accepted : undefined,
      );
    return value;
  };
}
