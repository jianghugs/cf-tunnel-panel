'use strict';
/**
 * monitor 相关路由（C8 第三步从 src/server.js 剪出，块内逻辑逐行未改）。
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
const crypto = require('crypto');

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
  // 一键体检：把「哪里不对」一次性查出来（面板/Caddy/出口/Prometheus/Grafana/磁盘）
  if (p === '/api/selfcheck' && req.method === 'GET') {
    const scope = String(url.searchParams.get('scope') || '').toLowerCase();
    let ids = String(url.searchParams.get('ids') || '').split(',').map((x) => x.trim()).filter(Boolean);
    // scope=quick：跳过要过 Cloudflare 的出口探测（只跑静态项），也就不写留痕
    if (!ids.length && scope === 'quick') ids = _selfcheck.CHECK_IDS.slice();
    if (ids.length) {
      const unknown = ids.filter((x) => !_selfcheck.CHECK_IDS.includes(x) && !/^exit-/.test(x));
      if (unknown.length) {
        return sendJson(res, 400, { ok: false, error: `未知的检查项：${unknown.join('、')}`, valid: _selfcheck.CHECK_IDS });
      }
    }
    const manualIds = String(url.searchParams.get('ids') || '').trim();
    const { out } = await require('../core/runtime').runSelfcheckOnce({ ids, scope: (scope === 'quick' && !manualIds) ? 'quick' : '' });
    const only = String(url.searchParams.get('only') || '').toLowerCase();
    if (only === 'bad') {
      const bad = (out.checks || []).filter((c) => c.status !== 'ok');
      return sendJson(res, 200, { ...out, checks: bad, shown: bad.length });
    }
    return sendJson(res, 200, out);
  }

  if (p === '/api/selfcheck/history' && req.method === 'GET') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 300);
    const hours = Math.min(Math.max(Number(url.searchParams.get('hours')) || 24, 1), 72);
    const items = _selfcheck.history(limit);
    const since = Date.now() - hours * 3600e3;
    const atOf = (h) => { const v = h && h.at; const n = Number(v); return Number.isFinite(n) && n > 1e12 ? n : (Date.parse(v) || 0); };
    const inWindow = items.filter((h) => atOf(h) >= since);
    const scopes = {
      all: inWindow.filter((h) => h.scope !== 'quick').length,
      quick: inWindow.filter((h) => h.scope === 'quick').length,
    };
    // ?scope=all 只给全量记录：前端拿它做聚合，免得自己筛
    const wantScope = String(url.searchParams.get('scope') || '').toLowerCase();
    const itemsOut = wantScope === 'all' ? items.filter((h) => h.scope !== 'quick') : items;
    return sendJson(res, 200, {
      ok: true,
      last: _selfcheck.lastResult(),
      hours,
      scopes,
      runs: inWindow.length,
      coverageHours: items.length ? Math.max(0, Math.round((Date.now() - (atOf(items[items.length - 1]) || Date.now())) / 36e5 * 10) / 10) : 0,
      fails: _selfcheck.fails(inWindow),
      store: _selfcheck.storeInfo(),
      items: itemsOut,
    });
  }

  // 监控页：面板替你去问 Prometheus（targets / 告警），省得再开一个标签页
  if (p === '/api/monitor/status' && req.method === 'GET') {
    const base = String((state.settings.monitoring || {}).promUrl || '').trim().replace(/\/+$/, '');
    const activeMutes = () => {
      const nowMs = Date.now();
      return ((state.settings.alerts || {}).mutes || [])
        .filter((m) => m && m.name && (!m.until || Date.parse(m.until) > nowMs))
        .map((m) => ({ name: m.name, until: m.until || '', note: m.note || '' }));
    };
    if (!/^https?:\/\/[^\s]+$/i.test(base)) {
      return sendJson(res, 200, { ok: false, promUrl: base, error: '还没配 Prometheus 地址（设置 → 监控嵌入）', mutes: activeMutes(), targets: [], alerts: [] });
    }
    const grab = async (pathname) => {
      const r = await fetch(base + pathname, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) throw new Error(`${pathname} → HTTP ${r.status}`);
      return r.json();
    };
    try {
      const ready = await fetch(base + '/-/ready', { signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false);
      let targets = [];
      let alerts = [];
      try {
        const t = await grab('/api/v1/targets?state=active');
        targets = ((t.data && t.data.activeTargets) || []).map((x) => ({
          job: (x.labels && x.labels.job) || '', instance: (x.labels && x.labels.instance) || '',
          health: x.health || 'unknown', scrapeUrl: x.scrapeUrl || '',
          lastScrape: x.lastScrape || '', lastError: (x.lastError || '').slice(0, 200),
        })).sort((a, b) => String(a.health).localeCompare(String(b.health)));
      } catch (e) { targets = []; }
      try {
        const a = await grab('/api/v1/alerts');
        alerts = ((a.data && a.data.alerts) || []).map((x) => ({
          name: (x.labels && x.labels.alertname) || '', state: x.state || '',
          severity: (x.labels && x.labels.severity) || '', summary: (x.annotations && x.annotations.summary) || '',
          activeAt: x.activeAt || '',
          labels: Object.fromEntries(Object.entries(x.labels || {}).filter(([k]) => ['id', 'name', 'mode', 'instance', 'job', 'status', 'severity'].includes(k))),
        }));
      } catch (e) { alerts = []; }
      const down = targets.filter((t) => t.health !== 'up').length;
      // 面板侧静默：只影响本页显示，Prometheus/Alertmanager 侧仍照常记录与通知
      const nowMs = Date.now();
      const mutes = ((state.settings.alerts || {}).mutes || [])
        .filter((m) => m && m.name && (!m.until || Date.parse(m.until) > nowMs));
      const muteMap = new Map(mutes.map((m) => [m.name, m]));
      alerts = alerts.map((a) => ({ ...a, muted: muteMap.has(a.name), muteUntil: (muteMap.get(a.name) || {}).until || '' }));
      return sendJson(res, 200, {
        ok: true, promUrl: base, ready, targets, alerts,
        summary: { total: targets.length, up: targets.length - down, down, muted: alerts.filter((a) => a.muted).length },
        mutes: mutes.map((m) => ({ name: m.name, until: m.until || '', note: m.note || '' })),
      });
    } catch (e) {
      return sendJson(res, 200, { ok: false, promUrl: base, error: `连不上 Prometheus：${e.message}`, mutes: activeMutes(), targets: [], alerts: [] });
    }
  }

  if (p === '/api/alerts/hook-token' && req.method === 'GET') {
    if ((authOf(req).role || 'admin') !== 'admin') return sendJson(res, 403, { ok: false, error: '只有管理员能查看回调令牌' });
    const cur = state.settings.alerts || (state.settings.alerts = { mutes: [], hookToken: '' });
    if (!cur.hookToken) {
      cur.hookToken = crypto.randomBytes(16).toString('hex');
      saveState('alert-hook-token');
    }
    const host = String(((state.tunnels || []).find((t) => t.mode === 'named' && t.publicHostname) || {}).publicHostname || '');
    return sendJson(res, 200, {
      ok: true,
      token: cur.hookToken,
      localUrl: `http://127.0.0.1:${PORT}/api/alerts/hook`,
      hint: 'Alertmanager 跑在同一台机器上就用 localUrl；写在 alertmanager.yml 的 webhook_configs.url，并加 headers: {x-cfp-token: 令牌}',
      publicHost: host,
    });
  }

  if (p === '/api/monitor/mute' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      if (!/^[A-Za-z][A-Za-z0-9_]{1,60}$/.test(name)) return sendJson(res, 400, { ok: false, error: '告警名字不合法' });
      const minutes = Math.min(Math.max(Number(body.minutes) || 60, 5), 24 * 60);
      const until = new Date(Date.now() + minutes * 60000).toISOString();
      const note = String(body.note || '').slice(0, 200);
      const cur = state.settings.alerts || (state.settings.alerts = { mutes: [] });
      cur.mutes = (cur.mutes || []).filter((m) => m && m.name !== name);
      cur.mutes.push({ name, until, note });
      saveState('alert-mute');
      auditRecord({ action: '静默告警', target: `${name} 至 ${until}`, ip: clientIpOf(req), actor: authOf(req).who, method: req.method, path: p, status: 200, ms: 0 });
      return sendJson(res, 200, { ok: true, name, until, minutes });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (p === '/api/monitor/unmute' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      const cur = state.settings.alerts || (state.settings.alerts = { mutes: [] });
      const before = (cur.mutes || []).length;
      cur.mutes = (cur.mutes || []).filter((m) => m && m.name !== name);
      const removed = before - cur.mutes.length;
      saveState('alert-unmute');
      auditRecord({ action: '取消静默', target: name || '(全部)', ip: clientIpOf(req), actor: authOf(req).who, method: req.method, path: p, status: 200, ms: 0 });
      return sendJson(res, 200, { ok: true, removed });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  return false;
}

module.exports = { handle };
