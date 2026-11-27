# 给接手这个项目的 AI 的说明（AGENTS.md）

> 这是 **cf-tunnel-panel** 的交接入口。先读完本文件，再动代码。
> 人类维护者：jianghugs。仓库：https://github.com/jianghugs/cf-tunnel-panel

## 1. 项目是什么

Cloudflare 隧道 + Caddy 的可视化面板：用一条（或多条）Cloudflare Named Tunnel 把本机服务暴露到公网，
面板负责「隧道出口管理 + 域名/路径分流规则 + 鉴权/限流/维护页 + 审计 + 指标 + 监控 + 一键体检」。

线上实例：https://panel.jianghugs.shop （Grafana 走 https://grafana.jianghugs.shop ）
技术栈：纯 Node.js（无框架、无 ORM、无构建步骤）+ 原生前端（`src/web/pages/*.html` + `src/web/assets/*.js`）+ Caddy admin API + cloudflared 子进程。

## 2. 运行环境（重要）

- 服务器：`root@61.128.209.254 -p 13232`（主机名 `xzx-docker-59`，Ubuntu 24.04，x86_64）
- 项目目录：`/opt/cf-tunnel-panel`（`data/` 里有全部密钥：面板口令哈希、TOTP 种子、CF API token、隧道 token）
- 配置快照仓库：`/opt/cf-tunnel-panel-config`（root crontab 每 15 分钟 `tools/git-snapshot.sh`）
- 端口：面板 blue `:8090` / green `:8095`（同一时刻只有一个 leader），Caddy `127.0.0.1:8080`（admin `127.0.0.1:20190`），
  Grafana `:3000`、Prometheus `:9090`、Alertmanager `:9093`，演示上游 t-site `:8088`、t-adminer `:8082`、t-ttyd `:7682`、mariadb `:3307`
- 注意：`192.168.0.59:8080` 被别的服务占用，所以 **Caddy 只监听 127.0.0.1:8080**（`state.settings.caddyListen`），
  隧道 ingress 指向 `http://127.0.0.1:8080`。

## 3. 起来 / 停下来

```bash
cd /opt/cf-tunnel-panel
docker compose up -d caddy demo                      # Caddy + 演示上游 whoami
docker compose --profile bootstrap up -d panel       # 首次起蓝色槽位
docker compose -f tools/monitoring/docker-compose.yml up -d
docker compose -f tools/test-stack.yml up -d         # 演示服务：nginx/mariadb/adminer/ttyd
```

## 4. 发布（唯一正确姿势）

```bash
cd /opt/cf-tunnel-panel
bash tools/release.sh <ver> --notes-file /tmp/notes-<ver>.md --build --force
```

它会：改 `package.json` → 往 `CHANGELOG.md` 插该版本段（**不要手写，否则脚本会拒绝**）→ `git add -A` 提交 →
打 tag → push（带 6 次重试）→ `--build` 构建镜像 → 滚动升级（blue↔green）→ 断言 `/healthz`。

发布后等 1–2 分钟再查 Release 与 ghcr 短 tag（workflow 有延迟）：

```bash
curl -s https://api.github.com/repos/jianghugs/cf-tunnel-panel/releases/latest | grep tag_name
curl -s https://panel.jianghugs.shop/healthz      # version / mode / code / imageCode / drift
```

`drift:false` 且 `code == imageCode` 才算干净：`code` 是运行中代码的指纹，`imageCode` 是镜像指纹。

## 5. 改代码时的三条路

| 场景 | 做法 | drift |
|---|---|---|
| 线上热修（快） | `docker cp src/… <leader>:/app/src/…` + `docker restart <leader>` | 变 true |
| 正式发布 | `tools/release.sh … --build`（推荐） | false |
| 本地开发 | `MOUNT_SRC=1` 挂工作区进容器 | true |

**容器真正入口是 `/app/src/server.js`**（`package.json` 的 `main`）—— cp 到 `/app/server.js` 完全无效。
部署前先确认哪一色是 leader：

```bash
for p in 8090 8095; do curl -s -m 3 http://127.0.0.1:$p/healthz | grep -q '"mode":"leader"' && echo "leader=$p"; done
```

## 6. 不变量（破坏它们会出线上事故）

