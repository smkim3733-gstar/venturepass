import "server-only";
import { StudioError } from "./studio-http";
import { currentApplicationNumberBinding } from "./studio-application-number";
import { readBoundMyStatusSchema, readVentureBoundResult } from "./venturein-bound-my-status";
import { withVentureMyStatusContext } from "./venturein-my-status-service";
import { readVentureBoundMyStatus } from "./venturein-runner";

/** An explicit, ephemeral comparison against a manually selected binding. Never an official receipt. */
export async function readBoundVentureMyStatus(caseId: string, raw: unknown) {
  const input = readBoundMyStatusSchema.parse(raw);
  return withVentureMyStatusContext(caseId, input, async ({ store, businessNumber, assertCurrent }) => {
    const resolve = () => {
      const current = currentApplicationNumberBinding(store.get(caseId), input.target.applicationId);
      const r = current.record;
      if (current.state !== "manual-unverified" || !r || r.command.operation !== "bind" ||
        r.id !== input.target.bindingId || r.recordDigest !== input.target.bindingDigest ||
        r.command.metadataVersionId !== input.target.metadataVersionId ||
        r.command.applicationNumber === null)
        throw new StudioError("신청 회차와 저장된 번호 연결이 변경되었거나 확인되지 않았습니다.", 409, "MY_STATUS_BINDING_CHANGED");
      return { ...input.target, applicationNumber: r.command.applicationNumber };
    };
    assertCurrent();
    const target = resolve();
    const assertTarget = () => {
      assertCurrent();
      if (JSON.stringify(resolve()) !== JSON.stringify(target))
        throw new StudioError("원래 신청번호 연결이 변경되었습니다.", 409, "MY_STATUS_BINDING_CHANGED");
    };
    assertTarget();
    const read = await readVentureBoundMyStatus(caseId, {
      sessionStartedAt: input.sessionStartedAt, accountRevision: input.accountRevision,
      businessNumber, applicationNumber: target.applicationNumber,
    }, assertTarget);
    assertTarget();
    const { applications, target: observedTarget, ...observed } = read.observation;
    const applicationTable = applications.state === "unsupported"
      ? { state: applications.state, reason: applications.reason } : { state: applications.state };
    const expected = { caseId, companyRevision: input.companyRevision, accountRevision: input.accountRevision,
      workflowRevision: input.workflowRevision, sessionStartedAt: input.sessionStartedAt, target };
    // Return only the requested row. Certificate history and unrelated applications are not attributed.
    return readVentureBoundResult({
      ...expected, format: "venturepass-bound-my-status-read-v1", documentRevision: read.documentRevision,
      scope: "manual-application-binding", applicationAttribution: "manual-unverified",
      observation: { origin: observed.origin, screenId: observed.screenId, observedAt: observed.observedAt,
        url: observed.url, companyNumberMatched: observed.companyNumberMatched,
        applicationTable, target: observedTarget, progressAttribution: "unverified",
        certificateApplicationLink: "unverified", officialStatusChecked: false, receiptVerified: false,
        transmissionAllowed: false, databaseChanged: false },
    }, expected);
  });
}
