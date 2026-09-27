import { evaluationFocusItems } from "@/lib/evaluation-guide";
import { applicationMetadata } from "@/lib/studio-application-types";
import { criteriaContextReasonLabels } from "@/lib/studio-criteria-version-types";
import type { BusinessPlan, Candidate, StudioCase } from "@/lib/studio-schema";
import { criteriaApplicationUiContext } from "./criteria-versions-ui";
import { EvidenceList } from "./evidence";
import styles from "./guided-workspace.module.css";

type Reference = Candidate["evidence"][number];

// A text match only. This component does not determine truth, eligibility, or plan freshness.
function referenceStatus(company: StudioCase, reference: Reference) {
  if (!reference.quote.trim()) return "인용문이 비어 있어요";
  if (reference.sourceId === "profile")
    return Object.values(company.profile).some(
      (value) => typeof value === "string" && value.includes(reference.quote),
    )
      ? "기업 입력 내용과 인용문이 일치해요"
      : "현재 기업 입력 내용과 인용문이 달라요";
  const sources = company.sources.filter((source) => source.id === reference.sourceId);
  if (!sources.length) return "연결한 자료가 없어요";
  if (sources.length !== 1) return "연결할 자료를 하나로 확인하지 못했어요";
  if (sources[0].extraction === "pending") return "본문을 아직 추출하지 않은 자료예요";
  return sources[0].text.includes(reference.quote)
    ? "현재 등록본문에 인용문이 있어요"
    : "현재 등록본문과 인용문이 달라요";
}

