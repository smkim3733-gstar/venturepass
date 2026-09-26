import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caseSchema, emptyProfile, type SourceDocument, type StudioCase } from "./studio-schema";
import { StudioStore } from "./studio-storage";
import {
  buildSourceSuggestionAdoption,
  buildSourceSuggestions,
  previewSourceSuggestions,
  sourceSuggestionInputDigest,
  assertSourceSuggestionCapacity,
} from "./studio-source-suggestion";
import {
  sourceSuggestionAdoptionInputSchema,
  sourceSuggestionPreviewInputSchema,
  type SourceSuggestionAdoptionInput,
  type SourceSuggestionsPreview,
  type SourceSuggestionTarget,
} from "./studio-source-suggestion-types";
import { buildSourceLocationMetadata } from "./studio-source-location";
import {
  newSourceIntakeBatch,
  retainIntakeLocations,
  intakeLocationBytes,
} from "./studio-source-intake";
import { sourceIntakeResultText } from "./studio-source-intake-types";
import { sourceLocationLimits } from "./studio-source-location-types";
import { withVentureInputCompanyLock } from "./venturein-input-lock";

const now = "2026-09-25T00:00:00.000Z",
  sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
function source(text: string, overrides: Partial<SourceDocument> = {}): SourceDocument {
  return {
    id: randomUUID(),
    name: "합성 문서",
    kind: "other",
    text,
    originalName: null,
    mimeType: null,
    extraction: "manual",
    warnings: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
function fixture(text: string): StudioCase {
  return caseSchema.parse({
    id: randomUUID(),
    profile: { ...emptyProfile(), companyName: "기존 기업", businessNumber: "123-45-67890" },
    sources: [source(text)],
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: "preparing",
    revision: 0,
    createdAt: now,
    updatedAt: now,
  });
}
const noOriginal = () => {
  throw new Error("Unexpected original read");
};
function preview(company: StudioCase) {
  return buildSourceSuggestions(
    company,
    {
      revision: company.revision,
      sourceId: company.sources[0].id,
      basis: { kind: "source-text", sourceUpdatedAt: company.sources[0].updatedAt },
    },
    noOriginal,
  );
}
function selection(
  value: SourceSuggestionsPreview,
  targets: SourceSuggestionTarget[],
): SourceSuggestionAdoptionInput {
  return {
    binding: value.binding,
    selections: targets.map((target) => {
      const candidate = value.candidates.find((entry) => entry.target === target)!;
      return { candidateId: candidate.id, target, expectedCurrentValue: candidate.currentValue };
    }),
    reviewed: true,
  };
}
function metadata(input: SourceSuggestionAdoptionInput) {
  return {
    id: randomUUID(),
    clientRequestId: randomUUID(),
    inputDigest: sourceSuggestionInputDigest(input),
    recordedAt: now,
  };
}
function intake(company: StudioCase, text: string) {
  const source = company.sources[0];
  source.text = "";
  source.extraction = "pending";
  source.originalName = "fixture.txt";
  source.mimeType = "text/plain";
  const item = newSourceIntakeBatch({
    action: "create",
    revision: 0,
    clientRequestId: randomUUID(),
    files: [
      { clientFileId: randomUUID(), originalName: "fixture.txt", sizeBytes: 3, kind: "other" },
    ],
  })[0];
  item.sourceId = source.id;
  item.phase = "awaiting_review";
  item.original = {
    originalName: source.originalName,
    mimeType: source.mimeType,
    sizeBytes: 3,
    sha256: sha("abc"),
    sourceUpdatedAt: source.updatedAt,
  };
  item.result = {
    id: randomUUID(),
    attemptId: randomUUID(),
    engine: "local-document",
    generatedAt: now,
    originalSha256: sha("abc"),
    sourceUpdatedAt: source.updatedAt,
    textSha256: sha(text),
    content: { kind: "plain", text },
    warnings: [],
    reviewStatus: "unreviewed",
    discardedAt: null,
  };
  company.sourceIntakes.push(item);
  const input = {
    revision: company.revision,
    sourceId: source.id,
    basis: { kind: "intake-result" as const, itemId: item.id, resultId: item.result.id },
  };
  const read = () => ({ source, buffer: Buffer.from("abc"), sha256: sha("abc") });
  return { item, source, input, read };
}
describe("explicit local source suggestions", () => {
  it("recognizes only labelled values and preserves exact UTF-16/CRLF spans", () => {
    const text =
      "😀\r\n  재무상태표\r\n상호   (법인명): 합성 법인\r\n사업자등록번호: 123-45-67890\r\n법인설립일: 2020년 2월 29일\r\n업종: 광고대행업\r\n납입자본금: 1,000,000원\r\n결산월: 12월";
    const result = preview(fixture(text));
    expect(result.candidates).toHaveLength(7);
    expect(result.identity.status).toBe("matched");
    expect(
      Object.fromEntries(result.candidates.map((entry) => [entry.target, entry.value])),
    ).toEqual({
      sourceKind: "finance",
      companyName: "합성 법인",
      businessNumber: "1234567890",
      foundedOn: "2020-02-29",
      industry: "광고대행업",
      paidInCapital: "1000000",
      closingMonth: "12",
    });
    for (const candidate of result.candidates) {
      expect(text.slice(candidate.start, candidate.end)).toBe(candidate.quote);
      expect(candidate.coordinate).toBeNull();
      expect(candidate.lineStart).toBe(candidate.lineEnd);
    }
    expect(result.candidates[0].start).toBe(6);
  });
  it.each([
    "개업일: 2020-01-01",
    "개업연월일: 2020-01-01",
    "설립/개업일: 2020-01-01",
    "설립일: 2023-02-29",
    "설립일: 2020/01/01",
  ])("does not turn ambiguous dates into foundation: %s", (text) => {
    const result = preview(fixture(text));
    expect(result.candidates).toEqual([]);
    expect(result.unresolved[0].code).toBe("AMBIGUOUS_DATE");
  });
  it.each([
    "납입자본금: 100",
    "납입자본금: 100천원",
    "자본금: 1억원",
    "자본금: 1/2원",
    "자본금: △100원",
    "자본금: (100)원",
    "자본금: 01원",
    "자본금: 1,00원",
    "자본금: 9007199254740992원",
    "자본총계: 100원",
    "매출액: 100원",
  ])("does not infer capital: %s", (text) => {
    expect(preview(fixture(text)).candidates).toEqual([]);
  });
  it("supports explicit won label and zero, never code conversions", () => {
    const result = preview(
      fixture("납입자본금(원): 0\n주업종: 71399\n업종: KSIC 71399\n결산월: 13월"),
    );
    expect(result.candidates.map((entry) => entry.value)).toEqual(["0"]);
    expect(result.unresolved).toHaveLength(3);
  });
  it("filename, arbitrary prose and manual page markers never supply facts or coordinates", () => {
    const company = fixture(
      "[페이지 99]\n문서에서 회사명과 자본금은 확인 필요\n설립일처럼 보이는 2020-01-01",
    );
    company.sources[0].name = "회사명_자동입력_특허증";
    expect(preview(company).candidates).toEqual([]);
    company.sources[0].text += "\n회사명: 명시값";
    expect(preview(company).candidates[0].coordinate).toBeNull();
  });
  it("keeps duplicate/conflicting occurrences distinct and forbids two selections per target", () => {
    const result = preview(fixture("회사명: 첫 값\n회사명: 둘째 값\n회사명: 첫 값"));
    expect(result.candidates).toHaveLength(3);
    expect(new Set(result.candidates.map((entry) => entry.id)).size).toBe(3);
    const input = selection(result, ["companyName"]);
    input.selections.push({ ...input.selections[0], candidateId: result.candidates[1].id });
    expect(sourceSuggestionAdoptionInputSchema.safeParse(input).success).toBe(false);
  });
  it("different company number blocks profile, while registered-text kind remains selectable", () => {
    const company = fixture("재무상태표\n사업자등록번호: 987-65-43210\n회사명: 다른 기업"),
      result = preview(company);
    expect(result.identity.status).toBe("mismatch");
    expect(result.profileAllowed).toBe(false);
    const forbidden = selection(result, ["companyName"]);
    expect(() =>
      buildSourceSuggestionAdoption(company, forbidden, metadata(forbidden), noOriginal),
    ).toThrow(expect.objectContaining({ code: "SUGGESTION_COMPANY_MISMATCH" }));
    const kind = selection(result, ["sourceKind"]);
    expect(
      buildSourceSuggestionAdoption(company, kind, metadata(kind), noOriginal).sourceKind,
    ).toBe("finance");
  });
  it("number with trailing note is not a value candidate but still prevents foreign-company adoption", () => {
    const result = preview(fixture("사업자등록번호: 987-65-43210 (별도사업자)\n회사명: 다른 기업"));
    expect(result.identity.status).toBe("mismatch");
    expect(result.candidates.some((entry) => entry.target === "businessNumber")).toBe(false);
  });
  it("missing number is explicitly unverified, without approval promotion", () => {
    const company = fixture("회사명: 제안 기업"),
      result = preview(company),
      input = selection(result, ["companyName"]);
    const built = buildSourceSuggestionAdoption(company, input, metadata(input), noOriginal);
    expect(result.identity.status).toBe("unverified");
    expect(built.receipt.origin).toBe("manual-local-suggestion");
    expect(company.profile.companyName).toBe("기존 기업");
  });
  it("rejects changed old field, text range binding, rule version and extra client value", () => {
    const company = fixture("회사명: 제안 기업"),
      result = preview(company),
      input = selection(result, ["companyName"]);
    company.profile.companyName = "다른 창 수정";
    expect(() =>
      buildSourceSuggestionAdoption(company, input, metadata(input), noOriginal),
    ).toThrow(expect.objectContaining({ code: "SUGGESTION_STALE" }));
    company.profile.companyName = "기존 기업";
    company.sources[0].text = "회사명: 다른 제안";
    expect(() =>
      buildSourceSuggestionAdoption(company, input, metadata(input), noOriginal),
    ).toThrow(expect.objectContaining({ code: "SUGGESTION_STALE" }));
    expect(
      sourceSuggestionAdoptionInputSchema.safeParse({
        ...input,
        binding: { ...input.binding, ruleVersion: "untrusted" },
      }).success,
    ).toBe(false);
    expect(
      sourceSuggestionAdoptionInputSchema.safeParse({
        ...input,
        selections: [{ ...input.selections[0], value: "injected" }],
      }).success,
    ).toBe(false);
    expect(
      sourceSuggestionPreviewInputSchema.safeParse({
        revision: 0,
        sourceId: randomUUID(),
        basis: { kind: "source-text", sourceUpdatedAt: now },
        text: "injected",
      }).success,
    ).toBe(false);
  });
  it("uses exact stored result locations, including actual spreadsheet cells", () => {
    const company = fixture(""),
      text = "[시트: 제안]\n행 7: C7=회사명: 합성 기업 | E7=기타",
      value = intake(company, text);
    const start = text.indexOf("회사명:"),
      end = text.indexOf(" | E7");
    value.item.result!.locations = buildSourceLocationMetadata(text, [
      {
        start,
        end,
        coordinate: {
          kind: "spreadsheet-cell",
          sheetIndex: 1,
          sheetName: "제안",
          row: 7,
          column: 3,
          address: "C7",
        },
      },
    ]);
    const result = buildSourceSuggestions(company, value.input, value.read);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      value: "합성 기업",
      start,
      end,
      coordinate: { kind: "spreadsheet-cell", address: "C7" },
    });
    expect(result.binding.locationsSha256).toMatch(/^[a-f0-9]{64}$/);
    value.item.result!.locations!.segments[0].coordinate = {
      kind: "spreadsheet-cell",
      sheetIndex: 1,
      sheetName: "제안",
      row: 8,
      column: 3,
      address: "C8",
    };
    const chosen = selection(result, ["companyName"]);
    expect(() =>
      buildSourceSuggestionAdoption(company, chosen, metadata(chosen), value.read),
    ).toThrow(expect.objectContaining({ code: "SUGGESTION_STALE" }));
  });
  it("pending result profile choices do not alter its source or enable kind adoption", () => {
    const company = fixture(""),
      value = intake(company, "재무상태표\n회사명: 합성 기업"),
      result = buildSourceSuggestions(company, value.input, value.read);
    const profileInput = selection(result, ["companyName"]),
      before = JSON.stringify(company.sourceIntakes);
    const built = buildSourceSuggestionAdoption(
      company,
      profileInput,
      metadata(profileInput),
      value.read,
    );
    expect(built.profile.companyName).toBe("합성 기업");
    expect(company.sources[0].text).toBe("");
    expect(JSON.stringify(company.sourceIntakes)).toBe(before);
    const kind = selection(result, ["sourceKind"]);
    expect(() => buildSourceSuggestionAdoption(company, kind, metadata(kind), value.read)).toThrow(
      expect.objectContaining({ code: "SUGGESTION_KIND_REQUIRES_BODY" }),
    );
    expect(result.blockedTargets[0].target).toBe("sourceKind");
  });
  it("rejects stale result text hash and malformed structural metadata", () => {
    const company = fixture(""),
      value = intake(company, "회사명: 합성 기업");
    value.item.result!.textSha256 = "a".repeat(64);
    expect(() => buildSourceSuggestions(company, value.input, value.read)).toThrow(
      expect.objectContaining({ code: "SUGGESTION_STALE" }),
    );
    value.item.result!.textSha256 = sha("회사명: 합성 기업");
    value.item.result!.locations = {
      version: 1,
      textSha256: "b".repeat(64),
      coverage: "complete",
      segments: [],
    };
    expect(() => buildSourceSuggestions(company, value.input, value.read)).toThrow(
      expect.objectContaining({ code: "SUGGESTION_STALE" }),
    );
  });
  it("original is rechecked without exposing bytes, and current company changes invalidate preview", () => {
    const company = fixture("회사명: 합성 기업");
    company.sources[0].originalName = "fixture.txt";
    let calls = 0;
    expect(() =>
      buildSourceSuggestions(
        company,
        {
          revision: 0,
          sourceId: company.sources[0].id,
          basis: { kind: "source-text", sourceUpdatedAt: now },
        },
        () => ({
          source: company.sources[0],
          buffer: Buffer.from("abc"),
          sha256: sha(++calls === 1 ? "abc" : "xyz"),
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "SUGGESTION_ORIGINAL_CHANGED" }));
    company.sources[0].originalName = null;
    const changed = structuredClone(company);
    changed.revision++;
    const getter = vi.fn().mockReturnValueOnce(company).mockReturnValueOnce(changed);
    expect(() =>
      previewSourceSuggestions({ get: getter, originalForVentureInput: noOriginal }, company.id, {
        revision: 0,
        sourceId: company.sources[0].id,
        basis: { kind: "source-text", sourceUpdatedAt: now },
      }),
    ).toThrow(expect.objectContaining({ code: "SUGGESTION_STALE" }));
  });
  it("rejects invalid final profile atomically rather than adjusting application dates", () => {
    const company = fixture("회사명: 새 기업\n설립일: 2030-01-01");
    company.profile.applicationDate = "2026-09-25";
    const result = preview(company),
      input = selection(result, ["companyName", "foundedOn"]);
    expect(() =>
      buildSourceSuggestionAdoption(company, input, metadata(input), noOriginal),
    ).toThrow();
    expect(company.profile.companyName).toBe("기존 기업");
  });
  it("bounds receipt count and payload without truncating history", () => {
    const company = fixture("회사명: 제안 기업"),
      input = selection(preview(company), ["companyName"]),
      record = buildSourceSuggestionAdoption(company, input, metadata(input), noOriginal).receipt;
    expect(() => assertSourceSuggestionCapacity(Array.from({ length: 201 }, () => record))).toThrow(
      expect.objectContaining({ code: "SUGGESTION_LIMIT" }),
    );
    expect(() =>
      assertSourceSuggestionCapacity(
        Array.from({ length: 180 }, () => ({
          ...record,
          selections: [{ ...record.selections[0], quote: "x".repeat(1000) }],
        })),
      ),
    ).toThrow(expect.objectContaining({ code: "SUGGESTION_LIMIT" }));
  });
  it("optional locations preserve legacy shape and fit separate aggregate cap without changing text", () => {
    const text = "회사명: 보존",
      input = buildSourceLocationMetadata(text, [
        { start: 0, end: text.length, coordinate: { kind: "pdf-page", pageNumber: 1 } },
      ]);
    expect(retainIntakeLocations([], text, undefined)).toEqual({ limited: false });
    expect(retainIntakeLocations([], text, input)).toEqual({ locations: input, limited: false });
    const record = fixture(""),
      value = intake(record, text);
    value.item.result!.locations = {
      ...input,
      segments: Array.from({ length: 16000 }, (_, index) => ({
        start: index,
        end: index + 1,
        coordinate: {
          kind: "spreadsheet-cell",
          sheetIndex: 1,
          sheetName: "x".repeat(100),
          row: index + 1,
          column: 1,
          address: `A${index + 1}`,
        },
      })),
    };
    expect(intakeLocationBytes(record.sourceIntakes)).toBeGreaterThan(
      sourceLocationLimits.retainedBytes,
    );
    expect(retainIntakeLocations(record.sourceIntakes, text, input)).toEqual({ limited: true });
    expect(sourceIntakeResultText(value.item.result!.content!)).toBe(text);
  });
});

describe("source suggestion durable adoption", { timeout: 60_000 }, () => {
  let directory: string, store: StudioStore, company: StudioCase;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "venture-suggestion-store-"));
    store = new StudioStore(directory);
    company = store.create({
      ...emptyProfile(),
      companyName: "기존 기업",
      businessNumber: "1234567890",
    });
  });
  afterEach(() => {
    store.close();
    const boundary = relative(resolve(tmpdir()), resolve(directory));
    if (
      !boundary.startsWith("venture-suggestion-store-") ||
      boundary.startsWith("..") ||
      isAbsolute(boundary)
    )
      throw new Error("Unsafe fixture cleanup");
    rmSync(directory, { recursive: true, force: true });
  });
  function add(
    text = "재무상태표\n회사명: 제안 기업\n사업자등록번호: 123-45-67890",
    original = false,
  ) {
    const value = source(
      text,
      original ? { originalName: "fixture.txt", mimeType: "text/plain", extraction: "local" } : {},
    );
    company = original
      ? store.addUpload(company.id, company.revision, value, Buffer.from("abc"))
      : store.mutate(
          company.id,
          { action: "source", revision: company.revision, source: value },
          () => [],
        );
    return company.sources.at(-1)!;
  }
  function read(sourceId: string) {
    const current = store.get(company.id);
    return previewSourceSuggestions(store, company.id, {
      revision: current.revision,
      sourceId,
      basis: {
        kind: "source-text",
        sourceUpdatedAt: current.sources.find((source) => source.id === sourceId)!.updatedAt,
      },
    });
  }
  it("preview is read-only; explicit adoption invalidates evidence and survives restart/replay", () => {
    const source = add();
    company = store.saveAnalysis(
      company.id,
      company.revision,
      { summary: "기존 분석", facts: [], candidates: [], questions: [], warnings: [] },
      "assisted",
    );
    const before = JSON.stringify(store.get(company.id)),
      result = read(source.id);
    expect(JSON.stringify(store.get(company.id))).toBe(before);
    const input = {
      action: "adopt-source-suggestions" as const,
      revision: company.revision,
      clientRequestId: randomUUID(),
      ...selection(result, ["companyName", "sourceKind"]),
    };
    const changed = store.mutate(company.id, input, () => []);
    expect(changed.profile.companyName).toBe("제안 기업");
    expect(changed.sources[0].kind).toBe("finance");
    expect(changed.sources[0].text).toBe(source.text);
    expect(changed.analysis).toBeNull();
    expect(changed.sourceSuggestionAdoptions[0]).toMatchObject({
      profileChanged: true,
      sourceKindChanged: true,
      sourceUpdatedAtAfter: changed.sources[0].updatedAt,
    });
    expect(changed.sources[0].updatedAt > source.updatedAt).toBe(true);
    store.close();
    store = new StudioStore(directory);
    expect(store.mutate(company.id, input, () => [])).toEqual(changed);
    expect(() =>
      store.mutate(
        company.id,
        { ...input, selections: [{ ...input.selections[0], expectedCurrentValue: "변경" }] },
        () => [],
      ),
    ).toThrow(expect.objectContaining({ code: "SUGGESTION_NONCE_CONFLICT" }));
    expect(() =>
      store.mutate(
        company.id,
        { action: "delete-source", revision: changed.revision, sourceId: source.id },
        () => [],
      ),
    ).toThrow(expect.objectContaining({ code: "SUGGESTION_SOURCE_REFERENCED" }));
  });
  it("stale CAS and exact quote changes reject without creating a receipt", () => {
    const source = add(),
      result = read(source.id),
      input = {
        action: "adopt-source-suggestions" as const,
        revision: company.revision,
        clientRequestId: randomUUID(),
        ...selection(result, ["companyName"]),
      };
    company = store.mutate(
      company.id,
      {
        action: "source",
        revision: company.revision,
        source: { ...source, text: "회사명: 새 원문" },
      },
      () => [],
    );
    expect(() => store.mutate(company.id, input, () => [])).toThrow(
      expect.objectContaining({ code: "STALE_REVISION" }),
    );
    expect(() =>
      store.mutate(company.id, { ...input, revision: company.revision }, () => []),
    ).toThrow();
    expect(store.get(company.id).sourceSuggestionAdoptions).toEqual([]);
  });
  it("same-size original changes block both adoption and future agency evidence", () => {
    const source = add(undefined, true),
      result = read(source.id),
      input = {
        action: "adopt-source-suggestions" as const,
        revision: company.revision,
        clientRequestId: randomUUID(),
        ...selection(result, ["companyName"]),
      },
      path = join(directory, "originals", company.id, `${source.id}.bin`);
    writeFileSync(path, "xyz");
    expect(() => store.mutate(company.id, input, () => [])).toThrow(
      expect.objectContaining({ code: "SUGGESTION_STALE" }),
    );
    writeFileSync(path, "abc");
    const saved = store.mutate(company.id, input, () => []);
    const edited = store.mutate(
      company.id,
      {
        action: "source",
        revision: saved.revision,
        source: { ...saved.sources[0], text: `${saved.sources[0].text}\n수동 검토 메모` },
      },
      () => [],
    );
    expect(edited.sources[0].updatedAt).not.toBe(saved.sources[0].updatedAt);
    expect(store.originalForVentureInput(company.id, source.id).buffer.toString()).toBe("abc");
    writeFileSync(path, "xyz");
    expect(() =>
      store.mutate(
        company.id,
        {
          action: "append-agency-record",
          revision: edited.revision,
          clientRequestId: randomUUID(),
          record: {
            kind: "request",
            institution: "가상기관",
            title: "합성 요청",
            body: "원본 연결",
            occurredOn: "",
            note: "",
            dueOn: "",
            dueNote: "",
            sourceIds: [source.id],
          },
        },
        () => [],
      ),
    ).toThrow(expect.objectContaining({ code: "SUGGESTION_ORIGINAL_CHANGED" }));
    expect(readFileSync(path, "utf8")).toBe("xyz");
    expect(store.get(company.id).agencyRecords).toEqual([]);
  });
  it("profile-only result adoption keeps pending text and original/result timestamps unchanged", () => {
    const text = "재무상태표\n회사명: 제안 기업",
      value = source("", {
        originalName: "fixture.txt",
        mimeType: "text/plain",
        extraction: "pending",
      });
    company = store.addUpload(company.id, 0, value, Buffer.from("abc"));
    const prepared = intake(company, text);
    const db = new DatabaseSync(join(directory, "studio.sqlite"));
    db.prepare("UPDATE studio_cases SET body=? WHERE id=?").run(
      JSON.stringify(company),
      company.id,
    );
    db.close();
    const result = previewSourceSuggestions(store, company.id, prepared.input),
      input = {
        action: "adopt-source-suggestions" as const,
        revision: company.revision,
        clientRequestId: randomUUID(),
        ...selection(result, ["companyName"]),
      };
    const old = JSON.stringify(store.get(company.id).sourceIntakes),
      updated = store.mutate(company.id, input, () => []);
    expect(updated.sources[0]).toEqual(company.sources[0]);
    expect(JSON.stringify(updated.sourceIntakes)).toBe(old);
    expect(updated.sources[0]).toMatchObject({ text: "", extraction: "pending" });
    expect(() =>
      store.mutate(
        company.id,
        {
          ...input,
          revision: updated.revision,
          clientRequestId: randomUUID(),
          ...selection(result, ["sourceKind"]),
        },
        () => [],
      ),
    ).toThrow(expect.objectContaining({ code: "SUGGESTION_KIND_REQUIRES_BODY" }));
    const current = store.get(company.id),
      item = current.sourceIntakes[0];
    const adopted = store.adoptSourceIntakeResult(company.id, {
      action: "adopt",
      revision: current.revision,
      clientRequestId: randomUUID(),
      itemId: item.id,
      expectedItemVersion: item.version,
      resultId: item.result!.id,
      sourceUpdatedAt: item.original!.sourceUpdatedAt,
      originalSha256: item.original!.sha256,
      reviewed: true,
      text,
    });
    expect(adopted.company.sources[0].text).toBe(text);
  });
  it("company input lock and foreign source reject before mutations", async () => {
    const source = add(),
      result = read(source.id),
      input = {
        action: "adopt-source-suggestions" as const,
        revision: company.revision,
        clientRequestId: randomUUID(),
        ...selection(result, ["companyName"]),
      };
    await withVentureInputCompanyLock(company.id, async () => {
      expect(() => store.mutate(company.id, input, () => [])).toThrow(
        expect.objectContaining({ code: "INPUT_IN_PROGRESS" }),
      );
    });
    const other = store.create({ ...emptyProfile(), companyName: "다른 기업" });
    expect(() => store.mutate(other.id, { ...input, revision: other.revision }, () => [])).toThrow(
      expect.objectContaining({ code: "SUGGESTION_SOURCE_UNAVAILABLE" }),
    );
  });
});
