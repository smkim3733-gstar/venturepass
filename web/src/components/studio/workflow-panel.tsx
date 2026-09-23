"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, Check, Clock3, Pencil, Plus, Save, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { stageLabels, stageValues, taskSchema, type WorkflowTask } from "@/lib/studio-schema";
import { EmptyPanel, Notice, PanelHeading, selectClass, useDirty, type PanelProps } from "./shared";
import { VisitPreparation } from "./evaluation-preparation";

const categoryLabels = {
  evidence: "자료 준비",
  payment: "수수료 납부",
  supplement: "서류 보완",
  visit: "실사 준비",
  appeal: "이의신청",
  other: "기타 업무",
};
const stageHelp: Record<(typeof stageValues)[number], string> = {
  preparing: "기업자료와 증빙을 모으고 부족한 정보를 확인하세요.",
  drafting: "신청 아이템과 사업계획서, 첨부자료를 검토하세요.",
  submitted:
    "벤처인에서 실제 제출 결과를 확인한 후 기록하세요. 제출 이후에도 접수 전 보완이 발생할 수 있습니다.",
  payment: "기관의 납부 요청과 금액·기한을 확인하고 공식 사이트에서 납부하세요.",
  evaluating: "수수료 납부와 접수완료를 확인한 후 기록하세요. 평가기관의 요청을 확인하세요.",
  visit: "실사 일정을 확인하고 대표 설명·제품 시연·원본 증빙을 준비하세요.",
  decision: "기관이 통보한 최종 결과와 통보일을 기록하세요.",
  appeal:
    "탈락 사유별 소명과 증빙을 준비하세요. 결과 통보일부터 30일 이내 신청 기한과 기관 안내를 확인하세요.",
  confirmed: "공식 사이트의 확인서 발급 결과와 유효기간을 확인하세요.",
  closed: "진행 결과와 후속 개선 과제를 남겨 주세요.",
};
function newTask(): WorkflowTask {
  return {
    id: crypto.randomUUID(),
    title: "",
    category: "evidence",
    dueDate: "",
    status: "pending",
    notes: "",
  };
}
export function WorkflowPanel({ company, mutate, setDirty }: PanelProps) {
  const [stage, setStage] = useState(company.stage);
  const [task, setTask] = useState<WorkflowTask | null>(null);
  useEffect(() => {
    if (!task?.id) return;
    document
      .getElementById("workflow-task-editor")
      ?.scrollIntoView({ block: "start", behavior: "smooth" });
    document.getElementById("task-title")?.focus({ preventScroll: true });
  }, [task?.id]);
  const savedTask = task ? company.tasks.find((item) => item.id === task.id) : null;
  const taskDirty =
    !!task &&
    (savedTask
      ? JSON.stringify(task) !== JSON.stringify(savedTask)
      : !!task.title || !!task.notes || !!task.dueDate);
  const dirty = stage !== company.stage || taskDirty;
  useDirty(dirty, setDirty);
  function startTask(item?: WorkflowTask) {
    if (stage !== company.stage) {
      toast.error("변경한 진행 단계를 먼저 저장해 주세요.");
      return;
    }
    if (taskDirty && !window.confirm("저장하지 않은 업무 편집을 취소할까요?")) return;
    setTask(item ? structuredClone(item) : newTask());
  }
  async function saveTask() {
    if (!task) return;
    if (stage !== company.stage) {
      toast.error("진행 단계를 먼저 저장해 주세요.");
      return;
    }
    const result = taskSchema.safeParse(task);
    if (!result.success) {
      toast.error(result.error.issues[0]?.message || "업무 제목을 확인해 주세요.");
      return;
    }
    await mutate({ action: "task", task: result.data });
  }
  async function saveStage() {
    if (taskDirty) {
      toast.error("업무 편집을 먼저 저장하거나 취소해 주세요.");
      return;
    }
    await mutate({ action: "stage", stage });
  }
  async function toggleTask(item: WorkflowTask) {
    if (dirty) {
      toast.error("편집 중인 내용을 먼저 저장하거나 취소해 주세요.");
      return;
    }
    await mutate({
      action: "task",
      task: { ...item, status: item.status === "done" ? "pending" : "done" },
    });
  }
  const today = new Date().toLocaleDateString("sv-SE");
  const sortedTasks = [...company.tasks].sort(
    (a, b) =>
      Number(a.status === "done") - Number(b.status === "done") ||
      (a.dueDate || "9999").localeCompare(b.dueDate || "9999"),
  );
  return (
    <div>
      <PanelHeading
        title="접수부터 확인서까지 진행 관리"
        description="기관에서 확인한 진행 결과와 담당 업무를 기록하세요. 단계 변경만으로 기관에 신청되거나 서류가 제출되지는 않습니다."
        actions={
          <Button asChild variant="outline">
            <a href="https://www.smes.go.kr/venturein/" target="_blank" rel="noreferrer">
              벤처인 열기
              <ArrowUpRight />
            </a>
          </Button>
        }
      />
      <div className="rounded-2xl border bg-muted/25 p-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-48 flex-1 space-y-2">
            <Label htmlFor="case-stage">현재 진행 단계</Label>
            <select
              id="case-stage"
              className={selectClass}
              disabled={taskDirty}
              value={stage}
              onChange={(event) => setStage(event.target.value as typeof stage)}
            >
              {stageValues.map((value) => (
                <option key={value} value={value}>
                  {stageLabels[value]}
                </option>
              ))}
            </select>
          </div>
          <Button className="h-10" disabled={stage === company.stage} onClick={saveStage}>
            <Save />
            단계 저장
          </Button>
        </div>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">{stageHelp[stage]}</p>
        {(stage === "submitted" || stage === "payment") && (
          <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-6 text-amber-950">
            2026년 7월 1일 시행 안내: 접수 전 신청 보완·수수료 납부 요청 후 15일간 진행하지 않으면
            신청이 취소되거나 제출완료 이전 상태로 변경될 수 있습니다. 추가 신청 보완요청이 있으면
            가장 최근 요청일을 기준으로 확인하세요. 기관이 안내한 기한을 업무에 기록하세요. 현장평가
            중 추가자료 요청은 해당 기관의 별도 안내기한을 확인합니다.{" "}
            <a
              href="https://www.smes.go.kr/venturein/board/viewNotiBoard?menuId=4060000&bbsSvcDvsnCd=&bbsSn=5933"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-4"
            >
              공식 운영 변경 안내
            </a>
          </p>
        )}
      </div>
      <div className="mt-5">
        <Notice>
          공식 사이트 자동 접수·납부와 문자·이메일 수신 연동은 아직 연결되지 않았습니다. 기관 요청을
          아래 업무로 등록해 기한과 완료 여부를 관리할 수 있습니다.
        </Notice>
      </div>
      <VisitPreparation
        company={company}
        onPrepare={(title, notes) => startTask({ ...newTask(), category: "visit", title, notes })}
      />
      <div className="mb-4 mt-7 flex items-center justify-between gap-3">
        <h3 className="font-bold">
          해야 할 일{" "}
          <span className="ml-1 text-primary">
            {company.tasks.filter((item) => item.status === "pending").length}
          </span>
        </h3>
        <Button
          variant="outline"
          disabled={company.tasks.length >= 200}
          onClick={() => startTask()}
        >
          <Plus />
          업무 추가
        </Button>
      </div>
      {task && (
        <section
          id="workflow-task-editor"
          aria-label="업무 편집"
          className="mb-5 scroll-mt-24 rounded-2xl border border-primary/30 bg-primary/[.025] p-5"
        >
          <div className="mb-4 flex items-center justify-between">
            <h4 className="font-semibold">{savedTask ? "업무 수정" : "새 업무"}</h4>
            <Button
              variant="ghost"
              size="icon"
              aria-label="업무 편집 취소"
              onClick={() => {
                if (!taskDirty || window.confirm("저장하지 않은 업무를 취소할까요?")) setTask(null);
              }}
            >
              <X />
            </Button>
          </div>
          <div className="space-y-2">
            <Label htmlFor="task-title">업무 제목 *</Label>
            <Input
              id="task-title"
              maxLength={300}
              value={task.title}
              onChange={(event) => setTask({ ...task, title: event.target.value })}
              placeholder="예: 기술 시험성적서 보완 제출"
            />
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="task-category">분류</Label>
              <select
                id="task-category"
                className={selectClass}
                value={task.category}
                onChange={(event) =>
                  setTask({ ...task, category: event.target.value as WorkflowTask["category"] })
                }
              >
                {Object.entries(categoryLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="task-due-date">마감일</Label>
              <Input
                id="task-due-date"
                type="date"
                value={task.dueDate}
                onInput={(event) => setTask({ ...task, dueDate: event.currentTarget.value })}
                onChange={(event) => setTask({ ...task, dueDate: event.target.value })}
              />
            </div>
          </div>
          <div className="mt-4 space-y-2">
            <Label htmlFor="task-notes">요청 내용·담당자·메모</Label>
            <Textarea
              id="task-notes"
              className="min-h-28 bg-white leading-7"
              maxLength={10000}
              value={task.notes}
              onChange={(event) => setTask({ ...task, notes: event.target.value })}
              placeholder="기관에서 받은 요청, 담당자, 준비할 자료를 입력하세요."
            />
          </div>
          <div className="mt-4 flex justify-end">
            <Button onClick={saveTask}>
              <Save />
              업무 저장
            </Button>
          </div>
        </section>
      )}
      {sortedTasks.length === 0 ? (
        <EmptyPanel
          title="다음 할 일을 등록하세요"
          description="자료 보강, 납부, 보완 제출, 실사 준비와 이의신청을 기한별로 관리할 수 있습니다."
        />
      ) : (
        <div className="space-y-3">
          {sortedTasks.map((item) => {
            const overdue = !!item.dueDate && item.dueDate < today && item.status !== "done";
            return (
              <article key={item.id} className="rounded-xl border bg-white p-4">
                <div className="flex items-start gap-3">
                  <button
                    type="button"
                    onClick={() => toggleTask(item)}
                    className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border ${item.status === "done" ? "border-primary bg-primary text-white" : "border-slate-300 hover:border-primary"}`}
                    aria-label={`${item.title} ${item.status === "done" ? "다시 진행" : "완료 처리"}`}
                  >
                    {item.status === "done" && <Check className="size-4" />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="mb-2 flex flex-wrap gap-2">
                      <Badge variant="secondary">{categoryLabels[item.category]}</Badge>
                      {item.dueDate && (
                        <span
                          className={`flex items-center gap-1 text-xs ${overdue ? "font-semibold text-destructive" : "text-muted-foreground"}`}
                        >
                          <Clock3 className="size-3" />
                          {item.dueDate}
                          {overdue && " · 기한 경과"}
                        </span>
                      )}
                      {item.status === "done" && (
                        <Badge variant="outline" className="text-primary">
                          완료
                        </Badge>
                      )}
                    </div>
                    <h4
                      className={`text-sm font-semibold ${item.status === "done" ? "text-muted-foreground line-through" : ""}`}
                    >
                      {item.title}
                    </h4>
                    {item.notes && (
                      <p className="mt-2 whitespace-pre-wrap text-xs leading-6 text-muted-foreground">
                        {item.notes}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`${item.title} 수정`}
                      onClick={() => startTask(item)}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-destructive"
                      aria-label={`${item.title} 삭제`}
                      onClick={() => {
                        if (dirty) {
                          toast.error("편집 중인 내용을 먼저 저장해 주세요.");
                          return;
                        }
                        if (window.confirm("이 업무를 삭제할까요?"))
                          void mutate({ action: "delete-task", taskId: item.id });
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
