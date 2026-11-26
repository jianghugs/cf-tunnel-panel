'use strict';
/**
 * Caddy 配置生成（分流规则、维护页）
 * 从 src/server.js 按职责拆出（v0.9.0），仅做搬运，行为不变。
 */

const http=require('http'); const https=require('https');

const path=require('path');
const net=require('net');
 const bcrypt=require('bcryptjs');

const { CLOUDFLARE_DEFAULT_RANGES, LB_POLICIES } = require('./paths');

// admin 监听地跟着 CADDY_ADMIN 走（默认 20190，非常用端口），否则每次下发配置都会把 Caddy 拉回硬编码的 2019
let ADMIN_PORT = '20190';
let ADMIN_LISTEN = '127.0.0.1:20190';
try {
  const _a = new URL(require('./paths').CADDY_ADMIN);
  ADMIN_PORT = _a.port || '20190';
  ADMIN_LISTEN = `${_a.hostname}:${ADMIN_PORT}`;
} catch {}
const { log, parseCidrs, parseHeaderLines, parseUpstream } = require('./util');
const _state = require('./state');
const state = _state.stateProxy;
const { runtimes, tunnelById } = require('./registry');

// ---- 面板自身的多槽位（滚动升级） -------------------------------------------
// 面板路由的上游是 127.0.0.1:8090 这类回环地址时，如果配置了 PANEL_SLOT_PEERS
// （例如 "8091"），就把它展开成「所有槽位 + 主动健康检查」：
//   - 老实例活着 → 一律走它（lb_policy: first，顺序固定，行为可预测）
//   - 老实例挂掉 → Caddy 探活失败自动跳过，流量落到新实例，不需要人工切
const PANEL_SLOT_RE = /^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost):(\d+)\/?$/i;


/**
 * 同机另一个槽位是否在监听：滚动升级期间两台并存，平时另一台是停着的。
 * 停着的时候不要下发主动健康检查 —— 每 2 秒一次的探测失败会在 Caddy 日志里堆出
 * 十几万行/天（实测占日志 99.85%），却一个字节的有用信息都不带；而且日志文件被这些
 * 噪音填满后，Caddy 轮转得更快，流量趋势图能覆盖的时间窗口也跟着缩水。
 * 探测结果异步刷新、同步读取：没探到之前一律当作「在线」，保持原有行为。
 */
const SELF_PORT = String(process.env.PORT || 8090);
const _peerLive = new Map();
let _peerTimer = null;
function probePort(port, timeout = 150) {
  const num = Number(port);
  if (!Number.isInteger(num) || num < 1 || num > 65535) return Promise.resolve(false);
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: num });
    const done = (v) => { try { sock.destroy(); } catch { /* ignore */ } resolve(v); };
    sock.setTimeout(timeout, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}
async function refreshPeerLiveness() {
  for (const port of panelSlots()) {
    const key = String(port);
    if (key === SELF_PORT) { _peerLive.set(key, true); continue; }
    const ok = await probePort(port);
    if (_peerLive.get(key) === true && ok === false) log('info', `同机槽位 ${key} 已下线，停止对它的健康检查`);
    if (_peerLive.get(key) === false && ok === true) log('info', `同机槽位 ${key} 已上线，恢复双上游负载均衡`);
    _peerLive.set(key, ok);
  }
}
function startPeerWatch() {
  if (_peerTimer) return;
  refreshPeerLiveness().catch(() => {});
  _peerTimer = setInterval(() => { refreshPeerLiveness().catch(() => {}); }, 3000);
  if (_peerTimer.unref) _peerTimer.unref();
}
function peerLive(port) {
  const v = _peerLive.get(String(port));
  return v === undefined ? true : v;
}

function panelSlots() {
  const self = String(process.env.PORT || 8090);
  const peers = String(process.env.PANEL_SLOT_PEERS || '')
    .split(',').map((x) => x.trim()).filter(Boolean);
  return [...new Set([self, ...peers])];
}

