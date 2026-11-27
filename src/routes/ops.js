'use strict';
/**
 * ops 相关路由（C8 第三步从 src/server.js 剪出，块内逻辑逐行未改）。
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

  return false;
}

module.exports = { handle };
