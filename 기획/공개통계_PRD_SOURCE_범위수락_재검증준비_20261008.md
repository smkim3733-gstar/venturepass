# PRD 범위·SOURCE 제한 재검증 준비 — 2026-10-08

2026-10-08 — **4H27 PRD 범위/SOURCE 제한 재검증기 합성 준비 완료**

완료 15/20=75%·미완료 5/20=25%·직전 대비 +0%p. 이번 4H27 제품 변경 0·신규/기존 제품시험 0/0(미실행)·lint/typecheck/새 빌드 0이다. 별도 임시 검증기는 신규 30+기존 2=32/32개, 기존 프로덕션 공개 route의 합성 흐름 4/4개(POST 10·합성 제공자 16)가 통과했다. 실제 외부 GET·키 취득/입력서버·SQL·SDK client/API·고객/운영 DB·유료 AI 0이다. 과거 4H26 제품 63/63·앱 9/9·38q4Zt 및 4H25 실제 3 GET는 재실행/합산하지 않는다. 보호 7·보존 152·소진 기록 26+28+19+15 SHA 불변, 새 검증기 9개 SHA 고정·공개 route 전이 14개 빌드 SHA 일치·env 0이다. 실환경 직접 1/5=20%·벤처인 앱 자동실행 0단계·KOSIS 수치 0/1·검색 누적 수락 10/12·표 설명 1/4(TBL)이다. 백업 27개 제한은 미해결·미실행이다. 준비 완료로 필수 결정 1개·승인 후 검증/기록 1~3시간(잠정)·전체 완료시간 미정·자동후속 PAUSED.

새 격리 사본 `.venturepass-tools/build-temp/venturepass-prd-source-range-zvw2lsuj`를 빌드 38q4Zt/BUILD_ID HmVRT_7zBhR5zFMob8Wdk에 고정했다. PRD 개별시점/범위/빈 배열을 구분하고 이번 기본 범위 검증은 범위 또는 정상 빈 배열만 수락한다. strict envelope·원래 명령·false 7개·후보 전체 재검색을 유지하며 혼합/중복/잘못된 SOURCE에서 즉시 중단한다. 임의 값·원문·errMsg·키·전체 API 주소는 기록하지 않는다. 제품의 기존 개별시점 지원은 변경하지 않았다.

승인 대기 실행안은 온라인쇼핑 첫 10개 후보 중 101/DT_1KE10041에 초기 검색 1회, PRD 재검색/읽기 2회, SOURCE 재검색/읽기 2회로 외부 GET 최대 5회다. 제품 loopback POST 최대 3회·일회성 키 전달 POST 최대 1회를 구분한다. 실패/후보 변경/지원 형식 불일치 때 즉시 종료하며 TBL/CMMT/수치/detail=Y/재시도 0이다. 본인 키는 승인 후 전용 child 메모리에서만 사용하고 .env/키파일/쿠키 복사·고객 자료 저장 0을 유지한다.

이번 local 준비는 실제 조회 승인이 아니다. 새 live 디렉터리·키 입력서버는 없고 실제 호출은 0회다. 과거 승인/미사용 호출을 이월하거나 소진 live를 재시작하지 않는다. 남은 결정은 이 최대 5회 단일 실행 허용 여부 한 가지다. 이미 승인된 합성 앱 개발의 재승인은 묻지 않는다. 같은 검사/문서 준비를 반복할 독립 작업은 남기지 않고 승인까지 PAUSED다.

상세: 기획/공개통계_PRD_SOURCE_범위수락_재검증준비_20261008.md

## 준비 범위와 근거

4H25에서 PRD_SE/STRT_PRD_DE/END_PRD_DE 문자열 3행이 관측됐지만 당시 앱은 PRD_DE 필수 계약으로 거절했다. 실제 값은 보관하지 않았다. 4H26은 두 PRD 형식을 구분해 합성 제품/화면 지원을 완료했다. 이번은 그 새 빌드의 제품 수락을 정확히 판정할 별도 실행기 준비다. 과거 응답을 복원하거나 실제 제품 수락을 완료했다고 주장하지 않는다.

