"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  ArrowRight,
  Check,
  ClipboardList,
  ExternalLink,
  FileCheck2,
  HardDrive,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  applicationSchema,
  getEvidenceItems,
  getPreparationTrack,
  type ApplicationProfile,
  type EvidenceItem,
} from "@/lib/application";
import {
  useWorkspaceHydrated,
  useWorkspaceHydrationProblem,
  useWorkspaceStore,
} from "@/lib/workspace-store";
import { cn } from "@/lib/utils";

const EMPTY_PROFILE: ApplicationProfile = {
  companyName: "",
  startDate: "",
  applicationDate: "",
  applicationKind: "new",
  industry: "",
  technologyName: "",
};

const INDUSTRIES = [
  "제조업",
  "정보처리·소프트웨어",
  "연구개발서비스",
  "건설·운수",
  "도소매·유통",
  "농림·어업",
  "기타",
];
const CATEGORIES: EvidenceItem["category"][] = ["기본 서류", "기술혁신성", "사업성장성"];
const selectClass =
  "h-11 w-full rounded-lg border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30 aria-invalid:border-destructive";

function ProfileForm({
  profile,
  onSave,
}: {
  profile: ApplicationProfile | null;
  onSave: (values: ApplicationProfile) => void;
}) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<ApplicationProfile>({
    resolver: zodResolver(applicationSchema),
    defaultValues: profile ?? EMPTY_PROFILE,
  });

  function fieldError(name: keyof ApplicationProfile) {
    return errors[name] ? (
      <p id={`${name}-error`} className="text-xs text-destructive" role="alert">
        {errors[name]?.message}
      </p>
    ) : null;
  }

  return (
    <form onSubmit={handleSubmit(onSave)} noValidate className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="companyName">
          기업명 <span className="text-primary">*</span>
        </Label>
        <Input
          id="companyName"
          placeholder="사업자등록증의 기업명"
          autoComplete="organization"
          className="h-11"
          {...register("companyName")}
          aria-invalid={Boolean(errors.companyName)}
          aria-describedby={errors.companyName ? "companyName-error" : undefined}
        />
        {fieldError("companyName")}
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="startDate">
            설립·사업개시일 <span className="text-primary">*</span>
          </Label>
          <Input
            id="startDate"
            type="date"
            min="1900-01-01"
            max="2200-12-31"
            className="h-11 min-w-0"
            {...register("startDate")}
            aria-invalid={Boolean(errors.startDate)}
            aria-describedby="startDate-help startDate-error"
          />
          <p id="startDate-help" className="text-xs leading-relaxed text-muted-foreground">
            법인은 설립등기일, 개인은 사업개시일을 입력하세요.
          </p>
          {fieldError("startDate")}
        </div>
        <div className="space-y-2">
          <Label htmlFor="applicationDate">
            신청예정일 <span className="text-primary">*</span>
          </Label>
          <Input
            id="applicationDate"
            type="date"
            min="1900-01-01"
            max="2200-12-31"
            className="h-11 min-w-0"
            {...register("applicationDate")}
            aria-invalid={Boolean(errors.applicationDate)}
            aria-describedby={errors.applicationDate ? "applicationDate-error" : undefined}
          />
          {fieldError("applicationDate")}
        </div>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="applicationKind">
            신청 구분 <span className="text-primary">*</span>
          </Label>
          <select id="applicationKind" className={selectClass} {...register("applicationKind")}>
            <option value="new">신규 신청</option>
            <option value="renewal">재확인 신청</option>
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="industry">
            업종 <span className="text-primary">*</span>
          </Label>
          <select
            id="industry"
            className={selectClass}
            {...register("industry")}
            aria-invalid={Boolean(errors.industry)}
            aria-describedby={errors.industry ? "industry-error" : undefined}
          >
            <option value="" disabled>
              주요 업종 선택
            </option>
            {INDUSTRIES.map((industry) => (
              <option key={industry} value={industry}>
                {industry}
              </option>
            ))}
          </select>
          {fieldError("industry")}
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="technologyName">
          신청 기술·서비스명 <span className="text-primary">*</span>
        </Label>
        <Input
          id="technologyName"
          placeholder="예: AI 기반 제조설비 이상 탐지 솔루션"
          className="h-11"
          {...register("technologyName")}
          aria-invalid={Boolean(errors.technologyName)}
          aria-describedby={errors.technologyName ? "technologyName-error" : undefined}
        />
        {fieldError("technologyName")}
        <p className="text-xs text-muted-foreground">
          이번 신청에서 기술혁신성과 성장성을 설명할 대상입니다.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t pt-5">
        <Button type="submit" className="h-11 gap-2">
          <Save className="size-4" />
          기업 정보 저장
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={!isDirty}
          onClick={() => reset(profile ?? EMPTY_PROFILE)}
          className="gap-2"
        >
          <RotateCcw className="size-4" />
          입력 되돌리기
        </Button>
      </div>
      {profile && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          기업 정보를 변경해 저장하면, 기존 항목의 검토 기록은 초기화됩니다.
        </p>
      )}
    </form>
  );
}

