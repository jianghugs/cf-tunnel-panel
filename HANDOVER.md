# 交接文档 · cf-tunnel-panel

> 这份文档写给「刚接手、还没跑过任何命令」的人。
> 版本号故意不写死 —— 永远看 `package.json` 的 `version` 或 `curl /healthz` 的 `version` 字段。
> 规范以 `AGENTS.md` 为准（它随代码走、由维护者维护）；本文负责「把事情讲明白」。
> 最后整体校验时间：2026-11 下旬，与代码同仓库。

---

## 0. 三条先看

1. **`data/state.json` 里有全部密钥（隧道 token、Cloudflare API token、面板口令哈希），绝对不要手改**。改配置走面板 API / 界面，改完它会自己落盘。
2. **一条 Named Tunnel 只能给一台机器用**。同一个 token 起两个连接器 = 两处抢流量，面板会把 `/connections` 里多出来的连接器标出来，看到就报告，别自己删。
3. **`docker cp` 进容器不等于发布**。判断「线上到底跑的哪份代码」只看 `/healthz` 的 `code` 与 `imageCode` 是否相等、`drift` 是否 `false`。

---

## 1. 项目是什么

一个自托管的 Cloudflare Tunnel 控制面板：把家里的服务通过 Cloudflare 隧道安全暴露到公网，并提供规则分流、基础认证、访问统计、健康巡检、滚动升级。

- 三个运行时角色：**panel**（Node 服务 + Web 界面）、**caddy**（真正的流量入口）、**cloudflared**（隧道连接器，由 panel 进程拉起/管理）。
- 面板自己也是入口之一：`panel.<域名>` → Caddy → 当前 leader 槽位。
- 蓝绿双槽：`8090`（blue）/ `8095`（green），同一时刻只有一个 instance 是 leader，另一个是只读备份（写操作返回 `409 STANDBY`）。
- 单一属主靠 `DATA_DIR/.leader.json` 租约（TTL 15s，5s 续一次），不靠 pid。

---

## 2. 拿到代码、把服务跑起来

### 2.1 拉代码

```bash
cd /opt/cf-tunnel-panel
git pull --ff-only
```

### 2.2 起服务

生产环境三容器（全部 host 网络）：

```bash
docker compose up -d                    # caddy + demo（日常）
docker compose --profile bootstrap up -d panel   # 首次/重建 panel 才需要
```

- panel 走 `profiles: ["bootstrap"]`，所以**日常 `docker compose up -d` 不会重建它** —— 升级 panel 请用 `tools/rolling-upgrade.sh`。
- panel 容器跑在 `1000:1000`，并 `group_add` 到宿主 docker 组（gid 见 `DOCKER_GID`，默认 989），否则「本机容器」页读不到 docker。

### 2.3 必须知道的环境变量

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `PORT` | 本实例监听端口 | `8090` |
| `DATA_DIR` | 运行时数据目录（state/备份/日志/租约） | 容器内 `/data` |
| `CADDY_ADMIN` | Caddy admin API | `http://127.0.0.1:20190` |
| `CADDY_LISTEN` | 生成给 Caddy 的监听地址 | `127.0.0.1:8080` |
| `PANEL_SLOT_PEERS` | 对端槽位端口 | `8095` |
| `PANEL_INSTANCE` | 实例名（写进 `/healthz`） | 自动 |
| `CLOUDFLARED_BIN` | cloudflared 路径 | 镜像自带 |
| `NODE_OPTIONS` | 见 §10「IPv6 陷阱」 | `--dns-result-order=ipv4first` |

---

## 3. 目录地图

