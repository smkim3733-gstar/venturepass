# 다른 PC 개발 인계

2026-10-03 4E2/4E3: 사용자가 최종 기준을 현재 PC의 내부 업무용 로컬 앱으로 확정했다. 실제 UI/API/SQLite9개 흐름, 한글 경로 백업 결함 수정과 관련74개, 복원 앱의 전체 회사/원고3개/원본/Markdown 대조를 완료했다. 최종 lint/typecheck/격리 Webpack anzETR 통과(BUILD_ID kupICGYV7EKcKSo5cN5Xj, 앱4파일 SHA 일치/.env.local 미복사). 현재 확정 범위의 독립 개발 잔여0, 사람 내용 확인/초안 인수는 미완료다. 시작·복구 안내와 마감 보고서는 기획/로컬앱_시작과복구_20261003.md 및 기획/로컬앱_최종마감_20261003.md. 추가 실제 호출/고정 운영 DB·키·고객 자료·기존 서버 수정0. 자동 후속 PAUSED. 아래 기록은 과거 인계다.

---

2026-10-03 4E1: 한국어 표현 점검에서6종 편집 위치로 이동하고 기존 과제·질문·항목 제목을 직접 수정하도록 연결했다. 관련30개·격리 실제 편집기 브라우저10개·lint·typecheck·Webpack HUfQkj 통과(BUILD_ID LzvkNrk_NAF6qeZVge90R, 앱8파일 SHA일치/.env.local미복사). 별도 한국어 검토본은 기획/산출물/내부검토_합성후보_v2_20261003.md. 과거 원고/운영 원장/실제 호출/예산/키/서버는 변경하지 않는다. 원래 두 완료 run은 재실행하지 않는다. 사람 인수는 별개이며 자동 후속 PAUSED 유지.

---

기준일: 2026-09-27. 저장소는 `smkim3733-gstar/venturepass`, 앱은 **`web/`**이다. 이 문서는 소스 설치와 개발 재개 안내다. GitHub 복제만으로 회사 자료·계정·브라우저 세션이 이전되지는 않는다.

## 1. 소스와 실행 도구 준비

Node.js **24.x**, pnpm **11.19.0**, Git을 준비한다. 기존 PC의 상위 폴더 실행기와 `.venturepass-tools`는 이 저장소의 필수 구성물이 아니므로 새 PC에서 해당 절대 경로를 재사용하지 않는다. Windows의 Edge·DPAPI·한국어 OCR 기능은 새 PC의 설치·권한 상태를 별도로 확인한다.

처음 복제할 때:

```powershell
git clone https://github.com/smkim3733-gstar/venturepass.git
cd venturepass
git switch main
git pull --ff-only origin main
cd web
node --version
pnpm --version
pnpm install --frozen-lockfile
```

기존 복제본을 갱신할 때는 먼저 `git status --short`와 현재 브랜치를 확인한다. 작업 중 변경은 검토 후 로컬 커밋·stash 또는 별도 사본으로 보존한다. 비밀이나 사용자 자료를 커밋하면 안 된다. 그다음 저장소 루트에서 `git switch main`, `git pull --ff-only origin main`을 실행한다. 분기되었거나 충돌하면 원인을 확인하며 `reset --hard`, 강제 checkout, 강제 push로 덮어쓰지 않는다. lockfile 불일치는 frozen 설치를 풀어 우회하지 않는다.

## 2. 이 PC의 환경설정

`web`에서 기존 설정을 덮어쓰지 않고 예시 파일을 복사한다.

```powershell
if (-not (Test-Path -LiteralPath '.env.local')) {
  Copy-Item -LiteralPath '.env.example' -Destination '.env.local'
}
```

- `.env.local`은 PC별 파일이다. API 키는 채팅·Git·문서·`NEXT_PUBLIC_` 변수에 넣지 않는다. 키 없이 로컬 자료 관리와 합성 검증을 시작할 수 있다.
- `VENTURE_DATA_DIR`는 Git·OneDrive·공유 동기화 폴더 밖의 **절대 로컬 경로**로 정한다. 예를 들어 해당 PC의 `%LOCALAPPDATA%\VenturePass\data`를 실제 절대 경로로 풀어 입력한다. dotenv에서 `%LOCALAPPDATA%`가 자동 확장된다고 가정하지 않는다.
- 미설정 기본 위치는 `web/.venture-pass`다. 기존 PC가 별도 경로를 사용했다면 그 데이터는 Git 복제본에 없다.
- 기존 일반 AI 설정의 모델과 품질평가 도구의 서버 고정 운영 **제안**은 별개다. `.env.example`에 모델명이 있거나 키를 설정했다고 품질평가 운영 모델·예산·전송 승인이 채택되는 것은 아니다.
- 이전 자료를 가져올 예정이면 **앱을 처음 실행하기 전에** 아래 복원을 마친다. 빈 DB를 먼저 만들면 품질 복원의 기존 목적지 거절이 발생할 수 있다.

## 3. 자료가 필요할 때만 별도 비공개 이전

