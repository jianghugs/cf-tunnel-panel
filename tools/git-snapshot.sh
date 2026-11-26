#!/usr/bin/env bash
# 配置即代码：把面板的「声明式配置快照」定期提交到 git 仓库。
#
# 为什么不在面板里调 git：面板镜像基于 node:*-slim，**里面没有 git**（验证过：
# `docker exec cf-tunnel-panel which git` → not found），而重建镜像需要能拉基础镜像。
# 所以提交动作放在宿主机，容器只负责把快照写进 data/config/（面板每次 apply 都会写）。
#
# 用法：
#   1) 建私有仓库，把路径填到 REPO（或用环境变量传入）
#   2) 宿主机 crontab：  */15 * * * * /path/to/cf-tunnel-panel/tools/git-snapshot.sh >>/tmp/cfp-git.log 2>&1
#
# 存什么：
#   - data/config/*.json  ← 面板导出的声明式配置（**不含** tunnel token / CF token / 口令哈希）
#   - 可选 STATE=1 时把 data/state.json 也一起提交（含密钥，仓库必须私有！）
#
# 只提交脱敏的声明式配置是默认行为，因为它可以安全地 share / 让 CI 复现。
set -euo pipefail

# 默认按「脚本所在项目」推导路径，换机器/换目录都不用改脚本
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="${REPO:-$HERE-config}"                                        # 目标 git 仓库
SRC="${SRC:-$HERE/data}"                                            # 面板数据目录
STATE="${STATE:-0}"                                                  # 1 = 连 state.json 一起提交（含密钥）
BRANCH="${BRANCH:-main}"

[ -d "$SRC" ] || { echo "找不到数据目录 $SRC"; exit 1; }
mkdir -p "$REPO"
[ -d "$REPO/.git" ] || { git -C "$REPO" init -q; git -C "$REPO" checkout -q -b "$BRANCH" 2>/dev/null || true; }

# ---- 1. 复制声明式配置（data/config/*.json，不含 last-applied 之外的历史也行：全要） ----
mkdir -p "$REPO/config"
if compgen -G "$SRC/config/*.json" > /dev/null; then
  # 只留最近的 120 份，避免仓库无限膨胀
  ls -1t "$SRC"/config/*.json | tail -n +121 | while read -r old; do rm -f "$old"; done 2>/dev/null || true
  cp -f "$SRC"/config/*.json "$REPO/config/" 2>/dev/null || true
  # 仓库里也只保留 120 份
  ls -1t "$REPO"/config/*.json 2>/dev/null | tail -n +121 | xargs -r rm -f
fi

# ---- 2. 可选：原始 state（含 token / 口令哈希） ----
if [ "$STATE" = "1" ] && [ -f "$SRC/state.json" ]; then
  cp -f "$SRC/state.json" "$REPO/state.json"
fi

cd "$REPO"
[ -f .gitignore ] || printf '%s\n' '*.log' 'node_modules/' '.DS_Store' > .gitignore
git add -A
if git diff --cached --quiet; then
  echo "[$(date -Iseconds)] 配置没变化，跳过提交"
  exit 0
fi

SUMMARY=$(python3 - "$REPO" <<'PY'
import json, os, sys
repo = sys.argv[1]
p = os.path.join(repo, 'config', 'last-applied.json')
try:
    d = json.load(open(p))
    print(f"{len(d.get('tunnels', []))} 出口 / {len(d.get('routes', []))} 规则")
except Exception:
    print("配置快照")
PY
)
git -c user.name="cf-tunnel-panel" -c user.email="panel@localhost" \
    commit -q -m "config: $(date -Iseconds)（${SUMMARY}）"
echo "[$(date -Iseconds)] 已提交：$(git -C "$REPO" log -1 --oneline)"