```
src/
  server.js            HTTP 入口 + 鉴权门 + /api/* 模块调度（约 780 行）
  http/
    onreq.js           请求入口：探针判定、限流、审计（x-cfp-test 不记审计）
    static.js          静态资源分发（带 ?v= 指纹走一年 immutable 缓存）
    boot.js            /boot.js：首帧主题 + 客户端语言字典
  routes/              按子系统拆分的 /api 路由；每个模块导出 handle(p, req, res, url)，
                       未命中返回 false，server.js 里对 /api/* 依次调用并短路
    authroutes.js      会话、运维账号、TOTP、面板登录、二维码
    rules.js           代理规则增删改、rules/test、match、caddy/{config,push}
    shares.js          一次性分享链接
    cf.js              Cloudflare：隧道、DNS、缓存、预览
    backups.js         备份与回滚
    monitor.js         一键体检、监控状态、告警静默
    observe.js         traffic / history / audit / logs / 各类统计
    settings.js        设置、导出导入、配置即代码
    ops.js             CSV 导出、IP 黑名单、bench
  core/
    web.js             页面外壳 + 静态资源（ETag/gzip/长缓存）+ 登录页模板
    i18n.js            中文原文 → 英文 字典（分版本多段 Object.assign 合并）
    state.js           state.json 读写、口令、审计
    lease.js           蓝绿 leader 租约
    caddy.js           把 state 渲染成 Caddy 配置（buildCaddyConfig）并下发
    pusher.js          下发调度（单飞串行，见 §5.3）
    tunnels.js         cloudflared 进程管理、隧道健康
    probe.js           上游/端口探测
    selfcheck.js       一键体检 14 项
    httpv4.js          强制 IPv4 的 HTTP 客户端（见 §10）
    guard.js           规则遮蔽检测（path:'/' 吃掉其它路径）
    monitor.js         Prometheus / Grafana 集成
    integrations.js    Cloudflare API（建隧道、DNS、缓存）
    notify.js          掉线通知
    insight.js         访问统计 / 审计汇总
  web/
    pages/*.html       7 个页面壳（overview/rules/tunnels/observe/tools/monitor/settings）
    assets/app.css     设计系统（令牌 + 组件，全部样式在这里）
    assets/*.js        每页一个脚本 + app.js（公共工具/命令面板/主题/翻译）
tools/
  release.sh           一条命令发版（见 §8）
  rolling-upgrade.sh   蓝绿滚动升级
  codehash.js          代码指纹（src + package.json 的 SHA1 前 16 位）
  i18n-check.js        i18n 字典自检（见 §7）
  git-snapshot.sh      每 15 分钟自动快照提交（cron）
  monitoring/          Prometheus / Alertmanager / Grafana 配置
test/                  api / dom / e2e / i18n 四套
```

---

## 4. 运行时数据布局（`DATA_DIR`）

| 路径 | 内容 | 注意 |
| --- | --- | --- |
| `state.json` | 全部配置 + 密钥（0660） | **不要手改**，走 API |
| `.leader.json` | 租约（端口 + 心跳时间戳） | 删掉＝让这个实例重新竞选 |
| `backups/` | 改配置前的自动快照（保留 N 份） | 回滚入口在设置页 |
| `history/` | 指标/流量采样 | 只读 |
| `audit/` | 审计日志（只记 mutating 操作） | 测试请求带 `x-cfp-test: 1` 不计入 |
| `logs/` | 面板自身日志 + `git-snapshot.log` | logrotate 已配 |
| `caddy-logs/` | Caddy access log（10MB × 3 自动轮转） | 已按大小轮转，无按天策略 |
| `config/` | 每次下发的 Caddy 配置快照（gzip） | 排查「当时下发了什么」看最新的那个 |

---

## 5. 不变量与禁区（都是踩过的坑）

### 5.1 属性与所有权
- 跨实例共享一律**以 `DATA_DIR` 磁盘为事实源**，不要在进程内存里缓存可变配置。
- 只有一个 leader 能写；备份实例必须返回 `409 STANDBY`，并把 leader 名字写进响应。

