import { z } from "zod";
import {
  agencyRecordSchema,
  isAgencyNoticeRecord,
  type AgencyRequestRecord,
} from "./studio-agency-records";
import type { StudioCase } from "./studio-schema";

export function currentRequests(company: StudioCase) {
  const records = company.agencyRecords.filter(
    (record): record is AgencyRequestRecord => !isAgencyNoticeRecord(record),
  );
  return records
    .filter((record) => record.kind === "request")
    .flatMap((root) => {
      const chain = records.filter((record) => record.requestRecordId === root.id);
      let latest: AgencyRequestRecord | undefined;
      let response: AgencyRequestRecord | undefined;
      for (const record of chain) {
        if (company.agencyRecords.filter((item) => item.id === record.id).length !== 1) return [];
        if (record.kind === "response") {
          if (
            !latest ||
            record.previousVersionId !== (response?.id ?? null) ||
            record.version !== (response?.version ?? 0) + 1 ||
            record.requestVersionId !== latest.id
          )
            return [];
          response = record;
        } else {
          if (
            record.previousVersionId !== (latest?.id ?? null) ||
            record.version !== (latest?.version ?? 0) + 1 ||
            record.kind !== (latest ? "request-correction" : "request") ||
            record.requestVersionId !== record.id ||
            (!latest && record.id !== root.id)
          )
            return [];
          latest = record;
        }
      }
      return latest ? [{ root, latest, response }] : [];
    });
}
export function currentNotices(company: StudioCase) {
  const records = company.agencyRecords.filter(isAgencyNoticeRecord);
  return records
    .filter((record) => record.kind === "notice")
    .flatMap((root) => {
      const chain = records.filter((record) => record.noticeRecordId === root.id);
      for (const [index, record] of chain.entries()) {
        if (
          company.agencyRecords.filter((item) => item.id === record.id).length !== 1 ||
          record.previousVersionId !== (chain[index - 1]?.id ?? null) ||
          record.version !== index + 1 ||
          record.kind !== (index ? "notice-correction" : "notice") ||
          (!index && record.id !== root.id)
        )
          return [];
      }
      return chain.length ? [chain.at(-1)!] : [];
    });
}

/** Exact local record address, including historical versions. Never a write permission. */
export const guidedAgencyRecordTargetSchema = z
  .object({
    kind: z.literal("agency-record"),
    caseId: z.string().uuid(),
    companyRevision: z.number().int().nonnegative().safe(),
    chainKind: z.enum(["request", "notice"]),
    chainRootId: z.string().uuid(),
    recordVersionId: z.string().uuid(),
  })
  .strict();
export type GuidedAgencyRecordTarget = z.infer<typeof guidedAgencyRecordTargetSchema>;
export function guidedAgencyChain(company: StudioCase, kind: "request" | "notice", rootId: string) {
  const roots =
    kind === "request"
      ? currentRequests(company).filter(({ root }) => root.id === rootId)
      : currentNotices(company).filter((r) => r.noticeRecordId === rootId);
  if (roots.length !== 1) return null;
  const records = company.agencyRecords.filter((r) =>
    kind === "notice"
      ? isAgencyNoticeRecord(r) && r.noticeRecordId === rootId
      : !isAgencyNoticeRecord(r) && r.requestRecordId === rootId,
  );
  return records.every((r) => agencyRecordSchema.safeParse(r).success) ? records : null;
}
export function validGuidedAgencyRecordTarget(company: StudioCase, input: unknown) {
  const parsed = guidedAgencyRecordTargetSchema.safeParse(input);
  if (
    !parsed.success ||
    parsed.data.caseId !== company.id ||
    parsed.data.companyRevision !== company.revision
  )
    return false;
  const target = parsed.data;
  return (
    guidedAgencyChain(company, target.chainKind, target.chainRootId)?.filter(
      (r) => r.id === target.recordVersionId,
    ).length === 1
  );
}