Git에 포함되는 것은 앱 소스, 기획·검증 기록, 공개 명단/통계 JSON, 합성 시험 자료다. 사용자 기업 DB·업로드 원본·저장 계정·품질평가 로컬 DB·실제 환경파일·브라우저 프로필은 Git으로 이전하지 않는다. 원본 PDF/Excel과 사용자 작업 산출물도 별도 보관한다. 앱 실행을 위해 `pnpm data:import`를 실행할 필요는 없다.

실제 자료가 필요한 경우 기존 PC의 최신 앱 코드에서 회사 백업과 품질 백업을 **각각** 만든다. 품질 DB가 없는 PC라면 품질 명령은 생략한다. 백업은 민감한 내용을 포함할 수 있고 자체 암호화되지 않으므로 접근권한을 관리한 비공개 저장매체·전송 방식으로 옮긴다. GitHub, 공개 링크, 이슈, 채팅 첨부로 이전하지 않는다.

기존 PC의 `web`에서:

```powershell
$sourceData = Read-Host '기존 VENTURE_DATA_DIR 절대 경로'
$companyBackup = Read-Host '새 회사 백업 폴더 절대 경로'
pnpm data:local backup --source "$sourceData" --destination "$companyBackup"
pnpm data:local verify --source "$companyBackup"

$qualityBackup = Read-Host '새 품질 백업 폴더 절대 경로'
pnpm data:local quality-backup --source "$sourceData" --destination "$qualityBackup"
pnpm data:local quality-verify --source "$qualityBackup"
```

