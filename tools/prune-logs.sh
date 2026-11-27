#!/usr/bin/env bash
# 清理 Caddy 的旧日志归档。
# Caddy 的 file writer 只按大小滚动（roll_size_mb / roll_keep），没有「按天保留」的能力
# （v0.29.46 试过 roll_keep_for，Caddy 2.11.9 不认这个字段，/load 直接 400 把整站打挂），
# 所以旧 .gz 只能由 cron 来删。
# 用法：tools/prune-logs.sh [--dry]；KEEP_DAYS 可调（默认 7 天）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/data/caddy-logs"
DAYS="${KEEP_DAYS:-7}"
DRY=0
[ "${1:-}" = "--dry" ] && DRY=1

[ -d "$DIR" ] || { echo "没有 $DIR，跳过"; exit 0; }

if [ "$DRY" = "1" ]; then
  n=$(find "$DIR" -type f -name '*.gz' -mtime +"$DAYS" | wc -l | tr -d ' ')
  echo "（--dry）将清理 $n 个超过 ${DAYS} 天的 .gz"
  find "$DIR" -type f -name '*.gz' -mtime +"$DAYS" -printf '%TY-%Tm-%Td %10s %p\n' 2>/dev/null | sort | head -20
  exit 0
fi

n=$(find "$DIR" -type f -name '*.gz' -mtime +"$DAYS" -print -delete | wc -l | tr -d ' ')
before=$(du -sh "$DIR" 2>/dev/null | cut -f1)
# 每天留一行汇总，写进 cron 的 data/logs/prune.log —— Caddy 自己只能按大小滚动，
# 想知道「日志一天涨多少」只能靠这行 + /metrics 里的 cf_caddy_log_bytes。
bytes=$(du -sb "$DIR" 2>/dev/null | cut -f1); bytes=${bytes:-0}
files=$(find "$DIR" -type f | wc -l | tr -d ' ')
oldest=$(find "$DIR" -type f -printf '%TY-%Tm-%Td %p\n' 2>/dev/null | sort | head -1 | cut -d' ' -f1)
echo "$(date '+%F %T') 清理 caddy 旧归档 ${n} 个（>${DAYS} 天）；目录 ${before} / ${bytes} 字节 / ${files} 个文件 / 最老 ${oldest:-无}"
