"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  CheckCircle2,
  Circle,
  FileStack,
  FileText,
  FolderOpen,
  ListChecks,
  KeyRound,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  emptyProfile,
  caseSchema,
  stageLabels,
  type CaseSummary,
  type CompanyProfile,
  type SourceDocument,
  type StudioCase,
  type StudioStatus,
} from "@/lib/studio-schema";
import { summarizeCase } from "@/lib/studio-case-summary";
import { cn } from "@/lib/utils";
import { ProfileEditor } from "./profile-editor";
import { SourcesPanel, type SourceExtractionMode } from "./sources-panel";
import { SourceIntakesPanel } from "./source-intakes-panel";
import { SourceSuggestionsPanel } from "./source-suggestions-panel";
import { SourceImpactPanel, type SourceImpactNavigation } from "./source-impact-panel";
import {
  sourceImpactNavigationIsCurrent,
  sourceImpactKindLabels,
} from "@/lib/studio-source-impact";
import { DiagnosisPanel } from "./diagnosis-panel";
import { PreparationPanel } from "./preparation-panel";
import { PreparationAutomationPanel } from "./preparation-automation-panel";
import { AnalysisPanel } from "./analysis-panel";
import { PlanEditor } from "./plan-editor";
import { WorkflowPanel } from "./workflow-panel";
import { VentureinPanel } from "./venturein-panel";
import {
  CaseAttentionCard,
  useLocalDay,
  selectCaseSummaries,
  type CaseAttentionFilter,
  type CaseAttentionSort,
} from "./case-attention";
import {
  EmptyPanel,
  Loading,
  Notice,
  StudioApiError,
  formatDate,
  jsonBody,
  selectClass,
  studioFetch,
  type StudioMutation,
} from "./shared";

type StudioTab =
  "profile" | "sources" | "diagnosis" | "analysis" | "plan" | "workflow" | "venturein";
type GenerationOperation = "analyze" | "plan";
const tabs: { value: StudioTab; title: string; icon: typeof Building2 }[] = [
  { value: "profile", title: "기업정보", icon: Building2 },
  { value: "sources", title: "자료함", icon: FolderOpen },
  { value: "diagnosis", title: "사전진단", icon: CheckCircle2 },
  { value: "analysis", title: "아이템 분석", icon: Sparkles },
  { value: "plan", title: "사업계획서", icon: FileText },
  { value: "workflow", title: "진행 관리", icon: ListChecks },
  { value: "venturein", title: "벤처인 연결", icon: KeyRound },
];

