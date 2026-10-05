# 4I21 — runtime owner·전송 직전 검사·캡처 복구 연결 명세

고정20개 기능 기준15/20=75%, 미완료5/20=25%, 직전 대비+0%p. 이번4I21은 runtime owner·전송 직전 guard·캡처 복구 연결 계약 점검1건이며 제품 소스 변경0개다. 신규 제품 시험0/0(미실행), 기존 회귀 재실행0·새 HTTP/브라우저/lint/typecheck/빌드0회다. 과거4I20 신규44+기존276=320/320·IWhJXA는 별도이며 재실행/합산하지 않는다. 백업27개 DESTINATION_REPOSITORY 제한은 미해결·이번 미실행이다. 실환경1/5=20%는 과거 사용자 직접 인증/접근이며 앱 자동실행 성공0단계·KOSIS 실제0/1이다. 필수 결정0개, 다음4I22 같은 lease의 비교 owner·최종 시작 guard·캡처 복구 격리 합성 연결3~6시간(잠정), 전체 완료시간 미정, 자동후속 ACTIVE.

이 문서는 **ace577f의 실제 코드를 대조하여 확정한 후속 구현 계약**이다. 아래에 제안한 새 비교 실행 API는 아직 존재하지 않으며 구현·합성 시험·실제 전송을 완료한 것이 아니다. 이번 변경은 문서뿐이다.

## 1. 대조한 현재 소스와 재사용 경계

아래 파일은 모두 D:/개발/codex_2/벤처확인자동화앱개발_최신/venturepass/web/src/lib/ 하위다. 줄 번호는 이번 점검 시점 기준이다.

| 소스·실제 함수 | 확인한 경계 | 후속 연결 |
|---|---|---|
| studio-public-claim-comparison-database-v11.ts:447 private write, :807 guardedWrite, :1154 writeGuardedPublicComparisonV13 | 원래 nonce 감사→회사 잠금→exact INSERT→사후 감사→COMMIT→회사 종료→다시 읽기/증인 ack. guardedWrite는 finally에서 lease 종료 | write 본문·exact gate는 재사용하고 private 수명 소유자가 begin/end를 관리. 공개 writer 반환은 권한 입력으로 받지 않음 |
| 같은 파일:1081 reconcileVersionedWitness | 공개 복구도 begin/end를 호출하며 정확한 DB/명령 감사 뒤 ack 파일만 추가 | 활성 owner의 기존 lease 안에서 같은 본문 실행. 공개 reconcilePublicComparisonStorageWitnessV3를 중첩 호출하지 않음 |
| studio-public-comparison-storage-witness.ts:237/281/288/297 | open은 기존 DB 연결·신원 보관, begin은 배타 lease 취득. active는 lease 상태이며 SQL transaction과 별개. 열린 transaction이면 end/close 거절 | 한 번 begin한 동일 session/lease를 promise·미보관 capture 동안 유지. 새로운 경로/두 번째 session/lease로 대체 금지 |
| 같은 파일:583/602 checkComparisonWitness/checkComparisonWitnessCompany | 두 사본 마지막 checkpoint, 파일/DB 신원과 회사 capability를 대조 | 새 시작 전·후속 기록/복구마다 같은 증인3와 대조 |
| studio-public-comparison-company-guard.ts:35/75/81 | 기존 StudioStore capability의 선택 회사 SELECT, BEGIN IMMEDIATE, 끝은 ROLLBACK | quality→studio 순서의 최종 읽기 잠금. 새 StudioStore를 만들어 guard를 대체하지 않음 |
| studio-public-claim-comparison-transmission-v4.ts:133/471/510 | 전체 binding3/4·원래 전체 명령 감사, 일회용 감사 ticket, 원래 nonce 우선 | 저장/최종 시작에 기존 전체 감사를 사용. 감사 ticket은 실행 owner가 아님 |
| studio-public-claim-comparison-request.ts:94/155 | 원래 context에서 request 재구성, 현재 회사의 전체 요청 신원 대조 | inspectArchivedPublicClaimRequest/inspectPublicClaimComparisonRequest 재사용 |
| studio-plan-quality-provider-production-runtime.ts:32/52/163 | credentials/실행 신원은 WeakMap. 설정 변경은 새 전송 폐기. factory는 generation 전용 store를 생성 | 비밀 비노출·단조 폐기 패턴만 참고. 이 factory/PlanQualityStore를 비교 실행으로 차용하지 않음 |
| studio-plan-quality-provider-sdk-owned.ts:28/79/106 | SDK는 준비 후 비동기 fetch 진입. 실제 fetch 안에서 withCurrentWriter 호출, 시작 promise를 보존한 뒤 await | 한 번 시작/동기 호출/throw 이후 promise 보존 순서 재사용. 기존 prepared 타입을 비교로 cast하지 않음 |
| studio-plan-quality-provider-transport-boundary.ts:42/105 | prepared phase가 generation/review, request/body schema와 해시도 그 목적에 결합 | 비교 목적 passive adapter 필요. 이 함수의 성공이 비교 SDK 지원 증거가 아님 |
| studio-plan-quality-provider-sdk-wire.ts:21 snapshotProviderSdkWire | 고정 HTTPS URL/POST/정확한 rawBody/헤더 allowlist/retry0/signal/redirect:error 대조. 권한 없는 함수 | 원문 wire 검사는 그대로 재사용 가능. 반환 header/key는 private driver 밖에 노출 금지 |
| studio-plan-quality-provider-production-service.ts:32/71, production-server.ts:35/65 | active/pending capture 보관·같은 store의 복구·draining 수명. 일반 생산 store 생성자는 비교SQL13 연결 아님 | 비공개 보관·교체 금지 원칙 재사용. 기존 server 설치/registry를 비교용으로 열지 않음 |

