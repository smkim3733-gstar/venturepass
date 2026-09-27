import { applicationSchema, getPreparationTrack } from "./application";
import type { StudioCase } from "./studio-schema";

export function trackContext(value: Pick<StudioCase, "profile">) {
  const parsed = applicationSchema.safeParse({
    companyName: value.profile.companyName,
    startDate: value.profile.foundedOn,
    applicationDate: value.profile.applicationDate,
    applicationKind: value.profile.applicationKind,
    industry: value.profile.industry || "미입력",
    technologyName: "준비유형 확인",
  });
  if (parsed.success) {
    const track = getPreparationTrack(parsed.data);
    return `${track.label}: ${track.description} 중점 준비: ${track.focus.join(", ")}. 입력일 기준 준비 안내이며 공식 자격 판정이 아닙니다.`;
  }
  if (value.profile.applicationKind === "renewal") {
    return "재확인: 이전 확인기간의 기술개발·사업성과와 이전 신청자료를 비교해야 합니다. 설립·개업일과 신청예정일도 확인해 주세요.";
  }
  return "신규: 유효한 설립·개업일과 신청예정일이 없어 3년 미만·이상 준비유형을 구분하지 않았습니다.";
}
