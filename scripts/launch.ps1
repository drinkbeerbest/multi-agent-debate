# One-click launcher for Multi-Agent Debate Platform (Windows).
# NOTE: keep this file UTF-8 with BOM, otherwise Windows PowerShell 5.1
# decodes the Chinese strings as ANSI and prints garbage.
param(
    [string]$Port = '',
    [switch]$NoBrowser,   # 只启动服务，不打开浏览器（供自动化测试使用）
    [switch]$NoPause      # 结束时不等待回车
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if ($Port -eq '') { $Port = '8787' }
$url = "http://127.0.0.1:$Port"
$env:PORT = $Port

function Wait-Exit {
    if ($NoPause -or $env:DEBATE_NO_PAUSE -eq '1') { return }
    try { [void](Read-Host "  按回车键退出") } catch { }
}

Write-Host ""
Write-Host "  ==================================================" -ForegroundColor Cyan
Write-Host "        多智能体辩论平台  ·  一键启动" -ForegroundColor Cyan
Write-Host "  ==================================================" -ForegroundColor Cyan
Write-Host ""

# ---- 1. Node.js 必须可用 ----
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "  [错误] 未检测到 Node.js" -ForegroundColor Red
    Write-Host ""
    Write-Host "  请先安装 Node.js 18 或更高版本： https://nodejs.org/"
    Write-Host "  安装完成后重新双击本脚本即可启动。"
    Write-Host ""
    Wait-Exit
    exit 1
}

# ---- 2. 服务是否已经在跑（并比对版本）----
$serverFile = Join-Path $root 'server.js'
$expected = ''
try {
    $m = Select-String -Path $serverFile -Pattern "const BUILD = '([^']+)'"
    if ($m) { $expected = $m.Matches[0].Groups[1].Value }
} catch { }

$running = $null
try {
    $resp = Invoke-WebRequest -Uri "$url/api/health" -UseBasicParsing -TimeoutSec 2
    $running = $resp.Content | ConvertFrom-Json
} catch {
    $running = $null
}

if ($running) {
    if (-not $expected -or $running.build -eq $expected) {
        Write-Host "  检测到服务已在运行（版本 $($running.build)），直接为你打开页面。" -ForegroundColor Green
        if (-not $NoBrowser) { Start-Process $url }
        Wait-Exit
        exit 0
    }
    # 版本不一致：旧进程还在跑旧代码，必须重启才能生效
    Write-Host "  检测到旧版本服务（$($running.build)），当前代码为 $expected，正在重启…" -ForegroundColor Yellow
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'stop.ps1') -Port $Port -NoPause | Out-Null
    Start-Sleep -Seconds 2
}

# ---- 3. 启动服务，2 秒后自动打开浏览器 ----
Write-Host "  正在启动服务 ...  $url" -ForegroundColor Green
Write-Host ""
Write-Host "  首次使用请点击页面右上角「设置」，"
Write-Host "  分别接入正方 / 反方两个大模型 API。"
Write-Host ""
Write-Host "  关闭本窗口或按 Ctrl+C 即可停止服务。"
Write-Host ""

if (-not $NoBrowser) {
    Start-Process powershell -WindowStyle Hidden -ArgumentList @(
        '-NoProfile',
        '-Command',
        "Start-Sleep -Seconds 2; Start-Process '$url'"
    )
}

node server.js

Write-Host ""
Write-Host "  服务已停止。" -ForegroundColor Yellow
Wait-Exit