1. `state.json` / Caddy 配置下发 / cloudflared 进程 **只能有一个属主**：第二实例是只读 standby，写请求返回 409 `STANDBY`。
2. 跨实例共享的东西一律以 `DATA_DIR` 磁盘为事实源（sessions、state mtime 重载、history、selfcheck 留痕）。
3. 槽位上游用 `round_robin` + 主动健康检查，**不要 `first`**（实测会反复重试死上游、切主窗口 3–5s）。
4. 健康检查只在对端真的在线时下发（对端不在监听就只写自己），否则日志被 `connection refused` 刷爆。
5. 规则里 `path:'/'` 的条会吃掉同域名其余路径 → 有 `src/core/guard.js` 遮蔽检测，`POST /api/routes?force` 才能放行。
6. 一条 Named Tunnel **只给一台机器用**：多连接器会让 Cloudflare 随机分流（曾导致 1/3 请求落到别的机器的 frp 上）。
7. `state.json` 不存在时拒绝首次 push（`PANEL_ALLOW_FRESH_PUSH=1` 才放）。
8. 审计只统计 mutating；测试请求必须带 `x-cfp-test: 1`，否则会把「变更趋势」刷成上万的假数字。
9. 长模板函数（`src/core/web.js` 的 `loginPage()` / `pageShell()`）**整函数替换**，不要锚点局部拼接（曾把文件切坏 500）。
10. 渲染函数里 `const` 别写在 `try` 块内再在块外引用（曾 `ReferenceError: r is not defined` 整块 UI 白）。

## 7. 测试（三套）

```bash
# API（会先快照你当前的规则/设置，跑完还原；务必带 x-cfp-test）
PANEL_URL=http://127.0.0.1:8090 PANEL_PASS=<面板口令> node test/api.test.mjs

# 前端（jsdom，需要 puppeteer 之外的东西？不需要，但要有 jsdom）
NODE_PATH=/tmp/jsd/node_modules node test/dom.test.cjs

# 真 Caddy 端到端（会写真生产配置！先读下面「第三套的真相」）
node test/e2e-caddy.mjs
```

**宿主机没有 node 时用 docker 跑**（本机即如此：`node`/`npm`/`caddy` 都没有，`/tmp/jsd` 里的依赖也会丢）：

```bash
# 依赖装一次（bcryptjs/qrcode 是运行时依赖，缺了 API 测试会挂 5 条 MODULE_NOT_FOUND）
docker run --rm -v /tmp/jsd:/j -w /j node:22-alpine sh -c 'echo "{\"name\":\"jsd\",\"private\":true}" > package.json && npm i bcryptjs qrcode jsdom@31'

# API：--network host 必须（测试要连 127.0.0.1:8090）
docker run --rm --network host -v "$PWD":/w -v /tmp/jsd:/j -w /w \
  -e NODE_PATH=/j/node_modules -e PANEL_URL=http://127.0.0.1:8090 -e PANEL_PASS='<面板口令>' \
  node:22-alpine node test/api.test.mjs

# DOM：同样要 --network host；漏掉 PANEL_PASS 会停在登录页，harness 空指针直接崩
docker run --rm --network host -v "$PWD":/w -v /tmp/jsd:/j -w /w \
  -e NODE_PATH=/j/node_modules -e PANEL_PASS='<面板口令>' \
  node:22-alpine node test/dom.test.cjs
```

基线（2026-11-26，v0.29.39）：API 367/367、DOM 236/236、e2e 39/39。另有两条不依赖面板的静态自检：`npm run test:i18n`（字典重复键/空译文）与 `npm run test:openapi`（代码里的 /api 路由必须都在 docs/openapi.json 里，改了接口记得 `node tools/openapi.js --gen`）。

**第三套 `e2e-caddy.mjs` 的真相**（原来这里写「起临时 Caddy :8180 / admin :20290，不碰生产」，是错的）：脚本里没有任何 `spawn caddy`，它用 basic auth 直连本机 leader 面板，`POST /api/routes` 把 6 条探针规则（`e2e-strip` / `e2e-keep` / `e2e-auth` / `e2e-hostA` / `e2e-hostB` / `e2e-ws`，upstream 指向脚本自起的本地 HTTP+WS 服务）**塞进线上规则表**，由面板推给线上 Caddy（127.0.0.1:20190）；同时临时打开「维护模式」、把 `127.0.0.1/32` 拉进 IP 黑名单。快照落在 `/tmp/e2e-routes-<pid>.json`，`finally` 里还原。**跑完要自己复核一遍**：规则条数与跑前一致、`maintenance.on=false`、`ipDeny` 为空。

三个必踩的坑：

- `CADDY_PORT` 必须等于**线上 Caddy 的监听口 8080**（不是随便挑个空闲口）；
- `E2E_STANDBY_PORT` 默认 8096 常被别的进程占用，换一个（如 8196）；
- 第二实例要读到 leader 的租约：容器里跑必须把真 `data` 挂进 `/data`（脚本从 `/api/system` 取到的 `dataDir` 是**容器内路径** `/data`），否则第二实例用空目录起、直接自己当 leader，standby 那几条断言全挂。

