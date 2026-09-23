import { z } from "zod";
import { getStudioStore } from "@/lib/studio-storage";
import { jsonResponse, readBoundedBody, studioRoute, StudioError } from "@/lib/studio-http";
import { ventureAccountInputSchema } from "@/lib/venturein-schema";
import { getVentureConnection, withVentureLock } from "@/lib/venturein-service";
import {
  deleteVentureAccount,
  getVentureAccountStatus,
  readVentureAccount,
  saveVentureAccount,
} from "@/lib/venturein-vault";
import {
  resumeVentureSession,
  startVentureSession,
  stopVentureSession,
} from "@/lib/venturein-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Context = { params: Promise<{ caseId: string }> };
async function readSmallJson(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
  return JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 8192)));
}
const revisionSchema = z.object({ revision: z.number().int().nonnegative() }).strict();
const commandSchema = z
  .object({
    action: z.enum(["start", "resume", "stop"]),
    accountRevision: z.number().int().nonnegative(),
  })
  .strict();
function checkRevision(caseId: string, revision: number) {
  if (getVentureAccountStatus(getStudioStore(), caseId).revision !== revision)
    throw new StudioError(
      "계정 정보가 변경되었습니다. 연결 상태를 새로 불러와 주세요.",
      409,
      "STALE_ACCOUNT",
    );
}
export function GET(request: Request, context: Context) {
  return studioRoute(request, async () =>
    jsonResponse(getVentureConnection((await context.params).caseId)),
  );
}
export function PUT(request: Request, context: Context) {
  return studioRoute(request, async () => {
    const { caseId } = await context.params;
    const input = ventureAccountInputSchema.parse(await readSmallJson(request));
    return withVentureLock(caseId, async () => {
      checkRevision(caseId, input.revision);
      await stopVentureSession(caseId);
      await saveVentureAccount(
        getStudioStore(),
        caseId,
        { loginId: input.loginId, password: input.password },
        input.revision,
      );
      return jsonResponse(getVentureConnection(caseId));
    });
  });
}
export function DELETE(request: Request, context: Context) {
  return studioRoute(request, async () => {
    const { caseId } = await context.params;
    const { revision } = revisionSchema.parse(await readSmallJson(request));
    return withVentureLock(caseId, async () => {
      checkRevision(caseId, revision);
      await stopVentureSession(caseId);
      await deleteVentureAccount(getStudioStore(), caseId, revision);
      return jsonResponse(getVentureConnection(caseId));
    });
  });
}
export function POST(request: Request, context: Context) {
  return studioRoute(request, async () => {
    const { caseId } = await context.params;
    const input = commandSchema.parse(await readSmallJson(request));
    return withVentureLock(caseId, async () => {
      const store = getStudioStore();
      checkRevision(caseId, input.accountRevision);
      if (input.action === "start") {
        const credentials = await readVentureAccount(store, caseId);
        checkRevision(caseId, input.accountRevision);
        try {
          await startVentureSession(caseId, credentials);
        } finally {
          credentials.loginId = "";
          credentials.password = "";
        }
      } else if (input.action === "resume") {
        await resumeVentureSession(caseId);
      } else {
        await stopVentureSession(caseId);
      }
      return jsonResponse(getVentureConnection(caseId));
    });
  });
}
