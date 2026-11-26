#!/usr/bin/env bash
# 滚动升级：两个实例同时活着，先把新代码起在另一个槽位，确认就绪后让老实例退场，
# Caddy 靠「双上游 + 主动健康检查」把流量切过去，整个过程不中断。
#
# 容器名是固定的 blue/green 一对，**不再抢 compose 的名字**：
#   cf-tunnel-panel-blue  :8090
#   cf-tunnel-panel-green :8095
# 每次升级只是「起另一色 → 停当前色」，所以来回跑多少遍都不会和 `docker compose up -d` 撞名，
# 也不会出现「名字到底指哪一代实例」这种歧义。
#
# 用法：
#   tools/rolling-upgrade.sh                  # 干跑：只做 preflight 并打印计划
#   tools/rolling-upgrade.sh --apply          # 真做
#   tools/rolling-upgrade.sh --apply --prune  # 真做，成功后删掉旧的那一色容器
#   tools/rolling-upgrade.sh --bootstrap --apply  # 全新部署：没有实例在跑时创建蓝色槽位
#
# 前提（很重要）：
#   1) 正在跑的面板必须带 PANEL_SLOT_PEERS=<另一槽位>，否则面板规则是单上游，
#      Caddy 不知道还有另一个实例 —— 这时脚本会退化成「先停后起」，有 1~3 秒 5xx。
#   2) 数据目录必须共享（同一个 ./data），两个实例靠租约文件决定谁是 leader。
#   3) 首次从老的单容器（cf-tunnel-panel）迁移过来时，老容器会被当成「当前色」保留，
#      新实例以蓝色/绿色身份起来；确认无误后可以 --prune 或手工删掉老容器。
set -euo pipefail

BASE=${BASE:-cf-tunnel-panel}
BLUE_PORT=${BLUE_PORT:-8090}
GREEN_PORT=${GREEN_PORT:-8095}
DATA=${DATA:-$(cd "$(dirname "$0")/.." && pwd)/data}
SRC=${SRC:-$(cd "$(dirname "$0")/.." && pwd)}
IMAGE=${IMAGE:-cf-tunnel-panel:local}
PANEL_HOST=${PANEL_HOST:-}
CADDY_ADMIN=${CADDY_ADMIN:-http://127.0.0.1:20190}
# 默认只听回环：:8080 会绑 0.0.0.0，既可能撞宿主机上已占 8080 的进程，也等于把代理暴露到内网
CADDY_LISTEN=${CADDY_LISTEN:-127.0.0.1:8080}
UIDGID=${UIDGID:-1000:1000}
READY_TIMEOUT=${READY_TIMEOUT:-60}
# MOUNT_SRC=1（默认）把工作区的 src/tools/package.json 挂进容器：改完代码直接升级，不必构建镜像。
# MOUNT_SRC=0 则完全用镜像里的代码 —— 前提是先 `docker compose build panel`；
# 挂源码时 /healthz 的 drift 会是 true，因为 code 反映的是工作区而不是镜像，这是设计如此。
MOUNT_SRC=${MOUNT_SRC:-1}

APPLY=0; PRUNE=0; BOOTSTRAP=0
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    --prune) PRUNE=1 ;;
    --bootstrap) BOOTSTRAP=1 ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) echo "未知参数: $a" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$@" || true; }
