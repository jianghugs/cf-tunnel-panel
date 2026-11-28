# Changelog

按日期倒序。功能细节与实测数据见 [docs/ROADMAP.md](docs/ROADMAP.md)。

## v0.29.67

# v0.29.67 发布说明

## 本轮内容（A 组全做 + B 组 4/5/7）

- **A1 404 文案**：去掉写死的内网地址（原「请打开面板 http://<本机IP>:8090 添加规则」），改成「请打开面板，添加一条匹配这条路径的规则」；线上 404 文案已走面板 API 同步更新。
- **A2 规则名 tooltip**：规则名输入框加 `title`，长名字不再只能看截断。
- **A3 测试提速**：`test/e2e-caddy.mjs` 把 6 处固定 sleep 改成轮询（维护/黑名单用 untilStatus、跨实例同步用 waitFor），全套 22s → 4.8s，36/36 通过。
- **B4 规则级限流**：每条规则可单独设每秒请求上限（rps/burst），生成 Caddy 配置时在规则 handle 前插 rate_limit（需 CADDY_RATELIMIT=1 的自定义镜像）。
- **B5 路径重写**：规则可把 `/api/v1/*` 前缀重写成 `/v2/*`（path_regexp + rewrite，与 strip 二选一）。
- **B7 证书到期体检**：监控页新增「证书到期」卡，从 Cloudflare 拉当前 zone 边缘证书；<14 天红、<30 天黄、Universal SSL 显示「自动续期」。

## 验证

- `bash tools/check.sh` 全绿：i18n（重复键 0 / 空译文 0 / 未收录 0）、OpenAPI（97 路径 / 104 操作）、告警规则副本一致、ESLint。
- `test/dom.test.cjs` **236/236**；`test/smoke.mjs` **91/91**；`test/e2e-caddy.mjs` **36/36**（本地真 Caddy）。
- 生产 API 回归 367/367（发布后随 rolling-upgrade 复跑）。
- 证书接口实测：`/api/cf/certs` 返回 zone 的两条 Universal SSL（active + backup_issued）；Cloudflare 的 certificate_packs 不暴露 Universal SSL 到期日，故「剩余」列显示「自动续期」，自定义/高级证书才有具体天数。

## v0.29.66

# v0.29.66 — 功能与实用性优化（五项）

一轮把工具箱/观测/规则/监控/分享五个方向的实用性补齐，每项独立提交：

## ① 域名体检 / 排障向导（`a2d494c`）
- 新增 `GET /api/diag?host=&path=&public=1`：一条链路查「规则命中 → 隧道出口 → 经本机 Caddy → 上游服务 → 公网经 Cloudflare → 拦截策略」六段，逐段给状态/耗时/详情，末尾给出 verdict。
- 工具箱页新增「域名体检」卡，支持深链 `/tools?host=demo.jianghugs.shop&path=/demo` 预填并自动跑。
- 三坑已修：undici fetch 不允许改 Host（改用 `http.request` 带 Host）；`simulateMatch` 返回键是 `rule` 不是 `route`、`basicAuth` 是布尔；smoke 的 data 目录须 chown 1000:1000。

## ② 规则批量操作（`5e50c03`）
- 规则页每条加勾选框，批量栏支持：启用 / 停用 / 删除 / 改上游 / 换出口 / 全选 / 清除。
- 只改内存标脏，由「保存规则」统一落盘，与既有流程一致。

## ③ 访问统计下钻（`d19a3fd`）
- 新增 `GET /api/drill`（rule / host / status / hours 四类过滤），聚合小时曲线 + Top 路径 + 最近 20 条原始日志。
- 观测页：状态码 tag、Top 域名、规则行「下钻」按钮均可点，打开下钻卡（迷你柱条 + 路径榜 + 明细表）。

## ④ 上游健康看板（`0008eb1`）
- `insight.js` 加 24h 环形历史缓冲（`upstreamHist`，60s 一个点）。
- 新增 `GET /api/upstream/health`：每条上游的当前状态 + 24h 可用率 / 平均 / P95 + 历史。
- 监控页新增「上游健康」卡（状态点 + 三个指标 + 96 根迷你柱条）。

## ⑤ 分享链接二维码 + 倒计时（`65f295e`）
- `GET/POST /api/shares` 现返回二维码（服务端 `qrcode` 包生成 data URL，220px）。
- 工具箱分享列表改成卡片：二维码 + 大号「复制链接」+ 秒级倒计时（`剩余 mm:ss` / `hh:mm:ss`，到期显「已过期」）。

## 验证
- `bash tools/check.sh` 全绿（i18n 重复键 0 / 空译文 0 / 未收录 0；openapi 96 路径 103 操作全覆盖；alerts；eslint）。
- `test/smoke.mjs` 91/91；`test/dom.test.cjs` 236/236。
- 浏览器实测（puppeteer）：下钻卡渲染、批量栏开合、二维码 img 与倒计时文本均正常，无 console/page error。
- API 367/367 基线不变。

## v0.29.65

### 新增
- 面板能看 **Caddy 自身日志**了。0.29.64 把 Caddy 的启动/admin/证书日志拆去 caddy.log 之后，界面上就再也看不到它们；这次补回：观测页新增「Caddy 自身日志」卡片，默认折叠，可切 100/200/500 行，可只看错误级别。
- 新接口 `GET /api/caddy/log?n=200&onlyError=1`：读文件尾部（默认 512KB，上限 2MB），逐行解析成时间/级别/logger/消息；文件不存在时给「还没有 caddy.log —— Caddy 大概刚启动」而不是报错。

### 修复
- `src/core/paths.js` 新增 `CADDY_OWN_LOG_FILE`（`DATA_DIR/caddy-logs/caddy.log`）。`otherLogPathForCaddy()` 是给 Caddy 配置用的（容器内 `/logs` 视角），面板容器里没有 `/logs`，直接读会永远 `exists:false`——第一版就踩了这个坑。

### 验证
- `tools/check.sh` 五项全绿（require 自检 / i18n 未收录 0 / openapi 93 路径 100 操作 / 告警副本一致 / ESLint）
- 预览实例：`/api/caddy/log?n=4` 返回真实行（文件 613133 字节）；`/api/caddy/log?onlyError=1` 返回空 + 无错误提示（当前 caddy.log 只有 info）
- 生产 leader 8095：`test/api.test.mjs` 367/367

## v0.29.64

## Caddy 日志拆成两个文件：access.log 只留访问日志

之前 `logging.logs.default` 一个文件接所有日志，`access.log` 里混着三成 `admin.api` 与 `tls` 行 —— 其中 `admin.api` 每 10 秒两条，来自面板自己给 Caddy 加的 healthcheck（`wget http://127.0.0.1:20190/config/`）。后果是：10MB 滚动、`roll_keep:3` 的配额被噪声吃掉三分之一，真实访问历史跟着缩水；面板做「最近请求 / 命中哪条规则 / 错误率」统计时还要逐行 `JSON.parse` 再丢掉这些行。

### 改动
- `src/core/paths.js`：新增 `otherLogPathForCaddy()` → `<CADDY_LOG_DIR>/caddy.log`。
- `src/core/caddy.js` 的 `buildCaddyConfig()`：日志拆两个 logger ——
  - `access`：`include: ["http.log.access"]`、写 `/logs/access.log`、`roll_size_mb:10 / roll_keep:3`（与原来一致，面板统计读这个文件，路径没变）；
  - `default`：`exclude: ["http.log.access"]`、写 `/logs/caddy.log`、`roll_size_mb:5 / roll_keep:2`（admin.api、tls、启动信息都在这）。

### 上线前的验证（吸取 v0.29.46 的教训：Caddy 配置错字段会连带停服）
1. 一次性 Caddy 容器验证配置形状：`access.log` 只有 `{"logger":"http.log.access"...}`，`caddy.log` 里是 `admin.api` / `http` / 启动行，两文件都正常生成。
2. 临时面板实例 + 一次性 Caddy（admin 20299、业务 8089、`/logs` 挂临时目录）真跑一次 `POST /api/caddy/push` → `{"ok":true,"routeCount":7}`；随后经 8089 打面板得到正常响应，`access.log` 里 `logger` 统计 `{'http.log.access': 2}`、`caddy.log` 里 `{'admin.api': 8, 'http': 2, ...}` —— 分流确认。
3. 注意：临时实例的 `state.json` 必须先把 `settings.caddyListen` 改成 `:8089` 再启动，否则会把测试 Caddy 绑到生产 8080 上（这一步第一次漏了，白跑一轮）。

### 校验
`tools/check.sh` 五项全绿；`node --check src/core/caddy.js src/core/paths.js` 通过。

## v0.29.63

## 修掉一个「上线了但按下去会报错」的真问题

v0.29.61 加的「设置 → 版本与回滚」有个隐患：回滚请求要写 `data/ops/rollback.json`，而那个目录是宿主机 root 建的（755 root:root），面板容器跑在 1000:1000 上，写不进去 —— 点回滚会返回 500（EACCES），功能等于摆设。这轮把它修掉并端到端验过。

### 改动
- `tools/ops-agent.sh`：每次运行先把 `data/ops` 的属主改回 `1000:1000`、权限 775（agent 本身是 root，能改），避免以后又被谁以 root 建目录卡住。
- `src/routes/versions.js`：写请求失败时不再吐裸 500，改成明确提示「写不进 data/ops（EACCES）：宿主机执行 chown 1000:1000 data/ops」，看页面就知道怎么修。
- 宿主机侧已 `chown 1000:1000 data/ops && chmod 775`。

### 端到端验证（不碰生产镜像）
按面板用户的身份往 `data/ops/` 排一个故意不存在的版本 `0.0.0` → 一分钟内 ops-agent 取走、`docker image inspect` 判定不存在、写入 `ok:false` 结果并删掉请求：
- 请求文件消失、`rollback-result.json` 出现 `{"version":"0.0.0","ok":false,"exitCode":127,"tail":["宿主机上没有 cf-tunnel-panel:0.0.0 这个镜像，请求已丢弃"]}`
- 面板 `GET /api/versions/rollback` 正确读到 `lastRun`（页面会显示这次失败与原因）
- agent 日志 `本机没有 cf-tunnel-panel:0.0.0，丢弃`

真回滚（切色 15–30 秒不可用）没有在这次做，需要时再单独演练。

### 校验
`tools/check.sh` 五项全绿（requires / i18n / openapi 92 路径 99 操作 / alerts / eslint）；`bash -n tools/ops-agent.sh`、`node --check src/routes/versions.js` 通过。

## v0.29.62

## v0.29.62

### 新增：新版本提示

侧栏版本号后面会多一个小角标，形如 `↑ v0.29.63`——当 GitHub 上有比当前更新的 Release 时出现，点一下直接打开那条 Release。没有新版本就什么都不显示。

检查是 **每 6 小时最多一次**（记在 localStorage），失败静默：GitHub 打不开、限流、没网，都只是不显示角标，不弹任何错误、不影响面板使用。

### 接口

`GET /api/version/latest` —— 返回 `{ok, current, latest, hasUpdate, url, publishedAt, notes, checkedAt}`，服务端缓存 6 小时；取 GitHub 的 `releases/latest`，走 `getV4`（本机没有 IPv6 出口，直接用 fetch 会卡在 AAAA 上）。

### 说明：备份下载本来就有

原本打算这版做「备份能下载」，查了一下 `/api/backups/download` 和备份列表里的「下载」按钮都已经在（带 `Content-Disposition`、`Cache-Control: no-store`），实测下一个 7.4 KB 的 settings 快照正常，所以这块不动。

「备份推到异地」（S3 / WebDAV / 另一台机器）还没做——需要先定目标与凭据，等你指定。

### 验证

- 预览实例 `GET /api/version/latest` → 200，1.3s，返回 `latest 0.29.61`、`hasUpdate:false`（当前就是最新）
- `/assets/app.js` 含 `checkUpdate`、`/assets/app.css` 含 `.ver-badge`
- `bash tools/check.sh` 五项全绿；OpenAPI 92 条路径 / 99 个操作

修正一处：新版本检查里 `getV4` 忘了 require，被 ESLint 的 no-undef 当场抓到（运行时它抛错会静默回落 fetch，所以功能看起来正常，其实是隐患）。这正是上一版把 eslint 接进 CI 的意义。

## v0.29.61

## v0.29.61

### 新增：面板内的「版本与回滚」

设置页多了一个「版本」分区，能看到本机所有 `cf-tunnel-panel:<版本>` 镜像、构建时间与大小，并标出当前在跑的是哪个。要回滚就输入目标版本号、再输入一遍确认，点了之后排队执行，页面显示进度和上一次结果。

以前回滚只能 SSH 上去敲 `tools/rollback.sh <版本>`，0.29.46 那次事故就是靠手工起临时实例推配置救回来的，前后十几分钟。现在面板上点两下就行。

### 为什么拆成两段

面板容器里没有 docker CLI，也不该给它 docker 特权。所以：

1. 容器内只做两件事——用 `/var/run/docker.sock` 的**只读** HTTP API 读镜像列表，把回滚请求写成 `data/ops/rollback.json`；
2. 宿主机 cron 每分钟跑 `tools/ops-agent.sh`，读到排队文件才真正执行 `tools/rollback.sh <版本>`（重标 `:local` → 滚动升级 → 校验内网 8080 与公网），结果写 `data/ops/rollback-result.json`。

容器保持非特权，真正动 docker 的动作发生在宿主机。

### 接口

- `GET /api/versions` —— 当前版本 + 本机镜像列表 + 排队中的请求 + 上次结果
- `GET /api/versions/rollback` —— 只看排队与结果
- `POST /api/versions/rollback` —— `{version, confirm}`，`confirm` 必须与 `version` 完全一致；版本格式、是否存在该镜像、是否等于当前版本都会校验；通过后写队列并记审计

OpenAPI 清单随之更新到 91 条路径 / 98 个操作。

### 验证

- 预览实例（生产数据副本）：`GET /api/versions` 列出 `0.29.60 / local / 0.29.59`，`available:true`；`confirm` 不符时返回「二次确认没对上」；镜像不存在时返回明确错误。
- 页面：设置页有「版本」分区与导航项，`settings.js` 已带 `loadVersions`。
- 静态检查 `bash tools/check.sh` 五项全绿（requires / i18n / openapi 91 路径 / alerts / eslint）。

### 注意

`data/ops/rollback.json` 一旦出现，**1 分钟内就会真的回滚**。回滚会重建容器，页面会 502 十几秒，这是正常的。

## v0.29.60

## v0.29.60

Caddy 的访问日志没法按天切文件（2.11.9 不认 roll_keep_for，v0.29.46 试过直接把整站打挂），
所以这一次不切文件，改成「按天看得见」：

- `/metrics` 新增 `cf_caddy_log_bytes`（日志目录总占用，含轮转归档）与 `cf_caddy_log_files`（文件数），
  30 秒缓存，扫一次目录；Prometheus 本来就在抓 8080 的本机指标，不用额外配置。
- `tools/prune-logs.sh` 每天 04:17 那趟除了删 7 天前的 `.gz`，再打一行汇总：
  字节数 / 文件数 / 最老归档日期，落在 `data/logs/prune.log`，看趋势用 `tail`。

实测：测试实例上 `/metrics` 报 1501853 字节 / 4 个文件，与 `du -sb data/caddy-logs` 完全一致。

静态检查（requires / i18n / openapi / alerts / eslint）全绿；对生产面板 API 367/367。

## v0.29.59

## 这一版修的是「审计出来的 7 个洞」

### 安全
- **公网 `/metrics` 不再裸奔**：以前 `https://panel.jianghugs.shop/metrics` 直接 200，把版本、代码指纹、隧道 id 与名字、主实例、请求分布全摊开。现在面板层判 `cf-connecting-ip` / `cf-ray`（Cloudflare 经隧道必带），带这两个头就 404。本机直连与 Prometheus 抓取（127.0.0.1:8080）都不带，监控不受影响。没走 Caddy 加路由，是因为 pusher 用 `routes.length - 1` 记 routeCount，多一条会让自检「本地 7 条 / Caddy 7 条」对不上。
- **写操作补 Origin 校验**：以前只有 `SameSite=Lax` 一道锁，同站子域或老浏览器挡不住。现在非 GET 的 `/api/*` 如果带 `Origin`/`Referer` 且与 `Host` 不同源 → 403。curl / 测试脚本不带头，照常放行。

### 稳定性
- **`unhandledRejection` 兜底**：Node 22 默认把未处理拒绝当致命错误，进程会退，容器拉起来但租约掉、cloudflared 重连，而且一点痕迹没有。现在记一条日志 + 计数，进程继续跑。
- **`tools/rollback.sh <版本>`**：0.29.46 那次把整站打挂时只能手工起临时实例推配置。现在一条命令：把目标版本镜像重标成 `local` → 走滚动升级 → 校验 healthz 版本与公网，任一步不对自动切回原版本。

### 可观测
- `/metrics` 新增：`cf_caddy_push_ms`（上次下发耗时）、`cf_caddy_push_failures_total`、`cf_selfcheck_fails` / `cf_selfcheck_warn`、`cf_unhandled_rejections_total`、`cf_process_rss_bytes`、`cf_eventloop_p99_ms` / `cf_eventloop_max_ms`。
- 告警新增 4 条：`SelfcheckFailing`、`UnhandledRejections`、`CaddyPushFailures`、`EventLoopLagHigh`（`tools/monitoring/prometheus/alerts.yml` 与 `docs/prometheus-alerts.yml` 两份已同步）。

### 前端
- `sw.js` 升到 v3：只预缓存 `/assets/icon.svg`、`/assets/offline.html`。`app.css` / `app.js` 的请求带 `?v=<codehash>`，预缓存裸路径永远命不中（白占空间），改由 runtime 缓存按完整 URL 收。

## 验证
- 全新实例（空 DATA_DIR）：`test/smoke.mjs` **91/91**；带 `cf-connecting-ip` 访 `/metrics` → **404**；跨站 POST → **403**、同源 POST → 200。
- 预览实例（生产数据副本 + 新代码）：**DOM 236/236**；API **353/354 + 跳过 13 条**（无真 Caddy 边缘，且预览的 CADDY_ADMIN 指死端口），唯一未过的是 `上游健康全部在线`，属预览环境上游抖动，生产同用例为绿。
- 静态检查：`check-requires` 55 文件 0 问题、`i18n-check` 通过、`openapi --check` 89 路径 95 操作、`eslint --quiet` 0 问题。

## 教训
- 改 `tools/monitoring/prometheus/alerts.yml` 必须同步 `docs/prometheus-alerts.yml`，测试里有断言会比较两份内容（这次就是这么被抓住的）。
- `/metrics` 的封禁要按「Cloudflare 是否加了头」判，按 Host 判会误伤 Prometheus（它是用 `Host: 127.0.0.1` 抓 8080 的）。

## v0.29.58

## 质量收尾：测试防线、去重复、静态检查

这一版不发新功能，全是「让它自己发现自己的错」的基础设施。

### 测试防线
- **接口冒烟** `test/smoke.mjs`：在空 DATA_DIR、无口令的全新实例上把 7 个页面 + 每条 `/api/*` 路由各打一遍，写操作也打（黑名单、设置、规则、分享、体检、推送），专抓「模块搬出去但 require 漏了」这类 `node --check` 查不出、只在运行期炸的问题。
- **api 套件可跑在无边缘环境**：`PANEL_NO_AUTH=1` 打无口令实例；开跑前探 `CADDY_EDGE`，连不上就把 13 条「经真 Caddy 取证」的用例标 SKIP 并汇总，退出码仍为 0。
- **发版自动验两条路**：`tools/release.sh` 默认 `PANEL_HOST=panel.jianghugs.shop`，滚动升级后既验「经 Caddy 的 8080（Host 头）」也验公网 `/healthz`，任一不通直接失败。
- CI 增加 i18n / openapi / 接口冒烟 / ESLint 四个门槛。

### 去重复
- 十个 `src/routes/*.js` 各 98–112 行的 require/解构样板（含 `authOf()`、`readOpenapi()`）收进 `src/routes/_deps.js`，模块只解构自己用到的名字，净减 727 行。
- 新增 `tools/node.sh`：本机有 node 就用本机的，没有就丢进容器跑，并白名单透传 `PANEL_URL/PANEL_USER/PANEL_PASS/CADDY_EDGE` 等变量；`release.sh` 自动接上，发版不再依赖手工 shim。

