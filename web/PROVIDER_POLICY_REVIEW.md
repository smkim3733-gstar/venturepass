# 운영 정책·누적 예산 검토 계약

2026-09-28 구현. 서버 고정 공식 설정, 등록 후보의 정확한 요청, 현재 production 예산 원장을 하나의 읽기 전용 검토 결과로 묶는다. 기존 원장 형식과 production 쓰기 제한은 변경하지 않는다.

## 모듈과 신뢰 경계

- `src/lib/studio-plan-quality-provider-policy-review.ts`: `createProviderPolicyReview()`와 `isProviderPolicyReviewCurrent()`.
- `src/lib/studio-plan-quality-provider-policy-review-types.ts`: 엄격한 JSON 스키마와 금액 일관성 검사.
- `src/lib/studio-plan-quality-provider-policy-review.test.ts`: 합성 입력과 메모리 내 원장으로 검증한다. 테스트의 production 형식은 실제 승인이나 청구 사실의 증거가 아니다.

호출자는 서버 고정 configuration, 검증된 후보 registry, 서버 조회 시각, 동일한 트랜잭션에서 읽은 production 예산 이벤트와 revision/head를 전달해야 한다. 이벤트와 head를 클라이언트가 제출한 값으로 대체하면 안 된다. 저장소의 전체 검사에서 관련 run·receipt·artifact의 일관성을 먼저 확인해야 한다. 이 모듈이 재검증하는 범위는 예산 이벤트 체인이며, 공개 hash 자체는 인증 수단이 아니다.

## 계산과 상태

| 상황 | 결과 |
| --- | --- |
| 원장 미설정 | 실제 잔액은 0, revision 0/head null을 유지한다. 미승인 제안 한도에 대한 가정 계산을 별도로 표시한다. |
| 기존 예산 존재 | 기존 한도에서 인정된 사용 금액과 미정산 예약을 차감한다. 새 제안 금액으로 한도를 덮어쓰거나 재조회 때 초기화하지 않는다. |
| 예약액 부족 | 추가 예약 후 가용액은 0, 부족액은 별도 필드로 반환한다. |
| 통화·금액 단위 불일치 | 서로 다른 단위의 금액을 차감하지 않으며 예약 후 계산값을 반환하지 않는다. |
| 이전 실행의 한도 위반 | 현재 누적 잔액이 남아 있어도 위반 상태를 유지한다. |
| 설정 만료·변조 또는 원장 오류 | 금액이 없는 unavailable 결과와 정해진 사유만 반환한다. |

계산은 정수 문자열과 BigInt를 사용한다. 입력 금액 문자열이 잘못된 경우 산술 예외를 내지 않고 스키마 검증에서 거절한다. `policyReview` 객체에는 원장 이벤트 본문, run ID, 요청 본문, 실행 준비안, 전송 manifest를 넣지 않는다. 조회본의 기존 `proposal.requestReview`에는 검토 목적의 정확한 합성 요청이 계속 포함된다.

## 유효성 재확인

검토 결과는 configuration, 후보 scope, 요청, 금융 근거, 보관 조건, usage 정책, 현재 예산 revision/head에 묶인다. 유효기간은 조회 후 15분과 공식 근거의 가장 이른 재확인 기한 중 빠른 시각까지이며, 경계 시각부터 만료된다.

`isProviderPolicyReviewCurrent()`는 현재 서버 입력으로 원래 검토를 다시 계산하여 비교한다. 후보·설정·예산이 바뀌거나 검토 hash가 변조됐거나 시간이 지났으면 false를 반환한다. true도 정책 채택, 예산 설정, 예약 또는 전송 권한은 부여하지 않는다. 해당 권한 필드는 항상 false다.

## 검증 결과

2026-09-28: 이 계약과 기존 설정·예산·실행·읽기 전용 서비스·백업을 포함한 관련 6파일 테스트 226개 통과. 최종 TypeScript 호환성 수정 후 계약 테스트 34개를 재실행하여 통과했다(226개에 포함). lint, typecheck, Webpack 빌드도 통과했다. 전체 저장소 테스트와 실제 유료 API 호출은 이번 검증에 포함하지 않았다.

같은 날 서버·화면 연결 검증: 관련 11파일 317개 통과 후 사례 3개를 추가하고 영향받은 2파일 29개를 재실행하여 통과했다. 중복을 제외하면 320개이며, 최종 lint·typecheck·Webpack 빌드도 통과했다. 새 저장소 통합 검증은 실제 임시 SQLite에서 설정된 production 형식의 한도 보존, 합성 잔액 분리, 잘못된 receipt·artifact 거절과 조회 전후 행 불변을 확인한다. 해당 production 형식은 합성 프로토콜 자료일 뿐 실제 승인·결제 증거가 아니다.

실제 빌드의 Edge headless 검증에서는 임시 합성 후보를 열어 조회·다운로드·다시 읽기를 완료했다. v4 JSON 원문 일치, 예산 불변, 브라우저 오류 0건 및 외부 요청 0건을 확인했다. 1280px/390px 화면을 시각 점검했고 예산 표시 영역의 가로 넘침이 없었다. 전체 저장소 테스트·실제 유료 호출·운영 승인 검증은 수행하지 않았다.

## 서버·화면 연결 완료

`PlanQualityStore.providerReviewContext()`는 후보, 전체 원장 검사 결과, production 이벤트·head를 하나의 SQLite 읽기 트랜잭션으로 조회한다. run·receipt·artifact까지 검사하며, 합성 원장의 잔액을 production 잔액에 포함하지 않는다. 조회로 저장 행을 변경하지 않는다.

기존 `/api/studio/quality/provider-review/inspect`는 유효한 공식 제안에 대해 `viewVersion: 4`와 `policyReview`를 반환한다. 누락은 v1, 만료는 v3를 유지한다. `providerReviewResponseSchema`는 v1/v2/v3 보관본과 새 v4를 모두 지원한다. 기존 `providerReviewViewSchema`의 v1/v2/v3 계약은 변경하지 않는다.

브라우저는 원래 제안의 요청·근거 검증에 더해 정책 검토의 후보·조회 시각·기한·근거 digest·제안 한도·예약 계산액을 대조한다. 보관 JSON은 전체 v4 응답을 담으며, 과거 기록은 만료 후에도 읽을 수 있다. 이는 운영 승인이나 최신 원장 확인을 대신하지 않는다.

`QualityProviderPolicyDetails`는 현재 한도·사용액·미정산 예약액·가용액과 추가 예약 가정값을 구분한다. 미설정이면 실제 가용액을 미설정으로 표시하며, 제안 한도를 사용한 계산에는 미승인 가정임을 명시한다. 한도 위반과 통화·단위 불일치를 우선 안내하고, 조회 시점과 재확인 기한을 표시한다. 기존 예산이 있을 때 잘못된 '예산 미설정' 안내를 붙이지 않는다.

## 다음 구현

정책 채택·후보 한 건 예약·별도 전송 승인에 대한 서버 쓰기 계약, 중복 방지와 동시성, 만료 재검사, 실패 복구를 구현한다. production 쓰기와 실제 전송은 여전히 비활성이다. 읽기 전용 검토 결과만으로 활성화하지 않는다.
