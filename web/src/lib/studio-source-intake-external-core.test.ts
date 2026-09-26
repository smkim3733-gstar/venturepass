import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SourceDocument } from "./studio-schema";
import {
  buildExternalIntakeApproval,
  buildExternalIntakeAttempt,
  currentExternalIntakeAttempt,
  unknownExternalIntakeAttempt,
  assertExternalIntakeResultBinding,
  externalIntakeNeedsDuplicateAcknowledgement,
  externalIntakeRequestDigest,
  externalIntakeApprovalSha,
  type ExternalIntakeItemState,
} from "./studio-source-intake-external-core";
import {
  runExternalSourceIntakeSchema,
  sourceIntakeExternalConfiguration,
  sourceIntakeExternalApprovalSchema,
  sourceIntakeExternalOutcomeSchema,
  type RunExternalSourceIntakeCommand,
} from "./studio-source-intake-external-types";
vi.mock("server-only", () => ({}));
const now = "2026-09-25T12:00:00.000Z";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const buffer = Buffer.from("%PDF-1.7\nsynthetic only");
  const source: SourceDocument = {
    id: randomUUID(),
    name: "합성 원본",
    originalName: "fixture.pdf",
    mimeType: "application/pdf",
    kind: "other",
    text: "",
    extraction: "pending",
    warnings: [],
    createdAt: now,
    updatedAt: now,
  };
  const original = { source, buffer, sha256: hash(buffer) };
  const company = { id: randomUUID(), revision: 4, sources: [source] };
  const item: ExternalIntakeItemState = {
    id: randomUUID(),
    sourceId: source.id,
    version: 3,
    original: {
      originalName: source.originalName!,
      mimeType: source.mimeType,
      sizeBytes: buffer.length,
      sha256: original.sha256,
      sourceUpdatedAt: now,
    },
    phase: "original_stored",
    attempts: [],
    requests: [],
    result: null,
    adoption: null,
  };
  const configuration = sourceIntakeExternalConfiguration(
    "ai-document",
    "synthetic-document-model",
  );
  const approval = buildExternalIntakeApproval(company, item, configuration, original);
  const input: RunExternalSourceIntakeCommand = {
    action: "run-external",
    revision: company.revision,
    clientRequestId: randomUUID(),
    itemId: item.id,
    expectedItemVersion: item.version,
    approval,
    approved: true,
    acknowledgePossibleDuplicate: false,
  };
  const generated = { id: randomUUID(), startedAt: now };
  const build = (raw = input) =>
    buildExternalIntakeAttempt(company, item, raw, configuration, original, generated);
  const start = () => {
    const attempt = build();
    item.attempts.push(attempt);
    item.requests.push({
      action: "run-external",
      clientRequestId: input.clientRequestId,
      inputDigest: externalIntakeRequestDigest(input),
    });
    item.version++;
    item.phase = "requesting_external";
    company.revision++;
    const binding = {
      revision: company.revision,
      itemId: item.id,
      itemVersion: item.version,
      attemptId: attempt.id,
    };
    return { attempt, binding };
  };
  return { company, item, original, configuration, approval, input, generated, build, start };
}
describe("명시 외부 판독 승인과 전송 전 저장 계약", () => {
  it("진행 이력의 승인과 자체 해시가 함께 바뀌어도 최초 요청 영수증 불일치는 거부한다", () => {
    const f = fixture(),
      { attempt } = f.start();
    attempt.externalApproval = { ...attempt.externalApproval, model: "changed-model" };
    attempt.approvalSha256 = externalIntakeApprovalSha(attempt.externalApproval);
    expect(() => currentExternalIntakeAttempt(f.item)).toThrow();
    expect(() => unknownExternalIntakeAttempt(f.item, now)).toThrow();
  });
  it("준비·시도 builder는 공급자 호출/회사 변경 없이 exact 원본·목적·설정을 묶는다", () => {
    const f = fixture(),
      before = JSON.stringify({ company: f.company, item: f.item });
    const attempt = f.build();
    expect(attempt).toMatchObject({
      status: "running",
      externalRequestStarted: true,
      externalApproval: f.approval,
      originalSha256: f.original.sha256,
      finishedAt: null,
      resultId: null,
      clientRequestId: f.input.clientRequestId,
    });
    expect(f.approval).toMatchObject({
      provider: "openai",
      destination: "https://api.openai.com/v1/responses",
      purpose: "document-text-extraction",
      version: 1,
    });
    expect(JSON.stringify({ company: f.company, item: f.item })).toBe(before);
    expect(JSON.stringify(attempt)).not.toContain(f.original.buffer.toString());
    expect(Object.keys(f.approval)).not.toContain("buffer");
  });
  it.each([
    "caseId",
    "itemId",
    "sourceId",
    "originalSha256",
    "originalName",
    "mimeType",
    "model",
    "sourceUpdatedAt",
    "sizeBytes",
  ] as const)("승인 %s 변경은 새 시도 전 거부한다", (key) => {
    const f = fixture();
    const values = {
      caseId: randomUUID(),
      itemId: randomUUID(),
      sourceId: randomUUID(),
      originalSha256: "b".repeat(64),
      originalName: "other.pdf",
      mimeType: "application/octet-stream",
      model: "other-model",
      sourceUpdatedAt: "2026-09-24T12:00:00.000Z",
      sizeBytes: f.approval.sizeBytes + 1,
    };
    expect(() =>
      f.build({ ...f.input, approval: { ...f.approval, [key]: values[key] } }),
    ).toThrow();
    expect(f.item.attempts).toEqual([]);
  });
  it.each([
    { provider: "other" },
    { destination: "https://external.invalid/v1/responses" },
    { destination: "https://api.openai.com/v1/audio/transcriptions" },
    { purpose: "audio-transcription" },
    { model: "secret\nkey" },
    { apiKey: "NOT_A_REAL_KEY" },
  ])("고정 대상·방식 불일치 및 비밀 필드 주입을 거부한다: %o", (change) => {
    expect(
      sourceIntakeExternalApprovalSchema.safeParse({ ...fixture().approval, ...change }).success,
    ).toBe(false);
  });
  it.each([
    { approved: false },
    { acknowledgePossibleDuplicate: undefined },
    { expectedItemVersion: 999 },
    { itemId: randomUUID() },
    { revision: -1 },
    { unapprovedRetry: true },
  ])("엄격 명시 요청 검사: %o", (change) => {
    expect(runExternalSourceIntakeSchema.safeParse({ ...fixture().input, ...change }).success).toBe(
      false,
    );
  });
  it("회사 revision/접수 버전·현재 모델이 달라지면 전송 전 승인 재검토가 필요하다", () => {
    const f = fixture();
    expect(() => f.build({ ...f.input, revision: 3 })).toThrow();
    f.item.version++;
    expect(() => f.build()).toThrow();
    f.item.version--;
    expect(() =>
      buildExternalIntakeAttempt(
        f.company,
        f.item,
        f.input,
        sourceIntakeExternalConfiguration("ai-document", "changed-model"),
        f.original,
        f.generated,
      ),
    ).toThrow();
  });
  it("서버 source 중복/본문 채택/원본 같은 크기 변경과 거짓 hash는 승인을 만들지 않는다", () => {
    const f = fixture();
    f.company.sources.push(f.company.sources[0]);
    expect(() => f.build()).toThrow();
    f.company.sources.pop();
    f.original.source.text = "이전 수동 본문";
    expect(() => f.build()).toThrow();
    f.original.source.text = "";
    const bytes = Buffer.from(f.original.buffer);
    bytes[bytes.length - 1] ^= 1;
    expect(() =>
      buildExternalIntakeApproval(f.company, f.item, f.configuration, {
        ...f.original,
        buffer: bytes,
      }),
    ).toThrow();
    expect(() =>
      buildExternalIntakeApproval(f.company, f.item, f.configuration, {
        ...f.original,
        buffer: bytes,
        sha256: hash(bytes),
      }),
    ).toThrow();
  });
  it.each([
    "awaiting_original",
    "storing_original",
    "extracting_local",
    "awaiting_review",
    "adopted",
    "cancelled",
    "requesting_external",
  ])("%s 단계에서 새 외부 시도를 만들지 않는다", (phase) => {
    const f = fixture();
    f.item.phase = phase;
    expect(() => f.build()).toThrow();
    expect(f.item.attempts).toHaveLength(0);
  });
  it("기존 판독 결과 본문이 남아 있으면 외부 재요청으로 덮지 않는다", () => {
    const f = fixture();
    f.item.result = { content: { kind: "plain", text: "보관 결과" } };
    expect(() => f.build()).toThrow(
      expect.objectContaining({ code: "INTAKE_EXTERNAL_PHASE_INVALID" }),
    );
  });
  it("중단 시도는 unknown 이력으로 보존하며 새 승인과 중복 가능성 확인 모두 필요하다", () => {
    const f = fixture(),
      { attempt } = f.start();
    const previous = JSON.stringify(attempt),
      unknown = unknownExternalIntakeAttempt(f.item, "2026-09-25T12:01:00.000Z");
    expect(JSON.stringify(attempt)).toBe(previous);
    expect(unknown).toMatchObject({
      id: attempt.id,
      status: "unknown",
      externalRequestStarted: true,
      code: "INTAKE_EXTERNAL_RESULT_UNKNOWN",
      resultId: null,
    });
    f.item.attempts[0] = unknown;
    f.item.phase = "external_result_unknown";
    f.item.version++;
    f.company.revision++;
    expect(externalIntakeNeedsDuplicateAcknowledgement(f.item)).toBe(true);
    const approval = buildExternalIntakeApproval(f.company, f.item, f.configuration, f.original);
    const next = {
      ...f.input,
      revision: f.company.revision,
      clientRequestId: randomUUID(),
      expectedItemVersion: f.item.version,
      approval,
    };
    expect(() =>
      buildExternalIntakeAttempt(f.company, f.item, next, f.configuration, f.original, {
        id: randomUUID(),
        startedAt: now,
      }),
    ).toThrow(expect.objectContaining({ code: "INTAKE_EXTERNAL_DUPLICATE_ACK_REQUIRED" }));
    const second = buildExternalIntakeAttempt(
      f.company,
      f.item,
      { ...next, acknowledgePossibleDuplicate: true },
      f.configuration,
      f.original,
      { id: randomUUID(), startedAt: now },
    );
    expect(second.id).not.toBe(attempt.id);
    expect(f.item.attempts[0]).toEqual(unknown);
    expect(() => currentExternalIntakeAttempt(f.item)).toThrow();
  });
  it("같은 nonce의 전송시도 builder 재호출과 완료 후 복구는 차단한다", () => {
    const f = fixture(),
      { attempt } = f.start();
    expect(() => f.build()).toThrow();
    f.item.phase = "external_result_unknown";
    f.item.attempts[0] = { ...attempt, status: "unknown" };
    const approval = buildExternalIntakeApproval(f.company, f.item, f.configuration, f.original);
    expect(() =>
      buildExternalIntakeAttempt(
        f.company,
        f.item,
        {
          ...f.input,
          revision: f.company.revision,
          expectedItemVersion: f.item.version,
          approval,
          acknowledgePossibleDuplicate: true,
        },
        f.configuration,
        f.original,
        { id: randomUUID(), startedAt: now },
      ),
    ).toThrow();
    expect(() => unknownExternalIntakeAttempt(f.item, now)).toThrow();
  });
  it("완료 경계에서 exact 회사/시도/버전과 원본을 다시 대조한다", () => {
    const f = fixture(),
      { attempt, binding } = f.start();
    expect(assertExternalIntakeResultBinding(f.company, f.item, binding, f.original)).toEqual(
      attempt,
    );
    for (const altered of [
      { revision: binding.revision + 1 },
      { itemVersion: binding.itemVersion + 1 },
      { attemptId: randomUUID() },
      { itemId: randomUUID() },
    ])
      expect(() =>
        assertExternalIntakeResultBinding(
          f.company,
          f.item,
          { ...binding, ...altered },
          f.original,
        ),
      ).toThrow();
    f.item.attempts[0].approvalSha256 = "a".repeat(64);
    expect(() =>
      assertExternalIntakeResultBinding(f.company, f.item, binding, f.original),
    ).toThrow();
  });
  it("요청 이후 같은 크기 파일/본문 변경 또는 다른 회사 응답은 저장하지 않는다", () => {
    const f = fixture(),
      { binding } = f.start();
    const changed = Buffer.from(f.original.buffer);
    changed[changed.length - 1] ^= 1;
    expect(() =>
      assertExternalIntakeResultBinding(f.company, f.item, binding, {
        ...f.original,
        buffer: changed,
        sha256: hash(changed),
      }),
    ).toThrow();
    expect(() =>
      assertExternalIntakeResultBinding(
        { ...f.company, id: randomUUID() },
        f.item,
        binding,
        f.original,
      ),
    ).toThrow();
    f.original.source.updatedAt = "2026-09-25T12:02:00.000Z";
    expect(() =>
      assertExternalIntakeResultBinding(f.company, f.item, binding, f.original),
    ).toThrow();
  });
  it("이력 한도는 기존 시도를 삭제하며 우회하지 않는다", () => {
    const f = fixture();
    f.item.attempts = Array.from({ length: 10 }, () => ({
      id: randomUUID(),
      engine: "local-document",
      status: "failed",
      externalRequestStarted: false,
    }));
    expect(() => f.build()).toThrow(expect.objectContaining({ code: "INTAKE_EXTERNAL_LIMIT" }));
    expect(f.item.attempts).toHaveLength(10);
  });
  it("마지막 요청 영수증은 중단된 외부 시도의 명시 복구를 위해 남긴다", () => {
    const f = fixture();
    f.item.requests = Array.from({ length: 19 }, () => ({
      action: "resume",
      clientRequestId: randomUUID(),
      inputDigest: "a".repeat(64),
    }));
    expect(() => f.build()).toThrow(expect.objectContaining({ code: "INTAKE_EXTERNAL_LIMIT" }));
    expect(f.item.requests).toHaveLength(19);
  });
  it("재시도 digest는 revision만 제외하고 승인·중복확인·nonce를 바인딩한다", () => {
    const { input } = fixture();
    expect(externalIntakeRequestDigest(input)).toBe(
      externalIntakeRequestDigest({ ...input, revision: input.revision + 1 }),
    );
    expect(externalIntakeRequestDigest(input)).not.toBe(
      externalIntakeRequestDigest({ ...input, acknowledgePossibleDuplicate: true }),
    );
    expect(externalIntakeRequestDigest(input)).not.toBe(
      externalIntakeRequestDigest({ ...input, clientRequestId: randomUUID() }),
    );
  });
  it("미검토 plain 결과만 허용하고 공급자 오류·시간·페이지를 사실처럼 저장하지 않는다", () => {
    expect(
      sourceIntakeExternalOutcomeSchema.safeParse({
        status: "completed",
        content: { kind: "plain", text: "합성 결과" },
        warnings: [],
      }).success,
    ).toBe(true);
    for (const value of [
      { status: "completed", content: { kind: "plain", text: " " }, warnings: [] },
      {
        status: "completed",
        content: { kind: "pages", pages: [{ pageNumber: 1, text: "생성 페이지" }] },
        warnings: [],
      },
      {
        status: "completed",
        content: { kind: "plain", text: "결과" },
        warnings: [],
        timestamps: [0, 10],
      },
      { status: "failed", code: "not_sent" },
      { status: "unknown", code: "raw provider error body" },
    ])
      expect(sourceIntakeExternalOutcomeSchema.safeParse(value).success).toBe(false);
  });
});
