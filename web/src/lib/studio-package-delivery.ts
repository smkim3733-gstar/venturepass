import { randomUUID } from "node:crypto";
import { withCaseStore } from "./studio-case-session";
import { attachmentHeaders, jsonResponse, privateHeaders, StudioError } from "./studio-http";
import {
  exportMaxAgeMs,
  exportObjectKey,
  exportPrefix,
  removeOldExports,
} from "./studio-original-store";
import { currentRequestScope } from "./studio-request-scope";

/** How long the storage link handed to the browser stays valid. */
export const exportLinkSeconds = 300;

const notConfigured = () =>
  new StudioError(
    "웹 서비스의 원본 저장소가 설정되지 않았습니다.",
    503,
    "ORIGINALS_NOT_CONFIGURED",
  );
const expired = () =>
  new StudioError("내려받기 시간이 지났습니다. 묶음을 다시 만들어 주세요.", 404, "EXPORT_EXPIRED");

/** Web service: fails early (503) when the ZIP could not be stored and downloaded. */
export function assertZipDeliveryAvailable() {
  const scope = currentRequestScope();
  if (scope && (!scope.originals?.createSignedDownload || !scope.originals.list))
    throw notConfigured();
}

/**
 * Local app: the ZIP itself. Web service: the response limit (about 4.5MB) is smaller than a
 * package (up to 28MB), so the ZIP is stored privately and only its id is returned. The
 * browser then downloads it through the same-origin export route; it never follows a URL
 * taken from a JSON body.
 */
export async function deliverZip(caseId: string, result: { buffer: Buffer; fileName: string }) {
  const scope = currentRequestScope();
  if (!scope)
    return new Response(new Uint8Array(result.buffer), {
      headers: {
        ...attachmentHeaders(result.fileName, "application/zip"),
        "Content-Length": String(result.buffer.length),
      },
    });
  const store = scope.originals;
  if (!store?.createSignedDownload || !store.list) throw notConfigured();
  const organizationId = scope.principal.organizationId;
  await removeOldExports(store, organizationId, caseId);
  const exportId = randomUUID();
  await store.put(
    exportObjectKey(organizationId, caseId, exportId),
    new Uint8Array(result.buffer),
    "application/zip",
  );
  return jsonResponse(
    { exportId, fileName: result.fileName, sizeBytes: result.buffer.length },
    201,
  );
}

/** Web service only: checks company access again, then redirects to a short-lived link. */
export async function redirectToExport(caseId: string, exportId: string, fileName: string) {
  const scope = currentRequestScope();
  if (!scope) throw new StudioError("이 PC 앱에서는 ZIP을 바로 내려받습니다.", 404, "SERVER_ONLY");
  const store = scope.originals;
  if (!store?.createSignedDownload || !store.list) throw notConfigured();
  // The same organization check as every company read: another organization sees 404.
  await withCaseStore(caseId, ({ store: cases }) => cases.get(caseId));
  const organizationId = scope.principal.organizationId;
  const key = exportObjectKey(organizationId, caseId, exportId);
  const listed = (await store.list(exportPrefix(organizationId, caseId))).find(
    (item) => item.key === key,
  );
  if (!listed || Date.now() - listed.createdAt.getTime() >= exportMaxAgeMs) throw expired();
  const url = await store.createSignedDownload(key, exportLinkSeconds, fileName);
  if (!url) throw expired();
  return new Response(null, { status: 302, headers: { ...privateHeaders, Location: url } });
}
