import { z } from "zod";
import { companyProfileSchema } from "@/lib/studio-schema";
import { getStudioStore } from "@/lib/studio-storage";
import { jsonResponse, readJson, studioRoute } from "@/lib/studio-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  return studioRoute(request, () => jsonResponse({ cases: getStudioStore().list() }));
}
export function POST(request: Request) {
  return studioRoute(request, async () => {
    const { profile } = z.object({ profile: companyProfileSchema }).parse(await readJson(request));
    return jsonResponse(getStudioStore().create(profile), 201);
  });
}
