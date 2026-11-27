'use strict';
/**
 * cf-tunnel-panel —— 可视化 cloudflared 隧道 + Caddy 反向代理面板
 *
 * 这个文件现在只做三件事：
 *   1) 把 src/core/* 的模块装配起来（依赖注入式，模块之间不互相抓全局）；
 *   2) 定义 HTTP 路由 handler（唯一的路由表）；
 *   3) 启动进程（loadState → pushCaddy → startAll → startMonitor）。
 *
 * 各模块分工见 README §12「代码结构」。
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');
const net = require('net');
const fs = require('fs');
const path = require('path');

// ---- OpenAPI 描述（GET /api/openapi 用）：首次读盘后进程内缓存
let _openapiCache = null;
function readOpenapi() {
  if (_openapiCache) return _openapiCache;
  const f = path.join(__dirname, '..', 'docs', 'openapi.json');
  _openapiCache = JSON.parse(fs.readFileSync(f, 'utf8'));
  return _openapiCache;
}
const os = require('os');
const { spawn } = require('child_process');
const QRCode = require('qrcode');
const bcrypt = require('bcryptjs');

const _audit = require('./core/audit');
const { record: auditRecord, list: auditList, stats: auditStats, byHour: auditByHour, actionOf, days: auditDays } = _audit;

const _paths = require('./core/paths');
const { ACCESS_LOG_FILE, ASSET_DIR, ASSET_TYPES, BACKUP_DIR, CADDY_ADMIN, CADDY_LOG_DIR, CLOUDFLARED, CLOUDFLARE_DEFAULT_RANGES, DATA_DIR, LB_POLICIES, LOGLEVELS, LOG_MAX, METHODS, PAGES, PAGE_DIR, PORT, PROTOCOLS, STATE_FILE, VERSION, WEB_DIR, accessLogPathForCaddy, pkgVersion } = _paths;

const _util = require('./core/util');
const { SEC_HEADERS, log, logSeq, logs, parseCidrs, parseHeaderLines, parseUpstream, rateLimited, readBody, rid, rlHits, sendJson, sseClients } = _util;

const _state = require('./core/state');
const { maybeReloadState } = _state;
const { acquireLock } = _state;
const { stateProxy, setState, deepDefault, defaultOrigin, defaultState, isFreshState, loadState, migrateState, newTunnel, normalizeTunnels, publicRoute, publicSettings, saveState, validateRoutes } = _state;
// 注意：必须是 stateProxy（指向模块内部同一个对象），直接把 state 解构出来会拿到
// loadState() 之前那个默认对象，导致 /api/state 看到的路由/出口数量和真实的不一致。
const state = stateProxy;

const _registry = require('./core/registry');
const { firstTunnel, publicUrlOf, runtimes, tunnelById, tunnelRt } = _registry;

const _auth = require('./core/auth');
const { clearBasicCache, AUTH_BLOCK_MS, AUTH_FAIL_LIMIT, AUTH_FAIL_WINDOW, authBlockedFor, authFails, authOk, checkAuth, clearAuthFail, clientIpOf, noteAuthFail, login , completeTotp } = _auth;

const _session = require('./core/session');
const history = require('./core/history');
const session = _session;

const secret = require('./core/secret');
const ident = require('./core/ident');
const _selfcheck = require('./core/selfcheck');
const configcode = require('./core/configcode');
const guard = require('./core/guard');
const lease = require('./core/lease');
const totp = require('./core/totp');
const perm = require('./core/perm');

const _caddy = require('./core/caddy');
const { buildCaddyConfig, buildMatch, buildRouteHandlers, caddy, cloudflareRanges, lastSkipped, maintPage, tunnelHostOf, PANEL_SLOT_RE, panelSlots } = _caddy;

const _pusher = require('./core/pusher');
const { pushCaddy, pushTimer, schedulePush } = _pusher;

const _tunnels = require('./core/tunnels');
const { QUICK_RE, applyTunnelFields, normalizeTunnelToken, publicTunnels, runtimeOf, startAll, startTunnel, stopAll, stopTunnel, syncTunnels, tokenTunnelOf, tunnelArgs } = _tunnels;

const _insight = require('./core/insight');
const { countPanelReq, upstreamHealth, HISTORY_MAX, badgeSvg, diffRoutes, healthOf, histTick, metricsText, readAccess, refreshUpstreamHealth, requestsLastMinute, rtHistory, sampleHistory, securityAttempts, shadowReport, simulateMatch, systemInfo, tcpProbeOnce, trafficByHour, trafficByPath, upstreamTarget } = _insight;

const _bench = require('./core/bench');
const { BENCH_MAX_MB, benchLocalOnce, coloOf, sendBenchBlob } = _bench;

const _probe = require('./core/probe');
const { getV4 } = require('./core/httpv4');
const { curlSelf, probeUpstream, wsProbe } = _probe;

const _integrations = require('./core/integrations');
const { cfApi, dockerApi, dockerContainers, pickWebPort } = _integrations;

const _notify = require('./core/notify');
const { inQuietHours, notify, notifyHistory, recordNotify } = _notify;

const _i18n = require('./core/i18n');
const { langOf } = _i18n;

const _web = require('./core/web');
const { pageShell, readPage, serveText, loginPage } = _web;

const _monitor = require('./core/monitor');
const { seenCaddyOk, shareJanitor, shareUrl, startMonitor } = _monitor;

const _httpStatic = require('./http/static');
const _httpBoot = require('./http/boot');
const _httpOnReq = require('./http/onreq');

const _routesBackups = require('./routes/backups');
const _routesShares = require('./routes/shares');
const _routesCf = require('./routes/cf');
const _routesAuthroutes = require('./routes/authroutes');
const _routesOps = require('./routes/ops');
const _routesSettings = require('./routes/settings');
const _routesRules = require('./routes/rules');
const _routesObserve = require('./routes/observe');
const _routesMonitor = require('./routes/monitor');
const _routesTunnels = require('./routes/tunnels');

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (p === '/healthz') {
    const running = state.tunnels.filter((t) => tunnelRt(t.id).status === 'running').length;
    let build = {};
    try { build = ident.buildInfo(); } catch { build = {}; }
    return sendJson(res, 200, {
      ok: true,
      tunnels: { total: state.tunnels.length, running },
      tunnel: running > 0 ? 'running' : state.tunnels.length ? 'stopped' : 'none',
      version: VERSION,
      mode: lease.isLeader() ? 'leader' : 'standby',
      instance: lease.instanceId(),
      // 集群视角：不管这次请求落到哪台，都能看到当前主实例是谁（监控/排障用）
      leader: (lease.status().holder || {}).id || null,
      // 代码指纹：drift=true 说明容器里是 docker cp 热替换的代码，跟镜像不一致
      code: build.code || null,
      imageCode: build.build || null,
      sha: build.sha || null,
      drift: !!build.drift,
    });
  }
  // 状态徽章：故意放在鉴权之前，方便 README / 监控页直接贴 <img src=".../badge.svg">
  if (p === '/badge.svg') {
    const run = state.tunnels.filter((t) => tunnelRt(t.id).status === 'running').length;
    const svg = badgeSvg('cloudflared', `${run}/${state.tunnels.length} up`, run > 0);
    res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(svg);
  }
  // 监控端点：免登录，方便 Prometheus 直接抓（内容只有聚合计数，不含 token/规则细节）
  // 按出口的 5 分钟滚动计数（Grafana 用；走访问日志，不额外占用 cloudflared 侧）
  function exitMetricsLines() {
    try {
      const winMin = 5;
      const d = readAccess(4000, { since: Date.now() - winMin * 60 * 1000, maxBytes: 1 * 1024 * 1024 });
      const rows = (d && d.rows) || [];
      const hostOf = (t) => {
        const u = publicUrlOf(t) || '';
        const m = /^https?:\/\/([^/:]+)/i.exec(u);
        return m ? m[1].toLowerCase() : '';
      };
      const byHost = new Map();
      for (const t of state.tunnels) {
        const h = hostOf(t);
        if (h) byHost.set(h, t.id);
      }
      const acc = new Map(); // id -> {count, err}
      for (const r of rows) {
        const host = String(r.host || '').toLowerCase();
        const id = byHost.get(host);
        if (!id) continue;
        const a = acc.get(id) || { count: 0, err: 0 };
        a.count += 1;
        const st = Number(r.status) || 0;
        if (st >= 400) a.err += 1;
        acc.set(id, a);
      }
      const out = [
        `# HELP cf_exit_requests_5m 每个出口最近 ${winMin} 分钟的请求数（滚动窗口，来自 access log）`,
        '# TYPE cf_exit_requests_5m gauge',
        '# HELP cf_exit_errors_5m 每个出口最近 5 分钟的 4xx+5xx 数',
        '# TYPE cf_exit_errors_5m gauge',
      ];
      for (const t of state.tunnels) {
        const a = acc.get(t.id) || { count: 0, err: 0 };
        const lbl = `id="${String(t.id).replace(/"/g, '')}",name="${String(t.name).replace(/"/g, '')}",mode="${String(t.mode || 'quick').replace(/"/g, '')}"`;
        out.push(`cf_exit_requests_5m{${lbl}} ${a.count}`);
        out.push(`cf_exit_errors_5m{${lbl}} ${a.err}`);
      }
      return out.join('\n') + '\n';
    } catch (e) {
      return '';
    }
  }

  if (p === '/metrics') {
    // 公网封禁：Cloudflare 经隧道转发时必带 cf-connecting-ip / cf-ray。
    // 本机直连与 Prometheus 抓取（127.0.0.1:8080）都不带这两个头，所以监控不受影响。
    if (req.headers['cf-connecting-ip'] || req.headers['cf-ray']) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
    let extra = '';
    try {
      const m = require('./core/metrics').snapshot();
      const g = m.gauges, c = m.counters;
      extra += '# HELP cf_caddy_push_ms 最近一次 Caddy 配置下发耗时（毫秒）\n';
      extra += '# TYPE cf_caddy_push_ms gauge\n';
      extra += 'cf_caddy_push_ms ' + (g.caddy_push_ms || 0) + '\n';
      extra += '# HELP cf_caddy_push_failures_total Caddy 配置下发失败累计\n';
      extra += '# TYPE cf_caddy_push_failures_total counter\n';
      extra += 'cf_caddy_push_failures_total ' + (c.caddy_push_failures || 0) + '\n';
      extra += '# HELP cf_selfcheck_fails 最近一次体检的失败项数\n';
      extra += '# TYPE cf_selfcheck_fails gauge\n';
      extra += 'cf_selfcheck_fails ' + (g.selfcheck_fails || 0) + '\n';
      extra += '# HELP cf_selfcheck_warn 最近一次体检的警告项数\n';
      extra += '# TYPE cf_selfcheck_warn gauge\n';
      extra += 'cf_selfcheck_warn ' + (g.selfcheck_warn || 0) + '\n';
      extra += '# HELP cf_unhandled_rejections_total 未处理的 Promise 拒绝累计\n';
      extra += '# TYPE cf_unhandled_rejections_total counter\n';
      extra += 'cf_unhandled_rejections_total ' + (c.unhandled_rejections || 0) + '\n';
      extra += '# HELP cf_process_rss_bytes 进程常驻内存\n';
      extra += '# TYPE cf_process_rss_bytes gauge\n';
      extra += 'cf_process_rss_bytes ' + m.rss + '\n';
      try {
        const _cl = require('./core/insight').caddyLogStats();
        extra += '# HELP cf_caddy_log_bytes Caddy 访问日志目录占用（含轮转归档）\n';
        extra += '# TYPE cf_caddy_log_bytes gauge\n';
        extra += 'cf_caddy_log_bytes ' + _cl.bytes + '\n';
        extra += '# HELP cf_caddy_log_files Caddy 访问日志目录文件数\n';
        extra += '# TYPE cf_caddy_log_files gauge\n';
        extra += 'cf_caddy_log_files ' + _cl.files + '\n';
      } catch (e) {}
      if (m.loop) {
        extra += '# HELP cf_eventloop_p99_ms 事件循环延迟 p99（毫秒）\n';
        extra += '# TYPE cf_eventloop_p99_ms gauge\n';
        extra += 'cf_eventloop_p99_ms ' + m.loop.p99.toFixed(1) + '\n';
        extra += '# HELP cf_eventloop_max_ms 事件循环延迟最大值（毫秒）\n';
        extra += '# TYPE cf_eventloop_max_ms gauge\n';
        extra += 'cf_eventloop_max_ms ' + m.loop.max.toFixed(1) + '\n';
      }
    } catch (e) { /* 指标失败不影响主指标 */ }
    return res.end(metricsText() + exitMetricsLines() + extra);
  }

  // ---------- 登录页与会话接口（必须在鉴权门之前）----------
  const wantsPage = req.method === 'GET' && (p === '/' || PAGES.some((x) => x.path === p || x.path === p.replace(/\/$/, '')));
  if (p === '/login' && req.method === 'GET') {
    const cur = session.fromReq(req);
    if (cur) { res.writeHead(302, { Location: url.searchParams.get('next') || '/' }); return res.end(); }
    return serveText(req, res, loginPage({ next: url.searchParams.get('next') || '/', error: url.searchParams.get('e') || '', lang: langOf(req) }), 'text/html; charset=utf-8', 'no-store');
  }
  if (p === '/api/login' && req.method === 'POST') {
    const wait = authBlockedFor(req);
    if (wait > 0) return sendJson(res, 429, { ok: false, error: `尝试次数过多，${Math.ceil(wait / 60)} 分钟后再试`, retryAfter: wait });
    let body = {};
    try { body = await readBody(req); } catch { body = {}; }
    const ip = clientIpOf(req);
    const ua = req.headers['user-agent'] || '';

    // 第二段：口令已过，等验证码（或恢复码）
    if (body.challenge) {
      const r = completeTotp({ challenge: body.challenge, code: body.code, ip, ua, remember: !!body.remember });
      if (!r.ok) {
        noteAuthFail(req);
        log(`二次验证失败（${ip}）：${r.error}`, 'panel');
        auditRecord({ actor: `(二次验证)`, ip, method: 'POST', path: '/api/login', status: 401, action: '二次验证失败', target: String(r.error || ''), ok: false });
        return sendJson(res, 401, { ok: false, error: r.error });
      }
      clearAuthFail(req);
      auditRecord({ actor: r.session.user, ip, method: 'POST', path: '/api/login', status: 200, action: r.usedRecovery ? '登录成功（恢复码）' : '登录成功（二次验证）', target: r.session.role });
      res.setHeader('Set-Cookie', session.cookieHeader(r.session.rawId || r.session.id || '', { secure: session.isSecure(req), remember: !!body.remember }));
      return sendJson(res, 200, { ok: true, user: r.session.user, role: r.session.role, usedRecovery: !!r.usedRecovery });
    }

    const s2 = login({ user: body.user, pass: body.pass, ip, ua, remember: !!body.remember });
    if (!s2) {
      noteAuthFail(req);
      const st = authFails.get(ip) || {};
      const left = Math.max(0, AUTH_FAIL_LIMIT - (st.count || 0));
      log(`面板登录失败（${ip}，本窗口还剩 ${left} 次机会）`, 'panel');
      auditRecord({ actor: `${String(body.user || '(空)')}（口令错误）`, ip, method: 'POST', path: '/api/login', status: 401, action: '登录失败', target: String(body.user || ''), ok: false });
      return sendJson(res, 401, { ok: false, error: left > 0 ? `用户名或密码不对（还剩 ${left} 次机会）` : '错误次数过多，已临时锁定', left });
    }
    if (s2.needTotp) {
      log(`口令通过，等二次验证码（${ip}，${s2.user}）`, 'panel');
      return sendJson(res, 200, { ok: false, needTotp: true, challenge: s2.challenge, role: s2.role });
    }
    clearAuthFail(req);
    log(`面板登录成功（${ip}，${s2.user}${s2.role === 'viewer' ? ' 只读' : s2.role === 'operator' ? ' 运维' : ''}）`, 'panel');
    auditRecord({ actor: s2.user, ip, method: 'POST', path: '/api/login', status: 200, action: '登录成功', target: s2.role });
    res.setHeader('Set-Cookie', session.cookieHeader(s2.rawId || s2.id || '', { secure: session.isSecure(req), remember: !!(body && body.remember) }));
    return sendJson(res, 200, { ok: true, user: s2.user, role: s2.role });
  }
  if (p === '/api/logout' && req.method === 'POST') {
    const s = session.fromReq(req);
    if (s) session.revoke(s.rawId || s.key);
    res.setHeader('Set-Cookie', session.clearCookieHeader());
    return sendJson(res, 200, { ok: true });
  }

  // 静态资源与首帧脚本都免登录：登录页自己也要用 app.css，而且它们不含任何密钥。
  // 放在鉴权之前还有个好处：Cloudflare 能把这些 URL 当公开资源缓存。
  if (p === '/boot.js' && (req.method === 'GET' || req.method === 'HEAD')) {
    return _httpBoot.serve(req, res, { lang: langOf(req), dict: _i18n.clientDict() });
  }

  // ---------- Alertmanager 回调（用自己的令牌，不依赖面板登录）----------
  if (p === '/api/alerts/hook' && req.method === 'POST') {
    const body = await readBody(req);
    const cur = state.settings.alerts || (state.settings.alerts = { mutes: [], hookToken: '' });
    if (!cur.hookToken) {
      const tok = crypto.randomBytes(16).toString('hex');
      cur.hookToken = tok;
      saveState('alert-hook-token');
      return sendJson(res, 401, {
        ok: false,
        error: '第一次调用：已生成回调令牌。请用管理员登录面板，在「设置 → 监控嵌入 → 告警回调令牌」里复制，写进 alertmanager.yml 的 x-cfp-token 后再重试',
      });
    }
    const given = String(req.headers['x-cfp-token'] || new URL(req.url, 'http://x').searchParams.get('token') || '');
    if (given !== cur.hookToken) return sendJson(res, 403, { ok: false, error: '令牌不对（x-cfp-token）' });
    try {
      const list = Array.isArray(body.alerts) ? body.alerts : [];
      const firing = list.filter((a) => (a.status || '') === 'firing');
      const resolved = list.filter((a) => (a.status || '') === 'resolved');
      const labelOf = (a, k) => String((a.labels && a.labels[k]) || '');
      const line = (a, tag) => `[${tag}] ${labelOf(a, 'alertname')}${labelOf(a, 'name') ? ` · 出口 ${labelOf(a, 'name')}` : ''}${labelOf(a, 'severity') ? ` · ${labelOf(a, 'severity')}` : ''}\n${String((a.annotations && a.annotations.summary) || '').slice(0, 200)}`;
      const title = firing.length ? `Prometheus 告警：${firing.length} 条在响` : resolved.length ? 'Prometheus 告警已恢复' : 'Prometheus 告警';
      const text = [...firing.map((a) => line(a, '正在告警')), ...resolved.map((a) => line(a, '已恢复'))].join('\n\n').slice(0, 3000) || String(body.status || '');
      await _notify.notify('promAlert', title, text, { force: true });
      auditRecord({ action: '接收外部告警回调', target: `${firing.length} 响 / ${resolved.length} 恢复`, ip: clientIpOf(req), actor: 'alertmanager', method: req.method, path: p, status: 200, ms: 0 });
      return sendJson(res, 200, { ok: true, firing: firing.length, resolved: resolved.length });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (p.startsWith('/assets/') && (req.method === 'GET' || req.method === 'HEAD')) {
    return _httpStatic.serveAsset(req, res, p, { assetDir: ASSET_DIR, assetTypes: ASSET_TYPES });
  }

  const auth = checkAuth(req);
  req.__who = auth.who || '(未登录)';
  // 角色权限矩阵：admin 全通；operator 只能碰运维类写接口；viewer 只读
  if (auth.ok) {
    const gate = perm.check(auth.role || 'admin', req.method, p);
    if (!gate.ok) return sendJson(res, 403, { ok: false, error: gate.error, code: gate.code || 'forbidden' });
  }
  // 备份实例：只读。登录/登出放行（用户得能签进来看看状态），其余写操作一律 409，
  // 免得两个进程同时改 state.json / 同时推 Caddy。
  if (auth.ok && !lease.isLeader() && req.method !== 'GET' && req.method !== 'HEAD'
      && p !== '/api/login' && p !== '/api/logout') {
    return sendJson(res, 409, {
      ok: false, code: 'STANDBY',
      error: '当前连的是备份实例（只读）。主实例正在处理写操作，等它退出后这里会自动接管。',
      mode: 'standby',
      leader: (lease.status().holder || {}).id || null,
    });
  }
  if (!auth.ok) {
    const wait = authBlockedFor(req);
    if (wait > 0) {
      res.writeHead(429, { 'Retry-After': String(wait), 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`登录失败次数过多，${Math.ceil(wait / 60)} 分钟后再试`);
    }
    if (auth.tried) {
      noteAuthFail(req);
      const st = authFails.get(clientIpOf(req)) || {};
      const left = Math.max(0, AUTH_FAIL_LIMIT - (st.count || 0));
      log(`面板登录失败（${clientIpOf(req)}，本窗口还剩 ${left} 次机会）`, 'panel');
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="cf-tunnel-panel"', 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(left > 0 ? `用户名或密码不对（还剩 ${left} 次机会）` : '错误次数过多，已临时锁定');
    }
    if (wantsPage) {
      res.writeHead(302, { Location: `/login?next=${encodeURIComponent(p)}` });
      return res.end();
    }
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="cf-tunnel-panel"' });
    return res.end('需要登录');
  }
  if (auth.tried) clearAuthFail(req);

  // 会话登录的写操作要防 CSRF：cookie 是浏览器自动带的，第三方页面能发起跨站表单 POST。
  // SameSite=Lax 已经挡掉大部分，这里再要求同源标记，双保险。
  if (auth.via === 'session' && !/^(GET|HEAD|OPTIONS)$/.test(req.method)) {
    const site = String(req.headers['sec-fetch-site'] || '');
    const origin = String(req.headers.origin || '');
    const host = String(req.headers.host || '');
    const sameOrigin = site === 'same-origin' || (origin && host && origin.replace(/^https?:\/\//, '') === host);
    if (!sameOrigin && site) {
      auditRecord({ actor: auth.who, ip: clientIpOf(req), method: req.method, path: p, status: 403, action: '跨站请求被拦下', ok: false });
      return sendJson(res, 403, { ok: false, error: '跨站请求被拒绝（CSRF 防护）：请刷新页面后重试' });
    }
  }


  // 前端静态资源
  if (p === '/__bench/ping') {
    return sendJson(res, 200, { ok: true, colo: coloOf(req), t: Date.now() });
  }
  if (p === '/__bench/blob') {
    return sendBenchBlob(req, res, url);
  }

  // 新版多页面
  const page = PAGES.find((x) => x.path === p || x.path === p.replace(/\/$/, ''));
  if (page) {
    return serveText(req, res, pageShell(page.path, readPage(page.file), langOf(req)), 'text/html; charset=utf-8',
      'no-store, no-transform', { 'Cloudflare-CDN-Cache-Control': 'no-store' });
  }



  if (p === '/api/state' && req.method === 'GET') {
    maybeReloadState();   // 另一实例可能刚改过配置
    return sendJson(res, 200, {
      version: VERSION,
      mode: lease.isLeader() ? 'leader' : 'standby',
      // 角色要下发：前端据此把「只读账号点一下才 403」变成「一开始就禁用」
      role: auth.role || 'admin',
      canWrite: (auth.role || 'admin') !== 'viewer' && lease.isLeader(),
      state: {
        settings: publicSettings(),
        tunnels: publicTunnels(),
        routes: state.routes.map(publicRoute),
        panel: { authEnabled: !!state.panel.user, user: state.panel.user || '' },
        warm: state.warm || null,
      },
      runtime: {
        tunnels: state.tunnels.map((t) => {
          const rt = tunnelRt(t.id);
          return {
            id: t.id, name: t.name, status: rt.status, pid: rt.pid, url: rt.url,
            startedAt: rt.startedAt, lastError: rt.lastError, publicUrl: publicUrlOf(t),
            reconnects: rt.reconnects || 0,
            flaps: rt.flaps || 0,
            lastFlapAt: rt.lastFlapAt || null,
            flaps10m: (rt.flapTimes || []).filter((x) => Date.now() - x < 600000).length,
            uptimeSec: rt.status === 'running' && rt.startedAt ? Math.round((Date.now() - rt.startedAt) / 1000) : 0,
          };
        }),
        caddy: { ok: caddy.ok, error: caddy.error, lastPush: caddy.lastPush, routeCount: caddy.routeCount, listen: state.settings.caddyListen, skipped: lastSkipped, shadowed: shadowReport() },
        selfcheck: _selfcheck.lastResult(),
        upstreams: Array.from(upstreamHealth.values()),
        publicUrl: (state.tunnels.map(publicUrlOf).filter(Boolean)[0]) || null,
        host: os.hostname(),
        lanIps: Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address),
        uptimeSec: Math.round(process.uptime()),
      },
    });
  }































  // 路由模块自决：三组路由依次尝试，命中即返回（未命中各自 return false，开销只是几十次字符串比较）。
  // 不再用前缀守卫，避免搬块时边界切歪导致整条路由 404。
  if (p.startsWith('/api/')) {
    await _routesBackups.handle(p, req, res, url);
    if (res.writableEnded || res.headersSent) return;
    await _routesShares.handle(p, req, res, url);
    if (res.writableEnded || res.headersSent) return;
    await _routesCf.handle(p, req, res, url);
    if (res.writableEnded || res.headersSent) return;
    await _routesAuthroutes.handle(p, req, res, url);
    if (res.writableEnded || res.headersSent) return;
    await _routesOps.handle(p, req, res, url);
    if (res.writableEnded || res.headersSent) return;
    await _routesSettings.handle(p, req, res, url);
    if (res.writableEnded || res.headersSent) return;
    await _routesRules.handle(p, req, res, url);
    if (res.writableEnded || res.headersSent) return;
    await _routesObserve.handle(p, req, res, url);
    if (res.writableEnded || res.headersSent) return;
    await _routesMonitor.handle(p, req, res, url);
    if (res.writableEnded || res.headersSent) return;
    await _routesTunnels.handle(p, req, res, url);
    if (res.writableEnded || res.headersSent) return;
  }
  if (p === '/api/openapi' && req.method === 'GET') {
    try {
      return sendJson(res, 200, readOpenapi());
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: 'docs/openapi.json 读不到：' + e.message + '（跑 node tools/openapi.js --gen 生成）' });
    }
  }
  if (p === '/api/system') return sendJson(res, 200, { ok: true, ...systemInfo() });
  // CF 路由已上移到「路由模块自决」块统一尝试

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

// ---------------------------------------------------------------- 启动
loadState();

// 会话持久化：落盘的只是 cookie 值的哈希，「记住我」30 天，普通登录 7 天
const _restored = session.init(require('path').join(DATA_DIR, 'sessions.json'));
history.init(DATA_DIR);   // 历史曲线/通知记录落盘，两台实例共享（v0.19.0）

// 领导权租约：谁拿着租约谁负责写 state / 推 Caddy / 跑 cloudflared，
// 其余实例是**只读备份**（滚动升级时先起备份、切换、再退老实例）。
// 只有一件事仍然禁止：两个实例同时以「领导」身份写同一份 state。
let leaderMode = false;
// 面板自己那条规则的 upstream 会随槽位切换而"漂移"：上一轮写在 8091，这一轮实例只监听 8095。
// Caddy 的双槽位展开会让流量仍然通（两个槽位都试），但：
//   · 状态里存着一个已经不存在的端口，看的人会困惑；
//   · 保存护栏（panelExposed）按 upstream 端口判断"面板会不会被自己锁死"，端口对不上就失效。
// 所以 leader 接管时把自己的端口写回去（只在两端口都属于面板槽位时才改，避免误伤普通上游）。
function alignPanelRoute() {
  const me = String(PORT || 8090);
  const slots = panelSlots().map(String);
  let changed = 0;
  for (const r of state.routes || []) {
    const m = String(r.upstream || '').match(PANEL_SLOT_RE);
    if (!m) continue;
    const port = m[1];
    if (port === me) continue;
    if (!slots.includes(port) && port !== me) continue;
    const next = String(r.upstream).replace(PANEL_SLOT_RE, (all, _p, ...rest) => all.replace(':' + port, ':' + me));
    if (next !== r.upstream) { r.upstream = next; changed += 1; }
  }
  if (changed) {
    saveState('panel-slot');
    log(`把 ${changed} 条面板规则的 upstream 端口对齐到本实例（:${me}）`, 'panel');
  }
  return changed;
}

function startLeaderWork() {
  if (leaderMode) return;
  leaderMode = true;
  log('本实例成为主实例，接管出口与 Caddy 配置下发', 'panel');
  // 空状态保护：state.json 都不存在却去推 Caddy，等于拿默认的一条规则覆盖线上配置。
  // 真要推（首次部署）就显式设 PANEL_ALLOW_FRESH_PUSH=1。
  if (isFreshState() && process.env.PANEL_ALLOW_FRESH_PUSH !== '1') {
    log('[skip] 当前是从空白状态启动（没有 state.json），已跳过首次 Caddy 下发，'
      + '避免用默认规则覆盖已有配置。确认这是全新部署就设 PANEL_ALLOW_FRESH_PUSH=1。', 'panel');
  } else {
    try { alignPanelRoute(); } catch (e) { log('对齐面板规则端口失败：' + e.message, 'panel'); }
    pushCaddy().catch(() => {});
  }
  startAll();
  refreshUpstreamHealth().catch(() => {});
}
leaderMode = lease.init(require('path').join(DATA_DIR, '.leader.json'), {
  onPromote: () => { try { startLeaderWork(); } catch (e) { log('接管失败：' + e.message, 'panel'); } },
  onDemote: () => { leaderMode = false; log('领导权被另一个实例接走，本实例转为只读备份', 'panel'); },
});
if (!leaderMode) {
  const st = lease.status();
  log(`已有实例持有领导权（${(st.holder && st.holder.id) || '?'}）→ 本实例以**只读备份模式**启动；`
    + '写操作会返回 409，等它退出后自动接管。', 'panel');
  // 备份实例也把 cloudflared 拉起来当「热连接器」：隧道连接属于进程而不是 state，
  // 老实例退出时会带走它自己的连接器，如果备份这边还没连上，Cloudflare 那边就有几秒
  // 没有 connector 可用（实测 530 约 6 秒）。两个连接器同时在线是无害的，CF 会自己挑。
  // 只给**命名隧道**当热备：快速隧道的域名是每次进程新连时随机分配的，
  // 两个实例各连一条只会互相打架（还会撞 Cloudflare 的快速隧道限流）。
  const warm = () => {
    for (const t of state.tunnels) {
      if (!t.enabled || t.mode !== 'named' || !t.token) continue;
      const rt = tunnelRt(t.id);
      if (!rt.proc && !rt.fatal) startTunnel(t.id);
    }
  };
  try { warm(); } catch (e) { log('热备连接器启动失败: ' + e.message, 'panel'); }
  setInterval(() => {
    try {
      for (const t of state.tunnels) {
        const rt = tunnelRt(t.id);
        if (t.enabled && t.mode === 'named' && t.token && !rt.proc && !rt.fatal) startTunnel(t.id);
        if ((!t.enabled || t.mode !== 'named') && rt.proc) stopTunnel(t.id, true);
      }
    } catch { /* ignore */ }
  }, 10000).unref();
}
process.on('exit', () => lease.release());
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log(`收到 ${sig}，让出领导权并退出`, 'panel');
    try { if (lease.isLeader()) stopAll(); } catch { /* ignore */ }
    lease.release();
    process.exit(0);
  });
}