mode_of() { curl -s --max-time 3 "http://127.0.0.1:$1/healthz" | sed -n 's/.*"mode":"\([a-z]*\)".*/\1/p'; }
port_env() { docker inspect "$1" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^PORT=//p'; }
peers_env() { docker inspect "$1" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^PANEL_SLOT_PEERS=//p'; }
wait_mode() { # wait_mode <port> <want> <timeout>
  local port=$1 want=$2 t=$3 i=0
  while [ $i -lt "$t" ]; do
    [ "$(mode_of "$port")" = "$want" ] && return 0
    sleep 1; i=$((i+1))
  done
  return 1
}
running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || echo false)" = "true" ]; }

# ---------------------------------------------------------------- 找出「当前色」
say "== preflight =="
[ -f "$SRC/src/server.js" ] || die "$SRC 里没有 src/server.js（用 SRC=… 指定源码目录）"
[ -d "$DATA" ] || die "数据目录 $DATA 不存在（用 DATA=… 指定）"

CUR_NAME=""; CUR=""; CUR_COLOR=""
for c in blue green; do
  n="$BASE-$c"; p=$([ "$c" = blue ] && echo "$BLUE_PORT" || echo "$GREEN_PORT")
  if running "$n"; then CUR_NAME="$n"; CUR="$p"; CUR_COLOR="$c"; break; fi
done
if [ -z "$CUR_NAME" ]; then
  # 兼容老的单容器（compose 创建的那个）：它没有 blue/green 名字，按它的 PORT 判断身份
  if running "$BASE"; then
    CUR_NAME="$BASE"; CUR="$(port_env "$BASE")"; CUR="${CUR:-$BLUE_PORT}"
    CUR_COLOR=$([ "$CUR" = "$GREEN_PORT" ] && echo green || echo blue)
    say "检测到旧式单容器 $BASE（:$CUR）→ 本次升级后改用 blue/green 命名"
  elif [ "$BOOTSTRAP" = "1" ]; then
    # 全新部署：直接起蓝色槽位。必须显式 --bootstrap，避免手滑把正式环境起成空白状态。
    CUR_NAME=""; CUR="$BLUE_PORT"; CUR_COLOR="blue"
    say "没有正在运行的实例 → 以 --bootstrap 创建蓝色槽位（:$BLUE_PORT）"
  else
    die "没有找到正在运行的实例（$BASE-blue / $BASE-green / $BASE 都没在跑）；全新部署请加 --bootstrap"
  fi
fi
NEXT_COLOR=$([ "$CUR_COLOR" = blue ] && echo green || echo blue)
NEXT="$([ "$NEXT_COLOR" = blue ] && echo "$BLUE_PORT" || echo "$GREEN_PORT")"
NEXT_NAME="$BASE-$NEXT_COLOR"

if [ -n "$CUR_NAME" ]; then
  CUR_HEALTH=$(code "http://127.0.0.1:$CUR/healthz")
  [ "$CUR_HEALTH" = "200" ] || die "当前实例 http://127.0.0.1:$CUR/healthz 返回 $CUR_HEALTH"
  say "当前实例 $CUR_NAME（:$CUR，$CUR_COLOR）健康"
else
  say "bootstrap：将创建 $CUR_COLOR 槽位（:$CUR）"
fi
say "接班目标 $NEXT_NAME（:$NEXT，$NEXT_COLOR）"

if ss -ltn 2>/dev/null | grep -q ":$NEXT "; then die "接班槽位 :$NEXT 已被占用"; fi
say "接班槽位 :$NEXT 空闲"

# 注意 pipefail：CUR_NAME 为空时 `docker inspect ""` 会失败，整条管道（含 sed）状态非 0，
# 在 set -e 下会直接退出脚本。bootstrap 路径必须显式兜住。
SLOTS=""
[ -n "$CUR_NAME" ] && SLOTS=$(peers_env "$CUR_NAME" || true)
ZERO_DOWNTIME=0
if echo ",$SLOTS," | grep -q ",$NEXT,"; then
  ZERO_DOWNTIME=1
  say "当前实例已预留槽位（PANEL_SLOT_PEERS=$SLOTS）→ 可以零中断切换"
else
  say "警告：当前实例没有预留 $NEXT（PANEL_SLOT_PEERS=${SLOTS:-<未设置>}）"
  say "      切换会退化成「先停后起」，期间 Caddy 无上游，约 1~3 秒 5xx"
  say "      想零中断：让当前实例以 PANEL_SLOT_PEERS=$NEXT 运行（本脚本起的实例自带）"
fi

# 挂载宿主源码时 /healthz 的 code 反映工作区而不是镜像，这点必须说清楚，
# 否则「镜像是不是新的」这个问题永远说不明白。
if docker inspect "$CUR_NAME" --format '{{range .Mounts}}{{.Source}}:{{.Destination}} {{end}}' 2>/dev/null | grep -q "$SRC/src:/app/src"; then
  say "提示：$CUR_NAME 挂着宿主源码（$SRC/src → /app/src）；新实例同样如此，"
  say "      升级后 /healthz 的 code 反映工作区。要验证镜像本身请用 docker compose。"
fi

if [ "$APPLY" != "1" ]; then
  say ""
  say "== 计划（干跑，没动任何东西）=="
  say "1) 用 $SRC 的源码在 :$NEXT 起 $NEXT_NAME（共享 $DATA，先当 standby）"
  say "2) 等它 /healthz 200 且 mode=standby"
  say "3) 停掉 $CUR_NAME（:$CUR），租约释放 → 新实例 5 秒内变 leader"
  say "4) 验证新实例 mode=leader$( [ -n "$PANEL_HOST" ] && echo "、经 Caddy 访问 $PANEL_HOST" )"
  say "5) 旧的 $CUR_NAME 作为回滚点保留$( [ "$PRUNE" = "1" ] && echo "（--prune：验证通过后删掉）" || echo "（--prune 可删）" )"
  say ""
  say "确认无误后加 --apply 执行"
  exit 0
fi

if [ -z "$CUR_NAME" ]; then
  # ---------------------------------------------------------------- bootstrap
  say ""
  say "== bootstrap：创建 $BASE-$CUR_COLOR（:$CUR）=="
  docker rm -f "$BASE-$CUR_COLOR" >/dev/null 2>&1 || true
  docker run -d --name "$BASE-$CUR_COLOR" \
    --network host --user "$UIDGID" --restart unless-stopped \
    -e PORT="$CUR" -e LOG_STDOUT=1 -e TZ=Asia/Shanghai -e NODE_OPTIONS=--dns-result-order=ipv4first \
    -e CADDY_ADMIN="$CADDY_ADMIN" -e CADDY_LISTEN="$CADDY_LISTEN" \
    -e PANEL_INSTANCE="$CUR_COLOR-$CUR-$(date +%s)" \
    -e PANEL_SLOT_PEERS="$NEXT" \
    --label com.docker.compose.project=cf-tunnel-panel \
    --label com.docker.compose.service=panel \
    --label com.docker.compose.oneoff=False \
    -v "$DATA:/data" -v /var/run/docker.sock:/var/run/docker.sock:ro \
    $([ "$MOUNT_SRC" = "1" ] && echo "-v $SRC/src:/app/src:ro -v $SRC/tools:/app/tools:ro -v $SRC/package.json:/app/package.json:ro") \
    "$IMAGE" >/dev/null
  if ! wait_mode "$CUR" leader "$READY_TIMEOUT"; then
    docker logs --tail 30 "$BASE-$CUR_COLOR" 2>&1 || true
    die "bootstrap 失败：实例没在 ${READY_TIMEOUT}s 内成为 leader"
  fi
  say "已就绪：$BASE-$CUR_COLOR（:$CUR，leader）"
  say "下一次升级会切到 $NEXT_COLOR（:$NEXT）"
  exit 0
fi

# ---------------------------------------------------------------- 起新实例
say ""
say "== 1/4 起新实例 $NEXT_NAME（:$NEXT）=="
docker rm -f "$NEXT_NAME" >/dev/null 2>&1 || true
docker run -d --name "$NEXT_NAME" \
  --network host --user "$UIDGID" --restart unless-stopped \
  -e PORT="$NEXT" -e LOG_STDOUT=1 -e TZ=Asia/Shanghai -e NODE_OPTIONS=--dns-result-order=ipv4first \
  -e CADDY_ADMIN="$CADDY_ADMIN" -e CADDY_LISTEN="$CADDY_LISTEN" \
  -e PANEL_INSTANCE="$NEXT_COLOR-$NEXT-$(date +%s)" \
  -e PANEL_SLOT_PEERS="$CUR" \
  --label com.docker.compose.project=cf-tunnel-panel \
  --label com.docker.compose.service=panel \
  --label com.docker.compose.container-number=1 \
  --label com.docker.compose.oneoff=False \
  --label com.docker.compose.project.working_dir="$SRC" \
  --label com.docker.compose.project.config_files="$SRC/docker-compose.yml" \
  -v "$DATA:/data" -v /var/run/docker.sock:/var/run/docker.sock:ro \
  $([ "$MOUNT_SRC" = "1" ] && echo "-v $SRC/src:/app/src:ro -v $SRC/tools:/app/tools:ro -v $SRC/package.json:/app/package.json:ro") \
  "$IMAGE" >/dev/null
say "已启动 $NEXT_NAME"

say "== 2/4 等它就绪（standby）=="
if ! wait_mode "$NEXT" standby "$READY_TIMEOUT"; then
  docker logs --tail 30 "$NEXT_NAME" 2>&1 || true
  die "新实例没有在 ${READY_TIMEOUT}s 内进入 standby（先看上面的日志）"
fi
say "新实例已就绪，模式 standby（当前实例仍是 leader，此时流量没变）"

# ---------------------------------------------------------------- 切换
say "== 3/4 让当前实例退场 =="
docker stop -t 10 "$CUR_NAME" >/dev/null
say "$CUR_NAME 已停（租约立即释放）"
if ! wait_mode "$NEXT" leader 40; then
  say "新实例没能接管，回滚：重启 $CUR_NAME"
  docker start "$CUR_NAME" >/dev/null || true
  die "接管失败，已尝试回滚；新实例保持运行以便排查（docker logs $NEXT_NAME）"
fi
say "新实例已接管（mode=leader）"

# ---------------------------------------------------------------- 验证
say "== 4/4 验证 =="
OK=1
NEW_HEALTH=$(code "http://127.0.0.1:$NEXT/healthz")
NEW_MODE=$(mode_of "$NEXT")
say "  $NEXT_NAME(:$NEXT) /healthz → $NEW_HEALTH，mode=$NEW_MODE"
[ "$NEW_HEALTH" = "200" ] && [ "$NEW_MODE" = "leader" ] || { say "警告：新槽位没接管成功"; OK=0; }
if [ -n "$PANEL_HOST" ]; then
  for u in /healthz /assets/app.css; do
    c=$(code -H "Host: $PANEL_HOST" "http://127.0.0.1:8080$u")
    say "  :8080$u（Host: $PANEL_HOST）→ $c"
    [ "$c" = "200" ] || OK=0
  done
else
  say "  （没给 PANEL_HOST，跳过经 Caddy 的验证；要验证就加 PANEL_HOST=你的面板域名）"
fi

if [ "$OK" = "1" ] && [ "$PRUNE" = "1" ] && [ "$CUR_NAME" != "$BASE" ]; then
  docker rm "$CUR_NAME" >/dev/null && say "已删除旧容器 $CUR_NAME" && CUR_NAME="(已删除)"
elif [ "$CUR_NAME" = "$BASE" ]; then
  say "旧式单容器 $BASE 保留着（它是你的回滚点）；确认稳定后可 docker rm $BASE"
fi

say ""
say "完成。当前实例 = $NEXT_NAME（:$NEXT，leader）；另一色 :$CUR $( [ "$(mode_of "$CUR")" = "standby" ] && echo '在热备待命' || echo '已停止' )"
say "下次升级直接再跑一遍：tools/rolling-upgrade.sh --apply   （会自动切回 $([ "$NEXT_COLOR" = blue ] && echo 'green' || echo 'blue')）"
[ "$OK" = "1" ] || die "验证有失败项，请检查上面输出"
