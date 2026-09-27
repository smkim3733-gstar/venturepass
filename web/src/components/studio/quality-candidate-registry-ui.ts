import {
  candidateRegistryCatalogSchema,
  candidateRegistrySourceSchema,
  candidateRegistrySnapshotSchema,
  candidateRegistryLookupSchema,
  candidateRegistryRegisterSchema,
  candidateRegistrySourceDigestInput,
  candidateRegistryVersionDigestInput,
  candidateRegistryRequestDigestInput,
  candidateRegistryDownloadName,
  candidateRegistryLimits,
  type CandidateRegistryCatalog,
  type CandidateRegistrySource,
  type CandidateRegistryRegisterRequest,
  type CandidateRegistryReceipt,
} from "@/lib/studio-plan-quality-candidate-registry-types";

export type CandidateRegistryPending = {
  request: CandidateRegistryRegisterRequest;
  manifestDigest: string;
  previousDigest: string | null;
};
export const candidateRegistryBase = "/api/studio/quality/candidate-sets";
export const candidateRegistryVersions = `${candidateRegistryBase}/ai-validation-candidates/versions`;
const unique = (values: string[]) => new Set(values).size === values.length;

/** A cached empty list never proves an unsettled write failed. */
export function candidateRegistryCatalogLabels(
  catalog: CandidateRegistryCatalog,
  unsettled: boolean,
) {
  const head = Math.max(0, ...catalog.versions.map((item) => item.version));
  const registered = catalog.versions.find(
    (item) => item.sourceDigest === catalog.source.sourceDigest,
  );
  return {
    sourceStatus: unsettled
      ? "이번 요청의 등록 상태 확인 중"
      : registered
        ? `등록 버전 ${registered.version}와 원문 일치`
        : "마지막 조회에서는 이 원문의 등록본이 없습니다",
    history: `${unsettled ? "마지막 목록 조회 기준 · " : ""}등록 이력 ${catalog.versions.length}개 · 최근 등록 버전 ${head || "없음"}`,
    empty: unsettled
      ? "마지막 조회에서는 보관한 후보 등록본이 없었습니다. 진행 중인 요청의 등록 결과는 아직 확인하지 못했습니다."
      : "마지막 조회에서는 보관한 후보 등록본이 없습니다.",
  };
}