기존 4H22 실행기 7개 소스만 새 지정 루트 하위 사본으로 가져왔다. 원래 검증기/live/합성 기록은 그대로 보존했다. 새 사본의 diagnose/preload/runner를 수정하고 accepted/range.test 2개를 추가했다. guard/workflow/provider-error/scope.test는 그대로다. 합계 임시 소스/시험 9개이며 제품 변경은 0개다. 임시 파일/로그/빌드는 Git에 넣지 않고 결과·인계 문서 5개만 커밋한다.

## 새 검증기의 판정

diagnose는 PRD를 point/range/empty/unsupported로 구분한다. 고정 4필드의 존재·자료형·길이/빈 값 합계와 고정 분류만 기록한다. 미지원 필드의 이름이나 값은 기록하지 않는다. 원래 JSON의 중복 속성·배열 형식 혼합·한 행의 두 형식 혼합·누락/추가/잘못된 자료형·동일 행을 거절한다. 정상 빈 배열은 오류 객체와 구분한다.

accepted는 명령 전체 일치, 정확한 envelope/metadata 키, source/identityBasis, 조회시각 형식, status와 행 수 일치 및 7개 false 제한을 다시 대조한다. 이번 PRD 기본 요청의 양성 판정은 range 또는 정상 empty뿐이다. 제품이 개별시점 응답을 수락하더라도 이번 실행 목적과 다르면 UNEXPECTED_PRD_SHAPE로 종료한다. 제품의 기존 point 지원을 바꾸지는 않는다. SOURCE는 기존 strict 행 형식을 유지한다.

고정 오류 분류 외 자유 문구를 출력하지 않는다. 제공자의 errMsg/본문/임의 속성·기간/출처 값·키/전체 API 주소·헤더/HAR/자유 예외 문자열은 기록하지 않는다. 기존 공개 오류 코드 허용목록만 재사용하며 오류를 빈 성공으로 바꾸지 않는다.

## 첫 시험 전 점검

새 임시 9파일은 자기 상대 모듈과 Node 내장 모듈만 사용하며 동적 import/구문 진단 0이다. 공개 route 로컬 전이 14파일과 외부 server-only/zod를 정적으로 대조했다. SDK/SQL/운영 모듈을 실행해서 확인하지 않았다.

기존 build 38q4Zt와 현재 route 전이 14개 SHA 일치, BUILD_ID HmVRT_7zBhR5zFMob8Wdk 및 빌드 루트 env 0을 확인했다. 새 빌드를 만들지 않았다. 사전 기록은 새 폴더의 import-audit.json/preflight.json이다.

## 이번 합성 검증 결과

임시 신규 30개는 범위/개별/빈 배열 구분·원래 문자열 보존·혼합/중복/자료형/한도 거절·응답 명령/envelope/false 제한·SOURCE 거절 뒤 중단·오류 객체와 빈 배열 구분이다. 영향 기존 2개는 정확한 5회 순서/6회째 차단 및 각 local 실패 뒤 중단이다. 정확한 두 시험 파일과 이름 필터, test-concurrency=1로 32/32개를 확인했다. 나머지 기존 임시 시험과 제품 시험은 반복하지 않았다.

| 새 합성 모드 | 제품 POST | 합성 제공자 | 관측 및 판정 |
| --- | ---: | ---: | --- |
| synthetic-success | 3 | 5 | PRD 범위 2행과 SOURCE 1행 route 200, bounded-read-complete |
| synthetic-prd-mixed | 2 | 3 | PRD 혼합 형식 route 502, SOURCE 없이 종료 |
| synthetic-prd-duplicate | 2 | 3 | PRD 원래 JSON 중복 속성 route 502, SOURCE 없이 종료 |
| synthetic-source-schema | 3 | 5 | PRD 범위 수락 뒤 SOURCE 행 규격 route 502로 종료 |
| 합계 | 10 | 16 | 고유 4/4 흐름 |

