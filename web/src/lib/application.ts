import { z } from "zod";

function isCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1900 || year > 2200) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

const dateSchema = z.string().refine(isCalendarDate, "올바른 날짜를 입력해 주세요.");

export const applicationSchema = z
  .object({
    companyName: z
      .string()
      .trim()
      .min(1, "기업명을 입력해 주세요.")
      .max(100, "기업명은 100자 이내로 입력해 주세요."),
    startDate: dateSchema,
    applicationDate: dateSchema,
    applicationKind: z.enum(["new", "renewal"]),
    industry: z.string().trim().min(1, "업종을 선택해 주세요.").max(100),
    technologyName: z
      .string()
      .trim()
      .min(1, "신청 기술 또는 서비스를 입력해 주세요.")
      .max(200, "200자 이내로 입력해 주세요."),
  })
  .superRefine((profile, context) => {
    if (
      isCalendarDate(profile.startDate) &&
      isCalendarDate(profile.applicationDate) &&
      profile.applicationDate < profile.startDate
    ) {
      context.addIssue({
        code: "custom",
        path: ["applicationDate"],
        message: "신청예정일은 설립·사업개시일 이후여야 합니다.",
      });
    }
  });

export type ApplicationProfile = z.infer<typeof applicationSchema>;
export type PreparationTrackId = "new-under-3" | "new-3-plus" | "renewal";
export type PreparationTrack = {
  id: PreparationTrackId;
  label: string;
  description: string;
  focus: string[];
};

const TRACKS: Record<PreparationTrackId, PreparationTrack> = {
  "new-under-3": {
    id: "new-under-3",
    label: "신규 · 3년 미만",
    description: "기술을 구현할 팀의 전문성과 앞으로의 개발·사업계획을 중심으로 준비하세요.",
    focus: ["연구조직·기술인력", "기술개발 계획", "기업가정신 기반 사업계획"],
  },
  "new-3-plus": {
    id: "new-3-plus",
    label: "신규 · 3년 이상",
    description: "개발·사업계획과 함께 연구개발 투자 및 고용 변화의 근거를 정리하세요.",
    focus: ["연구개발 투자", "기술 차별성", "시장·고용 변화"],
  },
  renewal: {
    id: "renewal",
    label: "재확인",
    description: "기술의 차별성과 R&D 실적, 최근 3년의 사업성과를 연결해 준비하세요.",
    focus: ["기술 차별성", "R&D 실적", "최근 사업성과"],
  },
};

/** Input-based preparation guidance; the official application determines eligibility. */
export function getPreparationTrack(profile: ApplicationProfile): PreparationTrack {
  const validProfile = applicationSchema.parse(profile);
  if (validProfile.applicationKind === "renewal") return TRACKS.renewal;
  const [year, month, day] = validProfile.startDate.split("-").map(Number);
  const anniversaryYear = year + 3;
  const daysInMonth = new Date(Date.UTC(anniversaryYear, month, 0)).getUTCDate();
  const anniversary = `${anniversaryYear}-${String(month).padStart(2, "0")}-${String(Math.min(day, daysInMonth)).padStart(2, "0")}`;
  return validProfile.applicationDate < anniversary ? TRACKS["new-under-3"] : TRACKS["new-3-plus"];
}

export type EvidenceItem = {
  id: string;
  title: string;
  category: "기본 서류" | "기술혁신성" | "사업성장성";
  purpose: string;
  example: string;
  tracks?: PreparationTrackId[];
};