참고 계약은4I20 SQL13/증인3 저장 명세와4I18 owner 수명 명세다. SQL13/native4/schema3/manifest1·요청v1/예약binding3·전송binding1/2/3/4·증인1/2/3과 coverage target10은 그대로다. 이 연결에 SQL14·별도 owner/nonce/승인 원장을 만들지 않는다.

## 2. 같은 lease 안의 private 실행 수명

기존 guardedWrite와 공개 V11/V12/V13 writer의 동작은 유지한다. 새 비교 composition은 같은 writer 모듈의 private write를 직접 사용하고 그 내부에서만 owner를 보관한다. 외부 transaction 함수나 일반 writer callback을 받지 않으며 write/persist/permits를 공개하지 않는다.

후속 격리 API 이름과 역할은 아래로 확정한다. **제안 이름이며 이번 코드에는 미구현**이다.

| API/내부 동작 | 입력과 반환 계약 |
|---|---|
| createIsolatedPublicComparisonExecution | 기존 ComparisonStorageSession, 기존 회사 guard, 명시적인 합성 fixture driver만 constructor에 고정. 실제 runtime/key/global fetch/SDK factory를 받거나 생성하지 않음. synthetic source의 execute/recover/inspect/retire 포트만 반환 |
| execute(command, current) | 기존 strict dispatch 명령2, 기존 검토안2/basis/usagePolicy/at/eventId와 constructor의 company guard. 전체 원장·원래 nonce 조회를 먼저 수행. 새 작업에만 current/시계/새 ID·driver 준비를 읽음 |
| private beginOwnedComparisonDispatch | 같은 lease에서 write(..., approve-dispatch, ..., version13)를 직접 호출. fresh COMMIT+정확한 ack를 관측한 호출의 지역변수와 사후 감사 snapshot을 private WeakMap에 넣음. 공개 결과 객체/boolean을 인수로 받지 않음 |
| private startOwnedComparisonRequest | 원래 driver가 실제 시작 경계에 진입할 때만 내부에서 호출. owner·same lease·원래 command/dispatch·현재 회사/시각/wire를 검사하고 한 번 시작 |
| private persistOwnedComparisonCapture | 같은 owner의 첫 canonical capture와 그때 고정한 원래 명령/nonce만 사용. write의 persist-capture와 전체 감사를 재사용 |
| recover(selection) | data-only 원래 run/dispatch 명령 digest의 strict 식별자. response/새 nonce/key/가격/회사/driver/callback 입력 없음. private retained owner를 찾아 원래 저장 조회/ack 복구만 수행 |
| inspect/retire | 신원/원문 없는 phase·관측 boolean·개수만 반환. retire는 새 시작을 닫고 draining. 미보관 원문이나 불명 SQL/lease를 버리지 않음 |

