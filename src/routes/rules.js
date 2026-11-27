'use strict';
/**
 * rules 相关路由（C8 第三步从 src/server.js 剪出，块内逻辑逐行未改）。
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
  if (p === '/api/caddy/config' && req.method === 'GET') {
    try {
      return sendJson(res, 200, { ok: true, config: buildCaddyConfig() });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e.message });
    }
  }

  if (p === '/api/rules/test' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      return sendJson(res, 200, await probeUpstream(body.upstream));
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (p === '/api/match' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      return sendJson(res, 200, simulateMatch(body.path, body.host, body.method));
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (p === '/api/routes' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const nextRoutes = validateRoutes(body.routes, state.routes);
      const g = guard.inspect(nextRoutes, { panelPort: PORT, prevRoutes: state.routes });
      if (g.blocked && !body.force) {
        return sendJson(res, 409, { ok: false, code: 'GUARD', issues: g.issues, error: g.issues[0].reason, hint: '确认无误就带 force:true 再提交' });
      }
      const prevEnabled = new Map((state.routes || []).map((r) => [r.id, r.enabled !== false]));
      state.routes = nextRoutes;
      saveState('routes');
      await pushCaddy();
      const flipped = nextRoutes.filter((r) => prevEnabled.has(r.id) && prevEnabled.get(r.id) !== (r.enabled !== false));
      if (flipped.length === 1) {
        const f0 = flipped[0];
        auditRecord({
          action: f0.enabled === false ? '停用规则' : '启用规则',
          target: String(f0.name || f0.path || f0.id),
          actor: authOf(req).who, ip: clientIpOf(req), method: req.method, path: p, status: 200, ms: 0,
        });
      }
      return sendJson(res, 200, { ok: true, routes: state.routes.map(publicRoute), caddy });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (p === '/api/caddy/push' && req.method === 'POST') { const c = await pushCaddy(); return sendJson(res, 200, { ok: c.ok, caddy: c }); }

  return false;
}

module.exports = { handle };
