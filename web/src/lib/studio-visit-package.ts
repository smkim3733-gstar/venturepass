import "server-only";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { isApplicationSubmission, type ApplicationSubmission } from "./studio-application-types";
import { originalConflicts, planConflicts } from "./studio-evidence-history";
import { StudioError } from "./studio-http";
import type { BusinessPlan, StudioCase } from "./studio-schema";
import type { StudioStore } from "./studio-storage";
import {
  visitAnswerContext,
  visitAnswerInputSchema,
  visitAnswerSchema,
  visitRespondentLabels,
  type VisitAnswer,
} from "./studio-visit-answer-types";
import {
  VISIT_PACKAGE_DOWNLOAD_NAME,
  visitPackageLimits,
  visitPackageRequestSchema,
  type VisitPackageManifest,
  type VisitPackageRequest,
} from "./studio-visit-package-types";

type Store = Pick<StudioStore, "get" | "isPlanCurrent" | "originalForVentureInput">;
// Share the existing ZIP job slot: both archives can retain up to 24MiB of original buffers.
const shared = globalThis as typeof globalThis & { __venturepassPackageJob?: { active: boolean } };
const job = (shared.__venturepassPackageJob ??= { active: false });
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function fail(code: string, status = 409): never {
  throw new StudioError(
    "실사 준비 묶음을 만들 수 없습니다. 선택한 원고·질문·답변·제출 기록과 원본을 확인해 주세요.",
    status,
    code,
  );
}
// User prose stays literal even if it contains Markdown images, HTML or closing fences.
const literal = (value: string) => {
  const runs = value.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  return `${fence}text\n${value}\n${fence}`;
};
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2), "utf8");

function selectedAnswers(
  company: StudioCase,
  plan: BusinessPlan,
  submission: ApplicationSubmission | null,
  input: VisitPackageRequest,
  planSha: string,
): VisitAnswer[] {
  const roots = new Set<string>();
  return input.answerVersionIds.map((id) => {
    const matches = company.visitAnswers.filter((record) => record.id === id);
    if (matches.length !== 1) fail("VISIT_PACKAGE_ANSWER_NOT_FOUND", 404);
    const parsed = visitAnswerSchema.safeParse(matches[0]);
    if (!parsed.success) fail("VISIT_PACKAGE_ANSWER_CHANGED");
    const answer = parsed.data;
    if (roots.has(answer.answerId)) fail("VISIT_PACKAGE_ANSWER_ROOT_DUPLICATE", 422);
    roots.add(answer.answerId);
    const saved = answer.questionSnapshot;
    if (
      answer.planId !== plan.id ||
      saved.planId !== plan.id ||
      saved.planVersion !== plan.version ||
      saved.planContentSha256 !== planSha ||
      saved.planTitle !== plan.content.title ||
      saved.questionIndex !== answer.questionIndex ||
      saved.questionText !== answer.questionText ||
      plan.content.interviewQuestions[answer.questionIndex] !== answer.questionText ||
      saved.questionSha256 !== sha(answer.questionText)
    )
      fail("VISIT_PACKAGE_QUESTION_CHANGED");
    if (answer.submissionRecordId !== null && answer.submissionRecordId !== submission?.id)
      fail("VISIT_PACKAGE_SUBMISSION_MISMATCH");
    const bound = answer.submissionSnapshot;
    if (
      answer.submissionRecordId === null
        ? bound !== null
        : !bound ||
          !submission ||
          bound.id !== submission.id ||
          bound.applicationId !== submission.applicationId ||
          bound.version !== submission.version ||
          bound.recordedAt !== submission.recordedAt ||
          bound.planContentSha256 !== planSha
    )
      fail("VISIT_PACKAGE_SUBMISSION_MISMATCH");
    const originalInput = visitAnswerInputSchema.safeParse({
      answerId: answer.previousVersionId === null ? null : answer.answerId,
      previousVersionId: answer.previousVersionId,
      planId: answer.planId,
      questionIndex: answer.questionIndex,
      questionText: answer.questionText,
      submissionRecordId: answer.submissionRecordId,
      respondentRole: answer.respondentRole,
      respondentName: answer.respondentName,
      answerText: answer.answerText,
      pairs: answer.pairs,
      followUpNote: answer.followUpNote,
      review: {
        reviewed: answer.review.reviewedAt !== null,
        reviewer: answer.review.reviewer,
        note: answer.review.note,
      },
    });
    if (!originalInput.success || sha(JSON.stringify(originalInput.data)) !== answer.inputDigest)
      fail("VISIT_PACKAGE_ANSWER_CHANGED");
    const references = answer.pairs.flatMap((pair) => pair.sources);
    const sourceIds = new Set(references.map((ref) => ref.sourceId));
    if (
      answer.sourceSnapshots.length !== sourceIds.size ||
      answer.sourceSnapshots.some(
        (snapshot) =>
          !sourceIds.has(snapshot.sourceId) ||
          answer.sourceSnapshots.filter((item) => item.sourceId === snapshot.sourceId).length !== 1,
      )
    )
      fail("VISIT_PACKAGE_REFERENCE_CHANGED");
    for (const pair of answer.pairs) {
      if (!answer.answerText.includes(pair.answerQuote)) fail("VISIT_PACKAGE_REFERENCE_CHANGED");
      if (pair.planReference) {
        const ref = pair.planReference,
          sections = plan.content.sections.filter((item) => item.key === ref.sectionKey);
        if (sections.length !== 1 || !sections[0].content.includes(ref.quote))
          fail("VISIT_PACKAGE_REFERENCE_CHANGED");
      }
      for (const ref of pair.sources) {
        const snapshot = answer.sourceSnapshots.find((item) => item.sourceId === ref.sourceId)!;
        if (
          snapshot.sourceUpdatedAt !== ref.sourceUpdatedAt ||
          (snapshot.original &&
            (snapshot.original.sourceId !== ref.sourceId ||
              snapshot.original.sourceUpdatedAt !== snapshot.sourceUpdatedAt))
        )
          fail("VISIT_PACKAGE_REFERENCE_CHANGED");
      }
    }
    return answer;
  });
}

