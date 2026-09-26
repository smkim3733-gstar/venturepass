import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import { emptyProfile, type StudioCase, type WorkflowTask } from "./studio-schema";
import { agencyTaskContext } from "./studio-agency-tasks";
import { withVentureInputCompanyLock } from "./venturein-input-lock";
import type { AgencyRecordInput } from "./studio-agency-records";

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
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "venture-agency-task-test-"));
  state.store = new StudioStore(directory);
  company = state.store.create({ ...emptyProfile(), companyName: "합성 기관 업무 검증" });
  state.external.mockReset();
});
afterEach(() => {
  state.store!.close();
  const boundary = relative(resolve(tmpdir()), resolve(directory));
  if (!boundary.startsWith("venture-agency-task-test-") || boundary.includes(".."))
    throw new Error("Unsafe synthetic cleanup");
  rmSync(directory, { recursive: true, force: true });
  expect(state.external).not.toHaveBeenCalled();
});
const requestInput = (dueOn = "2026-10-01"): Extract<AgencyRecordInput, { kind: "request" }> => ({
  kind: "request",
  institution: "합성기관",
  title: "추가 근거 확인",
  body: "합성 요청 원문",
  occurredOn: "2026-09-25",
  dueOn,
  dueNote: "가상 안내에 기재된 날짜",
  note: "",
  sourceIds: [],
});
const append = (input: AgencyRecordInput = requestInput()) => {
  company = state.store!.mutate(
    company.id,
    {
      action: "append-agency-record",
      revision: company.revision,
      clientRequestId: randomUUID(),
      record: input,
    },
    () => [],
  );
  return company.agencyRecords.at(-1)!;
};
const payload = (
  rootId = company.agencyRecords[0].id,
  versionId = company.agencyRecords.at(-1)!.id,
) => ({
  action: "create-agency-task" as const,
  revision: company.revision,
  requestRecordId: rootId,
  requestVersionId: versionId,
});
async function patch(
  body: unknown,
  caseId = company.id,
  headers: Record<string, string> = {},
  query = "",
) {
  return PATCH(
    new Request(`http://localhost:3000/api/studio/cases/${caseId}${query}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
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
function replace(record: StudioCase) {
  const db = new DatabaseSync(join(directory, "studio.sqlite"));
  try {
    db.prepare("UPDATE studio_cases SET body = ? WHERE id = ?").run(
      JSON.stringify(record),
      company.id,
    );
  } finally {
    db.close();
  }
}

describe("기관 요청과 담당 업무 연결", () => {
  it.each(["2026-10-01", ""])(
    "담당자 기입 기한 %s만 복사하고 원문·단계를 보존한다",
    async (dueOn) => {
      const request = append(requestInput(dueOn));
      const before = structuredClone(company);
      const task = await save();
      expect(task).toMatchObject({
        category: "supplement",
        status: "pending",
        dueDate: dueOn,
        agencyOrigin: { requestRecordId: request.id, requestVersionId: request.id },
      });
      expect(task.notes).toContain("기관 발송·접수 확인이 아닙니다");
      expect(company.agencyRecords).toEqual(before.agencyRecords);
      expect(company.stage).toBe(before.stage);
      expect(company.plans).toEqual(before.plans);
      expect(agencyTaskContext(company, task)?.state).toBe("current");
      state.store!.close();
      state.store = new StudioStore(directory);
      expect(state.store.get(company.id).tasks).toEqual(company.tasks);
    },
  );

  it("응답 유실 후 같은 버전 재요청은 수정된 업무도 그대로 재사용한다", async () => {
    append();
    const body = payload();
    const task = await save(body);
    company = state.store!.mutate(
      company.id,
      {
        action: "task",
        revision: company.revision,
        task: { ...task, status: "done", dueDate: "2026-10-03", notes: "담당자 수정 보존" },
      },
      () => [],
    );
    const before = structuredClone(company);
    await save(body);
    expect(company).toEqual(before);
    expect(company.tasks).toHaveLength(1);
  });

  it("요청 정정은 과거 업무의 완료·기한을 바꾸지 않고 새 버전 업무만 명시 생성한다", async () => {
    const root = append();
    const first = await save();
    company = state.store!.mutate(
      company.id,
      { action: "task", revision: company.revision, task: { ...first, status: "done" } },
      () => [],
    );
    const oldTask = structuredClone(company.tasks[0]);
    append({
      ...requestInput("2026-10-04"),
      kind: "request-correction",
      requestRecordId: root.id,
      previousVersionId: root.id,
    });
    expect(agencyTaskContext(company, oldTask)?.state).toBe("updated");
    expect((await patch(payload(root.id, root.id))).status).toBe(409);
    const next = await save();
    expect(next.dueDate).toBe("2026-10-04");
    expect(company.tasks[0]).toEqual(oldTask);
    expect(company.tasks).toHaveLength(2);
  });

  it("기존 기관 연결 위조/삭제 시도는 보존하고 일반 신규 업무에는 연결을 주입할 수 없다", async () => {
    append();
    const first = await save();
    const forged = { requestRecordId: randomUUID(), requestVersionId: randomUUID() };
    for (const agencyOrigin of [forged, undefined]) {
      company = state.store!.mutate(
        company.id,
        {
          action: "task",
          revision: company.revision,
          task: { ...first, title: "편집 업무", agencyOrigin },
        },
        () => [],
      );
      expect(company.tasks[0].agencyOrigin).toEqual(first.agencyOrigin);
    }
    company = state.store!.mutate(
      company.id,
      {
        action: "task",
        revision: company.revision,
        task: { ...first, id: randomUUID(), agencyOrigin: forged },
      },
      () => [],
    );
    expect(company.tasks[1].agencyOrigin).toBeUndefined();
  });

  it("다른 회사·존재하지 않는 요청은 거부한다", async () => {
    const root = append();
    const other = state.store!.create({ ...emptyProfile(), companyName: "합성 다른 회사" });
    expect((await patch({ ...payload(), revision: other.revision }, other.id)).status).toBe(404);
    expect((await patch(payload(randomUUID(), root.id))).status).toBe(404);
    expect(state.store!.get(other.id).tasks).toEqual([]);
  });

  it.each(["notice", "response"])("%s 기록은 업무의 요청 출처로 사용하지 않는다", async (kind) => {
    const root = append();
    const entry =
      kind === "notice"
        ? append({
            kind: "notice",
            title: "합성 통보",
            body: "합성",
            institution: "합성",
            occurredOn: "",
            note: "",
            sourceIds: [],
            details: { category: "receipt", receiptNumber: "", receivedOn: "", statusText: "" },
          })
        : append({
            kind: "response",
            requestRecordId: root.id,
            previousVersionId: null,
            responseStatus: "draft",
            title: "합성 답변",
            body: "합성",
            occurredOn: "",
            note: "",
            sourceIds: [],
          });
    expect((await patch(payload(entry.id, entry.id))).status).toBe(404);
    expect((await patch(payload(root.id, entry.id))).status).toBe(409);
    expect(state.store!.get(company.id).tasks).toEqual([]);
  });

  it("새 작업의 오래된 회사 버전은 CAS 거부하고 아무 기록도 만들지 않는다", async () => {
    append();
    const before = structuredClone(company);
    expect((await patch({ ...payload(), revision: company.revision - 1 })).status).toBe(409);
    expect(state.store!.get(company.id)).toEqual(before);
  });

  it("공식 입력 잠금 동안 생성과 중복 재사용 모두 차단한다", async () => {
    append();
    const body = payload();
    await withVentureInputCompanyLock(company.id, async () => {
      expect((await patch(body)).status).toBe(409);
    });
    await save(body);
    await withVentureInputCompanyLock(company.id, async () => {
      expect((await patch(body)).status).toBe(409);
    });
  });

  it("200개 한도에서는 새 업무 생성만 차단하고 기존 연결 재사용은 허용한다", async () => {
    append();
    const task = await save();
    const generic: WorkflowTask = {
      id: randomUUID(),
      title: "합성 업무",
      category: "other",
      dueDate: "",
      notes: "",
      status: "pending",
    };
    company.tasks = [
      task,
      ...Array.from({ length: 199 }, () => ({ ...generic, id: randomUUID() })),
    ];
    replace(company);
    const before = structuredClone(company);
    await save();
    expect(company).toEqual(before);
    const root = append(requestInput());
    expect((await patch(payload(root.id, root.id))).status).toBe(413);
    expect(state.store!.get(company.id).tasks).toEqual(before.tasks);
  });

  it("연결된 업무를 삭제한 뒤에만 동일 요청 버전으로 다시 만들 수 있다", async () => {
    append();
    const task = await save();
    company = state.store!.mutate(
      company.id,
      { action: "delete-task", revision: company.revision, taskId: task.id },
      () => [],
    );
    const replacement = await save();
    expect(replacement.id).not.toBe(task.id);
    expect(company.tasks).toHaveLength(1);
  });

  it("위조 필드·URL 매개변수·외부 Origin을 거부하며 기록을 보존한다", async () => {
    append();
    const before = structuredClone(company);
    expect((await patch({ ...payload(), dueDate: "2099-01-01" })).status).toBe(400);
    expect((await patch(payload(), company.id, {}, "?send=true")).status).toBe(400);
    expect(
      (await patch(payload(), company.id, { Origin: "https://untrusted.example" })).status,
    ).toBe(403);
    expect(state.store!.get(company.id)).toEqual(before);
  });

  it("저장 실패 시 업무와 회사 수정 버전이 같은 트랜잭션으로 롤백된다", async () => {
    append();
    const before = structuredClone(company);
    const db = new DatabaseSync(join(directory, "studio.sqlite"));
    try {
      db.exec(
        "CREATE TRIGGER synthetic_task_failure BEFORE UPDATE ON studio_cases BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;",
      );
    } finally {
      db.close();
    }
    expect((await patch(payload())).status).toBe(500);
    expect(state.store!.get(company.id)).toEqual(before);
  });

  it("다른 요청·답변이 뒤에 추가되어도 지정한 요청의 최신 정정 내용만 업무에 복사한다", async () => {
    const first = append(requestInput("2026-10-01"));
    const corrected = append({
      ...requestInput("2026-10-06"),
      kind: "request-correction",
      requestRecordId: first.id,
      previousVersionId: first.id,
      title: "명시 정정된 요청 제목",
      dueNote: "담당자가 기록한 별도 기한 근거",
    });
    const second = append({ ...requestInput("2026-12-01"), title: "관련 없는 다른 요청" });
    append({
      kind: "response",
      requestRecordId: first.id,
      previousVersionId: null,
      responseStatus: "reported-sent",
      title: "수동 기록한 답변",
      body: "발송 주장 기록",
      occurredOn: "2026-09-25",
      note: "",
      sourceIds: [],
    });
    const before = structuredClone(company);
    const task = await save(payload(first.id, corrected.id));
    expect(task).toMatchObject({
      title: "기관 요청 대응: 명시 정정된 요청 제목",
      dueDate: "2026-10-06",
      status: "pending",
      agencyOrigin: { requestRecordId: first.id, requestVersionId: corrected.id },
    });
    expect(task.notes).toContain("담당자가 기록한 별도 기한 근거");
    expect(task.notes).not.toContain("관련 없는 다른 요청");
    expect(agencyTaskContext(company, task)).toMatchObject({
      state: "current",
      latest: { id: corrected.id },
    });
    expect(company.agencyRecords).toEqual(before.agencyRecords);
    expect(company.stageHistory).toEqual(before.stageHistory);
    expect(company.tasks.some((item) => item.agencyOrigin?.requestRecordId === second.id)).toBe(
      false,
    );
  });

  it("정정 기록을 root로 쓰거나 다른 요청의 version을 붙이면 기록을 만들지 않는다", async () => {
    const first = append();
    const correction = append({
      ...requestInput(),
      kind: "request-correction",
      requestRecordId: first.id,
      previousVersionId: first.id,
    });
    const other = append();
    const before = structuredClone(company);
    expect((await patch(payload(correction.id, correction.id))).status).toBe(404);
    expect((await patch(payload(first.id, other.id))).status).toBe(409);
    expect((await patch(payload(other.id, correction.id))).status).toBe(409);
    expect(state.store!.get(company.id)).toEqual(before);
  });

  it("담당자가 업무를 삭제한 뒤 과거 CAS 재전송으로 삭제한 업무가 되살아나지 않는다", async () => {
    append();
    const originalRequest = payload();
    const task = await save(originalRequest);
    company = state.store!.mutate(
      company.id,
      {
        action: "delete-task",
        revision: company.revision,
        taskId: task.id,
      },
      () => [],
    );
    const before = structuredClone(company);
    const response = await patch(originalRequest);
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("STALE_REVISION");
    expect(state.store!.get(company.id)).toEqual(before);
    expect(company.tasks).toEqual([]);
  });

  it("재시작 뒤 같은 요청 재사용은 SQL UPDATE 자체를 수행하지 않는다", async () => {
    append();
    const originalRequest = payload();
    await save(originalRequest);
    const before = structuredClone(company);
    state.store!.close();
    state.store = new StudioStore(directory);
    const db = new DatabaseSync(join(directory, "studio.sqlite"));
    try {
      db.exec(
        "CREATE TRIGGER reject_unneeded_update BEFORE UPDATE ON studio_cases BEGIN SELECT RAISE(ABORT, 'No update permitted during replay'); END;",
      );
    } finally {
      db.close();
    }
    const response = await patch(originalRequest);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(before);
    expect(state.store!.get(company.id)).toEqual(before);
  });

  it("일반 업무 PATCH도 기관 연결을 위조하지 못하며 기존 두 출처의 식별자는 유지한다", async () => {
    const request = append();
    const task = await save();
    const forged = { requestRecordId: randomUUID(), requestVersionId: randomUUID() };
    const generic: WorkflowTask = {
      id: randomUUID(),
      title: "일반 업무",
      category: "other",
      dueDate: "",
      status: "pending",
      notes: "",
      agencyOrigin: forged,
      diagnosisOrigin: { diagnosisId: randomUUID(), actionId: "forged" },
    };
    const created = await patch({ action: "task", revision: company.revision, task: generic });
    expect(created.status).toBe(200);
    company = await created.json();
    expect(company.tasks.at(-1)).not.toHaveProperty("agencyOrigin");
    expect(company.tasks.at(-1)).not.toHaveProperty("diagnosisOrigin");
    const edited = await patch({
      action: "task",
      revision: company.revision,
      task: { ...task, title: "담당자가 고친 제목", agencyOrigin: forged },
    });
    expect(edited.status).toBe(200);
    company = await edited.json();
    expect(company.tasks.find((item) => item.id === task.id)?.agencyOrigin).toEqual({
      requestRecordId: request.id,
      requestVersionId: request.id,
    });
    expect(company.agencyRecords).toHaveLength(1);
  });

  it("기존 일반 업무는 연결 없음, 소실된 버전 참조는 missing으로 표시한다", async () => {
    append();
    const task = await save();
    const legacy = { ...task };
    delete legacy.agencyOrigin;
    expect(agencyTaskContext(company, legacy)).toBeNull();
    expect(
      agencyTaskContext(company, {
        ...task,
        agencyOrigin: {
          requestRecordId: task.agencyOrigin!.requestRecordId,
          requestVersionId: randomUUID(),
        },
      })?.state,
    ).toBe("missing");
    expect(agencyTaskContext({ ...company, agencyRecords: [] }, task)?.state).toBe("missing");
  });
});