### 静态检查与运维
- 接入 ESLint（只开 `no-undef` + `no-unused-vars`），`npm test` 链变成 requires → i18n → openapi → lint → api → dom。首跑即抓出一处真问题：路由模块里一段 `/metrics` 分支引用了 `server.js` 的私有函数，位置在调度链之后永不执行，属搬迁残留，已删。
- 新增 `tools/prune-logs.sh` + crontab（每天 04:17）清理 `data/caddy-logs` 里 7 天前的 `.gz`。Caddy 自身只有按大小滚动，按天保留做不到（0.29.46 试过 `roll_keep_for`，不被 2.11.9 识别并把整站打成 502）。
- i18n 覆盖漂移 53 条（同一句中文在 v0.14 / v0.29 两批翻译里的措辞差异）定为不改：运行时按 `Object.assign` 顺序取最后一段，界面只会显示一种译法、不会中英混排。

### 校验
- require 自检 54 文件 0 问题；i18n 重复键 0 / 空译文 0 / 未收录 0；openapi 89 路径 95 操作全覆盖；ESLint `--quiet` 0 problem。
- 接口冒烟 91/91；api 套件对生产 367/367；无边缘环境 354/354 + 跳过 13 条。

## v0.29.57

### 重构
- 隧道路由整组搬出 server.js：`/api/tunnels`（GET/POST）、`/api/tunnels/start-all|stop-all`、单出口动作正则、旧 `/api/tunnel*` 一起进了 `src/routes/tunnels.js`。这几条必须待在同一匹配序列里——单出口动作的正则会先把 `start-all` 当成 id 吃掉，拆开就互相抢。`src/server.js` 728 行（本轮起点 2380 行）。
- 至此 server.js 只剩：登录/登出与会话门、静态资源与页面壳、`/api/*` 模块调度、少量与 state/pusher 紧耦合的接口。

### 工具与 CI
- 新增 `tools/check-requires.js`：检查 ① 相对 require 能否解析到真实文件 ② Node 内置模块（net/dns/http/crypto/fs/path…）被用却没 require。
  这类问题 `node --check` 完全看不出来，只在跑到那一行才抛 `net is not defined`——0.29.55 的「一键封禁」500 就是这么来的。
- 接进 `npm test` 首位（`test:requires`），并补上 CI 的语法检查漏项：拆包后新增的 `src/routes/*.js`、`src/http/*.js` 之前根本没被 `node --check` 覆盖。

### 测试
- `test/dom.test.cjs` 6 处「点击后硬等 120~200ms」改成 `waitFor(条件)`，两处手写轮询也换成 waitFor；剩下 3 处 sleep 在 waitFor/pollTick 内部，是本该有的间隔。

### 验证
- DOM 对预览实例：236/236
- API 对生产：367/367
- API 对预览（CADDY_ADMIN 指死端口）：354/367，13 条全是既有的「真 Caddy 依赖」用例，无新增
- i18n：重复键 0 / 空译文 0 / 未收录中文 0；openapi：89 路径 95 操作全覆盖

## v0.29.56

## 修 0.29.55 的回归：一键封禁 500

0.29.55 把 `/api/security/deny|allow` 搬进 `src/routes/ops.js` 时，模块头是从 `cf.js` 复制的，
漏了 `net`（`net.isIP` 判断），`POST /api/security/deny` 直接 500 `{"ok":false,"error":"net is not defined"}`，
面板「一键封禁」不可用。

同批扫了所有 `src/routes/*.js` 与 `src/http/*.js`，一次补齐漏掉的模块：
`ops.js` → net；`cf.js` → dns、http；`monitor.js` → crypto；`shares.js` → fs、path。

验证：预览实例 `POST /api/security/deny` → `{"ok":true,"added":true,"entry":"192.0.2.77/32"}`，
`/api/security/allow` 回退正常；`node --check` 全部通过。

## v0.29.55

## 重构：server.js 从 2380 行减到 784 行

把 server.js 里的路由按子系统搬进 `src/routes/*.js`，每条路由导出 `handle(p, req, res, url)`
（未命中返回 false），server.js 只留「鉴权门 → 三块静态/入口 → `/api/*` 模块自决调度」。

- `src/http/{static,boot,onreq}.js`：静态资源、boot.js、请求入口（限流/审计/探针判定）
- `src/routes/shares.js`、`cf.js`、`backups.js`：一次性分享、Cloudflare、备份恢复
- `src/routes/monitor.js`、`observe.js`、`rules.js`：体检、观测数据、代理规则
- `src/routes/settings.js`、`ops.js`：设置/导出导入/配置即代码、运维导出与安全
- `src/routes/authroutes.js`：会话、运维账号、TOTP、面板登录

留在 server.js 的：隧道 CRUD 那一簇（`/api/tunnels/<id>` 的正则块夹在 start-all 与 operator
之间，挪进调度链会被这条正则先吃掉），以及鉴权门之前的登录/登出与 alerts hook。

## 顺带修掉

- `observe.js` 里 `require('./core/audit')` 少一级 `../`，导致 `/api/audit/days` 500（0.29.53 已修）
- `observe.js` / `rules.js` 残留裸 `auth.who`，线上「保存规则」报 400（0.29.54 已修）

## 验证

- DOM 236/236（预览实例，含全部新代码）
- API 353/367（预览的 CADDY_ADMIN 指死端口，14 条依赖真 Caddy 的既有用例失败）；线上同版本 367/367
- i18n 自检：重复键 0 / 空译文 0 / 未收录中文 0
- OpenAPI：89 路径 95 操作，`--check` 通过

## v0.29.54

### 修 0.29.52/0.29.53 引入的一个真故障：保存代理规则返回 400

**症状**：面板里改完规则点「保存规则」提示失败；`POST /api/routes` 返回 `{"ok":false,"error":"auth is not defined"}`（HTTP 400）。

**原因**：把路由从 `server.js` 拆到 `src/routes/*.js` 时，原 handler 作用域里的局部变量 `auth` 没有跟着走。大部分地方已经改用模块内的 `authOf(req)`，但漏了两处：

- `src/routes/rules.js`：规则启用/停用时写审计的 `actor: auth.who`
- `src/routes/observe.js`：重发通知时写审计的 `actor: auth.who`

两处都在 `try` 里，异常被统一转成 400/502，所以页面只看到「保存失败」，实际是变量未定义。

**修法**：两处都改成 `authOf(req).who`；顺带全仓 `grep` 确认 `src/routes/` 下已无裸 `auth.` 引用。

**验证**：预览实例 `POST /api/routes` 200（禁用一个规则再还原均成功）；发布后对生产复跑 api 套件确认 367/367。

## v0.29.53

### 修 0.29.52 的一个回归：审计日期列表 500

**症状**：`GET /api/audit/days` 返回 `{"ok":false,"error":"Cannot find module './core/audit'"}`，审计页的日期下拉是空的。

**原因**：0.29.52 把审计相关路由从 `server.js` 搬到 `src/routes/observe.js`，块里那句 `require('./core/audit').KEEP_DAYS` 是按 `src/` 目录写的相对路径；文件搬到 `src/routes/` 之后要写成 `../core/audit`。搬别的路由时没触发，只有这一处是内联 require 而不是顶部统一引入。

**修法**：改成 `require('../core/audit').KEEP_DAYS`。

**验证**：预览实例 `/api/audit/days` 返回 2026-11-25/26/27 三天记录；发布后对生产复跑 api 套件。

## v0.29.52

### 重构：把体检监控、观测数据、代理规则三组路由搬出 server.js

这是「拆分 server.js」三步里的第三步（前两步已随 0.29.52 前序提交完成）。

**做了什么**

- 新增 `src/routes/monitor.js`（一键体检、体检历史、监控状态、告警静默）
- 新增 `src/routes/observe.js`（流量趋势、按出口/按规则聚合、访问统计、审计、面板日志流）
- 新增 `src/routes/rules.js`（代理规则保存、规则测试、路径匹配、Caddy 配置与重推）
- `src/server.js` 由 **1736 行降到 1389 行**；路由分发改为「模块自决」：模块处理了就短路，没处理继续往下走

**为什么这么做**

单文件 2380 行时，任何一次改动都要在两千行里找锚点，改错一个括号整站 500。现在每个子系统一个文件，改哪块只看哪块。

**顺手修掉的两个坑**

- 搬出来的代码引用原作用域里的 `auth`（会话对象）→ 统一改成 `authOf(req)`，用 WeakMap 缓存，不重复校验
- 体检执行器 `runSelfcheckOnce` 依赖十几个顶层变量 → 通过 `src/core/runtime.js` 句柄注入，而不是把那堆依赖一起搬走

**验证**

- `test/api.test.mjs` 对生产 367/367
- `test/dom.test.cjs` 对同版预览实例 236/236
- `npm run test:i18n` 重复键 0 / 空译文 0 / 未收录中文 0
- `npm run test:openapi` 89 条路径 / 95 个操作全覆盖

**还没搬的**

隧道路由、设置页、鉴权与会话这三大块仍在 `server.js`，它们和 state/pusher/tunnel 管理器耦合最紧，留到下次单独做，不做「一次搬空」。

## v0.29.51

## 接口清单：OpenAPI 描述 + 覆盖自检

这一版没有改任何接口行为，只把「现在到底有哪些接口」变成可查、可校验的资产。

### 新增

- **`GET /api/openapi`**：返回本面板的 OpenAPI 3 描述（需登录，和其他 `/api/*` 一样）。用 Swagger UI、Postman、Insomnia 或任何 OpenAPI 工具贴这个地址就能直接浏览、试调。
- **`docs/openapi.json`**：89 条路径 / 95 个操作，按 13 个业务分组（系统与鉴权、代理规则、隧道出口、设置、安全、监控体检、一次性分享、Cloudflare、工具箱、日志审计、备份恢复、观测数据、其他）。
- **`tools/openapi.js`**：
  - `node tools/openapi.js --gen` 重新生成文档；
  - `node tools/openapi.js --check` 比对「代码里扫到的 `/api` 路由 ⊆ 文档」，缺一个就非零退出。

### 接线

- `npm test` 现在是四段：`test:i18n` → `test:openapi` → `test:api` → `test:dom`。
  以后新增接口忘了写文档，`npm test` / CI 会直接红，不用靠人记。
- `Dockerfile` 补了 `COPY docs ./docs`（原来只打包 `src` 和 `tools`，`/api/openapi` 在镜像里会读不到文件）。

### 生成器怎么认路由

`src/server.js` 里是手写路由（`if (p === '/api/x' && req.method === 'GET')` 加一批正则），所以生成器直接扫源码：

- 字面量：`p === '/api/...'`，一行里 `||` 串联的多个也能拆开；
- 正则：逐字符取边界，再把 `[0-9a-fA-F-]{36}`、`([\w-]+)`、`(?:/(start|stop))?` 这类片段归一成 `{id}` / `{id2}`；
- 方法取同一行的 `req.method`，没有就按 GET（本项目里的单行路由都是 GET）。

### 验证

| 项 | 结果 |
| --- | --- |
| `node test/openapi.test.cjs` | 6 项全 PASS（89 路径 / 95 操作，覆盖检查通过） |
| `GET /api/openapi`（带凭据） | 200，41 KB |
| `GET /api/openapi`（不带凭据） | 401 |
| API 回归（对线上） | 367/367 |
| DOM 回归（对同版实例） | 236/236 |

### 顺带

`AGENTS.md` 的测试基线那段补了一句：除 API/DOM/e2e，另有 `test:i18n` 与 `test:openapi` 两条静态自检，改接口后要跑 `--gen`。

## v0.29.50

## 测试提速与 i18n 补齐（C9 / C10）

### C9 · 测试不再靠硬等
`test/api.test.mjs` 里「新建出口后等它进 running」原来是写死的 `await sleep(14000)`，无论快慢都要等满 14 秒。
改成轮询：每 500ms 查一次出口状态，一离开 `starting` 就继续（28 次上限，超时再兜一次快照）。

- API 套件耗时 **34s → 23.5s**，结果仍是 367/367。
- 其余 21 处 `sleep()` 是等待渲染/节流的小 settling delay（dom 150–250ms、e2e 400–600ms），不是失败源，保持原样。

### C10 · 英文界面不再漏中文
新增 `EN_V0300` 段，补齐 79 条未收录的中文文案（监控页的体检历史轴与图例、观测页的筛选与延迟列、
概览页的命令面板提示、设置页的隧道 token 教程与 Grafana 嵌入说明、工具箱的小节标题等）。

同时修掉两个真实缺陷：

1. `EN_V0298` 里 `'局域网直连地址（可选）'` 写了两遍 —— 同段重复键，后者静默覆盖前者；
2. `EN_V0142C` 末尾的 `'中': '中'` 把 `EN_V0142B` 里正确的 `'中': 'in'` 覆盖掉，英文界面会出现一个中文「中」。

`tools/i18n-check.js` 增加「命令片段不进字典」的过滤（`curl …`、`webhook_configs: [...]`、含 `://` 或 `{` 的行），
避免把配置示例当成待翻译文案。当前状态：字典段 30、条目 986、唯一键 783、重复键 0、空译文 0、未收录中文 0。
自检已接进 `npm test`（`test:i18n → test:api → test:dom`）。

### 回归
- `node test/i18n.test.cjs` 通过
- `test/api.test.mjs` 367/367（23.5s）
- `test/dom.test.cjs` 236/236

## v0.29.49

### 安全与运维收口（第二轮审计的第一批）

这版只动了「已经在做但不彻底」和「缺一层」的地方，功能行为不变。

**安全**
- **HSTS**：Caddy 配置里给每条路由前置一个 `headers` 处理器，下发 `Strict-Transport-Security: max-age=15552000`（180 天）。
  - 用「同一条路由内前置处理器」而不是新增一条路由，是因为下发计数用的是 `routes.length - 1`，多一条会让自检的「本地 7 条 / Caddy 7 条」对不上。
  - 只在 https 下有意义（浏览器忽略 http 上的 HSTS），内网裸 IP 访问不受影响。
  - 落库前先在一次性 Caddy 2.11.9 实例上验过 `handle` 顺序与字段名，再推给线上；响应头已在 `panel.jianghugs.shop` 与 `demo.jianghugs.shop` 上实测出现。
- **会话 cookie 的 Secure**：`isSecure()` 现在优先看 Cloudflare 的 `CF-Visitor`（`{"scheme":"https"}`）。走隧道时 Caddy 到面板这一跳是明文 http，之前只看 `x-forwarded-proto` 会把 https 访问判成 http，cookie 就少了 `Secure`。

**运维**
- `tools/release.sh`：旧面板镜像保留数从 3 个降到 2 个（每版约 460MB）。
- `tools/monitoring/docker-compose.yml`：Prometheus 除了已有的 `retention.time=15d`，再加 `retention.size=2GB` 上限。

**顺带更正上一轮审计的 5 个误判（都已在代码里）**
- 不存在「双重登录」：`/login` 公网与内网都直接 200，之前看到的 401 是未登录访问受保护路径的正常响应。
- backups 已有 20 份上限（`saveState()` 里滚动删除）。
- Prometheus 早已设 `retention.time=15d`。
- Caddy 访问日志早已按 `roll_size_mb: 10, roll_keep: 3` 自滚动（上限约 40MB）。
- 带 `?v=<codehash>` 的静态资源早已是 `max-age=31536000, immutable`。

**验证**
- `test/api.test.mjs` 对生产 367/367。
- `test/dom.test.cjs` 对同版预览实例 236/236。
- `/api/selfcheck` 14/14；公网 `https://panel.jianghugs.shop/healthz` 200。
- Caddy 响应头实测：`Strict-Transport-Security: max-age=15552000`（panel 与 demo 两个 Host 都有），`routeCount` 仍是 7。

**下一步（同一轮审计里还没做的）**：拆 `server.js`（2380 行 / 77 个 API 路径）、测试里 22 处固定 `sleep()` 换轮询、i18n 79 处页面中文未收录、生成 OpenAPI。

## v0.29.48

## 图表与 Grafana 的最后两处

这一版把 P2 的两项收尾做完，都是「小屏 / https 场景下才暴露」的问题。

### 手机上不再挤成一排刻度

概览页四张图表的 X 轴以前固定按 6 个点左右取样，在 390px 宽的屏上「22:00 / 0:00 / 2:00 / 4:00 / 6:00」直接叠字。
现在按屏宽决定刻度数量：窄屏（< 720px）最多 3 个，桌面端保持原样。
分钟级采样（出口在线历史）在窄屏上改用「时:分」标注，避免三个刻度全被去重成同一个「3:00」。

实测（预览实例，390×844 @2x）：流量趋势 / 变更趋势 / 按规则看流量 各 3 个刻度，出口在线历史 `5:25 | 6:45 | 8:05`；桌面 1440px 仍是 6/4/6/6，没变化。

### Grafana 在 https 页面里给出入口

当面板走 https、而 Grafana 是 http 时，浏览器按混合内容把 iframe 拦掉，以前只留一段说明和一个空白的卡身。
现在：

- 概览页的「监控面板」卡在混合内容状态下会渲染一个说明块 + 「在新窗口打开 Grafana ↗」按钮，不再是白板；
- 监控页的 Grafana 卡补上了「在 Grafana 打开 ↗」按钮（HTML 里原本没有这个节点，JS 一直在找 `#btnMonOpen`，所以从没显示过）。

### 验证

- `test/i18n.test.cjs`：通过（重复键 0、空译文 0，未收录中文 79 处为覆盖率告警）
- `test/dom.test.cjs`（预览实例 :8181）：236/236 通过
- `test/api.test.mjs`（生产 :8090）：367/367 通过
- 预览截图核对：窄屏四张图表刻度 3 个、Grafana 卡有「在 Grafana 打开」按钮且可见

### 一并说明

`chartLabels()` 现在读 `window.innerWidth`，属于渲染期读取，不需要 resize 监听——图表随页面重绘时自动按新宽度取样。

## v0.29.47

## v0.29.47 — 热修：Caddy 配置里去掉不支持的 roll_keep_for

**v0.29.46 有一个致命问题，已在 20 分钟内修掉，这里说明白。**

### 出了什么事
v0.29.46 给 Caddy 访问日志加了 `roll_keep_for: '168h'`，想让超过 7 天的日志自动清理。但这台 Caddy（2.11.9）的 file writer **不认识这个字段**：

```
HTTP 400: loading config: setting up default log: loading log writer module:
loading module 'file': decoding module config: caddy.logging.writers.file:
json: unknown field "roll_keep_for"
```

每次下发都 400，Caddy 侧配置失效 → `panel.jianghugs.shop` 变成 502。

### 怎么修的
删掉 `roll_keep_for`，恢复成原来的 `roll_size_mb: 10, roll_keep: 3`（按体积滚动、留 3 份）。**按天回收这件事这次不做**，原因是 Caddy 的 file writer 没有这个能力，硬加只会把配置推挂。日志总量本来就被 `roll_size_mb` 限住了（最多 30MB × 若干），不是无界增长；真要按天归档，得让 Caddy 走 journald 或外部轮转，另开一版做。

### 教训（值得记）
1. **改 Caddy 配置字段前先在真 Caddy 上验一遍 `/load`**，别只看文档。Caddy 的 `/load` 失败会连带停掉既有 server，代价是整站 502。
2. 上线顺序应该是「先在旁路实例把 config 推给真 Caddy 验证，再发版」，这次顺序反了。

### 验证
- `POST /api/caddy/push` → `{"ok":true,"caddy":{"ok":true,"routeCount":7}}`
- 公网 `panel.jianghugs.shop/healthz` 200、`demo.jianghugs.shop` 200
- Prometheus 单目标 `up=1`
- DOM 回归 236/236

## v0.29.46

## v0.29.46 — P0 五项运维收口

这一版只动运维面，不改任何页面与业务逻辑。

### 1. Prometheus 只抓一个目标（跟着活的那一色）
原来 `tools/monitoring/prometheus/prometheus.yml` 把 `127.0.0.1:8090` 和 `127.0.0.1:8095` 都写死成 target，蓝绿只有一色在跑，另一条必然 `connection refused`，告警里天天挂一条假的 down。

改成只抓 `127.0.0.1:8080` —— Caddy 上有一条 `host = 127.0.0.1` 的规则永远指向当前 leader 那一色，所以这个 target 天然跟着活槽位走。实测重启后 20s 内 `up = 1`。

### 2. Caddy 访问日志按天回收
原来只有 `roll_size_mb: 10 / roll_keep: 3`（按体积滚动，留 3 份）。低流量下旧档永远攒不到 10MB，于是「三个月前的日志还在」，而「最近三天的可能已经被删」。

补 `roll_keep_for: '168h'`：无论体积，超过 7 天的滚动文件都清掉。

