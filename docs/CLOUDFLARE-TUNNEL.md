# 申请 Cloudflare 隧道（拿 token）的完整教程

> 这份文档是「怎么在 Cloudflare 那边申请一条隧道、拿到 token、再接到面板里」的操作手册。
> 面板里同一份内容在「设置 → 出口」卡片下的说明里也有摘要；完整版以本文为准。

---

## 0. 前提

| 项 | 要求 |
|---|---|
| 域名 | 托管在 Cloudflare（NS 已指向 CF），本仓库用的是 `jianghugs.shop` |
| 账号权限 | Zero Trust 已开通（Free 版够用）；需要能改 DNS 与 Tunnels |
| 网络 | 跑 cloudflared 的那台机器能出站访问 **7844**（QUIC）与 **443**（TCP 回退） |
| 面板 | 已在跑（`cf-tunnel-panel-blue:8090` 或 `green:8095`，谁是 leader 用 `/healthz` 看） |

---

## 1. 方式 A：面板一键新建（推荐）

面板 → **出口** → 右上角「一键新建出口」：

1. 填 **公网域名**：例如 `app.jianghugs.shop`（必须是本账号下的子域，要带点）；
2. 填 **上游**：`http://127.0.0.1:8080`（面板自己的 Caddy，分流都在这里做；也可以是别的容器地址）；
3. 可勾「同时加到本地面板（只留一条规则）」；
4. 想先看看会发生什么，勾「只演练」。

面板会依次做 5 件事，任何一步失败都会在结果表里标出来：

| 步骤 | 调用 | 说明 |
|---|---|---|
| 建隧道 | `POST /accounts/<acc>/cfd_tunnel` | `config_src: cloudflare`（远程托管配置） |
| 取 token | `GET .../cfd_tunnel/<id>/token` | 拿到 `eyJ…` 184 字符那串 |
| 写 ingress | `PUT .../cfd_tunnel/<id>/configurations` | **不写就会 1033**：把 `{hostname, service}` 插到已有条目后、保留尾部 `http_status:404` |
| 建 DNS | `POST /zones/<zone>/dns_records` | `CNAME <tunnelId>.cfargotunnel.com`，橙云（proxied） |
| 本地接入 | `POST /api/tunnels` | 建出口记录并 `startTunnel`，6×2.5s 轮询公网可达性 |

「只演练」会把上面 5 步的计划打出来但不调 Cloudflare，适合先确认域名/上游写对没有。

---

## 2. 方式 B：在 Cloudflare 后台手工建

1. 打开 <https://one.dash.cloudflare.com> → **Networks → Tunnels** → **Create a tunnel**；
2. 选 **Cloudflared** → 起个名字（例如 `panel-main`）→ Save；
3. 页面上会出现一段安装命令，形如：

   ```bash
   cloudflared service install eyJhIjoi...VGswWVRFMCJ9
   # 或 docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token eyJ...
   ```

   **`--token` 后面那串就是 token**（184 字符，`eyJh` 开头、`J9` 结尾）。
   也可以回 **Tunnels 列表 → 该隧道右侧的 token 图标**随时再取一次（滚轮菜单里还有个「Refresh token」，旧的会立刻失效）。
4. 切到 **Public Hostnames** 标签，加一条：
   - Subdomain `app`，Domain `jianghugs.shop`
   - Service `HTTP` → `127.0.0.1:8080`（指向面板的 Caddy）
   - 手工建的话**这一步必须做**，否则访问域名是 1033。
5. DNS 会自动生成 `CNAME app → <tunnelId>.cfargotunnel.com`，确认是**橙云**（Proxied）。

---

## 3. 把 token 接到面板里

面板 → **出口** → 「命名隧道」→ 粘贴 token → 保存。

容错行为（实测）：

- 直接粘**整条 `docker run … --token eyJ…` 命令**也行，面板会用正则把 `eyJ…` 抠出来并校验 `{a,t,s}` 三段；
- token 不合法（例如被换过、或复制漏字符）时，出口会停在「尚未检测到连接」，日志里是 `Provided Tunnel token is not valid.`。面板对这类**致命错误不再无限重启**，只重试有限次；
- 命名隧道模式下，Cloudflare 侧 ingress 固定指向本机 Caddy：**分流规则全在面板里配**（路径、域名、strip、Basic、限流…），改完 1–2 秒内热更。

