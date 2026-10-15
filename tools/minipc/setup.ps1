# 징칡홀덤 미니 PC 설치 — 관리자 PowerShell 에서 한 번 실행한다.
#   irm https://raw.githubusercontent.com/wjdcjf0845-bit/jingchik-holdem/main/tools/minipc/setup.ps1 | iex
# 하는 일: Node.js·Git 설치(없으면) → 저장소 받기(C:\jingchik) → 패키지 설치 → 설정 파일(C:\jingchik-data\server.env) 만들기
#          → Windows 가 켜지면 서버가 저절로 돌게 등록(작업 스케줄러, 죽으면 다시 띄우고 GitHub 새 커밋을 받아 재시작)
#          → 절전 끄기 → (원하면) Tailscale Funnel 로 인터넷 주소 열기
# 다시 실행해도 안전하다(있는 것은 건너뛰고 설정 파일은 덮어쓰지 않는다).
$ErrorActionPreference = 'Stop'
$Repo = 'C:\jingchik'
$Home2 = 'C:\jingchik-data'
$TaskName = 'JingchikHoldem'
$GitUrl = 'https://github.com/wjdcjf0845-bit/jingchik-holdem.git'

function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function RefreshPath { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host '관리자 권한이 필요합니다. 시작 버튼 우클릭 → "터미널(관리자)" 에서 다시 실행하세요.' -ForegroundColor Red; return }

Step '1/6 Node.js · Git'
RefreshPath
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements; RefreshPath }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { winget install -e --id Git.Git --accept-package-agreements --accept-source-agreements; RefreshPath }
$Node = (Get-Command node).Source
Write-Host ("node " + (& node -v) + " · " + (& git --version))

Step '2/6 저장소 받기'
if (-not (Test-Path "$Repo\.git")) { git clone $GitUrl $Repo } else { git -C $Repo pull --ff-only }
# 작업 스케줄러는 SYSTEM 계정으로 돌린다 — 다른 계정이 받은 폴더라고 git 이 거부하지 않게
git config --system --add safe.directory ($Repo -replace '\\', '/')

Step '3/6 패키지 설치'
Push-Location $Repo
npm.cmd ci --omit=dev
Pop-Location

Step '4/6 설정 파일'
New-Item -ItemType Directory -Force $Home2 | Out-Null
$EnvFile = "$Home2\server.env"
if (-not (Test-Path $EnvFile)) {
@'
# 징칡홀덤 미니 PC 설정 — Render 대시보드 → jingchik-holdem → Environment 에 있던 값을 그대로 옮겨 적으세요.
# 이 파일은 저장소 밖(C:\jingchik-data)에 있어 GitHub 에 올라가지 않습니다. 빈 칸은 설정 안 한 것으로 봅니다.
# 고친 뒤에는 작업 스케줄러에서 JingchikHoldem 을 끝냈다 다시 실행하거나 PC 를 다시 켜면 반영됩니다.
PORT=3000
# 전적 DB(Turso) — 이 두 줄을 채우면 Render 에서 쓰던 계정·전적·홀인원 장부를 그대로 이어 씁니다
TURSO_DATABASE_URL=
TURSO_AUTH_TOKEN=
ADMIN_USER=
ADMIN_PASS=
ADMIN_SECRET=
FN_PAYEE=
FN_ACCOUNT=
MAX_PLAYERS=
'@ | Set-Content -Encoding UTF8 $EnvFile
    Write-Host "설정 파일을 만들었습니다: $EnvFile — 메모장이 열리면 Render 의 값을 붙여 넣고 저장한 뒤 닫으세요." -ForegroundColor Yellow
    Start-Process notepad.exe $EnvFile -Wait
} else { Write-Host "있는 설정 파일을 그대로 씁니다: $EnvFile" }

Step '5/6 자동 실행 등록 · 절전 끄기'
$action = New-ScheduledTaskAction -Execute $Node -Argument "`"$Repo\tools\minipc\runner.js`"" -WorkingDirectory $Repo
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $TaskName
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
if (-not (Get-NetFirewallRule -DisplayName 'JingchikHoldem 3000' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'JingchikHoldem 3000' -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private | Out-Null
}
Start-Sleep -Seconds 8
try { $v = (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3000/version -TimeoutSec 10).Content; Write-Host "서버 동작 중 — 커밋 $v · 이 PC 에서 http://localhost:3000" -ForegroundColor Green }
catch { Write-Host "서버 응답이 아직 없습니다. 잠시 뒤 http://localhost:3000 을 열어 보거나 $Home2\runner.log · server.log 를 확인하세요." -ForegroundColor Yellow }

Step '6/6 인터넷 주소 (Tailscale Funnel — 무료 · HTTPS · 주소 고정)'
$ans = Read-Host '친구들이 밖에서 들어올 주소를 지금 열까요? Tailscale 계정 로그인이 필요합니다 (Y/N)'
if ($ans -match '^[Yy]') {
    if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) { winget install -e --id Tailscale.Tailscale --accept-package-agreements --accept-source-agreements; RefreshPath }
    Write-Host '브라우저가 열리면 Tailscale 에 로그인하세요(구글 계정 가능).' -ForegroundColor Yellow
    tailscale up
    Write-Host 'Funnel 을 처음 켜면 허용 링크가 나옵니다 — 그 링크를 열어 허용한 뒤 이 창에서 기다리세요.' -ForegroundColor Yellow
    tailscale funnel --bg 3000
    tailscale funnel status
}
Write-Host "`n끝. 로그: $Home2\runner.log · $Home2\server.log" -ForegroundColor Green