/** An explicit read-only selection. Historical prose is never replaced with current source text. */
export async function buildVisitPackage(
  store: Store,
  caseId: string,
  raw: VisitPackageRequest,
): Promise<{ buffer: Buffer; fileName: string; manifest: VisitPackageManifest }> {
  const input = visitPackageRequestSchema.parse(raw);
  if (job.active) fail("PACKAGE_BUSY");
  job.active = true;
  try {
    const company = store.get(caseId);
    if (company.id !== caseId || company.revision !== input.revision) fail("STALE_REVISION");
    const plans = company.plans.filter((plan) => plan.id === input.planId);
    if (plans.length !== 1) fail("PLAN_NOT_FOUND", 404);
    const plan = plans[0],
      planSha = sha(JSON.stringify(plan.content));
    if (planConflicts(company, { planId: plan.id, version: plan.version, contentSha256: planSha }))
      fail("VISIT_PACKAGE_PLAN_CHANGED");
    let submission: ApplicationSubmission | null = null;
    if (input.submissionRecordId !== null) {
      const events = company.applicationEvents.filter(
        (event) => event.id === input.submissionRecordId,
      );
      if (events.length !== 1 || !isApplicationSubmission(events[0]))
        fail("VISIT_PACKAGE_SUBMISSION_NOT_FOUND", 404);
      submission = events[0];
      if (
        company.applications.filter((item) => item.id === submission!.applicationId).length !== 1 ||
        submission.companySnapshot.caseId !== caseId ||
        submission.plan.id !== plan.id ||
        submission.plan.version !== plan.version ||
        submission.plan.contentSha256 !== planSha
      )
        fail("VISIT_PACKAGE_SUBMISSION_MISMATCH");
    }
    const answers = selectedAnswers(company, plan, submission, input, planSha);
    const currentEvidence = store.isPlanCurrent(caseId, plan),
      companyDigest = sha(JSON.stringify(company));
    const assertCurrent = () => {
      const current = store.get(caseId);
      if (
        current.id !== caseId ||
        current.revision !== input.revision ||
        sha(JSON.stringify(current)) !== companyDigest ||
        store.isPlanCurrent(caseId, plan) !== currentEvidence
      )
        fail("VISIT_PACKAGE_SNAPSHOT_CHANGED");
    };
    const allowedSources = new Set([
      ...plan.content.sections.flatMap((section) => section.evidence.map((ref) => ref.sourceId)),
      ...answers.flatMap((answer) =>
        answer.sourceSnapshots.flatMap((snapshot) =>
          snapshot.original ? [snapshot.sourceId] : [],
        ),
      ),
      ...(submission?.originals.map((original) => original.sourceId) ?? []),
    ]);
    // Resolve all selected IDs before opening any original.
    for (const sourceId of input.sourceIds) {
      const sources = company.sources.filter((source) => source.id === sourceId);
      if (!allowedSources.has(sourceId) || sources.length !== 1 || !sources[0].originalName)
        fail("VISIT_PACKAGE_SOURCE_NOT_SELECTED", 422);
    }
    const files = new Map<string, Buffer>();
    const originals: VisitPackageManifest["originals"] = [];
    let totalBytes = 0;
    for (const sourceId of input.sourceIds) {
      assertCurrent();
      let original: ReturnType<Store["originalForVentureInput"]>;
      try {
        original = store.originalForVentureInput(caseId, sourceId);
      } catch {
        fail("PACKAGE_ORIGINAL_UNAVAILABLE");
      }
      const source = company.sources.find((item) => item.id === sourceId)!;
      if (
        JSON.stringify(original.source) !== JSON.stringify(source) ||
        original.sha256 !== sha(original.buffer)
      )
        fail("PACKAGE_ORIGINAL_CHANGED");
      totalBytes += original.buffer.length;
      if (
        original.buffer.length > visitPackageLimits.originalBytes ||
        totalBytes > visitPackageLimits.totalOriginalBytes
      )
        fail("PACKAGE_ORIGINAL_LIMIT", 413);
      const identity = {
        sourceId,
        sha256: original.sha256,
        sizeBytes: original.buffer.length,
        originalName: source.originalName!,
        mimeType: source.mimeType,
      };
      if (originalConflicts(company, identity)) fail("VISIT_PACKAGE_HISTORICAL_ORIGINAL_CHANGED");
      const savedReferences = [
        ...answers.flatMap((answer) =>
          answer.sourceSnapshots.flatMap((snapshot) =>
            snapshot.sourceId === sourceId && snapshot.original ? [snapshot.original] : [],
          ),
        ),
        ...(submission?.originals.filter((item) => item.sourceId === sourceId) ?? []),
      ];
      if (
        savedReferences.some(
          (saved) =>
            saved.sha256 !== identity.sha256 ||
            saved.sizeBytes !== identity.sizeBytes ||
            saved.originalName !== identity.originalName ||
            saved.mimeType !== identity.mimeType,
        )
      )
        fail("VISIT_PACKAGE_HISTORICAL_ORIGINAL_CHANGED");
      const extension =
        /\.(pdf|png|jpg|jpeg|webp|txt|md|docx|xlsx|csv)$/i
          .exec(source.originalName!)?.[1]
          .toLowerCase() ?? "bin";
      const path = `originals/${sourceId}.${extension}`;
      files.set(path, original.buffer);
      originals.push({
        ...identity,
        path,
        sourceUpdatedAt: source.updatedAt,
        extraction: source.extraction,
        comparison: savedReferences.length ? "saved-reference" : "current-file",
      });
    }
    const selectedOriginalIds = new Set(input.sourceIds);
    const exportedAnswers = answers.map((answer) => {
      // Nonce/inputDigest are integrity internals, not preparation prose.
      const { clientRequestId: _nonce, inputDigest: _digest, ...saved } = answer;
      void _nonce;
      void _digest;
      return {
        saved,
        submissionBinding:
          answer.submissionRecordId === null ? "unlinked" : "exact-selected-record",
        currentContext: visitAnswerContext(company, answer),
        sourceOriginals: answer.sourceSnapshots.map((source) => ({
          sourceId: source.sourceId,
          included: selectedOriginalIds.has(source.sourceId),
        })),
      };
    });
    const questions = plan.content.interviewQuestions.map((question, index) => ({
      index,
      text: question,
      sha256: sha(question),
      selectedAnswerVersionIds: answers
        .filter((answer) => answer.questionIndex === index)
        .map((answer) => answer.id),
    }));
    const banner =
      input.mode === "draft"
        ? "DRAFT · 저장 원고 기준 실사 준비 묶음"
        : "DRAFT · 수동 제출 기록 기준 실사 준비 묶음";
    const warnings = [
      "기관의 실제 질문·접수·수신·심사·제출 완료를 증명하지 않습니다. 모든 묶음은 DRAFT 실사 준비용입니다.",
      "선택한 정확한 원고·답변 버전을 보존합니다. 최신 답변이나 과거 자료 본문을 현재 내용으로 교체하지 않습니다.",
      "담당자 답변과 내부 검토 표시는 사실 진위·기관 적합성 확인이 아닙니다. 저장된 수치 표기 차이도 의미상 모순 판정이 아닙니다.",
      "현재 연결 문맥은 등록 자료 메타데이터·인용 대조일 뿐입니다. 선택하지 않은 원본 파일은 읽거나 포함하지 않았습니다.",
      "saved-reference 원본은 저장된 SHA·크기·원본명·MIME와 일치합니다. current-file 원본은 현재 별도로 선택한 파일이며 과거 제출·답변 당시 파일임을 보장하지 않습니다.",
      "제출 기록 미연결 답변은 묶음에 넣어도 그 제출 기록으로 소급 귀속하지 않습니다.",
      "SHA는 바이트 식별값입니다. 원본 진위·기재 사실·기관 확인을 보장하지 않습니다. manifest 파일 자체는 파일 SHA 목록에서 제외합니다.",
    ];
    const manifest: VisitPackageManifest = {
      formatVersion: 1,
      scope: "local-visit-preparation-only",
      draft: true,
      caseId,
      caseRevision: input.revision,
      observedAt: new Date().toISOString(),
      mode: input.mode,
      currentCompanyName: company.profile.companyName,
      selection: {
        planId: input.planId,
        submissionRecordId: input.submissionRecordId,
        answerVersionIds: [...input.answerVersionIds],
        sourceIds: [...input.sourceIds],
      },
      plan: {
        id: plan.id,
        version: plan.version,
        title: plan.content.title,
        contentSha256: planSha,
        currentEvidence,
        latestVersion: company.plans.at(-1)?.id === plan.id,
        confirmedAt: plan.confirmedAt,
      },
      submission: submission
        ? {
            id: submission.id,
            applicationId: submission.applicationId,
            version: submission.version,
            occurredOn: submission.occurredOn,
            recordedAt: submission.recordedAt,
            recordedBy: submission.recordedBy,
            note: submission.note,
            recordedCompanyName: submission.companySnapshot.companyName,
            officialVerification: submission.officialVerification,
          }
        : null,
      answers: answers.map((answer) => ({
        id: answer.id,
        answerId: answer.answerId,
        version: answer.version,
        questionIndex: answer.questionIndex,
        submissionRecordId: answer.submissionRecordId,
        reviewedAt: answer.review.reviewedAt,
        currentContext: visitAnswerContext(company, answer).state,
      })),
      originals,
      files: [],
      warnings,
    };
    files.set(
      "README.md",
      Buffer.from(
        [
          `# ${banner}`,
          "",
          ...warnings.map((warning) => `- ${warning}`),
          "",
          "## 현재 표시 회사명",
          literal(company.profile.companyName),
          ...(manifest.submission
            ? [
                "## 선택한 수동 제출 기록 당시 회사명",
                literal(manifest.submission.recordedCompanyName),
                "기관 확인 상태: unverified · 담당자가 제출했다고 기록한 내용",
              ]
            : []),
        ].join("\n"),
        "utf8",
      ),
    );
    files.set(
      "plan.json",
      json({
        scope: "selected-plan-exact",
        id: plan.id,
        version: plan.version,
        contentSha256: planSha,
        content: plan.content,
      }),
    );
    files.set(
      "plan.md",
      Buffer.from(
        [
          `# ${banner}`,
          `원고 v${plan.version} · ${plan.id}`,
          literal(plan.content.title),
          "## 저장 원고 요약",
          literal(plan.content.summary),
          ...plan.content.sections.flatMap((section, index) => [
            `## 원고 항목 ${index + 1}`,
            literal(section.title),
            literal(section.content),
            `직접 확인 필요 표시: ${section.needsConfirmation ? "있음" : "없음 (사실 확인 완료 아님)"}`,
            "저장 원고의 인용:",
            ...section.evidence.flatMap((ref) => [
              literal(`출처 ID: ${ref.sourceId}\n위치: ${ref.locator}`),
              literal(ref.quote),
            ]),
          ]),
        ].join("\n\n"),
        "utf8",
      ),
    );
    files.set(
      "answers.json",
      json({ scope: "selected-saved-answer-versions", questions, answers: exportedAnswers }),
    );
    const answerLines = [
      `# ${banner}`,
      "예상 질문이며 기관의 실제 질문이 아닙니다. 선택한 답변이 없는 질문은 실제 답변의 존재 여부를 판단하지 않습니다.",
    ];
    const pendingLines = [
      `# ${banner} · 미확인·보강 목록`,
      "이 목록은 선택한 답변·원고 범위입니다. 전체 기업자료 점검이나 사실 판단이 아닙니다.",
    ];
    for (const question of questions) {
      answerLines.push(`## 질문 ${question.index + 1}`, literal(question.text));
      const selectedAnswers = answers.filter((answer) => answer.questionIndex === question.index);
      if (!selectedAnswers.length) {
        answerLines.push("선택한 저장 답변 없음 · 실제 답변 존재 여부 미확인");
        pendingLines.push(`- 질문 ${question.index + 1}: 선택 답변 없음`);
      }
      for (const answer of selectedAnswers) {
        const context = visitAnswerContext(company, answer);
        answerLines.push(
          `### 선택 답변 v${answer.version} · ${answer.id}`,
          `역할: ${visitRespondentLabels[answer.respondentRole]}`,
          literal(answer.respondentName || "응답자 미기록"),
          literal(answer.answerText || "저장 답변 공란"),
          answer.submissionRecordId === null
            ? "제출 기록 미연결 · 이 출력으로 소급 귀속하지 않음"
            : `선택 제출 기록과 명시 연결: ${answer.submissionRecordId}`,
          `내부 검토 기록: ${answer.review.reviewedAt ?? "미검토"}`,
          literal(
            `내부 검토자: ${answer.review.reviewer || "미기록"}\n검토 메모: ${answer.review.note || "미기록"}`,
          ),
        );
        for (const pair of answer.pairs) {
          answerLines.push(
            "#### 저장 답변의 대조 인용",
            literal(pair.answerQuote),
            literal(`해석 메모: ${pair.contextNote}`),
          );
          if (pair.planReference)
            answerLines.push(
              literal(`원고 항목: ${pair.planReference.sectionKey}`),
              literal(pair.planReference.quote),
            );
          for (const ref of pair.sources) {
            const snapshot = answer.sourceSnapshots.find((item) => item.sourceId === ref.sourceId)!;
            answerLines.push(
              literal(
                `저장 당시 자료명: ${snapshot.sourceName}\n등록 시각: ${snapshot.sourceUpdatedAt}\n위치: ${ref.locator || "미기록"}`,
              ),
              literal(ref.quote || "원본만 연결 · 본문 인용 미검토"),
              `원본: ${selectedOriginalIds.has(ref.sourceId) ? "선택하여 포함" : "미포함"}`,
            );
          }
        }
        answerLines.push(
          "#### 저장 당시 후속 확인 사항",
          literal(answer.followUpNote || "미기록"),
          "#### 현재 등록 연결 문맥",
          `상태: ${context.state}`,
          ...context.issues.map(literal),
        );
        if (!answer.answerText.trim())
          pendingLines.push(
            `- 질문 ${question.index + 1} / 답변 v${answer.version}: 저장 답변 공란`,
          );
        if (!answer.review.reviewedAt)
          pendingLines.push(`- 질문 ${question.index + 1} / 답변 v${answer.version}: 내부 미검토`);
        if (context.state !== "current")
          pendingLines.push(
            `- 질문 ${question.index + 1} / 답변 v${answer.version}: 현재 자료 연결 ${context.state}`,
            ...context.issues.map(literal),
          );
        for (const check of answer.checks)
          pendingLines.push(
            `- 질문 ${question.index + 1} / 답변 v${answer.version} / ${check.code}`,
            literal(check.message),
          );
        for (const snapshot of answer.sourceSnapshots)
          if (snapshot.original && !selectedOriginalIds.has(snapshot.sourceId))
            pendingLines.push(
              `- 질문 ${question.index + 1}: 저장 증빙 원본 미포함`,
              literal(snapshot.sourceName),
            );
      }
    }
    if (!questions.length)
      pendingLines.push(
        "선택 원고에 저장된 예상 질문이 없습니다. 질문 준비 완료를 뜻하지 않습니다.",
      );
    if (!currentEvidence)
      pendingLines.push("선택 원고가 현재 기업자료와 일치하는지 다시 확인해야 합니다.");
    for (const section of plan.content.sections)
      if (section.needsConfirmation)
        pendingLines.push("원고 확인 필요 항목:", literal(section.title));
    files.set("answers.md", Buffer.from(answerLines.join("\n\n"), "utf8"));
    files.set("pending.md", Buffer.from(pendingLines.join("\n\n"), "utf8"));
    manifest.files = [...files].map(([path, bytes]) => ({
      path,
      sizeBytes: bytes.length,
      sha256: sha(bytes),
    }));
    files.set("manifest.json", json(manifest));
    files.set(
      "manifest.md",
      Buffer.from(
        [
          `# ${banner} · 파일 목록`,
          ...warnings.map(literal),
          ...manifest.files.flatMap((file) => [
            `## ${file.path}`,
            `크기: ${file.sizeBytes} bytes / SHA-256: ${file.sha256}`,
          ]),
          ...originals.flatMap((original) => [
            literal(original.originalName),
            `원본 비교: ${original.comparison} / ${original.extraction}`,
          ]),
        ].join("\n\n"),
        "utf8",
      ),
    );
    const metadataBytes = [...files]
      .filter(([path]) => !path.startsWith("originals/"))
      .reduce((sum, [, bytes]) => sum + bytes.length, 0);
    if (metadataBytes > visitPackageLimits.metadataBytes) fail("PACKAGE_METADATA_LIMIT", 413);
    assertCurrent();
    const zip = new JSZip();
    for (const [path, buffer] of files)
      zip.file(path, buffer, { createFolders: false, date: new Date("2000-01-01T00:00:00Z") });
    const buffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "STORE",
      platform: "DOS",
      comment: "DRAFT local visit preparation; no agency verification.",
    });
    if (buffer.length > visitPackageLimits.zipBytes) fail("PACKAGE_ZIP_LIMIT", 413);
    for (const saved of originals) {
      assertCurrent();
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
    assertCurrent();
    return { buffer, fileName: VISIT_PACKAGE_DOWNLOAD_NAME, manifest };
  } finally {
    job.active = false;
  }
}