/** Browser-side checks. No registry writes, AI calls, or customer material input. */
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}
export function candidateRegistryCanonical(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export async function candidateRegistryDigest(value: unknown) {
  const bytes = new TextEncoder().encode(candidateRegistryCanonical(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function checkSource(value: CandidateRegistrySource) {
  if (
    !unique(value.entries.map((entry) => entry.candidateId)) ||
    !unique(value.entries.flatMap((entry) => entry.input.sources.map((source) => source.id))) ||
    !unique(value.manifest.map((entry) => entry.candidateId)) ||
    (await candidateRegistryDigest(candidateRegistrySourceDigestInput(value.entries))) !==
      value.sourceDigest ||
    (await candidateRegistryDigest(value.manifest)) !== value.manifestDigest
  )
    throw new Error("후보 원문과 목록의 연결을 확인하지 못했습니다.");
  await Promise.all(
    value.entries.map(async (entry, index) => {
      const manifest = value.manifest[index];
      const [source, candidate, input, metadata] = await Promise.all([
        candidateRegistryDigest({ profile: entry.input.profile, sources: entry.input.sources }),
        candidateRegistryDigest(entry.input.candidate),
        candidateRegistryDigest(entry.input),
        candidateRegistryDigest(entry.reviewerMetadata),
      ]);
      if (
        manifest.candidateId !== entry.candidateId ||
        manifest.label !== entry.label ||
        manifest.sourceDigest !== source ||
        manifest.candidateDigest !== candidate ||
        manifest.modelInputDigest !== input ||
        manifest.reviewerMetadataDigest !== metadata
      )
        throw new Error("후보 입력과 검토자 메모의 연결을 확인하지 못했습니다.");
    }),
  );
}

export async function candidateRegistrySource(raw: unknown) {
  const value = candidateRegistrySourceSchema.parse(raw);
  await checkSource(value);
  return value;
}

export async function candidateRegistryCatalog(raw: unknown) {
  const value = candidateRegistryCatalogSchema.parse(raw);
  await checkSource(value.source);
  const ordered = [...value.versions].sort((left, right) => left.version - right.version);
  if (
    !unique(ordered.map((item) => item.clientRequestId)) ||
    !unique(ordered.map((item) => item.sourceDigest)) ||
    ordered.some(
      (item, index) =>
        item.version !== index + 1 ||
        item.previousVersion !== (index === 0 ? null : index) ||
        item.previousDigest !== (index === 0 ? null : ordered[index - 1].versionDigest),
    )
  )
    throw new Error("후보 등록 이력의 버전 연결을 확인하지 못했습니다.");
  return value;
}

export function candidateRegistryPending(
  catalog: CandidateRegistryCatalog,
  nonce: string,
): CandidateRegistryPending {
  const head = [...catalog.versions].sort((left, right) => right.version - left.version)[0];
  if (catalog.versions.some((item) => item.sourceDigest === catalog.source.sourceDigest))
    throw new Error("현재 코드의 후보 원문은 이미 등록되었습니다.");
  if ((head?.version ?? 0) >= candidateRegistryLimits.versions)
    throw new Error("후보 등록 버전 한도에 도달했습니다.");
  return {
    request: candidateRegistryRegisterSchema.parse({
      expectedVersion: head?.version ?? 0,
      clientRequestId: nonce,
      sourceDigest: catalog.source.sourceDigest,
      acknowledgedCandidateStatus: true,
    }),
    manifestDigest: catalog.source.manifestDigest,
    previousDigest: head?.versionDigest ?? null,
  };
}

export async function candidateRegistrySnapshot(
  raw: unknown,
  expected: { version: number; versionDigest?: string },
) {
  const value = candidateRegistrySnapshotSchema.parse(raw);
  if (
    value.version !== expected.version ||
    (expected.versionDigest !== undefined && value.versionDigest !== expected.versionDigest) ||
    (await candidateRegistryDigest(candidateRegistryVersionDigestInput(value))) !==
      value.versionDigest
  )
    throw new Error("선택한 후보 등록 버전과 원문이 일치하지 않습니다.");
  await checkSource(value);
  return value;
}

export async function candidateRegistryRecovery(raw: unknown, waiting: CandidateRegistryPending) {
  const result = candidateRegistryLookupSchema.parse(raw);
  if (result.state === "committed") {
    const receipt = result.receipt;
    if (
      receipt.clientRequestId !== waiting.request.clientRequestId ||
      receipt.version !== waiting.request.expectedVersion + 1 ||
      receipt.inputDigest !==
        (await candidateRegistryDigest(candidateRegistryRequestDigestInput(waiting.request)))
    )
      throw new Error(
        "이 요청과 일치하는 후보 등록 영수증을 확인하지 못했습니다. 요청 번호를 보존합니다.",
      );
  }
  return result;
}

export async function candidateRegistryCommitted(
  raw: unknown,
  waiting: CandidateRegistryPending,
  receipt: CandidateRegistryReceipt,
) {
  await candidateRegistryRecovery({ state: "committed", receipt }, waiting);
  const value = await candidateRegistrySnapshot(raw, {
    version: receipt.version,
    versionDigest: receipt.versionDigest,
  });
  if (
    value.clientRequestId !== waiting.request.clientRequestId ||
    value.sourceDigest !== waiting.request.sourceDigest ||
    value.manifestDigest !== waiting.manifestDigest ||
    value.previousDigest !== waiting.previousDigest
  )
    throw new Error(
      "보관된 후보 원문이 이 등록 요청과 일치하지 않습니다. 저장 상태 조회를 유지합니다.",
    );
  return value;
}

export async function candidateRegistryArchive(
  response: Response,
  expected: { version: number; versionDigest: string },
) {
  const filename = candidateRegistryDownloadName(expected.version);
  const blob = await candidateRegistryJsonBytes(
    response,
    filename,
    candidateRegistryLimits.pinnedBytes,
  );
  await candidateRegistrySnapshot(JSON.parse(await blob.text()), expected);
  return { blob, filename };
}

export async function candidateRegistryJsonBytes(
  response: Response,
  filename: string,
  maximumBytes: number,
) {
  const disposition = response.headers.get("content-disposition")?.trim();
  const declared = response.headers.get("content-length");
  if (
    !response.ok ||
    response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !==
      "application/json" ||
    ![
      `attachment; filename="${filename}"`,
      `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    ].includes(disposition ?? "") ||
    (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes))
  ) {
    await response.body?.cancel();
    throw new Error("후보 버전 다운로드의 형식·파일 이름·크기를 확인하지 못했습니다.");
  }
  if (!response.body) throw new Error("내려받을 후보 버전이 없습니다.");
  const reader = response.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximumBytes) throw new Error("후보 버전 다운로드 크기가 너무 큽니다.");
      chunks.push(new Uint8Array(chunk.value).buffer);
    }
    if (declared !== null && Number(declared) !== size)
      throw new Error("후보 버전 다운로드가 완전하지 않습니다.");
    return new Blob(chunks, { type: "application/json" });
  } catch (caught) {
    await reader.cancel().catch(() => undefined);
    throw caught;
  } finally {
    reader.releaseLock();
  }
}