### 3. Caddy 容器加 healthcheck
panel 早就带 healthcheck，caddy 一直裸奔。现在用 admin 端口探活：
`wget -q -O /dev/null http://127.0.0.1:20190/config/`，`interval 10s / timeout 3s / retries 6 / start_period 10s`。

重建后 `docker ps` 里已是 `Up (healthy)`。注意：Caddy 启动只加载 bootstrap 配置，重建后需要 `POST /api/caddy/push` 把真实路由推回去（面板侧一有改动也会自动推）。

### 4. 发版时回收旧镜像
`tools/release.sh` 在「完成」前加一步：按创建时间倒序保留最近 3 个 `cf-tunnel-panel:<版本>` 镜像，其余 `docker rmi`（`:local` 不动）。之前积了 8 个 × 462MB ≈ 3.7GB。

### 5. 快照日志搬出 /tmp 并轮转
`git-snapshot.sh` 的输出原来写 `/tmp/cfp-git.log` —— 机器一重启就没了，也永远不轮转。现在落到 `data/logs/git-snapshot.log`，并加 `/etc/logrotate.d/cfp-snapshot`（weekly / rotate 4 / compress / copytruncate）。

### 验证
- `docker compose config` 渲染通过；`bash -n tools/release.sh`、`node --check src/core/caddy.js` 通过。
- Prometheus 重启后单 target `up=1`；Caddy 重建后 `healthy`、`routeCount 7`、公网 `panel.jianghugs.shop/healthz` 200、`demo.jianghugs.shop` 200。
- DOM 回归 236/236（预览实例 8181，含本版代码）。

## v0.29.45

## 修掉「工具箱 → 本机 Docker 容器：读不到 Docker」

页面一直提示「给 panel 服务加 /var/run/docker.sock 挂载再 docker compose up -d」。这句话是错的：
挂载从 v0.8.0 就在 `docker-compose.yml:27`，运行中的容器也确实挂着 `rw=false`。

真因是权限：宿主 socket 是 `root:docker 0660`（本机 docker 组 gid **989**），而面板以 `uid=1000 gid=1000` 运行，
组不匹配 → `EACCES Permission denied`。`dockerApi()` 只区分了 ENOENT，其余一律把原始报错抛给前端，于是被统一显示成「没挂载」。

改动（4 个文件）：

- `docker-compose.yml`：panel 服务加 `group_add: ["${DOCKER_GID:-989}"]`，挂载行保留。
- `tools/rolling-upgrade.sh`：新增 `DOCKER_GID=${DOCKER_GID:-989}`，两处 `docker run`（bootstrap 与升级）都加 `--group-add "$DOCKER_GID"`——否则滚动升级一次就把组丢了，问题复发。
- `src/core/integrations.js`：`dockerContainers()` 按 `ENOENT`（没挂载）/`EACCES`（没进 docker 组）/超时 三种情况分别给提示，不再一律透传原始报错。
- `src/web/assets/tools.js`：空态文案改用后端返回的 `d.error`，并写明「挂载 + group_add，改完要滚动升级一次才生效」。

验证：`docker compose --profile bootstrap config` 渲染出 `group_add: ["989"]`；同条件实测
`docker run --user 1000:1000 --group-add 989 -v /var/run/docker.sock:/var/run/docker.sock:ro` → socket 可打开
（`No such device or address` 是 cat 一个 socket 的正常结果），不加组则是 `Permission denied`。
升级后用 `/api/docker/containers` 确认 `available:true` 且能列出容器。

说明：panel 在 `profiles: ["bootstrap"]` 里，`docker compose up -d` 本身不会重建它（只有 caddy/demo，且都是 up-to-date）；
要让设置生效走 `tools/rolling-upgrade.sh --apply`，blue ↔ green 切换，不中断。

## v0.29.44

## 0.29.44

本版只动「出站取证」这一层，把 IPv4 兜底从自检里抽成公共模块，铺到所有会打公网的地方。修的是同一类假失败：**本机只有 v4 出口，但域名的 DNS 同时返回 A 和 AAAA**，Node 的 `fetch`（undici）与 `net.connect` 遇到 AAAA 先回、v6 又连不通时会一路等到超时，而 `curl` 走 happy-eyeballs 会自动回落 —— 于是面板上会出现「出口在线但自检报红」「一键新建出口最后一步自测失败」「Cloudflare 演练拿不到计划表」这类看得见摸不着的红灯。

### 新增

- `src/core/httpv4.js`：`getV4(url, opts)` —— 先 `dns.lookup(host, { family: 4 })` 拿 IPv4，再按 IP 直连（`http/https.request`），保留 `Host` 头与 SNI（`servername`），支持 `method / headers / body / timeout / maxBytes`，返回 `{ status, headers, body, ip }`。

### 改动

- `src/core/selfcheck.js`：删掉 v0.29.43 里那份本地兜底，改为 `require('./httpv4')`，行为不变（出口探针失败后兜一次，成功则 detail 注明「IPv4 兜底成功，<IP>」）。
- `src/core/probe.js`：上游探测两个阶段都兜底 —— TCP 阶段先解析 IPv4 再 `net.connect`；HTTP 阶段失败后 `getV4` 再试一次，成功时 `note` 写「已用 IPv4 直连（<IP>）拿到响应」。
- `src/server.js`：一键新建出口的「公网自测」步骤、以及边缘缓存预热探测，同样加一层 `getV4` 兜底（预热顺便从 `cf-ray` 里解析 colo）。
- `src/core/integrations.js`：`cfApi()` 改成 `fetch` 失败后走 `getV4` 重试，状态码与 JSON 判断改看兜底结果 —— Cloudflare 的「演练」「建隧道」「清缓存」不再因为 v6 假失败而中断。

### 验证

- 容器内实测：`getV4('https://demo.jianghugs.shop/')` → 200（IP 198.18.8.175）；`getV4('https://panel.jianghugs.shop/healthz')` → 200（IP 198.18.9.46）；同样 URL 的裸 `fetch` 报 `The operation was aborted due to timeout`。
- `probeUpstream` 四例：`https://demo.jianghugs.shop/` → ok 200（tcp 1079ms / 总 2124ms）；`https://panel.jianghugs.shop/healthz` → 200；`http://127.0.0.1:8090/` → 302；`http://127.0.0.1:9/` → 「端口 9 没人监听（connection refused）」，失败路径照旧。
- DOM 回归 236/236（含「工具箱：演练结果显示计划表」）。
- API 回归基线 367/367（0.29.43 时；本版未动路由与下发逻辑）。

### 备注

- `PANEL_*` 环境变量、数据结构、接口均未变，可直接滚动升级。
- 如果你确实给机器配了可用 IPv6 出口，这条兜底只在 `fetch` 失败后才启用，不影响原来的直连路径。

## v0.29.43

### 修

- **一键体检的「出口」不再是永久黄灯**：本机与容器都没有 IPv6 出口，而 DNS 同时返回 A 与 AAAA，Node 的 `fetch`（undici）遇到「AAAA 先回、v6 不通」会一路等到超时——同一容器里 `curl` 是 200，体检却每次报 `请求失败：fetch failed`，久了这条警告就没人看了。现在第一次 fetch 失败后会兜一次 IPv4：`dns.lookup(family:4)` 拿到 A 记录、按 IP 直连、`servername` 保留 SNI（等同 `curl -4`），成功则报绿并在证据里写明「IPv4 兜底成功，<IP>」。
  实测（面板容器内）：`fetch()` 三条 URL 全部失败，同源 `getV4()` 全部 HTTP 200。

### 文档

- `AGENTS.md` §8 排障速查补一行、新增小节「公网 502、本地却是 200」：`ss -ltnp | grep 8080` 看到两条 caddy 就是 SO_REUSEPORT 抢端口——本地调试起的 `caddy-test` 忘了收，它会用旧配置把面板域名指到已经停掉的旧颜色端口，于是公网随机 502、本地带 `Host` 头打 8080 也时好时坏。处理：只留生产那个，调试改用 8089 / 20299 这类高位端口。

### 验证

- `node --check src/core/selfcheck.js` 通过
- 容器内实测 getV4 兜底全部 200（172.67.206.9 / 104.21.69.69）
- 升级后 `/api/selfcheck` 期望 14/14（升级前 13/14，唯一 warn 就是这条出口探针）

## v0.29.42

## 下发串行化：并发推送不再互相覆盖

修掉一个会让「维护模式 / IP 黑名单 / 分享链接」看似失效的真 bug。

- **根因**：`src/core/pusher.js` 的 `schedulePush()` 只防「重复排期」（`if (pushTimer) return`），不防「已经在飞」。而 `pushCaddy()` 内部 `await fetch(CADDY_ADMIN + '/load')` 是异步的，于是两条推送可以同时在飞，Caddy 的 `/load` 是**后到覆盖先到** —— 先发出的那份配置如果后落地，就把后来的状态冲掉。典型场景：建分享链接（推 A：维护关）与开维护模式（推 B：维护开）几乎同时发生，A 后到 → 维护路由被冲掉，本该 503 的请求落回面板自身的 401。
- **修法**：`pushCaddy()` 拆成 `pushOnce()`（逻辑一行未动，含 admin 候选地址、`Origin` 头、8s 超时、`caddy.routeCount` 与「已下发 N 条代理规则」日志）与新的单飞外壳：任何时刻最多一条 `/load` 在飞，飞行途中的改动打 `dirty` 标记，结束后重新 `buildCaddyConfig()` 拿最新 state 补推一次。对外接口（`/api/caddy/push`、各 handler 里的 `await pushCaddy()`）语义不变。
- **复现与验证**：用假 Caddy admin（奇数号 `/load` 慢 400ms、偶数号立即返回，模拟「先发后到」）跑并发探针 —— 并发「建分享 + 开维护」后取最终落地的配置：
  - 打补丁前：`hasMaintenance=false`、`hasShare=true`（维护路由被冲掉）→ 1 条失败
  - 打补丁后：`hasMaintenance=true`、`hasShare=true` → 4/4 通过

## 验证

- 并发下发探针 4/4（打补丁前 3/4，失败项就是维护路由丢失）
- DOM 回归 236/236
- 发布后对生产面板复跑 API 回归，此前 8 条「经 Caddy 127.0.0.1:8080 取证」的失败应全部转绿

## v0.29.41

## 界面收尾：空态、可读性、分区与吸底保存

第二轮界面走查后的一批细节修补，全部集中在 `src/web/`，不动后端逻辑。

- **空态与加载态**：工具箱「读不到 Docker」从一行灰字换成带标题、修复提示和重试按钮的空态卡；「一次性分享链接」空态补上到期说明；链路自测的两个输出框在没跑之前显示占位文案，不再是两块空白。
- **数据可读性**：监控「体检历史」补「最早 / 最新」轴与四色图例；观测热门路径 chips 从 `×51` 改成 `51 次`；规则命中表把挤在一列的 `P50 / P95 / 最慢` 写清成 `P50 2 · P95 36 · 最慢 160 ms`；隧道页「另外 194 条请求打在不属于任何出口的域名上」收进可展开折叠。
- **布局与层级**：设置页分区导航分「常用 / 进阶」两组，「怎么申请隧道」降级成 `?` 入口；设置页新增吸底「保存设置」栏，改完不用滚回右上角；工具箱把「边缘缓存 / 清理与预热 / DNS 记录」拆成三个带小标题的小节；右上两个链接改名为「Prometheus 指标」「README 徽章」。
- **一致性**：告警空态压成一行（原来撑出 250px 空框）；Grafana 卡在 iframe 起来前先说「滚动到这里会自动加载」，不再谎称正在连接；表格数字统一等宽对齐。

上一版遗留的三项也在本版一起发布：侧栏「一键体检」改实线描边不再像禁用；滚动升级默认只监听 `127.0.0.1:8080`；`tools/release.sh` 的 push 判据改用 `git push` 退出码。

## 验证

- DOM 回归 236/236（预览实例，含新 CSS 与全部前端改动）
- API 359–361/367：8 条失败全部落在「经 Caddy 127.0.0.1:8080 取证」一类，根因是本部署 `local1`（`host=127.0.0.1 path=/`）兜底把请求接进面板回 401，与本版无关
- 逐页截图复核：工具箱 / 监控 / 设置 / 观测 / 隧道

## v0.29.40

**这一版只动前端表现，接口与数据结构一个没改。** 七个页面（概览 / 规则 / 隧道出口 / 观测 / 工具箱 / 监控 / 设置）外加登录页，全部收敛到同一套设计令牌上。

### 修掉的真 bug

- **82 个输入框掉样式**：基础表单规则原本是 `input[type=text], input[type=password]…` 白名单，而面板里大量 `<input>` 根本没写 `type`，于是它们全掉回浏览器原生外观 —— 登录页的用户名框是重灾区。改成排除法 `input:where(:not([type=checkbox]):not([type=radio])…)`，一次覆盖全站。
- **三处悬空变量**：`--card`、`--bg2`、`--acc-bg` 被引用但从未定义，导致登录卡背景、设置页吸顶分区导航底色、侧栏快捷按钮 hover 全部失效。补齐后设置页的 16 个分区终于有了可辨的吸顶条与当前段高亮。
- **`button.sm` 管不到 `<a class="sm">`**：快捷动作那排链接按钮一直比旁边的按钮胖一圈，选择器改成 `.sm` 后统一。
- **出口在线历史 X 轴出现两个 `3:00`**：`chartLabels()` 按 `getHours()+':00'` 出标签，分钟级采样时落在同一小时的两次抽样都渲染成同一个整点。改成按标签文本去重、分钟级只在整点标。
- **主题闪烁**：`<html data-theme="dark">` 是写死的，脚本跑完才改成浅色，每次刷新闪一下深色。现在主题判定放进了 `/boot.js`（CSP 不允许内联脚本），并在 `<head>` 里早于样式表加载 —— 首帧就是对的。深色、浅色两条路径都实测过。

### 交互与信息密度

- **规则页从 1668px 压到 1000px**：7 条规则原本全部摊开、每条常开四个输入框，误改风险高。改成一行一条（序号 / 名称 / 标签 / 路径 → 上游 / 操作），▸ 展开才编辑，新增规则自动展开并聚焦路径。
- **规则页顶栏减负**：时间窗、模板、导入移到「更多 ▾」抽屉，头部只留搜索与「＋ 添加规则」。
- **概览页页尾的快捷动作卡收进命令面板**：6 个平铺按钮改成一行提示 + 「打开命令面板 ⌘K」，6 个入口同时补进 `⌘K` 列表。
- **「最近请求 200」改成「请求总数」**：那个 200 是 12 小时请求总数，原来和 HTTP 200 撞脸，中英文两个字典键同步改。
- **最近日志折叠态不再被硬切**：`max-height` 取行高整数倍（128px）并在顶部加渐隐 mask，切边看起来是设计而不是故障。

### 设计系统

- 令牌层补齐语义色（`--ok/--warn/--err` 各带 `-soft`、`-line`），43 处硬编码 `rgba()` 收进变量；字号从 11.5/12.5/13.5 这些半档收成 11/12/13/14/15/20/26 七档。
- 断点从 15 个碎块合并成 1200 / 900 / 720 三档 + `pointer:coarse`，删除重复声明（`.chart` 高度、`.tbl-wrap` 溢出、`.side-foot` 各只留一处）。
- 按钮补 `:active` 位移与 hover 底色；`:focus-visible` 不再偷偷把 8px 圆角改成 6px；新增 `prefers-reduced-motion` 兜底。
- 移动端：`.grid2.top` 因选择器权重压不住而并排越界，改成 `.grid2,.grid2.top,.grid2.obs-mid,.grid3` 一起塌成单列；统计卡两列；导航换行不再横向藏起三个入口。
- 登录页：输入框 38px 统一、密码框保留 44px 右留白给「眼睛」、主按钮加投影与 hover 位移、三个功能图标与眼睛换成内联 SVG（原来是 ◧ ⤳ ◫ 👁 字符，在中文环境下像豆腐块）。

### 验证

- DOM 回归 **236/236**（含 CSP 内联脚本检查）。
- API 回归 **359–361/367**：8 条失败全部落在「经 Caddy 8080 取证」的断言上，根因是本部署有 `host=127.0.0.1 path=/` 的兜底规则把所有请求接进面板（面板回 401），与本版改动无关；换 `Host: e2e-no-rule.example.test` 打同一路径能正常拿到 Caddy 的 404。
- 端到端 **39/39**（含维护模式、IP 黑名单还原、跨实例只读备份）。

## v0.29.39

上一版（0.29.38）只保证了「旧 cloudflared 最终会死」，但重启的瞬间仍然是**先 SIGTERM、同时起新进程**：优雅退出要好几秒，这期间同一条隧道就出现两个连接器 —— Cloudflare 侧看到 3 个，`/connections` 里全是本机地址。

这次把顺序改对：

- 起新进程前先 `SIGKILL` 旧的，立刻断开，不再有并存窗口。
- 退役进程的 `exit` 事件直接返回：不再把 `rt.proc` 置空、不再触发自动重试（否则「旧进程死了 → 自动重启」会再补一个连接器，越重启越多）。

### 实测

连续调用 3 次 `POST /api/tunnels/<id>/restart`，容器内 cloudflared 数量始终是 **2**（两个出口各 1 个），公网 `/login` 抽样 15/15 正常。

### 为什么值得单独一版

同一条隧道出现多个连接器时，Cloudflare 会把请求分流到**任意**连接器。8 月那次 `panel.jianghugs.shop` 一半请求被一台跑 frp 的机器接走，就是这种形态 —— 那条机器上的 `:8080` 是 frps，回的是 frp 的 404 页。本机自己的重复连接器虽然都指向同一个面板、后果轻得多，但一样会让「哪台机器在服务我的域名」变得不可解释。

## v0.29.38

**这次的 bug 是这轮事故的真正尾巴。**

昨天 `panel.jianghugs.shop` 大约一半请求被一台跑着 frp 的陌生机器接走。根因是那条隧道有多个连接器；而本机为什么也会多出连接器，是 `stopTunnel()` 的兜底写错了：

```js
setTimeout(() => { if (rt.proc === p) p.kill('SIGKILL'); }, 5000);
```

如果这 5 秒里 `startTunnel()` 又起了新进程，`rt.proc` 已经换人，条件永远不成立 —— 旧 cloudflared 带着旧 token 一直挂在 Cloudflare 上（容器里一度 6 个 cloudflared，预期 2 个）。现在改成无条件兜底：5 秒后只要那个子进程还活着就 `SIGKILL`，并记一条日志。

### 顺手修的

- 回归断言：`src/core/tunnels.js` 里必须出现 `p.exitCode === null && p.signalCode === null`，且不再出现 `if (rt.proc === p) p.kill`。
- 测试不再写死 `main` 出口（它已经被删了）：改成取当前真实存在、且有公网地址的出口来绑探针规则，没有就跳过并说明。

### 现状

- 两条出口：`a6cd34c6`（demo）、`5c795838`（面板专用，2026-11 新隧道）。
- 公网 `/login` 抽样 20/20 正常，`/healthz` leader，`drift: false`。
- 面板容器内 cloudflared 数量回到 2（用 `docker top` 可自查）。

## v0.29.37

### 面板里多了「怎么申请隧道 token」卡片

设置页新增分区（导航第一项）：**怎么申请隧道 token** —— 默认折叠，展开是五步操作 + 一张「现象 → 原因/处理」表：

- 建隧道（Networks → Tunnels → Create，选 Cloudflared）；
- 在安装命令里取 `--token` 后面那串（184 字符、`eyJh` 开头），或从 Tunnels 列表的 token 图标再取；
- Public Hostnames 必须加，否则 **1033**；
- 回面板粘贴（整条 `docker run …` 直接粘也行）；
- 验收：`curl -sI https://<域名>` 带 `cf-ray`。

表里覆盖 `1033`、`530/502`、「尚未检测到连接」、重连数上涨四种常见状态。同一份内容在仓库的 `docs/CLOUDFLARE-TUNNEL.md`，卡片里有链接。

## v0.29.36

### 留痕双闸：最多 300 条，最多 7 天

以前只按条数截断，跑得少的机器会把两个月前的记录一直留着。现在裁剪同时看两件事：**≤300 条** 且 **≤7 天**。`store.retainDays` 会随接口返回，体检卡与「关于」都能看到。

### 历史接口可以只取全量

`/api/selfcheck/history?scope=all` 过滤掉快速记录；同时新增 `scopes: {all, quick}` 给出窗口内的次数，前端不用自己筛。

### 体检卡底注带上口径

「最近 24 小时：全量 11 次、快速 3 次」——一眼看出聚合统计用的是哪部分数据。

## v0.29.35

### 快速体检也留痕，但不算进「失败统计」