/**
 * 一次性把历史明文口令迁移成 bcrypt 哈希（v0.11.2 之前 state.json 里存的是明文）。
 * 只在发现明文时改写一次，之后 state.json / 备份 / 导出里都只有 $2b$ 串。
 */
function migrateSecrets() {
  let changed = false;
  if (state.panel && state.panel.pass && !secret.isHash(state.panel.pass)) {
    state.panel.pass = secret.hash(state.panel.pass);
    changed = true;
    log('面板口令已从明文迁移为 bcrypt 哈希', 'panel');
  }
  if (state.viewer && state.viewer.pass && !secret.isHash(state.viewer.pass)) {
    state.viewer.pass = secret.hash(state.viewer.pass);
    changed = true;
    log('只读口令已从明文迁移为 bcrypt 哈希', 'panel');
  }
  if (changed) saveState('migrate-secrets');
}
migrateSecrets();
const onReq = _httpOnReq.create({
  handler,
  log,
  sendJson,
  rateLimited,
  auditRecord,
  actionOf,
  isMutation: _audit.isMutation,
  countPanelReq,
  clientIpOf,
});

// 面板 HTTPS：挂载证书后设 PANEL_TLS_CERT / PANEL_TLS_KEY 即可（见 README §10）
const tlsOpts = (() => {
  const c = process.env.PANEL_TLS_CERT, k = process.env.PANEL_TLS_KEY;
  if (!c || !k) return null;
  try { return { cert: fs.readFileSync(c), key: fs.readFileSync(k) }; }
  catch (e) { log(`面板 HTTPS 证书读取失败（${e.message}），退回 HTTP`, 'panel'); return null; }
})();

