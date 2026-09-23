"use client";

import { useState } from "react";
import { Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { companyProfileSchema, type CompanyProfile } from "@/lib/studio-schema";
import { Notice, PanelHeading, selectClass, useDirty, type PanelProps } from "./shared";

const narrativeFields: { key: keyof CompanyProfile; label: string; placeholder: string }[] = [
  {
    key: "technologySummary",
    label: "핵심 기술과 제품",
    placeholder:
      "무엇을 개발하고 있나요? 해결하는 문제, 기술의 작동 방식, 현재 개발 단계를 적어 주세요.",
  },
  {
    key: "patents",
    label: "특허와 지식재산",
    placeholder:
      "출원·등록 번호, 명칭, 권리자, 제품에 적용한 부분을 적어 주세요. 보유하지 않았다면 현재 상황을 입력하세요.",
  },
  {
    key: "customers",
    label: "고객과 시장",
    placeholder: "주요 고객, 고객이 겪는 문제, 계약·납품 현황, 경쟁제품과 차이를 적어 주세요.",
  },
  {
    key: "team",
    label: "대표·개발인력과 협업",
    placeholder: "대표와 핵심인력의 경력, 역할, 개발에 참여하는 인력과 협력기관을 적어 주세요.",
  },
  {
    key: "financials",
    label: "재무와 자금",
    placeholder:
      "기간을 명시한 매출·개발비, 현재 확보한 자금, 앞으로의 조달·사용 계획을 적어 주세요.",
  },
  {
    key: "developmentPlan",
    label: "개발 경과와 향후 계획",
    placeholder: "완료한 개발·검증 결과와 앞으로 추진할 일정·목표를 구분해서 적어 주세요.",
  },
];
export function ProfileEditor({ company, mutate, setDirty }: PanelProps) {
  const [profile, setProfile] = useState(company.profile);
  const dirty = JSON.stringify(profile) !== JSON.stringify(company.profile);
  useDirty(dirty, setDirty);
  const change = (key: keyof CompanyProfile, value: string) =>
    setProfile((current) => ({ ...current, [key]: value }));
  async function save() {
    const result = companyProfileSchema.safeParse(profile);
    if (!result.success) {
      toast.error(result.error.issues[0]?.message || "기업정보를 확인해 주세요.");
      return;
    }
    await mutate({ action: "profile", profile: result.data });
  }
  return (
    <div>
      <PanelHeading
        title="우리 기업의 출발점"
        description="기술과 사업의 현재 상황을 알려 주세요. 입력한 내용과 자료함의 증빙을 함께 분석합니다."
        actions={
          <Button className="h-10" disabled={!dirty} onClick={save}>
            <Save />
            기업정보 저장
          </Button>
        }
      />
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="company-name">기업명 *</Label>
          <Input
            id="company-name"
            maxLength={100}
            value={profile.companyName}
            onChange={(event) => change("companyName", event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="business-number">사업자등록번호</Label>
          <Input
            id="business-number"
            maxLength={30}
            placeholder="000-00-00000"
            value={profile.businessNumber}
            onChange={(event) => change("businessNumber", event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="industry">업종</Label>
          <Input
            id="industry"
            maxLength={100}
            placeholder="예: 산업용 장비 제조"
            value={profile.industry}
            onChange={(event) => change("industry", event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="founded-on">설립일</Label>
          <Input
            id="founded-on"
            type="date"
            value={profile.foundedOn}
            onInput={(event) => change("foundedOn", event.currentTarget.value)}
            onChange={(event) => change("foundedOn", event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="application-date">신청 예정일</Label>
          <Input
            id="application-date"
            type="date"
            value={profile.applicationDate}
            onInput={(event) => change("applicationDate", event.currentTarget.value)}
            onChange={(event) => change("applicationDate", event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="application-kind">신청 구분</Label>
          <select
            id="application-kind"
            className={selectClass}
            value={profile.applicationKind}
            onChange={(event) => change("applicationKind", event.target.value)}
          >
            <option value="new">신규 확인</option>
            <option value="renewal">재확인</option>
          </select>
        </div>
      </div>
      <div className="my-6">
        <Notice>
          기업정보에 입력한 내용은 기업이 제공한 설명으로 취급합니다. 계약서·시험자료·특허 원문 등
          확인 가능한 근거는 자료함에 추가해 주세요.
        </Notice>
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        {narrativeFields.map(({ key, label, placeholder }) => (
          <div key={key} className="space-y-2">
            <Label htmlFor={`profile-${key}`}>{label}</Label>
            <Textarea
              id={`profile-${key}`}
              className="min-h-36 resize-y bg-white leading-7"
              value={profile[key]}
              maxLength={10000}
              onChange={(event) => change(key, event.target.value)}
              placeholder={placeholder}
            />
            <p className="text-right text-[11px] text-muted-foreground">
              {profile[key].length.toLocaleString()} / 10,000
            </p>
          </div>
        ))}
      </div>
      <div className="mt-6 flex justify-end">
        <Button disabled={!dirty} onClick={save}>
          <Save />
          기업정보 저장
        </Button>
      </div>
    </div>
  );
}
