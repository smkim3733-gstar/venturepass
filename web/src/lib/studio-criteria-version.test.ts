import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applicationCycleSchema } from "./studio-application-types";
import {
  appendCriteriaVersionInputSchema,
  criteriaCheckedOnSchema,
  criteriaFieldStatus,
  criteriaVersionDetailsSchema,
  criteriaVersionMutationSchema,
  criteriaVersionSchema,
  applicationCriteriaBindingSchema,
  criteriaVersionLimits,
  latestApplicationCriteriaBinding,
  type CriteriaVersionState,
  type AppendCriteriaVersionInput,
  type PinApplicationCriteriaInput,
  type CriteriaVersionDetails,
} from "./studio-criteria-version-types";
import {
  applicationCriteriaContext,
  assertCriteriaVersionCapacity,
  buildApplicationCriteriaBinding,
  buildCriteriaVersion,
  criteriaVersionContentSha,
  criteriaVersionInputDigest,
  isCriteriaVersionReplay,
  renderCriteriaReference,
  buildCriteriaReference,
} from "./studio-criteria-version";

const recordedAt = "2026-09-25T12:00:00.000Z";
function state(): CriteriaVersionState {
  const id = randomUUID();
  return {
    id,
    revision: 1,
    profile: { companyName: "합성 회사", businessNumber: "1234567890" },
    applications: [
      applicationCycleSchema.parse({
        id: randomUUID(),
        clientRequestId: randomUUID(),
        inputDigest: "a".repeat(64),
        recordedAt,
        origin: "manual",
        title: "합성 신규 회차",
        kind: "new",
        plannedOn: "",
        criteriaNote: "기존 메모",
        previousApplicationId: null,
        companyAtCreation: { companyName: "합성 회사", businessNumber: "1234567890" },
      }),
    ],
    applicationEvents: [],
  };
}
function details(): CriteriaVersionDetails {
  return {
    title: "합성 참고 기준",
    versionLabel: "담당자 기록 1",
    applicationPath: "혁신성장 경로라는 담당자 메모",
    checkedOn: "2026-09-25",
    sources: [
      {
        title: "합성 출처",
        url: "https://example.invalid/criteria",
        quote: "합성 원문",
        note: "현행 규정 아님",
      },
    ],
    documents: [
      {
        id: randomUUID(),
        name: "합성 서류",
        appliesTo: "원문에 적힌 대상",
        period: "",
        issueDateCondition: "",
        alternativeCondition: "",
        autoLinkGuidance: "연계 가능 안내일 뿐 수신 결과 없음",
        note: "",
      },
    ],
  };
}
function appendInput(extra: Partial<AppendCriteriaVersionInput> = {}): AppendCriteriaVersionInput {
  return {
    criteriaId: null,
    previousVersionId: null,
    details: details(),
    recordedBy: "합성 담당자",
    reason: "합성 최초 기록",
    ...extra,
  };
}
function server(
  value: CriteriaVersionState,
  action: "append-criteria-version" | "pin-application-criteria",
  input: AppendCriteriaVersionInput | PinApplicationCriteriaInput,
) {
  const clientRequestId = randomUUID();
  return {
    id: randomUUID(),
    clientRequestId,
    inputDigest: criteriaVersionInputDigest({
      action,
      revision: value.revision,
      clientRequestId,
      ...input,
    }),
    recordedAt,
  };
}
function add(value: CriteriaVersionState, input = appendInput()) {
  const entry = buildCriteriaVersion(value, input, server(value, "append-criteria-version", input));
  value.criteriaVersions = [...(value.criteriaVersions ?? []), entry];
  return entry;
}
function pinInput(value: CriteriaVersionState): PinApplicationCriteriaInput {
  const criteria = value.criteriaVersions![0];
  return {
    applicationId: value.applications[0].id,
    applicationMetadataVersionId: value.applications[0].id,
    criteriaVersionId: criteria.id,
    criteriaContentSha256: criteria.contentSha256,
    previousBindingId: null,
    recordedBy: "합성 담당자",
    reason: "정확한 버전 명시 선택",
  };
}
function pin(value: CriteriaVersionState, input = pinInput(value)) {
  const entry = buildApplicationCriteriaBinding(
    value,
    input,
    server(value, "pin-application-criteria", input),
  );
  value.applicationCriteriaBindings = [...(value.applicationCriteriaBindings ?? []), entry];
  return entry;
}