/* ---------------- 自检：上下文 / 留痕 / 定时跑 / 状态变化才告警 ---------------- */
function selfcheckContext() {
  const bi = ident.buildInfo();
  const rt = {
    tunnels: Object.fromEntries(state.tunnels.map((t) => {
      const r = tunnelRt(t.id);
      return [t.id, {
        status: r.status, publicUrl: publicUrlOf(t), url: r.url,
        flaps: r.flaps || 0, lastFlapAt: r.lastFlapAt || null,
        flaps10m: (r.flapTimes || []).filter((x) => Date.now() - x < 600000).length,
      }];
    })),
    caddy: { ok: caddy.ok, error: caddy.error, routeCount: caddy.routeCount, shadowed: shadowReport() },
  };
  return { rt, meta: { version: VERSION, code: bi.code, imageCode: bi.build, drift: bi.drift, role: lease.isLeader() ? 'leader' : 'standby' } };
}

// 进程启动就接上一次的结果：重启后不该把「原本就有的故障」再当成新故障报一遍
let _lastSelfcheck = _selfcheck.lastResult();

function selfcheckAlert(rec) {
  const list = (rec.bad || []).slice(0, 6).map((x) => `· ${x.name}：${x.detail}`).join('\n');
  _notify.notify('selfcheck', `面板自检 ${rec.fail} 项失败`,
    `共 ${rec.total} 项检查：${rec.fail} 项失败、${rec.warn} 项需要注意\n${list}`).catch(() => {});
}
function selfcheckRecovered(rec) {
  _notify.notify('selfcheck', '面板自检恢复正常', `${rec.total} 项全部通过。`).catch(() => {});
}

