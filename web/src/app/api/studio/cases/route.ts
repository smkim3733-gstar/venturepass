import { z } from "zod";
import { companyProfileSchema } from "@/lib/studio-schema";
import { createCase, listCases } from "@/lib/studio-case-session";
import { jsonResponse, readJson, studioRoute } from "@/lib/studio-route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  return studioRoute(request, async () => jsonResponse({ cases: await listCases() }));
}
export function POST(request: Request) {
  return studioRoute(request, async () => {
    const { profile } = z.object({ profile: companyProfileSchema }).parse(await readJson(request));
    return jsonResponse(await createCase(profile), 201);
  });
}
