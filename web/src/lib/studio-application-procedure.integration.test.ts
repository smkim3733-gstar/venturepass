import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import {
  emptyProfile,
  type CaseMutation,
  type SourceDocument,
  type StudioCase,
} from "./studio-schema";
import { applicationMetadata, currentApplicationLinks } from "./studio-application-types";
import {
  type AgencyRecord,
  type AgencyRecordInput,
  isAgencyNoticeRecord,
} from "./studio-agency-records";
import {
  type ApplicationProcedureInput,
  applicationProcedureLimits,
} from "./studio-application-procedure-types";
import { applicationProcedureContext } from "./studio-application-procedure";
import { withVentureInputCompanyLock } from "./venturein-input-lock";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ store: null as StudioStore | null, external: vi.fn() }));
vi.mock("@/lib/studio-storage", async (original) => ({
  ...(await original<typeof import("./studio-storage")>()),
  getStudioStore: () => state.store!,
}));
vi.mock("@/lib/venturein-runner", () => ({ stopVentureSession: state.external }));
vi.mock("openai", () => ({
  default: class {
    constructor() {
      state.external();
    }
  },
}));
import { GET, PATCH } from "@/app/api/studio/cases/[caseId]/route";

let directory: string;
let company: StudioCase;
const store = () => state.store!;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const originalBytes = Buffer.from("synthetic original A");
function mutate(input: CaseMutation) {
  company = store().mutate(company.id, input, () => []);
  return company;
}
function row(id = company.id) {
  const db = new DatabaseSync(join(directory, "studio.sqlite"));
  try {
    return db.prepare("SELECT * FROM studio_cases WHERE id=?").get(id)!;
  } finally {
    db.close();
  }
}
function replaceBody(change: (value: StudioCase) => void) {
  const value = store().get(company.id);
  change(value);
  const db = new DatabaseSync(join(directory, "studio.sqlite"));
  try {
    db.prepare("UPDATE studio_cases SET body=? WHERE id=?").run(JSON.stringify(value), company.id);
  } finally {
    db.close();
  }
  company = store().get(company.id);
}
function application(title = "합성 신청 회차") {
  mutate({
    action: "create-application",
    revision: company.revision,
    clientRequestId: randomUUID(),
    title,
    kind: "new",
    plannedOn: "",
    criteriaNote: "미확인",
    previousApplicationId: null,
  });
  return company.applications.at(-1)!;
}
function agency(kind: "request" | "notice" = "request", previous?: AgencyRecord) {
  const common = {
    title: "합성 요청·통보",
    institution: "합성 기관",
    body: "가상 보완 내용",
    occurredOn: "",
    note: "",
    sourceIds: [],
  };
  let record: AgencyRecordInput;
  if (kind === "notice")
    record = {
      ...common,
      ...(previous && isAgencyNoticeRecord(previous)
        ? {
            kind: "notice-correction" as const,
            noticeRecordId: previous.noticeRecordId,
            previousVersionId: previous.id,
          }
        : { kind: "notice" as const }),
      details: {
        category: "decision",
        decisionText: "수동 결과 메모",
        notifiedOn: "",
        reasons: "미확인",
      },
    };
  else
    record = {
      ...common,
      ...(previous && !isAgencyNoticeRecord(previous) && previous.kind !== "response"
        ? {
            kind: "request-correction" as const,
            requestRecordId: previous.requestRecordId,
            previousVersionId: previous.id,
          }
        : { kind: "request" as const }),
      dueOn: "",
      dueNote: "",
    };
  mutate({
    action: "append-agency-record",
    revision: company.revision,
    clientRequestId: randomUUID(),
    record,
  });
  return company.agencyRecords.at(-1)!;
}
function link(applicationId: string, recordId: string) {
  mutate({
    action: "link-application-agency",
    revision: company.revision,
    clientRequestId: randomUUID(),
    applicationId,
    recordId,
    note: "명시한 합성 귀속",
  });
  return currentApplicationLinks(company).at(-1)!;
}
function setup(kind: "request" | "notice" = "request"): ApplicationProcedureInput {
  const cycle = application(),
    record = agency(kind),
    owner = link(cycle.id, record.id);
  return {
    procedureId: null,
    previousVersionId: null,
    applicationId: cycle.id,
    applicationMetadataVersionId: cycle.id,
    agencyVersionId: record.id,
    expectedLinkEventId: owner.id,
    title: "합성 절차 기록",
    procedureType: "unknown",
    requester: "",
    requestedOn: "",
    dueOn: "",
    dueBasis: "",
    extensionStatus: "unknown",
    extensionRequestedOn: "",
    extensionDecidedOn: "",
    extendedDueOn: "",
    extensionBasis: "",
    status: "unknown",
    statusBasis: "",
    completionBasis: "",
    recordedBy: "합성 기록자",
    note: "",
    evidence: [],
  };
}
function append(procedure: ApplicationProcedureInput, changes: Record<string, unknown> = {}) {
  return {
    action: "append-application-procedure",
    revision: company.revision,
    clientRequestId: randomUUID(),
    procedure,
    ...changes,
  };
}
async function patch(
  body: unknown,
  options: { id?: string; query?: string; headers?: Record<string, string> } = {},
) {
  const id = options.id ?? company.id;
  return PATCH(
    new Request(`http://localhost:3000/api/studio/cases/${id}${options.query ?? ""}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...options.headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ caseId: id }) },
  );
}
async function save(procedure: ApplicationProcedureInput) {
  const input = append(procedure),
    response = await patch(input);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  company = await response.json();
  return { input, record: company.applicationProcedures.at(-1)! };
}
function source(original = false, pending = false) {
  const now = new Date().toISOString();
  const value: SourceDocument = {
    id: randomUUID(),
    name: "합성 추가 근거",
    kind: "other",
    text: pending ? "" : "확인할 정확한 합성 인용",
    originalName: original ? "fixture.txt" : null,
    mimeType: original ? "text/plain" : null,
    extraction: pending ? "pending" : "manual",
    warnings: [],
    createdAt: now,
    updatedAt: now,
  };
  if (original) company = store().addUpload(company.id, company.revision, value, originalBytes);
  else mutate({ action: "source", revision: company.revision, source: value });
  return company.sources.at(-1)!;
}
function evidence(value: SourceDocument, quote = value.text) {
  return {
    sourceId: value.id,
    sourceUpdatedAt: value.updatedAt,
    quote,
    locator: quote ? "등록 본문" : "원본만 연결·본문 미확인",
  };
}

describe("회차별 절차 기록 SQLite/API 통합", { timeout: 60_000 }, () => {
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "venture-procedure-api-"));
    state.store = new StudioStore(directory);
    company = store().create({ ...emptyProfile(), companyName: "합성 절차 기업" });
    state.external.mockClear();
  });
  afterEach(() => {
    expect(state.external).not.toHaveBeenCalled();
    store().close();
    const boundary = relative(resolve(tmpdir()), resolve(directory));
    if (
      !boundary.startsWith("venture-procedure-api-") ||
      boundary.startsWith("..") ||
      isAbsolute(boundary)
    )
      throw new Error("Unsafe fixture cleanup");
    rmSync(directory, { recursive: true, force: true });
  });

  it("legacy 조회 기본 배열은 원본 DB를 바꾸지 않고 재시작 후에도 읽힌다", async () => {
    const legacy = { ...company } as Partial<StudioCase>;
    delete legacy.applicationProcedures;
    const db = new DatabaseSync(join(directory, "studio.sqlite"));
    db.prepare("UPDATE studio_cases SET body=? WHERE id=?").run(JSON.stringify(legacy), company.id);
    db.close();
    const before = row();
    store().close();
    state.store = new StudioStore(directory);
    const response = await GET(
      new Request(`http://localhost:3000/api/studio/cases/${company.id}`),
      { params: Promise.resolve({ caseId: company.id }) },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).applicationProcedures).toEqual([]);
    expect(row()).toEqual(before);
  });

  it.each(["request", "notice"] as const)(
    "%s 최신 귀속에 수동 기한·연장을 기록해도 기관/업무/분석 상태는 유지한다",
    async (kind) => {
      const input = setup(kind),
        value = source();
      const before = structuredClone(company),
        oldRow = row();
      const { record } = await save({
        ...input,
        evidence: [evidence(value)],
        dueOn: "2030-10-01",
        dueBasis: "담당자 기재 근거",
        extensionStatus: "reported_allowed",
        extensionBasis: "담당자가 허용됐다고 기재",
        extendedDueOn: "2030-11-01",
        status: "reported_completed",
        statusBasis: "수동 대응 기록",
        completionBasis: "담당자 종료 메모",
      });
      expect(record).toMatchObject({
        version: 1,
        previousVersionId: null,
        procedureId: record.id,
        chainKind: kind,
        origin: "manual",
        officialVerification: "unverified",
      });
      expect(record.agencySnapshot).toEqual(before.agencyRecords[0]);
      expect(record.sourceSnapshots[0].textSha256).toBe(hash(value.text));
      for (const key of [
        "profile",
        "sources",
        "stage",
        "tasks",
        "agencyRecords",
        "applications",
        "applicationEvents",
        "analysis",
        "plans",
        "preparationRuns",
        "diagnoses",
      ] as const)
        expect(company[key]).toEqual(before[key]);
      expect(row().evidence_revision).toBe(oldRow.evidence_revision);
      expect(company.revision).toBe(before.revision + 1);
      expect(applicationProcedureContext(company, record)).toEqual([]);
    },
  );

  it("재시작·기관 정정 뒤 같은 nonce 재전송은 현재 상태만 반환하고 이전 내용을 복원하지 않는다", async () => {
    const input = setup(),
      { input: request, record } = await save(input);
    agency("request", company.agencyRecords[0]);
    const current = structuredClone(company),
      before = row();
    store().close();
    state.store = new StudioStore(directory);
    const replay = await patch(request);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(current);
    expect(row()).toEqual(before);
    expect(company.applicationProcedures[0]).toEqual(record);
    const conflict = await patch({ ...request, procedure: { ...input, note: "다른 내용" } });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe("PROCEDURE_REQUEST_CONFLICT");
    expect(row()).toEqual(before);
  });

  it("최신 버전에서 정정하고 이전 snapshot을 보존하며 오래된 previousVersion을 거부한다", async () => {
    const input = setup(),
      { record: first } = await save(input);
    const correction = agency("request", company.agencyRecords[0]);
    const revised = {
      ...input,
      procedureId: first.id,
      previousVersionId: first.id,
      agencyVersionId: correction.id,
      note: "추가 확인",
    };
    const { record: second } = await save(revised);
    expect(second).toMatchObject({
      version: 2,
      procedureId: first.id,
      previousVersionId: first.id,
      agencyVersionId: correction.id,
    });
    expect(company.applicationProcedures[0]).toEqual(first);
    expect(applicationProcedureContext(company, first)).toContain(
      "기관 요청·통보가 정정되었거나 없습니다.",
    );
    const before = row(),
      response = await patch(append(revised));
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("PROCEDURE_VERSION_STALE");
    expect(row()).toEqual(before);
  });

  it.each(["request", "notice"] as const)(
    "정정된 %s의 이전 기관 버전 저장은 거부한다",
    async (kind) => {
      const input = setup(kind);
      agency(kind, company.agencyRecords[0]);
      const before = row(),
        response = await patch(append(input));
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("PROCEDURE_AGENCY_STALE");
      expect(row()).toEqual(before);
    },
  );

  it("회차 메타 정정 뒤 정확 새 메타에서만 다음 절차 버전을 작성한다", async () => {
    const input = setup(),
      { record } = await save(input);
    mutate({
      action: "correct-application",
      revision: company.revision,
      clientRequestId: randomUUID(),
      applicationId: input.applicationId,
      previousVersionId: input.applicationMetadataVersionId,
      title: "정정 회차 제목",
      kind: "renewal",
      plannedOn: "",
      criteriaNote: "수기 기준",
      previousApplicationId: null,
    });
    const stale = await patch(append(input));
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("PROCEDURE_APPLICATION_STALE");
    const { record: next } = await save({
      ...input,
      procedureId: record.id,
      previousVersionId: record.id,
      applicationMetadataVersionId: applicationMetadata(company, input.applicationId)!
        .metadataVersionId,
    });
    expect(next.applicationTitle).toBe("정정 회차 제목");
    expect(company.applicationProcedures[0]).toEqual(record);
    expect(next.applicationSha256).not.toBe(record.applicationSha256);
  });

  it("기관 root 귀속 변경 후 과거 절차의 회차 이동은 거부하고 새 명시 절차만 허용한다", async () => {
    const input = setup(),
      { record: first } = await save(input),
      other = application("다른 회차");
    mutate({
      action: "correct-application-agency-link",
      revision: company.revision,
      clientRequestId: randomUUID(),
      previousLinkEventId: input.expectedLinkEventId,
      fromApplicationId: input.applicationId,
      toApplicationId: other.id,
      recordId: input.agencyVersionId,
      note: "회차 귀속 정정",
    });
    const owner = currentApplicationLinks(company)[0];
    const stale = await patch(append(input));
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("PROCEDURE_LINK_STALE");
    const moved = {
      ...input,
      applicationId: other.id,
      applicationMetadataVersionId: other.id,
      expectedLinkEventId: owner.id,
    };
    const rejected = await patch(
      append({ ...moved, procedureId: first.id, previousVersionId: first.id }),
    );
    expect(rejected.status).toBe(409);
    expect((await rejected.json()).code).toBe("PROCEDURE_ROOT_MISMATCH");
    const { record: separate } = await save(moved);
    expect(separate.procedureId).toBe(separate.id);
    expect(company.applicationProcedures[0]).toEqual(first);
  });

  it.each([
    ["agency", "PROCEDURE_AGENCY_CHANGED"],
    ["application", "PROCEDURE_APPLICATION_CHANGED"],
    ["link", "PROCEDURE_LINK_CHANGED"],
  ] as const)("같은 %s ID의 내용 변조는 새 기록으로 덮지 않는다", async (target, code) => {
    const input = setup();
    await save(input);
    replaceBody((value) => {
      if (target === "agency") value.agencyRecords[0].body += " 변조";
      else if (target === "application") value.applications[0].title += " 변조";
      else {
        const event = value.applicationEvents[0];
        if (event.kind === "agency-link") event.note += " 변조";
      }
    });
    const before = row(),
      response = await patch(append(input));
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe(code);
    expect(row()).toEqual(before);
  });

  it("응답 기록은 절차의 요청·통보 기준으로 사용할 수 없다", async () => {
    const input = setup();
    mutate({
      action: "append-agency-record",
      revision: company.revision,
      clientRequestId: randomUUID(),
      record: {
        kind: "response",
        requestRecordId: input.agencyVersionId,
        previousVersionId: null,
        responseStatus: "draft",
        title: "답변 초안",
        body: "미검토",
        occurredOn: "",
        note: "",
        sourceIds: [],
      },
    });
    const before = row(),
      response = await patch(
        append({ ...input, agencyVersionId: company.agencyRecords.at(-1)!.id }),
      );
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe("PROCEDURE_AGENCY_REQUIRED");
    expect(row()).toEqual(before);
  });

  it("회사 밖 회차·기관·자료와 기존값이 바뀐 인용은 거부한다", async () => {
    const input = setup(),
      value = source(),
      other = store().create({ ...emptyProfile(), companyName: "다른 합성 회사" });
    const before = row();
    for (const candidate of [
      { ...input, applicationId: randomUUID() },
      { ...input, agencyVersionId: randomUUID() },
      { ...input, evidence: [{ ...evidence(value), sourceId: randomUUID() }] },
      { ...input, evidence: [{ ...evidence(value), quote: "본문에 없는 인용" }] },
      { ...input, evidence: [{ ...evidence(value), sourceUpdatedAt: "2020-01-01T00:00:00.000Z" }] },
    ])
      expect((await patch(append(candidate))).status).toBeGreaterThanOrEqual(400);
    expect(
      (await patch(append(input, { revision: other.revision }), { id: other.id })).status,
    ).toBe(404);
    expect(row()).toEqual(before);
    expect(store().get(other.id).applicationProcedures).toEqual([]);
  });

  it("원본 전용 pending은 빈 인용으로만 연결되고 판독·검토 완료로 바뀌지 않는다", async () => {
    const input = setup(),
      value = source(true, true),
      beforeSource = structuredClone(value);
    const response = await patch(append({ ...input, evidence: [evidence(value, "임의 본문")] }));
    expect(response.status).toBe(409);
    const { record } = await save({ ...input, evidence: [evidence(value, "")] });
    expect(record.sourceSnapshots[0]).toMatchObject({
      extraction: "pending",
      textSha256: hash(""),
      original: { sha256: hash(originalBytes) },
    });
    expect(company.sources[0]).toEqual(beforeSource);
  });

  it("절차에 고정한 원본의 같은 크기 변경을 새 절차와 다른 기관 기록에서 거부한다", async () => {
    const input = setup(),
      value = source(true),
      linked = { ...input, evidence: [evidence(value)] };
    const { record } = await save(linked);
    const path = join(directory, "originals", company.id, `${value.id}.bin`),
      changed = Buffer.from("synthetic original B");
    expect(changed.length).toBe(originalBytes.length);
    writeFileSync(path, changed);
    const before = row(),
      response = await patch(append(linked));
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("PROCEDURE_ORIGINAL_CHANGED");
    const cross = await patch({
      action: "append-agency-record",
      revision: company.revision,
      clientRequestId: randomUUID(),
      record: {
        kind: "request",
        institution: "합성 기관",
        title: "추가 요청",
        body: "원본 연결",
        occurredOn: "",
        dueOn: "",
        dueNote: "",
        note: "",
        sourceIds: [value.id],
      },
    });
    expect(cross.status).toBe(409);
    expect((await cross.json()).code).toBe("PROCEDURE_ORIGINAL_CHANGED");
    expect(row()).toEqual(before);
    expect(readFileSync(path)).toEqual(changed);
    expect(store().get(company.id).applicationProcedures[0]).toEqual(record);
  });

  it("과거 기관 원본 해시도 절차에 새 해시로 덮을 수 없고 참조 자료 삭제는 막는다", async () => {
    const input = setup(),
      value = source(true),
      linked = { ...input, evidence: [evidence(value)] };
    mutate({
      action: "append-agency-record",
      revision: company.revision,
      clientRequestId: randomUUID(),
      record: {
        kind: "request",
        institution: "합성 기관",
        title: "별도 근거 고정",
        body: "가상",
        occurredOn: "",
        dueOn: "",
        dueNote: "",
        note: "",
        sourceIds: [value.id],
      },
    });
    const path = join(directory, "originals", company.id, `${value.id}.bin`);
    writeFileSync(path, "synthetic original B");
    const before = row(),
      changed = await patch(append(linked));
    expect(changed.status).toBe(409);
    expect(row()).toEqual(before);
    writeFileSync(path, originalBytes);
    await save(linked);
    const saved = row();
    const deletion = await patch({
      action: "delete-source",
      revision: company.revision,
      sourceId: value.id,
    });
    expect(deletion.status).toBe(409);
    expect(row()).toEqual(saved);
    expect(readFileSync(path)).toEqual(originalBytes);
  });

  it("절차만 참조한 본문 자료도 삭제할 수 없고 본문 정정은 과거 snapshot을 보존한다", async () => {
    const input = setup(),
      value = source(),
      { record } = await save({ ...input, evidence: [evidence(value)] });
    const before = row(),
      deletion = await patch({
        action: "delete-source",
        revision: company.revision,
        sourceId: value.id,
      });
    expect(deletion.status).toBe(409);
    expect(row()).toEqual(before);
    mutate({
      action: "source",
      revision: company.revision,
      source: { ...value, text: "수동 정정한 다른 본문" },
    });
    expect(company.applicationProcedures[0]).toEqual(record);
    expect(applicationProcedureContext(company, record)).toContain(
      "연결한 추가 증빙을 다시 확인해 주세요.",
    );
  });

  it("동일 회사 입력 잠금과 stale CAS는 기록·revision을 바꾸지 않는다", async () => {
    const input = setup(),
      request = append(input),
      before = row();
    await withVentureInputCompanyLock(company.id, async () => {
      const response = await patch(request);
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("INPUT_IN_PROGRESS");
    });
    const response = await patch({ ...request, revision: company.revision - 1 });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("STALE_REVISION");
    expect(row()).toEqual(before);
  });

  it.each(["count", "characters"] as const)(
    "%s 한도 거부는 SQL 전체를 rollback하며 이전 기록을 지우지 않는다",
    async (limit) => {
      const input = setup(),
        { record } = await save(input);
      replaceBody((value) => {
        const count = limit === "count" ? applicationProcedureLimits.versions : 35;
        value.applicationProcedures = Array.from({ length: count }, () => {
          const id = randomUUID();
          return {
            ...structuredClone(record),
            id,
            procedureId: id,
            clientRequestId: randomUUID(),
            ...(limit === "characters"
              ? {
                  note: "가".repeat(2000),
                  dueBasis: "나".repeat(2000),
                  extensionBasis: "다".repeat(2000),
                  statusBasis: "라".repeat(2000),
                  completionBasis: "마".repeat(2000),
                }
              : {}),
          };
        });
      });
      const before = row(),
        response = await patch(append(input));
      expect(response.status).toBe(413);
      expect((await response.json()).code).toBe("PROCEDURE_HISTORY_LIMIT");
      expect(row()).toEqual(before);
    },
  );

  it.each([
    ["extra", 400],
    ["query", 400],
    ["origin", 403],
    ["content-type", 415],
    ["json", 400],
    ["bytes", 413],
    ["date", 400],
    ["duplicate-source", 400],
  ] as const)("API %s 잘못된 요청을 저장 전에 거부한다", async (kind, expected) => {
    const input = setup(),
      value = source(),
      before = row();
    let body: unknown = append(input);
    const options: Parameters<typeof patch>[1] = {};
    if (kind === "extra")
      body = append({
        ...input,
        origin: "official",
        officialVerification: "verified",
      } as ApplicationProcedureInput);
    if (kind === "query") options.query = "?unexpected=1";
    if (kind === "origin") options.headers = { origin: "https://external.invalid" };
    if (kind === "content-type") options.headers = { "content-type": "text/plain" };
    if (kind === "json") body = "{";
    if (kind === "bytes")
      body = `${JSON.stringify(body)}${" ".repeat(applicationProcedureLimits.requestBytes)}`;
    if (kind === "date") body = append({ ...input, dueOn: "2026-02-30", dueBasis: "임의 날짜" });
    if (kind === "duplicate-source")
      body = append({ ...input, evidence: [evidence(value), evidence(value)] });
    const response = await patch(body, options);
    expect(response.status).toBe(expected);
    expect(row()).toEqual(before);
  });
});
