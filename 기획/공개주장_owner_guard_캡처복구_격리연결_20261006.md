# 비교 owner·최종 시작 guard·캡처 복구의 격리 연결 — 4I22

2026-10-06

고정20개 기능 기준15/20=75%, 미완료5/20=25%, 직전 대비+0%p. 이번4I22 관련3시험 파일 신규50/50+이번 기존14/14=64/64개 통과다. 초기 fixture import 순서·checkpoint 입력과 읽기 종료 실패의 phase를 보완했고 예비/선택/영향 반복은 재합산하지 않는다. 전체 lint의 시험 const 표현1개를 보완한 최종 lint·첫 typecheck·격리빌드1mafLl 통과, 변경 앱4개 SHA 일치·빌드 env 부재·보호7개 SHA 불변이다. 새 HTTP/브라우저·실제 외부/고객자료/SDK/AI0이다. 과거4I20 전체320/320·IWhJXA와4I19 370/370·BmapP2는 별도이며 이번 고유64개에 합산하지 않는다. 백업27개 DESTINATION_REPOSITORY 제한은 미해결·이번 미실행이다. 실환경1/5=20%는 과거 사용자 직접 인증/접근이며 앱 자동실행 성공0단계·KOSIS 실제0/1이다. 필수 결정0개, 다음4I23 비교 목적 SDK adapter·운영 연결 계약 점검1~3시간(잠정), 전체 완료시간 미정, 자동후속 ACTIVE.

## 구현 범위

기존 SQL13 private write와 증인3의 한 lease에 비교 실행 수명을 연결했다. 제품 소스는 기존 `studio-public-claim-comparison-database-v11.ts`와 새 `studio-public-claim-comparison-transport.ts` 두 개다. 기존 공개 writer는 호출 끝에 lease를 종료하고, 새 격리 composition만 같은 모듈의 private write를 직접 사용한다. SQL14, 새 표, 별도 owner/nonce/승인 원장, 새 가격 산술이나 native decoder는 없다.

`createIsolatedPublicComparisonExecution`은 기존 storage session·회사 guard·명시 합성 fixture driver를 constructor에 묶고 execute/recover/inspect/retire만 반환한다. DB 연결·transaction·writer callback·owner token은 반환하지 않는다. driver의 합성 token과 비공개 owner는 WeakMap으로 대조한다. 합성 callback은 시험 코드이며 실제 제공자 실행이나 사람 동의의 인증 수단이 아니다. route/UI/production runtime의 호출 연결은 없다.

원래 nonce·전체 명령은 기존 전체 감사 뒤 새 current/driver를 읽기 전에 조회한다. 정확한 replay는 원래 기록만 반환하며 owner를 발급하지 않는다. 현재 회사/근거가 없어도 원래 조회는 가능하지만, 원장 손상이나 nonce의 다른 전체 명령은 통과하지 못한다. 같은 활성 실행의 정확한 명령 조회는 진행 중 관측이며 새 전송 replay 권한이 아니다.

새 dispatch COMMIT·회사 SELECT 종료·전체 재읽기·양쪽 증인 ack가 같은 내부 호출에서 확인된 경우에만 일회용 owner를 만든다. 공개 writer의 반환 객체/boolean은 입력으로 받지 않는다. COMMIT 유실, ack/회사 종료 실패, 파일 복구, 재시작은 owner를 만들지 않는다. private 호출이 COMMIT을 관측했다는 사실은 오류 경로에도 표시하지만 실제 전송 권한과 구분한다.

dispatch 이전 거절에서 원래 checkpoint와 DB/증인이 그대로임을 대조한 경우에는 미사용 lease만 종료한다. intent·행 변경·불명 COMMIT이나 SQL 정리 실패가 있으면 이 경로를 쓰지 않는다. 이미 dispatch된 요청의 응답 없음과 hold를 자동 해제하는 기능이 아니다.

## 최종 시작과 요청