격리 factory는 생산 권한을 발급하지 않는다. 합성 driver는 test fixture 생성 때만 주입하고 명령에는 받지 않는다. driver가 전달받는 시작 hook도 내부 one-shot wrapper이며 저장 transaction을 받지 않는다. 합성 driver의 임의 callback이나 provenance 문자열을 실제 제공자 관측으로 승격하지 않는다. 생산 composition 연결은 별도 미완료다.

private write는 lease를 소유하지 않으므로 기존 본문을 복제할 필요가 없다. 내부 reconcileVersionedWitness의 lease 소유 여부만 동일 모듈의 검증된 private capability로 구분해 본문을 재사용한다. 공개 호출은 이전처럼 begin/end를 소유한다. 호출자 boolean/optional transaction으로 lease 대조를 건너뛰지 않는다. owner 상태의 쓰기/복구는 동기적으로 직렬화하고 await 중에는 SQL 거래를 모두 끝낸다.

기존 session.active가 true여도 db.isTransaction은 false여야 HTTP 대기가 가능하다. 공개 writer/reconcile의 재진입은 STORAGE_SESSION_BUSY로 닫힌다. 같은 DB의 다른 session/프로세스는 lease 또는 quality 잠금에서 닫혀야 한다. 같은 owner의 중복 execute는 새 driver/owner를 만들지 않으며 원래 명령 불일치는 충돌이다. 정확한 replay라고 보고할 때에는 기존 전체 감사가 필요하고, 단순 in-progress view와 구분한다.

## 3. owner 발급과 관측 정보

발급 조건은 한 호출 안에서 다음이 모두 확인된 경우다.

1. 전체 prefix/native/금액/예약/전송 binding 감사와 원래 명령 조회가 완료되고 같은 nonce가 새 명령이다.
2. dispatch 명령2/검토안2/binding4·회사 capability·같은 scope/기한/용량 검사가 통과했다.
3. dispatch3행 COMMIT이 정상 반환하고 db.isTransaction=false를 확인했다. 회사 SELECT 거래 종료도 확인했다.
4. 같은 lease 아래 다시 읽은 전체 DB·원래 행/명령·정확한 양쪽 증인 ack가 일치하고 그 읽기 거래 종료까지 확인했다.
5. constructor의 수명 소유자가 종료/폐기되지 않았고 아직 다른 send attempt가 없다.

지역 COMMIT flag를 공개 반환 객체에서 다시 읽어 mint하지 않는다. 생성한 owner는 비직렬화 WeakMap key이며 spread/JSON/프로토타입/TS cast로 재생성되지 않는다. owner에는 원래 session/DB·회사 guard 신원, dispatch 명령/영수증/binding digest, post-dispatch checkpoint, 원래 request rawBody/identity/context, 정책/기한, 후속 명령/nonce, one-shot 상태/promise/최초 capture를 private로 둔다.

생산 승인 진위는 이 capability가 증명하지 않는다. 다음4I22 결과는 source=synthetic-comparison-execution, 공개 owner:null, 기존 authority 전부 false다. runtimeObserved도 false이며 syntheticStartObserved만 별도로 기록한다. 향후 실제 실행 source는 인증된 private 생산 composition이 직접 관측한 현재 실행에만 붙일 수 있다. 기존 stored supplied/false authority bytes를 소급 변경하지 않는다.