성공 흐름은 2026-10-08 03:41:02.998~03:41:04.385 KST에 관측했다. 세 거절 흐름의 도구 종료코드 1/LOCAL_HTTP_FAILED는 기대한 앱 502 중단이다. 외부 재시도나 SOURCE 후속 단계는 없다. 첫 실행 묶음의 셸 래퍼가 거절 종료코드를 다르게 예상해 첫 거절 뒤 멈췄고, 남은 미실행 두 모드만 따로 실행했다. 기존 모드를 재실행하지 않았으며 준비 래퍼 중단을 고유 시험 실패/추가 시험으로 세지 않는다.

네 흐름 모두 원래 I/O active 0·모두 settled, 차단 0·금지파일 0·자기 child 종료 및 unused-data 부재를 확인했다. 각 모드 폴더에는 execution-started/wire/diagnostic/summary 4개 기록만 있다. 합성 기록 16개에 키/원문 값/임의 필드명이 유출되지 않음을 대조했다. 브라우저/UI 시험은 실행하지 않았으며 route 검증과 구분한다.

## 보존과 현재 상태

preservation.json은 작업 전 기준이며 preservation-after.json은 새 9파일과 합성 기록 16개의 SHA를 추가했다. verification.json은 최종 검사다. 보호 7·보존 152·직전 PRD 진단 기록 26·이전 period-source 기록 28·cmmt-error 기록 19·metadata 기록 15가 불변이다. 새 9파일도 첫 시험 전 SHA와 같다. 제품 152개 기준은 기존 venturepass-prd-range-hm9yivvk/preservation-after.json을 이어 쓴다.

모든 과거 소진 live, execution-started 및 합성 기록을 보존한다. 특히 prd-shape-30zvficy/live의 최대 3회 승인은 소진됐고 이전 미사용 호출도 이월하지 않는다. SQL13 고정 사본/원래 ID/hash/nonce/본문/hold를 변경하지 않았으며 이번 별도 새 SQL13 SHA 관측으로 세지 않는다. 백업 27개 DESTINATION_REPOSITORY 제한은 미해결·미실행이다.

새 live 디렉터리, 키 취득, 키 입력서버 및 실제 API 호출은 아직 없다. 고객 서버 변경/종료 0, 고객/운영 DB·유료 AI·SDK client/API·계정/신청/납부/서명/제출 0이다. 새 채팅/하위 에이전트도 만들지 않았다.

## 승인 후 4H28 단일 실행안

| 순서 | 제품 명령 | 외부 요청 | 대조 |
| --- | --- | --- | --- |
| 1 | ecommerce 검색 POST | SEARCH 1 | 온라인쇼핑 첫 10개, 목표 101/DT_1KE10041 정확히 1개·중복 없음 |
| 2 | 원래 후보 PRD POST | SEARCH 1 + PRD 1 | 원래 후보 7필드 전체 재대조, 기본 PRD 범위/empty 수락 |
| 3 | 원래 후보 SOURCE POST | SEARCH 1 + SOURCE 1 | 원래 후보 7필드 전체 재대조, 기존 strict SOURCE 수락 |

외부 GET 최대 5회, 제품 loopback POST 최대 3회, 일회성 키 전달 POST 최대 1회다. 원래 command/candidate를 고정하고 각 metadata 요청 안의 새 검색을 생략하지 않는다. 검색은 jsonVD=Y를 포함한 고정 ecommerce/온라인쇼핑 첫 10개이며 metadata는 format=json/jsonVD=Y/content=json, 대상 기관/표와 PRD 또는 SOURCE만 허용한다. detail=Y, 다른 주제/페이지, TBL/CMMT/수치 및 재시도는 0이다.