`/api/selfcheck?scope=quick` 的结果现在会写进留痕文件，记录带 `scope: "quick"`；历史小条里它们淡一档显示，悬停标「快速」。**「最近 24 小时哪些项失败过」的聚合会跳过快速记录** —— 快速模式不探出口，把它的失败混进去会让人以为出口真的挂了。

### 体检范围会被记住

「全部 / 快速」存进 `localStorage`（`cfp-checkScope`），和「只看 5xx」「只看失败」一致，常点快速的人不用每次重选。

### 「已丢弃」标记可以点

历史条最左侧的斜纹格变成可点按钮，点一下说明留痕上限（300 次 ≈ 25 小时）与它代表什么。

### 发版脚本自己会重试 push

`tools/release.sh` 今天两次被 GitHub 的 SSH 抖动打断（`Connection reset`），现在 push 分支与 tag 都带 6 次重试 + `ls-remote` 校验，仍失败才退出并提示手工补推命令。

## v0.29.34

### 「只看失败」刷新后还记得

审计区的「只看失败」和「只看 5xx」一样存进 `localStorage`（`cfp-auditFail`），刷新页面不用重按。

### 体检可选范围：全部 / 快速

体检卡右上角多了一个下拉：

- **全部**：14 项都跑，包含要过 Cloudflare 的出口探测（冷启动约 3 秒）；
- **快速**：只跑 12 项静态检查（`/api/selfcheck?scope=quick`），跳过出口探测，通常 1 秒内出结果，排查「Caddy 通不通 / 磁盘够不够」时更快。

快速模式不写留痕——半套结果进历史会让「最近 24 小时」的统计失真。

### 历史小条上的「已丢弃」标记

留痕到上限（300 条 ≈ 25 小时）后会开始丢最早的记录；现在历史小条最左侧会多一个斜纹小格，悬停提示「更早的记录已被丢弃」，不再让人误以为那是全部历史。

## v0.29.33

### 审计：只看失败

审计区多了「只看失败」开关（`/api/audit?bad=1`），只留下 `ok:false` 的记录 —— 登录失败、口令错误、跨站请求被拦下这些平时混在正常操作里的行。和「动作」下拉、搜索、日期一起叠加。

### 点名写错会报错，而不是空列表

`/api/selfcheck?ids=caddy,no-such-thing` 现在返回 **400** 并附上可用项清单（`valid`），不再静默给一个空 `checks`；出口相关的动态项允许 `exit-<id>` 形式。

### 留痕接近上限会提示

体检卡底注在剩余额度 ≤40 次时补一句「再跑 N 次就会开始丢最早的记录」，跑满则写「已满，正在丢弃最早的记录」。

## v0.29.32

### 审计日志按「动作」筛

观测页的审计区多了「全部动作」下拉，候选是从最近记录里按出现次数排好的动作名（`停用规则`、`登录成功`、`接收外部告警回调`…），选中即过滤，和搜索框、日期一起叠加。服务端 `/api/audit?act=…` 支持精确匹配，`actions` 字段返回候选列表。

### `/api/selfcheck?ids=caddy,disk`

只想看某几项时可以直接点名，真的不会去探出口（最慢的那几次 HTTP 被跳过）。命中项按原顺序返回，`total` 等于实际跑的项数；**子集结果不写留痕**，免得半套数据把「最近 24 小时」统计弄失真。

### 留痕占用看得见

`/api/selfcheck/history` 多一个 `store` 字段（条数 / 字节 / 上限 / 最老一条时间）。监控页体检卡底注显示「留痕 42 条 / 12 KB（上限 300 条 / 256 KB）」，设置页「关于」也多一行同样信息 —— 上次那个 360MB 的历史文件就是因为没人看得见它长多大。

## v0.29.31

### 体检历史不再整块消失

之前「最近 24 小时哪些项失败过」这张表在没有失败时整块隐藏，看着像没这个功能。现在始终显示一句话：跑过两次以上是「最近 24 小时跑了 N 次体检，没有失败项」，记录不足则是「还没攒够体检记录（N 次）」。

### 停用规则单独记一条审计

`enabled` 切换以前在审计里只算「改规则」，事后翻记录看不出到底是停了一条还是重排了顺序。现在单条停用/启用会记 `停用规则 / 启用规则`，目标写规则名（同一请求的兜底记录会被审计自身的去重逻辑丢掉，不会成对出现）。

### `/api/selfcheck?only=bad`

外部脚本（cron + curl）只想看有问题的项时不用自己过滤 14 条：加上 `?only=bad` 只返回非 `ok` 的检查项，并多一个 `shown` 字段说明返回了几条。`total / ok / fail / warn` 仍是全量汇总。

## v0.29.30

### 停用规则：给一次「撤销」

`操作 ⋯ → 禁用/启用` 之后的提示条多了一个「撤销」按钮，6 秒内点它就能把规则恢复原状 —— 误点一下不用再翻菜单。提示条本身也支持第三参 `{label, fn}`，以后别的动作可以直接复用。

### 只看 5xx 的空态给出退路

开着「只看 5xx」但窗口内一条 5xx 都没有时，表格里原来只有「这组筛选条件下没有请求」；现在直接说明并给一个可点的「关掉『只看 5xx』」，点完立刻回到全部请求（同时把开关状态写回 `localStorage`）。

### 体检历史：每项一条失败趋势

24 小时聚合表新增「最近 N 次」一列，按时间从左到右排小格：绿色是通过、红色是那一次体检这一项失败，鼠标悬停显示时间。次数只说明「坏了多少次」，小格能看出「是一路坏还是偶尔坏一下」。

## v0.29.29

### 停用的规则看得出来

`操作 ⋯ → 禁用这条规则` 之后，规则卡会整卡变淡（`opacity: .66`）、路径与上游加删除线，并在名字旁挂一个「已停用」标签 —— 之前停用过的规则和正常的完全一样，很容易以为自己改坏了。

### 「只看 5xx」记住状态

排查错误时最常按的那一下，现在写进 `localStorage['cfp-only5xx']`，刷新页面仍然是开着的；再点一次恢复关闭并写回 `0`。

### 体检 JSON 带上机器信息

导出的文件现在长这样，别人拿到一眼就知道是哪台机器、哪个版本：

```json
{
  "exportedAt": "2026-11-23T13:40:12.345Z",
  "panel": { "version": "0.29.29", "code": "…", "imageCode": "…", "mode": "leader", "instance": "green-8095-…", "drift": false },
  "result": { "total": 14, "fail": 0, "warn": 0, "checks": [ … ] }
}
```

## v0.29.28

### 规则卡：一键停用 / 启用

`操作 ⋯` 里多了「禁用这条规则 / 启用这条规则」——临时摘掉一条规则不用再进编辑面板改勾选框。提交走的是整表 `POST /api/routes`，停用的规则保留在列表里（`enabled: false`），Caddy 里立刻不生效。实测：停用「演示服务（whoami）」后 `routeCount` 7 → 6、状态变 `enabled=false`，再启用回 7。

### 观测页：只看 5xx

筛选栏加了一个一键开关「只看 5xx」（`aria-pressed` 状态可见），只显示状态码 ≥500 的请求；和状态/路径/IP/时间范围叠加生效，按钮文案变成「只看 5xx · 开」时有提示。CSV 导出跟随当前筛选结果。

### 体检：导出本次结果 JSON

体检卡底部多了「导出本次体检 JSON」，把当前这次 14 项检查（状态 / 结果说明 / 建议 / 耗时）原样存成 `selfcheck-时间戳.json`，方便贴给外部排查或留档对比。

## v0.29.27

### 规则卡：六个按钮收成三条

规则卡右侧原来排着 ↑ / ↓ / 测 / 复制 / 导出 / 删 六个小按钮，在 1280 宽的屏上占掉近一半宽度，手机上一行放不下还会折。现在只剩 **↑ ↓ 操作⋯ 删**，「测上游连通性 / 复制这条规则 / 导出这条规则」进 `操作 ⋯` 菜单（和出口卡同一套菜单样式），点空白处收起。

### 观测页：手机上不再挤六列

访问统计表在 ≤720px 时会变成「一行一卡」，但「方法」「来源 IP」这两行在手机上基本没用，却把卡片拉得很长。现在这两格隐藏（时间 / 路径 / 状态 / 耗时 / 命中规则仍保留），桌面宽度不受影响。

### 体检：刚启动的重连不算抖动

`出口链路稳定性` 这一项原来把重启后的第一次重连也算进去，于是每次升级完体检都会短暂报警（14 项里唯一不是绿的那一个）。现在出口启动不到 60 秒时直接跳过判定，说明里写明是哪个出口刚起来 —— 真正的 QUIC 抖动仍然照报。

## v0.29.26

### 新增 / 改进
- **命令面板能重启单个出口**：搜索「重启」会出现「重启出口：主隧道出口」这类动作项，选中即重启那一条（域名不变，只对命名隧道开放 —— quick 隧道每次重启都会换域名）。
- **命令面板一屏能装下更多项**：候选上限 12 → 24（页面 + 动作 + 出口 + 单个出口重启 + 规则，原来后半截被截掉看不到）。
- **观测页筛选栏收纳**：「来源 IP」「时间范围」收进「更多筛选」，默认只占一行；收起时按钮会写「更多筛选 · 2」，告诉你有几个筛选还在生效。
- **手机上的规则排序**：触屏设备上「↑ / ↓」按钮放大到 38×38（拖动把手在手机上本来就拖不动，直接隐藏）。

### 修复
- 英文模式侧栏「一键体检」留中文 —— 词典补 `'一键体检': 'Health check'`。

### 质量门
- DOM 200/200、API 352/352。

## v0.29.25

### 修复
- **Grafana 卡的「线路 + 耗时」徽标会被 5 秒轮询冲掉**：`paintGrafana()` 每轮重绘卡头都会把徽标写回「局域网直连」，所以刚测出来的耗时一闪就没。现在把测量结果记在模块里（`gVia`），重绘时优先用它。
- **骨架撤掉后徽标停在无耗时状态**：2.2 秒撤骨架时先写「局域网直连 · 画图中…」，等 iframe 真正 `load` 再换成实测秒数（实测局域网直连 16s、经公网 40s+）。

### 结果
`/` 概览卡右上角现在是「局域网直连 · 16s」，鼠标悬停说明走的哪条路、慢怎么改。

## v0.29.24

### 新增 / 改进
- **侧栏「一键体检」入口**：导航下面一个虚线小卡，点一下直接到监控页并把 12 项检查跑完（原来要先进监控页再找按钮）。
- **Grafana 卡标注线路与耗时**：右上角徽标从「局域网直连」升级成「局域网直连 · 0.9s」/「经公网 · 41s」，鼠标悬停说明走的哪条路、慢的话怎么改。
- **规则的主机名单独成徽标**：概览迷你表和规则卡里，只对某个域名生效的规则不再把域名塞在路径旁边，改用灰色等宽徽标，扫一眼就能区分「所有主机」和「只对 grafana…」。
- **出口卡按钮收口**：卡片头只留「操作 ⋯」和「删除」，重启/启动/停止/二维码/复制都进菜单（六个按钮挤一行的问题彻底没有了）。

### 修复
- `pre.log.collapsed` 之前被 `pre.log` 的 `min-height:220px` 撑住，折叠/展开看不出差别，现在折叠 120px、展开跟内容走。
- 概览右侧 Grafana 卡在加载失败时也会写清「走的哪条路 + 等了多久」，不再只说「没加载出来」。

### 质量门
- DOM 197/197、API 352/352；`drift: false`；体检 14 项 0 失败。

## v0.29.23

### 观测页瘦身：2170px → 1687px

「可疑访问」与「规则命中统计」并成一行（都是五行小表，半宽读得下去）；审计日志保持整行宽 —— 半宽时 5 列会被挤成一字一行，试过又改回来了；面板日志默认折叠，需要时点「展开」。

折叠态以前被 `min-height:220px` 撑着，展开/收起看不出差别，现在补了 `min-height:0`。日志还没吐数据时显示「正在连接面板日志…」，不再是纯黑一块。

### 概览规则表省掉一整列

所有规则都是全局时，「作用域」列 6 行全是「全局」。现在整列不显示，只有真的存在「仅限单出口」的规则时才出现。

### 命令面板能干活了

Ctrl+K 除跳页面外新增三个动作，选中就地执行、不跳页面：

- **一键体检** —— 跳到监控页并直接跑一次
- **重新预热边缘缓存** —— 就地执行，提示预热了几个资源
- **重启全部出口** —— 重启所有命名隧道出口

### 质量门

- DOM **194/194**（新增 4 条：观测并排布局、面板日志默认折叠、无单出口规则时不显示作用域列、命令面板含动作项）
- API **352/352**

## v0.29.22

### 设置页变短了：6244px → 1000px

15 张卡片一次只显示一个分区，顶部那排分区导航就是页签：点它切换、地址栏跟着变（`#sec-backup`）、刷新后还记得上次在哪个分区。搜索是例外 —— 搜索框有内容时跨分区搜，匹配的分区都列出来，清空后回到当前分区。卡片仍然都在 DOM 里，锚点、表单、测试选择器都不受影响。

### 概览两卡不再强制等高

出口只有 2 条时，左边「隧道出口」被右边 7 行规则表拉到 297px，实际内容只有 198px。现在按内容高度排。

### 审计历史清掉测试流量

`tools/clean-audit.cjs --apply --drop-invalid`：删除 1287 行（回环 127.0.0.1 ×994、RFC 5737 文档网段 ×213、缺字段的早期记录 ×40），保留 2 行真实访问。概览「变更趋势」的 542 次改动 / 498 次失败归零，此后只统计真实操作。清理顺手发现：0 字节的审计文件会以「0 B」挂在日期下拉里，现在跳过。

### 质量门

- DOM **190/190**（新增 4 条：一次只显示一个分区、点标签能切换、搜索跨分区、并排卡按内容高度）
- API **352/352**

## v0.29.21

### 这轮是 UI 巡检的收口

截图 + 逐页量测 7 个页面，挑出 7 处修掉：

- **设置页「关于」把面板请求总数渲染成 `undefined`**（`total` 在 `panelRequests` 顶层、`2xx/3xx…` 在 `byStatus` 里，前端只取了后者）。
- **概览「代理规则」表加「主机」列**：两条 `/` 规则（面板自己、Grafana）之前长得一模一样，现在写明主机；6 个「全局」标签降级成浅色文字。
- **「其中 0 条仅限单出口」** → 「全部对所有出口生效」。
- **出口卡不再显示「0 条仅限此出口」**。
- **卡片头部的「刷新」被挤成两行**：按钮加 `white-space:nowrap`（这条规则之前只在 720px 断点里），卡片标题同样不再拆行。
- **监控页**：「1/2 正常（1 为备份槽位）」换行 → `1/2 正常 · 备份槽位 1`；体检历史「上次 287 分钟前」→「上次 4 小时 47 分前」。
- **测试不再污染审计**：不带鉴权的测试请求也打 `x-cfp-test`，概览「变更趋势」的失败数不再被测试刷高（之前 100 次）。

### 质量门

- DOM **186/186**（新增 3 条：规则表主机列、设置页无 `undefined`、0 条专属规则不显示标签）
- API **352/352**

## v0.29.20

### 测试不再改生产设置

API 回归里有两处会把 Grafana 设置写成测试值（`url: http://192.168.1.55:3000`、`theme: dark`、只留一个 panel），跑完不还原 —— 于是每次跑测试，线上「监控嵌入」就被改成测试配置，配置好的局域网地址被抹掉、主题被改回深色。

现在测试开跑前把 `settings.grafana / monitoring / notify` 一起快照，跑完（含 Ctrl+C）统一还原；输出里会打印「已还原测试前的设置」。

### 质量门

- API **352/352**（跑完后 `lanUrl`、`theme`、`url` 与跑之前一致）
- DOM **183/183**

## v0.29.19

### 骨架不再挡住已经画出来的图

Grafana 的 d-solo 页要等所有 bundle 跑完才触发 `load`，而骨架屏是绝对定位盖在 iframe 上的 —— 所以局域网直连之后图其实已经在画了，用户看到的还是「正在连接 Grafana…」。

现在骨架 2.2 秒后先撤，`load` 只负责收尾；真正的失败判定（50 秒没出来 → 「这块图没加载出来 + 重试」）不变。

### 顺手

- CSP、`lanUrl` 校验的既有测试改成「恢复测试前的值」而不是写死空值（生产上现在真的配了局域网地址，不能被测试抹掉）。
- 文档与体检说明同步：`Grafana` 一项在配了局域网地址后走本机探测（实测 38ms，之前 1.7 秒）。

### 质量门

- DOM **183/183**（新增 1 条：骨架到点先撤）
- API **352/352**

## v0.29.18

### 体检历史：从"最近发生的"到"反复发生的"

监控页体检卡下面多一张表：最近 24 小时里**哪些检查项出过问题**、各几次、最后一次什么时候、什么说明，次数多的排前面。

以前只有一条 40 次的细条，能看出"刚才失败了"，看不出"Grafana 老是超时"。加了聚合表以后，第一次跑就把真问题照出来了。

### 它照出来的假失败

`Grafana` 这项原来打公网主机名（要穿过 Cloudflare 隧道），超时定的是 3 秒 —— 于是体检时好时坏，24 小时里报了 4 次超时。现在：

- 优先用局域网地址探测（配了 `lanUrl` 时），不再绕一圈公网；
- 超时放宽到 6 秒；
- 超时/连不上只算「注意」并说明"可能只是慢"，不再算失败。

### 老配置快照压 gzip

最近 10 份保持明文（方便直接看和 diff），更老的自动压成 `.json.gz`；读回快照、列快照、按快照回滚都照常。这个实例实测 **441KB → 146KB**。

顺带修掉一个真 bug：同一毫秒里连写两份快照会用同一个文件名互相覆盖（脚本里真的会发生），现在撞名自动加序号。

### 质量门

- API **352/352**（新增 8 条：窗口聚合字段、聚合计数与最后一次说明、ISO 时间串兼容、快照压缩数量、压缩后能读回、快照不撞名）
- DOM **182/182**（新增 2 条：聚合表容器、渲染函数按项目计数）

## v0.29.17

### 修了什么

- **测试不再靠"睡一会儿"**：DOM 回归里十几处固定 `setTimeout` 换成「轮询到条件成立为止」（`waitFor`）和「等到真的发生了一次 5 秒轮询」（`pollTick`，按 `/api/state` 的调用次数判定）。固定等待在机器忙、面板刚重启时会"还没渲染完就断言"——这正是之前偶发 177/179 的来源；整套 DOM 测试也快了几十秒。
- **顺手修掉一个真 UI bug**（被新写法照出来的）：从「按规则看流量」点进来时，规则会闪一下高亮，但 5 秒轮询重绘一次列表，`data-focused` 标记就丢了 —— 高亮"闪一下就没"。现在记住被聚焦的规则，每次重绘补回去；规则被删或换作用域时自动清除。

### 质量门

- DOM **180/180**（新增 1 条：轮询重绘后焦点标记仍在）
- API **344/344**

## v0.29.16

### 修了什么

- **出口的网络重连终于看得见**：cloudflared 到 Cloudflare 边缘的 QUIC 连接断了会自己重连 —— 进程没退出，所以原来那个「重连 ×N」永远不动，但访客那一刻就是「网站抽了一下」。现在解析 cloudflared 输出里的重连信号（同一波重连 5 秒内只算一次）：
  - 出口卡片上出现「网络重连 ×N」徽标（最近 10 分钟 ≥3 次标黄；鼠标悬停看累计次数与最近一次时间）；
  - 体检新增第 14 项「出口链路稳定性」，抖动时提示把协议从 `auto` 改成 `http2`（走 TCP，穿 NAT 更稳）。
- **顺手抓到并修掉一个真 bug**：`data/backups/` 现在还有 `audit-cleanup/` 子目录，而「备份列表」原来不过滤扩展名 → 最新一份"备份"指向一个目录，下载返 400；同一处按数量裁剪的循环会在 `unlink` 目录时抛错，被外层 `catch` 吞掉，结果**备份永远不清理**。两处都改成只认 `.json`，裁剪时单条失败也不再影响其它。
- `data/audit/` 里两份早期清理留下的 `.backup-audit-*.jsonl`（2.2MB）挪到 `data/backups/audit-cleanup/` —— 这种文件名不被保留期清扫匹配，会一直躺着。

### 质量门

- API **344/344**（新增 3 条：体检含「出口链路稳定性」、`/api/state` 的出口带 `flaps10m`、备份列表只列 `.json`）
- DOM **179/179**

## v0.29.15

### 修了什么