공개 view의 phase는 replay, dispatch-recorded, start-refused, in-flight, unknown, capture-retained, capture-persisted, draining, recovery-required, closed로 한정한다. dispatchCommitObserved, witnessMatched, startAttempted, capturePersisted, promiseSettled, cleanupRequired는 독립 관측이다. closed는 실행 수명 종료이며 사업계획서/비교 품질·정산 완료가 아니다. rawBody/capture/header/key/SDK error/cause/owner token은 view·로그에 없다.

COMMIT 결과 유실·ack 미확정·회사 종료 실패는 새 send owner0이다. 원래 DB행을 찾거나 ack를 나중에 복구해도 발급 조건3~4를 원래 호출에서 관측한 것이 아니므로 owner를 새로 만들지 않는다. 이 경우에도 불명 lease의 정리 책임을 가진 private 보관 객체는 남길 수 있으나 send capability와 구분한다.

## 4. 실제 시작 직전의 잠금과 head 관계

준비 시점의 검사로 대체할 수 없다. 후속 실제 SDK도 비동기 준비 뒤 fetch hook에서 아래 순서를 따라야 하며4I22는 이를 지연 가능한 합성 hook으로 검사한다.

1. one-shot owner·활성 lease를 확인하고 두 번째 hook 진입을 먼저 닫는다. wire snapshot은 descriptor/헤더 검사를 포함해 잠금 전에 복사하며 공급된 가변 input을 network에 그대로 넘기지 않는다.
2. quality BEGIN IMMEDIATE→정확한SQL13/전체 감사→checkpoint/증인3/파일 신원 대조→studio beginComparisonCompanyRead 순서다. SDK client 생성 시 이 거래를 열어 await하지 않는다.
3. 현재 DB checkpoint는 owner가 발급 당시 고정한 **post-dispatch checkpoint**와 같아야 한다. 해당 run의 최신 event는 바로 자기 dispatch이며 unknown/response/result/close가 없어야 한다. 원래 dispatch 명령·binding4/영수증과 nonce가 완전 일치해야 한다.
4. binding 감사는 dispatch 직전 예약 상태의 review2를 재구성한다. pre-dispatch review head와 post-dispatch current head는 서로 다르므로 직접 같다고 요구하지 않는다. dispatch는 native event/receipt/binding만 추가하고 금액 event는 추가하지 않는다. 따라서 원래 금액 revision/head·cap/recognized/held/available와 원래 hold는 불변이며 정확한3행/현재 checkpoint 관계로 확인한다.
5. inspectPublicClaimComparisonRequest로 선택 회사의 전체 원래 request/identity를 재대조한다. 같은 revision에서 본문이 바뀐 경우도 닫는다. checkComparisonWitnessCompany/checkComparisonCompanyRead로 원래 studio 파일/잠금 신원을 확인한다.
6. 원래 고정 basis는 comparisonTransmissionCore.validateBasis, 정책은 validateComparisonUsagePolicy로 현재 시각에 다시 검사한다. 원래 approvedReview.expiresAt/예약/정책 기한의 최솟값을 연장하지 않는다. reviewFor는 dispatch 전 전용이므로 현재 state로 새 review를 만들지 않는다. 전체 감사에서 복원한 원래 binding과 고정 근거만 사용한다.
7. 감사 전 wall clock와 단조시계 deadline을 읽고 검사 종료 직전에 다시 확인한다. 시계 역행·같은/지난 만료·signal abort·runtime 폐기·파일/lease 변화·용량/hold 불일치는 시작 거절이다. 실제 key/설정 확인은 미래 production driver 안에만 두며 capture 복구에는 요구하지 않는다.
8. 잠금 아래 one-shot를 소비한 뒤 network/startFake를 **동기 호출**하고 promise에 즉시 rejection handler를 붙인다. 동기 throw도 startAttempted=true를 유지한다. studio SELECT는 ROLLBACK, quality의 읽기 transaction도 명시 종료하고 잠금 밖에서 await한다.

