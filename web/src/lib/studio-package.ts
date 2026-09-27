import "server-only";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { exportPlanMarkdown } from "./studio-export";
import { reviewPlan } from "./studio-engine";
import { StudioError } from "./studio-http";
import {
  PACKAGE_DOWNLOAD_NAME,
  packageLimits,
  packageRequestSchema,
  type PackageEvidence,
  type PackageManifest,
  type PackageOriginal,
  type PackageRequest,
} from "./studio-package-types";
import type { StudioStore } from "./studio-storage";

type Store = Pick<StudioStore, "get" | "isPlanCurrent" | "originalForVentureInput">;
const shared = globalThis as typeof globalThis & { __venturepassPackageJob?: { active: boolean } };
const job = (shared.__venturepassPackageJob ??= { active: false });
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
function fail(code: string, status = 409): never {
  throw new StudioError(
    "준비 묶음을 만들 수 없습니다. 선택한 원고·원본과 최신 기업자료 버전을 확인해 주세요.",
    status,
    code,
  );
}
const quote = (value: string) =>
  value
    .replaceAll("\r", "")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

/** Exact company snapshots and approved local buffers only; no filesystem path enters a ZIP. */
export async function buildPreparationPackage(
  store: Store,
  caseId: string,
  rawInput: PackageRequest,
): Promise<{ buffer: Buffer; fileName: string; manifest: PackageManifest }> {
  const input = packageRequestSchema.parse(rawInput);
  if (job.active) fail("PACKAGE_BUSY");
  job.active = true;
  try {
    const company = store.get(caseId);
    if (company.revision !== input.revision) fail("STALE_REVISION");
    const matches = company.plans.filter((plan) => plan.id === input.planId);
    if (matches.length !== 1) fail("PLAN_NOT_FOUND", 404);
    const plan = matches[0];
    const snapshotDigest = sha(JSON.stringify(company));
    const currentEvidence = store.isPlanCurrent(caseId, plan);
    const latestVersion = company.plans.at(-1)?.id === plan.id;
    const assertSnapshot = () => {
      const current = store.get(caseId);
      if (
        current.revision !== input.revision ||
        sha(JSON.stringify(current)) !== snapshotDigest ||
        store.isPlanCurrent(caseId, plan) !== currentEvidence
      )
        fail("PACKAGE_SNAPSHOT_CHANGED");
    };
    const files = new Map<string, Buffer>();
    const originals: PackageOriginal[] = [];
    let totalBytes = 0;
    for (const sourceId of input.sourceIds) {
      const source = company.sources.filter((item) => item.id === sourceId);
      if (source.length !== 1 || !source[0].originalName) fail("SOURCE_NOT_FOUND", 404);
      assertSnapshot();
      let original: ReturnType<Store["originalForVentureInput"]>;
      try {
        original = store.originalForVentureInput(caseId, sourceId);
      } catch {
        fail("PACKAGE_ORIGINAL_UNAVAILABLE");
      }
      if (JSON.stringify(original.source) !== JSON.stringify(source[0]))
        fail("PACKAGE_SNAPSHOT_CHANGED");
      if (original.buffer.length > packageLimits.originalBytes) fail("PACKAGE_ORIGINAL_LIMIT", 413);
      totalBytes += original.buffer.length;
      if (totalBytes > packageLimits.totalOriginalBytes) fail("PACKAGE_TOTAL_LIMIT", 413);
      if (original.sha256 !== sha(original.buffer)) fail("PACKAGE_ORIGINAL_CHANGED");
      // UUID entry names are one-to-one and cannot contain traversal or duplicate source names.
      const extension =
        /\.(pdf|png|jpg|jpeg|webp|txt|md|docx|xlsx|csv)$/i
          .exec(original.source.originalName!)?.[1]
          .toLowerCase() ?? "bin";
      const path = `originals/${sourceId}.${extension}`;
      files.set(path, original.buffer);
      originals.push({
        sourceId,
        path,
        originalName: original.source.originalName!,
        mimeType: original.source.mimeType,
        sizeBytes: original.buffer.length,
        sha256: original.sha256,
        sourceUpdatedAt: original.source.updatedAt,
        extraction: original.source.extraction,
      });
    }
    const selected = new Set(input.sourceIds);
    const evidence: PackageEvidence[] = plan.content.sections.flatMap((section) =>
      section.evidence.map((reference) => {
        const source = company.sources.find((item) => item.id === reference.sourceId);
        const profile = reference.sourceId === "profile";
        const matched =
          Boolean(reference.quote.trim()) &&
          (profile
            ? Object.values(company.profile).some(
                (value) => typeof value === "string" && value.includes(reference.quote),
              )
            : Boolean(
                source && source.extraction !== "pending" && source.text.includes(reference.quote),
              ));
        return {
          sectionKey: section.key,
          sourceId: reference.sourceId,
          sourceName: profile ? "기업 기본정보" : (source?.name ?? null),
          sourceUpdatedAt: source?.updatedAt ?? null,
          locator: reference.locator,
          quote: reference.quote,
          state: matched
            ? "matched"
            : source?.extraction === "pending"
              ? "pending"
              : profile || source
                ? "mismatch"
                : "missing",
          originalIncluded: selected.has(reference.sourceId),
        } as PackageEvidence;
      }),
    );
    const findings = reviewPlan(company, plan.content);
    const draftReasons = [
      ...(!currentEvidence ? ["PLAN_NOT_CURRENT"] : []),
      ...(!latestVersion ? ["OLDER_PLAN_VERSION"] : []),
      ...(!plan.confirmedAt ? ["NOT_REVIEWED"] : []),
      ...(plan.content.sections.some((section) => section.needsConfirmation)
        ? ["UNCONFIRMED_SECTION"]
        : []),
      ...(findings.some((finding) => finding.severity === "error") ? ["REVIEW_ERROR"] : []),
      ...(findings.some((finding) => finding.category === "confirmation")
        ? ["REVIEW_CONFIRMATION"]
        : []),
      ...(plan.review.some((finding) => finding.severity === "error")
        ? ["STORED_REVIEW_ERROR"]
        : []),
      ...(plan.review.some(
        (finding) => finding.category === "confirmation" && finding.severity !== "info",
      )
        ? ["STORED_REVIEW_CONFIRMATION"]
        : []),
      ...(plan.review.some(
        (finding) =>
          finding.severity !== "info" &&
          [
            "semantic-evidence",
            "contradiction",
            "timeline",
            "financial-plan",
            "fact-vs-plan",
          ].includes(finding.category),
      )
        ? ["STORED_SEMANTIC_FINDINGS"]
        : []),
      ...(evidence.some((item) => item.state !== "matched") ? ["INVALID_REFERENCE"] : []),
    ];
    const draft = draftReasons.length > 0;
    const banner = `${draft ? "DRAFT · 검토·보강 필요" : "로컬 검토 표시가 있는 준비본"}\n\n기관 접수·수신·심사·제출 완료를 증명하지 않는 로컬 준비 묶음입니다.\n`;
    const relatedIds = [...new Set([...input.sourceIds, ...evidence.map((item) => item.sourceId)])];
    files.set(
      "plan.md",
      Buffer.from(
        `${banner}\n${exportPlanMarkdown(company, plan, currentEvidence, { sourceListIds: relatedIds })}`,
        "utf8",
      ),
    );
    files.set(
      "evidence.json",
      Buffer.from(
        JSON.stringify({ scope: "registered-text-comparison-only", evidence }, null, 2),
        "utf8",
      ),
    );
    const linkedTasks = company.tasks.filter(
      (task) =>
        task.category === "evidence" &&
        task.status === "pending" &&
        task.diagnosisOrigin &&
        company.diagnoses.some(
          (diagnosis) => diagnosis.id === task.diagnosisOrigin!.diagnosisId && !diagnosis.stale,
        ),
    );
    const reviewLines = [
      banner,
      "# 미확인 항목·보강 과제",
      "",
      "현재 등록본문을 기준으로 다시 수행한 규칙 점검입니다. 원본 진위·기관 적합성 판단은 포함하지 않습니다.",
      "",
      ...findings.flatMap((finding) => [
        `## ${finding.severity} · ${finding.category}`,
        quote(finding.message),
        quote(finding.action),
        "",
      ]),
      "## 원고의 추가 준비 과제",
      "",
      ...plan.content.actionItems.map((item) => quote(item)),
      "",
      "## 원고 저장 당시 검토 의견",
      "AI 의미 검토를 포함해 원고 버전에 저장된 의견입니다. 현재 규칙 점검과 별도로 보존하며 해결·사실 확인 완료로 바꾸지 않습니다.",
      ...plan.review.flatMap((finding) => [
        `### ${finding.severity} · ${finding.category}`,
        quote(finding.message),
        quote(finding.action),
        "",
      ]),
      "",
      "## 현재 진단에서 연결한 미완료 자료보강 업무",
      ...linkedTasks.flatMap((task) => [quote(task.title), quote(task.notes), ""]),
      "",
      "선택한 원본의 보관·SHA 일치는 본문 검토나 기관 수신 확인이 아닙니다.",
    ];
    files.set("review.md", Buffer.from(reviewLines.join("\n"), "utf8"));
    const manifest: PackageManifest = {
      formatVersion: 1,
      scope: "local-preparation-only",
      caseId,
      caseRevision: input.revision,
      companyName: company.profile.companyName,
      observedAt: new Date().toISOString(),
      plan: {
        id: plan.id,
        version: plan.version,
        generatedAt: plan.generatedAt,
        sourceRevision: plan.sourceRevision,
        mode: plan.mode,
        currentEvidence,
        latestVersion,
        confirmedAt: plan.confirmedAt,
        draft,
        draftReasons,
      },
      originals,
      files: [...files].map(([path, bytes]) => ({
        path,
        sizeBytes: bytes.length,
        sha256: sha(bytes),
      })),
      warnings: [
        "기관 접수·수신·심사·제출 완료를 증명하지 않습니다.",
        "원본 SHA는 이 묶음에 넣은 보관 파일의 바이트 일치만 표시합니다. 기재 사실의 진위와 사용자 검토 완료를 뜻하지 않습니다.",
        "근거 일치는 현재 등록본문의 정확한 인용 포함 여부입니다. 당시 원고 작성 시점의 원본 파일과 동일하다는 보장은 없습니다.",
        "선택하지 않은 원본은 포함하지 않았습니다. 파일 SHA 목록은 manifest.json과 manifest.md 자체를 제외합니다.",
        ...(draft ? ["DRAFT: 원고 최신성·검토 여부 또는 보강 항목을 확인하세요."] : []),
      ],
    };
    files.set("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2), "utf8"));
    files.set(
      "manifest.md",
      Buffer.from(
        [
          banner,
          "# 준비 묶음 목록",
          quote(company.profile.companyName),
          `원고 v${plan.version} · ${plan.id}`,
          `현재 근거: ${currentEvidence ? "일치" : "오래됨"} / 최신 원고 버전: ${latestVersion ? "예" : "아니요"}`,
          `사용자 검토 표시: ${plan.confirmedAt ?? "없음"}`,
          `DRAFT 사유: ${draftReasons.join(", ") || "없음"}`,
          "",
          ...manifest.warnings.map(quote),
          "",
          ...originals.flatMap((item) => [
            `## ${item.path}`,
            quote(item.originalName),
            `크기: ${item.sizeBytes} bytes / SHA256: ${item.sha256}`,
            `본문 추출 상태: ${item.extraction}`,
            "",
          ]),
        ].join("\n"),
        "utf8",
      ),
    );
    const metadataBytes = [...files]
      .filter(([path]) => !path.startsWith("originals/"))
      .reduce((total, [, bytes]) => total + bytes.length, 0);
    if (metadataBytes > packageLimits.metadataBytes) fail("PACKAGE_METADATA_LIMIT", 413);
    assertSnapshot();
    const zip = new JSZip();
    for (const [path, buffer] of files)
      zip.file(path, buffer, { createFolders: false, date: new Date("2000-01-01T00:00:00Z") });
    const buffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "STORE",
      platform: "DOS",
      comment: "Local preparation only; not agency submission.",
    });
    if (buffer.length > packageLimits.zipBytes) fail("PACKAGE_ZIP_LIMIT", 413);
    // Never begin sending the archive before this final original/metadata/CAS pass completes.
    for (const saved of originals) {
      assertSnapshot();
      let current: ReturnType<Store["originalForVentureInput"]>;
      try {
        current = store.originalForVentureInput(caseId, saved.sourceId);
      } catch {
        fail("PACKAGE_ORIGINAL_UNAVAILABLE");
      }
      if (
        current.sha256 !== saved.sha256 ||
        sha(current.buffer) !== saved.sha256 ||
        current.buffer.length !== saved.sizeBytes ||
        JSON.stringify(current.source) !==
          JSON.stringify(company.sources.find((item) => item.id === saved.sourceId))
      )
        fail("PACKAGE_ORIGINAL_CHANGED");
    }
    assertSnapshot();
    return { buffer, fileName: PACKAGE_DOWNLOAD_NAME, manifest };
  } finally {
    job.active = false;
  }
}
