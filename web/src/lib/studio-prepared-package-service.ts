import "server-only";
import { z } from "zod";
import { withCaseStore } from "./studio-case-session";
import { attachmentHeaders, privateHeaders, StudioError } from "./studio-http";
import { preparedPackageObjectKey } from "./studio-original-store";
import { exportLinkSeconds } from "./studio-package-delivery";
import {
  buildPreparedPackageSnapshot,
  preparedPackageError,
  preparedPackageRequestDigest,
  preparedPackageSha,
  preservePreparedPackage,
} from "./studio-prepared-package";
import type { PreparedPackageRepository } from "./studio-prepared-package-repository";
import {
  MAX_PREPARED_PACKAGES,
  preparedPackageRequestSchema,
  preparedPackageSummary,
  type PreparedPackageRecord,
  type PreparedPackageRequest,
} from "./studio-prepared-package-types";
import { currentRequestScope, serverModeRequested } from "./studio-request-scope";
import { getStudioStore, parsePreparedPackageRow } from "./studio-storage";

/**
 * 원고·첨부 보관본 for both modes. The PC app keeps records and ZIPs in its SQLite database,
 * unchanged. The web service keeps the record in Postgres and the ZIP in private object
 * storage, with the same per-company limit, replay, snapshot checks and company deletion.
 */

const uuid = z.string().uuid();

type WebPreparedPackages = {
  organizationId: string;
  repository: PreparedPackageRepository;
  objects: NonNullable<NonNullable<ReturnType<typeof currentRequestScope>>["originals"]>;
};

/** Null in the PC app. The web service without database table or storage answers 503. */
function webPreparedPackages(): WebPreparedPackages | null {
  const scope = currentRequestScope();
  if (!scope) {
    if (serverModeRequested())
      throw new StudioError("로그인이 필요합니다.", 401, "UNAUTHENTICATED");
    return null;
  }
  const objects = scope.originals;
  if (!scope.preparedPackages || !objects?.createSignedDownload || !objects.list)
    throw new StudioError(
      "웹 서비스의 보관본 저장소가 설정되지 않았습니다.",
      503,
      "PREPARED_NOT_CONFIGURED",
    );
  return {
    organizationId: scope.principal.organizationId,
    repository: scope.preparedPackages,
    objects,
  };
}

async function findWebRequest(
  repository: PreparedPackageRepository,
  caseId: string,
  input: PreparedPackageRequest,
) {
  const row = await repository.findByRequest(caseId, input.clientRequestId);
  if (!row) return null;
  const digest = preparedPackageRequestDigest(input);
  if (row.request_digest !== digest) preparedPackageError("PREPARED_REQUEST_CONFLICT");
  const record = parsePreparedPackageRow(caseId, row);
  if (record.requestDigest !== digest || JSON.stringify(record.input) !== JSON.stringify(input))
    preparedPackageError("PREPARED_REQUEST_CONFLICT");
  return record;
}

async function readWebRecord(web: WebPreparedPackages, caseId: string, packageId: string) {
  const row = await web.repository.get(caseId, packageId);
  if (!row) preparedPackageError("PREPARED_PACKAGE_NOT_FOUND", 404);
  const record = parsePreparedPackageRow(caseId, row);
  if (record.id !== packageId) preparedPackageError("PREPARED_PACKAGE_CHANGED");
  return record;
}

export async function listPreparedPackagesForRequest(caseId: string) {
  const web = webPreparedPackages();
  if (!web) return getStudioStore().listPreparedPackages(caseId);
  // The company read is the organization check: another organization's company is 404.
  return withCaseStore(caseId, async ({ store }) => {
    const company = store.get(caseId);
    const rows = await web.repository.list(caseId);
    return {
      caseId,
      caseRevision: company.revision,
      packages: rows.map((row) => preparedPackageSummary(parsePreparedPackageRow(caseId, row))),
    };
  });
}

export async function getPreparedPackageForRequest(
  caseId: string,
  packageId: string,
): Promise<PreparedPackageRecord> {
  const web = webPreparedPackages();
  if (!web) return getStudioStore().getPreparedPackage(caseId, packageId);
  uuid.parse(packageId);
  return withCaseStore(caseId, async ({ store }) => {
    store.get(caseId);
    return readWebRecord(web, caseId, packageId);
  });
}

