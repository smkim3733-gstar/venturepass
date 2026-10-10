import { caseSchema, type CompanyProfile, type StudioCase } from "@/lib/studio-schema";

/** The generic mutation response permits same-revision replays; a saved description needs
 * an increased revision and the complete profile that this editor actually submitted. */
export function guidedDescriptionAcknowledged(
  response: StudioCase | null,
  original: Pick<StudioCase, "id" | "revision">,
  submitted: CompanyProfile,
) {
  return Boolean(
    response &&
    response.id === original.id &&
    response.revision > original.revision &&
    (Object.keys(submitted) as (keyof CompanyProfile)[]).every(
      (key) => response.profile[key] === submitted[key],
    ),
  );
}

export type GuidedDescriptionSave = {
  company: Pick<StudioCase, "id" | "revision">;
  profile: CompanyProfile;
};
/** Accept a complete response only against the original submission and the current company. */
export function guidedDescriptionSaveResponse(
  response: unknown,
  current: StudioCase,
  request: GuidedDescriptionSave,
): StudioCase | null {
  const parsed = caseSchema.safeParse(response);
  if (
    !parsed.success ||
    current.id !== request.company.id ||
    parsed.data.revision < current.revision ||
    !guidedDescriptionAcknowledged(parsed.data, request.company, request.profile)
  )
    return null;
  return parsed.data;
}
