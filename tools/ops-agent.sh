#!/usr/bin/env bash
# 宿主机侧的运维小代理：cron 每分钟跑一次，处理面板排队的一次性运维请求。
#
# 为什么放宿主机：面板容器没有 docker CLI，也不该拿 docker 特权；它只把请求写成
# data/ops/rollback.json，真正动 docker 的两步（改 tag + 滚动升级）在这里跑，
# 结果写回 data/ops/rollback-result.json，面板页面读它显示。
#
# 用法（cron）：* * * * * /opt/cf-tunnel-panel/tools/ops-agent.sh
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OPS="$ROOT/data/ops"
REQ="$OPS/rollback.json"
RUN="$OPS/rollback.running.json"
RES="$OPS/rollback-result.json"
LOG="$ROOT/data/logs/ops-agent.log"

mkdir -p "$OPS" "$(dirname "$LOG")"
exec >>"$LOG" 2>&1

# 同一时刻只允许一个实例，避免 cron 叠跑
exec 9>"$OPS/.agent.lock"
flock -n 9 || exit 0

[ -f "$REQ" ] || exit 0
say() { echo "$(date -Is) $*"; }

VER="$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1])) or {};print(d.get("version",""))' "$REQ" 2>/dev/null || true)"
if ! printf '%s' "$VER" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  say "请求里的版本号不合法：[${VER}]，丢弃"
  rm -f "$REQ"
  exit 1
fi

write_result() { # $1=ok(0/1) $2=exitCode $3=seconds $4=tailfile
  python3 - "$RES" "$VER" "$1" "$2" "$3" "${4:-}" <<'PY'
import json, sys, time
path, ver, ok, code, secs, tailf = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6]
tail = []
if tailf:
    try:
        tail = open(tailf, encoding='utf-8', errors='replace').read().splitlines()[-40:]
    except OSError:
        tail = []
json.dump({"version": ver, "ok": ok == "1", "exitCode": int(code), "seconds": secs,
           "finishedAt": int(time.time() * 1000), "tail": tail},
          open(path, "w"), ensure_ascii=False, indent=2)
PY
}

if ! docker image inspect "cf-tunnel-panel:${VER}" >/dev/null 2>&1; then
  say "本机没有 cf-tunnel-panel:${VER}，丢弃"
  rm -f "$REQ"
  printf '宿主机上没有 cf-tunnel-panel:%s 这个镜像，请求已丢弃\n' "$VER" > "$OPS/.tail.tmp"
  write_result 0 127 0 "$OPS/.tail.tmp"
  rm -f "$OPS/.tail.tmp"
  exit 1
fi

if [ -f "$RUN" ]; then
  say "已有一个回滚在跑（$(cat "$RUN" 2>/dev/null | head -c 80)），本次跳过"
  exit 0
fi

mv "$REQ" "$RUN"
say "开始回滚：${VER}"
START=$(date +%s)
RUNLOG="$ROOT/data/logs/rollback-${VER}-$(date +%Y%m%d-%H%M%S).log"
bash "$ROOT/tools/rollback.sh" "$VER" >"$RUNLOG" 2>&1
CODE=$?
END=$(date +%s)
say "回滚结束：${VER} 退出码 ${CODE}，用时 $((END - START))s，日志 ${RUNLOG}"

tail -n 40 "$RUNLOG" > "$OPS/.tail.tmp" 2>/dev/null || : > "$OPS/.tail.tmp"
if [ "$CODE" -eq 0 ]; then write_result 1 "$CODE" "$((END - START))" "$OPS/.tail.tmp"
else write_result 0 "$CODE" "$((END - START))" "$OPS/.tail.tmp"; fi
rm -f "$OPS/.tail.tmp" "$RUN"
exit 0