각 명령이 성공한 뒤 다음으로 진행한다. 목적지 부모는 존재해야 하고 새 백업 폴더 자체는 없어야 한다. Git·OneDrive 아래, 원본과 겹치는 경로, 링크·알 수 없는 구조는 거절한다. WAL/SHM 불일치나 접수 복구 오류를 보조파일·DB 삭제로 해결하지 않는다. 작업 중 자료가 변하면 완료하지 않으므로 앱 편집을 멈추고 상태를 확인한 뒤 새 백업을 만든다. 자세한 조건은 [README의 로컬 백업 안내](README.md#검증-가능한-로컬-백업과-새-경로-복원)를 따른다.

새 PC의 `web`에서, 옮긴 백업을 검증한 후:

```powershell
$companyBackup = Read-Host '옮긴 회사 백업 폴더 절대 경로'
$qualityBackup = Read-Host '옮긴 품질 백업 폴더 절대 경로'
$restoredData = Read-Host '아직 없는 새 데이터 루트 절대 경로'
pnpm data:local verify --source "$companyBackup"
pnpm data:local quality-verify --source "$qualityBackup"
pnpm data:local restore --source "$companyBackup" --destination "$restoredData"
pnpm data:local verify --source "$restoredData"
pnpm data:local quality-restore --source "$qualityBackup" --destination "$restoredData"
```

회사 `restore`는 새 데이터 루트를 만든다. **회사 검증까지 성공한 뒤** 품질을 복원한다. `quality-restore`는 이미 있는 데이터 루트 안에 새 `quality-evaluation`을 만들며 기존 품질 DB를 덮어쓰지 않는다. 회사 자료 없이 품질만 복원한다면 안전한 새 데이터 루트 폴더를 먼저 만든다. `quality-verify`의 대상은 manifest가 있는 품질 **백업 폴더**다. 복원된 live 품질 폴더에 그대로 실행하는 명령이 아니며, `quality-restore` 자체가 복원 바이트와 논리 구조를 검사한다.

검증·복원 완료 후 `.env.local`의 `VENTURE_DATA_DIR`를 새 데이터 루트로 지정한다. 기존 경로와 백업은 보존한다. 앱에서 회사·자료·원고·준비본·품질 이력을 확인하며, 문제가 있으면 설정을 원래 경로로 되돌릴 수 있다. 새 경로에서 편집한 뒤에는 과거 백업 manifest와 바이트가 달라질 수 있다.

회사 백업의 64MiB DB 한도에는 보관 준비본 ZIP도 포함된다. 품질 백업은 현재 v9의 18테이블과 v1~v8 지원 형식을 검사한다. 정책·예약·전송 승인 결합과 각각의 이전 coverage, 원시 바이트·해시·공유 용량을 함께 감사한다. 구버전 백업은 원래 버전으로 복원하고 앱을 열 때 단일 트랜잭션에서 전체 검사 후 이전한다. 현재 버전의 coverage/필수 결합 누락을 재생성하거나 구버전 writer로 쓰지 않는다. 한도·구조 오류를 우회하거나 기록을 자동 삭제하지 않는다. JSON 내려받기는 개별 기록 조회용이며 전체 DB 복원을 대신하지 않는다.

## 4. 실행과 새 PC에서의 재연결

```powershell
pnpm dev
```

[로컬 스튜디오](http://127.0.0.1:3000/studio)에 접속한다. 기본 서버는 loopback 전용이다. 복원한 DB를 두 PC나 여러 서버가 동시에 공유해 쓰지 않는다.

벤처인 계정 암호문은 Windows DPAPI에 묶여 다른 PC/Windows 사용자에서 복호화되지 않을 수 있다. 새 PC의 앱에서 계정을 다시 등록하고 별도 Edge 로그인·필요한 권한/추가 인증을 진행한다. 기존 화면·단회 승인·실행 잠금·살아 있는 브라우저 세션은 이전되지 않는다. 회사·현재 계정·공식 화면을 다시 연결하고 정확한 입력/첨부 범위를 새로 검토한다. 과거 실행 기록이 있다는 이유로 재전송하지 않는다.

`/application`의 브라우저 localStorage도 서버 DB와 다르다. Git이나 서버 DB 백업만으로 기존 브라우저 체크리스트가 복원되었다고 가정하지 않는다. Codex의 작업 대화·자동 재개 예약·이전 임시 빌드 경로도 Git 설정이 아니므로 새 PC의 프로젝트와 실행 환경을 다시 연결한다.

## 5. 개발 검증

모든 명령은 `web`에서 실행한다.

```powershell
pnpm lint
pnpm typecheck
pnpm test --maxWorkers=1
pnpm test:local-data
pnpm build
```

전체 시험과 빌드를 동시에 돌리면 Windows 파일 I/O 시험의 시간 초과가 생길 수 있으므로 순차 실행한다. 실패 시 단언을 약화하거나 데이터 보호 검사를 끄지 않는다. 환경 조건으로 건너뛴 OCR/DPAPI 시험은 통과와 구분한다. `test:local-data`는 별도 Node CLI 회귀다. 실제 고객 자료나 외부 AI를 검증 입력으로 사용하지 않는다.

OneDrive의 `.next` 잠금 등으로 일반 빌드를 진행할 수 없다면 `pnpm build:local`을 사용한다. 이는 필요한 소스를 고유 임시 폴더에 복사하여 빌드하고 기존 서버를 보존한다. 환경파일·사용자 데이터는 복사하지 않는다. 출력된 임시 산출물은 원본 폴더의 `pnpm start` 대상과 다르다.

최신 변경 묶음의 인계 기준은 **관련 21파일 607개 시험, lint, 타입 검사, 격리 빌드와 합성 브라우저 검증 통과**다. 빌드 `xq1GuB`의 소스 521파일 SHA 대조까지 완료했다. 이는 최신 변경 범위의 검증이며, 현재 앱의 모든 시험을 같은 실행에서 다시 돌렸다는 뜻은 아니다. 새 PC의 재현 결과와 별개이며 세부 기록은 [VALIDATION.md](VALIDATION.md)를 따른다.

## 6. 이어서 읽을 문서와 다음 작업

다음 세 문서를 먼저 읽는다. 날짜가 오래된 대기 기록보다 각 문서의 최신 상태와 실제 소스를 우선한다.

1. [연속개발 작업대장](../기획/연속개발_작업대장.md): 마지막 완료·검증·차단 원인·다음 순서.
2. [3단계 기획 반영 개발 현황](../기획/3단계_기획반영_개발현황.md): 단순한 사용자 흐름과 현재 구현 범위.
3. [구현 검증 기록](VALIDATION.md): 시험 범위·실패 보정·빌드·합성 UI 검증의 실제 한계.

바로 다음 개발은 [운영 승인·실행 연결 후속 설계](../기획/품질평가_운영승인_실행연결_후속설계.md)를 따른다. 현재 운영 모델·공식 근거의 읽기 전용 제안을 표시하며, USD 11.22 금융 예약 계산과 USD 15 누적 예산은 **제안**이다. 운영 채택·예산 설정·계정 확인·실제 전송 승인은 완료되지 않았다. 근거에는 내부 재확인 기한이 있으므로 오래된 제안을 새 운영 승인에 재사용하지 않는다.

남은 핵심은 다음과 같다.

- 운영 정책 채택·누적 예산, 정확한 후보 1건 예약, 별도 전송 승인을 분리하여 서버 고정 실제 adapter에 연결. 현재 production 쓰기·실제 유료 실행은 닫혀 있다.
- 실제 AI 출력의 의미 품질, 사람 정답표·독립 평가. 합성/모의 실행과 구조 검증을 품질 합격으로 표시하지 않는다.
- 실제 공식 사이트의 입력·첨부·저장·이동·접수·결과 관측. 미관측 동작을 추측하지 않고 정확한 승인 범위를 확인한다. 가상 자료를 기관에 제출하지 않는다.
- 외부 고객용 사용자 인증·기업별 권한·비밀 관리·운영 저장소·보관/복구·비용 정책. 로컬 앱 실행을 공개 서비스 운영 준비 완료로 취급하지 않는다.

새 개발자는 먼저 작업 트리·위 문서·관련 코드를 확인한 뒤 독립 구현과 합성 검증을 이어간다. 미확인 사실·실제 자료 검토·사용자 승인을 자동 완료 처리하지 않는다. Git 갱신/푸시와 로컬 데이터 이전, 공개 배포, 실제 AI/기관 실행은 서로 다른 작업이다.
