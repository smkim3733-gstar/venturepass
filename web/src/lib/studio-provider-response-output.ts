import "server-only";
import { StudioEngineError } from "./studio-engine-request-core";
import {
  providerObservationLimits,
  type ProviderCapturedResponse,
} from "../../scripts/local-data-quality-provider-usage.mjs";

const fail = (code: string): never => {
  throw new StudioEngineError(
    code,
    "전송·응답 범위를 확인하지 못해 후속 실행을 중단했습니다.",
    502,
  );
};

/** Decode an already captured response only; no provider execution or configuration. */
export function parseProviderResponseOutput(response: ProviderCapturedResponse): unknown {
  if (response.status !== "completed" || !Array.isArray(response.output))
    return fail("AI_INCOMPLETE");
  const texts: string[] = [];
  for (const item of response.output) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      item.type !== "message" ||
      !Array.isArray(item.content)
    )
      continue;
    for (const part of item.content) {
      if (!part || typeof part !== "object" || Array.isArray(part)) continue;
      if (part.type === "refusal") return fail("AI_INCOMPLETE");
      if (part.type === "output_text" && typeof part.text === "string") texts.push(part.text);
    }
  }
  if (texts.length !== 1 || Buffer.byteLength(texts[0]) > providerObservationLimits.validatedBytes)
    return fail("AI_INVALID_OUTPUT");
  try {
    return JSON.parse(texts[0]);
  } catch {
    return fail("AI_INVALID_OUTPUT");
  }
}