describe("수동 기준·서류 조건의 순수 입력 계약", () => {
  it("공란은 미확인이고 수동 기록은 공식 확인으로 승격되지 않는다", () => {
    const draft = details();
    draft.checkedOn = "";
    draft.applicationPath = "";
    draft.sources = [];
    expect(criteriaVersionDetailsSchema.parse(draft)).toEqual(draft);
    expect(criteriaFieldStatus("")).toBe("unrecorded");
    expect(criteriaFieldStatus("   ")).toBe("unrecorded");
    expect(criteriaFieldStatus("자동연계 가능 안내")).toBe("recorded-unverified");
    const company = state(),
      entry = add(company, appendInput({ details: draft }));
    expect(entry).toMatchObject({ officialVerification: "unverified", origin: "manual" });
    expect(entry.details.documents[0].issueDateCondition).toBe("");
    expect(entry.details.documents[0]).not.toHaveProperty("received");
  });
  it.each(["2025-02-29", "2026-13-01", "2026-04-31", "0000-01-01", "2026/09/25"])(
    "잘못된 실제 날짜 %s를 거부한다",
    (date) => {
      expect(criteriaCheckedOnSchema.safeParse(date).success).toBe(false);
    },
  );
  it("윤년 날짜와 공란을 허용한다", () => {
    expect(criteriaCheckedOnSchema.parse("2024-02-29")).toBe("2024-02-29");
    expect(criteriaCheckedOnSchema.parse("")).toBe("");
  });
  it.each([
    "javascript:alert(1)",
    "file:///private",
    "ftp://example.invalid/a",
    "https://user:password@example.invalid/a",
    "not a url",
  ])("출처 URL %s를 거부하며 자동 fetch 기능은 없다", (url) => {
    const value = details();
    value.sources[0].url = url;
    expect(criteriaVersionDetailsSchema.safeParse(value).success).toBe(false);
  });
  it("출처 URL 공란/http(s)만 허용한다", () => {
    for (const url of ["", "http://example.invalid/a", "https://example.invalid/a"]) {
      const value = details();
      value.sources[0].url = url;
      expect(criteriaVersionDetailsSchema.safeParse(value).success).toBe(true);
    }
  });
  it("root/이전 버전 쌍·중복 서류 ID·서버 필드 주입을 거부한다", () => {
    expect(
      appendCriteriaVersionInputSchema.safeParse(appendInput({ criteriaId: randomUUID() })).success,
    ).toBe(false);
    const value = details();
    value.documents.push(value.documents[0]);
    expect(criteriaVersionDetailsSchema.safeParse(value).success).toBe(false);
    const mutation = {
      action: "append-criteria-version",
      revision: 1,
      clientRequestId: randomUUID(),
      ...appendInput(),
    };
    for (const extra of [
      { officialVerification: "verified" },
      { contentSha256: "a".repeat(64) },
      { recordedAt },
      { received: true },
    ])
      expect(criteriaVersionMutationSchema.safeParse({ ...mutation, ...extra }).success).toBe(
        false,
      );
  });
  it("요청/기록 스키마는 입력을 정규화해 nonce digest를 안정적으로 만든다", () => {
    const input = {
      action: "append-criteria-version",
      revision: 1,
      clientRequestId: randomUUID(),
      ...appendInput(),
    };
    const digest = criteriaVersionInputDigest(input);
    expect(
      criteriaVersionInputDigest({ ...input, revision: 100, clientRequestId: randomUUID() }),
    ).toBe(digest);
    expect(criteriaVersionInputDigest({ ...input, reason: "바뀐 이유" })).not.toBe(digest);
    expect(
      criteriaVersionInputDigest({
        ...input,
        details: { ...input.details, title: ` ${input.details.title} ` },
      }),
    ).toBe(digest);
  });
});
describe("수동 기준 버전 추가와 신청 회차의 정확한 고정", () => {
  it("legacy에 새 기준·pin을 주입하지 않는다", () => {
    const company = state(),
      before = structuredClone(company);
    expect(latestApplicationCriteriaBinding(company, company.applications[0].id)).toBeNull();
    expect(applicationCriteriaContext(company, company.applications[0].id)).toEqual({
      status: "unpinned",
      bindingId: null,
      criteriaVersionId: null,
      reasons: [],
      officialVerification: "unverified",
    });
    expect(company).toEqual(before);
  });
  it("정정은 새 버전이고 과거 기준/연결은 불변이다", () => {
    const company = state(),
      first = add(company),
      binding = pin(company),
      saved = structuredClone({ first, binding });
    const next = add(
      company,
      appendInput({
        criteriaId: first.criteriaId,
        previousVersionId: first.id,
        details: {
          ...first.details,
          versionLabel: "새 기준 2",
          documents: first.details.documents.map((item) => ({ ...item, period: "새 담당자 기록" })),
        },
      }),
    );
    expect(next.version).toBe(2);
    expect(next.criteriaId).toBe(first.criteriaId);
    expect(next.previousVersionId).toBe(first.id);
    expect(company.criteriaVersions![0]).toEqual(saved.first);
    expect(company.applicationCriteriaBindings![0]).toEqual(saved.binding);
    expect(applicationCriteriaContext(company, company.applications[0].id)).toMatchObject({
      status: "needs-review",
      criteriaVersionId: first.id,
      reasons: ["newer-criteria-version"],
    });
  });
  it("이전 버전 정정을 경합으로 거부하고 원본 상태를 변경하지 않는다", () => {
    const company = state(),
      first = add(company);
    add(company, appendInput({ criteriaId: first.criteriaId, previousVersionId: first.id }));
    const before = structuredClone(company);
    const input = appendInput({ criteriaId: first.criteriaId, previousVersionId: first.id });
    expect(() =>
      buildCriteriaVersion(company, input, server(company, "append-criteria-version", input)),
    ).toThrow(expect.objectContaining({ code: "CRITERIA_VERSION_STALE" }));
    expect(company).toEqual(before);
  });
  it("정확히 고른 과거 버전도 연결 가능하며 자동 최신 버전 선택은 없다", () => {
    const company = state(),
      first = add(company);
    add(company, appendInput({ criteriaId: first.criteriaId, previousVersionId: first.id }));
    const binding = pin(company);
    expect(binding.criteriaVersionId).toBe(first.id);
    expect(binding.criteriaVersion).toBe(1);
    expect(binding.officialVerification).toBe("unverified");
  });
  it("새 pin도 append-only이며 이전 연결 ID를 정확히 요구한다", () => {
    const company = state(),
      first = add(company),
      firstBinding = pin(company);
    const next = add(
      company,
      appendInput({ criteriaId: first.criteriaId, previousVersionId: first.id }),
    );
    const input = {
      ...pinInput(company),
      criteriaVersionId: next.id,
      criteriaContentSha256: next.contentSha256,
      previousBindingId: firstBinding.id,
    };
    const second = pin(company, input);
    expect(second.version).toBe(2);
    expect(second.previousBindingId).toBe(firstBinding.id);
    expect(latestApplicationCriteriaBinding(company, firstBinding.applicationId)?.id).toBe(
      second.id,
    );
    expect(() =>
      buildApplicationCriteriaBinding(
        company,
        input,
        server(company, "pin-application-criteria", input),
      ),
    ).toThrow(expect.objectContaining({ code: "CRITERIA_VERSION_STALE" }));
  });
  it("회차 metadata 변경은 과거 snapshot 보존 및 재확인 상태로만 반영한다", () => {
    const company = state();
    add(company);
    const binding = pin(company),
      before = structuredClone(binding);
    company.applications[0].title = "변경된 합성 제목";
    expect(applicationCriteriaContext(company, binding.applicationId)).toMatchObject({
      status: "needs-review",
      reasons: ["application-changed"],
    });
    expect(binding).toEqual(before);
    const input = {
      ...pinInput(company),
      applicationMetadataVersionId: randomUUID(),
      previousBindingId: binding.id,
    };
    expect(() =>
      buildApplicationCriteriaBinding(
        company,
        input,
        server(company, "pin-application-criteria", input),
      ),
    ).toThrow(expect.objectContaining({ code: "CRITERIA_APPLICATION_CHANGED" }));
  });
  it("회사명/사업자번호 변경도 당시 snapshot을 덮어쓰지 않는다", () => {
    const company = state();
    add(company);
    const binding = pin(company),
      before = structuredClone(binding);
    company.profile.companyName = "다른 이름";
    expect(applicationCriteriaContext(company, binding.applicationId)).toMatchObject({
      status: "needs-review",
      reasons: ["company-changed"],
    });
    expect(binding).toEqual(before);
  });
  it("다른 회사·회차·기준 ID 및 잘못된 content SHA를 차단한다", () => {
    const company = state();
    add(company);
    const input = pinInput(company);
    for (const change of [
      { applicationId: randomUUID() },
      { criteriaVersionId: randomUUID() },
      { criteriaContentSha256: "0".repeat(64) },
    ]) {
      const bad = { ...input, ...change };
      expect(() =>
        buildApplicationCriteriaBinding(
          company,
          bad,
          server(company, "pin-application-criteria", bad),
        ),
      ).toThrow();
    }
    company.criteriaVersions![0].caseId = randomUUID();
    expect(() =>
      buildApplicationCriteriaBinding(
        company,
        input,
        server(company, "pin-application-criteria", input),
      ),
    ).toThrow(expect.objectContaining({ code: "CRITERIA_NOT_FOUND" }));
  });
  it("같은 ID의 기준 내용 변조는 pin·정정·현재성·replay 모두 거부한다", () => {
    const company = state(),
      entry = add(company),
      binding = pin(company);
    entry.details.documents[0].period = "변조";
    const input = pinInput(company);
    expect(() =>
      buildApplicationCriteriaBinding(
        company,
        input,
        server(company, "pin-application-criteria", input),
      ),
    ).toThrow(expect.objectContaining({ code: "CRITERIA_CONTENT_CHANGED" }));
    const correction = appendInput({ criteriaId: entry.criteriaId, previousVersionId: entry.id });
    expect(() =>
      buildCriteriaVersion(
        company,
        correction,
        server(company, "append-criteria-version", correction),
      ),
    ).toThrow(expect.objectContaining({ code: "CRITERIA_CONTENT_CHANGED" }));
    expect(applicationCriteriaContext(company, binding.applicationId)).toMatchObject({
      status: "unresolved",
      reasons: ["criteria-changed"],
    });
    expect(() =>
      isCriteriaVersionReplay(company, binding.clientRequestId, binding.inputDigest),
    ).toThrow(expect.objectContaining({ code: "CRITERIA_CONTENT_CHANGED" }));
  });
  it("동일 nonce 과거 pin replay는 새 연결을 복원하지 않는다", () => {
    const company = state(),
      entry = add(company),
      first = pin(company);
    const input = { ...pinInput(company), previousBindingId: first.id, reason: "재확인 기록" };
    const second = pin(company, input),
      before = structuredClone(company);
    expect(isCriteriaVersionReplay(company, first.clientRequestId, first.inputDigest)).toBe(true);
    expect(isCriteriaVersionReplay(company, entry.clientRequestId, entry.inputDigest)).toBe(true);
    expect(isCriteriaVersionReplay(company, randomUUID(), "0".repeat(64))).toBe(false);
    expect(() => isCriteriaVersionReplay(company, first.clientRequestId, "0".repeat(64))).toThrow(
      expect.objectContaining({ code: "CRITERIA_REQUEST_CONFLICT" }),
    );
    expect(latestApplicationCriteriaBinding(company, first.applicationId)?.id).toBe(second.id);
    expect(company).toEqual(before);
  });
  it("다른 회차 최초 연결도 과거 pin과 같은 버전 ID의 hash 동시변조를 거부한다", () => {
    const company = state(),
      entry = add(company),
      first = pin(company);
    company.applications.push({
      ...company.applications[0],
      id: randomUUID(),
      clientRequestId: randomUUID(),
    });
    entry.details.title = "변조한 동일 버전";
    entry.contentSha256 = criteriaVersionContentSha(entry.details);
    const input = {
      ...pinInput(company),
      applicationId: company.applications[1].id,
      applicationMetadataVersionId: company.applications[1].id,
    };
    expect(() => pin(company, input)).toThrow(
      expect.objectContaining({ code: "CRITERIA_CONTENT_CHANGED" }),
    );
    expect(() =>
      isCriteriaVersionReplay(company, entry.clientRequestId, entry.inputDigest),
    ).toThrow(expect.objectContaining({ code: "CRITERIA_CONTENT_CHANGED" }));
    expect(() => renderCriteriaReference(company, first.id)).toThrow(
      expect.objectContaining({ code: "CRITERIA_CONTENT_CHANGED" }),
    );
    expect(company.applicationCriteriaBindings).toHaveLength(1);
  });
  it("과거 핀 출력은 최신 연결·기준을 대체하지 않고 사용자 Markdown을 실행문법으로 만들지 않는다", () => {
    const company = state(),
      entry = add(company),
      first = pin(company);
    const next = add(
      company,
      appendInput({
        criteriaId: entry.criteriaId,
        previousVersionId: entry.id,
        details: { ...entry.details, title: "다른 최신 기준" },
      }),
    );
    pin(company, {
      ...pinInput(company),
      previousBindingId: first.id,
      criteriaVersionId: next.id,
      criteriaContentSha256: next.contentSha256,
    });
    const before = structuredClone(company),
      output = renderCriteriaReference(company, first.id);
    expect(output).toContain(entry.id);
    expect(output).not.toContain("다른 최신 기준");
    expect(output).toContain("새 기준 버전이 있습니다");
    expect(output).toContain("앱 내장 사전진단 기준과 별개");
    expect(company).toEqual(before);
    const dangerous = state();
    add(
      dangerous,
      appendInput({
        details: { ...details(), title: "<script>alert(1)</script> [x](https://example.invalid)" },
      }),
    );
    const binding = pin(dangerous),
      escaped = renderCriteriaReference(dangerous, binding.id);
    expect(escaped).not.toContain("<script>");
    expect(escaped).not.toContain("[x](");
    expect(escaped).toContain("&lt;script&gt;");
  });
  it("출력 전후 회사 변경과 다른 회사의 핀은 결과를 폐기한다", () => {
    const company = state();
    add(company);
    const binding = pin(company);
    let calls = 0;
    expect(() =>
      buildCriteriaReference(
        { get: () => ({ ...company, revision: company.revision + calls++ }) },
        company.id,
        binding.id,
      ),
    ).toThrow(expect.objectContaining({ code: "STALE_REVISION" }));
    const foreign = state();
    expect(() => buildCriteriaReference({ get: () => foreign }, company.id, binding.id)).toThrow();
    expect(() => renderCriteriaReference(company, randomUUID())).toThrow();
  });
  it("서버 metadata digest·중복 ID/nonce 주입을 거부한다", () => {
    const company = state(),
      input = appendInput(),
      meta = server(company, "append-criteria-version", input);
    expect(() =>
      buildCriteriaVersion(company, input, { ...meta, inputDigest: "0".repeat(64) }),
    ).toThrow(expect.objectContaining({ code: "CRITERIA_RECORD_INVALID" }));
    const entry = add(company);
    expect(() => buildCriteriaVersion(company, input, { ...meta, id: entry.id })).toThrow();
    expect(() =>
      buildCriteriaVersion(company, input, { ...meta, clientRequestId: entry.clientRequestId }),
    ).toThrow();
    expect(
      criteriaVersionSchema.safeParse({ ...entry, officialVerification: "verified" }).success,
    ).toBe(false);
    const binding = pin(company);
    expect(applicationCriteriaBindingSchema.safeParse({ ...binding, eligible: true }).success).toBe(
      false,
    );
  });
  it("저장 한도를 초과해도 기존 이력을 자르거나 수정하지 않는다", () => {
    const company = state(),
      entry = add(company),
      binding = pin(company);
    expect(() =>
      assertCriteriaVersionCapacity({
        criteriaVersions: Array(criteriaVersionLimits.versions + 1).fill(entry),
        applicationCriteriaBindings: [],
      }),
    ).toThrow(expect.objectContaining({ code: "CRITERIA_LIMIT" }));
    expect(() =>
      assertCriteriaVersionCapacity({
        criteriaVersions: [entry],
        applicationCriteriaBindings: Array(criteriaVersionLimits.bindings + 1).fill(binding),
      }),
    ).toThrow(expect.objectContaining({ code: "CRITERIA_LIMIT" }));
    const huge = structuredClone(entry);
    huge.details.documents = Array.from({ length: 50 }, () => ({
      ...entry.details.documents[0],
      id: randomUUID(),
      note: "x".repeat(2000),
      period: "x".repeat(2000),
      appliesTo: "x".repeat(2000),
      issueDateCondition: "x".repeat(2000),
      alternativeCondition: "x".repeat(2000),
      autoLinkGuidance: "x".repeat(2000),
    }));
    expect(() =>
      assertCriteriaVersionCapacity({ criteriaVersions: [huge], applicationCriteriaBindings: [] }),
    ).toThrow(expect.objectContaining({ code: "CRITERIA_LIMIT" }));
  });
  it("기준 내용 해시는 입력 순서를 고정하며 서류 조건이 바뀌면 달라진다", () => {
    const original = details(),
      sha = criteriaVersionContentSha(original);
    expect(criteriaVersionContentSha({ ...original, title: ` ${original.title} ` })).toBe(sha);
    expect(
      criteriaVersionContentSha({
        ...original,
        documents: original.documents.map((item) => ({
          ...item,
          alternativeCondition: "담당자 정정",
        })),
      }),
    ).not.toBe(sha);
  });
});
