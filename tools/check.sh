#!/usr/bin/env bash
# 静态检查一把过（宿主机没有 npm/node 也能跑 —— 走 tools/node.sh）
#   ./tools/check.sh
# 等价于 npm run check：requires → i18n → openapi → alerts → lint
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

fail=0
run() {
  local name=$1; shift
  printf '\n== %s\n' "$name"
  if "$@"; then printf '   ✓ %s\n' "$name"; else printf '   ✗ %s\n' "$name"; fail=1; fi
}

NODE="$ROOT/tools/node.sh"
run "require 自检（相对路径解析 + 内置模块漏 require）" bash "$NODE" tools/check-requires.js
run "文案字典（重复键 / 空译文 / 未收录中文）"          bash "$NODE" tools/i18n-check.js
run "接口清单（/api 路由必须都在 docs/openapi.json）"    bash "$NODE" tools/openapi.js --check
run "告警规则两份副本一致"                              bash "$NODE" tools/check-alerts.js

printf '\n== ESLint no-undef（--quiet）\n'
LINT_BIN=${ESLINT_BIN:-/tmp/lint/node_modules/.bin/eslint}
LINT_ROOT="${LINT_BIN%%/node_modules/*}"
if [ -x "$LINT_BIN" ]; then
  if docker run --rm -v "$ROOT:/w" -v "$LINT_ROOT:/l" -w /w \
       node:22-alpine /l/node_modules/.bin/eslint . --quiet; then
    printf '   ✓ ESLint\n'
  else
    printf '   ✗ ESLint\n'; fail=1
  fi
elif [ -x node_modules/.bin/eslint ]; then
  if bash "$NODE" node_modules/.bin/eslint . --quiet; then printf '   ✓ ESLint\n'; else printf '   ✗ ESLint\n'; fail=1; fi
else
  printf '   · 跳过（本机没装 eslint；CI 里会跑）：\n'
  printf '     docker run --rm -v /tmp/lint:/l node:22-alpine npm i --prefix /l eslint@9\n'
fi

if [ "$fail" = 0 ]; then printf '\n全部通过\n'; else printf '\n有检查未通过\n' >&2; fi
exit "$fail"