### 5.2 规则与 Caddy
- **`path: '/'` 会吃掉同域名下其余路径**。`guard.js` 会检测遮蔽；确实需要时 `POST /api/routes?force` 才放行。
- 槽位上游用 `round_robin` + 主动健康检查；**禁用 `first`**（会把流量全压在挂掉那台上）。
- 健康检查只在对端在线时下发，否则备份槽位会被误判。

### 5.3 配置下发：单飞（这是 2026-11 修过的真 bug）
`pusher.js` 里任何时刻只允许一条 `POST /load` 在飞。历史故障：建分享 + 设维护同时下发，先发后到的那份把维护路由冲掉 → 维护模式失效。
现在的实现是 `running` + `dirty` 双标记：飞行途中的改动只补推一次，且补推会重新 `buildCaddyConfig()` 拿最新状态。

### 5.4 Caddy 配置字段：改之前先在真 Caddy 上试
`POST /load` 失败**会连带停掉既有 server** → 全站 502。历史故障：给 file writer 加了 Caddy 2.11.9 不认识的 `roll_keep_for`，一次发版把站点打挂。
规矩：任何新字段先对着测试 Caddy（独立端口 + 独立 admin）试一次 `/load`，再进发版。

### 5.5 测试请求与审计
- 所有 mutating 请求都会被审计；测试脚本必须带 `x-cfp-test: 1`，否则污染统计。

---

## 6. 改代码的三种循环（挑最轻的）

1. **只改前端静态资源**（`src/web/**`）：改完刷新页面即可，但注意浏览器缓存 —— `app.css` 走 ETag，指纹变了才会重新下载。
2. **改服务端逻辑**：改仓库文件**不影响**运行中的容器（镜像里是烘死的代码）。要生效必须发版或滚动升级；想先看效果，用「预览实例」：复制仓库到 `/tmp/cfp-preview`，用 `node:22-alpine` 起在别的端口、`DATA_DIR` 指向**数据副本**、`CADDY_ADMIN` 指向死端口（避免误改生产 Caddy）。
3. **改 Caddy 配置生成**：额外一步 —— 先在测试 Caddy 上验 `/load`（见 §5.4），再走预览实例。

---

## 7. 测试

宿主机**没有 node**（见 §10），所以三套都通过 docker 跑；依赖装在 `/tmp/jsd`。

```bash
# 0) 一次性准备依赖
docker run --rm -v /tmp/jsd:/j -w /j node:22-alpine npm i bcryptjs qrcode jsdom@31

# 1) 服务端接口（对着 leader 跑；脚本自带快照与还原）
docker run --rm --network host -v "$PWD":/w -v /tmp/jsd:/j:ro -w /w \
  -e NODE_PATH=/j/node_modules -e PANEL_URL=http://127.0.0.1:8090 -e PANEL_PASS='<口令>' \
  node:22-alpine node test/api.test.mjs
#   经 Caddy 取证那几条默认打 127.0.0.1:8080，可用 CADDY_EDGE 覆盖

# 2) 前端 DOM（需要 jsdom；注意 PANEL_PROXY_PORT 别撞车）
docker run --rm --network host -v "$PWD":/w -v /tmp/jsd:/j:ro -w /w \
  -e NODE_PATH=/j/node_modules -e PANEL_URL=http://127.0.0.1:8080 -e PANEL_PASS='<口令>' \
  -e PANEL_PROXY_PORT=8199 node:22-alpine node test/dom.test.cjs

# 3) 真 Caddy 端到端（会写**真生产配置**：6 条探针规则 + 维护模式 + IP 黑名单，自带快照还原）
docker run --rm --network host -v "$PWD":/w -v "$PWD/data":/data -v /tmp/jsd:/j:ro -w /w \
  -e NODE_PATH=/j/node_modules -e PANEL_URL=http://127.0.0.1:8090 -e PANEL_PASS='<口令>' \
  -e CADDY_PORT=8080 -e E2E_STANDBY_PORT=8196 \
  node:22-alpine node test/e2e-caddy.mjs

# 4) i18n 字典自检（纯静态，最快）
docker run --rm -v "$PWD":/w -w /w node:22-alpine node tools/i18n-check.js
```