export function StudioWorkspace() {
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [status, setStatus] = useState<StudioStatus | null>(null);
  const [company, setCompany] = useState<StudioCase | null>(null);
  const [tab, setTab] = useState<StudioTab>("profile");
  const [impactNavigation, setImpactNavigation] = useState<SourceImpactNavigation | null>(null);
  const [panelDirty, setDirty] = useState(false);
  const [intakeDirty, setIntakeDirty] = useState(false);
  const [suggestionDirty, setSuggestionDirty] = useState(false);
  const [automationUnsettled, setAutomationUnsettled] = useState(false);
  const [manualPreparationUnsettled, setManualPreparationUnsettled] = useState(false);
  const editorDirty = panelDirty || intakeDirty || suggestionDirty;
  const dirty = editorDirty || automationUnsettled || manualPreparationUnsettled;
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [attentionFilter, setAttentionFilter] = useState<CaseAttentionFilter>("all");
  const [attentionSort, setAttentionSort] = useState<CaseAttentionSort>("due-date");
  const today = useLocalDay();
  const openRequest = useRef(0);
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createIndustry, setCreateIndustry] = useState("");
  const [createKind, setCreateKind] = useState<CompanyProfile["applicationKind"]>("new");
  const [settings, setSettings] = useState(false);
  const [generation, setGeneration] = useState<GenerationOperation | null>(null);
  const [mode, setMode] = useState<"ai" | "assisted" | null>(null);
  useEffect(() => {
    return () => {
      openRequest.current += 1;
    };
  }, []);
  const refresh = useCallback(async () => {
    try {
      const [available, list] = await Promise.all([
        studioFetch<StudioStatus>("/api/studio/status"),
        studioFetch<{ cases: CaseSummary[] }>("/api/studio/cases"),
      ]);
      setStatus(available);
      setCases(list.cases);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "작업공간을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    let active = true;
    Promise.all([
      studioFetch<StudioStatus>("/api/studio/status"),
      studioFetch<{ cases: CaseSummary[] }>("/api/studio/cases"),
    ])
      .then(([available, list]) => {
        if (!active) return;
        setStatus(available);
        setCases(list.cases);
      })
      .catch((caught: unknown) => {
        if (active)
          setError(caught instanceof Error ? caught.message : "작업공간을 불러오지 못했습니다.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    function unload(event: BeforeUnloadEvent) {
      if (dirty || busy || (creating && (createName || createIndustry))) {
        event.preventDefault();
        event.returnValue = "";
      }
    }
    function navigate(event: MouseEvent) {
      const anchor = (event.target as Element | null)?.closest("a");
      if (
        !anchor ||
        anchor.hasAttribute("download") ||
        anchor.target === "_blank" ||
        event.ctrlKey ||
        event.metaKey
      )
        return;
      const destination = new URL(anchor.href, window.location.href);
      if (
        destination.pathname === window.location.pathname ||
        destination.origin !== window.location.origin
      )
        return;
      if (busy || (dirty && !window.confirm("저장하지 않은 편집을 취소하고 이동할까요?"))) {
        event.preventDefault();
        event.stopPropagation();
        if (busy) toast.info("진행 중인 작업이 끝난 뒤 이동해 주세요.");
      } else if (dirty) setDirty(false);
    }
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", navigate, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", navigate, true);
    };
  }, [dirty, busy, creating, createName, createIndustry]);
  function mayLeave() {
    if (busy) return false;
    return !dirty || window.confirm("저장하지 않은 편집을 취소하고 이동할까요?");
  }
  function switchTab(next: StudioTab) {
    if (next === tab || !mayLeave()) return false;
    setImpactNavigation(null);
    setDirty(false);
    setTab(next);
    return true;
  }
  function navigateSourceImpact(input: SourceImpactNavigation) {
    if (!company || !sourceImpactNavigationIsCurrent(company, input)) {
      toast.info("자료 또는 연결 대상이 변경되었습니다. 최신 자료함에서 다시 확인해 주세요.");
      return;
    }
    if (switchTab(input.destination.tab)) setImpactNavigation(input);
  }
  function accept(next: StudioCase) {
    setImpactNavigation(null);
    setCompany(next);
    setDirty(false);
    setCases((current) => [summarizeCase(next), ...current.filter((item) => item.id !== next.id)]);
  }
  async function showError(caught: unknown, id?: string) {
    const message = caught instanceof Error ? caught.message : "요청을 처리하지 못했습니다.";
    toast.error(message);
    if (caught instanceof StudioApiError && caught.status === 409 && id) {
      toast.info("다른 작업에서 변경한 내용이 있습니다. 편집 내용을 복사한 후 새로고침해 주세요.", {
        duration: 9000,
      });
      setError(
        "새 버전이 저장되어 현재 편집을 저장하지 못했습니다. 필요한 내용을 복사한 후 ‘최신 내용 불러오기’를 눌러 주세요.",
      );
    }
  }
  async function openCase(id: string, nextTab: StudioTab = "profile") {
    if (!mayLeave()) return;
    const request = ++openRequest.current;
    setBusy("기업 자료를 불러오는 중입니다");
    setError("");
    try {
      const parsed = caseSchema.safeParse(await studioFetch<unknown>(`/api/studio/cases/${id}`));
      if (request !== openRequest.current) return;
      if (
        !parsed.success ||
        parsed.data.id !== id ||
        parsed.data.revision < (cases.find((item) => item.id === id)?.revision ?? 0)
      )
        throw new Error("요청한 기업의 최신 자료를 확인하지 못했습니다. 다시 불러와 주세요.");
      accept(parsed.data);
      setTab(nextTab);
    } catch (caught) {
      if (request === openRequest.current) await showError(caught);
    } finally {
      if (request === openRequest.current) setBusy("");
    }
  }
  async function mutate(mutation: StudioMutation): Promise<StudioCase | null> {
    if (!company || busy) return null;
    setBusy("변경 내용을 저장하는 중입니다");
    setError("");
    try {
      const next = await studioFetch<StudioCase>(`/api/studio/cases/${company.id}`, {
        method: "PATCH",
        ...jsonBody({ ...mutation, revision: company.revision }),
      });
      accept(next);
      toast.success("저장했습니다.");
      return next;
    } catch (caught) {
      await showError(caught, company.id);
      return null;
    } finally {
      setBusy("");
    }
  }
  async function upload(
    file: File,
    kind: SourceDocument["kind"],
    allowAi: boolean,
    extractionMode: SourceExtractionMode = "extract",
  ): Promise<StudioCase | null> {
    if (!company || busy) return null;
    setBusy(
      extractionMode === "original-only"
        ? "본문을 추출하지 않고 원본 파일만 보관하는 중입니다."
        : "자료를 읽고 보관하는 중입니다. 큰 문서와 녹음은 시간이 걸릴 수 있습니다.",
    );
    setError("");
    const body = new FormData();
    body.append("file", file);
    body.append("kind", kind);
    body.append("revision", String(company.revision));
    body.append("allowAi", String(extractionMode === "original-only" ? false : allowAi));
    body.append("extractionMode", extractionMode);
    try {
      const next = await studioFetch<StudioCase>(`/api/studio/cases/${company.id}/sources`, {
        method: "POST",
        body,
      });
      accept(next);
      toast.success(
        extractionMode === "original-only"
          ? "원본만 보관했습니다. 본문 확인 전에는 분석 근거로 사용하지 않습니다."
          : "자료를 추가했습니다. 추출 내용을 확인해 주세요.",
      );
      return next;
    } catch (caught) {
      await showError(caught, company.id);
      return null;
    } finally {
      setBusy("");
    }
  }
  function beginCreate() {
    if (!mayLeave()) return;
    setCreateName("");
    setCreateIndustry("");
    setCreateKind("new");
    setCreating(true);
  }
  function closeCreate(open: boolean) {
    if (busy) return;
    if (
      !open &&
      (createName || createIndustry) &&
      !window.confirm("입력한 새 기업 정보를 취소할까요?")
    )
      return;
    setCreating(open);
  }
  async function createCase(event: React.FormEvent) {
    event.preventDefault();
    if (!createName.trim() || busy) return;
    setBusy("기업 작업공간을 만드는 중입니다");
    setError("");
    try {
      const next = await studioFetch<StudioCase>("/api/studio/cases", {
        method: "POST",
        ...jsonBody({
          profile: {
            ...emptyProfile(),
            companyName: createName.trim(),
            industry: createIndustry.trim(),
            applicationKind: createKind,
          },
        }),
      });
      accept(next);
      setTab("profile");
      setCreating(false);
      toast.success("기업 작업공간을 만들었습니다.");
    } catch (caught) {
      await showError(caught);
    } finally {
      setBusy("");
    }
  }
  async function deleteCase() {
    if (
      !company ||
      busy ||
      !window.confirm(
        `‘${company.profile.companyName}’의 자료·사업계획서·업무 기록을 모두 삭제할까요? 이 작업은 되돌릴 수 없습니다.`,
      )
    )
      return;
    setBusy("기업 작업공간을 삭제하는 중입니다");
    try {
      await studioFetch<{ ok: boolean }>(`/api/studio/cases/${company.id}`, {
        method: "DELETE",
        ...jsonBody({ revision: company.revision }),
      });
      setCases((current) => current.filter((item) => item.id !== company.id));
      setCompany(null);
      setDirty(false);
      setError("");
      toast.success("기업 작업공간을 삭제했습니다.");
    } catch (caught) {
      await showError(caught, company.id);
    } finally {
      setBusy("");
    }
  }
  function beginGeneration(operation: GenerationOperation) {
    if (busy) return;
    if (dirty) {
      toast.error("편집 중인 내용을 먼저 저장해 주세요.");
      return;
    }
    setGeneration(operation);
    setMode(null);
  }
  async function runGeneration() {
    if (!company || !generation || !mode || busy) return;
    const operation = generation;
    setGeneration(null);
    setBusy(
      operation === "analyze"
        ? "회사 자료에서 기술·사업 역량과 신청 아이템을 분석하는 중입니다"
        : "자료와 증빙을 바탕으로 사업계획서를 작성하는 중입니다",
    );
    setError("");
    try {
      const next = await studioFetch<StudioCase>(`/api/studio/cases/${company.id}/generate`, {
        method: "POST",
        ...jsonBody({ revision: company.revision, operation, mode }),
      });
      accept(next);
      setTab(operation === "analyze" ? "analysis" : "plan");
      toast.success(
        operation === "analyze"
          ? "아이템 분석을 완료했습니다."
          : "사업계획서를 작성했습니다. 내용을 검토해 주세요.",
      );
    } catch (caught) {
      await showError(caught, company.id);
    } finally {
      setBusy("");
    }
  }
  const filteredCases = selectCaseSummaries(cases, {
    query: filter,
    filter: attentionFilter,
    sort: attentionSort,
    today,
  });
  const panelProps = company ? { company, mutate, setDirty } : null;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-bold tracking-wide text-primary">
            <Sparkles className="size-3.5" />
            INNOVATION GROWTH STUDIO
          </div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-[29px]">사업계획서 스튜디오</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            회사의 기술에서 아이템을 찾고, 근거를 갖춘 사업계획서로 연결합니다.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="h-10" onClick={() => setSettings(true)}>
            <Settings2 />
            {status?.aiConfigured ? "AI 연결됨" : "AI 연결 설정"}
          </Button>
          <Button className="h-10" disabled={!!busy || loading} onClick={beginCreate}>
            <Plus />
            기업 추가
          </Button>
        </div>
      </div>
      {busy && (
        <div className="sticky top-[84px] z-10 rounded-xl border border-primary/20 bg-white/95 p-4 shadow-sm backdrop-blur-sm">
          <Loading text={busy} />
          <p className="mt-2 pl-6 text-xs text-muted-foreground">
            현재 화면을 유지해 주세요. 완료되면 결과가 표시됩니다.
          </p>
        </div>
      )}
      {error && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4">
          <p className="text-sm leading-6 text-red-800">{error}</p>
          <Button
            className="mt-3"
            variant="outline"
            disabled={!!busy}
            onClick={() => (company ? void openCase(company.id) : void refresh())}
          >
            <RefreshCw />
            {company ? "최신 내용 불러오기" : "다시 불러오기"}
          </Button>
        </div>
      )}
      {loading ? (
        <div className="rounded-2xl border bg-white p-10">
          <Loading />
        </div>
      ) : !company ? (
        <>
          <div className="relative overflow-hidden rounded-2xl border border-primary/15 bg-gradient-to-br from-[#edf9f7] via-white to-[#eef3fc] p-6 sm:p-8">
            <div className="relative z-1 max-w-2xl">
              <Badge variant="outline" className="mb-4 border-primary/20 bg-white/70 text-primary">
                혁신성장유형 전용 작업공간
              </Badge>
              <h2 className="text-xl font-bold leading-relaxed sm:text-2xl">
                자료는 한 번 모으고,
                <br />
                사업계획서는 근거와 함께 완성하세요.
              </h2>
              <p className="mt-3 text-sm leading-7 text-muted-foreground">
                상담 녹취, 특허, 제품·기술자료를 회사별로 보관하고
                <br className="hidden sm:block" />
                아이템 분석부터 수정 이력과 제출 준비까지 이어갑니다.
              </p>
              <div className="mt-6 flex flex-wrap items-center gap-2 text-xs font-semibold text-primary">
                <span className="rounded-full bg-white px-3 py-2">자료 수집</span>
                <ArrowRight className="size-3" />
                <span className="rounded-full bg-white px-3 py-2">아이템 도출</span>
                <ArrowRight className="size-3" />
                <span className="rounded-full bg-white px-3 py-2">작성·검토</span>
              </div>
            </div>
            <div className="absolute -bottom-12 -right-8 hidden size-64 rounded-full border-[28px] border-primary/5 sm:block" />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-bold">
              기업 작업공간 <span className="ml-1 text-primary">{cases.length}</span>
            </h2>
            <div className="relative w-full sm:w-64">
              <Search className="absolute left-3 top-3 size-4 text-muted-foreground" />
              <Input
                aria-label="기업 작업공간 검색"
                className="h-10 bg-white pl-9"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="기업명 또는 업종 검색"
              />
            </div>
          </div>
          <div className="space-y-3 rounded-xl border bg-white p-4">
            <div className="flex flex-wrap gap-3">
              <div className="min-w-48 space-y-1">
                <Label htmlFor="case-attention-filter">확인할 기업</Label>
                <select
                  id="case-attention-filter"
                  className={selectClass}
                  value={attentionFilter}
                  disabled={!!busy}
                  onChange={(event) =>
                    setAttentionFilter(event.target.value as CaseAttentionFilter)
                  }
                >
                  <option value="all">전체</option>
                  <option value="overdue">기한 경과</option>
                  <option value="due-soon">오늘~7일 내 기한</option>
                  <option value="attention">확인 필요</option>
                </select>
              </div>
              <div className="min-w-48 space-y-1">
                <Label htmlFor="case-attention-sort">정렬</Label>
                <select
                  id="case-attention-sort"
                  className={selectClass}
                  value={attentionSort}
                  disabled={!!busy}
                  onChange={(event) => setAttentionSort(event.target.value as CaseAttentionSort)}
                >
                  <option value="due-date">미완료 업무 기한순</option>
                  <option value="recent">최근 수정순</option>
                </select>
              </div>
            </div>
            <p className="text-xs leading-6 text-muted-foreground">
              PC 기준일 {today || "확인 중"} · 날짜 구분은 60초마다 갱신합니다. 오늘부터 7일은 앱의
              확인 편의 범위이며, 기한은 담당자가 입력한 값입니다. 법정기한을 자동 계산하지
              않습니다.
            </p>
            <p className="text-xs leading-6 text-muted-foreground">
              답변 발송 표시는 최신 요청·답변에 연결된 담당자 기록을 확인하는 항목입니다. 기관
              미접수·미승인 판단이 아닙니다. 목록은 저장·불러온 시점 기준이며 기업을 열면 최신
              내용을 확인합니다.
            </p>
          </div>
          {cases.length === 0 ? (
            <EmptyPanel
              title="첫 번째 기업을 등록해 주세요"
              description="실제 기업정보와 자료를 입력하면 회사에 맞는 사업계획서 준비를 시작할 수 있습니다."
            >
              <Button disabled={!!busy} onClick={beginCreate}>
                <Plus />
                기업 등록하고 시작
              </Button>
            </EmptyPanel>
          ) : filteredCases.length === 0 ? (
            <EmptyPanel
              title="검색·필터에 맞는 기업이 없습니다"
              description="기업명·업종 검색어나 확인 상태 필터를 바꿔 주세요."
            />
          ) : (
            <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
              {filteredCases.map((item) => (
                <CaseAttentionCard
                  key={item.id}
                  item={item}
                  today={today}
                  busy={!!busy}
                  onOpen={(nextTab) => void openCase(item.id, nextTab)}
                />
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="rounded-2xl border bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button
                variant="ghost"
                className="-ml-2 text-muted-foreground"
                disabled={!!busy}
                onClick={() => {
                  if (mayLeave()) {
                    setCompany(null);
                    setDirty(false);
                    setError("");
                  }
                }}
              >
                <ArrowLeft />
                전체 기업
              </Button>
              <Button
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                disabled={!!busy}
                onClick={deleteCase}
              >
                <Trash2 />
                기업 삭제
              </Button>
            </div>
            <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="text-xl font-bold">{company.profile.companyName}</h2>
                  <Badge className="bg-primary/10 text-primary">{stageLabels[company.stage]}</Badge>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {company.profile.industry || "업종 미입력"} ·{" "}
                  {company.profile.applicationKind === "renewal" ? "재확인" : "신규 확인"} ·{" "}
                  {formatDate(company.updatedAt)} 저장
                </p>
              </div>
              <div className="flex gap-5 text-center">
                <div>
                  <span className="block text-lg font-bold">{company.sources.length}</span>
                  <span className="text-[11px] text-muted-foreground">등록 자료</span>
                </div>
                <div>
                  <span className="block text-lg font-bold">{company.plans.length}</span>
                  <span className="text-[11px] text-muted-foreground">작성 버전</span>
                </div>
                <div>
                  <span className="block text-lg font-bold">
                    {company.tasks.filter((item) => item.status === "pending").length}
                  </span>
                  <span className="text-[11px] text-muted-foreground">남은 업무</span>
                </div>
              </div>
            </div>
          </div>
          <PreparationPanel
            key={company.id}
            company={company}
            dirty={editorDirty}
            busy={!!busy}
            externalBusy={automationUnsettled}
            onBusyChange={setBusy}
            onCompany={accept}
            onUnsettledChange={setManualPreparationUnsettled}
            goTo={switchTab}
          />
          <PreparationAutomationPanel
            key={`automation:${company.id}`}
            company={company}
            dirty={editorDirty}
            busy={!!busy}
            suspended={tab === "venturein" || settings || creating || generation !== null}
            manualUnsettled={manualPreparationUnsettled}
            onBusyChange={setBusy}
            onCompany={accept}
            onUnsettledChange={setAutomationUnsettled}
            goTo={switchTab}
          />
          <div className="overflow-hidden rounded-2xl border bg-white">
            <div
              role="tablist"
              aria-label="기업 작업 단계"
              className="flex overflow-x-auto border-b bg-muted/30 p-2"
            >
              {tabs.map(({ value, title, icon: Icon }, index) => (
                <button
                  key={value}
                  id={`studio-tab-${value}`}
                  role="tab"
                  aria-selected={tab === value}
                  aria-controls={`studio-panel-${value}`}
                  disabled={!!busy}
                  type="button"
                  onClick={() => switchTab(value)}
                  className={cn(
                    "flex min-w-32 flex-1 items-center justify-center gap-2 rounded-lg px-3 py-3 text-sm transition-colors disabled:opacity-60",
                    tab === value
                      ? "bg-white font-semibold text-primary shadow-sm"
                      : "text-muted-foreground hover:bg-white/60",
                  )}
                >
                  <Icon className="size-4" />
                  <span>
                    <span className="mr-1 text-[10px] opacity-50">{index + 1}</span>
                    {title}
                  </span>
                </button>
              ))}
            </div>
            <fieldset
              disabled={!!busy || automationUnsettled || manualPreparationUnsettled}
              className="min-w-0 p-4 sm:p-6"
              key={`${company.id}:${tab === "sources" ? "sources" : company.revision}`}
            >
              <div role="tabpanel" id={`studio-panel-${tab}`} aria-labelledby={`studio-tab-${tab}`}>
                {panelProps && tab === "profile" && <ProfileEditor {...panelProps} />}
                {impactNavigation &&
                  company.id === impactNavigation.caseId &&
                  company.revision === impactNavigation.revision &&
                  tab === impactNavigation.destination.tab && (
                    <div className="mb-5">
                      <Notice tone="warning">
                        자료함에서 선택한 재확인 대상:{" "}
                        {sourceImpactKindLabels[impactNavigation.destination.target.kind]} · ID{" "}
                        <span className="break-all">{impactNavigation.destination.target.id}</span>
                        {impactNavigation.destination.target.version !== null &&
                          ` · v${impactNavigation.destination.target.version}`}
                        {impactNavigation.destination.target.partId &&
                          ` · 항목 ${impactNavigation.destination.target.partId}`}
                        . 아래 기록의 정확한 ID·버전을 확인해 주세요. 이전 버전은 보존되며 자동으로
                        수정하거나 최신 기록으로 대체하지 않습니다.
                      </Notice>
                    </div>
                  )}
                {panelProps && tab === "sources" && (
                  <>
                    <SourceIntakesPanel
                      key={company.id}
                      company={company}
                      blockedReason={
                        panelDirty || suggestionDirty
                          ? "기존 자료 편집·OCR 검토 또는 제안 선택을 먼저 저장하거나 닫아 주세요."
                          : ""
                      }
                      busy={!!busy}
                      onCompany={accept}
                      onBusyChange={setBusy}
                      onDirtyChange={setIntakeDirty}
                    />
                    <SourceSuggestionsPanel
                      key={`suggestions:${company.id}`}
                      company={company}
                      busy={!!busy}
                      onCompany={accept}
                      onBusyChange={setBusy}
                      onDirtyChange={setSuggestionDirty}
                      blockedReason={
                        panelDirty || intakeDirty
                          ? "자료 편집·원본 접수·판독문 교정을 먼저 마치거나 닫아 주세요."
                          : ""
                      }
                    />
                    <SourcesPanel
                      key={`${company.id}:${company.revision}`}
                      {...panelProps}
                      upload={upload}
                      supportedFiles={status?.supportedFiles || []}
                      aiConfigured={!!status?.aiConfigured}
                      blockedReason={
                        intakeDirty || suggestionDirty
                          ? "복수파일 접수·교정·제안 선택 또는 미확인 요청을 먼저 마치거나 닫아 주세요."
                          : ""
                      }
                    />
                    <SourceImpactPanel
                      company={company}
                      onNavigate={navigateSourceImpact}
                      blockedReason={busy}
                    />
                  </>
                )}
                {panelProps && tab === "diagnosis" && (
                  <DiagnosisPanel
                    {...panelProps}
                    goToProfile={() => switchTab("profile")}
                    goToSources={() => switchTab("sources")}
                    goToAnalysis={() => switchTab("analysis")}
                  />
                )}
                {panelProps && tab === "analysis" && (
                  <AnalysisPanel
                    {...panelProps}
                    generate={() => beginGeneration("analyze")}
                    goToPlan={() => switchTab("plan")}
                  />
                )}
                {panelProps && tab === "plan" && (
                  <PlanEditor
                    key={impactNavigation ? JSON.stringify(impactNavigation) : "default-plan"}
                    {...panelProps}
                    reviewTarget={
                      impactNavigation?.caseId === company.id &&
                      impactNavigation.revision === company.revision &&
                      impactNavigation.destination.tab === "plan" &&
                      impactNavigation.destination.target.planId
                        ? {
                            companyId: company.id,
                            revision: company.revision,
                            planId: impactNavigation.destination.target.planId,
                            sectionKey: impactNavigation.destination.target.sectionKey,
                            recordKind: impactNavigation.destination.target.kind,
                            recordId: impactNavigation.destination.target.id,
                          }
                        : undefined
                    }
                    onBusyChange={setBusy}
                    generate={() => beginGeneration("plan")}
                    goToAnalysis={() => switchTab("analysis")}
                  />
                )}
                {panelProps && tab === "workflow" && (
                  <WorkflowPanel {...panelProps} onBusyChange={setBusy} />
                )}
                {panelProps && tab === "venturein" && <VentureinPanel {...panelProps} />}
              </div>
            </fieldset>
          </div>
        </>
      )}
      <Dialog open={creating} onOpenChange={closeCreate}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>기업 작업공간 만들기</DialogTitle>
            <DialogDescription>
              기업별로 자료, 아이템, 사업계획서와 진행 기록을 보관합니다.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={createCase} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="new-company-name">기업명 *</Label>
              <Input
                autoFocus
                id="new-company-name"
                required
                maxLength={100}
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
                placeholder="기업명을 입력하세요"
                disabled={!!busy}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-company-industry">업종</Label>
              <Input
                id="new-company-industry"
                maxLength={100}
                value={createIndustry}
                onChange={(event) => setCreateIndustry(event.target.value)}
                placeholder="예: 소프트웨어 개발 및 공급업"
                disabled={!!busy}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-company-kind">신청 구분</Label>
              <select
                id="new-company-kind"
                className={selectClass}
                value={createKind}
                onChange={(event) =>
                  setCreateKind(event.target.value as CompanyProfile["applicationKind"])
                }
                disabled={!!busy}
              >
                <option value="new">신규 확인</option>
                <option value="renewal">재확인</option>
              </select>
            </div>
            <Button type="submit" className="h-10 w-full" disabled={!createName.trim() || !!busy}>
              <Plus />
              {busy ? "만드는 중…" : "기업 작업공간 만들기"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={settings} onOpenChange={setSettings}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>AI 연결과 자료 보관</DialogTitle>
            <DialogDescription>자료 분석과 자동 작성에 사용할 연결 상태입니다.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-xl border bg-muted/30 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold">
                {status?.aiConfigured ? (
                  <CheckCircle2 className="size-4 text-primary" />
                ) : (
                  <Circle className="size-4 text-amber-600" />
                )}
                {status?.aiConfigured
                  ? "AI 서비스가 연결되어 있습니다."
                  : "AI 서비스를 아직 연결하지 않았습니다."}
              </div>
              <p className="mt-2 text-xs leading-6 text-muted-foreground">
                {status?.aiConfigured
                  ? "분석·작성 시 AI 모드를 선택하면 회사 자료가 연결된 서비스로 전달됩니다."
                  : "운영자가 서버의 .env.local에 API 키를 설정한 뒤 앱을 다시 실행하면 AI 자동 작성을 사용할 수 있습니다. 설정 방법은 프로젝트 README에 있습니다."}
              </p>
            </div>
            <Notice>
              AI 연결 없이도 기업자료를 저장하고 ‘자료 기반 정리본’을 만들 수 있습니다. 정리본은
              입력한 내용을 항목별로 배치하며 AI의 아이템 추천·서술 생성은 수행하지 않습니다.
            </Notice>
            <p className="text-xs leading-6 text-muted-foreground">
              현재 자료는 이 앱을 실행하는 컴퓨터에 저장됩니다. 공동 접속·사용자별 권한과 외부 포털
              연동은 제공되지 않습니다.
            </p>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!generation}
        onOpenChange={(open) => {
          if (!busy && !open) setGeneration(null);
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {generation === "analyze" ? "아이템 분석 방식 선택" : "사업계획서 작성 방식 선택"}
            </DialogTitle>
            <DialogDescription>
              사용할 방식을 선택해 주세요. 기존 작성본은 이력에 보관됩니다.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <button
              type="button"
              disabled={!status?.aiConfigured}
              onClick={() => setMode("ai")}
              className={cn(
                "w-full rounded-xl border p-4 text-left disabled:opacity-60",
                mode === "ai" ? "border-primary bg-primary/5" : "bg-white",
              )}
            >
              <div className="flex items-center gap-2 font-semibold">
                <Sparkles className="size-4 text-primary" />
                AI 분석·자동 작성
                {!status?.aiConfigured && (
                  <Badge variant="outline" className="ml-auto text-xs">
                    연결 필요
                  </Badge>
                )}
              </div>
              <p className="mt-2 text-xs leading-6 text-muted-foreground">
                기업의 상황을 분석해 아이템과 서술을 생성합니다. 기업정보와 등록된 자료 내용이
                연결된 AI 서비스로 전송됩니다.
              </p>
            </button>
            <button
              type="button"
              onClick={() => setMode("assisted")}
              className={cn(
                "w-full rounded-xl border p-4 text-left",
                mode === "assisted" ? "border-primary bg-primary/5" : "bg-white",
              )}
            >
              <div className="flex items-center gap-2 font-semibold">
                <FileStack className="size-4 text-primary" />
                자료 기반 정리본
              </div>
              <p className="mt-2 text-xs leading-6 text-muted-foreground">
                입력한 기술·고객·계획과 자료를 항목별로 정리합니다. AI 생성 없이 현재 자료를
                검토하는 용도로 사용합니다.
              </p>
            </button>
            {!status?.aiConfigured && (
              <p className="text-xs leading-6 text-muted-foreground">
                AI 자동 작성은 상단의 ‘AI 연결 설정’에서 연결 방법을 확인하세요.
              </p>
            )}
            <Button className="h-10 w-full" disabled={!mode || !!busy} onClick={runGeneration}>
              {generation === "analyze" ? "선택한 방식으로 분석" : "선택한 방식으로 작성"}
              <ArrowRight />
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