---

## 4. 验收

```bash
# 1) 面板自身
curl -s https://panel.jianghugs.shop/healthz   # expect: version / mode=leader / drift=false

# 2) 新域名
curl -sI https://app.jianghugs.shop/ | head -3 # expect: HTTP/2 200 或 302，且带 cf-ray

# 3) 面板内体检（会检查 Caddy、出口、Prometheus、Grafana、磁盘…）
curl -s -u admin:*** http://127.0.0.1:8090/api/selfcheck | python3 -m json.tool | head -40
```

体检里 `出口：<名字>` 一项会同时看「进程在不在」和「公网能不能通」；`出口链路稳定性` 会看最近 10 分钟 cloudflared 有没有自己重连。

---

## 5. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 访问域名 **1033** | 隧道没写 ingress / Public Hostname 没加 | 用方式 A 一键建，或在后台补 Public Hostnames |
| **530 / 502** | 隧道通了但 Caddy 没接住（上游挂、规则没匹配） | 面板「规则 → 模拟匹配」看命中；`curl -H 'Host: <域名>' http://127.0.0.1:8080/` |
| 面板显示「尚未检测到连接」 | token 复制不全 / 被 Refresh 过 | 重新取 token；确认长度 184、`eyJh` 开头 |
| 出口无限重启刷日志 | 致命错误（token invalid） | 已在 v0.7.4 修：致命错误只重试有限次并停止 |
| **只有局域网能访问**，公网 530 | 本机在 CGNAT 后，或 cloudflared 没起 | 看出口状态；`docker logs cf-tunnel-panel-<色> \| grep cloudflared` |
| 重连次数一直在涨 | QUIC 被中途掐断 | 出口设置里把协议从 `auto` 改成 `http2`（走 TCP，穿 NAT 更稳） |
| `curl` 返回一堆乱码/空 | 面板对 JSON 开了 gzip | 加 `--compressed` |

---

## 6. token 轮换与删除

- **换 token**：Cloudflare 后台 Tunnels → 该隧道的 `⋯` → **Refresh token**（旧 token 立刻失效），回面板把出口的 token 更新即可；也可以「复制成新出口」再删掉旧的。
- **删隧道**：先删面板里的出口（会停掉 cloudflared），再去 Cloudflare 删隧道和那条 CNAME，避免留下 `530` 的死记录。
- ⚠️ token 等同于「以该隧道身份连入你的账户」，贴到聊天/工单里就等于泄露；泄露后最省事的处置就是 Refresh 一次。

## 一条隧道只给一台机器用（2026-11-26 的实际故障）

同一个隧道 token 可以被**多台机器同时连接**，Cloudflare 会把请求轮流分给每个连接器（connector）。如果其中一台机器的 `127.0.0.1:8080` 跑的不是面板（例如那台机器上是 frps），那么约 1/3–1/2 的请求会拿到 frp 的 404 页 —— 表现为「网页样式全没了」「一会儿能打开一会儿 404」。

排查（有 CF API token 就能跑）：

```python
# 看这条隧道现在有几个连接器、分别来自哪个 IP
GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}/connections
# 返回里每个 client 有 version/arch，conns[].origin_ip 是来源 IP
```

修复顺序（本次采用第三种）：

1. 在多余的那台机器上停掉 cloudflared（`docker stop <name>` 或 `systemctl stop cloudflared`）；
2. 轮换隧道 token（`Refresh token`），旧 token 全部失效，再更新面板里出口的 token；
3. **给面板单开一条隧道**：新建隧道 → ingress 指向 `http://127.0.0.1:8080` → 把 `panel`/`grafana` 的 CNAME 切到新隧道 → 面板里新增一个 token 模式出口并启动 → 旧隧道留给实验用。

2026-11-26 起：`panel.jianghugs.shop` 与 `grafana.jianghugs.shop` 走专用隧道 `b826c185`（出口「面板专用出口（新）」），实验用的旧隧道 `0cbc1a01` 已从这两条 CNAME 上摘除，ingress 只剩 404。
