import "server-only";
import { z } from "zod";
import { StudioError } from "./studio-http";
import { assertVentureWorkflowVersions } from "./venturein-workflow";
import { getVentureAccountStatus } from "./venturein-vault";
import { getVentureSession, readVentureMyStatus } from "./venturein-runner";
import { withVentureLock } from "./venturein-service";

const revision = z.number().int().nonnegative().safe();
export const readCurrentMyStatusSchema = z.object({
  action: z.literal("read-current-my-status"),
  companyRevision: revision,
  accountRevision: revision,
  workflowRevision: revision,
  sessionStartedAt: z.string().datetime(),
  confirmed: z.literal(true),
}).strict();

/** Ephemeral company-scoped observation. No inference from receipt numbers or manual ledgers. */
export async function readCurrentVentureMyStatus(caseId: string, command: unknown) {
  z.string().uuid().parse(caseId);
  const input = readCurrentMyStatusSchema.parse(command);
  return withVentureLock(caseId, async () => {
    const versions = {
      revision: input.workflowRevision,
      accountRevision: input.accountRevision,
      companyRevision: input.companyRevision,
    };
    const store = assertVentureWorkflowVersions(caseId, versions);
    const businessNumber = store.get(caseId).profile.businessNumber;
    const assertCurrent = () => {
      const currentStore = assertVentureWorkflowVersions(caseId, versions);
      const account = getVentureAccountStatus(currentStore, caseId);
      const session = getVentureSession(caseId);
      if (currentStore !== store || !account.saved || account.revision !== input.accountRevision ||
        currentStore.get(caseId).profile.businessNumber !== businessNumber ||
        !businessNumber.trim() || session.state !== "connected_unmapped" ||
        session.startedAt !== input.sessionStartedAt)
        throw new StudioError("회사와 원래 계정 연결이 변경되었거나 확인되지 않았습니다.",
          409, "MY_STATUS_CONTEXT_CHANGED");
    };
    assertCurrent();
    const read = await readVentureMyStatus(caseId, {
      sessionStartedAt: input.sessionStartedAt,
      accountRevision: input.accountRevision,
      businessNumber,
    }, assertCurrent);
    assertCurrent();
    return {
      format: "venturepass-my-status-read-v1" as const,
      caseId,
      companyRevision: input.companyRevision,
      accountRevision: input.accountRevision,
      workflowRevision: input.workflowRevision,
      sessionStartedAt: input.sessionStartedAt,
      scope: "company-screen" as const,
      applicationAttribution: "unavailable-no-application-number" as const,
      ...read,
    };
  });
}
