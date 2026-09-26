import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowTask } from "@/lib/studio-schema";
import { TaskOwnersEditor, TaskOwnersSummary } from "./task-owners";
import { workflowTaskDirty } from "./workflow-panel";

const owners = { materials: "자료 준비자", writing: "작성자", review: "확인 담당자" };
const blankTask: WorkflowTask = {
  id: "44444444-4444-4444-8444-444444444444",
  title: "",
  category: "evidence",
  dueDate: "",
  notes: "",
  status: "pending",
};

describe("업무 담당자 기록 UI", () => {
  it("이전 업무는 세 역할 모두 미지정이며 권한·알림·확인 완료로 표시하지 않는다", () => {
    const html = renderToStaticMarkup(createElement(TaskOwnersSummary, { owners: undefined }));
    expect(html.match(/미지정/g)).toHaveLength(3);
    for (const label of ["자료 준비 담당자", "작성 담당자", "최종 내용 확인 담당자"])
      expect(html).toContain(label);
    expect(html).toContain("계정 권한이나 검토 완료를 부여하지 않으며 알림을 보내지 않습니다");
  });
  it("저장한 이름을 역할별로 표시하고 HTML은 실행 가능한 요소로 넣지 않는다", () => {
    const html = renderToStaticMarkup(
      createElement(TaskOwnersSummary, {
        owners: { ...owners, review: "<script>synthetic()</script>" },
      }),
    );
    expect(html).toContain(owners.materials);
    expect(html).toContain(owners.writing);
    expect(html).toContain("&lt;script&gt;synthetic()&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });
  it("편집란은 이름 자동 채우기 없이 기존 값과 각 100자 한도를 표시한다", () => {
    const onChange = vi.fn();
    const html = renderToStaticMarkup(createElement(TaskOwnersEditor, { owners, onChange }));
    for (const key of ["materials", "writing", "review"])
      expect(html).toContain(`for="task-owner-${key}"`);
    expect(html.match(/maxLength="100"/g)).toHaveLength(3);
    expect(html.match(/autoComplete="off"/g)).toHaveLength(3);
    for (const name of Object.values(owners)) expect(html).toContain(`value="${name}"`);
    expect(onChange).not.toHaveBeenCalled();
  });
  it("담당자만 입력한 새 업무도 이탈·다른 편집 보호 대상이다", () => {
    expect(workflowTaskDirty(null)).toBe(false);
    expect(workflowTaskDirty(blankTask)).toBe(false);
    expect(
      workflowTaskDirty({ ...blankTask, owners: { materials: "", writing: "", review: "" } }),
    ).toBe(false);
    for (const key of ["materials", "writing", "review"] as const)
      expect(
        workflowTaskDirty({
          ...blankTask,
          owners: { materials: "", writing: "", review: "", [key]: "새 담당자" },
        }),
      ).toBe(true);
  });
  it("기존 이름 변경·명시적 해제는 저장 전 변경이며 원래 값으로 돌아오면 해제된다", () => {
    const saved = { ...blankTask, title: "기존 업무", owners };
    expect(workflowTaskDirty(structuredClone(saved), saved)).toBe(false);
    expect(workflowTaskDirty({ ...saved, owners: { ...owners, review: "다른 이름" } }, saved)).toBe(
      true,
    );
    expect(
      workflowTaskDirty({ ...saved, owners: { materials: "", writing: "", review: "" } }, saved),
    ).toBe(true);
    expect(workflowTaskDirty(structuredClone(blankTask), blankTask)).toBe(false);
  });
});