- **健康检查不再刷日志**：面板槽位原来无条件下发 `health_checks`，而平时另一色是停着的 —— 每 2 秒一次的探测失败在 Caddy 日志里堆到每天十几万行（实测占 **99.85%**），把日志填满、轮转变快，趋势图能覆盖的窗口跟着缩水。现在只有对端真的在监听时才下发健康检查；对端离线时连上游列表里都不留它（否则每个请求都要先吃一次 connect refused）。
- 槽位上下线由守护线程发现并自动重推一次配置，滚动升级期间仍是双上游 + 健康检查，切换窗口没变差。
- 体检新增第 13 项「访问日志」：报最近 10 分钟访问行/健康检查行的数量与噪音占比，以及访问行能回溯多久 —— 这项以前完全不可见。

### 实测

| 场景 | 结果 |
|---|---|
| 对端离线 | 上游只剩自己，`health_checks` 不下发 |
| 对端起监听 | 4 秒内自动恢复双上游 + 健康检查，并打一行「已上线，恢复双上游负载均衡」 |
| 日志噪音 | 改动前 20 秒新增 20 行健康检查；改动后 20 秒 **0 行** |

### 质量门

- API **341/341**（新增 2 条：对端离线只留一个上游、不下发健康检查）
- DOM **179/179**

## v0.29.14

### 修了什么

- **趋势图不再被日志轮转切断**：流量与按规则聚合一直只读当前 `access.log` 的尾部 2MB，Caddy 每 10MB 轮转一次，窗口内更早的记录就丢了。现在把窗口内的轮转文件（`.gz`，最多 3 个、每个上限 4MB）一起读进来。
- **只解析访问行**：日志里 99% 是健康检查对「停着的那一色」的失败重连（每天十几万条），原来整段 `split('\n')` 再逐行判断；改成按 `"logger":"http.log.access` 定位，只切真正要解析的行。
- **加 30 秒结果缓存**：小时粒度的图看不出差别，但 Jetson 上省下每 5 秒一次的 600ms 解析。

### 实测

| 项 | 结果 |
|---|---|
| 冷启动解析 | 190ms（原来 600ms+） |
| 缓存命中 | 0ms |
| 轮转文件内的记录 | 计入（临时目录构造 gz + 当前文件，三行全中，502 计为错误） |

### 质量门

- API **339/339**（新增 2 条：轮转文件里的流量计入趋势、按规则聚合同样跨轮转）
- DOM **179/179**

## v0.29.13

### 流量趋势为什么一直是 0

`trafficByHour()` 与 `trafficByPath()` 原来这样造桶：

```js
const start = now - hours * 3600 * 1000;
for (let i = 0; i < hours; i++) keys.push(new Date(start + i * 3600 * 1000).setMinutes(0, 0, 0));
```

`start` 带着当前分钟，取整后第一个桶被压到整点，最后一个桶就落在**上一小时**；遍历日志时 `if (!b) continue` 于是把「当前这一小时」的所有行都丢了。流量都发生在最近一小时里的时候，概览页就显示「合计 0 次」，而规则统计里明明有几十次请求。

现在改成以 `nowHour` 为基准倒推：

```js
const nowHour = new Date(now).setMinutes(0, 0, 0);
for (let i = hours - 1; i >= 0; i--) keys.push(nowHour - i * 3600 * 1000);
```

窗口包含当前（未满）小时；`/api/traffic` 与 `/api/traffic/paths` 一起修好。

### 另一个小别扭

监控页「抓取目标」在滚动升级期间显示「1/2 正常」，看着像有故障。现在写成「1/2 正常（1 为备份槽位）」，与表格里的「备份槽位」标注一致。

### 验证

- 修前 `/api/traffic?hours=12` 合计 **0**；修后 **114**（当前小时桶 = 21:00）。
- API 测试 **337/337**（新增 3 条：最后一个桶必须是当前小时、桶按整点连续、按规则流量同样含当前小时）。
- DOM 测试 **179/179**。

## v0.29.12

### 修掉一个自己造成的事故

体检历史文件 `data/selfcheck/history.jsonl` 被一条转义爆炸的记录撑到 **360 MB**（24 行，最大单行 218 MB）。旧实现每次体检都 `readFileSync` 整读 + `writeFileSync` 整写，实测 **22.5 秒**，而定时体检每 5 分钟跑一次 —— 面板会周期性卡死 20 秒，`/api/selfcheck`、`/api/selfcheck/history` 直接挂住。

现在：

- `persist()` 改成**追加写**（O(1)），只在文件超过 256 KB 时裁剪；
- 单条记录限长 2 KB（`bad` 最多 8 条、`detail` 截 200 字），异常大的记录退化成摘要；
- `history()` 用 `tailLines()` **从文件尾部倒着读**，凑够条数就停，不再整读；
- 已有历史文件已清理（保留合法记录，删掉爆炸行）。

### 顺手做的两件小事

- 监控页「一键体检」卡片底部加了**体检历史小条**：一次体检一根柱子，绿=全通过、琥珀=有警告、红=有失败，悬停显示时间、通过数与失败项名字。
- 抓取目标表里停着的那一色不再标红 `DOWN`，改成「备份槽位」（滚动升级时两色互换，停着的那侧不是故障），错误列也不再刷 `connection refused`。
- 图表无障碍：每张图的 `aria-label` 带上数值摘要（「最近 12 小时访问量柱状图：合计 1 234 次…」），并补 `<title>/<desc>`。

### 验证

- API 测试 **334/334**、DOM 测试 **179/179**。
- 体检接口：首次 3.2s（冷启动探测出口），之后 0.7–0.9s；历史接口 4–13ms（此前 48 秒）。
- history.jsonl 稳定在几百字节到几十 KB。

## v0.29.11

- **定时体检**：面板每 5 分钟自己跑一遍 12 项检查（只主实例跑），从正常变失败、从失败恢复正常时走通知通道告警
- **结果留痕**：`data/selfcheck/last.json` + `history.jsonl`（最多 200 次），侧栏显示「· 体检 12/12」并带上次时间与失败项
- **监控页开机即显示上次结果**：「上次体检 3 分钟前，12 项全部通过」
- `GET /api/selfcheck/history?limit=` 供外部取最近结果
- **少报假警**：走 Cloudflare 的出口探测给到 6 秒，超时按「慢」处理而不是「坏」

## v0.29.10

出问题时别再一条条 curl 了。

**一键体检**（监控页顶部）

一个按钮，12 项检查并行跑完，最慢 3 秒；每条都给「结论 + 证据 + 怎么办」：

| 检查 | 能发现什么 |
| --- | --- |
| 版本与代码指纹 | `docker cp` 热替换导致跑的代码 ≠ 镜像里的代码 |
| 实例角色 | 一直停在 standby（主实例租约没释放） |
| Caddy 管理接口 | Caddy 容器没起来、admin 端口不对 |
| 规则数一致 | 最后一次下发没完全生效 |
| 规则遮蔽 | `path: /` 把同域名其它路径吃掉（401/530 那个老坑） |
| 每个出口 | cloudflared 没在跑，或对端 5xx / Cloudflare 1033 |
| Prometheus 就绪 + **真的抓到面板** | 光 ready 不够，还得确认它抓的是活的那一色 |
| Grafana | 数据库没就绪、URL 写错 |
| 数据盘 / 状态文件 | 审计和备份写不进去的前兆 |

顺手修：监控页「抓取目标 1/2 正常」以前一直标红 —— 双槽位部署下停着的那一色必然 down，现在只有「非槽位目标」挂了才算故障。

**审计历史清洗**

`tools/clean-audit.cjs`：审计里 99.5% 是开发期我打出来的测试流量（`/api/settings` 2264 次、`/api/login` 1569 次、`/api/match` 502 次……全来自回环地址和 RFC 5737 文档网段）。已清理 11,969 行，保留 2 行真实访问，每个文件都留了 `data/audit/.backup-*` 备份。「变更趋势」从此是真实数据（会从 0 开始长）。

用法：

```bash
node tools/clean-audit.cjs              # 演练，只打印报告
node tools/clean-audit.cjs --apply      # 真删（先备份）
```

**测试**：DOM 175/175、API 327/327。

## v0.29.9

页面切到后台就别再空转了。

**改了三个地方**

- **轮询改成「可见才跑」**：以前概览/隧道/规则/观测/监控/工具箱都不管页面在不在前台，每 5 秒拉一次 `/api/state`、重画三张图。手机锁屏放一晚上，就是几万次没必要的请求。现在统一用 `cfpEvery()`：`visibilitychange` 一进后台就 `clearInterval`，回前台立刻补一次再恢复节拍。
- **SSE 日志流在后台断开**：日志流是服务端一直推的，切到别的标签页也在推。现在切后台就 `close()`，回来再连。
- **中文兜底扫描自停**：为了不漏译动态内容，页面上有个 2.5 秒一次的整树扫描。它其实只在启动早期有用，现在补 24 次（约 60 秒）就停，后面靠 `MutationObserver`。

**顺手**

- 手机顶栏那排小按钮（☀️ / ⌘K / EN / 退出）从 26px 加到 34px，手指能点准了。

**实测**（无头浏览器数请求）

| 场景 | `/api/state` 次数 |
| --- | --- |
| 前台 11 秒 | 3 |
| 切到后台 12 秒 | **0** |
| 切回前台 6 秒 | 2（立刻补一次 + 恢复 5 秒节拍） |

**测试**：DOM 172/172、API 322/322（新增：`cfpEvery` 可用/可停、`visibilitychange` 监听、兜底扫描有限次、日志流后台断开）。

## v0.29.8

让 Grafana 的图走局域网，顺便清了几个小毛病。

**新增：Grafana 局域网直连**

经 Cloudflare 隧道嵌 Grafana，一张图要把几十个 bundle 各拉一遍，实测首次 40 秒以上。
现在「设置 → 监控嵌入」多了一个可选的「局域网直连地址」（如 `http://192.168.1.55:3000`）：

- 面板自己用 `http://192.168.x.x:8090` 打开时优先走它 —— 实测从 40 秒降到 **1 秒内**；
- 经公网 `https://panel.…` 打开时仍用正式地址（https 页面里嵌 http 会被浏览器按混合内容拦掉）；
- 概览页那张卡的右上角会标「局域网直连」，一眼能看出当前走的是哪条路；
- 面板的 CSP `frame-src` 会同时放行两个源（以前只放行正式地址，局域网地址会被拦成一块灰板）。

**修复**

- **灰板没有原因**：被 CSP 拦掉的 iframe 也会触发 `load`，界面看起来"加载完成了"、其实一片灰。现在监听 `securitypolicyviolation`，把这种情况判成失败并写清怎么放行。
- **预热结果看着像出错**：第一次预热必然是 0 命中（全是 MISS 到源站），文案却写「0/4 命中缓存」。改成「已把 4 个资源推进边缘缓存，下一次访问就是 HIT」。
- **骨架撤太快的割裂感**：iframe `load` 只代表文档加载完，Grafana 还要画几秒图，中间会露出它自己的灰底 Loading。现在先换成「Grafana 已连上，正在画图…」，1.2 秒后再撤。
- **手机端观察页整页 677px 宽**：卡片头右侧那排控件（时间范围 + 状态筛选）不换行，把页面撑开。窄屏下改成换行 + 控件自适应，7 个页面实测都回到 390px。
- **手机端小链接太难点**：正文里的路径链接、`⋯`、小按钮只有 20–24px 高。窄屏统一拉到 30px（表格内保持 24px，免得把行撑高）。

**测试**

- DOM 166/166、API 322/322（新增：局域网地址校验/回显、CSP 同时放行两个源、概览徽标位、设置页输入框）。

## v0.29.7

第三轮界面反馈（3 条，都在概览页）。

**修复**
- **顶部横幅不再夹在两张卡中间**：原来那条「代码已更新」的黄色提示夹在监控面板和日志之间，文案又全是内部术语（指纹、预热、资源 URL），很容易被当成报错。现在挪到页面最上方、带关闭按钮（按版本记：下次换版本会重新出现），文案改成「面板换过版本（be6350f4 → 96049050），边缘缓存里还是上一版的资源，首个访客会慢一点。点重新预热把新资源准备好」。
- **横幅永远关不掉的 bug**：预热接口存的是 8 位短指纹，横幅却拿 16 位全指纹比对，两者永远不相等 → 现在两边都截 8 位。
- **Grafana 嵌入不再是一块黑底**：设置里的主题从固定 `dark` 改成「跟随面板」，嵌入 URL 会带 `theme=light`；`.gframe` 加浅色底与描边，深色图也有明确边界。主题选项文案也改成「跟随面板（推荐）/ 固定深色 / 固定浅色」。
- **三张图表卡的摘要统一贴底**：卡片改成 flex 列、图表 `flex:1`、摘要 `margin-top:auto`，「变更趋势」的摘要不再比旁边两张高一截。
- **Grafana 首次加载判定放宽到 50 秒**：实测经 Cloudflare 隧道打开一张 d-solo 面板要 43 秒，原来 25 秒就判失败、点重试还是慢。现在 8 秒 / 30 秒只换安抚文案，50 秒才报失败，失败文案也写清了原因。

**变更**
- 预热横幅加 `role="status"`，关闭按钮带 `aria-label`。
- 新增 13 条中英文界面词条。

## v0.29.6

- `package.json` 补齐发布元数据：`description`、`license`、`repository`、`homepage`、`bugs`，全部指向改名后的 `github.com/jianghugs/cf-tunnel-panel`（旧 `Adam-cell-tech` 是**同一账号改名**，Secrets / 包命名空间 / Issue / Star 都原样保留，无需迁移）。
- 全仓扫描确认无 `Adam-cell-tech` 残留；workflow 里的镜像地址统一用 `${{ github.repository }}`、Release 正文用 `$GITHUB_REPOSITORY`，所以以后账号再改名也不需要改代码。

## v0.29.5

- 新增 `tools/release.sh`：一条命令完成发版 —— 升 `package.json` 版本 → 把 Release 说明插进 `CHANGELOG.md` 顶部 → 提交 → 打 `vX.Y.Z` tag → push；加 `--build` 还会构建镜像、打 tag、跑滚动升级，并校验 `/healthz` 的 `version` 与 `drift:false`。
- 脚本是幂等可试的：`--dry` 只打印计划不写文件，`--no-push` 只本地提交打 tag，`--force` 允许脏工作区/同版本；版本号格式与已存在 tag 都有校验。
- README（英/中）的「Releases 与预构建镜像」小节改成先介绍脚本，再给手工三步的备用做法。

## v0.29.4

- **GitHub Releases 打通**：以前只在 `package.json` 里升版本、从没打过 git tag，而且 `.github/workflows/release.yml` 只推 ghcr 镜像、没有创建 Release 的步骤 —— 所以 Releases 页面一直是空的。现在 push 一个 `v*` tag 就会自动：构建 amd64+arm64 镜像 → 推 ghcr → 用 `CHANGELOG.md` 中该版本那一段作为 Release 说明创建 Release（预发布版自动标 prerelease）。
- **镜像 tag 对齐**：`docker/metadata-action` 补上 `type=semver` 规则，同一次发布同时产出 `v0.29.4`、`0.29.4`、`0.29`、`latest` 四种 tag（之前只有 `v0.29.3` 和 `latest`，Release 正文里写的 `:0.29.3` 会 404）。

## v0.29.3

- 仓库迁到 `github.com/jianghugs/cf-tunnel-panel`：README 克隆地址、登录页页脚链接、LICENSE 版权署名同步更新。

## v0.29.2

- Grafana 嵌入的超时从 12 秒放宽到 25 秒（经隧道首次加载要拉几十个 bundle），8 秒后骨架文案提示「还在加载，第一次会慢一些」。

## v0.29.1

- 修 Grafana 卡的骨架屏一直盖在图表上：iframe `load` 后没移除绝对定位的骨架，图其实加载好了但看不见。

## v0.29.0

第二轮界面评审（12 条）落地，重点是把「看不出来在干什么」的地方变得可解释。

**新增**
- 概览的 Grafana 卡改为懒加载：先显示骨架，进入视口才插 iframe；12 秒没加载出来就显示原因 + 重试 + 在新窗口打开（不再是一块白板）。
- 侧栏顶部新增工具条（主题 / 命令面板 / 语言），不再藏在侧栏底部。

**修复**
- 变更趋势数字虚高：审计原来把读请求和测试流量也算进去，现在只统计「真正改配置」的请求，测试流量（带 `x-cfp-test` 头）不落库。
- CSP 拦掉了 Cloudflare 自动注入的统计脚本，补 `static.cloudflareinsights.com` / `cloudflareinsights.com`。
- 隧道「已运行 30 时 54 秒」读不通：时长统一成「N 天 N 小时 / N 小时 N 分 / N 分 N 秒」。
- 手机端整页横向溢出：根因是 `@media (max-width:900px)` 里 `grid-template-columns:1fr` 的隐式 `min-width:auto` 被侧栏按钮撑开，改 `minmax(0,1fr)`；顺带补 `min-width:0` / `max-width:100%` 兜底。
- 出口卡 6 个按钮挤成一片：高频「重启」留外面，启动/停止/二维码/复制/复制成新出口 收进「⋯」菜单，删除单独放右侧并二次确认。

**改进**
- 图表摘要从图上方移到图下方，数字用等宽数字对齐；统一「蓝=正常、红=错误」配色，变更趋势改回主色。
- 日志默认折叠 6 行，带级别色点（ERR 红 / WRN 黄 / INF 蓝），可一键展开。
- 微文案：「专属」→「仅限单出口」、「重连 2」→「重连 ×2」、「条专属规则」→「条仅限此出口」。

**测试**：API 317 / DOM 159 / e2e 39。

## v0.28.4

修 v0.28.3 引入的复选框渲染 bug（用户截图：勾选框被拉成通栏蓝色长条、文案挤成竖排单字）。

### 修复
- **根因**：`.login-card input{width:100%}` 的特异度（0,1,1）高于 `.chk`（0,1,0），所以自绘勾选框也被拉成 100% 宽；`flex:none` 下它独占整行，`<span>` 被挤到 1 字宽逐字换行。
- 把宽度规则收窄成 `.login-card input:not([type=checkbox]):not([type=radio]){width:100%}`，并给勾选框补 `.login-card input[type=checkbox]{width:18px;height:18px;flex:0 0 18px;min-width:18px;max-width:18px;box-sizing:border-box}` 双保险。

### 改动
- 标题「登录面板」→「管理员登录」（左侧已写「Cloudflare 隧道面板」，不再重复）。
- 输入框聚焦描边调柔：`border-color:var(--acc)` + `box-shadow:0 0 0 3px rgba(59,130,246,.15)`，替换原来偏重的圆环。
- 左侧页脚 GitHub 地址改成可点击 `<a target="_blank" rel="noopener">`，hover 变品牌色 + 下划线。
- 视觉验证：用 `zenika/alpine-chrome` 跑无头 Chromium 截图确认（勾选框 18×18、文案单行、卡片高度自适应）。
- 回归：DOM **151**（+3：CSS 含 `input:not([type=checkbox])` 作用域、勾选框有固定尺寸规则、登录页标题是「管理员登录」）、API **309**。

## v0.28.3

登录页按 7 点评审重排（同一批反馈里最要紧的是「复选框文字被裁切」）。

### 修复
- **复选框文字溢出**：根因是文字容器没有 `min-width:0` 与换行约束，长文案在 `.login-wrap{overflow:hidden}` 里被直接切掉。现在 `.remember` 是 `display:flex; align-items:flex-start; gap:9px; min-width:0`，文字 `flex:1 1 auto; min-width:0; overflow-wrap:anywhere`；长说明从复选框旁移到按钮下方的 `.tips`，复选框只留「记住这台设备 30 天」。

### 改动
- **凭证区成组**：用户名/密码/验证码/记住设备包进 `<div class="cred">`（浅色卡 + 1px 边框 + 圆角 12px），「输入区」和「操作区」有层次了。
- **垂直节奏统一**：新增 spacing token `--sp-field:18px`、`--sp-group:24px`，字段之间 18px、凭证区与提交按钮之间 24px、按钮与帮助文字之间 12px。
- **自定义勾选框**：`appearance:none`、18×18、圆角 5px，选中时品牌色底 + 伪元素白勾，`:focus-visible` 有描边。
- **眼睛按钮**：38×38 桌面 / 44×44 触屏（`@media (pointer:coarse)`），hover 与 focus 对比度加强。
- **右侧不再空旷**：表单上方加一句副标题「输入管理员账号登录」，底部帮助文字改成 `.tips` 样式（更低对比、带行高）。
- **无障碍**：`<label for="rem">` 显式绑定、输入框 `aria-describedby` 指向错误元素、`#uErr/#pErr` 带 `role="alert"`、提交按钮 `:focus-visible` 双层描边。
- **错误态**：401 落在密码字段（红描边 + 字段下 12px 红字 + `aria-invalid`），429 落在整体提示，输入即清。
- 测试：DOM **148**（+4：`.cred` 分组、`label.remember[for=rem]`、`button.login-submit`、勾选框文案非空）、API **309**。