owner는 자기 dispatch 이후 checkpoint와 binding4, 원래 금액 head를 고정한다. 최종 시작에서 같은 lease의 quality BEGIN IMMEDIATE→studio SELECT 잠금 순으로 다시 읽는다. 최신 run head가 바로 자기 dispatch인지, 금액 revision/head가 원래 명령과 같은지, 전체 DB/증인 checkpoint·파일·회사/원래 요청·정책/기한이 맞는지 대조한다. dispatch 전 review head와 변경된 현재 native head를 직접 같다고 요구하지 않는다.

기존 inspectPublicClaimComparisonRequest, comparisonTransmissionCore.validateBasis, validateComparisonUsagePolicy를 사용한다. wall clock의 역행/만료와 단조시계 deadline, abort, 폐기와 한 번 시작 여부를 확인한다. 합성 시작 함수 호출과 rejection handler 설치는 잠금 안에서 동기 실행한다. promise 대기는 잠금 밖이며 같은 lease만 남는다. 시작 뒤 잠금 정리가 실패해도 원래 promise를 버리지 않는다. unknown/폐기는 새로운 시작 근거가 아니다.

새 passive boundary는 기존 inspectArchivedPublicClaimRequest로 원래 command/context/identity에서 정확한 rawBody를 재구성한다. snapshotProviderSdkWire의 고정 URL·POST·body·header/signal/redirect 검사를 재사용한다. requestedTier:null, store:false, 출력16000/한 번/재시도0과 service_tier/truncation/background/stream 생략을 유지한다. generation/review/default 계약으로 cast하지 않는다.

driver에는 공개된 합성 문자열만 wire 대조용으로 사용한다. 실제 키·현재 구성·SDK factory·global fetch를 찾지 않으며 OpenAI SDK를 import/생성/호출하는 새 경로도 없다. 실제 설치 SDK의 옵션 지원이나 공식 가격 진위는 이번 합성 검사로 확인한 것이 아니다.

## 최초 캡처와 보관 복구

원래 network promise가 반환한 값은 기존 captureProviderResponse로 즉시 좁은 canonical 사본을 만든다. DB 쓰기·회사 재조회·비교 의견/금액 판정보다 먼저 보관한다. 첫 사본은 교체하지 않는다. 응답 보관은 현재 회사 삭제·현재 가격/기한 변경에 다시 의존하지 않는다. 전체 HTTP stream/headers를 보관한 증거는 아니다.

unknown은 기존 event/receipt2행, 첫 capture는 기존 artifact/event/receipt3행을 같은 private writer로 저장한다. 각 명령의 원래 nonce/eventId/시각·SHA/길이·head를 첫 쓰기 전에 고정한다. unknown 뒤 late capture가 가능하고, capture가 먼저 확정되면 뒤늦은 unknown은 추가하지 않는다. 명령을 발행한 뒤 실패하면 현재 시각이나 새 ID로 교체하지 않는다.

recover는 strict runId/dispatchCommandDigest만 받는다. 원문·새 nonce·회사·가격·driver를 입력하지 않는다. 비공개 lease capability를 확인해 기존 reconcileVersionedWitness의 본문을 그대로 사용한다. 공개 reconcile wrapper를 활성 lease에서 중첩 호출하지 않는다.

| 원래 기록 상태 | 보관 복구 |
|---|---|
| 정확한 원래 행/명령과 증인 ack 있음 | 원래 명령의 replay를 확인하고 새 SQL 행 없이 보관 확정 |
| 정확한 원래 행/명령 있음, ack만 미확정 | 기존 전체 감사 뒤 ack 파일만 복구 |
| intent만 있음, 부분 사본/행, 원문 충돌/DB 되돌림 | recovery-required, 재삽입·새 nonce·새 전송 없음 |
| 시작 후 SQL/회사 읽기 정리 실패 | 같은 owner가 원래 읽기 거래 정리를 확인한 뒤 보관/복구 |
| capture 확정, promise 미종료 | capture와 lease 유지 |
| capture 확정, promise 종료, SQL/lease 정리 완료 | 실행 수명 closed, 메모리 capture 해제 |
| 응답 없음/캡처 불가/lease 정리 불명 | 원래 책임·hold 유지, 시간/PID/retire로 자동 해제하지 않음 |

