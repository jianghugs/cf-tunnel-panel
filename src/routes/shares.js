'use strict';
/**
 * shares 相关路由（C8 第二步从 src/server.js 搬出，块内逻辑逐行未改）。
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
const crypto = require('crypto');

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
const fs = require('fs');
const path = require('path');

async function handle(p, req, res, url) {
  if (p === '/api/shares' && req.method === 'GET') {
    return sendJson(res, 200, {
      shares: (state.shares || []).map((s) => ({ ...s, url: shareUrl(s.token), leftSec: Math.max(0, Math.round((s.expiresAt - Date.now()) / 1000)) })),
    });
  }
  if (p === '/api/shares' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const up = String(body.upstream || '').trim();
      if (!up) throw new Error('上游地址不能为空');
      parseUpstream(up);
      const minutes = Math.max(1, Math.min(10080, Number(body.minutes) || 30));
      const s = {
        id: rid(), token: crypto.randomBytes(9).toString('base64url'),
        name: String(body.name || '临时分享').slice(0, 60), upstream: up,
        createdAt: Date.now(), expiresAt: Date.now() + minutes * 60000,
      };
      state.shares = [...(state.shares || []), s];
      saveState('share-add');
      await pushCaddy();
      log(`已生成分享链接 ${s.name} → ${up}（${minutes} 分钟）`, 'panel');
      return sendJson(res, 200, { ok: true, share: { ...s, url: shareUrl(s.token) }, caddy });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }
  const sm = p.match(/^\/api\/shares\/([\w-]+)\/delete$/);
  if (sm && req.method === 'POST') {
    const before = (state.shares || []).length;
    state.shares = (state.shares || []).filter((s) => s.id !== sm[1]);
    if (state.shares.length === before) return sendJson(res, 404, { ok: false, error: '这条分享链接不存在' });
    saveState('share-del');
    await pushCaddy();
    return sendJson(res, 200, { ok: true, caddy });
  }

  // ---- 面板内 curl 测试器（只打本机 Caddy，安全）
  if (p === '/api/ws-test' && req.method === 'POST') {
    const body = await readBody(req);
    const caddyPort = (String((state.settings || {}).caddyListen || ':8080').split(':').pop() || '8080');
    const target = `http://127.0.0.1:${caddyPort}${body.path || '/'}`;
    const r = await wsProbe(target, body.host ? String(body.host).trim() : `127.0.0.1:${caddyPort}`);
    log(`WS 自测 ${body.path || '/'} → ${r.ok ? '可升级（101）' : r.error}`, 'panel');
    return sendJson(res, 200, { ok: !!r.ok, target, ...r });
  }

  if (p === '/api/curl' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, await curlSelf(body.path || '/'));
  }

  // ---- 日志下载
  if (p === '/api/logs/download' && req.method === 'GET') {
    const text = logs.map((l) => `[${new Date(l.t || Date.now()).toISOString()}] (${l.source}) ${l.line}`).join('\n');
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="cf-tunnel-panel-log-${Date.now()}.txt"`,
    });
    return res.end(text);
  }

  // ---- Prometheus metrics
  if (p === '/metrics' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(metricsText() + exitMetricsLines());
  }

  // ---- Cloudflare API
  // ---- 命名隧道的「公共主机名」管理（Cloudflare 隧道配置 API，v0.12 新增）----
  // 以前这一步只能去 Cloudflare 后台点，面板只能提醒"只建 CNAME 会 1033"。
  // 现在直接读写 cf d_tunnel/{id}/configurations：加/删主机名 = 改 ingress 规则。
  return false;
}

module.exports = { handle };
