# 多阶段：把官方 cloudflared 二进制搬进来，面板容器内直接 spawn
#
# 两个基础镜像都锁版本（latest 会让构建结果随时间漂移）。
# 国内拉不动/镜像站坏掉时可以覆盖：
#   docker build --build-arg NODE_IMAGE=node:22-bookworm-slim \
#                --build-arg CF_IMAGE=cloudflare/cloudflared:latest \
#                --build-arg NPM_REGISTRY=https://registry.npmjs.org .
# 注意：所有会出现在 FROM 里的 ARG 必须声明在第一个 FROM **之前**（全局作用域）。
# 之前 NODE_IMAGE 写在 cf 阶段里，导致 `FROM ${NODE_IMAGE}` 取到空串 → "base name should not be blank"。
ARG GIT_SHA=dev
ARG CF_IMAGE=cloudflare/cloudflared:2026.10.7
ARG NODE_IMAGE=node:22.23.5-bookworm-slim

FROM ${CF_IMAGE} AS cf

FROM ${NODE_IMAGE}

ARG NPM_REGISTRY=https://registry.npmmirror.com

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tzdata \
 && rm -rf /var/lib/apt/lists/*

# cloudflared 走 Cloudflare 的网络，容器内需要能访问 7844/443 出站
COPY --from=cf /usr/local/bin/cloudflared /usr/local/bin/cloudflared
RUN cloudflared --version

WORKDIR /app
ENV GIT_SHA=${GIT_SHA}
COPY package.json ./
RUN npm config set registry ${NPM_REGISTRY} \
 && npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY tools ./tools
# docs/openapi.json 由 GET /api/openapi 直接对外提供，必须进镜像
COPY docs ./docs
# 宿主机上被编辑器/脚本写成 600 的文件会被 COPY 原样带进来，容器里以 uid 1000 运行就读不了
# （症状：EACCES open /app/src/core/xxx.js → 容器反复重启）。统一放开读权限。
RUN chmod -R a+rX /app
# 把「镜像里这份代码」的指纹写死进镜像；运行时再算一次，不一致就在 /healthz 里报 drift
RUN node tools/codehash.js > .code-hash

ENV TZ=Asia/Shanghai \
    PORT=8090 \
    DATA_DIR=/data \
    CADDY_ADMIN=http://127.0.0.1:20190 \
    CADDY_LISTEN=:8080 \
    CLOUDFLARED_BIN=/usr/local/bin/cloudflared

VOLUME ["/data"]
EXPOSE 8090
# 端口跟着 $PORT 走：滚动升级时面板会在 8090/8091 两个槽位之间来回搬
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -fsS "http://127.0.0.1:${PORT:-8090}/healthz" || exit 1
CMD ["node", "src/server.js"]
