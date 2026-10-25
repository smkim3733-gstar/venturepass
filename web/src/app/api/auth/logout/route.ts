import { logoutRoute } from "@/lib/studio-auth-routes";
import { jsonResponse } from "@/lib/studio-http";
import { loadAuthRouteContextFromEnv } from "@/lib/studio-server-bootstrap";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const context = await loadAuthRouteContextFromEnv();
  if (!context)
    return jsonResponse(
      { error: "웹 서비스 로그인이 설정되지 않았습니다.", code: "SERVER_NOT_CONFIGURED" },
      503,
    );
  return logoutRoute(request, context);
}
