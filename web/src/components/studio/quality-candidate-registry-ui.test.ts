import { randomUUID, webcrypto } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planQualityEvaluationDigest as digest } from "@/lib/studio-plan-quality-evaluation";
import {
  createCandidateRegistrySource,
  candidateRegistryManifest,
  candidateRegistrySourceDigest,
  candidateRegistrySummary,
  candidateRegistryVersionDigest,
} from "@/lib/studio-plan-quality-candidate-registry";
import {
  candidateRegistryNotice,
  candidateRegistrySetId,
  candidateRegistryDownloadName,
  candidateRegistryRequestDigestInput,
  type CandidateRegistryCatalog,
  type CandidateRegistrySnapshot,
  type CandidateRegistrySource,
  type CandidateRegistryReceipt,
} from "@/lib/studio-plan-quality-candidate-registry-types";
import {
  candidateRegistryArchive,
  candidateRegistryCatalog,
  candidateRegistryCatalogLabels,
  candidateRegistryCommitted,
  candidateRegistryDigest,
  candidateRegistryJsonBytes,
  candidateRegistryPending,
  candidateRegistryRecovery,
  candidateRegistrySnapshot,
  candidateRegistrySource,
  candidateRegistryVersions,
} from "./quality-candidate-registry-ui";
import {
  QualityCandidateContents,
  QualityCandidateRegistryPanel,
} from "./quality-candidate-registry-panel";
import { qualityPost, QualityWriteRejection } from "./quality-evaluation-ui";

const now = "2026-09-27T06:00:00.000Z";
function changedSource() {
  const source = createCandidateRegistrySource();
  source.entries[0].reviewerMetadata.authoringNotes.push("합성 검토자 메모 두 번째 버전");
  source.manifest = candidateRegistryManifest(source.entries);
  source.manifestDigest = digest(source.manifest);
  source.sourceDigest = candidateRegistrySourceDigest(source.entries);
  return source;
}
function snapshot(
  source = createCandidateRegistrySource(),
  previous?: CandidateRegistrySnapshot,
): CandidateRegistrySnapshot {
  const value: Omit<CandidateRegistrySnapshot, "versionDigest"> = {
    ...source,
    kind: "validation-candidate-set" as const,
    version: previous ? previous.version + 1 : 1,
    previousVersion: previous?.version ?? null,
    previousDigest: previous?.versionDigest ?? null,
    registeredAt: now,
    clientRequestId: randomUUID(),
    notice: candidateRegistryNotice,
  };
  return { ...value, versionDigest: candidateRegistryVersionDigest(value) };
}
function fixture() {
  const value = snapshot();
  const catalog: CandidateRegistryCatalog = {
    source: createCandidateRegistrySource(),
    versions: [],
  };
  const waiting = candidateRegistryPending(catalog, value.clientRequestId);
  const receipt: CandidateRegistryReceipt = {
    kind: "register-candidate-set",
    setId: candidateRegistrySetId,
    version: 1,
    clientRequestId: value.clientRequestId,
    inputDigest: digest(candidateRegistryRequestDigestInput(waiting.request)),
    versionDigest: value.versionDigest,
  };
  return { value, catalog, waiting, receipt };
}
function archive(value: CandidateRegistrySnapshot, change: Record<string, string> = {}) {
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  return {
    raw,
    response: new Response(raw, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${candidateRegistryDownloadName(value.version)}"`,
        "content-length": String(new TextEncoder().encode(raw).byteLength),
        ...change,
      },
    }),
  };
}
const fetchGuard = vi.fn(() => {
  throw new Error("합성 UI 시험 외부 요청 금지");
});
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  fetchGuard.mockClear();
  vi.stubGlobal("fetch", fetchGuard);
});
afterEach(() => vi.unstubAllGlobals());