/**
 * 跑一次体检，并把「同一时刻只跑一份」这件事收在这里。
 *
 * 为什么要去重：12 项检查里有几个要过 Cloudflare（每个 6 秒），一次体检可能要 6 秒；
 * 定时那一路和手动点按钮撞在一起时，两路同时打公网既慢又会让结果互相覆盖。
 */
let _selfcheckInflight = null;
async function runSelfcheckOnce(opts) {
  const ids = (opts && Array.isArray(opts.ids) ? opts.ids : []).filter(Boolean);
  // 只跑指定项时不走单飞：半套结果一旦混进「最近 24 小时」统计就会失真
  // （v0.29.35 起：点名「快速」的那一路会落盘，但记录带 scope='quick'，聚合时被排除）
  if (ids.length) {
    maybeReloadState();
    const c2 = selfcheckContext();
    const out2 = await _selfcheck.runChecks(state, { runtime: c2.rt, ...c2.meta }, { ids });
    const rec2 = (opts && opts.scope === 'quick') ? _selfcheck.persist(out2, 'quick') : null;
    return { out: out2, rec: rec2 };
  }
  if (_selfcheckInflight) return _selfcheckInflight;
  _selfcheckInflight = (async () => {
    maybeReloadState();
    const { rt, meta } = selfcheckContext();
    const out = await _selfcheck.runChecks(state, { runtime: rt, ...meta });
    const rec = _selfcheck.persist(out);            // 留痕：总览页与定时自检都读它
    if (rec) {
      const prev = _lastSelfcheck;
      _lastSelfcheck = rec;
      // 手动与定时走同一条「状态翻转才报」逻辑，避免重复刷通知
      if (prev && prev.ok && !rec.ok) selfcheckAlert(rec);
      else if (prev && !prev.ok && rec.ok) selfcheckRecovered(rec);
    }
    return { out, rec };
  })().finally(() => { _selfcheckInflight = null; });
  return _selfcheckInflight;
}