## v0.28.2

登录页细节修正（按反馈改的）。

### 修复
- **删掉「用面板账号登录。默认账号 admin…」那行说明**：标题已经够清楚，多一行反而像在提醒你密码是什么。
- **用户名/密码/验证码三个框都不再有任何占位文字**（原来用户名预填 `admin`、密码预填 `••••••••`、验证码 `123456`），避免被误当成默认值。
- **「记住这台设备」布局错位**：复选框外层 `label` 误用了 `.chk`（那是给 `<input>` 的 15×15 样式），导致整行被压成 15px 高、和密码框/登录按钮挤在一起。改成 `label.inline` + 内部 `<input class="chk">`，并给字段与按钮之间补上 14/16px 间距。
- 测试：DOM **144**（+2：「没有预填占位值」「记住设备是 label 包 input」）。

## v0.28.1

登录页重做：从"一张小卡片"变成左右分栏的品牌页。

### 改动
- **左侧品牌区**（桌面端）：渐变背景 + 三条卖点（多出口 / 规则分流 / 可观测）+ 版本与仓库地址；窗口 <860px 时整块隐藏，表单居中占满，不出现横向滚动。
- **右侧表单区**：标题 + 一句说明，字段有占位符（`admin` / `••••••••`），右下角三个小按钮——语言（中/EN）、深浅色、密码显隐（👁，带 `aria-pressed`）。
- **二次验证那一步**：提交后自动展开验证码框、锁住已填的账号密码、按钮文案变「下一步」，输错时自动选中验证码方便重填；这些文案都进了词典，英文模式下不再中英混排。
- 新增 `EN_LOGIN` 词条 17 条；登录页仍走外部 `login.js`（CSP `script-src 'self'` 不允许内联脚本）。
- 测试：DOM **142**（+3：双栏结构、三个工具按钮、三条卖点）。

## v0.28.0

告警终于能"闭环"了：**Prometheus 判断 → Alertmanager 路由 → 面板转成你配的钉钉/飞书/bark 通知**，而且点得动。

### 新增
- **监控页可点**：告警行现在能点——带 `labels.id` 的（如 `TunnelDown`）跳 `/tunnels?focus=<id>` 并高亮那张出口卡；抓取目标里的面板槽位会加「面板」标签。`/api/monitor/status` 的 `alerts[]` 增加了 `labels`（只保留 `id/name/mode/instance/job/status/severity`）。
- **单出口错误率告警** `ExitErrorRateHigh`：`(cf_exit_errors_5m / cf_exit_requests_5m > 0.1) and cf_exit_requests_5m >= 20`，`for: 10m`。同一出口「抓不到」时由 `TunnelDown` 抑制，不重复报。
- **Alertmanager 接入**（`tools/monitoring`）：新增 `prom/alertmanager:v0.28.0` 容器（`127.0.0.1:9093`）+ `alertmanager/alertmanager.yml`，Prometheus 侧 `alerting.alertmanagers` 指向它；告警统一转给面板的新回调接口。
- **面板告警回调** `POST /api/alerts/hook`：接收 Alertmanager 的 webhook，拼成人话（`[正在告警] AlertName · 出口 X · warning` + summary）后走你配的通知通道；`firing`/`resolved` 都转发（`send_resolved: true`）。令牌用 `?token=` 或 `x-cfp-token` 头，首次访问会自动生成，管理员可在「设置 → 监控嵌入 → 告警回调令牌」查看/复制。
- 新增 `GET /api/alerts/hook-token`（管理员）：返回令牌与推荐回调地址。
- 新增路由规则（面板自带的那条之外）：「面板本机入口（127.0.0.1:8080）」——同机服务（Alertmanager、你自己的脚本）统一走 Caddy，切主后依然能打进来。
- 测试：API **309**（+6：令牌可取、错令牌 403、正确令牌接收、告警带 labels、规则含 ExitErrorRateHigh、监控栈副本同步）、DOM **139**（+2）。

### 实测（本机全链路）
1. `curl -XPOST 127.0.0.1:9093/api/v2/alerts` 塞一条 `DemoAlert`；
2. 20 秒后 Alertmanager POST 到 `http://127.0.0.1:8080/api/alerts/hook?token=…`（走 Caddy → 在线槽位）；
3. 面板审计出现 `alertmanager | 接收外部告警回调 | 1 响 / 0 恢复`，通知记录出现 `promAlert | skipped | 没有启用任何通知通道`（当前没配通道，属预期）。

### 两个坑（写下来省你时间）
- **Alertmanager 0.28 的 `http_config` 不支持 `headers`**：写 `headers: {x-cfp-token: …}` 会 `field headers not found in type config.plain` 直接起不来。改成把令牌拼进 URL 的 `?token=`。
- 回调地址别写死某个槽位端口（8090/8095 会换），写 `127.0.0.1:8080` 让 Caddy 挑在线的那个。

## v0.27.0

Grafana 那张缺失的图补上了：**按出口看谁在吃流量**。

### 新增
- **`cf_exit_requests_5m` / `cf_exit_errors_5m`**：`/metrics` 在原有指标后追加每个出口最近 5 分钟的请求数与 4xx+5xx 数，标签 `{id,name,mode}`。数据来自访问日志（`readAccess` 只读末尾 1MB），不额外占用 cloudflared。
  - 出口归属沿用「按域名归属」逻辑：命名隧道取 `publicHostname`、快速隧道取当前 `trycloudflare` 域名；不属于任何出口的 Host 不计数（页面上的「其它」汇总仍可用 `/api/tunnels/stats` 看）。
- **Grafana 面板 13**：「按出口的请求数（5 分钟滚动）」两条线（请求 / 错误），按 `name` 分组。`docs/grafana-dashboard.json` 与 `tools/monitoring/dashboards/` 的副本同步更新，Grafana provisioning 约 10 秒自动加载。
- API 测试 +3（`/metrics` 带两个出口指标、带 `name` 标签）→ **303**。

### 说明
- 这是**滚动窗口 gauge**（每个抓取点回看 5 分钟），不是计数器，所以 Grafana 里直接画原值即可，不要套 `rate()`。

## v0.26.1

### 修复
- **`NotifyFailing` 被手动「发测试」顶起来**：没配通道时 `notify()` 直接 `return false`，而测试接口把这次尝试记成 `fail`；跑几次测试就累计到阈值，监控页一直挂着告警。现在「没有启用任何通道 / 指定通道不存在」记为 `skipped`，并且 `cf_notify_total` **不统计 `event="test"`** —— 手动测试互不干扰运营告警。

## v0.26.0

监控页能「治」了：告警可以就地静默，页面上也看得出哪些被按掉了；`/monitor` 同时纳入真 Caddy 的 e2e。

### 新增
- **面板侧告警静默**：监控页每条告警后面多了「静默 1h」（可填 5–1440 分钟）与「解除」。静默写进 `settings.alerts.mutes[]`（`{name, until, note}`），`GET /api/monitor/status` 会给每条告警标 `muted` 并返回 `mutes` 列表，被静默的行淡化 + 显示「已静默」。
  - 诚实边界：这是**面板侧**静默 —— 只影响这一页的提醒与视觉标记，Prometheus 仍照常评估、Alarmmanager/Alertmanager 仍照常通知。要真正掐断通知得在 Alertmanager 里做 silence。
  - 接口：`POST /api/monitor/mute {name, minutes, note}`、`POST /api/monitor/unmute {name}`，都写审计（「静默告警」/「取消静默」）。
- **e2e 覆盖监控页**：`test/e2e-caddy.mjs` 从 32 项扩到 **39 项**，新增「监控页可打开 / 有概览卡容器 / 状态接口结构 / mutes 数组 / 静默写入 / 出现在状态里 / 可解除」。

### 变更
- Prometheus 不可达时，`/api/monitor/status` 依然返回 `mutes`，所以页面在 Prometheus 挂掉时也能解除静默。
- 新增 8 条界面词条。

## v0.25.0

监控系统不再只是「文档里的一套 YAML」：面板里多了一个「监控」页，Prometheus 抓到了谁、谁在告警，一眼能看到。

### 新增
- **监控页 `/monitor`**：四张概览卡（Prometheus 就绪、抓取目标 up/down、正在告警数、面板角色）+ 抓取目标表（job / 实例 / 健康 / 最近抓取 / 错误）+ 告警表（名字 / 级别 / 状态 / 开始时间 / 说明）+ 内嵌 Grafana 三个面板。30 秒自动刷新。
  - 后端 `GET /api/monitor/status` 代理查询 Prometheus 的 `/-/ready`、`/api/v1/targets?state=active`、`/api/v1/alerts`；地址在设置页「监控嵌入」卡的 **Prometheus 地址**（`settings.monitoring.promUrl`，默认 `http://127.0.0.1:9090`），留空就不查。
- 侧栏新增「监控」入口（7 个页面）。

### 修复
- **`PanelDown` 永远在响**：规则原来是 `up{job="cf-tunnel-panel"} == 0`，而 blue/green 总有一色是停的 —— 等于常驻告警。改成 `sum(up{job="cf-tunnel-panel"}) == 0`（两色都抓不到才算挂）。
- **`NotifyFailing` 的说明是 `1.0132312312312313 条`**：`{{ $value }}` 直接插浮点数，改成 `{{ $value | printf "%.0f" }}`。
- 修 YAML 引号踩坑：`summary: "…printf "%.0f" …"` 会被解析坏，Prometheus 直接起不来；必须外层单引号。改完用 `promtool check rules` 验一遍。
- 窄屏 CSS 里 `.chart` 高度有两处重复定义（96px 被后面的 126px 覆盖），删掉无效那条。

### 变更
- 新增 36 条界面词条；`docs/PROMETHEUS-GRAFANA.md` 补监控页与 promtool 校验步骤。

## v0.24.0

两件事：监控图不再只能局域网看，通知不再只能配一条。

### 新增
- **通知多通道**：`settings.notify.channels[]`（最多 8 条），每条独立 `name / format / url / secret / enabled`，一条通知会发给所有启用的通道；设置页「掉线通知」改成通道表，每行可单独测试/删除/停用。`POST /api/notify/test` 支持 `{channelId}` 只测一条。
  - 兼容：老的 `notify.url / format / secret` 在读取时虚拟成一条「默认通道」，老配置不用迁移也能继续发；`migrateState()` 会顺手把它们写成 `channels[0]`。
  - 保存时按每条通道自己的 `format` 校验地址（钉钉必须 `oapi.dingtalk.com/robot/send`、飞书必须 `open-apis/bot/v2/hook`、bark 必须 `host/key`），密钥留空=保留旧值、`clearSecret` 才清空，id 重复直接 400。
- **Grafana 走 HTTPS**：`grafana.jianghugs.shop` 经由 Caddy（`→ 127.0.0.1:3000`）与同一条隧道暴露，Grafana 容器补 `GF_SERVER_ROOT_URL` / `GF_SERVER_DOMAIN`，面板 `settings.grafana.url` 改成 https —— 首页 iframe 不再被混合内容拦截，`/d/…` 分享链接也指向公网域名。

### 变更
- 面板 `frame-src` 会跟随 `settings.grafana.url` 的源动态放行；关闭嵌入时回到 `frame-src 'self'`。
- 新增 28 条界面词条。

### 注意
- Grafana 是**匿名只读**：同网段 / 公网任何人都能看这些图（看不到配置、改不了东西）。不想公开就关掉隧道里的 `grafana` 公共主机名，只保留局域网 `:3000`。

## v0.23.0

把两处「数据都在、但要人手工搬」的地方接上了：看到谁在砸门就能直接封，看到哪个出口在吃流量也能直接读。

### 新增
- **可疑访问一键封禁**：观测页「可疑访问（401/403）」每一行来源 IP 后面新增「封禁 / 解封」按钮，直接写进 `security.ipDeny` 并立刻下发 Caddy（`POST /api/security/deny|allow`）。内网/环回地址会额外提示「可能把你自己挡在外面」，CIDR 支持 `/32`、`/128`、`/24` 等写法，最多 200 条。
- **出口流量（按域名）**：隧道页新增一张表，把访问日志里的 Host 归属到具体出口 —— 请求数、5xx、4xx、p95、流量，支持 1/6/24/72 小时窗口（`GET /api/tunnels/stats?hours=`）。不属于任何出口的主机名会单独汇总在表格下方。

### 变更
- operator 角色可以封禁/解封 IP（属于日常运维动作，不需要管理员）。
- 新增 15 条界面词条（出口流量表 + 封禁按钮）。

## v0.22.0

按「角色 / 导出 / 英文」三条线索收的一轮尾巴，重点是让界面**先说清楚能不能改**，而不是点了才报错。

### 新增
- **角色下发**：`/api/state` 返回 `role` 与 `canWrite`；前端据此在顶栏显示「只读账号 / 运维账号」标签，主按钮禁用，点写操作直接提示，不再等 403 才知道。
- **备份单份下载**：`GET /api/backups/download?file=`（附件下载，文件名白名单，拒绝路径穿越）。
- **访问日志 CSV**：`GET /api/access.csv?limit=`，BOM + CRLF + Excel 公式注入防护；观测页「导出 CSV」跟随当前筛选条数。
- **规则一键复制**：规则卡新增「复制」，插在当前规则后面（自动换 id、名字加「副本」），保存后生效。
- **Grafana 混合内容提示**：https 页面里嵌 http 的 Grafana 会被浏览器拦截，卡片现在直接说明原因与两条出路，而不是显示两块白板。

### 变更
- 语言按钮在英文模式下显示「中文」（原来是个孤零零的「中」）。
- 词典 lookup 增加「空白归一化」兜底：页面里带缩进的文本节点也能命中，英文模式残留中文从 `/settings` 8.0% 降到 0%。

### 修复
- `/api/audit` 的 `limit` 未夹紧（`?limit=99999` 能拉 370KB）→ 夹到 2000。
- `/api/security/attempts` 的 `hours`/`limit` 未夹紧 → 夹到 0.1–168 小时、100–5000 条。

## v0.21.0 附：本机监控栈（tools/monitoring）

- 新增 `tools/monitoring/`：Prometheus(v2.55.1) + Grafana(11.3.0) 的 compose，host 网络、
  `restart: unless-stopped`，Prometheus 抓 `127.0.0.1:8090/8095`，Grafana 自动预置
  数据源（uid `prom-main`）与仪表盘（uid `cfp-main`），并开匿名只读 + `allow_embedding`。
- `docs/grafana-dashboard.json` 补显式 panel id（1–12），`dashboards/` 下生成可直接预置的副本。
- 踩坑记入 `tools/monitoring/README.md`：数据目录要归 uid 1000（用 `--entrypoint sh` 以容器 root 改属主，
  不加 `--entrypoint` 会把 Grafana 当服务跑起来抢 3000 端口）。

## v0.21.0 — 把 Grafana 的图嵌进首页

- **首页新增「监控面板」卡**：把 Grafana 单个 panel 用 `/d-solo/` 直接嵌进来（只给一张图，
  不带 Grafana 自己的时间选择器和侧栏，尺寸可控）。设置页「监控嵌入」里填 Grafana 地址、
  仪表盘 `uid/slug`、最多 3 个 `panelId`（可加标题与高度），保存后首页出现。
- **CSP 跟着配置走**：页面的 `frame-src` 只在开启嵌入时放行「你填的那个源」，
  关掉或没填就退回 `'self'` —— 不用 `*`，也不允许任意站点被嵌进来。
- 校验都在服务端：地址必须 http(s)（拒绝 `javascript:`）、仪表盘要 `<uid>/<slug>`、
  高度夹到 140–600、最多 3 个；开启但少任何一项直接 400 并说明缺什么。
- Grafana 侧需要 `allow_embedding = true` + 面板可匿名只读（org_role=Viewer），
  否则 iframe 里会是 Grafana 自己的登录页。

测试：API 262 项、DOM 118 项。

## v0.20.0 — 审计留档按天、告警模板、Grafana 集群面板

三件都是「出了事能查、平时能看」的东西。

- **审计日志按天分文件 + 保留策略**：以前是单个 `data/audit.log`，超过 2MB 只留最后 3000 行，
  等于只记得最近几小时 —— 「上周三谁改的规则」根本查不到。现在每天一个
  `data/audit/audit-YYYY-MM-DD.jsonl`，单文件超 8MB 截断到 5000 行，默认保留 30 天
  （`PANEL_AUDIT_DAYS` 可调，启动与每小时各清一次）。老文件首次启动自动搬进新目录，不丢历史。
  观测页审计卡多了日期下拉（默认「最近两天」），导出 CSV 也跟着筛选走；接口新增
  `GET /api/audit/days`，`/api/audit` 与 `/api/audit.csv` 都支持 `date=YYYY-MM-DD`。
- **告警规则模板** `docs/prometheus-alerts.yml`：10 条，覆盖面板抓不到、没有主实例、主实例频繁切换、
  代码漂移、出口掉线、Caddy 下发失败、业务 5xx 占比、面板自身 5xx、面板被扫、通知发送失败。
  每条都写了「看到它该去查什么」。
- **Grafana 面板重做** `docs/grafana-dashboard.json`：12 个 panel —— 主实例 / 在线出口 / Caddy 下发 /
  代码漂移 / 历史采样 / 面板请求六个数字，集群角色时间线、面板请求速率、业务请求、通知结果四张时序图，
  出口状态与构建信息两张表。

测试：API 251 项、DOM 116 项。

## v0.19.0 – v0.19.2 — 历史共享 + 集群指标

- **v0.19.0**：出口采样与通知记录落盘共享（`data/history/samples.jsonl`、`notify.jsonl`），
  两台实例读同一份；`/api/history`、`/api/notify/history` 响应带 `shared:true`。
- **v0.19.1**：采样触发改成「距上一条 ≥55 秒」而不是数 tick —— 原来进程重启相位归零，
  滚动升级切主时曲线会空整一分钟。
- **v0.19.2**：`/metrics` 升级为集群视角（`cf_role`/`cf_leader_info`/`cf_build_info`/`cf_code_drift`/
  `cf_history_samples`/`cf_notify_total`/`cf_panel_requests_total`），另加面板自身请求计数。

## v0.18.0 — 横向扩展收口：两个实例终于「像一份系统」

这一版几乎全是 bug 修复 —— 起因是「两个进程同时活」之后，很多以前不会暴露的假设开始漏气：
会话只在内存里、配置只读一次、告警两个实例各发一份、审计只在重启前有效。

- **会话跨实例共享**：`sessions.json` 变成共享事实源。会话表以磁盘为准，取会话时做限流合并
  （1.5 秒最多读一次盘），未命中再强制读一次；撤销用**共享墓碑**（文件格式升级到 v2：
  `{version, sessions, revoked}`，旧的纯数组仍能读）。修掉三个具体故障：①在 A 登录、请求被
  Caddy 轮到 B → 401 掉登录；②在 A 踢人、B 那边还能用；③改只读账号口令把管理员自己也踢下线。
- **配置跨实例可见**：`maybeReloadState()` 按 `state.json` 的 mtime 增量重载（2 秒节流，页面渲染
  1 秒），改完规则切到另一个实例的页面不会再看到旧配置。
- **告警只由 leader 发**：`monitor.js` 的通知统一走 `alertOnlyLeader()`。两个实例读同一份
  access.log，之前一条 5xx 尖峰会发两遍、出口恢复也会报两次。采样仍各实例本地做。
- **审计日志读文件**：`/api/audit` 改成读 `data/audit.log`（跨实例、重启后仍在），而不是只看
  本进程的 200 条环形缓冲。
- **权限**：只读/运维账号不能再 `/api/export?full=1`（GET 对它们本来都放行，之前能一键导出
  隧道 token、CF API token、TOTP 密钥）；设置只读/运维账号只踢**该账号**的会话（新增
  `session.revokeUser()`），不再是 revokeAll。
- **审计 CSV 一直是空的**：处理函数读的是 `list().items`，实际字段叫 `rows` —— 从 v0.14.0 起
  这个导出只有表头。顺带给单元格加 Excel 公式注入防护（`= + - @` 开头垫单引号）。
- **链路自测发不出 Host**：`fetch`/undici 不允许覆盖 `Host`，所以「指定域名测规则」永远是错的
  （看起来像规则没配好）。改用 `http.request` 手写 Host，回显里能看到真正发出的域名。