describe("후보 원문·등록 이력 대조", () => {
  it("validates all 12 inputs and separate reviewer metadata with server-compatible digests", async () => {
    const source = createCandidateRegistrySource();
    expect(await candidateRegistrySource(source)).toEqual(source);
    expect(await candidateRegistryDigest({ "10": "a", "2": "b", Z: 2, a: ["한글"] })).toBe(
      digest({ "10": "a", "2": "b", Z: 2, a: ["한글"] }),
    );
    expect(source.entries).toHaveLength(12);
    expect(fetchGuard).not.toHaveBeenCalled();
  });
  it("metadata-only changes do not change model inputs but are a new source version", async () => {
    const previous = createCandidateRegistrySource(),
      current = changedSource();
    expect(current.manifest[0].modelInputDigest).toBe(previous.manifest[0].modelInputDigest);
    expect(current.manifest[0].reviewerMetadataDigest).not.toBe(
      previous.manifest[0].reviewerMetadataDigest,
    );
    expect(current.sourceDigest).not.toBe(previous.sourceDigest);
    expect(await candidateRegistrySource(current)).toEqual(current);
  });
  it.each(["input", "memo", "manifest", "duplicate"])(
    "rejects changed %s instead of displaying a verified source",
    async (kind) => {
      const source = createCandidateRegistrySource();
      if (kind === "input") source.entries[0].input.profile.companyName += "변경";
      if (kind === "memo") source.entries[0].reviewerMetadata.authoringNotes.push("변경");
      if (kind === "manifest") source.manifest[0].modelInputDigest = "f".repeat(64);
      if (kind === "duplicate") source.entries[1] = structuredClone(source.entries[0]);
      await expect(candidateRegistrySource(source)).rejects.toThrow();
    },
  );
  it("rejects a recomputed source digest with a stale per-entry manifest", async () => {
    const source = createCandidateRegistrySource();
    source.entries[0].input.profile.companyName += "변경";
    source.sourceDigest = candidateRegistrySourceDigest(source.entries);
    await expect(candidateRegistrySource(source)).rejects.toThrow("후보 입력");
  });
  it("accepts unordered complete history, rejects gaps and changed previous binding", async () => {
    const first = snapshot(),
      second = snapshot(changedSource(), first);
    const catalog = {
      source: changedSource(),
      versions: [candidateRegistrySummary(second), candidateRegistrySummary(first)],
    };
    expect(await candidateRegistryCatalog(catalog)).toEqual(catalog);
    await expect(
      candidateRegistryCatalog({ ...catalog, versions: [catalog.versions[0]] }),
    ).rejects.toThrow();
    catalog.versions[0].previousDigest = "f".repeat(64);
    await expect(candidateRegistryCatalog(catalog)).rejects.toThrow();
  });
  it("captures current source and previous fixed digest without registering automatically", () => {
    const prior = snapshot();
    const catalog = { source: changedSource(), versions: [candidateRegistrySummary(prior)] };
    const waiting = candidateRegistryPending(catalog, randomUUID());
    expect(waiting.request).toMatchObject({
      expectedVersion: 1,
      sourceDigest: catalog.source.sourceDigest,
      acknowledgedCandidateStatus: true,
    });
    expect(waiting.previousDigest).toBe(prior.versionDigest);
    expect(waiting.manifestDigest).toBe(catalog.source.manifestDigest);
    expect(Object.keys(waiting.request).sort()).toEqual([
      "acknowledgedCandidateStatus",
      "clientRequestId",
      "expectedVersion",
      "sourceDigest",
    ]);
    expect(fetchGuard).not.toHaveBeenCalled();
  });
  it("refuses a new nonce for already registered source bytes", () => {
    const value = snapshot();
    expect(() =>
      candidateRegistryPending(
        { source: createCandidateRegistrySource(), versions: [candidateRegistrySummary(value)] },
        randomUUID(),
      ),
    ).toThrow("이미 등록");
  });
});

describe("후보 등록 요청 복구", () => {
  it("not-observed is only an observation and does not mutate or retry the request", async () => {
    const { waiting } = fixture(),
      before = JSON.stringify(waiting);
    expect(await candidateRegistryRecovery({ state: "not-observed" }, waiting)).toEqual({
      state: "not-observed",
    });
    expect(JSON.stringify(waiting)).toBe(before);
    expect(fetchGuard).not.toHaveBeenCalled();
  });
  it("accepts exact nonce receipt and then the exact archived snapshot", async () => {
    const { waiting, receipt, value } = fixture();
    expect(await candidateRegistryRecovery({ state: "committed", receipt }, waiting)).toEqual({
      state: "committed",
      receipt,
    });
    expect(await candidateRegistryCommitted(value, waiting, receipt)).toEqual(value);
  });
  it.each(["nonce", "version", "digest"])("rejects a different receipt %s", async (change) => {
    const { waiting, receipt } = fixture();
    if (change === "nonce") receipt.clientRequestId = randomUUID();
    if (change === "version") receipt.version += 1;
    if (change === "digest") receipt.inputDigest = "f".repeat(64);
    await expect(
      candidateRegistryRecovery({ state: "committed", receipt }, waiting),
    ).rejects.toThrow("이 요청");
  });
  it("does not accept an archive with another pinned manifest or previous digest", async () => {
    const { waiting, receipt, value } = fixture();
    await expect(
      candidateRegistryCommitted(value, { ...waiting, manifestDigest: "f".repeat(64) }, receipt),
    ).rejects.toThrow("이 등록 요청");
    await expect(
      candidateRegistryCommitted(value, { ...waiting, previousDigest: "f".repeat(64) }, receipt),
    ).rejects.toThrow("이 등록 요청");
  });
  it("requires exact snapshot version, digest, and original bytes", async () => {
    const { value } = fixture();
    await expect(candidateRegistrySnapshot(value, { version: 2 })).rejects.toThrow();
    await expect(
      candidateRegistrySnapshot(value, { version: 1, versionDigest: "f".repeat(64) }),
    ).rejects.toThrow();
    value.entries[0].input.profile.companyName += "변경";
    value.versionDigest = candidateRegistryVersionDigest(value);
    await expect(candidateRegistrySnapshot(value, { version: 1 })).rejects.toThrow();
  });
  it("explicit retries transmit identical nonce and body; errors do not trigger another POST", async () => {
    const { waiting } = fixture();
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", send);
    await expect(qualityPost(candidateRegistryVersions, waiting.request)).rejects.toThrow(
      "network",
    );
    expect(send).toHaveBeenCalledTimes(1);
    await qualityPost(candidateRegistryVersions, waiting.request);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
  });
  it("only explicit accepted:false 4xx is a definite rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: "충돌", accepted: false }), { status: 409 }),
        ),
    );
    await expect(
      qualityPost(candidateRegistryVersions, fixture().waiting.request),
    ).rejects.toBeInstanceOf(QualityWriteRejection);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ error: "확인 필요" }), { status: 409 })),
    );
    await expect(
      qualityPost(candidateRegistryVersions, fixture().waiting.request),
    ).rejects.not.toBeInstanceOf(QualityWriteRejection);
  });
});

