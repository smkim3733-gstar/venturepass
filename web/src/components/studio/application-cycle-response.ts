import { caseSchema, type StudioCase } from "@/lib/studio-schema";
import {
  applicationDetailsSchema,
  applicationMetadata,
  applicationMutationSchema,
  type ApplicationMutation,
} from "@/lib/studio-application-types";

export type ApplicationCycleMutation = Extract<
  ApplicationMutation,
  { action: "create-application" | "correct-application" }
>;
export function isApplicationCycleMutation(value: {
  action: string;
}): value is ApplicationCycleMutation {
  return value.action === "create-application" || value.action === "correct-application";
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Match the original cycle command before accepting company state; never writes or retries. */
export function applicationCycleSaveAcknowledged(
  raw: unknown,
  company: StudioCase,
  value: ApplicationCycleMutation,
) {
  const response = caseSchema.safeParse(raw),
    before = caseSchema.safeParse(company),
    command = applicationMutationSchema.safeParse(value);
  if (
    !response.success ||
    !before.success ||
    !command.success ||
    !isApplicationCycleMutation(command.data)
  )
    return false;
  const saved = response.data,
    base = before.data,
    input = command.data;
  if (saved.id !== base.id || saved.revision < base.revision || input.revision !== base.revision)
    return false;
  const all = [...saved.applications, ...saved.applicationEvents];
  const originals = [...base.applications, ...base.applicationEvents];
  if (
    new Set(all.map((r) => r.id)).size !== all.length ||
    new Set(originals.map((r) => r.id)).size !== originals.length
  )
    return false;
  const matches = all.filter((r) => r.clientRequestId === input.clientRequestId);
  const prior = originals.filter((r) => r.clientRequestId === input.clientRequestId);
  if (matches.length !== 1 || prior.length > 1) return false;
  const record = matches[0];
  const details = applicationDetailsSchema.parse({
    title: input.title,
    kind: input.kind,
    plannedOn: input.plannedOn,
    criteriaNote: input.criteriaNote,
    previousApplicationId: input.previousApplicationId,
  });
  if (prior.length) {
    if (
      !equal(record, prior[0]) ||
      !equal(saved.applications, base.applications) ||
      !equal(saved.applicationEvents, base.applicationEvents)
    )
      return false;
  } else {
    if (saved.revision <= base.revision) return false;
    if (
      !equal(
        saved.applications,
        input.action === "create-application" ? [...base.applications, record] : base.applications,
      ) ||
      !equal(
        saved.applicationEvents,
        input.action === "correct-application"
          ? [...base.applicationEvents, record]
          : base.applicationEvents,
      )
    )
      return false;
  }
  if (input.action === "create-application") {
    if (!("companyAtCreation" in record)) return false;
    return (
      equal(
        applicationDetailsSchema.parse({
          title: record.title,
          kind: record.kind,
          plannedOn: record.plannedOn,
          criteriaNote: record.criteriaNote,
          previousApplicationId: record.previousApplicationId,
        }),
        details,
      ) &&
      equal(record.companyAtCreation, {
        companyName: base.profile.companyName,
        businessNumber: base.profile.businessNumber,
      }) &&
      applicationMetadata(saved, record.id)?.metadataVersionId === record.id
    );
  }
  if (
    record.kind !== "cycle-correction" ||
    record.applicationId !== input.applicationId ||
    record.previousVersionId !== input.previousVersionId ||
    !equal(record.details, details)
  )
    return false;
  if (base.applications.filter((cycle) => cycle.id === input.applicationId).length !== 1)
    return false;
  const previous = applicationMetadata(base, input.applicationId);
  return (
    previous?.metadataVersionId === (prior.length ? record.id : input.previousVersionId) &&
    applicationMetadata(saved, input.applicationId)?.metadataVersionId === record.id
  );
}
