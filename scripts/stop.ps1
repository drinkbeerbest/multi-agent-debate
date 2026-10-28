# Stop every node process that belongs to this project.
# NOTE: keep this file UTF-8 with BOM so Windows PowerShell 5.1 reads the
# Chinese strings correctly.
param(
    [int]$Port = 8787,
    [switch]$NoPause
)

$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$project = Split-Path -Parent $PSScriptRoot
$marker = Split-Path -Leaf $project
$stopped = @{}

function Stop-NodeProcess($processId, $why) {
    if ($processId -and -not $stopped.ContainsKey($processId)) {
        Write-Host ("  已停止 PID " + $processId + "  (" + $why + ")")
        Stop-Process -Id $processId -Force
        $stopped[$processId] = $true
    }
}

Write-Host ""
Write-Host "  正在停止多智能体辩论平台..."

# 1) 监听平台端口的进程
Get-NetTCPConnection -LocalPort $Port -State Listen | ForEach-Object {
    Stop-NodeProcess $_.OwningProcess "listening on port $Port"
}

# 2) 命令行里带项目目录名的 node 进程
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
    if ($_.CommandLine -and $_.CommandLine -like "*$marker*") {
        Stop-NodeProcess $_.ProcessId "command line references $marker"
    }
}

# 3) 运行本项目脚本的 node 进程（相对路径启动的情况）
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
    if ($_.CommandLine -and ($_.CommandLine -like '*mock-provider.js*' -or $_.CommandLine -like '*mavis-debate*')) {
        Stop-NodeProcess $_.ProcessId "project script"
    }
}

if ($stopped.Count -eq 0) {
    Write-Host "  未发现正在运行的实例"
}
Write-Host "  完成。"
Write-Host ""

if (-not $NoPause -and $env:DEBATE_NO_PAUSE -ne '1') {
    try { [void](Read-Host "  按回车键退出") } catch { }
}