`npm test` 串起来跑 4→1→2。已知「假失败」：重启后固定 `sleep` 会抖（用 `waitFor`）、jsdom 每次 `open()` 都是新的 localStorage。

---

## 8. 发版（一条命令）

```bash
# 1) 先把 Release 说明写好（markdown 列表，会被插进 CHANGELOG + GitHub Release）
cat > /tmp/notes.md <<'EOF'
- 一句话说清这版改了什么
- 验证：API x/y、DOM x/y、/api/selfcheck x/14
EOF

# 2) 发版（自动改 package.json → 插 CHANGELOG → commit → tag → push → 构建镜像 → 滚动升级 → 校验 /healthz）
bash tools/release.sh <版本号> --notes-file /tmp/notes.md --build --force
```

脚本会做 6 步。宿主机没有 node 也不影响：release.sh 自己会用 tools/node.sh 把 node 调用丢进容器（见 §10）。
现在发版还会顺带验两条路：经 Caddy 打 8080（Host 头）与公网 https://$PANEL_HOST，
公网不通会直接报错退出（查 cloudflared 是否在线、8080 上是不是只有生产 Caddy）。
升级完成后一定要确认：`/healthz` 的 `version` 是新的、`code == imageCode`、`drift == false`、`tunnels` 全是 running。

---

## 9. CI 与仓库

- GitHub Actions：`release`（tag 触发，发 Release）+ `sync-release-notes`（CHANGELOG 回写）。
- 每 15 分钟 `tools/git-snapshot.sh` 自动提交一次快照，日志在 `data/logs/git-snapshot.log`。
- `codehash.js` 对 `src/**` + `package.json` 算 SHA1 前 16 位；镜像构建时写进 `/app/.code-hash`，运行期再算一次比对 → `/healthz` 的 `drift`。

---

## 10. 本机环境（重要约束）

- **宿主机没有 node/npm**，所有 node 命令都走仓库里的 `tools/node.sh`：有本机 node 就用本机的，
  没有就丢给 `node:22-alpine` 容器（容器里保持同一绝对路径，所以脚本里的相对路径与 `require` 照旧可用）。

  ```bash
  tools/node.sh -p 'process.version'
  tools/node.sh tools/codehash.js
  ```

  `tools/release.sh` 已经自己接上了（宿主没 node 时内部包一层），发版命令不用变，也不需要再手工
  `PATH=/tmp/nodebin:$PATH`。**不要再手造 `/tmp` 里的 shim**：重启即丢，换个环境就忘。

- **Docker Hub 直连不可用**（`registry-1.docker.io` 只回 IPv6，本机无 v6 出口；daemon.json 里配的镜像源已全部失效）。
  构建前先走可达的镜像站把基础镜像拉下来本地打 tag：

  ```bash
  docker pull docker.m.daocloud.io/library/node:22.23.5-bookworm-slim
  docker tag  docker.m.daocloud.io/library/node:22.23.5-bookworm-slim node:22.23.5-bookworm-slim
  docker pull docker.m.daocloud.io/cloudflare/cloudflared:2026.10.7
  docker tag  docker.m.daocloud.io/cloudflare/cloudflared:2026.10.7 cloudflare/cloudflared:2026.10.7
  ```

- **IPv6 陷阱**：本机与容器都只有 v4 出口，但 DNS 会同时返回 AAAA。Node 自带的 `fetch`（undici）与 `net.connect` 遇到「AAAA 先回、v6 不通」会一直等到超时，而 curl 走 happy-eyeballs 会自动回落。
  现象是「curl 好好的，Node 报 fetch failed / ETIMEDOUT」。解法是 `src/core/httpv4.js` 的 `getV4()`：先 `dns.lookup(..., {family:4})` 再按 IP 连、`servername` 保 SNI、`headers.host` 保留域名。所有面向公网的探测都走它，别直接 `fetch`。

