import "server-only";
import { z } from "zod";
import { StudioError } from "./studio-http";
import type { StudioStore } from "./studio-storage";
import { getAiStatus } from "./studio-engine";
import { studioGenerationJobs } from "./studio-generation-lock";
import { localPreparationIsRunning } from "./studio-preparation";
import { preparationAutomationIsRunning } from "./studio-preparation-automation-service";
import { assertVentureCompanyWritable } from "./venturein-input-lock";
import { planSupplementInputSchema } from "./studio-plan-supplement-types";
import { preparePlanSupplement } from "./studio-plan-supplement";
import {
  auditPlanSupplementExecutions,
  buildPlanSupplementExecutionApproval,
  replayPlanSupplementExecution,
} from "./studio-plan-supplement-execution-state";
import {
  planSupplementExecutionCommandSchema,
  planSupplementModelSchema,
  type PlanSupplementExecutionCommand,
} from "./studio-plan-supplement-execution-types";
import {
  buildPlanSupplementSdkRequest,
  dispatchPlanSupplementSdk,
  type PlanSupplementOwner,
} from "./studio-plan-supplement-sdk";
import { planSupplementResult } from "./studio-plan-supplement-result";

export const planSupplementServiceCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("prepare-ai"), input: planSupplementInputSchema }).strict(),
  planSupplementExecutionCommandSchema,
  z
    .object({ action: z.literal("recover"), command: planSupplementExecutionCommandSchema })
    .strict(),
]);
type Entry = {
  command: PlanSupplementExecutionCommand;
  owner: PlanSupplementOwner;
  active: boolean;
};
export class PlanSupplementRequestError extends StudioError {
  constructor(
    code: string,
    status: number,
    public accepted: boolean,
  ) {
    super(
      "수정안 요청의 저장 상태를 확인해 주세요. 원래 요청을 유지하며 자동으로 다시 전송하지 않습니다.",
      status,
      code,
    );
  }
}
/** Constructor dependencies are internal only. Production factory supplies server config/network. */
export class PlanSupplementService {
  private entries = new Map<string, Entry>();
  private retired = false;
  private readonly configuration: () => { model: string; apiKey: string };
  private readonly network: typeof fetch;
  constructor(
    private readonly store: StudioStore,
    dependencies: { configuration: () => { model: string; apiKey: string }; network: typeof fetch },
  ) {
    this.configuration = dependencies.configuration;
    this.network = dependencies.network;
  }
  status(caseId: string) {
    const company = this.store.get(caseId);
    auditPlanSupplementExecutions(company);
    const entry = this.entries.get(caseId);
    return {
      company,
      active: entry?.active ?? false,
      retainedCapture: entry?.owner.status().retained ?? false,
      executions: (company.planSupplementExecutions ?? []).map((record) => ({
        record,
        ...planSupplementResult(company, record),
      })),
      transmissionAllowed: false as const,
    };
  }
  preview(caseId: string, raw: unknown) {
    const input = planSupplementInputSchema.parse(raw),
      company = this.store.get(caseId);
    auditPlanSupplementExecutions(company);
    const configuration = this.configuration(),
      model = planSupplementModelSchema.parse(configuration.model);
    return {
      ...preparePlanSupplement(company, input),
      approval: buildPlanSupplementExecutionApproval(company, input, model),
      aiConfigured: Boolean(configuration.apiKey.trim()),
    };
  }
  private accepted(caseId: string, command: PlanSupplementExecutionCommand) {
    if (this.entries.has(caseId)) return true;
    try {
      return Boolean(replayPlanSupplementExecution(this.store.get(caseId), command));
    } catch {
      return true;
    }
  }
  private release(caseId: string, entry: Entry) {
    if (entry.owner.close()) {
      this.entries.delete(caseId);
      studioGenerationJobs.delete(caseId);
    }
  }
  async run(caseId: string, raw: unknown) {
    const command = planSupplementExecutionCommandSchema.parse(raw);
    // This path must precede every key/model read, new owner, or SDK construction.
    const previous = replayPlanSupplementExecution(this.store.get(caseId), command);
    if (previous) return this.status(caseId);
    if (this.retired) throw new PlanSupplementRequestError("SUPPLEMENT_SERVICE_CLOSED", 409, false);
    if (
      this.entries.has(caseId) ||
      studioGenerationJobs.has(caseId) ||
      localPreparationIsRunning(caseId) ||
      preparationAutomationIsRunning(caseId)
    )
      throw new PlanSupplementRequestError("SUPPLEMENT_BUSY", 409, this.entries.has(caseId));
    let entry: Entry | undefined;
    studioGenerationJobs.add(caseId);
    try {
      assertVentureCompanyWritable(caseId);
      const rawConfig = this.configuration();
      const configuration = {
        model: planSupplementModelSchema.parse(rawConfig.model),
        apiKey: rawConfig.apiKey.trim(),
      };
      if (!configuration.apiKey)
        throw new StudioError("AI 키를 설정해 주세요.", 503, "AI_NOT_CONFIGURED");
      const assertConfiguration = () => {
        const current = this.configuration();
        if (current.model !== configuration.model || current.apiKey.trim() !== configuration.apiKey)
          throw new StudioError(
            "AI 설정이 변경되었습니다.",
            409,
            "SUPPLEMENT_CONFIGURATION_CHANGED",
          );
      };
      const prepared = preparePlanSupplement(this.store.get(caseId), command.input);
      const rawBody = buildPlanSupplementSdkRequest(prepared.payload, configuration.model);
      const started = this.store.beginPlanSupplementExecution(caseId, command, () => {
        assertConfiguration();
        return configuration.model;
      });
      if (!started.owner) return this.status(caseId);
      entry = { command: structuredClone(command), owner: started.owner, active: true };
      this.entries.set(caseId, entry);
      const capture = await dispatchPlanSupplementSdk(
        rawBody,
        configuration.apiKey,
        this.network,
        entry.owner,
        assertConfiguration,
      );
      entry.owner.retain(capture);
      entry.active = false;
      entry.owner.persist();
      this.release(caseId, entry);
      return this.status(caseId);
    } catch (error) {
      if (entry) entry.active = false;
      throw new PlanSupplementRequestError(
        error instanceof StudioError ? error.code : "SUPPLEMENT_STORAGE_UNCONFIRMED",
        error instanceof StudioError ? error.status : 500,
        this.accepted(caseId, command),
      );
    } finally {
      if (!this.entries.has(caseId)) studioGenerationJobs.delete(caseId);
    }
  }
  recover(caseId: string, raw: unknown) {
    const command = planSupplementExecutionCommandSchema.parse(raw);
    try {
      const recorded = replayPlanSupplementExecution(this.store.get(caseId), command),
        entry = this.entries.get(caseId);
      if (!recorded)
        throw new PlanSupplementRequestError("SUPPLEMENT_REQUEST_NOT_FOUND", 409, Boolean(entry));
      if (entry && !entry.active && entry.command.clientRequestId === command.clientRequestId) {
        if (!entry.owner.status().retained)
          throw new PlanSupplementRequestError("SUPPLEMENT_CAPTURE_UNAVAILABLE", 409, true);
        entry.owner.persist();
        this.release(caseId, entry);
      }
      // A cold service only reads. It never creates a replacement owner or provider call.
      return this.status(caseId);
    } catch (error) {
      if (error instanceof PlanSupplementRequestError) throw error;
      throw new PlanSupplementRequestError(
        error instanceof StudioError ? error.code : "SUPPLEMENT_STORAGE_UNCONFIRMED",
        error instanceof StudioError ? error.status : 500,
        this.accepted(caseId, command),
      );
    }
  }
  close() {
    if (this.entries.size) return false;
    this.retired = true;
    return true;
  }
}
const shared = globalThis as typeof globalThis & {
  __venturepassSupplementServices?: WeakMap<StudioStore, PlanSupplementService>;
};
const services = (shared.__venturepassSupplementServices ??= new WeakMap<
  StudioStore,
  PlanSupplementService
>());
export function getPlanSupplementService(store: StudioStore) {
  let service = services.get(store);
  if (!service) {
    service = new PlanSupplementService(store, {
      configuration: () => ({
        model: getAiStatus().model,
        apiKey: process.env.OPENAI_API_KEY ?? "",
      }),
      network: globalThis.fetch.bind(globalThis),
    });
    services.set(store, service);
  }
  return service;
}
