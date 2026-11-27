#!/usr/bin/env bash
# 本地"真 Caddy"端到端：一次性 Caddy + 一次性面板实例（数据是副本），跑 api 套件
#   PANEL_PASS=... ./tools/local-e2e.sh            # api.test.mjs（那 13 条不再 SKIP）
#   PANEL_PASS=... ./tools/local-e2e.sh --e2e      # 再跑一遍 e2e-caddy.mjs
# 特点：CADDY_ADMIN 指临时 Caddy(:20299)，Caddy 监听 :8089，面板在 :8182，
#       state.json 里的上游 8090/8095 会被改指 8182 —— 全程不碰生产。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME=${NAME:-cfp-e2e}
PORT=${PORT:-8182}
DATA=${DATA:-/tmp/cfp-e2e-data}
ADMIN=${CADDY_ADMIN_URL:-http://127.0.0.1:20299}
EDGE=${EDGE:-http://127.0.0.1:8089}
USER_=${PANEL_USER:-admin}
PASS=${PANEL_PASS:?需要 PANEL_PASS（data 副本里是同一个管理员哈希）}
NODE_IMG=${NODE_IMG:-node:22-alpine}
DEPS=${DEPS:-/tmp/jsd}

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== 1/5 起临时 Caddy"
bash "$ROOT/tools/caddy-test.sh" start

echo "== 2/5 准备数据副本（$DATA）"
rm -rf "$DATA"; cp -a "$ROOT/data" "$DATA"; rm -f "$DATA/.leader.json"
PORT="$PORT" python3 - "$DATA/state.json" <<'PY'
import json, os, sys
p = sys.argv[1]
port = os.environ['PORT']
s = json.load(open(p))
s.setdefault('settings', {})['caddyListen'] = ':8089'
n = 0
for r in (s.get('routes') or []):
    up = str(r.get('upstream') or '')
    for old in ('127.0.0.1:8090', '127.0.0.1:8095'):
        if old in up:
            r['upstream'] = up.replace(old, '127.0.0.1:' + port); n += 1; break
s.setdefault('settings', {}).setdefault('security', {})
s['settings']['security']['ipDeny'] = ''
s['settings'].setdefault('maintenance', {})['on'] = False
json.dump(s, open(p, 'w'), ensure_ascii=False, indent=2)
print('   · caddyListen=:8089，改写上游 %d 条，清空黑名单/维护模式' % n)
PY
chown -R 1000:1000 "$DATA"

echo "== 3/5 起面板实例（:$PORT）"
cleanup
docker run -d --name "$NAME" --network host --user 1000:1000 \
  -v "$ROOT:/app" -v "$DEPS:/j:ro" -v "$DATA:/data" \
  -e PORT="$PORT" -e DATA_DIR=/data -e CADDY_ADMIN="$ADMIN" \
  -e CLOUDFLARED_BIN=/bin/false -e NODE_PATH=/j/node_modules \
  -w /app "$NODE_IMG" node src/server.js >/dev/null

for i in $(seq 1 60); do
  H=$(curl -s -m 2 "http://127.0.0.1:$PORT/healthz" || true)
  case "$H" in *'"mode":"leader"'*) ok=1; break;; esac
  sleep 0.5
done
[ "${ok:-0}" = 1 ] || { echo "✗ 面板实例没起来"; docker logs --tail 30 "$NAME"; exit 1; }
echo "   · $(printf '%s' "$H" | head -c 120)"

echo "== 4/5 把配置推给临时 Caddy"
PUSH=$(curl -s -m 15 -u "$USER_:$PASS" -X POST "http://127.0.0.1:$PORT/api/caddy/push")
echo "   · $PUSH"
case "$PUSH" in *'"ok":true'*) ;; *) echo "✗ 下发失败"; exit 1;; esac
curl -s -m 3 "http://127.0.0.1:${EDGE#http://127.0.0.1:}/" >/dev/null 2>&1 || true

echo "== 5/5 api.test.mjs（CADDY_EDGE=$EDGE）"
set +e
PANEL_URL="http://127.0.0.1:$PORT" PANEL_USER="$USER_" PANEL_PASS="$PASS" CADDY_EDGE="$EDGE" \
  bash "$ROOT/tools/node.sh" "$ROOT/test/api.test.mjs" | tail -6
API_RC=${PIPESTATUS[0]}
set -e

if [ "${1:-}" = "--e2e" ]; then
  echo "== 附：e2e-caddy.mjs（CADDY_PORT=8089 / standby 8196）"
  set +e
  PANEL_URL="http://127.0.0.1:$PORT" PANEL_USER="$USER_" PANEL_PASS="$PASS" \
    CADDY_PORT=8089 E2E_STANDBY_PORT=8196 \
    bash "$ROOT/tools/node.sh" "$ROOT/test/e2e-caddy.mjs" | tail -8
  E2E_RC=${PIPESTATUS[0]}
  set -e
fi

echo "== 完成（api 退出码 ${API_RC}${E2E_RC:+，e2e 退出码 $E2E_RC}）"
exit "${API_RC:-1}"
