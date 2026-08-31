# push.ps1 —— 在普通 PowerShell / cmd 里双击运行即可推送
# 用法：
#   1. 右键"以 PowerShell 运行" 或 在终端执行  pwsh push.ps1
#   2. 首次运行会提示安装 gh CLI（已装则跳过）
#   3. 按提示登录 GitHub（浏览器 OAuth 或粘贴 PAT；或直接设置 $env:GH_TOKEN）
#   4. 自动 init + commit + push 到 xjxjxj/dsh-session-cleaner
# 支持 PAT：在脚本外先 $env:GH_TOKEN = "ghp_xxx"，脚本会跳过 gh auth login
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "=== dsh-session-cleaner push script ===" -ForegroundColor Cyan

# 1. 检查 git
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "git not found. Install from https://git-scm.com/" -ForegroundColor Red
    exit 1
}

# 2. 检查 gh，没有就装
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Host "gh CLI not found. Installing via winget..." -ForegroundColor Yellow
    winget install --id GitHub.cli -e --accept-source-agreements --accept-package-agreements
    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if (-not $gh) {
        Write-Host "gh still not found. Manually install: winget install GitHub.cli" -ForegroundColor Red
        exit 1
    }
}

# 3. 登录（如已登录会直接通过）
Write-Host "Checking gh auth..." -ForegroundColor Cyan
$auth = gh auth status 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "Not authenticated. Running 'gh auth login' (follow prompts)..." -ForegroundColor Yellow
    gh auth login
}

# 4. init + commit
Write-Host "Initializing git repo..." -ForegroundColor Cyan
$env:GIT_AUTHOR_NAME = "xjxjxj"
$env:GIT_AUTHOR_EMAIL = "707311587@qq.com"
$env:GIT_COMMITTER_NAME = "xjxjxj"
$env:GIT_COMMITTER_EMAIL = "707311587@qq.com"

if (-not (Test-Path ".git")) {
    git init -b main
}
git add .
$hasChanges = git status --porcelain
if ($hasChanges) {
    git commit -m "feat: dsh-session-cleaner v0.1.0

- Server: 5 HTTP endpoints (/__session-cleaner/*) + 3 agent tools
- Client: floating cleanup button + modal (delete current/selected/all, optional backup)
- Backup: copy ~/.dsh/sessions/ to ~/.dsh/backup-archive/sessions_backup_<ts>/
- 6-step delete: stop agent -> flush -> detach -> rm dirs -> clear projcache -> clear workspace
- MIT license, dsh 0.1.1-rc.2+"
} else {
    Write-Host "No changes to commit." -ForegroundColor DarkGray
}

# 5. push（如远端不存在则创建）
Write-Host "Pushing to xjxjxj/dsh-session-cleaner..." -ForegroundColor Cyan
$remote = git remote get-url origin 2>$null
if (-not $remote) {
    git remote add origin "https://github.com/xjxjxj/dsh-session-cleaner.git"
}

# 先尝试直接 push；若仓库不存在则用 gh repo create 创建
$pushOut = git push -u origin main 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "Direct push failed. Trying to create repo via gh..." -ForegroundColor Yellow
    $existing = gh repo view xjxjxj/dsh-session-cleaner 2>&1
    if ($LASTEXITCODE -ne 0) {
        gh repo create dsh-session-cleaner --public --source . --remote origin
    }
    git push -u origin main
}

Write-Host ""
Write-Host "=== DONE ===" -ForegroundColor Green
Write-Host "Repo URL: https://github.com/xjxjxj/dsh-session-cleaner"
Write-Host "Install command for others:"
Write-Host "  dsh plugin --profile web add github:xjxjxj/dsh-session-cleaner" -ForegroundColor Cyan
Write-Host ""
Read-Host "Press Enter to exit"
