#!/usr/bin/env bash
# 一键发版：升版本 → 写 CHANGELOG → 提交 → 打 tag → push →（可选）构建镜像并滚动升级
# 用法：
#   tools/release.sh 0.29.5 --notes-file /tmp/notes.md [--build] [--no-push] [--dry] [--force]
# 说明：
#   --notes-file  Release/CHANGELOG 的正文（markdown 列表），必填；脚本把它插到 CHANGELOG 顶部
#   --build       额外构建镜像、打 tag、跑 tools/rolling-upgrade.sh --apply，并校验 /healthz
#   --no-push     只本地提交与打 tag，不 push（想先复核时用）
#   --dry         只打印将要做什么，不写任何文件
#   --force       允许工作区不干净 / 版本号没变
set -euo pipefail

VERSION=""; NOTES=""; DO_BUILD=0; NO_PUSH=0; DRY=0; FORCE=0
PANEL_PORT="${PANEL_PORT:-8090}"

while [ $# -gt 0 ]; do
  case "$1" in
    0.*|[0-9]*) VERSION="$1"; shift ;;
    --notes-file) NOTES="${2:-}"; shift 2 ;;
    --build) DO_BUILD=1; shift ;;
    --no-push) NO_PUSH=1; shift ;;
    --dry) DRY=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

die() { echo "错误：$*" >&2; exit 1; }
step() { echo; echo "== $* =="; }

[ -n "$VERSION" ] || die "缺少版本号，例如：tools/release.sh 0.29.5 --notes-file /tmp/notes.md"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "版本号格式应为 X.Y.Z 或 X.Y.Z-rc.1，收到：$VERSION"
[ -n "$NOTES" ] || die "缺少 --notes-file（Release 说明）。先把这版改了什么写成 markdown 列表存文件里。"
[ -f "$NOTES" ] || die "notes 文件不存在：$NOTES"
[ -s "$NOTES" ] || die "notes 文件是空的：$NOTES"

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
step "检查环境（$ROOT）"
git rev-parse --git-dir >/dev/null 2>&1 || die "当前目录不是 git 仓库"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || echo "⚠️  当前分支是 $BRANCH（通常应在 main）"
if [ -n "$(git status --porcelain)" ] && [ "$FORCE" -ne 1 ]; then
  git status --short
  die "工作区有未提交改动。先提交，或加 --force"
fi
git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null && die "tag v$VERSION 已存在"
CUR="$(node -p "require('./package.json').version")"
echo "当前版本：$CUR → 目标版本：$VERSION"

step "计划"
cat <<EOF
  1. package.json          : $CUR → $VERSION
  2. CHANGELOG.md          : 顶部插入 "## v$VERSION" 段（内容取自 $NOTES）
  3. git commit            : "release: v$VERSION"
  4. git tag               : v$VERSION
  5. git push              : origin ${BRANCH}$([ "$NO_PUSH" -eq 1 ] && echo "（已跳过）")
$([ "$DO_BUILD" -eq 1 ] && echo "  6. 构建镜像 + 滚动升级 + 校验 /healthz（端口 $PANEL_PORT）" || echo "  6. 跳过镜像构建（要构建加 --build）")
EOF
if [ "$DRY" -eq 1 ]; then echo; echo "（--dry 到此为止，没有写入任何文件）"; exit 0; fi

step "1/6 写 package.json"
node -e '
const fs=require("fs"),f="package.json";
const p=JSON.parse(fs.readFileSync(f,"utf8"));
p.version=process.argv[1];
fs.writeFileSync(f, JSON.stringify(p,null,2)+"\n");
' "$VERSION"

step "2/6 写 CHANGELOG.md"
python3 - "$VERSION" "$NOTES" <<'PY'
import sys, pathlib
ver, notes_file = sys.argv[1], sys.argv[2]
p = pathlib.Path('CHANGELOG.md')
text = p.read_text(encoding='utf-8')
if f'## v{ver}' in text:
    sys.exit(f'CHANGELOG 里已经有 v{ver} 段')
body = pathlib.Path(notes_file).read_text(encoding='utf-8').strip()
section = f'## v{ver}\n\n{body}\n\n'
# 插到第一个 "## " 之前；没有就追加
idx = text.find('\n## ')
if idx == -1:
    new = text.rstrip() + '\n\n' + section
else:
    new = text[:idx+1] + section + text[idx+1:]
p.write_text(new, encoding='utf-8')
print(f'CHANGELOG 已插入 v{ver}（{len(body.splitlines())} 行）')
PY

