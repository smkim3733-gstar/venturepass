import { readJson, studioRoute } from "@/lib/studio-route";
import { addMember, listMembers } from "@/lib/studio-members";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  return studioRoute(request, () => listMembers());
}
export function POST(request: Request) {
  return studioRoute(request, async () => addMember(await readJson(request)));
}