시작 뒤 SQL 종료 실패가 나도 이미 얻은 promise를 폐기하지 않는다. 정리 실패 상태를 별도로 남기고 원래 응답의 첫 capture 수명을 계속 소유한다. 열려 있는 거래가 남았다면 같은 소유자만 정확한 rollback 정리를 시도하며 확인 전 다른 저장/lease 종료를 열지 않는다. DB2개·증인파일·네트워크의 원자성은 없다.

## 5. 요청v1과 공통 transport 기구

비교 adapter는 inspectArchivedPublicClaimRequest로 원래 문맥/명령에서 복원한 요청만 받는다. body/rawBody·문자수/UTF8 bytes/해시·strict schema·POST 목적지/store:false/max_output_tokens16000/1회/재시도0을 대조한다. service_tier/truncation/background/stream은 생략한 그대로이며 requestedTier:null을 default로 채우지 않는다. native3/5의 generation/review request 형식으로 cast하지 않는다.

snapshotProviderSdkWire는 문자열 rawBody만 대조하므로 재사용 가능하다. providerTransportSdkOptions의 자격증명 없는 고정 timeout120000/maxRetries0/redirect:error 등은 권한 없이 재사용할 수 있지만 이것만으로 실제 비교 SDK wire가 맞는지는 입증되지 않는다. prepareProviderTransportBoundary는 purpose-specific이므로 그대로 호출하지 않는다.

후속 비교 passive adapter 이름은 preparePublicComparisonTransportBoundary로 정한다. 입력은 서버가 기존 request inspector로 만든 bounded JSON이며 새 명령/승인·callback/API키를 받지 않는다. 반환은 frozen 비교 request와 capture/failure 변환, source=supplied-comparison-transport-boundary, dispatchAllowed:false다. canonical capture는 기존 captureProviderResponse를 사용한다. 기존 decoder/usage 산술이나 response schema를 새로 작성하지 않는다. HTTP 오류의 안전한 분류만 공통화가 필요하면 기존 좁은 무권한 함수로 공유하고 오류원문/headers/cause를 보관하지 않는다.

4I22는 실제 OpenAI SDK를 import/생성/호출하지 않는다. 합성 driver로 비동기 준비→정확한 wire→one-shot 시작→delayed 결과를 검증한다. 실제SDK 호환성·옵션 지원·가격 진위·사람의 전송 동의·production 활성화는 별도 미완료이며 근거가 없으면 실행을 닫는다.

## 6. 최초 capture·unknown·복구·종료

원래 driver의 완료 handler에서 captureProviderResponse를 동기 호출하고 원래 owner에 첫 사본을 보관한다. await/DB 저장/회사 재조회/출력·사용량 판정보다 먼저다. 두 번째 응답·교체 원문·임의 HTTP JSON은 실제 owner의 capture를 대체하지 못한다. 현재 capturePublicClaimComparisonResponse는 회사 인수를 받는 passive supplied helper이므로 이미 시작된 응답 보관을 현재 회사에 다시 의존시키지 않는다.

동일 owner의 상태 변경은 직렬화한다. timeout/abort 관측으로 unknown2행을 저장하는 동안 late response가 도착하면 첫 사본을 먼저 보관하고 그 동기 저장이 끝난 뒤 최신 원래 head에서 capture 명령을 한 번 만든다. capture가 먼저 기록되면 뒤늦은 unknown을 추가하지 않는다. write에 넘기기 전 nonce/eventId/at/명령 전체와 canonical bytes·SHA/길이를 고정한다. 저장 실패 뒤 현재시각/새 ID를 넣어 같은 명령을 바꾸지 않는다.

unknown은 자동 취소/해제/새 전송 근거가 아니다. request가 끝났다는 관측도 provider 비용0의 증거가 아니다. 원래 pending promise가 계속될 수 있으면 unknown 후에도 first late capture를 같은 lease 아래 받는다. 이미 끝난 promise에 응답을 임의로 만들어 붙이지 않는다.

