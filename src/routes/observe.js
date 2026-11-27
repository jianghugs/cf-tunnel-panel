'use strict';
/**
 * observe 相关路由（C8 第三步从 src/server.js 剪出，块内逻辑逐行未改）。
 * 公共依赖沿用 server.js 顶部同一套 require，这里复制一份，避免两边各写一套。
 * server.js 侧只负责判前缀，调用后看响应有没有写出来决定是否继续往下走。
 */

// ---- OpenAPI 描述（GET /api/openapi 用）：首次读盘后进程内缓存
let _openapiCache = null;
function readOpenapi() {
  if (_openapiCache) return _openapiCache;
  const f = path.join(__dirname, '..', '..', 'docs', 'openapi.json');
  _openapiCache = JSON.parse(fs.readFileSync(f, 'utf8'));
  return _openapiCache;
}
const os = require('os');
const { spawn } = require('child_process');
const QRCode = require('qrcode');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const _audit = require('../core/audit');
const { record: auditRecord, list: auditList, stats: auditStats, byHour: auditByHour, actionOf, days: auditDays } = _audit;

const _paths = require('../core/paths');
const { ACCESS_LOG_FILE, ASSET_DIR, ASSET_TYPES, BACKUP_DIR, CADDY_ADMIN, CADDY_LOG_DIR, CLOUDFLARED, CLOUDFLARE_DEFAULT_RANGES, DATA_DIR, LB_POLICIES, LOGLEVELS, LOG_MAX, METHODS, PAGES, PAGE_DIR, PORT, PROTOCOLS, STATE_FILE, VERSION, WEB_DIR, accessLogPathForCaddy, pkgVersion } = _paths;

const _util = require('../core/util');
const { SEC_HEADERS, log, logSeq, logs, parseCidrs, parseHeaderLines, parseUpstream, rateLimited, readBody, rid, rlHits, sendJson, sseClients } = _util;

const _state = require('../core/state');
const { maybeReloadState } = _state;
const { acquireLock } = _state;
const { stateProxy, setState, deepDefault, defaultOrigin, defaultState, isFreshState, loadState, migrateState, newTunnel, normalizeTunnels, publicRoute, publicSettings, saveState, validateRoutes } = _state;
// 注意：必须是 stateProxy（指向模块内部同一个对象），直接把 state 解构出来会拿到
// loadState() 之前那个默认对象，导致 /api/state 看到的路由/出口数量和真实的不一致。
const state = stateProxy;

const _registry = require('../core/registry');
const { firstTunnel, publicUrlOf, runtimes, tunnelById, tunnelRt } = _registry;

const _auth = require('../core/auth');
const { clearBasicCache, AUTH_BLOCK_MS, AUTH_FAIL_LIMIT, AUTH_FAIL_WINDOW, authBlockedFor, authFails, authOk, checkAuth, clearAuthFail, clientIpOf, noteAuthFail, login , completeTotp } = _auth;

const _session = require('../core/session');
const history = require('../core/history');
const session = _session;

const secret = require('../core/secret');
const ident = require('../core/ident');
const _selfcheck = require('../core/selfcheck');
const configcode = require('../core/configcode');
const guard = require('../core/guard');
const lease = require('../core/lease');
const totp = require('../core/totp');
const perm = require('../core/perm');

const _caddy = require('../core/caddy');
const { buildCaddyConfig, buildMatch, buildRouteHandlers, caddy, cloudflareRanges, lastSkipped, maintPage, tunnelHostOf, PANEL_SLOT_RE, panelSlots } = _caddy;

const _pusher = require('../core/pusher');
const { pushCaddy, pushTimer, schedulePush } = _pusher;

const _tunnels = require('../core/tunnels');
const { QUICK_RE, applyTunnelFields, normalizeTunnelToken, publicTunnels, runtimeOf, startAll, startTunnel, stopAll, stopTunnel, syncTunnels, tokenTunnelOf, tunnelArgs } = _tunnels;

const _insight = require('../core/insight');
const { countPanelReq, upstreamHealth, HISTORY_MAX, badgeSvg, diffRoutes, healthOf, histTick, metricsText, readAccess, refreshUpstreamHealth, requestsLastMinute, rtHistory, sampleHistory, securityAttempts, shadowReport, simulateMatch, systemInfo, tcpProbeOnce, trafficByHour, trafficByPath, upstreamTarget } = _insight;

const _bench = require('../core/bench');
const { BENCH_MAX_MB, benchLocalOnce, coloOf, sendBenchBlob } = _bench;

const _probe = require('../core/probe');
const { getV4 } = require('../core/httpv4');
const { curlSelf, probeUpstream, wsProbe } = _probe;

const _integrations = require('../core/integrations');
const { cfApi, dockerApi, dockerContainers, pickWebPort } = _integrations;

const _notify = require('../core/notify');
const { inQuietHours, notify, notifyHistory, recordNotify } = _notify;

const _i18n = require('../core/i18n');
const { langOf } = _i18n;