실행 수명 closed는 비교 의견·사용량 정산·원고 채택 완료가 아니다. usage unknown이면 DB run/금액 hold와 저장 예약은 남는다. 후속 result3행/close8행은 기존 SQL13 writer와 고정 정책으로 처리한다. missing usage를0으로 바꾸지 않고, 검증한 명시0과 판정 가능한 초과 비용의 기존 fold를 유지한다.

## 관측과 운영 한계

반환 source는 synthetic-comparison-execution이며 공개 owner:null·runtimeObserved:false·기존 authority 전부 false다. dispatchCommitObserved/witnessMatched/startAttempted/capturePersisted/promiseSettled/cleanupRequired는 서로 다른 관측이다. 최초 capture가 도착해도 기존 정리 실패가 있으면 recovery-required를 유지한다. rawBody/capture/header/key/SDK 오류원문·cause는 공개 view에 포함하지 않는다.

요청v1/native4/schema3/manifest1·예약binding3·전송binding1/2/3/4·coverage target10·증인1/2/3과 원래 bytes를 유지한다. 같은 두 경로,128기록/4MiB와 미완료 run의 최악 기록 예약은 기존 검사다. SQL·파일·network 전체 원자성이나 프로세스 종료 뒤 RAM capture 보존을 주장하지 않는다.

이번은 합성 fixture의 SQLite/파일과 지연 가능한 합성 driver 검증이다. 실제 SDK/외부 전송/고객자료/유료 AI·HTTP/브라우저 실행은0이다. 실제 고객·운영 DB/키/완료 control/lock·원래 nonce/비용/수동 judgement를 변경하지 않는다. 백업27개 DESTINATION_REPOSITORY와 일반 v10~v13 backup/restore 미지원은 별도 미해결이며 반복/우회하지 않는다. 보호 편집기3개/미추적4개, 새 채팅/하위 에이전트0·모델/effort 확인/변경0을 유지한다.

F12 자동목록/전체 원문·실제 KOSIS, F13 실제 가격/사람 동의/전송·AI 의미 품질, F18~F20 실제 상세/최종제출·접수증/영속 결과는 미완료다.


## 이번 검증

신규 시험은 같은 lease의 첫 dispatch/시작과 원래 nonce 조회, 두 DB 잠금 안 동기 시작·잠금 밖 응답 대기, 한 번 시작·driver 종료/retire 이후 시작 거절을 검사한다. 회사 삭제/revision/동일 revision 본문, 기한·역행/단조시계, wire body/옵션/header/abort, 복원 표식·lease 거절과 지연 중 공급 정책/요청/native·금액 행 변조를 포함한다. 후자의 원장 변조는 격리 raw reader 반환값 주입이며 실제 고객 DB 수정이나 정당한 새로운 승인 상태를 만들었다는 뜻이 아니다.

unknown 뒤 late capture·최초 원문 불변, 회사 삭제·기한 이후 첫 capture, refusal/불완전/usage 누락, 비정상 getter 응답·거절/응답 없음, dispatch/capture COMMIT 반환·ack·INSERT·SQL 읽기 종료/lease 종료 실패, 원래 명령/bytes의 ack만 복구를 검사한다. 캡처 확정과 원래 promise 종료가 함께 확인되어야 메모리/lease가 닫히며 DB usage unknown hold는 남는다. 오류원문·key/capture가 공개 view로 노출되지 않음을 확인한다.