function expandPanelSlots(upstream) {
  const m = String(upstream || '').match(PANEL_SLOT_RE);
  if (!m) return null;
  const slots = panelSlots();
  if (slots.length < 2 || !slots.includes(m[1])) return null;
  return slots.map((port) => `127.0.0.1:${port}`);
}

function buildRouteHandlers(r) {
  const handle = [];

  // 1) 基础认证（口令在保存时已转 bcrypt 哈希）
  if (r.basicAuth && r.basicAuth.user && r.basicAuth.hash) {
    handle.push({
      handler: 'authentication',
      providers: {
        http_basic: {
          hash: { algorithm: 'bcrypt' },
          accounts: [{ username: r.basicAuth.user, password: r.basicAuth.hash }],
        },
      },
    });
  }

  // 2) 剥离路径前缀
  if (r.strip && r.path) {
    const prefix = r.path.replace(/\*+$/, '').replace(/\/+$/, '');
    if (prefix) handle.push({ handler: 'rewrite', strip_path_prefix: prefix });
  }

  // 3) 反向代理
  const main = parseUpstream(r.upstream);
  const slotUps = expandPanelSlots(r.upstream);
  // 只把在监听的槽位写进上游：停着的那一色留着只会让每个请求先吃一次 connect refused
  const liveUps = slotUps ? slotUps.filter((u) => peerLive(String(u).split(':').pop())) : null;
  const useUps = liveUps && liveUps.length ? liveUps : null;
  const upstreams = useUps ? useUps.map((dial) => ({ dial })) : [{ dial: main.dial }];
  if (r.backupUpstream) upstreams.push({ dial: parseUpstream(r.backupUpstream).dial });

  const proxy = { handler: 'reverse_proxy', upstreams };
  const transport = { protocol: 'http' };
  if (main.scheme === 'https') transport.tls = {};
  if (r.timeoutSec > 0) transport.response_header_timeout = r.timeoutSec * 1e9;
  proxy.transport = transport;
  if (r.timeoutSec > 0) proxy.flush_interval = 0;

  if (useUps) {
    // 面板槽位：优先第一个（老实例），它不健康时自动跳过 → 滚动升级不需要人工切流量
    // 用 round_robin 而不是 first：两台都健康时轮询（滚动升级期间短暂并存，代码版本可能不同但
    // 共享同一份 data/，行为一致）；一台挂掉时健康检查把它剔除，且重试会立刻落到另一台上 ——
    // 用 first 会在「老实例刚停、健康检查还没标记不健康」那段窗口里反复重试同一台死上游，
    // 实测表现为 3~5 秒的 502。
    proxy.load_balancing = { selection_policy: { policy: 'round_robin' }, try_duration: 3e9, try_interval: 250e6 };
    // 只有两台都在监听时才需要健康检查：单槽位时没有可切换的对象，检查只会刷日志
    if (useUps.length > 1) {
      proxy.health_checks = {
        active: { uri: '/healthz', interval: '2s', timeout: '1s', fails: 2, passes: 1 },
      };
    }
    // 不要写 fail_duration / max_fails：Caddy 2.11.9 的 reverse_proxy 不认这个字段
    // （会 400 unknown field "fail_duration"，整份配置下发失败）。被动健康检查交给默认值。
  } else if (upstreams.length > 1) {
    // 注意：Caddy v2.11 起字段名是 selection_policy（老写法 selection 会 400 unknown field）
    proxy.load_balancing = {
      selection_policy: { policy: LB_POLICIES.includes(r.lbPolicy) ? r.lbPolicy : 'round_robin' },
      try_duration: (r.lbTryDuration > 0 ? r.lbTryDuration : 10) * 1e9,
      try_interval: 500e6,
    };
  }

  const reqSet = Object.assign(
    {
      'X-Forwarded-Host': ['{http.request.host}'],
      'X-Real-IP': ['{http.request.remote.host}'],
      'X-Panel-Route': [r.name || r.id],
    },
    parseHeaderLines(r.headersReq),
  );
  proxy.headers = { request: { set: reqSet } };
  const resSet = parseHeaderLines(r.headersRes);
  if (Object.keys(resSet).length) proxy.headers.response = { set: resSet };

  handle.push(proxy);
  return handle;
}

