import type { CompanyProfile, StudioCase } from "@/lib/studio-schema";

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