- **静默失效变显式警告**：勾了限流但镜像里的 Caddy 没有 `rate_limit` 模块时，保存设置会回
  `warnings` 并在界面上提示（之前只是日志里说一次，用户以为开了）。
- `/api/qr?text=` 加 1200 字符上限（再长二维码密到扫不出来，也顺便挡掉拿它当存储的用法）。
- 测试：**229 接口 + 113 页面 + 32 真 Caddy e2e**（e2e 新增「备份实例认得 leader 登录的会话」
  「备份实例看到 leader 刚改的配置」两条跨实例断言）。

## v0.19.2 — 监控指标升级成「集群视角」

`/metrics` 以前只描述“这台实例自己”：抓的是 standby 就只能看到它那份出口状态，
而且面板自己的 `/api` 请求根本不在 Caddy 的 access.log 里，被扫描时看不出来。

- 新增指标：
  - `cf_role{role="leader|standby"}`、`cf_leader_info{id}` —— 一眼看出这台是谁、谁是主；
  - `cf_build_info{version,code,mode}`、`cf_code_drift` —— 版本/代码指纹/是否跑着镜像外的代码；
  - `cf_history_samples`、`cf_notify_total{status}` —— 读共享历史文件，两台抓出来的数一致；
  - `cf_panel_requests_total{status}`、`cf_panel_uptime_seconds` —— 面板自身请求（按状态类），
    静态资源、`/healthz`、`/metrics`、`/badge.svg`、`/__bench/*` 都不计入，避免健康检查把 2xx 刷成噪声。
- `GET /api/system` 增加 `panelRequests {total, since, byStatus, top[10]}`；
  设置页「关于」多两行：面板请求合计与最热路径、历史采样/通知条数。
- 计数是**每实例内存**（进程重启归零），要长期审计看 `audit.log`，两者用途不同。

## v0.19.1 — 采样按「上一条有多旧」触发，主备切换不再漏一分钟

v0.19.0 把曲线落盘后立刻暴露一个瑕疵：采样是 `histTick % 12 === 0`（每 12 个 5 秒 tick）
触发的，进程一重启相位就归零 —— 滚动升级切主时那条曲线上会**空掉整整一分钟**。

- 改成看「文件里最后一条采样有多旧」：`Date.now() - last.t >= 55000` 才采。
  新 leader 起来后立刻补一个点，历史由 `history.js` 按分钟去重，所以不会重复也不会漏。
- 实测蓝绿切换前后：`17:37 blue → 17:38 blue → 17:39 blue → 17:40 green → 17:41 green`，
  曲线连续，点的来源字段 `inst` 显示两台都写过同一个文件。

## v0.19.0 — 历史数据落盘共享（两台实例看到同一份曲线）

横向扩展之后还剩一处「两台不一样」：出口在线曲线（`/api/history`）和通知发送记录
（`/api/notify/history`）都攒在各自进程内存里 —— 刷新页面落在哪台就看哪份，
重启还会清零。这版把它们搬到 `DATA_DIR/history/`：

- `samples.jsonl`：每分钟一条 `{t,running,total,caddyOk,req,inst}`，**只由 leader 写**
  （standby 也写就会两家互相覆盖），读取时按分钟去重，leader 切换不会出现重复点。
- `notify.jsonl`：通知结果 `{seq,event,title,status,extra,text,inst}`，seq 用毫秒时间戳，
  跨实例不撞车；「重发」按 seq 找记录，重启后仍能重发。
- 两个文件都是追加写 + 超 512KB 自动重写成最后 2000 行（临时文件 + rename），
  读的时候只读末尾 256KB；跨实例刷新节流 2 秒，不会每个请求都读盘。
- `/api/history`、`/api/notify/history` 响应加 `shared:true`；`/api/system` 多一段
  `history {dir,inited,samples,notifies,*Bytes}`，排障时能直接看到文件长到多大。

顺带：`sampleHistory()` 现在由 `monitor.js` 在 `safeLeader()` 为真时才调，
避免 standby 写出「自己这边 0 个出口在线」的假低谷。

## v0.18.3 — 镜像重建，`drift` 归零

前面几版都是用 `docker cp` 热替换容器里的代码（改一行、重启一次，十几秒见效果），
代价是镜像里还是老代码 —— `/healthz` 的 `drift:true` 就是在说这件事。这版把两者对齐：

- 用当前工作区重建镜像，并核对镜像内 `.code-hash` 与工作区 `node tools/codehash.js` 完全一致
  （`902d6faf08cdbaa2`），再用 `MOUNT_SRC=0 tools/rolling-upgrade.sh --apply` 滚两轮，
  两台实例都跑镜像里的代码，`/healthz` → `drift:false`、`code == imageCode`。
- 修 `Dockerfile` 的默认 `CADDY_ADMIN`：原来写 `127.0.0.1:2019`，而 `caddy.bootstrap.json`
  现在监听 `20190`。走 compose 时由 compose 覆盖所以看不出来，但**直接 `docker run` 这个镜像**
  会推不动配置（v0.16.0 起 pusher 不再回退旧端口）。改成 `20190`。
- 镜像同时打 `cf-tunnel-panel:local`（脚本默认引用）与 `cf-tunnel-panel:0.18.3`（便于回滚）。

## v0.18.2 — 备份实例不再「悄悄失败」

横向扩展之后 Caddy 会把页面请求轮流分给两台实例，轮到备份实例时写操作会被 409 拦住，
但界面只弹一句「当前连的是备份实例」，用户不知道该怎么办。

- `api()` 识别 `409 STANDBY`：提示「这次请求落在备份实例上（只读），已自动刷新」，
  900ms 后自动刷新页面（此时主实例通常已接管或本就该在它上面），用户重做一次即可。
- 顶栏健康点会显示 **「备份实例 · N/M 出口在线」**，黄点 + hover 说明，不再让人误以为出口全挂了。
- `/healthz` 增加 **`leader`**（当前主实例 id）、`/api/state` 增加 **`mode`**：
  监控/脚本不用猜「这次请求落到哪台」，也能一眼看出谁在当主。

## v0.18.1 — 修 CI：e2e 不再抢 8080/20190，失败时能看懂原因

CI 从 v0.16.2 起一直是红的，但本地三套测试全绿——差别在端口与环境：

- `test/caddy.e2e.json` 原来监听 `:8080`、admin `127.0.0.1:20190`，和「本机已有 Caddy」的
  场景撞车，GitHub runner 上又可能被别的进程占用 → 改成 e2e 专用端口
  **业务 `:8180`、admin `127.0.0.1:20290`**，与本地验证用的组合完全一致。
- CI 的 e2e 作业补 `CADDY_PORT=8180`、`CADDY_LISTEN=:8180`、`PANEL_ALLOW_FRESH_PUSH=1`，
  否则面板会把「默认 `:8080`」的配置推给只监听 8180 的 Caddy，随后所有断言 `fetch failed`。
- e2e 断言加 `timeout 600` 兜底，避免某个断言挂住把作业拖到 6 小时超时。
- 失败时打印 Caddy 容器日志 + 面板日志末尾 80 行 + **当前 Caddy 运行配置**（前 2KB），
  以后红一眼能看出是「配置没下发」还是「服务没起来」。

## v0.17.0 — 升级改成 blue/green 固定命名，不再和 compose 抢名字

以前脚本收尾会把新实例改名成 `cf-tunnel-panel`，于是「容器名」既是 compose 的服务名、
又是当前 leader 的名字 —— 下次 `docker compose up -d` 必然报 name conflict，
而且「cf-tunnel-panel 到底指哪一代实例」也没法从名字看出来。

- 容器名固定成一对：`cf-tunnel-panel-blue`（:8090）/ `cf-tunnel-panel-green`（:8095）。
  每次升级只是「在另一色上起新实例 → 停当前色」，**从不改名**，跑多少遍名字都稳定。
- 新增 `--bootstrap`：机器上还没有任何实例时用它创建蓝色槽位（不写 `--bootstrap` 就报错，
  避免手滑把正式环境起成空白状态）。
- `docker-compose.yml` 的 panel 服务移到 `profiles: ["bootstrap"]`：裸跑
  `docker compose up -d` 只管 Caddy 与演示服务，不再与脚本争容器名/端口。
  首次部署用 `docker compose --profile bootstrap up -d panel` 或脚本的 `--bootstrap`。
- `--prune` 现在删除的是「停下来的那一色」（如果那是旧式单容器则保留并提示手工删）。
- 修 `set -euo pipefail` 下的 bootstrap 崩溃：`CUR_NAME` 为空时 `docker inspect ""` 失败，
  经 `pipefail` 让整条管道非 0，脚本直接退出。
- 脚本起容器时补上 compose 项目标签，`docker compose ps` / 面板的宿主机信息都能看懂它是谁。

## v0.16.2 — 把「两个进程同时活」也纳入端到端

- e2e 新增双实例段（5 条）：用同一个 `data/` 起第二实例，断言它拿到 `standby` 身份、能读
  `/api/state`、写 `/api/settings` 被 `409 STANDBY` 拦住、409 里写明谁是 leader、
  以及原实例仍是 leader。真 Caddy 段总计 **28 条**。
- `tools/rolling-upgrade.sh` preflight 增加两条提示：容器若由 compose 创建，切换后
  `docker compose up -d` 会因容器名冲突而失败（先 `docker rename` 即可）；容器若挂载了
  宿主源码，升级后的 `code` 反映的是工作区而不是镜像（想验镜像请走 compose）。

## v0.16.1 — 镜像不再是「另一份代码」

终于把镜像 rebuild 通了，之前每次 `docker compose up -d` 都会把面板退回 v0.5.0，`/healthz` 的 `drift` 也一直报警。

- 修 `Dockerfile` 里 `ARG NODE_IMAGE` 的作用域：它写在 `FROM ${CF_IMAGE}` 之后，到 `FROM ${NODE_IMAGE}` 时已经取到空串，构建直接报 `base name (${NODE_IMAGE}) should not be blank`。所有出现在 `FROM` 里的 ARG 现在都在第一个 `FROM` 之前。
- 修 `COPY` 带进来的文件权限：宿主机上被脚本写成 `600` 的文件（`src/core/audit.js`、`lease.js`、`web/assets/app.js` 等）会被原样复制进镜像，容器以 uid 1000 运行时直接 `EACCES open`，面板反复重启。现在末尾统一 `RUN chmod -R a+rX /app`。
- 新增**面板槽位自愈**：leader 接管时，如果「面板自己」那条规则的 upstream 端口属于面板槽位但不是本实例端口（滚动升级换槽位后必然发生），自动改成本实例端口并落盘。否则状态里存着一个不存在的端口，看的人困惑，保存护栏的 `panelExposed` 判断也会失效。
- 自动重试时保留上一次失败原因（`startTunnel(id, { keepError: true })`），手动点「启动」才清空 —— 之前「启动中」那一小段界面上什么提示都没有，看起来像隧道凭空消失。
- 测试：把两条依赖 Cloudflare 快速隧道配额的断言放宽（只要求「running 时必有地址」「失败要留原因」），本地/CI 不再随机红。

## v0.16.0 — 2026-11-16

- **滚动升级（零中断）**：新增 `src/core/lease.js` —— 基于租约文件的主备选主（5s 心跳 / 15s TTL），
  持有者才写 state、下发 Caddy、跑 cloudflared；其余实例以 standby 运行，写操作返回
  `409 {code:"STANDBY"}` 并报出 leader。leader 退出即刻让权，standby 约 5s 接管。
- **Caddy 双槽位**：面板自己那条规则下发成两条上游（`PORT` + `PANEL_SLOT_PEERS`），
  `selection_policy: first` + `/healthz` 主动健康检查，切换时 Caddy 自动跳过不健康的上游。
- **新增 `tools/rolling-upgrade.sh`**：ping-pong 双槽位升级，含 preflight、standby 就绪等待、
  接管检测、容器改名、验证、`--prune` 清理；接管失败自动回滚。
- **`/healthz` 增加 `mode`（leader/standby）与 `instance`**，`docker ps` 之外也能一眼看出谁在当班。
- **修两个会咬人的问题**：
  1. `CADDY_ADMIN` 原来会「挨个试 2019/20190」，一个把 admin 指向假端口的测试实例能靠兜底打到
     线上 Caddy 并用它的空白配置覆盖生产规则 —— 现在只认 `CADDY_ADMIN`（`PANEL_ADMIN_FALLBACK=1` 恢复旧行为）。
  2. `reverse_proxy.fail_duration` 在 Caddy 2.11.9 里不存在，写上去整份配置 400 下发失败
     （表面现象是「推送成功但线上没变」），已移除。
- **空状态保护**：启动时 `state.json` 不存在则拒绝首次 Caddy 下发（`PANEL_ALLOW_FRESH_PUSH=1` 可放行）。
- **bootstrap 兜底从 200 改成 503 + `Retry-After`**：以前占位页返回 200，会让「线上是否可用」的检查全部假绿。
- **备份实例常驻 cloudflared 热备连接器**（仅命名隧道）：交接时隧道不会丢掉最后一个 connector。
  线上实测切换窗口从 **7 次 530（≈6s）** 降到 **1 次 530（≈0.25s）**；负载均衡策略也从 `first`
  改成 `round_robin` + `try_duration 3s`（`first` 会在健康检查尚未剔除死上游时反复重试同一台）。
- `docker-compose.yml` 增加 `PANEL_SLOT_PEERS`（默认 8095）。
- 测试：API 216、DOM 113、e2e 23。

## v0.14.2 — 2026-11-16

- **英文界面收口**：词典 229 → 502 条（从 jsdom 渲染出的 6 个页面采文案）；英文模式残留中文从 7%~32% 降到 0~3%，剩余为用户数据（规则名/出口名）。
- **动态文案翻译**：`toast/confirm/alert/prompt` 全部包一层 `t()`；新增 `MutationObserver` 对新挂载节点补扫（原来只在加载后 700ms 扫一次），另加 2.5 秒兜底扫描。
- **带数字的句子**：`app.js` 新增约 30 条正则（`NUMPAT`）+ 单位词兜底（`WORDS`），覆盖图表 tooltip、分页、在线数、采样数等拼接文案。
- 允许单字文本节点翻译（`测`/`删` 这类按钮此前被 `key.length > 1` 挡掉）。
- 测试：API 196、DOM 102、e2e 23。

## v0.14.3 — 2026-11-16

- **一键新建出口**：`POST /api/cf/tunnels/quick` —— 建隧道 → 取 token → 写 ingress（公共主机名）→ 建 CNAME → 可选落成本机出口并启动 → 轮询公网自测（最多 15 秒），逐步骤返回 `{name, ok, detail}`。
- **修最容易踩的坑**：只建 CNAME 不写 ingress 会 1033，现在同一步完成（保留已有 ingress 条目与末尾 `http_status:404`）。
- **只演练模式**：`dry:true` 返回 5 步计划（含具体接口路径），不调 Cloudflare。
- 校验：主机名必须是带点的完整域名、上游必须带协议，均返回 400 人话提示。
- 工具箱新增「一键新建出口」卡（`#btnQuick/#qkHost/#qkSvc/#qkName/#qkLocal/#qkDry/#btnQkRun/#qkOut`），结果以表格展示。
- 测试：API 200、DOM 106、e2e 23。

## v0.15.2 — 2026-11-16

- **规则拖动排序**（`src/web/assets/rules.js` + `app.css`）
  - 卡片 `draggable="true"` + 抓手 `.drag`（`⠿`，title 说明「顺序就是优先级」）
  - `dragstart` 记住源索引、`dragover` 按落点上半/下半给 `.dropbefore`/`.dropafter` 蓝线、`drop` 里 `splice` 重排后 `markDirty()` + `render()`
  - 从 `input/select/textarea/button/a` 起手一律 `preventDefault`（那是选文字，不是拖排序）
  - 只动同作用域：跨作用域卡片本来就不显示，天然隔离
- 快照 cron 落地：宿主机 `*/15 * * * * … tools/git-snapshot.sh`，实测首次提交 `426236c`、二次「配置没变化，跳过提交」
- 测试：DOM **113**（+3：卡片可拖拽 / 有抓手 / 保留 ↑↓），API 214、e2e 23

## v0.15.1 — 2026-11-16

- **保存前的护栏**（`src/core/guard.js`，新增）
  - `shadowIssues(routes)`：找出被前面规则遮蔽的规则（兜底 `/`、更宽前缀、同 host 同路径重复），判定与 Caddy 首条命中一致
  - `panelExposed(routes, panelPort)`：新规则集里是否还有一条指向面板自身端口
  - `POST /api/routes` 与 `POST /api/config/apply` 命中即 **409 `{code:'GUARD', issues:[…]}`**，`force:true` 放行；`apply` 的 `dry` 把同样内容放进 `warnings`
- 前端：`api()` 抛错时带 `err.status` / `err.payload`；规则页与「配置即代码」卡的保存失败走确认框，逐条列原因后带 force 重试
- `validateRoutes` 加严上游：必须是 `host:port` 或 `http://host:port`（此前 `parseUpstream('not-a-url')` 不报错）
- `tools/git-snapshot.sh` 重写：提交 `data/config/*.json`（脱敏声明式快照）而非只提交 state.json，保留 120 份、幂等；`STATE=1` 才连 `state.json` 一起提交
- 修正：`guard` 的「面板入口」只在**本来能进、改完就进不去**时才拦（比较新旧规则集），否则首次搭 Caddy 或 CI 里不挂面板的场景会被误判
- 测试：API **214**（+4：顺序护栏 409 / 演练 warnings / 面板入口护栏 / 被拦时线上不变）、DOM 110、e2e 23

## v0.15.0 — 2026-11-16

- **配置即代码**：新增 `src/core/configcode.js` + 五个接口
  - `GET /api/config`：state → 声明式 JSON（settings 公开字段 / tunnels 带 hasToken / routes 无哈希 / shares）
  - `POST /api/config/apply`：routes 全量替换、tunnels 按 id 合并（导出不含 token 也不会抹掉），写 `before-apply` 快照；`dry:true` 只算差异
  - `GET /api/config/drift`：与 `last-applied.json` 比对，用于发现手改
  - `POST /api/config/snapshot` / `GET /api/config/snapshots` / `GET /api/config/snapshot?file=`：快照存取（保留 80 份，文件名白名单防穿越）
- 设置页新增「配置即代码」卡（载入/预览/应用/存快照/看漂移 + 快照表一键填回编辑器），并加入分区导航。
- 实测：把 `/api/config` 原样 apply 回去 → `{added:0,removed:0,changed:0}`、Caddy 仍 5 条路由、两条隧道不重启；drift 立刻一致。
- 测试：API 210、DOM 110、e2e 23。

## v0.11.2

- **口令只存 bcrypt 哈希**：`state.json` 里 `panel.pass` / `viewer.pass` 改为 `$2b$10$…`；启动时自动把历史明文迁移成哈希（`migrate-secrets`）。
- **Basic 凭据缓存**：bcrypt 每次校验在本机 ARM 上约 170ms，成功凭据缓存 10 分钟后同页面加载从 5.8s 回到 <1s；改口令即时清空缓存。
- **代码指纹**：新增 `tools/codehash.js` + `src/core/ident.js`，`/healthz` 增加 `code` / `imageCode` / `sha` / `drift`；`Dockerfile` 构建时写 `.code-hash`，热替换代码会被识别成 `drift: true`。
- **修 core 模块冗余 require**：清理 121 条复制残留（先前误删 `SEC_HEADERS` 导致页面 500，已用更稳的匹配规则重做）。
- **修 v0.9.0 拆分埋下的真 bug**：`monitor.js` 对解构来的常量做 `histTick += 1`，每 5 秒抛 `Assignment to constant variable`，导致出口状态采样/掉线通知/历史采样自拆分起从未运行；改为模块内 `let histTick`。
- `package.json` 增加 `engines.node >= 20`。
- 测试：API 113、DOM 75。

## v0.14.1 — 2026-11-16

### 新增
- Service Worker 离线兜底页 `src/web/assets/offline.html`（缓存版本升到 v2，navigate 失败时返回）。
- 设置页卡片搜索 `#cardSearch`：按标题 + 正文过滤 13 个分区，chips 同步隐藏并显示命中计数。
- 窄屏（≤720px）图表高度 96 → 126px、刻度字号 10px。

### 变更
- **JSON 响应统一加 ETag 并支持 304**：`sendJson` 输出弱 ETag（按 gzip/identity 分后缀）+ `Cache-Control: private, no-cache`，`If-None-Match` 命中返回 304 且无正文。原来写的是 `no-store`，浏览器因此从不发起协商缓存，这也是这条优化以前做不成的原因。