/** 只在「状态翻转」时通知：正常→故障 报一次，故障→正常 报一次，其余静默 */
async function runSelfcheckQuiet() {
  if (!lease.isLeader()) return;                       // 备份实例不查，免得两边重复告警
  try {
    await runSelfcheckOnce();
  } catch (e) {
    log('自检失败（不影响面板运行）: ' + (e && e.message), 'panel');
  }
}

// 把体检执行器挂到共享句柄上，供 src/routes/monitor.js 调用（它只保留 HTTP 处理）
const _runtime = require('./core/runtime');
_runtime.runSelfcheckOnce = runSelfcheckOnce;
_runtime.runSelfcheckQuiet = runSelfcheckQuiet;

const server = tlsOpts ? https.createServer(tlsOpts, onReq) : http.createServer(onReq);

server.listen(PORT, '0.0.0.0', async () => {
  log(`面板已启动 v${VERSION}: ${tlsOpts ? 'https' : 'http'}://0.0.0.0:${PORT}（数据目录 ${DATA_DIR}）`
    + `，模式 ${lease.isLeader() ? 'leader' : 'standby'}`, 'panel');
  if (lease.isLeader()) {
    // 统一走 startLeaderWork（内含「空白状态不推 Caddy」的保护）
    leaderMode = false;
    startLeaderWork();
    setInterval(() => { refreshUpstreamHealth().catch(() => {}); }, 60000).unref();
    shareJanitor();
    // 每 5 分钟自检一次（首轮延迟 45 秒，避开启动时的抖动）
    setTimeout(() => {
      runSelfcheckQuiet();
      setInterval(runSelfcheckQuiet, 5 * 60 * 1000).unref();
    }, 45000).unref();
  }
  // 监控与健康巡检两边都跑（只读采样，不改共享状态）
  startMonitor();

  // 同机槽位在线状态：双上游 + 健康检查只在一台真正在监听时才下发（见 caddy.js）。
  // 槽位上下线（滚动升级）时 leader 需要重推一次配置，否则新起来的那一台要等到
  // 下次状态变更才会被写进上游列表 —— 那段时间切流量就少了兜底。
  _caddy.startPeerWatch();
  let _slotSig = '';
  setInterval(() => {
    const sig = _caddy.panelSlots().map((p2) => `${p2}:${_caddy.peerLive(p2) ? 1 : 0}`).join(',');
    if (sig === _slotSig) return;
    const first = !_slotSig;
    _slotSig = sig;
    if (first || !lease.isLeader()) return;
    log(`槽位状态变化（${sig}），重推 Caddy 配置`, 'panel');
    pushCaddy().catch(() => {});
  }, 5000).unref();
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { stopAll(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000); });
}
process.on('uncaughtException', (e) => log(`未捕获异常: ${e.stack || e.message}`, 'panel'));
// Node 22 默认把未处理的 Promise 拒绝当致命错误（进程直接退），面板会被容器拉起来但租约掉、cloudflared 重连，
// 而且没有任何痕迹。这里兜住：记一条日志 + 计数（/metrics 与告警都能看到），进程继续跑。
let _unhandled = 0;
process.on('unhandledRejection', (e) => {
  _unhandled += 1;
  try { require('./core/metrics').inc('unhandled_rejections'); } catch { /* 指标失败不影响 */ }
  const detail = (e && (e.stack || e.message)) || String(e);
  log(`未处理的 Promise 拒绝（第 ${_unhandled} 次）: ${detail}`, 'panel');
});
