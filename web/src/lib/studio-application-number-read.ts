// Server-only local read. Reuses the writer's full history audit; no official site access.
import { z } from "zod";
import type { StudioCase } from "./studio-schema";
import { applicationMetadata } from "./studio-application-types";
import {
  auditApplicationNumberBindings,
  currentApplicationNumberBinding,
  findApplicationNumberReplay,
} from "./studio-application-number";
import {
  applicationNumberBindingCommandSchema,
  type ApplicationNumberBindingCommand,
} from "./studio-application-number-types";

export const applicationNumberInspectionSchema = z
  .object({
    action: z.literal("inspect-original-request"),
    command: applicationNumberBindingCommandSchema,
  })
  .strict();

export function readApplicationNumbers(company: StudioCase) {
  const { records } = auditApplicationNumberBindings(company);
  return {
    company: structuredClone(company),
    records,
    current: company.applications.map((cycle) => ({
      applicationId: cycle.id,
      ...currentApplicationNumberBinding(company, cycle.id),
    })),
    historyAudited: true as const,
    officialStatusChecked: false as const,
    databaseChanged: false as const,
    transmissionAllowed: false as const,
  };
}
export function inspectApplicationNumberRequest(
  company: StudioCase,
  raw: ApplicationNumberBindingCommand,
) {
  const command = applicationNumberBindingCommandSchema.parse(raw);
  const receipt = findApplicationNumberReplay(company, command);
  const snapshot = readApplicationNumbers(company);
  // Missing original round/version is not a basis for closing an uncertain request.
  const originalExists =
    company.applications.some((c) => c.id === command.applicationId) &&
    (command.metadataVersionId === command.applicationId ||
      company.applicationEvents.some(
        (e) =>
          e.id === command.metadataVersionId &&
          e.applicationId === command.applicationId &&
          e.kind === "cycle-correction",
      ));
  const metadata = applicationMetadata(company, command.applicationId);
  return {
    ...snapshot,
    command,
    receipt,
    outcome: receipt
      ? ("recorded" as const)
      : originalExists && metadata && command.revision < company.revision
        ? ("not-recorded-stale" as const)
        : ("unconfirmed" as const),
  };
}