새 passive boundary 시험10개는 원래 command/context/identity로 재구성한 rawBody, requestedTier:null과 생략 옵션·복사본, 변조/extra/getter/toJSON/순환/용량과 위조/spread/JSON driver token 거절을 검사한다. SDK constructor/global fetch와 현재 키 구성 접근을 금지한 합성 fixture다. 실제 제공자 옵션 지원·가격 진위·사람 동의·AI 품질 검증이 아니다.

초기 두 시험은 fixture 의존성 import 순서가 바뀌어 기존 synthetic policy 설정이 늦게 적용되면서 전체 실행 전 준비에 실패했다. 기존 import 순서를 보존한 뒤 checkpoint에 필요한 state를 누락한 새 composition 오류가 드러났다. 기존 inspector의 inspection.state를 그대로 전달하도록 고쳤으며 준비 실패를 무한히 기다리지 않도록 ready 대기를 실행 결과와 함께 대조했다. 동일 핵심2/2개가132.68초에 통과했다. 이2개는 이후 신규 묶음에 포함되므로 중복 합산하지 않는다.

확장36개는35통과/1실패,1389.38초였다. read-rollback 주입 뒤 최초 응답이 도착하면 원문과 lease는 남지만 phase가 capture-retained로 바뀌는 오류였다. 기존 cleanupRequired/pending이 있으면 recovery-required를 유지하도록 제품 상태 표현을 보완했다. 후속 영향 재검증에서 이 경로가 통과했다. 기대하는 실패 의미·원문·금액·권한 검사를 완화하지 않았다.

후속 검토에서는 새 dispatch COMMIT 관측 뒤 회사 종료 실패, driver 완료/동기 시작 throw·시작 뒤 throw, 미사용 dispatch 이전 입력/회사/driver 거절을 추가했다. 과거 공개 API의 영향을 받는 COMMIT/ack 복구·binding3/4·사용량 경계 회귀14개와 함께 실행했다. 지연 guard의 내부 단언이 합성 driver의 예외 처리에 가려지지 않도록 외부에서 driver 검증 완료도 확인하며 해당 조건만 추가 재검증한다.

이번 기존14개는 SQL13의 binding4 전체 저장/정산 여정, 기존 binding3 결과/정책 close 차단, usage missing/zero/excess, result/close COMMIT·ack 유실4개와 close ack+rollback 이중 실패, SQL12의 dispatch/unknown/capture COMMIT 유실3개·capture ack 유실1개다. 알려진 백업/HTTP 왕복은 포함하지 않았다. 과거4I20 전체320/320·IWhJXA와4I19 370/370·BmapP2는 이번 결과에 다시 더하지 않는다. 각각 시험의 마지막 결과만 고유 수로 집계하고 예비/선택/영향 반복은 합산하지 않는다.

후속 선택 실행은 신규7+영향6+기존14의27/27개(89skip),1617.88초·종료코드0이었다. 지연 guard 단언 보강과 추가 조건은17/17개(67skip),837.58초·종료코드0이며 신규7+영향10개다. 각 시험의 마지막 결과를 기준으로 신규50/50+이번 기존14/14=64/64개다. 초기 핵심2개·확장36개·영향16개를 중복 합산하지 않는다. 이번 최종 제품/시험 실패0이다.

관련 회귀의 최종 종료코드0 뒤 전체 lint를 실행했다. 신규 시험 한 곳의 1회 할당 let에 prefer-const 오류1개가 있어 const 선언으로만 정정했고 동작/단언/제품 소스는 바꾸지 않았다. 최종 전체 lint 종료코드0, 첫 typecheck9.76초 종료코드0을 확인한 뒤 격리 build:local을 순차 완료했다. TypeScript 진단0이며 이 표현 정정으로 이미 통과한 시험을 불필요하게 반복하지 않았다.