---

## 11. 排障速查

| 现象 | 先看这里 |
| --- | --- |
| 公网 502，本地 `curl` 正常 | `ss -ltnp \| grep 8080` —— 出现两条 caddy 就是 **SO_REUSEPORT 抢端口**（调试实例忘了关），`docker rm -f` 掉非生产那个 |
| `/healthz` 的 `drift: true` | 运行中的容器代码 ≠ 仓库代码。镜像没重建，或 `docker cp` 骗自己了 |
| 写操作返回 409 STANDBY | 这个实例是备份。看 `409` 响应里的 `leader` 字段，或删掉 `DATA_DIR/.leader.json` 让它重新竞选 |
| 规则改了但没生效 | `data/config/` 最新快照 vs `POST /api/caddy/push` 的返回；`routeCount` 不变说明根本没下发 |
| 一键体检某条一直黄 | 先用 `curl` 试同一个 URL；curl 通而 Node 不通 → IPv6 陷阱（§10） |
| 隧道显示 running 但公网 404 | Caddy 里没有匹配的规则；看 `guard.js` 的遮蔽告警 |
| 首页空白 / 样式全丢 | 浏览器缓存了旧 `app.css`；或 CSP 拦了新加的内联脚本（DOM 测试有一条专查这个） |
| 本机容器页读不到 docker | 挂载在，但容器没进 docker 组（`group_add`）；升级一次才生效 |

---

## 12. 交接时的状态与下一步

- 当前状态：绿/蓝双槽正常，`/api/selfcheck` 14/14，公网入口与两条隧道均正常。具体版本号看 `/healthz`。
- 值得继续做的事（按价值排序）：
  1. `src/routes/*.js` 的模块头是从 `cf.js` 复制的 require 段，新增模块一定要逐文件自查 ——
     漏 `net` / `dns` / `http` / `crypto` / `fs` / `path` 只会**运行期**报错（`node --check` 查不出来），
     发版后必须跑一遍 `test/api.test.mjs` 才能发现。可以考虑在 CI 里加一条「模块 require 自检」；
  2. 隧道 CRUD 那一簇仍留在 `src/server.js`：`/api/tunnels/<id>` 的正则块夹在 `start-all` 与
     `/api/operator` 之间，把 `start-all` 挪进调度链会被这条正则先吃掉（`id='start-all'`）。要拆得先调整匹配顺序；
  3. Caddy access log 本身只有**按大小**滚动（file writer 无按天能力），旧归档靠 `tools/prune-logs.sh` + cron 每天删 7 天前的 `.gz`；
  4. `dom.test.cjs` 里还有几处依赖固定 `sleep` 的用例，可以统一换成 `waitFor`；
  5. 面板自己的能力接口已有 OpenAPI（`docs/openapi.json`，线上 `GET /api/openapi`），改接口记得
     `node tools/openapi.js --gen`，否则 `npm run test:openapi` 会挡下来。

- **Caddy 旧归档由 cron 清理**：`tools/prune-logs.sh`（默认删 7 天前的 `data/caddy-logs/*.gz`，`KEEP_DAYS` 可调、`--dry` 可预览），crontab 每天 04:17 跑，日志写 `data/logs/prune.log`。Caddy 自身只有按大小滚动（`roll_size_mb` / `roll_keep`），按天保留做不到（`roll_keep_for` 不被 2.11.9 识别，v0.29.46 试过并因此把整站打成 502）。
- **i18n 覆盖漂移 53 条：定为不改**。都是同一句中文在 v0.14 与 v0.29 两批翻译里的措辞差异（如 `Caddy 分流` = routing / dispatch），运行时按 `Object.assign` 顺序取最后一段，所以英文界面只会看到一种译法、不会混中文；`tools/i18n-check.js` 只把它当 warn。真要统一得逐条改译文，收益低。