describe("고정 후보 JSON 다운로드와 UI", () => {
  it("preserves original archived bytes instead of generating today's source", async () => {
    const { value } = fixture();
    const file = archive(value);
    const result = await candidateRegistryArchive(file.response, value);
    expect(await result.blob.text()).toBe(file.raw);
    expect(result.filename).toBe(candidateRegistryDownloadName(1));
    expect(changedSource().sourceDigest).not.toBe(value.sourceDigest);
  });
  it.each(["content-type", "content-disposition", "content-length"])(
    "rejects invalid %s without saving the file",
    async (header) => {
      const { value } = fixture();
      const incorrect =
        header === "content-type"
          ? "text/html"
          : header === "content-length"
            ? "1"
            : 'attachment; filename="wrong.json"';
      await expect(
        candidateRegistryArchive(archive(value, { [header]: incorrect }).response, value),
      ).rejects.toThrow();
    },
  );
  it("limits actual streamed bytes even without a declared length", async () => {
    const filename = "synthetic.json";
    await expect(
      candidateRegistryJsonBytes(
        new Response("123456", {
          headers: {
            "content-type": "application/json",
            "content-disposition": `attachment; filename="${filename}"`,
          },
        }),
        filename,
        3,
      ),
    ).rejects.toThrow("너무 큽니다");
  });
  it("renders only synthetic read views with separated reviewer notes", () => {
    const source: CandidateRegistrySource = createCandidateRegistrySource();
    const html = renderToStaticMarkup(
      createElement(QualityCandidateContents, { source, label: "현재 코드의 후보 원문" }),
    );
    expect(html).toContain("현재 코드의 후보 원문 · 12개");
    expect(html).toContain("입력 자료·신청 주제 원문");
    expect(html).toContain("검토자용 구성 의도·작성자 메모");
    expect(html).toContain("사람 정답표 없음 · 독립성 미확정 · 성능 미평가");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain('type="file"');
    expect(fetchGuard).not.toHaveBeenCalled();
  });
  it("initial panel has no auto-registration or evaluation and supports narrow wrapped controls", () => {
    const html = renderToStaticMarkup(
      createElement(QualityCandidateRegistryPanel, { blockedReason: "기존 평가 저장 확인 중" }),
    );
    expect(html).toContain("기존 50개 평가 회차와 별도로 보관");
    expect(html).toContain("기존 평가 저장 확인 중");
    expect(html).toContain("min-h-11");
    expect(html).toContain("whitespace-normal");
    expect(fetchGuard).not.toHaveBeenCalled();
  });
});

describe("미확정 등록 중 목록 안내", () => {
  it("does not infer failure from an empty catalog after a POST result is lost", () => {
    const { catalog } = fixture();
    const labels = candidateRegistryCatalogLabels(catalog, true);
    expect(labels.sourceStatus).toBe("이번 요청의 등록 상태 확인 중");
    expect(labels.history).toBe("마지막 목록 조회 기준 · 등록 이력 0개 · 최근 등록 버전 없음");
    expect(labels.empty).toContain("진행 중인 요청의 등록 결과는 아직 확인하지 못했습니다");
    expect(Object.values(labels).join(" ")).not.toContain("아직 등록되지 않았습니다");
  });
  it("qualifies a nonempty old history while preserving an exact settled registration label", () => {
    const value = snapshot();
    const catalog = {
      source: createCandidateRegistrySource(),
      versions: [candidateRegistrySummary(value)],
    };
    expect(candidateRegistryCatalogLabels(catalog, true).history).toContain(
      "마지막 목록 조회 기준 · 등록 이력 1개",
    );
    expect(candidateRegistryCatalogLabels(catalog, true).sourceStatus).toContain(
      "등록 상태 확인 중",
    );
    expect(candidateRegistryCatalogLabels(catalog, false).sourceStatus).toBe(
      "등록 버전 1와 원문 일치",
    );
  });
});
