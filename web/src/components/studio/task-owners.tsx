"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { WorkflowTask } from "@/lib/studio-schema";

type TaskOwners = NonNullable<WorkflowTask["owners"]>;
const roles = [
  { key: "materials", label: "자료 준비 담당자" },
  { key: "writing", label: "작성 담당자" },
  { key: "review", label: "최종 내용 확인 담당자" },
] as const;
const emptyOwners: TaskOwners = { materials: "", writing: "", review: "" };
const explanation =
  "담당자 이름을 기록합니다. 계정 권한이나 검토 완료를 부여하지 않으며 알림을 보내지 않습니다.";

export function TaskOwnersEditor({
  owners,
  onChange,
}: {
  owners: WorkflowTask["owners"];
  onChange: (owners: TaskOwners) => void;
}) {
  return (
    <fieldset className="mt-4 space-y-3">
      <legend className="text-sm font-semibold">업무 담당자 (선택)</legend>
      <div className="grid gap-4 sm:grid-cols-3">
        {roles.map(({ key, label }) => (
          <div key={key} className="space-y-2">
            <Label htmlFor={`task-owner-${key}`}>{label}</Label>
            <Input
              id={`task-owner-${key}`}
              maxLength={100}
              autoComplete="off"
              value={owners?.[key] ?? ""}
              placeholder="미지정"
              onChange={(event) =>
                onChange({ ...(owners ?? emptyOwners), [key]: event.target.value })
              }
            />
          </div>
        ))}
      </div>
      <p className="text-xs leading-6 text-muted-foreground">{explanation}</p>
    </fieldset>
  );
}

export function TaskOwnersSummary({ owners }: { owners: WorkflowTask["owners"] }) {
  return (
    <div className="mt-2 text-xs leading-6 text-muted-foreground">
      <dl className="grid gap-x-4 sm:grid-cols-3">
        {roles.map(({ key, label }) => (
          <div key={key} className="min-w-0">
            <dt>{label}</dt>
            <dd className="break-words font-medium text-foreground">
              {owners?.[key].trim() || "미지정"}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-1">{explanation}</p>
    </div>
  );
}
