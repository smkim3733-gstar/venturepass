import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import { emptyProfile, type StudioCase } from "./studio-schema";
import type { AgencyRecordInput } from "./studio-agency-records";
import { withVentureInputCompanyLock } from "./venturein-input-lock";
import { certificateTaskContext } from "./studio-certificate-renewal-types";

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
import { PATCH } from "@/app/api/studio/cases/[caseId]/route";

let directory: string;
let company: StudioCase;
const store = () => state.store!;
const notice = (validUntil = "2028-09-24"): Extract<AgencyRecordInput, { kind: "notice" }> => ({
  kind: "notice",
  institution: "합성 기관",
  title: "합성 확인서 통보",
  body: "비공개 합성 통보 원문",
  occurredOn: "",
  note: "",
  sourceIds: [],
  details: {
    category: "certificate",
    certificateNumber: "private-synthetic-number",
    issuedOn: "",
    validFrom: "",
    validUntil,
    statusText: "취소 여부 미확인",
  },
});
function append(record: AgencyRecordInput = notice()) {
  company = store().mutate(
    company.id,
    {
      action: "append-agency-record",
      revision: company.revision,
      clientRequestId: randomUUID(),
      record,
    },
    () => [],
  );
  return company.agencyRecords.at(-1)!;
}
function payload(preparationOn = "2028-08-01") {
  return {
    action: "create-certificate-task" as const,
    revision: company.revision,
    noticeRecordId: company.agencyRecords[0].id,
    noticeVersionId: company.agencyRecords.at(-1)!.id,
    preparationOn,
  };
}
async function patch(
  body: unknown,
  caseId = company.id,
  suffix = "",
  headers: Record<string, string> = {},
) {
  return PATCH(
    new Request(`http://localhost:3000/api/studio/cases/${caseId}${suffix}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ caseId }) },
  );
}
async function save(body = payload()) {
  const response = await patch(body);
  expect(response.status).toBe(200);
  company = await response.json();
  return company.tasks.at(-1)!;
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "venture-certificate-test-"));
  state.store = new StudioStore(directory);
  company = store().create({ ...emptyProfile(), companyName: "합성 확인서 기업" });
  state.external.mockReset();
});
afterEach(() => {
  store().close();
  const boundary = relative(resolve(tmpdir()), resolve(directory));
  if (!boundary.startsWith("venture-certificate-test-") || boundary.includes(".."))
    throw new Error("Unsafe synthetic cleanup");
  rmSync(directory, { recursive: true, force: true });
  expect(state.external).not.toHaveBeenCalled();
});

describe("확인서 통보→차기 준비 업무 API", () => {
  it.each(["2028-09-24", ""])(
    "creates only the selected user date; recorded expiry %s remains unverified",
    async (validUntil) => {
      const recorded = append(notice(validUntil));
      const before = structuredClone(company);
      const created = await save();
      expect(created).toMatchObject({
        category: "other",
        status: "pending",
        dueDate: "2028-08-01",
        certificateOrigin: {
          noticeRecordId: recorded.id,
          noticeVersionId: recorded.id,
          preparationOn: "2028-08-01",
          validUntil,
          category: "certificate",
        },
      });
      expect(created.owners).toBeUndefined();
      expect(company.agencyRecords).toEqual(before.agencyRecords);
      expect(company.stage).toBe(before.stage);
      expect(company.plans).toEqual(before.plans);
      expect(company.analysis).toBe(before.analysis);
      store().close();
      state.store = new StudioStore(directory);
      expect(store().get(company.id).tasks).toEqual(company.tasks);
    },
  );
  it("replays an identical lost request without overwriting a completed or edited task", async () => {
    append();
    const body = payload();
    const created = await save(body);
    company = store().mutate(
      company.id,
      {
        action: "task",
        revision: company.revision,
        task: {
          ...created,
          dueDate: "2028-07-20",
          status: "done",
          notes: "보존할 편집",
          owners: { materials: "담당자", writing: "", review: "" },
        },
      },
      () => [],
    );
    const before = structuredClone(company);
    await save(body);
    expect(company).toEqual(before);
    expect(company.tasks).toHaveLength(1);
  });
  it("rejects a different create-date for an already linked version", async () => {
    append();
    await save();
    const before = structuredClone(company);
    const response = await patch(payload("2028-08-02"));
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("CERTIFICATE_TASK_EXISTS");
    expect(store().get(company.id)).toEqual(before);
  });
  it("preserves old dates/completion after correction and requires an explicit new-version task", async () => {
    const first = append();
    const created = await save();
    company = store().mutate(
      company.id,
      { action: "task", revision: company.revision, task: { ...created, status: "done" } },
      () => [],
    );
    const corrected = append({
      ...notice("2029-09-24"),
      kind: "notice-correction",
      noticeRecordId: first.id,
      previousVersionId: first.id,
    });
    expect(certificateTaskContext(company, company.tasks[0])?.state).toBe("updated");
    const obsolete = await patch({ ...payload(), noticeVersionId: first.id });
    expect(obsolete.status).toBe(409);
    await save(payload("2029-08-01"));
    expect(company.tasks).toHaveLength(2);
    expect(company.tasks[0]).toMatchObject({
      status: "done",
      dueDate: "2028-08-01",
      certificateOrigin: { validUntil: "2028-09-24" },
    });
    expect(company.tasks[1].certificateOrigin?.noticeVersionId).toBe(corrected.id);
  });
  it("rejects a current non-certificate notice and keeps prior linked work", async () => {
    const first = append();
    await save();
    append({
      ...notice(),
      kind: "notice-correction",
      noticeRecordId: first.id,
      previousVersionId: first.id,
      details: { category: "decision", decisionText: "별도 안내", notifiedOn: "", reasons: "" },
    });
    const before = structuredClone(company);
    const response = await patch(payload());
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("CERTIFICATE_CATEGORY_CHANGED");
    expect(store().get(company.id)).toEqual(before);
  });
  it("strips fabricated task origins and preserves server origins during ordinary edits", async () => {
    append();
    const created = await save();
    const other = store().create({ ...emptyProfile(), companyName: "다른 합성기업" });
    const injected = store().mutate(
      other.id,
      { action: "task", revision: other.revision, task: { ...created, id: randomUUID() } },
      () => [],
    );
    expect(injected.tasks[0].certificateOrigin).toBeUndefined();
    const { certificateOrigin: omitted, ...edited } = created;
    expect(omitted).toBeDefined();
    company = store().mutate(
      company.id,
      {
        action: "task",
        revision: company.revision,
        task: { ...edited, dueDate: "", notes: "일반 편집" },
      },
      () => [],
    );
    expect(company.tasks[0].certificateOrigin).toEqual(created.certificateOrigin);
    const forged = {
      ...company.tasks[0],
      certificateOrigin: {
        ...created.certificateOrigin!,
        noticeRecordId: randomUUID(),
        preparationOn: "2020-01-01",
      },
    };
    company = store().mutate(
      company.id,
      { action: "task", revision: company.revision, task: forged },
      () => [],
    );
    expect(company.tasks[0].certificateOrigin).toEqual(created.certificateOrigin);
  });
  it("enforces company boundaries and stale CAS before new creation", async () => {
    append();
    const other = store().create({ ...emptyProfile(), companyName: "별도기업" });
    const foreign = await patch({ ...payload(), revision: other.revision }, other.id);
    expect(foreign.status).toBe(404);
    expect(store().get(other.id).tasks).toEqual([]);
    const stale = await patch({ ...payload(), revision: company.revision - 1 });
    expect(stale.status).toBe(409);
    expect(store().get(company.id).tasks).toEqual([]);
  });
  it("keeps locked cases unchanged and performs no browser work", async () => {
    append();
    const before = structuredClone(company);
    await withVentureInputCompanyLock(company.id, async () => {
      const response = await patch(payload());
      expect(response.status).toBe(409);
    });
    expect(store().get(company.id)).toEqual(before);
  });
  it("rejects unknown fields, guessed dates, foreign origin, query and oversized input", async () => {
    append();
    expect((await patch({ ...payload(), preparationOn: "" })).status).toBe(400);
    expect((await patch({ ...payload(), validUntil: "2028-09-24" })).status).toBe(400);
    expect((await patch({ ...payload(), preparationOn: "2026-02-29" })).status).toBe(400);
    expect((await patch(payload(), company.id, "?x=1")).status).toBe(400);
    expect(
      (await patch(payload(), company.id, "", { origin: "https://foreign.invalid" })).status,
    ).toBe(403);
    expect((await patch(payload(), company.id, "", { "content-type": "text/plain" })).status).toBe(
      415,
    );
    expect((await patch(`${JSON.stringify(payload())}${" ".repeat(4096)}`)).status).toBe(413);
    expect(store().get(company.id).tasks).toEqual([]);
  });
  it("preserves company revision and tasks on a storage failure", async () => {
    append();
    const before = structuredClone(company);
    const db = new DatabaseSync(join(directory, "studio.sqlite"));
    db.exec(
      "CREATE TRIGGER synthetic_certificate_failure BEFORE UPDATE ON studio_cases BEGIN SELECT RAISE(FAIL, 'synthetic'); END;",
    );
    db.close();
    expect((await patch(payload())).status).toBe(500);
    expect(store().get(company.id)).toEqual(before);
  });
  it("allows explicit recreation after deletion but rejects a stale lost creation request", async () => {
    append();
    const body = payload();
    const created = await save(body);
    company = store().mutate(
      company.id,
      { action: "delete-task", revision: company.revision, taskId: created.id },
      () => [],
    );
    expect((await patch(body)).status).toBe(409);
    const recreated = await save();
    expect(recreated.id).not.toBe(created.id);
    expect(company.tasks).toHaveLength(1);
  });
  it("adds counts and recorded dates to summaries, excluding certificate numbers and notice bodies", async () => {
    append(notice(""));
    let summary = store()
      .list()
      .find((entry) => entry.id === company.id)!;
    expect(summary.attention?.certificate).toEqual({
      recordedUntilDates: [],
      missingUntilCount: 1,
      needsPreparationCount: 1,
      changedTaskCount: 0,
    });
    await save();
    summary = store()
      .list()
      .find((entry) => entry.id === company.id)!;
    expect(summary.attention?.certificate?.needsPreparationCount).toBe(0);
    expect(JSON.stringify(summary)).not.toMatch(/private-synthetic-number|비공개 합성|취소 여부/);
  });
});