Webpack **1mafLl**, BUILD_ID **O4c1-HMXWlWdPrOSUFw6d**, 컴파일28.7초/타입29.5초/정적9개819ms·종료코드0이다. 변경 앱4파일 SHA가 빌드 사본과 일치하고 빌드 루트 .env 파일0개·보호7개 SHA 불변이다. 보호 편집기3개가 포함된 작업 폴더 빌드이며 그 변경의 완료는 합산하지 않는다. 빌드 뒤 앱 소스/시험 변경0·새 HTTP/브라우저/시각 검증0이다.

## 다음4I23 계약 점검 완료 조건

1. 이번 격리 composition과 기존 production-runtime/sdk-owned/transport-boundary의 실제 호출·폐기·재시작 경계를 읽어 같은 lease/owner를 유지할 정확한 연결 지점을 지정한다. 공개 writer 반환이나 supplied 기록으로 owner를 발급하지 않는다.
2. 설치된 SDK의 package/로컬 코드에서 요청 작성·fetch 진입·retry/timeout·응답 반환 순서를 읽기만 하고, 비교 요청v1의 네 생략 옵션·requestedTier:null·POST/store:false/정확한 rawBody를 보존하는 목적별 adapter 입력과 검사를 명세한다. 확인하지 못한 지원은 미확인으로 남긴다.
3. 늦게 호출되는 실제 transport 시작 경계의 quality→studio 마지막 guard, 동기 시작·rejection handler·잠금 밖 await와 즉시 canonical capture를 같은 내부 owner 수명에 연결하는 계약을 작성한다. 실제 network는 호출하지 않는다.
4. 운영 사용에 필요한 원래 회사/선택·사람 동의·가격/사용량 정책/보관 근거·설정의 명시 확인을 각각 구분한다. 공급된 문자열/해시·합성 fixture·SQL COMMIT을 실제 인증으로 승격하지 않는다. 기존 승인을 소비한 운영 control/예산을 재사용·초기화하지 않는다.
5. 새 COMMIT/ack와 replay/불명 COMMIT·ack만 복구·unknown/late capture·캡처/SQL/lease 정리 실패의 입력·출력·실패표와 다음 격리 합성 구현의 완료 조건을 한 계약으로 확정한다. 새 원장/SQL14·기존 helper 복제·일반 callback 실행 권한을 만들지 않는다.
6. 소스 변경·신규 제품 시험/회귀/lint/typecheck/빌드0인 계약 점검으로 보고한다. 실제 SDK import/생성/실행·fetch/키/공식 가격 설정·고객/운영 DB·route/UI/production 설치는 별도 미완료다. 필수 외부 결정이 없어도 독립 계약 점검은 진행하며, 실제 활성화는 이번 범위가 아니다.

다음4I23은 이번 격리 owner/guard/캡처 수명을 기존 production-runtime/sdk-owned/transport-boundary와 설치된 SDK의 읽기 가능한 소스에 대조하여 비교 목적 SDK adapter·운영 연결 계약을 확정한다. 합성 driver와 공개 dummy wire가 실제 전송 승인이 아님을 유지하고, requestedTier:null·요청v1의 생략 옵션/정확한 wire·무재시도/동기 첫 capture를 같은 private 수명에 연결할 입력·출력·실패표를 정한다. 기존 generation/review 타입으로 cast하지 않고 SQL13/증인3·원래 nonce/bytes·private writer/decoder/산술을 재사용한다. 실제 사람 동의·공식 가격/정책·키/환경·운영 활성화는 공급된 문자열/COMMIT과 구분하며 필요한 명시 검토 절차를 계약으로 남긴다. 이번 후속은 소스 변경 없는 로컬 읽기 점검이다. 실제 SDK import/생성/실행·fetch/외부 전송·키/공식 가격 설정·고객/운영 DB·완료 control/lock·route/UI/production 설치는 열지 않는다. 완료 시험/빌드와 백업27개 제한을 반복/우회하지 않는다. 필수 결정0개·다음1~3시간 잠정·전체 완료시간 미정·자동후속 ACTIVE.
