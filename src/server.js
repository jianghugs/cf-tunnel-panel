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
const _routesRules = require('./routes/rules');
const _routesObserve = require('./routes/observe');
const _routesMonitor = require('./routes/monitor');

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
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(metricsText() + exitMetricsLines());
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

  // 会话管理
  if (p === '/api/sessions' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, cookie: session.COOKIE, sessions: session.list(auth.sid), ttlDays: Math.round(session.TTL_MS / 86400000) });
  }
  if (p === '/api/sessions/revoke' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const full = session.resolveKey(body && body.id);
    if (!full) return sendJson(res, 404, { ok: false, error: '这个会话已经不存在了（可能已过期或被踢）' });
    const isSelf = full === auth.sid;
    session.revoke(full);
    if (isSelf) res.setHeader('Set-Cookie', session.clearCookieHeader());
    return sendJson(res, 200, { ok: true, self: isSelf });
  }
  if (p === '/api/sessions/revoke-all' && req.method === 'POST') {
    const n = session.revokeAll();
    res.setHeader('Set-Cookie', session.clearCookieHeader());
    auditRecord({ actor: auth.who, ip: clientIpOf(req), method: 'POST', path: p, status: 200, action: '退出全部登录会话', target: `${n} 个` });
    return sendJson(res, 200, { ok: true, revoked: n });
  }
  if (p === '/api/sessions/revoke-others' && req.method === 'POST') {
    const n = session.revokeOthers(auth.sid);
    return sendJson(res, 200, { ok: true, revoked: n });
  }

  // 前端静态资源
  if (p === '/__bench/ping') {
    return sendJson(res, 200, { ok: true, colo: coloOf(req), t: Date.now() });
  }
  if (p === '/__bench/blob') {
    return sendBenchBlob(req, res, url);
  }
  if (p === '/api/bench/local' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const n = Math.min(20, Math.max(1, Number(body && body.n) || 5));
      const port = Number(process.env.CADDY_PORT || '8080');
      const out = [];
      for (let i = 0; i < n; i += 1) out.push(await benchLocalOnce(port));
      const good = out.filter((x) => x.ok).map((x) => x.ttfbMs).sort((a, b) => a - b);
      return sendJson(res, 200, {
        ok: good.length > 0,
        port,
        samples: out,
        ttfbMs: good.length ? { min: good[0], median: good[Math.floor(good.length / 2)], max: good[good.length - 1] } : null,
      });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
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












  if (p === '/api/audit.csv' && req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 2000, 1), 5000);
    const items = auditList({ limit, q: url.searchParams.get('q') || '', date: url.searchParams.get('date') || '' }).rows || [];
    // CSV 单元格：①引号双写；②防 Excel 公式注入 —— 以 = + - @ 开头的单元格
    // 会被 Excel 当公式执行（规则名/对象名都是用户可填的），前面垫一个单引号。
    const cell = (v) => {
      let t = String(v == null ? '' : v);
      if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
      return `"${t.replace(/"/g, '""')}"`;
    };
    const esc = cell;
    const head = ['时间', '谁', 'IP', '方法', '路径', '状态', '耗时ms', '动作', '对象', '结果'];
    const lines = [head.map(esc).join(',')];
    for (const a of items) {
      lines.push([a.at ? new Date(a.at).toLocaleString('sv-SE') : '', a.actor, a.ip, a.method, a.path,
        a.status, a.ms, a.action, a.target, a.ok ? '成功' : '失败'].map(esc).join(','));
    }
    const body = '\uFEFF' + lines.join('\r\n') + '\r\n';   // BOM 让 Excel 认 UTF-8
    res.writeHead(200, {
      ...SEC_HEADERS,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return true;
  }

  // 一键封禁：把「可疑访问」里看到的 IP 直接写进 security.ipDeny
  // （在此之前，两个信息都在，但要人去设置页手抄一遍）
  if ((p === '/api/security/deny' || p === '/api/security/allow') && req.method === 'POST') {
    const denyMode = p.endsWith('/deny');
    try {
      const body = await readBody(req);
      const raw = String(body.ip || '').trim();
      if (!raw || raw.length > 64 || !/^[0-9a-fA-F:.\/]+$/.test(raw)) {
        return sendJson(res, 400, { ok: false, error: 'IP 格式不对（要写成 1.2.3.4 或 2001:db8::1）' });
      }
      let entry = raw;
      if (!raw.includes('/')) {
        const v = net.isIP(raw);
        if (!v) return sendJson(res, 400, { ok: false, error: `不是一个合法 IP：${raw}` });
        entry = v === 6 ? `${raw}/128` : `${raw}/32`;
      } else {
        const [addr, mask] = raw.split('/');
        const v = net.isIP(addr);
        const m = Number(mask);
        if (!v || !Number.isInteger(m) || m < 0 || m > (v === 6 ? 128 : 32)) {
          return sendJson(res, 400, { ok: false, error: 'CIDR 不合法，例如 203.0.113.0/24' });
        }
      }
      const cur = String((state.settings.security && state.settings.security.ipDeny) || '');
      let list = cur.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
      if (denyMode) {
        if (list.includes(entry)) return sendJson(res, 200, { ok: true, added: false, entry, ipDeny: list.join('\n') });
        if (list.length >= 200) return sendJson(res, 400, { ok: false, error: '黑名单最多 200 条，先清掉一些' });
        list.push(entry);
      } else {
        if (!list.includes(entry)) return sendJson(res, 200, { ok: true, removed: false, entry, ipDeny: list.join('\n') });
        list = list.filter((x) => x !== entry);
      }
      state.settings.security.ipDeny = list.join('\n');
      saveState(denyMode ? 'ip-deny' : 'ip-allow');
      pushCaddy();
      auditRecord({ action: denyMode ? '封禁来源 IP' : '解封来源 IP', target: entry, ok: true });
      const warning = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$)/.test(entry.split('/')[0])
        ? '这是内网/本机地址：如果你正从内网访问面板，封掉会把自己挡在外面'
        : '';
      return sendJson(res, 200, {
        ok: true, added: denyMode, removed: !denyMode, entry, warning,
        ipDeny: state.settings.security.ipDeny, count: list.length,
      });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (p === '/api/security/attempts' && req.method === 'GET') {
    const hours = Math.min(Math.max(Number(url.searchParams.get('hours')) || 24, 0.1), 168);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 3000, 100), 5000);
    return sendJson(res, 200, securityAttempts(hours, limit));
  }

  if (p === '/api/access' && req.method === 'GET') {
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 100)));
    const d = readAccess(limit);
    // 给每行标上它命中的规则，前端才能「点日志跳到规则」
    const rows = ((d && d.rows) || []).map((r) => {
      const m = simulateMatch(String(r.uri || '/').split('?')[0], r.host || '', r.method || 'GET');
      const idx = m && m.matched ? (m.ofIndex != null ? m.ofIndex : m.index - 1) : -1;
      const rule = idx >= 0 ? state.routes[idx] : null;
      return rule ? Object.assign({}, r, { rule: { id: rule.id, name: rule.name } }) : r;
    });
    return sendJson(res, 200, Object.assign({}, d, { rows }));
  }

  // 访问日志导出 CSV（和审计 CSV 同一套写法：BOM + CRLF + 公式注入防护）
  if (p === '/api/access.csv' && req.method === 'GET') {
    const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get('limit') || 200)));
    const rows = readAccess(limit).rows || [];
    const cell = (v) => {
      let t = String(v === undefined || v === null ? '' : v);
      if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
      return /["\n\r,]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    };
    const head = ['时间', '主机', '方法', '路径', '状态', '耗时ms', '字节', '来源IP'];
    const lines = [head.join(',')];
    for (const r of rows) {
      lines.push([
        new Date(r.at || Date.now()).toISOString(),
        r.host || '', r.method || '', r.uri || '', r.status || '', r.durMs || 0, r.size || 0, r.ip || '',
      ].map(cell).join(','));
    }
    const body = Buffer.from('\uFEFF' + lines.join('\r\n'), 'utf8');
    res.writeHead(200, {
      ...SEC_HEADERS,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="access-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Cache-Control': 'no-store',
      'Content-Length': body.length,
    });
    return res.end(body);
  }


  if (p === '/api/settings' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      if (typeof body.caddyListen === 'string' && body.caddyListen.trim()) {
        const v = body.caddyListen.trim();
        if (!/^(:\d+|[\d.]+:\d+)$/.test(v)) throw new Error('监听地址格式应为 :8080 或 127.0.0.1:8080');
        state.settings.caddyListen = v;
      }
      if (typeof body.notFoundBody === 'string') state.settings.notFoundBody = body.notFoundBody.slice(0, 2000);
      if (typeof body.panelTitle === 'string') state.settings.panelTitle = body.panelTitle.slice(0, 60);

      if (body.maintenance && typeof body.maintenance === 'object') {
        const m = body.maintenance;
        state.settings.maintenance = {
          on: !!m.on,
          body: String(m.body === undefined ? state.settings.maintenance.body : m.body).slice(0, 2000),
          retryAfter: Math.max(1, Math.min(86400, Number(m.retryAfter) || 300)),
        };
      }
      if (body.security && typeof body.security === 'object') {
        const sec = body.security;
        const deny = String(sec.ipDeny || '').slice(0, 2000);
        parseCidrs(deny); // 校验，不合法直接抛
        state.settings.security = {
          ipDeny: deny,
          rateLimit: {
            enabled: !!(sec.rateLimit && sec.rateLimit.enabled),
            rps: Math.max(0, Math.min(100000, Number((sec.rateLimit || {}).rps) || 0)),
            burst: Math.max(0, Math.min(100000, Number((sec.rateLimit || {}).burst) || 0)),
          },
        };
      }
      if (body.notify && typeof body.notify === 'object') {
        const n = body.notify;
        const given = String(n.url || '').trim();
        if (given && !/^https?:\/\//i.test(given)) throw new Error('通知地址必须是 http:// 或 https:// 开头');
        // 空字符串 = 不改（前端拿到的是脱敏值）；要清空请传 clearUrl: true
        const url = n.clearUrl === true ? '' : (given || state.settings.notify.url || '');
        const quiet = String(n.quietHours === undefined ? (state.settings.notify.quietHours || '') : n.quietHours).trim();
        if (quiet && !/^\d{1,2}:\d{2}-\d{1,2}:\d{2}(,\s*\d{1,2}:\d{2}-\d{1,2}:\d{2})*$/.test(quiet)) {
          throw new Error('静默时段格式应为 23:00-07:00（多段用逗号分隔）');
        }
        const prevN = state.settings.notify || {};
        const cool = n.cooldownSec === undefined ? (prevN.cooldownSec || 0) : n.cooldownSec;
        const fmt = ['generic', 'dingtalk', 'feishu', 'bark'].includes(n.format) ? n.format
          : (['generic', 'dingtalk', 'feishu', 'bark'].includes(prevN.format) ? prevN.format : 'generic');
        // 每种格式的地址长得完全不一样，填错了只会「静默不送达」，所以在保存时就挡住
        const shape = {
          dingtalk: [/^https:\/\/oapi\.dingtalk\.com\/robot\/send/i, '钉钉机器人地址形如 https://oapi.dingtalk.com/robot/send?access_token=…（在群设置 → 机器人 → 自定义 → Webhook 里复制）'],
          feishu: [/^https:\/\/(open\.feishu\.cn|open\.larksuite\.com)\/open-apis\/bot\/v2\/hook\//i, '飞书机器人地址形如 https://open.feishu.cn/open-apis/bot/v2/hook/xxxx（群设置 → 群机器人 → 添加 → 自定义机器人）'],
          bark: [/^https?:\/\/[^/]+\/./i, 'Bark 地址形如 https://api.day.app/你的Key（自建服务器就填你的域名/Key）'],
        }[fmt];
        if (url && shape && !shape[0].test(url)) throw new Error(`通知地址和「${fmt}」格式不匹配：${shape[1]}`);
        // 加签密钥：空 = 保留旧值；要清空传 clearSecret: true
        const secretGiven = String(n.secret || '').trim();
        const secret = n.clearSecret === true ? '' : (secretGiven || state.settings.notify.secret || '');
        // 多通道：给了 channels 就整体替换；每条按自己的 format 校验地址
        const FORMATS = ['generic', 'dingtalk', 'feishu', 'bark'];
        const SHAPES = {
          dingtalk: /^https:\/\/oapi\.dingtalk\.com\/robot\/send/i,
          feishu: /^https:\/\/(open\.feishu\.cn|open\.larksuite\.com)\/open-apis\/bot\/v2\/hook\//i,
          bark: /^https?:\/\/[^/]+\/.+/i,
        };
        let channels = Array.isArray(prevN.channels) ? prevN.channels : [];
        if (Array.isArray(n.channels)) {
          const seen = new Set();
          channels = n.channels.slice(0, 8).map((raw, i) => {
            const c = raw && typeof raw === 'object' ? raw : {};
            const id = String(c.id || `c${i + 1}`).replace(/[^\w.-]/g, '').slice(0, 24) || `c${i + 1}`;
            if (seen.has(id)) throw new Error(`通知通道 id 重复：${id}`);
            seen.add(id);
            const cfmt = FORMATS.includes(c.format) ? c.format : 'generic';
            const curl = String(c.url === undefined ? '' : c.url).trim().slice(0, 400);
            if (curl && !/^https?:\/\//i.test(curl)) throw new Error(`通道「${c.name || id}」的地址必须以 http:// 或 https:// 开头`);
            if (curl && SHAPES[cfmt] && !SHAPES[cfmt].test(curl)) {
              throw new Error(`通道「${c.name || id}」的地址和「${cfmt}」格式不匹配`);
            }
            // 密钥：不传 = 保留旧值（前端拿到的是 hasSecret），clearSecret 才清
            const prevC = (prevN.channels || []).find((x) => String(x.id) === id) || {};
            const csecret = c.clearSecret === true ? ''
              : (String(c.secret || '').trim() || String(prevC.secret || ''));
            return {
              id, name: String(c.name || `通道 ${i + 1}`).slice(0, 40),
              format: cfmt, url: curl, secret: csecret, enabled: c.enabled !== false,
            };
          });
        }
        state.settings.notify = {
          url,
          format: fmt,
          secret,
          channels,
          events: n.events && typeof n.events === 'object'
            ? {
              tunnelUp: n.events.tunnelUp !== false,
              tunnelDown: n.events.tunnelDown !== false,
              urlChange: n.events.urlChange !== false,
              caddyFail: n.events.caddyFail !== false,
              sessionIp: n.events.sessionIp !== false,
              errorSpike: n.events.errorSpike !== false,
              loginFail: n.events.loginFail !== false,
              authScan: n.events.authScan !== false,
            }
            : (prevN.events || { tunnelUp: true, tunnelDown: true, urlChange: true, caddyFail: true, sessionIp: true }),
          cooldownSec: Math.max(0, Math.min(86400, Number(cool) || 0)),
          quietHours: quiet,
          template: {
            title: String((n.template && n.template.title) !== undefined ? n.template.title : ((prevN.template || {}).title || '')).slice(0, 120),
            text: String((n.template && n.template.text) !== undefined ? n.template.text : ((prevN.template || {}).text || '')).slice(0, 500),
          },
        };
      }
      if (body.monitoring && typeof body.monitoring === 'object') {
        const u = String(body.monitoring.promUrl === undefined ? ((state.settings.monitoring || {}).promUrl || '') : body.monitoring.promUrl).trim().replace(/\/+$/, '').slice(0, 200);
        if (u && !/^https?:\/\/[^\s]+$/i.test(u)) throw new Error('Prometheus 地址必须是 http:// 或 https:// 开头');
        state.settings.monitoring = { promUrl: u };
      }
      if (body.cf && typeof body.cf === 'object') {
        state.settings.cf = {
          token: String(body.cf.token === undefined ? (state.settings.cf || {}).token : body.cf.token).slice(0, 200).trim(),
          accountId: String(body.cf.accountId === undefined ? (state.settings.cf || {}).accountId : body.cf.accountId).slice(0, 64).trim(),
          zoneId: String(body.cf.zoneId === undefined ? (state.settings.cf || {}).zoneId : body.cf.zoneId).slice(0, 64).trim(),
        };
      }
      if (body.grafana && typeof body.grafana === 'object') {
        const g = body.grafana;
        const prev = state.settings.grafana || {};
        // URL 只接受 http(s)，并去掉结尾斜杠（iframe src 里自己拼 /d-solo/...）
        let url = String(g.url === undefined ? prev.url || '' : g.url).trim().replace(/\/+$/, '');
        if (url && !/^https?:\/\/[^\s"'<>]+$/i.test(url)) {
          return sendJson(res, 400, { ok: false, error: 'Grafana 地址要写成 http://host:port（不要带路径、不要引号）' });
        }
        // 局域网直连地址（可选）：页面本身以 http 打开时优先用它，绕开 Cloudflare 隧道，
        // 嵌入图从 40 秒降到 1 秒内。https 页面里不会用它（否则是混合内容，浏览器直接拦）。
        let lanUrl = String(g.lanUrl === undefined ? prev.lanUrl || '' : g.lanUrl).trim().replace(/\/+$/, '');
        if (lanUrl && !/^https?:\/\/[^\s"'<>]+$/i.test(lanUrl)) {
          return sendJson(res, 400, { ok: false, error: '局域网直连地址要写成 http://192.168.x.x:3000（不要带路径）' });
        }
        // dashboard 形如 <uid>/<slug>：两种情况都兼容，只有 uid 时也能用
        const dash = String(g.dashboard === undefined ? prev.dashboard || '' : g.dashboard).trim().replace(/^\/+|\/+$/g, '');
        if (dash && !/^[\w.\-]{1,80}(\/[\w.\-]{1,80})?$/.test(dash)) {
          return sendJson(res, 400, { ok: false, error: '仪表盘要写成 <uid>/<slug>（在 Grafana 地址栏里 /d/ 后面那一段）' });
        }
        const theme = String(g.theme === undefined ? prev.theme || '' : g.theme);
        if (!['', 'dark', 'light'].includes(theme)) {
          return sendJson(res, 400, { ok: false, error: '主题只能是 dark / light / 跟随面板' });
        }
        const rawPanels = Array.isArray(g.panels) ? g.panels : (prev.panels || []);
        const panels = [];
        for (const item of rawPanels.slice(0, 3)) {
          const id = Number((item && item.panelId) || 0);
          if (!Number.isFinite(id) || id < 0 || id > 99999) {
            return sendJson(res, 400, { ok: false, error: 'panelId 要是 Grafana 里那个数字（view panel → Inspect → Panel JSON 里的 id）' });
          }
          if (!id) continue;
          const h = Number((item && item.h) || 220);
          panels.push({
            panelId: Math.round(id),
            title: String((item && item.title) || '').slice(0, 40),
            h: Math.min(Math.max(Math.round(h), 140), 600),
          });
        }
        const enabled = !!(g.enabled === undefined ? prev.enabled : g.enabled);
        if (enabled && (!url || !dash || !panels.length)) {
          return sendJson(res, 400, { ok: false, error: '要开启嵌入，至少需要：Grafana 地址 + 仪表盘 uid + 一个 panelId' });
        }
        state.settings.grafana = { enabled, url, lanUrl, dashboard: dash, theme, panels };
      }
      saveState('settings');
      await pushCaddy();
      // 有些选项在当前镜像里根本执行不了（例如标准 caddy 没有 rate_limit 模块）。
      // 静默失效比报错更糟：用户以为开了限流，其实一条都没拦。这里显式回告。
      const warnings = [];
      const rl = (state.settings.security || {}).rateLimit || {};
      if (rl.enabled && process.env.CADDY_RATELIMIT !== '1') {
        warnings.push('限流已勾选，但当前 Caddy 镜像不含 rate_limit 模块，实际没有生效（见 docs/RATELIMIT.md，需自定义镜像并设 CADDY_RATELIMIT=1）');
      }
      return sendJson(res, 200, { ok: true, settings: publicSettings(), caddy, warnings });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  // ---- 多隧道出口 CRUD
  if (p === '/api/tunnels' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, tunnels: publicTunnels().map((t) => ({ ...t, ...runtimeOf(t.id) })) });
  }
  if (p === '/api/tunnels' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      if (state.tunnels.length >= 8) throw new Error('最多 8 个隧道出口，够用了吧');
      const t = applyTunnelFields(newTunnel(), body);
      state.tunnels.push(t);
      saveState('tunnel-add');
      if (t.enabled) startTunnel(t.id);
      return sendJson(res, 200, { ok: true, id: t.id, tunnels: publicTunnels().map((x) => ({ ...x, ...runtimeOf(x.id) })) });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (p === '/api/tunnels/start-all' && req.method === 'POST') { startAll(); return sendJson(res, 200, { ok: true }); }
  if (p === '/api/tunnels/stop-all' && req.method === 'POST') { stopAll(); return sendJson(res, 200, { ok: true }); }

  const tm = p.match(/^\/api\/tunnels\/([\w-]+)(?:\/(start|stop|restart|delete))?$/);
  if (tm && req.method === 'POST') {
    const t = tunnelById(tm[1]);
    if (!t) return sendJson(res, 404, { ok: false, error: '这个隧道出口不存在（可能已被删除）' });
    const action = tm[2];
    if (action === 'delete') {
      stopTunnel(t.id, true);
      state.tunnels = state.tunnels.filter((x) => x.id !== t.id);
      if (!state.tunnels.length) state.tunnels = [newTunnel({ id: 'main', name: '主隧道出口' })];
      runtimes.delete(t.id);
      saveState('tunnel-del');
      return sendJson(res, 200, { ok: true, tunnels: publicTunnels() });
    }
    if (action === 'start') { startTunnel(t.id); return sendJson(res, 200, { ok: true, status: tunnelRt(t.id).status }); }
    if (action === 'stop') { stopTunnel(t.id); return sendJson(res, 200, { ok: true, status: tunnelRt(t.id).status }); }
    if (action === 'restart') { startTunnel(t.id); return sendJson(res, 200, { ok: true, status: tunnelRt(t.id).status }); }
    try {
      const body = await readBody(req);
      applyTunnelFields(t, body);
      saveState('tunnel');
      startTunnel(t.id);
      return sendJson(res, 200, { ok: true, id: t.id, status: tunnelRt(t.id).status, tunnels: publicTunnels() });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  // 旧接口（单隧道时代）保留，作用于第一个出口，方便老脚本/书签继续用
  if (p === '/api/tunnel' && req.method === 'POST') {
    const t0 = firstTunnel();
    const body = await readBody(req);
    applyTunnelFields(t0, body);
    saveState('tunnel');
    startTunnel(t0.id);
    return sendJson(res, 200, { ok: true, tunnel: { status: tunnelRt(t0.id).status, mode: t0.mode } });
  }
  if (p === '/api/tunnel/start' && req.method === 'POST') { startAll(); return sendJson(res, 200, { ok: true }); }
  if (p === '/api/tunnel/stop' && req.method === 'POST') { stopAll(); return sendJson(res, 200, { ok: true }); }


  // ---------- 运维账号（admin 专属，perm 已挡） ----------
  if (p === '/api/operator' && req.method === 'POST') {
    const body = await readBody(req);
    const oUser = String(body.user || '').trim();
    const oPass = String(body.pass || '');
    if (oUser && !/^[\w.@-]{1,40}$/.test(oUser)) return sendJson(res, 400, { ok: false, error: '账号只能是字母数字和 . _ @ -' });
    if (oUser && oPass && oPass.length < 6) return sendJson(res, 400, { ok: false, error: '运维账号密码至少 6 位' });
    state.operator.user = oUser;
    if (!oUser) state.operator.pass = '';
    else if (oPass) state.operator.pass = secret.hash(oPass);
    saveState('operator');
    clearBasicCache();
    const kicked = oUser ? session.revokeUser(oUser, auth.sid) : 0;
    log(oUser ? `运维账号已设置：${oUser}` + (kicked ? `（该账号 ${kicked} 个会话已失效）` : '') : '运维账号已关闭', 'panel');
    return sendJson(res, 200, { ok: true, operator: { user: oUser, hasPass: !!state.operator.pass }, revoked: kicked, relogin: kicked > 0 });
  }

  // ---------- 二次验证 TOTP（admin 专属） ----------
  if (p === '/api/totp/setup' && req.method === 'POST') {
    const s3 = totp.newSecret();
    state.totp.pending = s3;
    saveState('totp-setup');
    const otpauth = totp.otpauthUrl({ secret: s3, label: state.panel.user || 'admin', issuer: 'cf-tunnel-panel' });
    let qr = '';
    try { qr = await QRCode.toDataURL(otpauth, { margin: 1, width: 240 }); } catch { qr = ''; }
    log('已生成 TOTP 密钥，等待验证码确认', 'panel');
    return sendJson(res, 200, { ok: true, secret: s3, otpauth, qr });
  }
  if (p === '/api/totp/enable' && req.method === 'POST') {
    const body = await readBody(req);
    const pending = (state.totp && state.totp.pending) || '';
    if (!pending) return sendJson(res, 400, { ok: false, error: '先点「生成二维码」，用手机 App 扫一下' });
    if (totp.verify(pending, body.code) === null) return sendJson(res, 400, { ok: false, error: '验证码不对：确认手机时间准确，再输入当前 6 位数字' });
    const rec = totp.newRecovery(10);
    state.totp = { enabled: true, secret: pending, pending: '', recovery: rec.hashed };
    saveState('totp-enable');
    auditRecord({ actor: auth.who, ip: clientIpOf(req), method: 'POST', path: p, status: 200, action: '开启二次验证', target: 'TOTP' });
    log('二次验证已开启（下次登录需要 6 位验证码）', 'panel');
    return sendJson(res, 200, { ok: true, enabled: true, recoveryCodes: rec.plain });
  }
  if (p === '/api/totp/disable' && req.method === 'POST') {
    const body = await readBody(req);
    const conf = state.totp || {};
    let okCode = false;
    if (conf.secret && /^\d{6}$/.test(String(body.code || '').trim())) okCode = totp.verify(conf.secret, body.code) !== null;
    if (!okCode && body.code) {
      const h = totp.hashRecovery(body.code);
      okCode = ((conf.recovery || []).indexOf(h) >= 0);
    }
    if (!okCode) return sendJson(res, 400, { ok: false, error: '要关掉二次验证，得先输入一个当前验证码或恢复码' });
    state.totp = { enabled: false, secret: '', pending: '', recovery: [] };
    saveState('totp-disable');
    auditRecord({ actor: auth.who, ip: clientIpOf(req), method: 'POST', path: p, status: 200, action: '关闭二次验证', target: '' });
    log('二次验证已关闭', 'panel');
    return sendJson(res, 200, { ok: true, enabled: false });
  }

  if (p === '/api/totp/recovery' && req.method === 'POST') {
    const body = await readBody(req);
    const conf = state.totp || {};
    if (!conf.enabled || !conf.secret) return sendJson(res, 400, { ok: false, error: '二次验证还没开启' });
    const code = String(body.code || '').trim();
    let pass = false;
    if (/^\d{6}$/.test(code)) pass = totp.verify(conf.secret, code) !== null;
    if (!pass && code) pass = ((conf.recovery || []).indexOf(totp.hashRecovery(code)) >= 0);
    if (!pass) return sendJson(res, 400, { ok: false, error: '要重新生成恢复码，得先输入当前验证码或一个旧恢复码' });
    const pack = totp.newRecovery(10);
    state.totp.recovery = pack.hashed;
    saveState('totp-recovery');
    auditRecord({ actor: auth.who, ip: clientIpOf(req), method: 'POST', path: p, status: 200, action: '重新生成恢复码', target: '10 个' });
    log('已重新生成 10 个恢复码，旧的全部作废', 'panel');
    return sendJson(res, 200, { ok: true, recovery: pack.plain });
  }

  if (p === '/api/panel-auth' && req.method === 'POST') {
    const body = await readBody(req);
    const pUser = String(body.user || '').trim();
    const pPass = String(body.pass || '');
    if (pUser && pPass.length < 4) return sendJson(res, 400, { ok: false, error: '面板密码至少 4 位' });
    state.panel.user = pUser;
    // 口令只存 bcrypt 哈希：state.json、备份、导出里都不再出现明文
    state.panel.pass = pPass ? secret.hash(pPass) : '';
    saveState('panel-auth');
    clearBasicCache();
    // 改口令等于「我不相信现在所有还登着的设备」：全踢，让所有人重新登录。
    const kicked = state.panel.user ? session.revokeAll() : 0;
    if (kicked) {
      res.setHeader('Set-Cookie', session.clearCookieHeader());
      log(`面板口令已更新，已踢掉 ${kicked} 个登录会话`, 'panel');
      auditRecord({ actor: auth.who, ip: clientIpOf(req), method: 'POST', path: p, status: 200, action: '改面板口令并踢掉所有会话', target: `${kicked} 个` });
    }
    return sendJson(res, 200, { ok: true, authEnabled: !!state.panel.user, relogin: kicked > 0, revoked: kicked });
  }

  if (p === '/api/qr' && req.method === 'GET') {
    const text = url.searchParams.get('text') || state.tunnels.map(publicUrlOf).filter(Boolean)[0] || '';
    if (!text) return sendJson(res, 400, { ok: false, error: '没有可编码的内容' });
    if (text.length > 1200) return sendJson(res, 400, { ok: false, error: '内容太长（最多 1200 字符），二维码会密到扫不出来' });
    try {
      return sendJson(res, 200, { ok: true, text, dataUrl: await QRCode.toDataURL(text, { margin: 1, width: 360, errorCorrectionLevel: 'M' }) });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }



  // 导出/导入：整份配置（可脱敏）
  // 配置即代码：把可公开的配置导成 YAML，方便进 git 做 diff / review
  if (p === '/api/export.yaml' && req.method === 'GET') {
    const scalar = (v) => (v === null || v === undefined ? 'null'
      : typeof v === 'number' || typeof v === 'boolean' ? String(v)
        : JSON.stringify(String(v)));
    const toYaml = (v, ind = 0) => {
      const pad = '  '.repeat(ind);
      if (v === null || v === undefined || typeof v !== 'object') return scalar(v);
      if (Array.isArray(v)) {
        if (!v.length) return '[]';
        return '\n' + v.map((x) => {
          if (x && typeof x === 'object' && !Array.isArray(x)) {
            const keys = Object.keys(x).filter((k) => x[k] !== undefined);
            const first = keys.slice(0, 1).map((k) => `${k}: ${toYaml(x[k], ind + 2)}`).join('');
            const rest = keys.slice(1).map((k) => {
              const val = toYaml(x[k], ind + 2);
              return pad + '  ' + k + ':' + (val.startsWith('\n') ? val : ' ' + val);
            });
            return [pad + '- ' + first, ...rest].join('\n');
          }
          return pad + '- ' + toYaml(x, ind + 1).replace(/^\n/, '');
        }).join('\n');
      }
      const keys = Object.keys(v).filter((k) => v[k] !== undefined);
      if (!keys.length) return '{}';
      return '\n' + keys.map((k) => {
        const val = toYaml(v[k], ind + 1);
        return pad + k + ':' + (val.startsWith('\n') ? val : ' ' + val);
      }).join('\n');
    };
    const dump = {
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: publicSettings(),
      tunnels: publicTunnels().map((t) => ({ id: t.id, name: t.name, mode: t.mode, enabled: t.enabled, origin: t.origin, publicHostname: t.publicHostname, protocol: t.protocol, loglevel: t.loglevel, metricsPort: t.metricsPort })),
      routes: state.routes.map((r) => ({ id: r.id, name: r.name, path: r.path, host: r.host, upstream: r.upstream, strip: r.strip, tunnelId: r.tunnelId, methods: r.matchMethod, ipAllow: r.ipAllow, timeoutSec: r.timeoutSec, backupUpstream: r.backupUpstream, note: r.note })),
    };
    const body = '# cf-tunnel-panel 配置快照（不含任何密钥）\n' + toYaml(dump).replace(/^\n/, '');
    res.writeHead(200, { 'Content-Type': 'application/yaml; charset=utf-8', 'Content-Disposition': 'attachment; filename="cf-tunnel-panel.yaml"' });
    return res.end(body);
  }

  if (p === '/api/export' && req.method === 'GET') {
    const full = url.searchParams.get('full') === '1';
    // 含密钥的导出只给管理员：GET 对「只读/运维」账号都是放行的，
    // 不加这道门，只读账号点一下就能把隧道 token、CF API token、TOTP 密钥全导出。
    if (full && (auth.role || 'admin') !== 'admin') {
      return sendJson(res, 403, { ok: false, code: 'readonly', error: '只有管理员能导出含密钥的配置' });
    }
    const copy = JSON.parse(JSON.stringify(state));
    if (!full) {
      (copy.tunnels || []).forEach((t) => { t.token = ''; });
      copy.panel.pass = '';
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="cf-tunnel-panel-${Date.now()}.json"`,
    });
    return res.end(JSON.stringify(copy, null, 2));
  }

  // ---- 配置即代码：快照 / 差异 / 按声明应用 ----
  if (p === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, config: configcode.snapshot(state) });
  }
  if (p === '/api/config/drift' && req.method === 'GET') {
    const applied = configcode.lastApplied(DATA_DIR);
    const cur = configcode.snapshot(state);
    if (!applied) return sendJson(res, 200, { ok: true, hasBaseline: false, drift: null, config: cur });
    return sendJson(res, 200, { ok: true, hasBaseline: true, drift: configcode.diffView(applied, cur) });
  }
  if (p === '/api/config/snapshots' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, items: configcode.listSnapshots(DATA_DIR, 30) });
  }
  if (p === '/api/config/snapshot' && req.method === 'GET') {
    try {
      const file = String(url.searchParams.get('file') || '');
      return sendJson(res, 200, { ok: true, file, config: configcode.readSnapshot(DATA_DIR, file) });
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (p === '/api/config/snapshot' && req.method === 'POST') {
    const file = configcode.writeSnapshot(DATA_DIR, configcode.snapshot(state), 'manual');
    auditRecord({ actor: auth.who, ip: clientIpOf(req), method: 'POST', path: p, status: 200, action: '保存配置快照', target: file });
    return sendJson(res, 200, { ok: true, file });
  }
  if (p === '/api/config/apply' && req.method === 'POST') {
    let body = {};
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: '解析失败：' + e.message }); }
    const incoming = body.config && typeof body.config === 'object' ? body.config : body;
    const dry = !!body.dry;
    try {
      if (!incoming || typeof incoming !== 'object') throw new Error('配置必须是 JSON 对象');
      if (!Array.isArray(incoming.routes)) throw new Error('配置里要有 routes 数组');
      const nextRoutes = validateRoutes(incoming.routes, state.routes);
      const prevTunnels = new Map((state.tunnels || []).map((t) => [t.id, t]));
      const nextTunnels = (incoming.tunnels || []).map((t) => {
        const base = prevTunnels.get(t.id) ? JSON.parse(JSON.stringify(prevTunnels.get(t.id))) : newTunnel();
        const merged = { ...base, ...t };
        merged.id = String(t.id || base.id);
        return merged;
      });
      const prevCfg = configcode.snapshot(state);
      const nextCfg = {
        apiVersion: 'cf-tunnel-panel/v1', kind: 'Config',
        settings: prevCfg.settings, tunnels: nextTunnels.map(configcode.tunnelView), routes: nextRoutes.map(configcode.routeView),
        shares: prevCfg.shares,
      };
      const d = configcode.diffView(prevCfg, nextCfg);
      const touchesTunnels = d.added.concat(d.removed, d.changed).some((x) => x.kind === 'tunnels');
      const g = guard.inspect(nextRoutes, { panelPort: PORT, prevRoutes: state.routes });
      if (dry) return sendJson(res, 200, { ok: true, dry: true, diff: d, touchesTunnels, routes: nextRoutes.length, tunnels: nextTunnels.length, warnings: g.issues });
      if (g.blocked && !body.force) {
        return sendJson(res, 409, { ok: false, code: 'GUARD', issues: g.issues, error: g.issues[0].reason, hint: '确认无误就带 force:true 再提交' });
      }
      const file = configcode.writeSnapshot(DATA_DIR, prevCfg, 'before-apply');
      state.routes = nextRoutes;
      state.tunnels = nextTunnels;
      saveState('config-apply');
      pushCaddy().catch(() => {});
      if (touchesTunnels) syncTunnels([...prevTunnels.values()]);
      configcode.writeSnapshot(DATA_DIR, configcode.snapshot(state), 'apply');
      auditRecord({ actor: auth.who, ip: clientIpOf(req), method: 'POST', path: p, status: 200, action: '按声明应用配置', target: `+${d.added.length} -${d.removed.length} ~${d.changed.length}` });
      return sendJson(res, 200, { ok: true, file, diff: d, routes: nextRoutes.length, tunnels: nextTunnels.length, touchesTunnels });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }
  if (p === '/api/import' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      if (!body || typeof body !== 'object') throw new Error('导入内容必须是 JSON 对象');
      const merged = deepDefault(body, defaultState());
      merged.routes = validateRoutes(merged.routes || [], state.routes);
      // 导入不该抹掉密钥：导出默认会去掉 token / CF API token / 通知地址，
      // 如果导入的文件里这些字段是空的，就沿用当前配置里的值（同 id 的隧道逐个合并）。
      const prevTunnels = new Map((state.tunnels || []).map((t) => [t.id, t]));
      merged.tunnels = (merged.tunnels || []).map((t) => {
        const old = prevTunnels.get(t.id);
        if (old && !t.token && old.token) t.token = old.token;
        return t;
      });
      if (merged.settings && merged.settings.cf && !merged.settings.cf.token && state.settings.cf.token) {
        merged.settings.cf.token = state.settings.cf.token;
      }
      if (merged.settings && merged.settings.notify && !merged.settings.notify.secret && state.settings.notify.secret) {
        merged.settings.notify.secret = state.settings.notify.secret;
      }
      if (merged.settings && merged.settings.notify && !merged.settings.notify.url && state.settings.notify.url) {
        merged.settings.notify.url = state.settings.notify.url;
      }
      // 面板/只读密码同样不能被脱敏导出抹掉：用户同名且文件里密码为空 → 沿用当前密码
      if (merged.panel) {
        if (!merged.panel.user && state.panel.user) merged.panel = state.panel;
        else if (!merged.panel.pass && state.panel.pass && merged.panel.user === state.panel.user) merged.panel.pass = state.panel.pass;
      }
      if (merged.viewer) {
        if (!merged.viewer.pass && state.viewer && state.viewer.pass && merged.viewer.user === state.viewer.user) {
          merged.viewer.pass = state.viewer.pass;
        }
        if (!merged.viewer.user) merged.viewer = { user: '', pass: '' };
      }
      setState(merged);
      saveState('import');
      await pushCaddy();
      normalizeTunnels();
      startAll();
      return sendJson(res, 200, { ok: true, routeCount: state.routes.length });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
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
    await _routesRules.handle(p, req, res, url);
    if (res.writableEnded || res.headersSent) return;
    await _routesObserve.handle(p, req, res, url);
    if (res.writableEnded || res.headersSent) return;
    await _routesMonitor.handle(p, req, res, url);
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
