import { describe, it, expect } from "vitest";
import { caseSchema, taskSchema } from "@/lib/studio-schema";
import {
  certificateTaskFixture,
  certificateTaskResult,
  agencyId,
} from "../../../scripts/fixtures/certificate-task-receipt";
import { certificateTaskSaveAcknowledged } from "./certificate-task-response";
type Fixture = ReturnType<typeof certificateTaskFixture>;
describe("exact certificate preparation task response", () => {
  it("accepts only the exact new task, preserving original records and input", () => {
    const f = certificateTaskFixture(),
      copy = structuredClone(f);
    expect(certificateTaskSaveAcknowledged(f.saved, f.company, f.request)).toBe(true);
    expect(f).toEqual(copy);
  });
  const failures: [string, (f: Fixture) => void][] = [
    [
      "missing task",
      (f) => {
        f.saved.tasks.pop();
      },
    ],
    [
      "additional task",
      (f) => {
        f.saved.tasks.push({ ...f.saved.tasks.at(-1)!, id: agencyId(99) });
      },
    ],
    [
      "title",
      (f) => {
        f.saved.tasks.at(-1)!.title = "다른 제목";
      },
    ],
    [
      "notes",
      (f) => {
        f.saved.tasks.at(-1)!.notes = "다른 내용";
      },
    ],
    [
      "date",
      (f) => {
        f.saved.tasks.at(-1)!.dueDate = "2029-09-24";
      },
    ],
    [
      "category",
      (f) => {
        f.saved.tasks.at(-1)!.category = "evidence";
      },
    ],
    [
      "status",
      (f) => {
        f.saved.tasks.at(-1)!.status = "done";
      },
    ],
    [
      "owners",
      (f) => {
        f.saved.tasks.at(-1)!.owners = { materials: "다른 담당", writing: "", review: "" };
      },
    ],
    [
      "notice root",
      (f) => {
        f.saved.tasks.at(-1)!.certificateOrigin!.noticeRecordId = agencyId(98);
      },
    ],
    [
      "notice version",
      (f) => {
        f.saved.tasks.at(-1)!.certificateOrigin!.noticeVersionId = agencyId(80);
      },
    ],
    [
      "recorded expiry",
      (f) => {
        f.saved.tasks.at(-1)!.certificateOrigin!.validUntil = "2028-09-24";
      },
    ],
    [
      "original chosen date",
      (f) => {
        f.saved.tasks.at(-1)!.certificateOrigin!.preparationOn = "2029-08-01";
      },
    ],
    [
      "existing edited task",
      (f) => {
        f.saved.tasks[0].notes = "변경";
      },
    ],
    [
      "task order",
      (f) => {
        f.saved.tasks.reverse();
      },
    ],
    [
      "duplicate task id",
      (f) => {
        f.saved.tasks.at(-1)!.id = f.saved.tasks[0].id;
      },
    ],
    [
      "duplicate existing origin",
      (f) => {
        f.company.tasks.push(
          { ...f.saved.tasks.at(-1)!, id: agencyId(97) },
          { ...f.saved.tasks.at(-1)!, id: agencyId(96) },
        );
      },
    ],
    [
      "duplicate notice id",
      (f) => {
        f.company.agencyRecords.push(structuredClone(f.company.agencyRecords.at(-1)!));
      },
    ],
    [
      "duplicate notice version",
      (f) => {
        f.company.agencyRecords.at(-1)!.version = 1;
      },
    ],
    [
      "old notice request",
      (f) => {
        f.request.noticeVersionId = agencyId(80);
      },
    ],
    [
      "missing root",
      (f) => {
        f.company.agencyRecords = f.company.agencyRecords.filter((r) => r.id !== agencyId(80));
      },
    ],
    [
      "changed category",
      (f) => {
        const n = f.company.agencyRecords.at(-1)!;
        if (n.kind === "notice-correction")
          n.details = { category: "decision", decisionText: "정정됨", notifiedOn: "", reasons: "" };
        f.saved.agencyRecords = structuredClone(f.company.agencyRecords);
      },
    ],
    [
      "invalid date",
      (f) => {
        f.request.preparationOn = "2029-02-30";
      },
    ],
    [
      "empty date",
      (f) => {
        f.request.preparationOn = "";
      },
    ],
    [
      "company",
      (f) => {
        f.saved.id = agencyId(99);
      },
    ],
    [
      "old revision",
      (f) => {
        f.saved.revision = f.company.revision - 1;
      },
    ],
    [
      "new task without new revision",
      (f) => {
        f.saved.revision = f.company.revision;
      },
    ],
    [
      "command revision",
      (f) => {
        f.request.revision--;
      },
    ],
    [
      "profile",
      (f) => {
        f.saved.profile.companyName = "다른 회사";
      },
    ],
    [
      "plan",
      (f) => {
        f.saved.plans[0].content.title = "다른 원고";
      },
    ],
    [
      "notice body",
      (f) => {
        f.saved.agencyRecords.at(-1)!.body = "다른 원문";
      },
    ],
    [
      "stage",
      (f) => {
        f.saved.stage = "preparing";
      },
    ],
    [
      "malformed",
      (f) => {
        Object.assign(f.saved, { tasks: null });
      },
    ],
  ];
  it.each(failures)("rejects %s", (_, alter) => {
    const f = certificateTaskFixture();
    alter(f);
    expect(certificateTaskSaveAcknowledged(f.saved, f.company, f.request)).toBe(false);
  });
  it("confirms an already visible owner-edited task without resetting the date or completion", () => {
    const f = certificateTaskFixture();
    f.company = structuredClone(f.saved);
    const task = f.company.tasks.at(-1)!;
    task.title = "담당자가 편집";
    task.dueDate = "2029-06-01";
    task.status = "done";
    task.notes = "원래 편집";
    task.owners = { materials: "담당", writing: "", review: "" };
    f.request.revision = f.company.revision;
    expect(certificateTaskSaveAcknowledged(structuredClone(f.company), f.company, f.request)).toBe(
      true,
    );
    const changed = structuredClone(f.company);
    changed.tasks.at(-1)!.dueDate = f.request.preparationOn;
    expect(certificateTaskSaveAcknowledged(changed, f.company, f.request)).toBe(false);
    const otherDate = { ...f.request, preparationOn: "2029-08-01" };
    expect(certificateTaskSaveAcknowledged(f.company, f.company, otherDate)).toBe(false);
  });
  it("allows an explicitly chosen date when the notice expiry is unknown", () => {
    const f = certificateTaskFixture(),
      n = f.company.agencyRecords.at(-1)!;
    if (n.kind === "notice-correction" && n.details.category === "certificate")
      n.details.validUntil = "";
    expect(
      certificateTaskSaveAcknowledged(
        certificateTaskResult(f.company, f.request),
        f.company,
        f.request,
      ),
    ).toBe(true);
  });
  it("accepts the 200th task and rejects creating a 201st", () => {
    const f = certificateTaskFixture();
    while (f.company.tasks.length < 199)
      f.company.tasks.push(
        taskSchema.parse({
          id: agencyId(200 + f.company.tasks.length),
          title: "합성 업무",
          category: "other",
          status: "pending",
          dueDate: "",
          notes: "",
        }),
      );
    const saved = certificateTaskResult(f.company, f.request);
    expect(saved.tasks).toHaveLength(200);
    expect(certificateTaskSaveAcknowledged(saved, f.company, f.request)).toBe(true);
    f.company.tasks.push(
      taskSchema.parse({
        id: agencyId(500),
        title: "마지막 업무",
        category: "other",
        status: "pending",
        dueDate: "",
        notes: "",
      }),
    );
    expect(certificateTaskSaveAcknowledged(caseSchema.parse(saved), f.company, f.request)).toBe(
      false,
    );
  });
});