// 某个出口对外的域名：命名隧道取配置里的 publicHostname，快速隧道取运行时拿到的 trycloudflare 域名
function tunnelHostOf(id) {
  const t = tunnelById(id);
  if (!t) return '';
  if (t.mode === 'named') return String(t.publicHostname || '').trim();
  const rt = runtimes.get(id);
  const m = String((rt && rt.url) || '').match(/^https?:\/\/([^/:]+)/i);
  return m ? m[1] : '';
}

function buildMatch(r, forcedHost) {
  const m = {};
  const explicit = String(r.host || '').split(',').map((s) => s.trim()).filter(Boolean);
  const hosts = explicit.length ? explicit : (forcedHost ? [forcedHost] : []);
  if (hosts.length) m.host = hosts;
  if (r.path) m.path = [r.path.endsWith('*') ? r.path : r.path.replace(/\/+$/, '') + '*'];
  if (r.matchMethod) m.method = String(r.matchMethod).split(',').map((s) => s.trim()).filter(Boolean);
  const cidrs = parseCidrs(r.ipAllow);
  if (cidrs.length) m.remote_ip = { ranges: cidrs };
  return m;
}

let lastSkipped = [];
function buildCaddyConfig() {
  const routes = [];
  let securityTail = 0;
  lastSkipped = [];

  // ① IP 黑名单：最先匹配，直接 403（连"这里有没有服务"都不暴露）
  let deny = [];
  try { deny = parseCidrs(state.settings.security && state.settings.security.ipDeny); } catch { deny = []; }
  if (deny.length) {
    routes.push({
      match: [{ remote_ip: { ranges: deny } }],
      handle: [{
        handler: 'static_response', status_code: 403,
        headers: { 'Content-Type': ['text/plain; charset=utf-8'] }, body: '403 forbidden',
      }],
      terminal: true,
    });
  }

  // ② 限流：只有自定义 Caddy 镜像（带 caddy-ratelimit）时才下发，否则会 load 失败
  const rl = (state.settings.security || {}).rateLimit || {};
  if (rl.enabled && Number(rl.rps) > 0) {
    if (process.env.CADDY_RATELIMIT === '1') {
      routes.push({
        handle: [{
          handler: 'rate_limit',
          zones: [{
            key: '{remote_host}',
            events: Math.max(1, Math.round(Number(rl.rps))),
            window: '1s',
          }],
        }],
        terminal: false,
      });
    } else if (!global.__rlWarned) {
      global.__rlWarned = true;
      log('已勾选限流，但当前 Caddy 不带 rate_limit 模块 —— 见 docs/RATELIMIT.md 换自定义镜像并设 CADDY_RATELIMIT=1', 'panel');
    }
  }

  // ③ 维护模式：整站 503，隧道和出口不用动，关掉即恢复
  const maint = state.settings.maintenance || {};
  if (maint.on) {
    routes.push({
      handle: [{
        handler: 'static_response',
        status_code: 503,
        headers: {
          'Content-Type': ['text/html; charset=utf-8'],
          'Retry-After': [String(Math.max(1, Math.min(86400, Number(maint.retryAfter) || 300)))],
          'Cache-Control': ['no-store'],
        },
        body: maintPage(String(maint.body || '站点正在维护，请稍后再来。')),
      }],
      terminal: true,
    });
  } else {
    securityTail = routes.length; // 分享链接要插在「安全层之后、业务规则之前」
    for (const r of state.routes.filter((x) => x.enabled && x.upstream)) {
      let host = '';
      if (r.tunnelId) {
        host = tunnelHostOf(r.tunnelId);
        if (!host) {
          const t = tunnelById(r.tunnelId);
          lastSkipped.push({ id: r.id, name: r.name, path: r.path, tunnelId: r.tunnelId,
            reason: t ? `出口「${t.name}」还没有公网域名（先启动它）` : '所属出口已被删除' });
          continue;
        }
      }
      routes.push({ match: [buildMatch(r, host)], handle: buildRouteHandlers(r), terminal: true });
    }
  }

  // ③ 一次性分享链接：/s/<token>/… 直通某个上游，到期由 janitor 删除
  const now = Date.now();
  const shareRoutes = [];
  for (const s of (state.shares || []).filter((x) => x && x.token && x.expiresAt > now && x.upstream)) {
    let up = null;
    try { up = parseUpstream(s.upstream); } catch { up = null; }
    if (!up) continue;
    shareRoutes.push({
      match: [{ path: [`/s/${s.token}`, `/s/${s.token}/*`] }],
      handle: [
        { handler: 'rewrite', strip_path_prefix: `/s/${s.token}` },
        { handler: 'reverse_proxy', upstreams: [{ dial: up.dial }] },
      ],
      terminal: true,
    });
  }
  // 分享链接必须排在业务规则前面：否则任何 path=/ 的兜底规则（面板、静态站）会先吃掉 /s/<token>
  if (shareRoutes.length) routes.splice(securityTail, 0, ...shareRoutes);

  routes.push({
    handle: [
      {
        handler: 'static_response',
        status_code: 404,
        headers: { 'Content-Type': ['text/plain; charset=utf-8'] },
        body: String(state.settings.notFoundBody || 'not found'),
      },
    ],
  });

  return {
    // admin 监听地跟着 CADDY_ADMIN 走：默认 20190（非常用端口），换了环境变量这里也跟着换，
    // 否则每次下发配置都会把 Caddy 拉回硬编码的 2019。
    admin: { listen: ADMIN_LISTEN, origins: [CADDY_ADMIN, `http://localhost:${ADMIN_PORT}`] },
    logging: {
      logs: {
        default: {
          level: 'INFO',
          encoder: { format: 'json' },
          // 访问日志落文件，面板据此做「最近请求 / 状态码 / 命中了哪条规则」统计
          writer: { output: 'file', filename: accessLogPathForCaddy(), roll_size_mb: 10, roll_keep: 3, roll_keep_for: '168h' },
        },
      },
    },
    apps: {
      http: {
        servers: {
          main: {
            listen: [state.settings.caddyListen || ':8080'],
            automatic_https: { disable: true },
            logs: {}, // 打开 access log（写进上面的 default logger）
            // 流量经 Cloudflare 隧道进来时，TCP 对端是 cloudflared/边缘节点，
            // 真实访客 IP 在 CF-Connecting-IP 里。不配这两项，IP 白名单/黑名单
            // 会把所有人当成同一个 IP（127.0.0.1 或某个边缘地址）。
            trusted_proxies: { source: 'static', ranges: cloudflareRanges() },
            client_ip_headers: ['CF-Connecting-IP'],
            routes,
          },
        },
      },
    },
  };
}