export const EVIDENCE_ITEMS: EvidenceItem[] = [
  {
    id: "sme",
    title: "중소기업확인서",
    category: "기본 서류",
    purpose: "중소기업 해당 여부와 확인서의 유효기간을 확인합니다.",
    example: "신청 시 유효한 중소기업확인서",
  },
  {
    id: "registration",
    title: "사업자·법인 기본 정보",
    category: "기본 서류",
    purpose: "기업명, 사업자 정보, 설립·개업일이 자료 간 일치하는지 확인합니다.",
    example: "사업자등록증, 법인 등기·주주명부 등 해당 서류",
  },
  {
    id: "financial",
    title: "재무·매출 자료",
    category: "기본 서류",
    purpose: "최근 실적과 계획의 출발점을 객관적인 자료로 확인합니다.",
    example: "최근 3개년 재무제표·부가세 과세표준증명 (업력이 짧으면 해당 기간)",
  },
  {
    id: "employment",
    title: "고용·보험 자료",
    category: "기본 서류",
    purpose: "인력 현황을 확인하고 기간별 자료의 누락을 점검합니다.",
    example: "고용·보험 가입자명부 등 해당 서류, 신청일 기준 발급요건 확인",
  },
  {
    id: "team",
    title: "연구조직·기술인력의 전문성",
    category: "기술혁신성",
    purpose: "신청 기술을 개발하고 지속해서 개선할 수 있는 팀의 역량을 설명합니다.",
    example: "핵심 인력 경력·역할·개발 참여 이력, 연구조직 인정서(해당 시)",
  },
  {
    id: "development",
    title: "기술개발 계획과 R&D 실적",
    category: "기술혁신성",
    purpose: "개발 필요성, 지금까지의 개발 경과, 향후 3년 계획을 연결합니다.",
    example: "개발 일정·목표·담당 인력, 시험 결과와 개발 실적",
  },
  {
    id: "difference",
    title: "기술의 차별성",
    category: "기술혁신성",
    purpose: "경쟁 기술과 비교했을 때의 차이를 객관적인 근거로 설명합니다.",
    example: "비교표, 성능 시험·검증 자료, 고객 문제를 해결한 사례",
  },
  {
    id: "intellectual-property",
    title: "지식재산권 현황 · 해당 시",
    category: "기술혁신성",
    purpose:
      "보유 권리와 신청 기술의 연관성을 확인합니다. 특허 보유를 일률적인 필수요건으로 보지 않습니다.",
    example: "특허·실용신안 등 권리 현황, 권리자와 유효 상태",
  },
  {
    id: "research-cost",
    title: "연구개발비 투자",
    category: "기술혁신성",
    purpose: "연구개발 투입 비용과 실제 개발 활동의 연결을 확인합니다.",
    example: "연구개발비 산정 근거와 관련 회계 자료",
    tracks: ["new-3-plus", "renewal"],
  },
  {
    id: "market",
    title: "목표시장·고객과 사업계획",
    category: "사업성장성",
    purpose: "목표 고객, 경쟁사, 시장 진입 전략과 신청 기술의 연관성을 설명합니다.",
    example: "고객 수요 근거, 시장 조사 출처, 향후 3년 사업계획",
  },
  {
    id: "funding",
    title: "자금 조달·운용 계획",
    category: "사업성장성",
    purpose: "개발 및 사업계획을 실행하는 데 필요한 자금과 조달 근거를 확인합니다.",
    example: "향후 3년 자금 소요·조달 일정, 기존 자금 현황",
  },
  {
    id: "cooperation",
    title: "외부 협업 실적 · 해당 시",
    category: "사업성장성",
    purpose: "사업 성장과 기술개발을 지원하는 외부 협업 내용을 정리합니다.",
    example: "공동개발·협약·납품 등 협업의 실제 내용과 결과",
  },
  {
    id: "employment-growth",
    title: "고용 변화",
    category: "사업성장성",
    purpose: "기간별 고용 인원의 변화를 같은 기준으로 비교합니다.",
    example: "기간별 고용 인원과 산정 기준",
    tracks: ["new-3-plus", "renewal"],
  },
  {
    id: "business-performance",
    title: "재확인 사업성과",
    category: "사업성장성",
    purpose: "최근 3년 자료 중 공식 지침에 따라 선택한 2가지 사업성과 지표의 근거를 준비합니다.",
    example: "선택한 성과 지표, 연도별 실적, 원본 증빙",
    tracks: ["renewal"],
  },
];

export function getEvidenceItems(track: PreparationTrackId) {
  return EVIDENCE_ITEMS.filter((item) => !item.tracks || item.tracks.includes(track));
}