사용자가 이 실행안을 명시 승인한 뒤에만 새 runner를 live와 --approved-range-prd-source-five-reads로 1회 시작할 수 있다. 새 live/execution-started.json은 배타 생성하고 삭제/재사용하지 않는다. 승인 없이 flag를 넣어 실행하지 않는다. 승인 이후에도 파일/빌드가 달라졌거나 실행 표시가 있으면 중단하고 상태를 먼저 대조한다.

사용자 발급키는 승인 후 일회성 loopback password form으로 전용 child 메모리에만 전달한다. .env를 읽거나 설정하지 않고 키/쿠키/SSO를 파일·채팅·명령문으로 복사하지 않는다. 키 입력은 1회 소비하며 사용 후 메모리/임시 입력탭을 정리하고 사용자 KOSIS 탭은 보존한다. 로그인 세션이 끝났다면 기존 승인을 유지한 채 로그인만 요청한다.

지정 빌드의 자기 child를 loopback에 실행하고 자기 Ready 로그를 기다린다. 비밀 없는 최소 환경과 실행별 unused-data 경로를 지정하며 DB를 만들지 않는다. token으로 제한한 제품 공개 조회 POST만 허용한다. 다른 제품 API/쓰기와 외부 경로·SDK/운영 import는 차단한다. 고객 앱 서버는 변경하거나 종료하지 않는다. 제품 명령 20초·응답당 512KiB·strict UTF8/JSON·공유 원래 I/O 및 무재시도는 그대로다.

다음이면 후속 요청 없이 즉시 종료한다: 목표 후보 없음/중복/규격 오류, 후보 7필드 변경, 요청 경로/순서/횟수/매개변수 불일치, 제공자 오류/HTTP 실패/시간·크기 상한, UTF8/JSON/행 규격 거절, PRD 중복 속성·형식 혼합, 잘못된 envelope/명령/false 제한/상태, 기본 PRD의 예상 밖 point 응답, 금지 import/API 시도, 원래 I/O 종료 미확인. 남은 호출은 재시도 권한으로 이월하지 않는다.

실행 결과는 고정 분류·HTTP 상태·바이트/행 수·PRD 형식·지원 필드 합계·대상 유무/중복 수·원래 I/O 종료·자기 child 종료만 기록한다. PRD/SOURCE 원문 및 값은 기록하지 않는다. 종료 때 활성 I/O 0/모두 settled, 자기 child 종료, 금지파일/unused-data 부재 및 보존 SHA를 대조한다.

## 성공·미확인 기준과 남은 결정

앱 route 200 + 정확한 envelope + 범위 또는 정상 빈 배열 PRD + strict SOURCE 수락을 각각 기록한다. 오류는 수락으로 세지 않는다. empty는 이번 요청이 정상 빈 배열을 반환했다는 뜻이며 표 전체 주석/기간/출처의 공식 부재를 확정하지 않는다. 기간 전체목록·연속성/최신시점·수치·회사 해당성·사실 확인·F12 전체·AI 품질·사람 인수 완료로 승격하지 않는다.

현재 구체적인 합성 보완과 검증 준비는 끝났다. F12의 이번 남은 작업은 새 실제 PRD/SOURCE 응답 수락 관측이며 위 외부 호출 승인이 필요하다. F13의 실제 SDK/운영 전송·사람동의/가격·AI 품질, F18~20 실제 제출/접수/결과 및 백업 제한은 별도 미완료다. 관측되지 않은 구조를 만들어 독립 개발을 무한 연장하지 않는다.

필수 결정은 하나다: **본인 발급키를 일회성 메모리에서 사용해 101/DT_1KE10041의 검색 3회+PRD 1회+SOURCE 1회, 총 최대 5 GET를 단일 실행으로 검증할지.** 과거 실조회 승인은 종료됐고 사용자가 새 외부 호출을 별도 승인하도록 지시했기 때문에 묻는다. 합성 앱 개발 승인을 다시 묻는 것이 아니다. 승인 전 자동후속은 PAUSED이며 변동 없는 heartbeat는 조용히 종료한다. 승인 후 검증·기록은 1~3시간 잠정, 전체 완료시간은 미정이다.