function maintPage(body) {
  const esc = String(body).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>维护中</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f172a;color:#e2e8f0;
font:16px/1.7 system-ui,-apple-system,"PingFang SC","Microsoft Yahei",sans-serif;padding:24px}
.box{max-width:560px;text-align:center}.ic{font-size:44px;margin-bottom:8px}
h1{font-size:20px;margin:0 0 10px}p{color:#94a3b8;white-space:pre-wrap;margin:0}</style>
<div class="box"><div class="ic">🛠️</div><h1>站点维护中</h1><p>${esc}</p></div>`;
}

/** 是否落在静默时段（支持跨零点，如 23:00-07:00；可逗号分隔多段）。 */
const caddy = { ok: false, error: null, lastPush: 0, routeCount: 0 };

function cloudflareRanges() {
  const custom = String(process.env.CLOUDFLARE_IPS || '').trim();
  if (!custom) return CLOUDFLARE_DEFAULT_RANGES;
  return custom.split(',').map((x) => x.trim()).filter(Boolean);
}

const { CADDY_ADMIN, accessLogPathForCaddy } = require('./paths');

module.exports = { buildCaddyConfig, buildMatch, buildRouteHandlers, caddy, cloudflareRanges, lastSkipped, maintPage, tunnelHostOf, PANEL_SLOT_RE, panelSlots, startPeerWatch, peerLive };