/**
 * PC app: the ZIP bytes. Web service: the stored ZIP is checked against its record (size and
 * SHA-256) and the browser is redirected to a short-lived private link, because a package can
 * exceed the function response limit.
 */
export async function downloadPreparedPackageForRequest(caseId: string, packageId: string) {
  const web = webPreparedPackages();
  if (!web) {
    const { record, buffer } = getStudioStore().downloadPreparedPackage(caseId, packageId);
    return new Response(new Uint8Array(buffer), {
      headers: {
        ...attachmentHeaders(record.zip.fileName, "application/zip"),
        "Content-Length": String(buffer.length),
        "X-Archive-SHA256": record.zip.sha256,
      },
    });
  }
  const record = await getPreparedPackageForRequest(caseId, packageId);
  const key = preparedPackageObjectKey(web.organizationId, caseId, record.id);
  const bytes = await web.objects.get(key);
  if (
    !bytes ||
    bytes.length !== record.zip.sizeBytes ||
    preparedPackageSha(bytes) !== record.zip.sha256
  )
    preparedPackageError("PREPARED_ARCHIVE_CHANGED");
  const url = await web.objects.createSignedDownload!(key, exportLinkSeconds, record.zip.fileName);
  if (!url) preparedPackageError("PREPARED_ARCHIVE_CHANGED");
  return new Response(null, {
    status: 302,
    headers: { ...privateHeaders, Location: url, "X-Archive-SHA256": record.zip.sha256 },
  });
}

export async function preservePreparedPackageForRequest(
  caseId: string,
  raw: PreparedPackageRequest,
): Promise<{ package: PreparedPackageRecord; replayed: boolean }> {
  const web = webPreparedPackages();
  if (!web) return preservePreparedPackage(getStudioStore(), caseId, raw);
  const input = preparedPackageRequestSchema.parse(raw);
  const { repository, objects, organizationId } = web;
  return withCaseStore(caseId, async ({ store, stageOriginals }) => {
    store.get(caseId);
    const existing = await findWebRequest(repository, caseId, input);
    if (existing) return { package: existing, replayed: true };
    if (store.get(caseId).revision !== input.revision) preparedPackageError("STALE_REVISION");
    // Fail before reading originals from storage when the company is already full.
    if ((await repository.count(caseId)) >= MAX_PREPARED_PACKAGES)
      preparedPackageError("PREPARED_PACKAGE_LIMIT", 413);
    await stageOriginals(input.sourceIds);
    const { snapshot, buffer } = await buildPreparedPackageSnapshot(store, caseId, input);
    if (preparedPackageSha(JSON.stringify(store.get(caseId))) !== snapshot.company.snapshotSha256)
      preparedPackageError("PREPARED_SNAPSHOT_CHANGED");
    const count = await repository.count(caseId);
    if (count >= MAX_PREPARED_PACKAGES) preparedPackageError("PREPARED_PACKAGE_LIMIT", 413);
    const { record, body } = store.verifyPreparedPackageSnapshot(
      caseId,
      input,
      snapshot,
      buffer,
      count + 1,
    );
    // The ZIP goes first; the row that references it is inserted only while the company is
    // unchanged and the version is still free. Anything else removes the ZIP again.
    const key = preparedPackageObjectKey(organizationId, caseId, record.id);
    await objects.put(key, new Uint8Array(buffer), "application/zip");
    let inserted = false;
    try {
      inserted = await repository.insert(
        {
          id: record.id,
          caseId,
          version: record.version,
          clientRequestId: input.clientRequestId,
          requestDigest: record.requestDigest,
          body,
          bodySha256: preparedPackageSha(body),
          zipSha256: record.zip.sha256,
          zipSizeBytes: record.zip.sizeBytes,
        },
        input.revision,
      );
    } finally {
      if (!inserted) await objects.remove(key).catch(() => {});
    }
    if (!inserted) {
      const replay = await findWebRequest(repository, caseId, input);
      if (replay) return { package: replay, replayed: true };
      if ((await repository.count(caseId)) >= MAX_PREPARED_PACKAGES)
        preparedPackageError("PREPARED_PACKAGE_LIMIT", 413);
      preparedPackageError("STALE_REVISION");
    }
    return { package: record, replayed: false };
  });
}