step "3/6 提交"
# 把工作区里所有改动一起提交：以前只 add package.json + CHANGELOG，
# 用 --force 跳过了「工作区脏」检查时，代码改动会被悄悄留在工作区 ——
# 后果是「tag 指的提交里没有发布出去的代码」，镜像与源码对不上（v0.29.11 就这么翻过车）。
git add -A
if git diff --cached --quiet; then
  echo "没有可提交的改动（版本号与 CHANGELOG 也没变？）" >&2
  [ "$FORCE" -eq 1 ] || exit 3
fi
git commit -q -m "release: v$VERSION" || true
git --no-pager log --oneline -1

step "4/6 打 tag"
git tag -a "v$VERSION" -m "v$VERSION"
echo "已创建 tag v$VERSION"

if [ "$NO_PUSH" -eq 1 ]; then
  step "5/6 跳过 push（--no-push）"
else
  step "5/6 push"
  # GitHub 的 SSH 时而抽风（Connection reset / closed），重试几次比让人手工补推更省事
  push_retry() {
    local ref="$1" i
    for i in 1 2 3 4 5 6; do
      # 以 git push 的退出码为准：连 ls-remote 判活会在 SSH 抖动时误报失败（实际已推成）
      if git push origin "$ref"; then return 0; fi
      echo "  push 第 $i 次没成功，8 秒后重试…"
      sleep 8
    done
    return 1
  }
  push_retry "$BRANCH" || die "push 分支失败（网络问题？先 git push origin $BRANCH 再重跑本脚本）"
  push_retry "v$VERSION" || die "push tag 失败（网络问题？先 git push origin v$VERSION 再重跑本脚本）"
  echo "已 push $BRANCH 与 tag v$VERSION —— release workflow 会自动建 Release 并推 ghcr 镜像"
fi

if [ "$DO_BUILD" -eq 1 ]; then
  step "6/6 构建镜像 + 滚动升级"
  node tools/codehash.js
  docker compose build panel --build-arg "GIT_SHA=$(git rev-parse --short HEAD)"
  docker tag cf-tunnel-panel:local "cf-tunnel-panel:$VERSION"
  IMG_HASH="$(docker run --rm --entrypoint cat cf-tunnel-panel:local /app/.code-hash)"
  echo "镜像内 code-hash：$IMG_HASH"
  MOUNT_SRC=0 bash tools/rolling-upgrade.sh --apply
  echo
  echo "--- /healthz ---"
  # 滚动升级会把 leader 换到另一色，端口可能是 8090 也可能是 8095 → 两个都探，取有响应的那个
  LIVE=""; RESP=""
  for cand in "$PANEL_PORT" 8090 8095; do
    if out="$(curl -fsS --max-time 4 "http://127.0.0.1:$cand/healthz" 2>/dev/null)" && [ -n "$out" ]; then
      LIVE="$cand"; RESP="$out"; break
    fi
  done
  [ -n "$LIVE" ] || die "滚动升级后没有任何实例在 /healthz 上响应（8080/8090/8095 都试过了）"
  printf '%s' "$RESP" | VERSION="$VERSION" LIVE="$LIVE" python3 -c '
import json, os, sys
d = json.load(sys.stdin)
print("端口", os.environ["LIVE"], {k: d.get(k) for k in ("version", "mode", "code", "imageCode", "drift")})
ver, want = d.get("version"), os.environ["VERSION"]
if ver != want:
    sys.exit("版本号不符：期望 %s，实际 %s" % (want, ver))
if d.get("mode") != "leader":
    sys.exit("新实例没有接管（mode=%s）" % d.get("mode"))
if d.get("drift") is not False:
    sys.exit("drift 为 true：镜像内代码与运行代码不一致")
' || die "部署校验失败（见上一行原因）"
  echo "✅ 部署校验通过"
fi

  # 旧镜像回收：面板镜像每版约 460MB，只留最近 3 个 tag
  if command -v docker >/dev/null 2>&1; then
    OLDIMG=$(docker images --format '{{.Repository}}:{{.Tag}} {{.CreatedAt}}' \
      | grep '^cf-tunnel-panel:' | grep -v ':local' \
      | sort -k2 -r | tail -n +4 | cut -d' ' -f1)
    if [ -n "$OLDIMG" ]; then
      echo "$OLDIMG" | xargs -r docker rmi >/dev/null 2>&1 || true
      echo "已回收旧镜像：$(echo "$OLDIMG" | tr '\n' ' ')"
    fi
  fi

step "完成"
cat <<EOF
接下来可以核对：
  Release : https://github.com/jianghugs/cf-tunnel-panel/releases/tag/v$VERSION
  CI      : curl -sL "https://api.github.com/repos/jianghugs/cf-tunnel-panel/actions/runs?per_page=1" | grep -E '"conclusion"|"name"'
  镜像    : docker pull ghcr.io/jianghugs/cf-tunnel-panel:$VERSION
EOF