function ApplicationCriteriaReference({
  company,
  applicationId,
}: {
  company: StudioCase;
  applicationId: string;
}) {
  const application = applicationMetadata(company, applicationId);
  const { binding, context } = criteriaApplicationUiContext(company, applicationId);
  const versions = (company.criteriaVersions ?? []).filter(
    (version) =>
      version.caseId === company.id &&
      version.id === binding?.criteriaVersionId &&
      version.contentSha256 === binding.criteriaContentSha256,
  );
  const version = versions.length === 1 ? versions[0] : null;
  return (
    <details className={styles.details}>
      <summary>{application?.title ?? "신청 기록 확인 필요"}</summary>
      {!binding ? (
        <p className={styles.helper}>이 신청에 연결한 기준 버전이 없습니다.</p>
      ) : (
        <>
          <p className={styles.body}>
            연결 기록: {binding.criteriaSummary.title} · {binding.criteriaSummary.versionLabel} ·
            버전 {binding.criteriaVersion}
          </p>
          <p className={styles.helper}>
            기록한 확인일: {binding.criteriaSummary.checkedOn || "미기입"}
          </p>
          {!context && (
            <p className={styles.helper}>
              현재 연결 상태를 확인하지 못했습니다. 최신 기업 기록을 불러와 확인해 주세요.
            </p>
          )}
          {context?.status === "pinned-unverified" && (
            <p className={styles.helper}>
              기준 버전 연결 기록이 있습니다. 현행 기준 여부와 이 회사의 적용 여부는 확인이
              필요합니다.
            </p>
          )}
          {context?.status === "unresolved" && (
            <p className={styles.helper}>기준 연결을 다시 확인해 주세요.</p>
          )}
          {context?.reasons.map((reason) => (
            <p className={styles.helper} key={reason}>
              {criteriaContextReasonLabels[reason]}
            </p>
          ))}
          {!version ? (
            <p className={styles.helper}>연결한 기준 원문 기록을 확인하지 못했습니다.</p>
          ) : (
            <details className={styles.details}>
              <summary>연결 당시 기준의 출처·서류 조건</summary>
              {version.details.sources.length === 0 && (
                <p className={styles.helper}>기록한 출처가 없습니다.</p>
              )}
              {version.details.sources.map((source, index) => (
                <div className="mt-3 space-y-1 text-sm" key={index}>
                  <p className="font-medium">{source.title || "출처 이름 미기입"}</p>
                  {source.url && <p className="break-all">{source.url}</p>}
                  <blockquote className="whitespace-pre-wrap break-words border-l-2 border-primary/30 pl-3">
                    {source.quote || "인용문 미기입"}
                  </blockquote>
                </div>
              ))}
              {version.details.documents.length === 0 && (
                <p className={styles.helper}>기록한 서류 조건이 없습니다.</p>
              )}
              {version.details.documents.map((document) => (
                <details className={styles.details} key={document.id}>
                  <summary>{document.name}</summary>
                  <dl className="space-y-2 text-sm">
                    {(
                      [
                        ["적용 대상", document.appliesTo],
                        ["대상 기간", document.period],
                        ["발급일 조건", document.issueDateCondition],
                        ["대체 자료 조건", document.alternativeCondition],
                        ["자동 연계 안내 기록", document.autoLinkGuidance],
                        ["추가 메모", document.note],
                      ] as const
                    ).map(([label, value]) => (
                      <div key={label}>
                        <dt className="text-muted-foreground">{label}</dt>
                        <dd className="whitespace-pre-wrap break-words">{value || "미기입"}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              ))}
            </details>
          )}
        </>
      )}
    </details>
  );
}

export function GuidedPlanEvidence({ company, plan }: { company: StudioCase; plan: BusinessPlan }) {
  const stored = company.plans.filter((item) => item.id === plan.id);
  if (stored.length !== 1 || JSON.stringify(stored[0]) !== JSON.stringify(plan)) return null;
  return (
    <details className={styles.details}>
      <summary>기준·근거 보기</summary>
      <p className={styles.helper}>
        원고 v{plan.version}의 인용문을 현재 등록본문과 비교합니다. 인용 일치만으로 사실 확인이 끝난
        것은 아닙니다.
      </p>
      <p className={styles.helper}>
        아래 작성 가이드는 앱의 내부 점검용입니다. 공식 배점표나 모든 회사의 필수서류 목록은
        아닙니다.
      </p>
      {plan.content.sections.map((section, index) => {
        const guidance = evaluationFocusItems.filter((item) =>
          item.sectionKeys.includes(section.key),
        );
        return (
          <details className={styles.details} key={`${section.key}-${index}`}>
            <summary>
              {section.title} · 근거 {section.evidence.length}개
            </summary>
            {guidance.length > 0 && (
              <details className={styles.details}>
                <summary>관련 작성 가이드</summary>
                {guidance.map((item) => (
                  <div className="mt-3" key={item.id}>
                    <p className="text-sm font-medium">{item.title}</p>
                    <p className={styles.helper}>{item.question}</p>
                  </div>
                ))}
              </details>
            )}
            {section.evidence.length === 0 ? (
              <EvidenceList company={company} evidence={[]} />
            ) : (
              section.evidence.map((reference, referenceIndex) => {
                const matches = company.sources.filter((item) => item.id === reference.sourceId);
                const source = matches.length === 1 ? matches[0] : null;
                const changedAfterPlan =
                  source && Date.parse(source.updatedAt) > Date.parse(plan.generatedAt);
                return (
                  <div className="mt-4 space-y-2" key={`${reference.sourceId}-${referenceIndex}`}>
                    <p className="text-xs font-medium">{referenceStatus(company, reference)}</p>
                    {reference.sourceId === "profile" && (
                      <p className={styles.helper}>
                        기업이 입력한 설명입니다. 별도 증빙 확인이 필요합니다.
                      </p>
                    )}
                    {changedAfterPlan && (
                      <p className={styles.helper}>
                        원고 작성 후 수정된 자료입니다. 변경 내용을 확인해 주세요.
                      </p>
                    )}
                    <EvidenceList company={company} evidence={[reference]} />
                  </div>
                );
              })
            )}
          </details>
        );
      })}
      <details className={styles.details}>
        <summary>신청별 기준 기록</summary>
        <p className={styles.helper}>
          담당자가 보관한 기준입니다. 이 원고와의 대조 및 회사별 적용 여부는 별도 확인이 필요합니다.
        </p>
        {company.applications.length === 0 ? (
          <p className={styles.helper}>신청별로 연결한 기준 기록이 없습니다.</p>
        ) : (
          company.applications.map((application) => (
            <ApplicationCriteriaReference
              key={application.id}
              company={company}
              applicationId={application.id}
            />
          ))
        )}
      </details>
    </details>
  );
}
