#!/usr/bin/env bash
# 起一个一次性 Caddy，给测试当"边缘"用（不碰生产那份 caddy）
#   ./tools/caddy-test.sh start    # 起：admin 127.0.0.1:20299，监听 :8089
#   ./tools/caddy-test.sh stop     # 删
#   ./tools/caddy-test.sh status   # 看状态
# 用途：让 test/api.test.mjs 里那批"经真 Caddy 取证"的用例（分享/维护/黑名单/护栏/WS）
# 真的有边缘可用，而不是被 SKIP；面板实例把 CADDY_ADMIN 指到这里，测试把 CADDY_EDGE 指向 :8089。
set -euo pipefail

NAME=${NAME:-cfp-caddy-test}
IMAGE=${IMAGE:-caddy:2.11.9-alpine}
ADMIN_PORT=${ADMIN_PORT:-20299}
EDGE_PORT=${EDGE_PORT:-8089}
DIR=${DIR:-/tmp/cfp-caddy-test}

conf() {
  mkdir -p "$DIR"
  cat > "$DIR/caddy.json" <<JSON
{
  "admin": { "listen": "127.0.0.1:${ADMIN_PORT}" },
  "apps": {
    "http": {
      "servers": {
        "srv0": {
          "listen": [":${EDGE_PORT}"],
          "routes": [
            { "handle": [ { "handler": "static_response", "status_code": 200, "body": "cfp-caddy-test" } ] }
          ]
        }
      }
    }
  }
}
JSON
}

wait_admin() {
  for _ in $(seq 1 50); do
    if curl -fsS -m 1 "http://127.0.0.1:${ADMIN_PORT}/config/" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  return 1
}

case "${1:-start}" in
  start)
    conf
    if docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
      echo "已有同名容器，先停：docker rm -f $NAME"; docker rm -f "$NAME" >/dev/null
    fi
    docker run -d --name "$NAME" --network host \
      -v "$DIR/caddy.json:/etc/caddy/caddy.json:ro" \
      "$IMAGE" caddy run --config /etc/caddy/caddy.json >/dev/null
    if wait_admin; then
      echo "✓ 临时 Caddy 就绪：admin 127.0.0.1:${ADMIN_PORT}，边缘 :${EDGE_PORT}（容器 $NAME）"
      curl -s -m 2 "http://127.0.0.1:${EDGE_PORT}/" | head -c 40; echo
    else
      echo "✗ 临时 Caddy 没起来，看日志：docker logs $NAME" >&2
      docker logs --tail 20 "$NAME" >&2 || true
      exit 1
    fi
    ;;
  stop)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    echo "✓ 已删除 $NAME"
    ;;
  status)
    docker ps -a --filter "name=$NAME" --format '{{.Names}}\t{{.Status}}'
    curl -s -o /dev/null -w "admin %{http_code}\n" -m 2 "http://127.0.0.1:${ADMIN_PORT}/config/" || true
    curl -s -o /dev/null -w "edge  %{http_code}\n" -m 2 "http://127.0.0.1:${EDGE_PORT}/" || true
    ;;
  *)
    echo "用法：$0 {start|stop|status}" >&2; exit 2 ;;
esac
