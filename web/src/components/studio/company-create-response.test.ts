import { describe, expect, it } from "vitest";
import { createdCompanyResponse } from "./company-create-response";
import { companyCreateFixture, companyCreateResult } from "../../../scripts/fixtures/company-create-receipt";
import type { StudioCase } from "@/lib/studio-schema";
import { manualSourceFixture } from "../../../scripts/fixtures/manual-source-receipt";

describe("new company response", () => {
  it("accepts exact renewal profile and empty initial state without changing inputs", () => {
    const f=companyCreateFixture();const next=companyCreateResult(f.profile,f.id);const frozen=JSON.stringify({f,next});
    expect(createdCompanyResponse(next,f.profile,[f.existing.id])).toEqual(next);
    expect(JSON.stringify({f,next})).toBe(frozen);
  });
  it("accepts new application with explicitly empty industry", () => {
    const f=companyCreateFixture();f.profile.applicationKind="new";f.profile.industry="";
    const next=companyCreateResult(f.profile,f.id);expect(createdCompanyResponse(next,f.profile,[])).toEqual(next);
  });
  it("uses normalized company name and profile contract", () => {
    const f=companyCreateFixture();f.profile.companyName="  새 합성 준비 기업  ";
    expect(createdCompanyResponse(companyCreateResult(f.profile,f.id),f.profile,[])).not.toBeNull();
  });
  it("permits same name as another company with a different ID", () => {
    const f=companyCreateFixture();f.profile.companyName=f.existing.profile.companyName;
    expect(createdCompanyResponse(companyCreateResult(f.profile,f.id),f.profile,[f.existing.id])).not.toBeNull();
  });
  const changes: [string,(n:StudioCase,f:ReturnType<typeof companyCreateFixture>)=>void][] = [
    ["company name",n=>{n.profile.companyName="다른 기업";}],
    ["industry",n=>{n.profile.industry="다른 업종";}],
    ["application kind",n=>{n.profile.applicationKind="new";}],
    ["unrequested registration number",n=>{n.profile.businessNumber="111-22-33333";}],
    ["unrequested technology",n=>{n.profile.technologySummary="다른 기술";}],
    ["unrequested customers",n=>{n.profile.customers="다른 고객";}],
    ["existing company ID",(n,f)=>{n.id=f.existing.id;}],
    ["positive revision",n=>{n.revision=1;}],
    ["negative revision",n=>{n.revision=-1;}],
    ["unsafe revision",n=>{n.revision=Number.MAX_SAFE_INTEGER+1;}],
    ["invalid time",n=>{n.createdAt="invalid";n.updatedAt="invalid";}],
    ["different update time",n=>{n.updatedAt="2026-10-12T06:11:00.000Z";}],
    ["existing source",n=>{n.sources=manualSourceFixture().company.sources;}],
    ["existing plan",(n,f)=>{n.plans=f.existing.plans;}],
    ["existing task",n=>{n.tasks=[{id:"a0000000-0000-4000-8000-000000000001",title:"합성 업무",notes:"",category:"evidence",status:"pending",dueDate:""}];}],
    ["selected candidate",n=>{n.selectedCandidateId="other";}],
    ["diagnosis entity",n=>{n.diagnosisAnswers.entityType="corporate";}],
    ["diagnosis note",n=>{n.diagnosisAnswers.sme.note="이전 판단";}],
    ["diagnosis reviewed",n=>{n.diagnosisAnswers.sme.reviewed=true;}],
    ["automation company binding",(n,f)=>{n.preparationAutomation.caseId=f.id;}],
  ];
  for(const [label,change] of changes) it(`rejects ${label}`,()=>{
    const f=companyCreateFixture();const n=companyCreateResult(f.profile,f.id);change(n,f);
    expect(createdCompanyResponse(n,f.profile,[f.existing.id])).toBeNull();
  });
  it("rejects null",()=>{const f=companyCreateFixture();expect(createdCompanyResponse(null,f.profile,[])).toBeNull();});
  it("rejects malformed company",()=>{const f=companyCreateFixture();expect(createdCompanyResponse({id:f.id},f.profile,[])).toBeNull();});
  it("rejects malformed ID",()=>{const f=companyCreateFixture();expect(createdCompanyResponse({...companyCreateResult(f.profile,f.id),id:"invalid"},f.profile,[])).toBeNull();});
  it("rejects a blank requested name",()=>{const f=companyCreateFixture();expect(createdCompanyResponse(companyCreateResult(f.profile,f.id),{...f.profile,companyName:"  "},[])).toBeNull();});
  it("rejects an existing application number history object",()=>{
    const f=companyCreateFixture();const n=companyCreateResult(f.profile,f.id);const hash="a".repeat(64);
    n.applicationNumberBindings={formatVersion:1,headId:f.id,headDigest:hash,records:[{
      id:f.id,caseId:f.id,origin:"manual",officialVerification:"unverified",recordedAt:n.createdAt,committedRevision:0,
      command:{action:"record-application-number",revision:0,clientRequestId:f.id,applicationId:f.id,metadataVersionId:f.id,expectedPreviousBindingId:f.id,operation:"release",applicationNumber:null,recordedBy:"합성 담당자",reason:"합성 이력",confirmed:true},
      inputDigest:hash,previousRecordId:f.id,previousRecordDigest:hash,companySnapshot:{companyName:f.profile.companyName,businessNumber:""},applicationSnapshot:{cycleDigest:hash,metadataDigest:hash,title:"합성 회차"},recordDigest:hash,
    }]};
    expect(createdCompanyResponse(n,f.profile,[])).toBeNull();
  });
  it("accepts explicitly empty optional histories",()=>{const f=companyCreateFixture();const n=companyCreateResult(f.profile,f.id);n.guidedPreparationRuns=[];n.planSupplementExecutions=[];n.planSupplementAdoptions=[];expect(createdCompanyResponse(n,f.profile,[])).toEqual(n);});
});