복구는 아래 세 경우로 구분한다.

- **정확한 원래 DB행/명령과 ack가 모두 있음:** 원래 bytes를 대조해 보관 확정. SQL 재삽입0.
- **정확한 원래 DB행/전체 명령은 있고 ack만 미확정:** 같은 활성 lease 안에서 기존 acknowledgeComparisonWitness/전체 감사 본문으로 파일 ack만 복구. dispatch owner를 새로 발급하지 않음.
- **intent만 남고 SQL행 없음·부분 사본/부분행·원문 충돌·DB 되돌림·lease/SQL 종료 불명:** recovery-required. 자동 행 재삽입/새 nonce/새 경로로 복구하지 않음. private capture는 유지하고 별도 복구 절차가 확정되기 전 차단.

캡처 command 자체를 만들기 전의 확정 로컬 오류와 이미 발행한 command의 불명 저장은 구분한다. 처음 쓰기 여부가 불명해졌으면 위 조회를 먼저 한다. helper를 실패할 때마다 다시 호출하며 원문/시각을 바꾸지 않는다.

종료 조건은 정확한 capture artifact/event/receipt+증인 확인, 원래 promise 종료, 열린 SQL 거래 없음, 원래 lease 정상 종료다. 캡처가 보관돼도 promise가 살아 있으면 owner/lease 유지다. promise가 끝나도 캡처가 미확정이면 유지다. lease 종료가 실패하면 closed로 표시하거나 새로운 owner를 설치하지 않는다. capture 사본은 정리 성공까지 유지한다.

응답이 끝내 없거나 canonical capture 실패이면 위 정상 종료 조건을 만족하지 못한다. 다음4I22는 unknown/hold·recovery-required와 비공개 정리 책임을 유지하는 보수적 경계까지 구현한다. 시간/PID/사용자 연결 끊김/retire만으로 lease 삭제·run 종료·예산 해제를 하지 않는다. 프로세스 종료는 메모리 capture 보존을 보장하지 않으며 재시작은 기록에서 send owner를 복원하지 않는다. 남은 lease의 명시 복구/해제 정책은 이번 범위 밖이다.

캡처 확정 이후 기존 planComparisonPostcapture와 SQL13 record-result/settle-finalize가 원래 context/policy로 계산한다. 실행 owner가 끝나도 저장된 캡처 기반 작업은 가능하다. missing usage/binding3 정책 없음이면 close0행/hold 유지, 명시0·초과 비용은 기존4I19/20 규칙 그대로다. 메모리 종료·금액 해제·32MiB 저장 예약 해제를 혼동하지 않는다.

## 7. 실패·반환 결정표

