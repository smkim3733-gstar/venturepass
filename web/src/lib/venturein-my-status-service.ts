import "server-only";
import { z } from "zod";
import type { StudioStore } from "./studio-storage";
import { StudioError } from "./studio-http";
import { assertVentureWorkflowVersions } from "./venturein-workflow";
import { getVentureAccountStatus } from "./venturein-vault";
import { getVentureSession, readVentureMyStatus } from "./venturein-runner";
import { withVentureLock } from "./venturein-service";

import { readCurrentMyStatusSchema } from "./venturein-my-status-view";
export { readCurrentMyStatusSchema } from "./venturein-my-status-view";

/** Ephemeral company-scoped observation. No inference from receipt numbers or manual ledgers. */
export async function readCurrentVentureMyStatus(caseId: string, command: unknown) {
  const input = readCurrentMyStatusSchema.parse(command);
  return withVentureMyStatusContext(caseId, input, async ({ businessNumber, assertCurrent }) => {
    const read = await readVentureMyStatus(caseId, {
      sessionStartedAt: input.sessionStartedAt, accountRevision: input.accountRevision, businessNumber,
    }, assertCurrent);
    assertCurrent();
    return {
      format: "venturepass-my-status-read-v1" as const, caseId,
      companyRevision: input.companyRevision, accountRevision: input.accountRevision,
      workflowRevision: input.workflowRevision, sessionStartedAt: input.sessionStartedAt,
      scope: "company-screen" as const,
      applicationAttribution: "unavailable-no-application-number" as const, ...read,
    };
  });
}
/** Shared ownership gate; caller extends it with its own exact read target. */
export function withVentureMyStatusContext<T>(caseId: string,
  input: Pick<z.infer<typeof readCurrentMyStatusSchema>, "companyRevision" | "accountRevision" | "workflowRevision" | "sessionStartedAt">,
  task: (context: { store: StudioStore; businessNumber: string; assertCurrent: () => void }) => Promise<T>,
) {
  z.string().uuid().parse(caseId);
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
    return task({ store, businessNumber, assertCurrent });
  });
}
