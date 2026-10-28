#!/usr/bin/env bash
# 多智能体辩论平台 —— 一键启动（macOS / Linux）
# 用法: ./start.sh [端口]
set -euo pipefail

cd "$(dirname "$0")"

PORT="${1:-8787}"
URL="http://127.0.0.1:${PORT}"

echo ""
echo "  =================================================="
echo "        多智能体辩论平台  ·  一键启动"
echo "  =================================================="
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "  [错误] 未检测到 Node.js"
  echo ""
  echo "  请先安装 Node.js 18 或更高版本： https://nodejs.org/"
  echo ""
  exit 1
fi

open_browser() {
  if command -v open >/dev/null 2>&1; then
    open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL"
  fi
}

if curl -fsS "${URL}/api/health" >/dev/null 2>&1; then
  echo "  检测到服务已在运行，直接为你打开页面。"
  open_browser
  exit 0
fi

echo "  正在启动服务 ...  ${URL}"
echo ""
echo "  首次使用请点击页面右上角「设置」，"
echo "  分别接入正方 / 反方两个大模型 API。"
echo ""
echo "  按 Ctrl+C 停止服务。"
echo ""

( sleep 2; open_browser ) &

exec node server.js