| 관측 | owner/시작 | 저장·복구/반환 |
|---|---|---|
| 같은 nonce/전체 명령 replay, 현재 회사/가격 소실 | 새 owner0·driver 준비0 | 원래 전체 감사 후 replay, rows0; 현재입력 getter/시계/ID 읽지 않음 |
| nonce 충돌·과거 전체 원장 손상 | owner0·시작0 | 거절. nonce 한 건만 읽어 성공 금지 |
| 새 dispatch 전 현재 회사/기한/지원 근거 거절 | owner0·시작0 | 기존 저장 경계에 따라 차단. 실제 생산 권한은 계속false |
| dispatch SQL COMMIT 반환 유실/무동작 | owner0·시작0 | 원래 행/명령 조회만. hold 유지·불명 기록을 새전송으로 대체 금지 |
| COMMIT 관측 후 ack/회사/읽기 거래 종료 실패 | send owner0 | COMMIT 관측true를 보존·recovery-required. ack 복구는 권한 발급 아님 |
| fresh owner 후 fetch 진입 전 회사/파일/기한/정책/시각 변경 | 시작0, one-shot 재사용0 | start-refused/unknown 경계, hold 유지. cleanup 정상이라도 자동 취소하지 않음 |
| 동기 network throw·timeout/abort/HTTP/JSON decode 실패 | startAttemptedtrue·재시도0 | unknown, 비용불명·hold 유지. 실제 오류원문 비노출 |
| 시작 뒤 SQL 종료 실패 + 후속 성공 응답 | promise/capture 유지 | 정리 불명과 capture-retained를 함께 표시; 후속 정리/원래 보관 복구만 |
| unknown 뒤 first late capture | 새 dispatch0 | 원래 binding/최신 원래 head로 최초 capture3행 |
| capture COMMIT 반환 유실·ack 실패 | 원래 capture/nonce 유지 | 조회·ack 파일만 복구, SDK/재전송0 |
| 회사 삭제·키/가격 만료 뒤 보관 | 새 전송 없음 | 원래 캡처 보관 허용, current company/key/가격 재조회 불필요 |
| capture 확정 + promise 종료 + usage unknown | send owner/lease 정상 정리 가능 | DB run/hold 유지, 결과/정산은 기존 writer |
| cleanup 실패/retire/모듈 재적재/프로세스 종료 | 새 owner 설치/복원0 | draining/recovery-required. 원문/hold 재생성·자동 lease 삭제0 |
| policy로 계산한 실제 C>H | 새로운 실행 거절 | 기존 close8행의 전체C/excess 그대로. 비용을H나0으로 자르지 않음 |

## 8. 다음4I22 전체 완료 조건

한 구현 단위에서 private lease 수명·fresh owner·최종 시작 guard·첫 캡처/동일원문 복구·종료까지 연결한다. 다음 항목을 구현하거나 시험하지 않은 채 합성 owner 완료로 보고하지 않는다.

1. 동일 모듈 private write와 reconcile 본문을 재사용한다. 공개 V13 API의 기존 lease/owner:null 동작과 SQL13/증인3·과거bytes를 보존한다. raw DatabaseSync/transaction/permit/일반 writer callback을 새 공개 권한 API에 노출하지 않는다.
2. 같은 lease를 얻고 새 dispatch3행의 COMMIT/양쪽 ack/거래 종료를 직접 관측한 내부 호출만 일회용 WeakMap capability를 갖는다. forged/spread/JSON token, public commitObserved:true, replay, 불명 COMMIT, ack 복구, 재시작으로 발급되지 않음을 확인한다.
3. 원래 nonce/전체 명령 조회 우선: current getter/시계/새ID/driver가 throw하는 입력을 replay에 넣어 읽지 않음을 확인한다. 내부 nonce/다른 명령 충돌과 기존 전체 감사 유지.
4. 합성 async 준비 동안 회사revision/동일revision 본문·원문 request·기한·시계역행·policy·파일·lease·native/budget head 변경을 주입해 실제 시작 경계에서 거절한다. 옛reviewhead를현재와단순비교하지않고 정상 자기dispatch 이후 시작은 통과시킨다.
5. 선택 회사/quality의 경쟁 연결에서 quality→studio 잠금과 동기 시작을 관측한다. 잠금 중 callback 지연await0, 시작 뒤 SQL잠금 없음·lease 있음, 두 번째fetch/hook/동시execute 거절, 시작직후throw·rollback실패에도 promise/capture 유지.
6. 정확한 rawBody/wire·requestedTier:null과 네 생략옵션 보존. SDK준비/네트워크 호출0이며 합성 driver의 delayed 진입/응답으로만 검사한다. provider SDK import/production constructor/globalfetch/environmentkey lookup은 테스트에서 금지한다.
7. dispatch→unknown→late capture, capture먼저→unknown생략, 원래회사삭제/가격만료 뒤 첫 캡처, refusal/불완전/사용량누락 보관을 기존 decoder/writer로 검사한다. 첫동기capture를 보관/투영실패 전에 유지하고 두번째/대체원문을 거절한다.
8. capture INSERT/COMMIT반환유실/ack/SQL종료/lease종료 실패, 원래nonce/bytes 재조회, 정확한DB행일때ack파일만복구, intent-only/부분사본/원문충돌/되돌림의fail-closed를 확인한다. 캡처없는terminalunknown을 임의정리/0원처리하지 않음도 검사한다.
9. capture확정+promise종료 이후만owner/lease종료; usageunknown의DBhold보존, 기존result3/close8행 및binding3close차단·known0/excess·원래prefixbytes를 회귀로 확인한다. 운영backup과fixture재열기를 구분한다.
10. 실제 기존server/SDK실행·키/공식가격·운영DB/control/routesUI/계정접속을 열지 않는다. 관련 대상회귀(maxWorkers1,알려진백업파일내시험제외)→lint→typecheck→격리build:local의 종료코드를 순서대로확인하고 관련파일만 로컬commit한다. 합성source/실제권한false와 검증한범위를 인계한다.

