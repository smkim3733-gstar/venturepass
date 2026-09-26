import { randomUUID } from "node:crypto";
import type { StageRecord, StudioCase } from "./studio-schema";
import { StudioError } from "./studio-http";

/** Local history only; neither origin asserts agency verification. Called inside the case transaction. */
export function changeStage(
  record: StudioCase,
  stage: StudioCase["stage"],
  details: Pick<StageRecord, "origin" | "occurredOn" | "note">,
) {
  if (record.stage === stage) return;
  if (record.stageHistory.length >= 500) {
    throw new StudioError(
      "진행 이력 보관 한도 500건에 도달했습니다. 기존 기록은 보존했으며 단계 변경을 저장하지 않았습니다.",
      409,
      "STAGE_HISTORY_LIMIT",
    );
  }
  record.stageHistory.push({
    id: randomUUID(),
    from: record.stage,
    to: stage,
    recordedAt: new Date().toISOString(),
    ...details,
  });
  record.stage = stage;
}
