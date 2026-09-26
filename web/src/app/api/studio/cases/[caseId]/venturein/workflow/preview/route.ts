import { z } from "zod";
import { studioRoute, StudioError, privateHeaders } from "@/lib/studio-http";
import { withVentureLock } from "@/lib/venturein-service";
import { getVentureWorkflow } from "@/lib/venturein-workflow";
import { previewVentureApplication } from "@/lib/venturein-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
const version = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().nonnegative().safe());
export function GET(request: Request, context: { params: Promise<{ caseId: string }> }) {
  return studioRoute(request, async () => {
    const { caseId } = await context.params;
    const query = new URL(request.url).searchParams;
    const revision = version.parse(query.get("revision"));
    const accountRevision = version.parse(query.get("accountRevision"));
    return withVentureLock(caseId, async () => {
      const current = getVentureWorkflow(caseId);
      if (
        !current.snapshot ||
        current.revision !== revision ||
        current.accountRevision !== accountRevision ||
        current.snapshot.accountRevision !== accountRevision
      )
        throw new StudioError(
          "현재 연결의 공식 화면을 다시 읽은 뒤 미리보기를 여세요.",
          409,
          "STALE_PREVIEW",
        );
      const image = await previewVentureApplication(
        caseId,
        current.snapshot.sessionStartedAt,
        current.snapshot.screen.url,
      );
      // A second local server process can update the same database outside this process lock.
      const latest = getVentureWorkflow(caseId);
      if (
        latest.revision !== revision ||
        latest.accountRevision !== accountRevision ||
        latest.snapshot?.screen.id !== current.snapshot.screen.id ||
        latest.snapshot?.sessionStartedAt !== current.snapshot.sessionStartedAt ||
        latest.session.state !== "connected_unmapped" ||
        latest.session.startedAt !== current.snapshot.sessionStartedAt
      )
        throw new StudioError(
          "미리보기 중 연결 정보가 변경되었습니다. 현재 화면을 다시 확인해 주세요.",
          409,
          "STALE_PREVIEW",
        );
      return new Response(new Uint8Array(image), {
        headers: {
          ...privateHeaders,
          "Content-Type": "image/png",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        },
      });
    });
  });
}
