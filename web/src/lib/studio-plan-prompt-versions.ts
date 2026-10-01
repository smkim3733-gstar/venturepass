import type { EngineExecutionTransportRequest } from "./studio-engine-execution-types";
import { getV1PlanPromptDefinition } from "./studio-plan-prompt-v1";
import { getV2PlanPromptDefinition } from "./studio-plan-prompt-v2";

export type PlanPromptVersion = "plan-observation-v1" | "plan-observation-v2";
type PlanWireFormat = EngineExecutionTransportRequest["body"]["text"]["format"];
export type PlanPromptDefinition = {
  engineVersion: PlanPromptVersion;
  systemPrompt: string;
  candidateClassificationInstructions: string;
  generationInstruction: string;
  reviewInstruction: string;
  generationFormat: PlanWireFormat;
  reviewFormat: PlanWireFormat;
};

/** Isolated request material only; there is no current/default version or execution switch. */
export function getPlanPromptDefinition(version: PlanPromptVersion): PlanPromptDefinition {
  switch (version) {
    case "plan-observation-v1":
      return getV1PlanPromptDefinition();
    case "plan-observation-v2":
      return getV2PlanPromptDefinition();
    default:
      throw new RangeError("Unsupported plan prompt version");
  }
}