```bash
docker run --rm --network host -v "$PWD":/w -v "$PWD/data":/data -v /tmp/jsd:/j -w /w \
  -e NODE_PATH=/j/node_modules -e PANEL_URL=http://127.0.0.1:8090 -e PANEL_PASS='<面板口令>' \
  -e CADDY_PORT=8080 -e E2E_STANDBY_PORT=8196 \
  node:22-alpine node test/e2e-caddy.mjs
```

已知假失败模式：改完代码刚重启时，固定 `sleep` 等待会抖 → 用 `waitFor(fn, 8000)`（`test/dom.test.cjs` 里已有）。
`jsdom` 的 `localStorage` 每次 `open()` 都是新的，别指望跨「刷新」保留状态。

验「未命中 → 404」别用 fetch 直打 `127.0.0.1:8080`：本部署有一条 `host=127.0.0.1 path=/` 的兜底规则（带 basicAuth），任何路径都会被它接住变成 401。要换一个没有任何规则匹配的 Host（`e2e-caddy.mjs` 已改成 `rawGet(path, 'e2e-no-rule.example.test')`）。

## 8. 排障速查

| 现象 | 先看什么 |
|---|---|
| 页面样式全丢 / 404 页面来自别的服务 | `curl -sI https://panel.jianghugs.shop/login` 看有没有 `via: 1.1 Caddy`；再看 `GET /accounts/<acc>/cfd_tunnel/<tid>/connections` 有没有多余连接器 |
| 502 / 530 | **先 `ss -ltnp \| grep 8080` 确认只有一个 caddy**（两个 = SO_REUSEPORT 抢端口，见下方小节）；再看 `docker logs cf-tunnel-caddy --tail 50`；`curl -s -u admin:<pass> http://127.0.0.1:8090/api/routes` 看上游端口 |
| 面板打不开但容器在 | `curl -s http://127.0.0.1:8090/healthz`；两色 leader 判断（见上） |
| 体检红项 | 面板「监控 → 一键体检」跑 14 项，每项带「怎么办」；或 `curl -s -u admin:<pass> 'http://127.0.0.1:8090/api/selfcheck?scope=quick'` |
| 隧道重连多 | 出口卡有 `重连 ×N` 徽标；体检 `出口链路稳定性` 项；必要时把协议从 `auto` 改 `http2` |

### 公网 502、本地却是 200

症状：`curl -sI https://panel.jianghugs.shop/healthz` 返回 502，但
`curl -s -H 'Host: panel.jianghugs.shop' http://127.0.0.1:8080/healthz` 是 200 —— 或者反过来，
连着打几次，200 和 502 交替出现。

先看谁在听 8080：

```bash
ss -ltnp | grep 8080
```

正常只有一条（`cf-tunnel-caddy` 容器里的 caddy，pid 形如 531480）。如果看到**两条 caddy**
抢同一个 `127.0.0.1:8080`，就是 SO_REUSEPORT：两个进程都在 accept，其中挂着旧配置的那个会把
`panel.jianghugs.shop` 指向已经停掉的旧颜色端口（例如滚动升级后 8090 已经没了），于是公网随机 502。

处理：把非生产那个 `docker rm -f` 掉（本地调试用的 `caddy-test`、预览实例自带的临时 Caddy 都算）。
**别在 8080 上起自己的测试 Caddy** —— 调试一律用 8089 / 20299 这类高位端口。

教训：这次是排查 pusher 竞态时起的 `caddy-test` 忘了收，导致 0.29.42 上线后公网随机 502，
排查了半天配置，实际是端口被抢。

## 9. 提交 / 协作约定

- 直接提交到 `main`，提交信息中文，形如 `feat(规则): …` / `fix(隧道): …` / `docs: …` / `release: v0.29.40`。
- 每次发版必须同步 `CHANGELOG.md`（脚本插）、`README.md` 与 `README.zh-CN.md`（各加一节 highlights）、`docs/ROADMAP.md`（加 ✅ 段）。
- 中英双语：面板自带 i18n（`src/core/i18n.js`），新增中文文案要同时给英文（英文页残留中文会被 `test/dom.test.cjs` 的覆盖率断言盯上）。

## 10. 想更深入了解

- `HANDOVER.md` —— 14 节完整交接文档（架构、目录地图、DATA_DIR 布局、发版六个坑、本机约束、第一组命令）
- `docs/CLOUDFLARE-TUNNEL.md` —— 怎么申请隧道、token 从哪来、1033/530 怎么解、多连接器事故复盘
- `docs/PROMETHEUS-GRAFANA.md` —— 监控栈与告警规则
- 面板「设置 → 怎么申请隧道」有同样的步骤卡片
