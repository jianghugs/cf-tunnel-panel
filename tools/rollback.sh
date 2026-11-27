#!/bin/bash
# 回滚到指定版本号（用本机已存在的镜像，不重新构建）
#
#   tools/rollback.sh 0.29.57
#
# 做的事：把 cf-tunnel-panel:<版本> 重新标成 cf-tunnel-panel:local（rolling-upgrade 默认用这个 tag）
# → 走一次滚动升级 → 校验 healthz 版本与公网；任何一步不对就自动切回原版本。
# 只动容器的镜像与进程，不改 git 工作区（要连源码一起回到旧版请 git checkout v<版本>）。
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
warn() { printf '\033[33m! %s\033[0m\n' "$*"; }

VER="${1:-}"
[ -n "$VER" ] || die "用法：tools/rollback.sh <版本号，例如 0.29.57>"
VER="${VER#v}"
CUR="$(bash tools/node.sh -p "require('./package.json').version" 2>/dev/null | tail -1)"
[ -n "$CUR" ] || die "读不到当前版本（tools/node.sh 出问题了？）"
say "回滚：$CUR → $VER"
[ "$VER" = "$CUR" ] && { warn "当前已经是 $VER，不用回滚"; exit 0; }

docker image inspect "cf-tunnel-panel:$VER" >/dev/null 2>&1 ||
  die "本机没有镜像 cf-tunnel-panel:$VER —— 回滚只用现成镜像；要重建请 git checkout v$VER 后跑 tools/release.sh"

BEFORE=""
for pp in 8090 8095; do
  if curl -sf -m 2 "http://127.0.0.1:$pp/healthz" >/dev/null 2>&1; then BEFORE="$pp"; fi
done
say "回滚前 leader 在 ${BEFORE:-未知} 端口"

back() {
  say "切回 $CUR"
  docker tag "cf-tunnel-panel:$CUR" cf-tunnel-panel:local 2>/dev/null || true
  MOUNT_SRC=0 bash tools/rolling-upgrade.sh --apply || warn "切回也失败了，手工看 docker ps"
}

docker tag "cf-tunnel-panel:$VER" cf-tunnel-panel:local || die "给 $VER 打 local 标签失败"
if ! MOUNT_SRC=0 PANEL_HOST="${PANEL_HOST:-panel.jianghugs.shop}" bash tools/rolling-upgrade.sh --apply; then
  back
  die "回滚到 $VER 失败（滚动升级报错），已尝试切回 $CUR"
fi

say "校验版本"
OK=0
for pp in 8090 8095; do
  body="$(curl -s -m 3 "http://127.0.0.1:$pp/healthz" 2>/dev/null || true)"
  case "$body" in
    *"\"version\":\"$VER\""*) OK=1; echo "  ✓ :$pp → $body" ;;
  esac
done
if [ "$OK" != 1 ]; then
  back
  die "回滚后 healthz 里看不到 $VER，已尝试切回 $CUR"
fi

PUB="$(curl -s -m 10 -o /dev/null -w '%{http_code}' "https://${PANEL_HOST:-panel.jianghugs.shop}/healthz" 2>/dev/null || true)"
say "公网 /healthz → ${PUB:-无响应}"
[ "${PUB:-0}" = 200 ] || warn "公网不是 200，查 cloudflared 是否在线、8080 上是不是只有生产 Caddy"
say "回滚完成：$CUR → $VER（git 工作区没动）"