다음4I22는 기획/공개주장_runtime_owner_전송직전검사_복구_연결명세_20261006.md의 전체 완료 조건에 따라 기존 SQL13 private write와 증인3의 같은 lease 안에서 비교 owner·전송 직전 quality→studio guard·최초 capture/복구 수명을 한 격리 합성 단위로 연결한다. guardedWrite 공개 반환/commitObserved boolean으로 owner를 만들지 않고 새 dispatch COMMIT·정확한 ack를 직접 관측한 내부 호출만 일회용 capability를 보관한다. 기존 writer/감사/원문 decoder/산술/증인을 복제하거나 SQL14·새 원장을 만들지 않는다. replay/불명 COMMIT/ack 복구/재시작은 새 전송 owner0이다. 원래 nonce 조회가 현재 회사·시계/근거·새 ID·driver 준비보다 먼저다. 최종 guard는 자기 dispatch 이후 정확한 checkpoint/binding·원래 hold/금액 head와 현재 회사/원래 request·기한/파일/lease를 대조하며 옛 review head를 현재와 단순 비교하지 않는다. 비교 요청v1/requestedTier:null·생략 옵션을 유지하고 실제 SDK 없이 지연 가능한 합성 시작 경계에서 잠금 안 동기 시작·잠금 밖 await·두 번째 시작 거절을 시험한다. unknown/late capture와 같은 nonce/bytes의 보관·ack만 복구, COMMIT/정리 실패 시 원래 capture/lease 보존, 캡처 확정+promise 종료 후 정리 및 usage unknown의 DB hold 유지를 검증한다. 응답이 끝내 없으면 recovery-required로 남기며 시간/PID/종료 버튼으로 lease나 hold를 자동 해제하지 않는다. 합성 source와 authority:false/공개 owner:null을 유지하고 실제 SDK import/실행·fetch/키/공식 가격 설정·production runtime 설치·route/UI·고객/운영 DB·완료 control/lock·외부 전송은 열지 않는다. 백업27개 제한은 반복/우회하지 않는다. 필수 결정0개·다음3~6시간 잠정·전체 완료시간 미정·자동후속 ACTIVE.

## 9. 이번 검증과 남은 범위

이번은 위 소스/기존 계약의 읽기 대조와 문서 변경뿐이다. 신규 제품 시험0/0(미실행), 기존 회귀/HTTP/브라우저/lint/typecheck/빌드0회다. 과거4I20 320/320·IWhJXA를 이번 검증으로 재사용·합산하지 않는다. 후속 owner/SDK/실제 사람동의/가격/전송은 미완료이며 새 계획을 완료 기능 수에 더하지 않는다.

백업27개 경로 제한과 일반 v10~v13 backup/restore 미지원은 미해결·이번 미실행이다. 보호7개SHA와 제품소스 불변을 문서commit 전후 대조한다. 고객/운영DB·키/완료control/lock·원래nonce/비용/원문·수동judgement 변경0, 실제외부/SDK/AI/계정조회0, 새채팅/하위에이전트0·모델/effort확인/변경0이다. F12/F13/F18~F20의 실제 미완료와 사람 인수는 그대로다.