### 修复
- 清理 README（中英）里 `/legacy` 的过时描述。

## v0.14.0 — 2026-11-16

### 新增
- `/api/routes/stats?hours=`：按 1/6/24 小时时间窗统计；规则卡显示「命中 N · 错 M · p95 Xms」并可切窗口。
- 图表悬停提示：柱子与在线率采样点都带 `<title>`（原生 SVG tooltip），显示该小时的具体数字。
- `tunnelUp` 通知事件：出口从非 running 恢复到 running 时发一条带地址的消息，设置页可开关。
- `GET /api/audit.csv`：审计日志导出 CSV（UTF-8 BOM，Excel 友好），观测页有按钮。
- 观测页 IP 筛选：来源 IP 可点，或直接 `/observe?ip=`。

### 修复
- **访问日志行缺 `at` 字段**，`monitor.js` 的「最近 5 分钟」过滤永远为空 → 5xx 尖峰告警自上线以来从未触发。现在 `readAccess()` 每行带 `at`，并支持 `{since, maxBytes}` 参数。
- `readAccess()` 只读末 512KB，24 小时窗口会被截断；带 `hours` 时改读 4MB。

## v0.13.9 — 2026-11-16

### 修复
- **概览页图表显示错乱**：SVG 用 `preserveAspectRatio="none"` 横向拉伸，导致刻度文字被压扁、贴住卡片底边；首尾柱子被卡片边缘切掉；三张图塞在两列网格里，第三张换行留白；「出口在线历史」只有 1 个采样点时 `polyline` 画不出来，整块卡片是空白。
- 现在：绘图区留在 SVG，刻度用 HTML 绝对定位（`.chart-x`，字号恒定、自动对齐柱子中心）；柱子左右留 `CPAD=1.2`；统一 `gridLines()` 基线/中线；峰值乘 1.08 留余量；采样点 <2 时显示明确说明。

### 变更
- 概览页三张图表卡从 `.grid2` 改到 `.grid3`（宽屏一行三张，窄屏自动堆叠）。

## v0.13.8 — 2026-11-16

### 修复
- **登录页点「登录」没反应**（严重）：`loginPage` 的表单逻辑写在 HTML 内联 `<script>` 里，被 v0.7.1 加上的 CSP `script-src 'self'` 直接拦掉。浏览器于是走原生表单提交（`GET /login?username=…&password=…`），页面刷新一次、口令明文进了 URL 和访问日志。现已把脚本移到 `/assets/login.js`（同源外部脚本，CSP 允许），并用 `data-next` 传跳转目标。
- **英文切换静默失效**：`window.__CFP_LANG`/`__CFP_DICT` 也是内联注入，同样被 CSP 拦。改为 `/boot.js`（gzip + `no-store`），八页与登录页都引用。
- 清理：访问日志里 4 条带明文口令的记录已就地打码（`password=REDACTED`）。

### 新增
- API 套件新增「所有页面无内联 `<script>`」「`/boot.js` 可用且不缓存」「`/assets/login.js` 可访问」四个断言；DOM 套件新增登录页引用检查。测试总数 180 API + 91 DOM。

## v0.13.7 — 2026-11-16

### 新增
- **可疑访问统计** `GET /api/security/attempts?hours=&limit=`：把访问日志里的 401/403 按规则与来源 IP 聚合，含每条规则的前 5 个来源、全局前 20 个 IP；观测页新增卡片（窗口 6h/24h/3d/7d，规则名可点回规则页）。
- **扫描告警 `authScan`**：`monitor.js` 每 5 分钟检查 10 分钟窗口，单 IP 被拒 ≥20 次触发通知，30 分钟冷却；`settings.notify.events.authScan` 可在设置页关掉。

### 修复
- 设置页「通知事件」的保存补上 `authScan`，避免勾选被静默丢弃。

## v0.13.6 — 2026-11-16

### 新增
- **访问记录可点进规则**：`/api/access` 为每行附加 `rule: {id, name}`（`simulateMatch` 归属），观测页路径单元格渲染成 `/rules?focus=<id>` 链接，hover 提示命中的规则名。
- **规则卡片显示命中量**：`rules.js` 在 `render()` 后拉 `/api/routes/stats?limit=2000`，把 `命中 N · 错 M · p95 Xms` 填进每条规则的徽标（有错误转黄色，没数据则隐藏）。

## v0.13.5 — 2026-11-16

### 新增
- **按规则流量图例可点**：`/api/traffic/paths` 的分组里补 `id/path/tunnelId`，概览页图例渲染成 `/rules?focus=<id>` 链接；规则页读取 `focus` 参数、必要时切换到对应作用域、滚动到卡片并高亮（`data-focused` + 1.6s 闪烁动画）。规则已被删掉时给人话提示而不是静默无反应。

## v0.13.4 — 2026-11-16

### 新增
- **按规则看流量** `GET /api/traffic/paths?hours=&top=`：读 access log 后用 `simulateMatch` 把每条请求归属到规则，按小时分桶输出；未命中的请求单独用 `unmatched` 计数（健康检查、未知路径常占大头，混进图例会挤掉真服务）。概览页新增「按规则看流量」堆叠柱状图 + 图例（规则名 · 总量 · 5xx）。
- **部署提醒**：预热成功时把代码指纹写进 `state.warm`，概览页发现「运行代码 ≠ 上次预热指纹」就提示重新预热。

### 修复
- 按规则归属一开始全落到「未匹配」：原始 Caddy 日志里 `host/uri/method` 在 `request` 子对象内（`readAccess` 才拍平），直接读 `o.host` 拿到的是 `undefined`。改为 `o.request.host` 兜底。

## v0.13.3 — 2026-11-16

### 新增
- **资源指纹 + 一年 immutable 长缓存**：页面引用 `/assets/*` 时带 `?v=<代码指纹前 8 位>`，这类请求回 `Cache-Control: public, max-age=31536000, immutable` 与一年期的 `CDN-Cache-Control`；无指纹的请求保持 `max-age=300`。代码一改 URL 就变，天然绕开旧缓存。
- **缓存预热** `POST /api/cf/cache/warm`：按当前指纹从公网域名拉 `/login` + 关键资源（可传 `paths` 覆盖，最多 12 条），逐条返回 `cf-cache-status` / `age` / 机房 / 耗时，工具箱加「预热缓存」按钮。
- **通知文案模板**：`notify.template {title, text}`，占位符 `{event} {title} {text} {host} {time} {running} {total}`；正文不含 `{text}` 时自动把原正文附在末尾。

### 修复
- `POST /api/settings` 的 `notify.events` 之前只回写四项，会把手动关掉的 `errorSpike` / `loginFail` 又打开；现在六个开关都保留。

## v0.13.2 — 2026-11-16

### 新增
- **Cloudflare 边缘缓存**：静态资源响应加 `Cache-Control: public, max-age=300` + `Cloudflare-CDN-Cache-Control: public, max-age=86400`；新增 `GET/POST /api/cf/cache/rule`（自动建/删「/assets/* 边缘缓存 1 天」的 Cache Rule）与 `POST /api/cf/cache/purge`（按 URL 或整域名清边缘缓存）；工具箱页新增「边缘缓存」操作区。实测公网 `cf-cache-status` 由 `DYNAMIC` → `MISS` → `HIT`（`age` 递增）。
- **通知重发**：`POST /api/notify/resend {seq}`，设置页「通知发送记录」每行加「重发」按钮（绕过静默时段/冷却/事件开关，用于验证 webhook 到底通不通）。
- **设置页分区导航**：卡片加 `#sec-*` 锚点并新增吸顶 `.subnav`，13 个卡片可一键跳转，窄屏横向滚动。

### 变更
- `/assets/*` **不再要求登录**（放在鉴权之前）：登录页自己也要加载 `app.css`，之前未登录时 CSS 是 401，登录页等于无样式；顺带让 Cloudflare 能把这些 URL 当公开资源缓存。
- JSON 响应 gzip：`sendJson` 在体积 >1KB 且客户端接受 gzip 时压缩（`/api/state` 4851B → 1559B，降 68%）。
- 文本响应的 ETag 区分编码（`-gz` / `-id` 后缀），避免中间缓存把压缩字节发给不支持 gzip 的客户端。

### 修复
- `/api/cf/cache/rule` 取 Cloudflare 返回值时多套了一层 `.result`（`cfApi` 已经解包），导致规则建好了却报 `rules: 0`。
## v0.13.1 — 2026-11-16

### 新增
- `POST /api/totp/recovery`：用「当前验证码或一个旧恢复码」换一批新的 10 个恢复码，旧的全部作废（只存 sha256）；设置页「二次验证」卡新增输入框 + 「重新生成恢复码」按钮，新码只在页面显示一次。
- 端到端测试（真 Caddy）从 8 项扩到 **23 项**：strip 前缀、不 strip 原样透传、基础认证三种情况、按 Host 域名隔离（含未登记域名 404）、WebSocket 101 升级、未命中 404、维护模式 503 + `Retry-After` + 关闭恢复、IP 黑名单 403 + 清空恢复、admin 不监听 2019、配置含 access log writer 与 `trusted_proxies`、规则表与设置还原。

### 变更
- 审计日志去重：同一次请求若已被 handler 显式记账（人话 action），收尾兜底那条「POST /api/xxx」不再重复写，列表里不再成对出现。
- e2e 探针路径改成互不嵌套的前缀（`/e2strip`、`/e2keep`、`/e2auth`、`/e2host`、`/e2ws`）——Caddy 是前缀匹配，`/e2e` 会吃掉 `/e2ek`，之前这类失败是测试写法问题而非实现问题。
- 域名隔离断言改用原始 socket 手写请求（`fetch`/undici 不允许覆盖 `Host` 头），并补 `Transfer-Encoding: chunked` 解码。

### 修复
- `/api/totp/recovery` 首次实现误用 `newRecovery()` 返回值（它返回 `{plain, hashed}` 而不是数组）→ 500。

## v0.13.0

### 新增
- **二次验证（TOTP，RFC 6238）**：自实现（只依赖 node:crypto），登录两段式；10 个一次性恢复码；允许 ±30 秒时钟偏移；关闭需当前验证码或恢复码；密钥不出现在 `/api/state`。
- **角色细分 admin / operator / viewer**：`src/core/perm.js` 用写接口白名单，operator 可管隧道/规则/分享/维护模式/主机名，碰不到凭证类设置与导入回滚；403 带具体原因。
- **运维账号**：`POST /api/operator`，保存即踢掉所有旧会话。
- **真 Caddy 端到端测试**：`test/e2e-caddy.mjs` + CI `e2e` 作业（caddy:2.11.9-alpine，admin :20190），验证下发的配置真能加载、真能转发、未命中仍是 404。
- 登录页新增「记住这台设备（30 天）」勾选与二次验证码输入框（口令通过后才显示）。

### 变更
- 登录接口 `POST /api/login` 支持两段：第一段返回 `{needTotp, challenge}`（5 分钟有效、HMAC 签名），第二段带 `challenge + code` 换会话。
- `/healthz` 之外的写权限判断统一走角色矩阵（readonly 判断被 `perm.check` 取代）。

### 修复
- e2e 脚本还原逻辑改为从 `/tmp` 快照还原（原来从当前 state 还原，中途崩溃会把线上规则清空）。
## v0.12.0

**面板从「配置页」变成「小运维台」：会话登录、踢设备、单实例锁、主机名管理、按规则统计、更多告警、PWA、YAML 导出、GHCR 镜像。**

### 新增
- 会话登录：cookie `cfp_sid`（HttpOnly / SameSite=Lax）、记住我 30 天、空闲 12 小时过期；会话落盘 `data/sessions.json`（只存 cookie 值的 SHA-256），重启不掉线。
- 设置 → 登录会话：列出会话（IP / UA / 最后活跃 / 换过 IP 标记），支持单个踢、全部踢；改面板口令或只读账号会踢掉全部会话。
- 未保存改动守卫：标脏 + 顶栏「未保存」徽标 + 站内跳转确认 + `beforeunload`。
- 单实例锁 `data/.state.lock`：pid + `/proc/<pid>/cmdline` 双重确认，第二个实例直接退出。
- 公共主机名管理：`GET /api/cf/tunnels/<id>/ingress`、`POST .../hostnames`、`POST .../hostnames/delete`，自动建/删 CNAME。
- 按规则统计 `GET /api/routes/stats`：命中数、错误率、P50/P95/最慢、字节数、未命中请求。
- 新告警事件 `errorSpike`（5xx 尖峰）、`loginFail`（登录失败集中），沿用冷却与静默时段。
- `GET /api/export.yaml`：无密钥的单文件配置快照。
- PWA：manifest + 图标 + service worker（只缓存 `/assets/*`）。
- `.github/workflows/release.yml`：打 tag 构建多架构镜像推 GHCR。

### 变更
- Caddy admin 默认从 `127.0.0.1:2019` 改到 `127.0.0.1:20190`，监听地址跟随 `CADDY_ADMIN`；下发改多地址回退。
- 移除 `/legacy` 旧单页（96KB）及其入口。

### 修复
- 会话 `resolveKey` 不认原始 cookie 值，导致「登出」不生效、退出全部设备返回 undefined。
- 会话换 IP 分支读 `sess.id`（不存在）抛错，使 `/api/sessions` 500。
- 规则命中统计的索引错位（`simulateMatch` 返回 1-based），1xx（WebSocket 101）被漏计。

## v0.11.1

- 通知按格式校验地址（钉钉/飞书/Bark 填错当场 400，不再静默不送达）。
- 钉钉 / 飞书「加签」支持：密钥单独存，钉钉签进 URL、飞书签进 body。
- 设置页按格式切换地址标签/占位符/操作提示，新增「清空已存密钥」。
- 测试：API 111 项、DOM 75 项。

## v0.11.0

- 帮助文案全部中英双语（171 条页面文案入库，字典共 229 条），翻译改为文本节点级 + 属性级扫描。
- 会话换来源 IP 告警：审计 + 通知 + 会话表红标。
- 「退出全部设备」；改面板口令 / 改只读账号自动踢掉所有会话并跳登录页。
- 测试：API 107 项、DOM 72 项。

## v0.10.0
- 会话式登录：`/login` 页 + `cfp_sid` cookie（HttpOnly/SameSite=Lax/HTTPS 自动 Secure），7 天有效、12 小时闲置失效；Basic 认证保留给脚本与 Prometheus。
- 会话管理：`GET /api/sessions`、`POST /api/sessions/revoke`、`POST /api/sessions/revoke-others`；设置页「登录会话」表格显示账号/角色/IP/设备/时间，可逐个踢掉。会话只存内存，重启即失效。
- CSRF：会话 cookie 的写请求要求同源（`Sec-Fetch-Site`/`Origin`），跨站写 403 并记审计。
- 变更趋势图：概览页新增第三张柱状图，`GET /api/audit/trend?hours=` 按小时聚合写操作（失败叠红）。
- 界面中英双语：`cfp_lang` cookie + 左下角 `EN`/`中` 切换，字典按「中文原文→英文」精确替换，服务端渲染 `<html lang>` 与导航文案。
- 未登录访问页面跳转 `/login?next=`（API 仍返回 401 JSON）。
- 测试：API 100 项 + 页面 70 项。

## v0.9.0

- **Backend split**: `src/server.js` 2543 → ~800 lines; logic moved into 15 focused modules under `src/core/`
  (`paths`, `util`, `state`, `registry`, `auth`, `caddy`, `pusher`, `tunnels`, `insight`, `bench`, `probe`,
  `integrations`, `notify`, `web`, `monitor`, `audit`). No behavioural change intended; verified by the full suite.
- **State sharing**: `state.js` now exports a live `stateProxy` plus `setState()` so导入/回滚 takes effect everywhere
  (a stale destructured `state` used to make `/api/state` report the wrong route/exit counts).
- **Audit log**: every state-changing request and every failed `/api` call is recorded (actor, real client IP,
  action, status, duration). Ring buffer of 500 + append-only `data/audit.log` (JSON Lines, rotated at 2 MB).
  New endpoint `GET /api/audit?limit=&q=`; new card on the Observe page with search and pagination.
- **Fixes**: `src/core/paths.js` resolved `web/`, `ui.html` and `package.json` one level too shallow after the move.
- Tests: 86 API + 57 DOM assertions (143 total).

## v0.8.1

**安全**
- 修：`POST /api/settings` 的回包把 Cloudflare API token / 通知 webhook 明文吐了回来（`/api/state` 早就脱敏了，这个回包漏了）。现在统一走 `publicSettings()`，只回 `hasToken` / `hasUrl`。

**工程**
- `docker-compose.yml`：面板容器改以宿主机 uid 运行（`user: "${PUID:-1000}:${PGID:-1000}"`），`data/state.json` 不再是 root 属主；Caddy 镜像锁到 `2.11.9-alpine`（面板生成的 JSON 依赖该版本字段名）。
- `Dockerfile`：基础镜像锁版本（`node:22.23.5-bookworm-slim`、`cloudflared:2026.10.7`），并支持 `--build-arg` 覆盖镜像与 npm 源。
- 中文说明改名 `README.zh-CN.md`，`README.md` 改为英文默认版，两页顶部可互相切换。
- 新增 `CHANGELOG.md`、GitHub Actions 冒烟测试。
- 新增 2 条接口断言（设置回包脱敏）。

## v0.8.0

- 前端重做为多页面（概览 / 隧道 / 规则 / 工具 / 观测 / 设置）+ 设计系统（深色默认、响应式、1200/720 断点）。
- 新增：流量趋势图、出口在线历史、通知发送记录、系统信息表、只读账号、Ctrl+K 命令面板、规则搜索、
  作用域记忆、访问统计筛选、日志暂停/只看错误。
- 修：导入脱敏配置会把面板密码清空；概览 SVG 用了不存在的 CSS 变量名；jsdom 测试绕过鉴权导致误判。
- 测试入库：`test/api.test.mjs`（78）+ `test/dom.test.cjs`（54）。

## v0.7.9

- Cloudflare API 集成做厚：`/api/cf/verify`（验证 token、自动带出账号/域名）、隧道详情（含边缘连接）、
  取隧道 token、DNS 增删查；README 补齐「能做什么 / 做不到什么」与错误对照表。

## v0.7.8

- 修分享链接 `/s/<token>` 被 `/` 兜底规则吃掉（分享路由现在插在业务规则之前）。

## v0.7.7

- 面板内置测速（`/__bench/ping`、`/__bench/blob`、`/api/bench/local`），工具箱一键测延迟与吞吐。

## v0.7.6

- 修代理规则页编辑时被 5 秒轮询覆盖（脏标记 + 焦点保护）；`/api/tunnels` 补 `publicUrl`。

## v0.7.5

- Tunnel token 粘贴容错：粘整条 `cloudflared service install ...` 命令会自动抠出 token 并校验。

## v0.7.4

- cloudflared 报 `token is not valid` / 连续 5 次启动失败 → 标记 fatal 并停止自动重试（此前每 5 秒重启刷日志）。

## v0.7.3

- 命名隧道接入；面板登录 + 8 次错密码锁 10 分钟；Caddy `trusted_proxies`(Cloudflare 22 段) + `CF-Connecting-IP`
  取真实客户端 IP（否则 IP 白名单在隧道后面形同虚设）；导入保留密钥。

## v0.7.2

- WebSocket 自测、通知冷却与静默时段、备份对比、Prometheus 指标规范化 + Grafana 面板。

## v0.7.1

- 上游健康探测、规则遮蔽检测、Caddy 配置预览、CSP 等安全头、`/api` 限流、ETag/gzip。

## v0.7.0

- 多页面架构落地（侧边导航 + 页面片段 + 共享设计系统），旧单页保留在 `/legacy`。

## v0.6.0

- B/C/D 三档：Docker 容器一键加规则、一次性分享链接、维护模式、IP 黑名单、限流开关、掉线通知
  （generic/钉钉/飞书/Bark）、Cloudflare API、`/metrics`、`/badge.svg`、日志下载。

## v0.5.0

- 规则自检三件套（测上游 / 模拟匹配 / 访问统计）、一键回滚、访问日志落盘。

## v0.4.x

- 出口绑定规则、左右两栏布局、出口切换做成顶部 tab。

## v0.3.x

- 多隧道出口并行（state v3）、顶部 tab、根路径提示条。

## v0.2.x

- 多页面前身：脏标记防轮询覆盖、Cloudflare 配置教程写进面板与文档。

## v0.1.0

- 首个可用版本：单隧道 + 路径分流 + 面板 CRUD。