const _web = require('../core/web');
const { pageShell, readPage, serveText, loginPage } = _web;

const _monitor = require('../core/monitor');
const { seenCaddyOk, shareJanitor, shareUrl, startMonitor } = _monitor;

const _httpStatic = require('../http/static');
const _httpBoot = require('../http/boot');
const _httpOnReq = require('../http/onreq');

// 搬运前 auth 是 server.js handler 内的局部变量（checkAuth(req) 的结果）。
// 每个请求只算一次，结果挂在 req 上缓存，避免重复校验与重复计数。
const _authCache = new WeakMap();
function authOf(req) {
  let a = _authCache.get(req);
  if (!a) {
    a = require('../core/auth').checkAuth(req);
    _authCache.set(req, a);
  }
  return a;
}



async function handle(p, req, res, url) {
  // 旧版单页（保留以便随时回退）
  if (p === '/api/audit/trend' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, buckets: auditByHour(url.searchParams.get('hours') || 12) });
  }

  if (p === '/api/audit/days' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, days: auditDays(), keepDays: require('../core/audit').KEEP_DAYS });
  }

  if (p === '/api/audit' && req.method === 'GET') {
    const date = url.searchParams.get('date') || '';
    // limit 必须夹住：之前直接透传，一个 ?limit=99999 就能拉 300KB+
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 2000);
    return sendJson(res, 200, {
      ...auditList({
        limit, q: url.searchParams.get('q') || '', date,
        act: url.searchParams.get('act') || '', bad: url.searchParams.get('bad') === '1',
      }),
      stats: auditStats(), days: auditDays(), actions: _audit.actions(),
    });
  }

  // 按出口聚合：多条隧道跑不同域名时，看谁在吃流量、谁在报错
  if (p === '/api/tunnels/stats' && req.method === 'GET') {
    const url2 = new URL(req.url, 'http://x');
    const hours = Math.min(Math.max(Number(url2.searchParams.get('hours')) || 24, 0.1), 168);
    const d = readAccess(4000, { since: Date.now() - hours * 3600 * 1000, maxBytes: 4 * 1024 * 1024 });
    const rows = (d && d.rows) || [];
    const hostOf = (t) => {
      const u = publicUrlOf(t) || '';
      const m = /^https?:\/\/([^/:]+)/i.exec(u);
      return m ? m[1].toLowerCase() : '';
    };
    const buckets = new Map(); // host -> {count, ok, err4, err5, bytes, durs: []}
    const other = { count: 0, hosts: new Map() };
    const known = new Map();
    for (const t of state.tunnels) {
      const h = hostOf(t);
      if (h) known.set(h, t.id);
    }
    for (const r of rows) {
      const host = String(r.host || '').toLowerCase();
      if (!host) continue;
      if (!known.has(host)) {
        other.count += 1;
        other.hosts.set(host, (other.hosts.get(host) || 0) + 1);
        continue;
      }
      const b = buckets.get(host) || { count: 0, ok: 0, err4: 0, err5: 0, bytes: 0, durs: [] };
      b.count += 1;
      const st = Number(r.status) || 0;
      if (st >= 500) b.err5 += 1; else if (st >= 400) b.err4 += 1; else b.ok += 1;
      b.bytes += Number(r.size) || 0;
      if (r.durMs) b.durs.push(r.durMs);
      buckets.set(host, b);
    }
    const p95 = (arr) => {
      if (!arr.length) return 0;
      const a = arr.slice().sort((x, y) => x - y);
      return a[Math.min(a.length - 1, Math.floor(a.length * 0.95))];
    };
    const tunnels = state.tunnels.map((t) => {
      const host = hostOf(t);
      const b = (host && buckets.get(host)) || { count: 0, ok: 0, err4: 0, err5: 0, bytes: 0, durs: [] };
      return {
        id: t.id, name: t.name, mode: t.mode, host,
        count: b.count, ok: b.ok, err4: b.err4, err5: b.err5,
        bytes: b.bytes, p95: p95(b.durs),
      };
    });
    const others = [...other.hosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([host, count]) => ({ host, count }));
    return sendJson(res, 200, { ok: true, hours, sampled: rows.length, tunnels, other: { count: other.count, hosts: others }, note: (d && d.note) || '' });
  }

  // 按规则聚合访问日志：谁在被访问、谁在报错、哪条慢
  if (p === '/api/routes/stats' && req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 2000, 50), 8000);
    // hours：只看最近 N 小时（0/缺省 = 不按时间过滤，取最后 limit 条）
    const hours = Math.min(Math.max(Number(url.searchParams.get('hours')) || 0, 0), 168);
    const since = hours ? Date.now() - hours * 3600 * 1000 : 0;
    const d = readAccess(limit, { since, maxBytes: hours ? 4 * 1024 * 1024 : 512 * 1024 });
    const rows = (d && d.rows) || [];
    const acc = new Map(); // index -> {count, s2, s3, s4, s5, durs, bytes}
    const unmatched = { count: 0, s4: 0, s5: 0 };
    for (const r of rows) {
      const path = String(r.uri || '/').split('?')[0];
      const m = simulateMatch(path, r.host || '', r.method || 'GET');
      const idx = m && m.matched ? (m.ofIndex != null ? m.ofIndex : m.index - 1) : -1;
      const st = Number(r.status) || 0;
      if (idx < 0) {
        unmatched.count += 1;
        if (st >= 500) unmatched.s5 += 1; else if (st >= 400) unmatched.s4 += 1;
        continue;
      }
      let a = acc.get(idx);
      if (!a) { a = { count: 0, s1: 0, s2: 0, s3: 0, s4: 0, s5: 0, durs: [], bytes: 0 }; acc.set(idx, a); }
      a.count += 1;
      if (st >= 500) a.s5 += 1; else if (st >= 400) a.s4 += 1; else if (st >= 300) a.s3 += 1; else if (st >= 200) a.s2 += 1; else if (st >= 100) a.s1 += 1;
      if (r.durMs) a.durs.push(r.durMs);
      a.bytes += Number(r.size) || 0;
    }
    const pct = (arr, p) => {
      if (!arr.length) return 0;
      const q = arr.slice().sort((x, y) => x - y);
      return q[Math.min(q.length - 1, Math.max(0, Math.round((p / 100) * (q.length - 1))))];
    };
    const list = [...acc.entries()].map(([idx, a]) => {
      const rule = state.routes[idx] || {};
      return {
        index: idx, id: rule.id, name: rule.name || rule.path || '(未命名)', path: rule.path || '',
        host: rule.host || '', tunnelId: rule.tunnelId || '',
        count: a.count, ok: a.s2 + a.s3 + a.s1, err4: a.s4, err5: a.s5, upgraded: a.s1,
        errRate: a.count ? Math.round(((a.s4 + a.s5) / a.count) * 1000) / 10 : 0,
        p50: pct(a.durs, 50), p95: pct(a.durs, 95), max: a.durs.length ? Math.max(...a.durs) : 0,
        avg: a.durs.length ? Math.round(a.durs.reduce((x, y) => x + y, 0) / a.durs.length) : 0,
        bytes: a.bytes,
      };
    }).sort((a, b) => b.count - a.count);
    return sendJson(res, 200, {
      ok: true, available: !!d.available, sampled: rows.length, totalRoutes: state.routes.length,
      hours, unmatched, routes: list, note: d.note || '',
    });
  }

  if (p === '/api/logs' && req.method === 'GET') {
    const after = Number(url.searchParams.get('after') || 0);
    return sendJson(res, 200, { logs: logs.filter((l) => l.seq > after), last: logSeq });
  }

  if (p === '/api/logs/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    for (const l of logs.slice(-80)) res.write(`data: ${JSON.stringify(l)}\n\n`);
    sseClients.add(res);
    const ka = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
    req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
    return;
  }

  // --- Cloudflare API 增强：验证 token / 账号域名发现 / 隧道详情 / DNS 记录 ---
  if (p === '/api/traffic') {
    const hours = Math.min(72, Math.max(1, Number(url.searchParams.get('hours')) || 12));
    return sendJson(res, 200, { ok: true, ...trafficByHour(hours) });
  }

  // 按归属规则的流量趋势：哪个服务在吃流量
  if (p === '/api/traffic/paths') {
    const hours = Math.min(72, Math.max(1, Number(url.searchParams.get('hours')) || 12));
    const top = Math.min(8, Math.max(1, Number(url.searchParams.get('top')) || 4));
    return sendJson(res, 200, { ok: true, ...trafficByPath(hours, top) });
  }

  if (p === '/api/history') return sendJson(res, 200, { ok: true, points: history.sampleList(), max: HISTORY_MAX, shared: true });

  if (p === '/api/notify/history') return sendJson(res, 200, { ok: true, items: history.notifyList().slice().reverse(), shared: true });

  if (p === '/api/notify/resend' && req.method === 'POST') {
    let body = {};
    try { body = await readBody(req); } catch { body = {}; }
    const seqN = Number(body.seq || 0);
    const all = history.notifyList();
    const entry = history.notifyBySeq(seqN) || all[all.length - 1];
    if (!entry) return sendJson(res, 400, { ok: false, error: '还没有任何通知记录可以重发' });
    const n = state.settings.notify || {};
    if (!n.url) return sendJson(res, 400, { ok: false, error: '还没配置通知地址（设置 → 掉线通知）' });
    const sent = await notify(entry.event, entry.title, entry.text || '', { force: true, ignoreDisabled: true });
    auditRecord({ actor: authOf(req).who, ip: clientIpOf(req), method: 'POST', path: p, status: sent ? 200 : 502, action: '重发通知', target: `${entry.event} · ${entry.title}` });
    if (!sent) return sendJson(res, 502, { ok: false, error: '重发失败，看下面的「通知发送记录」里最新一条的原因' });
    return sendJson(res, 200, { ok: true, event: entry.event, title: entry.title });
  }

  return false;
}

module.exports = { handle };
