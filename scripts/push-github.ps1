# 推送到 GitHub（首次）
# 用法：
#   .\scripts\push-github.ps1 -Repo "https://github.com/<你的用户名>/black-hole.git"
# 前提：已在 GitHub 网页上创建了【空仓库】（不要勾 README / .gitignore / License）

param(
  [Parameter(Mandatory = $true)]
  [string]$Repo,
  [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "=== 1/4 检查本地提交 ===" -ForegroundColor Cyan
$log = git log --oneline -1 2>$null
if (-not $log) { throw "本地还没有提交，先 commit" }
Write-Host "  $log"

Write-Host "=== 2/4 敏感信息复检 ===" -ForegroundColor Cyan
$bad = @()
foreach ($p in @('.env', 'config.json', 'data/black-hole.db')) {
  git ls-files --error-unmatch $p 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { $bad += $p }
}
$leak = git grep -n -E 'sk-[a-zA-Z0-9]{20,}|im\.bot:[a-f0-9]{20,}' --cached 2>$null
if ($bad.Count -gt 0) { throw "以下敏感文件被跟踪，先 git rm --cached：$($bad -join ', ')" }
if ($leak) { throw "检测到疑似密钥：`n$leak" }
Write-Host "  ✅ 无敏感文件 / 无密钥" -ForegroundColor Green

Write-Host "=== 3/4 设置远程 ===" -ForegroundColor Cyan
git remote remove origin 2>$null
git remote add origin $Repo
Write-Host "  origin → $Repo"

Write-Host "=== 4/4 推送 ===" -ForegroundColor Cyan
Write-Host "  首次推送会弹出浏览器，让你授权 GitHub 账号（授权一次即可，凭证会缓存）" -ForegroundColor Yellow
git push -u origin $Branch

if ($LASTEXITCODE -eq 0) {
  Write-Host "`n✅ 推送完成：$Repo" -ForegroundColor Green
} else {
  Write-Host "`n❌ 推送失败。常见原因：" -ForegroundColor Red
  Write-Host "  1) 仓库还没在网页上创建 → 打开 https://github.com/new 建一个空仓库"
  Write-Host "  2) 仓库名/用户名不对 → 检查 $Repo"
  Write-Host "  3) 授权被取消 → 重跑本脚本，浏览器里点 Authorize"
}