export function ApplicationWorkspace() {
  const hydrated = useWorkspaceHydrated();
  const hydrationProblem = useWorkspaceHydrationProblem();
  const profile = useWorkspaceStore((state) => state.profile);
  const checkedEvidence = useWorkspaceStore((state) => state.checkedEvidence);
  const saveProfile = useWorkspaceStore((state) => state.saveProfile);
  const toggleEvidence = useWorkspaceStore((state) => state.toggleEvidence);
  const resetWorkspace = useWorkspaceStore((state) => state.resetWorkspace);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const track = profile ? getPreparationTrack(profile) : null;
  const evidence = track ? getEvidenceItems(track.id) : [];
  const reviewedCount = evidence.filter((item) => checkedEvidence.includes(item.id)).length;

  function handleSave(values: ApplicationProfile) {
    try {
      saveProfile(values);
      toast.success("이 브라우저에 기업 정보를 저장했습니다.");
    } catch {
      toast.error("브라우저에 저장하지 못했습니다. 저장 공간과 브라우저 설정을 확인해 주세요.");
    }
  }

  function handleToggle(id: string) {
    try {
      toggleEvidence(id);
    } catch {
      toast.error("검토 기록을 저장하지 못했습니다. 브라우저 저장 설정을 확인해 주세요.");
    }
  }

  function handleReset() {
    try {
      resetWorkspace();
      setDeleteOpen(false);
      toast.success("저장된 기업 정보와 검토 기록을 삭제했습니다.");
    } catch {
      toast.error("저장 기록을 삭제하지 못했습니다. 브라우저 저장 설정을 확인해 주세요.");
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold tracking-wide text-primary">
            <ClipboardList className="size-4" /> INNOVATION GROWTH
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">신청 준비</h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            기업 정보를 바탕으로 준비 경로를 확인하고, 기술과 성장성을 설명할 근거를 하나씩
            정리하세요.
          </p>
        </div>
        <Badge variant="outline" className="gap-1.5 rounded-full px-3 py-1.5 text-xs">
          <HardDrive className="size-3.5" />
          브라우저 저장
        </Badge>
      </div>

      {hydrated && hydrationProblem && (
        <p
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-relaxed text-amber-900"
          role="alert"
        >
          {hydrationProblem}
        </p>
      )}

      {!hydrated ? (
        <div
          className="grid gap-6 lg:grid-cols-[1.3fr_1fr]"
          aria-label="저장된 준비 정보를 불러오는 중"
          role="status"
        >
          <Skeleton className="h-[550px] rounded-2xl" />
          <Skeleton className="h-72 rounded-2xl" />
        </div>
      ) : (
        <>
          <div className="grid items-start gap-6 xl:grid-cols-[1.25fr_1fr]">
            <Card className="rounded-2xl border-border/80 shadow-none">
              <CardHeader className="border-b pb-6">
                <CardTitle className="flex items-center gap-3 text-lg">
                  <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-sm text-primary">
                    01
                  </span>
                  기업 기본 정보
                </CardTitle>
                <CardDescription className="pt-1">
                  필수 정보를 저장하면 준비할 항목을 확인할 수 있습니다.
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-6">
                <ProfileForm key={JSON.stringify(profile)} profile={profile} onSave={handleSave} />
              </CardContent>
            </Card>

            <div className="space-y-5">
              <Card className="overflow-hidden rounded-2xl border-primary/15 bg-primary/[0.035] shadow-none">
                <CardHeader>
                  <CardDescription className="font-medium text-primary">
                    입력 정보에 따른 준비 경로
                  </CardDescription>
                  <CardTitle className="pt-2 text-2xl">
                    {track?.label ?? "우리 기업의 경로 찾기"}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  <p className="text-sm leading-7 text-muted-foreground">
                    {track?.description ??
                      "신청 구분과 설립·사업개시일, 신청예정일을 입력하면 우리 기업의 준비 방향을 안내합니다."}
                  </p>
                  {track ? (
                    <div className="space-y-3">
                      <p className="text-xs font-semibold text-foreground">
                        중점적으로 정리할 근거
                      </p>
                      {track.focus.map((focus) => (
                        <div key={focus} className="flex items-center gap-2 text-sm">
                          <Check className="size-4 text-primary" />
                          {focus}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="space-y-3 rounded-xl bg-background/80 p-4 text-sm">
                      {["신규 · 3년 미만", "신규 · 3년 이상", "재확인"].map((label) => (
                        <div key={label} className="flex items-center justify-between">
                          <span>{label}</span>
                          <ArrowRight className="size-4 text-muted-foreground" />
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="border-t border-primary/10 pt-4 text-xs leading-relaxed text-muted-foreground">
                    입력한 날짜 기준의 준비 안내입니다. 실제 적용 경로와 제출서류는 공식 신청화면의
                    기준을 확인해 주세요.
                  </p>
                </CardContent>
              </Card>
              <div className="rounded-2xl border bg-background p-5">
                <div className="flex gap-3">
                  <HardDrive className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">이 기기에서 이어서 준비</p>
                    <p className="mt-2 text-xs leading-6 text-muted-foreground">
                      기업 정보와 검토 체크만 현재 브라우저에 저장합니다. 같은 브라우저에서 다시
                      열면 복원되며, 다른 기기와 동기화되지 않습니다. 브라우저 데이터를 지우면
                      기록도 삭제됩니다.
                    </p>
                  </div>
                </div>
                {profile && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-3 gap-2 text-muted-foreground hover:text-destructive"
                    onClick={() => setDeleteOpen(true)}
                  >
                    <Trash2 className="size-3.5" />
                    저장 기록 삭제
                  </Button>
                )}
              </div>
            </div>
          </div>

          <section className="space-y-5" aria-labelledby="evidence-heading">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h2 id="evidence-heading" className="text-xl font-bold tracking-tight">
                  근거자료 검토
                </h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  각 항목의 목적과 자료 예시를 확인하고 검토한 항목을 기록하세요.
                </p>
              </div>
              {track && (
                <Badge
                  variant="secondary"
                  className="rounded-full px-3 py-1.5 font-medium"
                  aria-live="polite"
                >
                  {evidence.length}개 항목 중 {reviewedCount}개 검토
                </Badge>
              )}
            </div>
            {!track ? (
              <div className="flex flex-col items-center rounded-2xl border border-dashed bg-background px-6 py-14 text-center">
                <span className="mb-4 rounded-2xl bg-muted p-4">
                  <FileCheck2 className="size-6 text-muted-foreground" />
                </span>
                <h3 className="text-sm font-semibold">기업 정보를 먼저 저장해 주세요</h3>
                <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                  신규·재확인과 업력에 맞는 기본 서류, 기술혁신성, 사업성장성 항목을 표시합니다.
                </p>
              </div>
            ) : (
              <>
                <div className="rounded-xl bg-muted/60 px-4 py-3 text-xs leading-6 text-muted-foreground">
                  체크는 사용자가 근거를 검토했다는 기록입니다. 자료의 적합성 검증이나 심사 점수가
                  아니며, 해당하지 않는 항목은 체크하지 않아도 됩니다. 서류의 발급일·대상 기간과
                  자동연계 여부는 공식 신청 시 확인하세요.
                </div>
                <div className="space-y-5">
                  {CATEGORIES.map((category) => (
                    <Card
                      key={category}
                      className="gap-0 overflow-hidden rounded-2xl py-0 shadow-none"
                    >
                      <CardHeader className="border-b bg-muted/25 py-5">
                        <CardTitle className="flex items-center justify-between text-base">
                          {category}
                          <span className="text-xs font-normal text-muted-foreground">
                            {evidence.filter((item) => item.category === category).length}개 항목
                          </span>
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="divide-y px-0">
                        {evidence
                          .filter((item) => item.category === category)
                          .map((item) => {
                            const checked = checkedEvidence.includes(item.id);
                            return (
                              <div
                                key={item.id}
                                className={cn(
                                  "flex gap-4 px-6 py-5 transition-colors",
                                  checked && "bg-primary/[0.035]",
                                )}
                              >
                                <Checkbox
                                  id={`evidence-${item.id}`}
                                  checked={checked}
                                  onCheckedChange={() => handleToggle(item.id)}
                                  className="mt-0.5 size-5 shrink-0"
                                  aria-label={`${item.title} 검토 기록`}
                                  aria-describedby={`evidence-purpose-${item.id}`}
                                />
                                <div className="min-w-0 flex-1">
                                  <label
                                    htmlFor={`evidence-${item.id}`}
                                    className="cursor-pointer text-sm font-semibold leading-5"
                                  >
                                    {item.title}
                                  </label>
                                  <p
                                    id={`evidence-purpose-${item.id}`}
                                    className="mt-1.5 text-sm leading-6 text-muted-foreground"
                                  >
                                    {item.purpose}
                                  </p>
                                  <p className="mt-2 text-xs leading-6 text-muted-foreground">
                                    <span className="font-medium text-foreground/75">
                                      자료 예시
                                    </span>{" "}
                                    · {item.example}
                                  </p>
                                </div>
                                {checked && (
                                  <span className="hidden shrink-0 text-xs font-medium text-primary sm:block">
                                    검토 기록됨
                                  </span>
                                )}
                              </div>
                            );
                          })}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </>
            )}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs leading-6 text-muted-foreground">
              <span>참고: 2026 벤처기업확인제도 가이드북 p.27–28, 34–36</span>
              <a
                href="https://www.smes.go.kr/venturein/institution/requireGuide?rgCd=C"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
              >
                공식 혁신성장유형 안내
                <ExternalLink className="size-3" />
              </a>
            </div>
          </section>
        </>
      )}

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>저장 기록을 삭제할까요?</DialogTitle>
            <DialogDescription>
              이 브라우저에 저장된 기업 기본 정보와 모든 항목의 검토 기록이 삭제됩니다. 삭제한
              기록은 복원할 수 없습니다.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              취소
            </Button>
            <Button variant="destructive" onClick={handleReset}>
              저장 기록 삭제
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
