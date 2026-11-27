#!/usr/bin/env bash
# node 跑器：宿主机有 node 就用它，没有就退回 node:22-alpine 容器。
# 部署机是 Alpine 宿主、没装 node，而 release.sh 与各种校验脚本都要 node，所以统一走这里。
# 用法：tools/node.sh -p 'process.version'   /   tools/node.sh tools/codehash.js
#   CFP_NODE_IN_CONTAINER=1 强制走容器（release.sh 里的包装函数用它避免自递归）
#   CFP_NODE_IMAGE 换镜像，默认 node:22-alpine
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -z "${CFP_NODE_IN_CONTAINER:-}" ] && command -v node >/dev/null 2>&1; then
  exec node "$@"
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "既没有 node 也没有 docker：装一个 node 再跑" >&2
  exit 127
fi

# 容器里保持同一个绝对路径，脚本里的相对路径与 require 才照旧可用
WORK="$PWD"
case "$WORK" in
  "$ROOT" | "$ROOT"/*) : ;;
  *) WORK="$ROOT" ;;
esac

# 测试常用环境变量要显式 -e 才进容器（docker 不会自动继承宿主机 export）
PASSENV=()
for _v in CFP_NODE_IMAGE PANEL_URL PANEL_USER PANEL_PASS PANEL_NO_AUTH \
          PANEL_PROXY_PORT CADDY_EDGE CADDY_PORT E2E_STANDBY_PORT NODE_PATH TZ; do
  if [ -n "${!_v:-}" ]; then PASSENV+=(-e "$_v=${!_v}"); fi
done

exec docker run --rm -i --network host \
  -e CFP_NODE_IN_CONTAINER=1 \
  "${PASSENV[@]}" \
  -v "$ROOT":"$ROOT" -w "$WORK" \
  "${CFP_NODE_IMAGE:-node:22-alpine}" node "$@"
