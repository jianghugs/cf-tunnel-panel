'use strict';
/**
 * cf 相关路由（C8 第二步从 src/server.js 搬出，块内逻辑逐行未改）。
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
  const cfIngress = p.match(/^\/api\/cf\/tunnels\/([0-9a-fA-F-]{36})\/ingress$/);
  if (cfIngress && req.method === 'GET') {
    try {
      const cf = state.settings.cf || {};
      if (!cf.accountId) throw new Error('还没填 Account ID（设置 → Cloudflare API）');
      const r = await cfApi(`/accounts/${cf.accountId}/cfd_tunnel/${cfIngress[1]}/configurations`);
      const cfg = (r && r.config) || {};
      const ingress = (cfg.ingress || []).filter((x) => x && x.hostname);
      return sendJson(res, 200, { ok: true, ingress, raw: cfg });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (/^\/api\/cf\/tunnels\/[0-9a-fA-F-]{36}\/hostnames$/.test(p) && req.method === 'POST') {
    try {
      const tid = p.split('/')[4];
      const body = await readBody(req);
      const cf = state.settings.cf || {};
      if (!cf.accountId) throw new Error('还没填 Account ID（设置 → Cloudflare API）');
      const hostname = String(body.hostname || '').trim().toLowerCase();
      if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(hostname)) throw new Error('域名格式不对，例如 app.example.com');
      const service = String(body.service || '').trim();
      if (!/^(https?:\/\/|ssh:\/\/|tcp:\/\/)[^\s]{1,300}$/i.test(service)) {
        throw new Error('上游要写成 http://127.0.0.1:8080 / ssh://localhost:22 这样的完整地址');
      }
      const cur = await cfApi(`/accounts/${cf.accountId}/cfd_tunnel/${tid}/configurations`);
      const cfg = Object.assign({}, (cur && cur.config) || {});
      const ingress = Array.isArray(cfg.ingress) && cfg.ingress.length ? cfg.ingress.slice() : [{ service: 'http_status:404' }];
      if (ingress.some((x) => x && String(x.hostname || '').toLowerCase() === hostname)) {
        throw new Error(`这条隧道已经有 ${hostname} 了；要改就删掉再加`);
      }
      // 兜底规则（没有 hostname 的那条）必须在最后，否则它会把后面的全吃掉
      let tail = ingress.filter((x) => !x.hostname);
      if (!tail.length) tail = [{ service: 'http_status:404' }];
      const head = ingress.filter((x) => x.hostname);
      const next = [...head, { hostname, service }, ...tail];
      cfg.ingress = next;
      await cfApi(`/accounts/${cf.accountId}/cfd_tunnel/${tid}/configurations`, { method: 'PUT', body: { config: cfg } });
      let dns = null;
      if (body.addDns !== false && cf.zoneId) {
        dns = await cfApi(`/zones/${cf.zoneId}/dns_records`, {
          method: 'POST',
          body: { type: 'CNAME', name: hostname, content: `${tid}.cfargotunnel.com`, proxied: true, comment: 'created by cf-tunnel-panel' },
        }).catch((e) => ({ error: e.message }));
      }
      log(`隧道 ${tid.slice(0, 8)} 新增公共主机名 ${hostname} → ${service}`, 'panel');
      auditRecord({ actor: authOf(req).who, ip: clientIpOf(req), method: 'POST', path: p, status: 200, action: '新增隧道公共主机名', target: `${hostname} → ${service}` });
      return sendJson(res, 200, { ok: true, hostname, service, dns, ingress: head.concat({ hostname, service }) });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (/^\/api\/cf\/tunnels\/[0-9a-fA-F-]{36}\/hostnames\/delete$/.test(p) && req.method === 'POST') {
    try {
      const tid = p.split('/')[4];
      const body = await readBody(req);
      const cf = state.settings.cf || {};
      if (!cf.accountId) throw new Error('还没填 Account ID');
      const hostname = String(body.hostname || '').trim().toLowerCase();
      if (!hostname) throw new Error('要删哪个域名？');
      const cur = await cfApi(`/accounts/${cf.accountId}/cfd_tunnel/${tid}/configurations`);
      const cfg = Object.assign({}, (cur && cur.config) || {});
      const ingress = Array.isArray(cfg.ingress) ? cfg.ingress : [];
      const next = ingress.filter((x) => String(x.hostname || '').toLowerCase() !== hostname);
      cfg.ingress = next.length ? next : [{ service: 'http_status:404' }];
      await cfApi(`/accounts/${cf.accountId}/cfd_tunnel/${tid}/configurations`, { method: 'PUT', body: { config: cfg } });
      let dns = null;
      if (body.removeDns !== false && cf.zoneId) {
        const rec = await cfApi(`/zones/${cf.zoneId}/dns_records?name=${encodeURIComponent(hostname)}`).catch(() => null);
        const hit = rec && Array.isArray(rec) ? rec.find((r) => r.type === 'CNAME' && /cfargotunnel\.com$/.test(r.content)) : null;
        if (hit) dns = await cfApi(`/zones/${cf.zoneId}/dns_records/${hit.id}`, { method: 'DELETE' }).catch((e) => ({ error: e.message }));
      }
      log(`隧道 ${tid.slice(0, 8)} 删除公共主机名 ${hostname}`, 'panel');
      auditRecord({ actor: authOf(req).who, ip: clientIpOf(req), method: 'POST', path: p, status: 200, action: '删除隧道公共主机名', target: hostname });
      return sendJson(res, 200, { ok: true, hostname, dns });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (p === '/api/cf/tunnels' && req.method === 'GET') {
    try {
      const cf = state.settings.cf || {};
      if (!cf.accountId) throw new Error('还没填 Account ID（设置卡「Cloudflare API」里填）');
      const list = await cfApi(`/accounts/${cf.accountId}/cfd_tunnel?is_deleted=false`);
      return sendJson(res, 200, {
        ok: true,
        tunnels: (list || []).map((t) => ({ id: t.id, name: t.name, status: t.status, createdAt: t.created_at, connections: (t.connections || []).length })),
      });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }
  if (p === '/api/cf/tunnels' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const cf = state.settings.cf || {};
      if (!cf.accountId) throw new Error('还没填 Account ID');
      const name = String(body.name || '').trim();
      if (!/^[\w.-]{1,60}$/.test(name)) throw new Error('隧道名只能包含字母数字和 . _ -，最长 60');
      const tun = await cfApi(`/accounts/${cf.accountId}/cfd_tunnel`, { method: 'POST', body: { name, config_src: 'cloudflare' } });
      const token = await cfApi(`/accounts/${cf.accountId}/cfd_tunnel/${tun.id}/token`).catch(() => '');
      let dns = null;
      const hostname = String(body.hostname || '').trim();
      if (hostname && cf.zoneId) {
        dns = await cfApi(`/zones/${cf.zoneId}/dns_records`, {
          method: 'POST',
          body: { type: 'CNAME', name: hostname, content: `${tun.id}.cfargotunnel.com`, proxied: true, comment: 'created by cf-tunnel-panel' },
        }).catch((e) => ({ error: e.message }));
      }
      let localId = null;
      if (body.addLocal && token) {
        const t = applyTunnelFields(newTunnel(), { name, mode: 'named', token, publicHostname: hostname });
        state.tunnels.push(t);
        saveState('cf-tunnel-add');
        if (t.enabled) startTunnel(t.id);
        localId = t.id;
      }
      return sendJson(res, 200, { ok: true, tunnel: tun, token: token ? '已获取' : '获取失败（可在 Cloudflare 后台复制）', dns, localId });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }
  // 一键新建出口：建隧道 → 拿 token → 写 ingress（公共主机名）→ 建 CNAME → 可选落成本机出口
  if (p === '/api/cf/tunnels/quick' && req.method === 'POST') {
    let body = {};
    try { body = await readBody(req); } catch { body = {}; }
    const cf = state.settings.cf || {};
    const steps = [];
    const step = (name, ok2, detail) => { steps.push({ name, ok: ok2, detail: detail || '' }); return ok2; };
    const hostname = String(body.hostname || '').trim().toLowerCase();
    const service = String(body.service || 'http://127.0.0.1:8080').trim();
    const name = String(body.name || '').trim() || `panel-${Math.random().toString(16).slice(2, 8)}`;
    const dry = !!body.dry;
    if (!/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(hostname) || hostname.indexOf('.') < 1) {
      return sendJson(res, 400, { ok: false, error: '公共主机名要写完整域名，例如 dsh2.example.com', steps });
    }
    if (!/^(https?|ssh|tcp|rdp):\/\/[^\s]+$/.test(service)) return sendJson(res, 400, { ok: false, error: '上游要带协议，例如 http://127.0.0.1:8080', steps });
    if (!dry && !cf.accountId) return sendJson(res, 400, { ok: false, error: '还没填 Account ID（设置 → Cloudflare API）', steps });
    if (!dry && !cf.token) return sendJson(res, 400, { ok: false, error: '还没填 API Token（设置 → Cloudflare API）', steps });
    if (dry) {
      return sendJson(res, 200, {
        ok: true, dry: true, name, hostname, service,
        plan: [
          { step: 1, api: `POST /accounts/${cf.accountId || '<账户>'}/cfd_tunnel`, note: `建隧道「${name}」（config_src=cloudflare）` },
          { step: 2, api: `GET /accounts/${cf.accountId || '<账户>'}/cfd_tunnel/<id>/token`, note: '拿隧道 token（写进本机出口）' },
          { step: 3, api: `PUT /accounts/${cf.accountId || '<账户>'}/cfd_tunnel/<id>/configurations`, note: `ingress: ${hostname} → ${service}，末尾留 http_status:404` },
          { step: 4, api: `POST /zones/${cf.zoneId || '<域名>'}/dns_records`, note: `CNAME ${hostname} → <id>.cfargotunnel.com（proxied）` },
          { step: 5, api: '(local)', note: body.addLocal ? '把这套写进本机出口并启动 cloudflared' : '只建云端，不动本机' },
        ],
      });
    }
    try {
      const tun = await cfApi(`/accounts/${cf.accountId}/cfd_tunnel`, { method: 'POST', body: { name, config_src: 'cloudflare' } });
      step('1. 建隧道', true, `${name} · ${tun.id}`);
      let token = '';
      try { token = await cfApi(`/accounts/${cf.accountId}/cfd_tunnel/${tun.id}/token`); step('2. 取 token', true, token.slice(0, 12) + '…'); } catch (e) { step('2. 取 token', false, e.message); }
      let ingressOk = false;
      try {
        const cur = await cfApi(`/accounts/${cf.accountId}/cfd_tunnel/${tun.id}/configurations`).catch(() => ({ config: {} }));
        const curIngress = (cur && cur.config && Array.isArray(cur.config.ingress)) ? cur.config.ingress.slice() : [];
        const rest = curIngress.filter((x) => x && x.hostname && !/cfargotunnel|http_status/.test(String(x.service)));
        const tail = curIngress.filter((x) => x && !x.hostname);
        const next = rest.concat([{ hostname, service }], tail.length ? tail : [{ service: 'http_status:404' }]);
        await cfApi(`/accounts/${cf.accountId}/cfd_tunnel/${tun.id}/configurations`, { method: 'PUT', body: { config: { ingress: next } } });
        ingressOk = true;
        step('3. 写公共主机名', true, `${hostname} → ${service}（共 ${next.length} 条 ingress）`);
      } catch (e) { step('3. 写公共主机名', false, e.message); }
      let dnsId = null;
      if (cf.zoneId) {
        try {
          const dns = await cfApi(`/zones/${cf.zoneId}/dns_records`, { method: 'POST', body: { type: 'CNAME', name: hostname, content: `${tun.id}.cfargotunnel.com`, proxied: true, comment: 'created by cf-tunnel-panel' } });
          dnsId = dns.id; step('4. 建 CNAME', true, hostname);
        } catch (e) { step('4. 建 CNAME', false, e.message); }
      } else {
        step('4. 建 CNAME', false, '没填 zoneId，CNAME 需要你在 Cloudflare 后台手建');
      }
      let localId = null;
      if (body.addLocal !== false && token) {
        const t = applyTunnelFields(newTunnel(), { name, mode: 'named', token, publicHostname: hostname, origin: service.startsWith('http') ? 'http://127.0.0.1:8080' : 'http://127.0.0.1:8080' });
        state.tunnels.push(t);
        saveState('cf-tunnel-quick');
        if (t.enabled) startTunnel(t.id);
        localId = t.id;
        step('5. 加本机出口', true, `${name}（已启动）`);
      } else {
        step('5. 加本机出口', true, '跳过（只建云端）');
      }
      const url = `https://${hostname}`;
      let publicStatus = null;
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        try {
          const rr = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(6000) });
          publicStatus = rr.status;
          if (rr.status < 500) break;
        } catch (e) {
          // 本机没有 v6 出口时 fetch 会假失败，再兜一次 IPv4（见 core/httpv4.js）
          try {
            const v4 = await getV4(url, { timeout: 6000 });
            publicStatus = v4.status;
            if (v4.status < 500) break;
          } catch (e2) { publicStatus = 'x'; }
        }
      }
      step('6. 公网自测', publicStatus && publicStatus !== 'x', publicStatus ? `${url} → ${publicStatus}` : `${url} 暂时连不上（DNS 可能还要 1~2 分钟）`);
      auditRecord({ actor: authOf(req).who, ip: clientIpOf(req), method: 'POST', path: p, status: 200, action: '一键新建出口', target: `${name} → ${hostname}` });
      return sendJson(res, 200, { ok: ingressOk && !!localId, name, tunnelId: tun.id, hostname, service, dnsId, localId, steps, url, publicStatus });
    } catch (e) {
      step('失败', false, e.message);
      return sendJson(res, 400, { ok: false, error: e.message, steps });
    }
  }
  const cdm = p.match(/^\/api\/cf\/tunnels\/([\w-]+)\/delete$/);

  // 清 Cloudflare 边缘缓存：不传 urls = 清空整个域名
  if (p === '/api/cf/cache/purge' && req.method === 'POST') {
    let body = {};
    try { body = await readBody(req); } catch { body = {}; }
    try {
      const zone = (state.settings.cf || {}).zoneId;
      if (!zone) throw new Error('还没填 Zone ID（设置 → Cloudflare API）');
      const urls = Array.isArray(body.urls) ? body.urls.filter((u) => /^https?:\/\//.test(String(u))).slice(0, 30) : [];
      const payload = urls.length ? { files: urls } : { purge_everything: true };
      const r = await cfApi(`/zones/${zone}/purge_cache`, { method: 'POST', body: payload });
      auditRecord({ actor: authOf(req).who, ip: clientIpOf(req), method: 'POST', path: p, status: 200, action: '清理 Cloudflare 缓存', target: urls.length ? `${urls.length} 个 URL` : '整个域名' });
      log(urls.length ? `已清理 ${urls.length} 个 URL 的边缘缓存` : '已清空整个域名的边缘缓存', 'panel');
      return sendJson(res, 200, { ok: true, purged: urls.length ? urls.length : 'all', result: (r && r.result) || null });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  // 读 / 建「缓存静态资源」这条 Cache Rule（/assets/* 边缘缓存 1 天，其余不缓存）
  if (p === '/api/cf/cache/rule' && req.method === 'GET') {
    try {
      const zone = (state.settings.cf || {}).zoneId;
      if (!zone) throw new Error('还没填 Zone ID（设置 → Cloudflare API）');
      const r = await cfApi(`/zones/${zone}/rulesets/phases/http_request_cache_settings/entrypoint`);
      const rules = (((r && r.rules) || [])).map((x) => ({ id: x.id, description: x.description, enabled: x.enabled, expression: x.expression }));
      return sendJson(res, 200, { ok: true, rules });
    } catch (e) {
      return sendJson(res, 200, { ok: false, rules: [], error: e.message });
    }
  }
  if (p === '/api/cf/cache/rule' && req.method === 'POST') {
    let body = {};
    try { body = await readBody(req); } catch { body = {}; }
    try {
      const zone = (state.settings.cf || {}).zoneId;
      if (!zone) throw new Error('还没填 Zone ID（设置 → Cloudflare API）');
      const desc = 'cf-tunnel-panel: cache /assets/* at the edge';
      let cur = null;
      try { const g = await cfApi(`/zones/${zone}/rulesets/phases/http_request_cache_settings/entrypoint`); cur = g || null; } catch { cur = null; }
      const rules = ((cur && cur.rules) || []).filter((x) => x.description !== desc);
      if (body.enable !== false) {
        rules.push({
          description: desc,
          expression: '(starts_with(http.request.uri.path, "/assets/"))',
          action: 'set_cache_settings',
          action_parameters: { cache: true, edge_ttl: { mode: 'override_origin', default: 86400 }, browser_ttl: { mode: 'respect_origin' } },
          enabled: true,
        });
      }
      const r = cur
        ? await cfApi(`/zones/${zone}/rulesets/${cur.id}`, { method: 'PUT', body: { rules } })
        : await cfApi(`/zones/${zone}/rulesets/phases/http_request_cache_settings/entrypoint`, { method: 'PUT', body: { rules } });
      auditRecord({ actor: authOf(req).who, ip: clientIpOf(req), method: 'POST', path: p, status: 200, action: body.enable === false ? '关闭静态资源缓存规则' : '开启静态资源缓存规则', target: zone });
      log(body.enable === false ? '已关闭静态资源缓存规则' : '已开启静态资源缓存规则（/assets/* 边缘 1 天）', 'panel');
      return sendJson(res, 200, { ok: true, rules: ((r && r.rules) || []).length });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message + '（这个操作需要 Token 带 Zone → Cache Rules → Edit 权限，也可以在 Cloudflare 后台手动建）' });
    }
  }

  // 缓存预热：按当前代码指纹把关键资源在边缘拉一遍（清缓存后立刻有热数据）
  if (p === '/api/cf/cache/warm' && req.method === 'POST') {
    let body = {};
    try { body = await readBody(req); } catch { body = {}; }
    try {
      const named = publicTunnels().find((t) => t.mode === 'named' && t.publicHostname);
      const host = String(body.host || (named && named.publicHostname) || '').trim();
      if (!host) throw new Error('没有可用的公网域名：先在「隧道出口」里配一条命名隧道，或在请求里带 host');
      const base = /^https?:\/\//i.test(host) ? host.replace(/\/+$/, '') : `https://${host}`;
      const v = (() => { try { return (ident.buildInfo().code || 'dev').slice(0, 8); } catch { return 'dev'; } })();
      const def = ['/login', `/assets/app.css?v=${v}`, `/assets/app.js?v=${v}`, '/badge.svg'];
      const paths = (Array.isArray(body.paths) && body.paths.length ? body.paths : def).slice(0, 12)
        .map((x) => (String(x).startsWith('/') ? String(x) : '/' + String(x)));
      const out = [];
      for (const path0 of paths) {
        const t0 = Date.now();
        try {
          const r = await fetch(base + path0, { method: 'GET', headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(10000) });
          await r.arrayBuffer();
          out.push({
            path: path0, status: r.status, ms: Date.now() - t0,
            cache: r.headers.get('cf-cache-status') || '', age: r.headers.get('age') || '',
            colo: (() => { const c = r.headers.get('cf-ray') || ''; const m = /-([A-Z]{3})$/i.exec(c); return m ? m[1].toUpperCase() : ''; })(),
          });
        } catch (e) {
          const coloOf = (c) => { const mm = /-([A-Z]{3})$/i.exec(String(c || '')); return mm ? mm[1].toUpperCase() : ''; };
          try {
            // 同上：IPv4 兜底，别让「本机没 v6 出口」被误判成缓存不通
            const v4 = await getV4(base + path0, { timeout: 10000, headers: { 'Cache-Control': 'no-cache' } });
            out.push({
              path: path0, status: v4.status, ms: Date.now() - t0,
              cache: v4.headers['cf-cache-status'] || '', age: v4.headers['age'] || '',
              colo: coloOf(v4.headers['cf-ray']),
            });
          } catch (e2) {
            out.push({ path: path0, status: 0, ms: Date.now() - t0, error: e.message });
          }
        }
      }
      const hit = out.filter((x) => x.cache === 'HIT').length;
      state.warm = { code: v, at: Date.now(), host: base, paths: out.length, hit };
      saveState('cache-warm');
      auditRecord({ actor: authOf(req).who, ip: clientIpOf(req), method: 'POST', path: p, status: 200, action: '预热边缘缓存', target: `${host} · ${out.length} 个路径` });
      log(`缓存预热：${host} → ${out.length} 个路径，HIT ${hit} 个`, 'panel');
      return sendJson(res, 200, { ok: true, host: base, version: v, hit, total: out.length, results: out });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (p === '/api/cf/verify' && req.method === 'GET') {
    try {
      const cf = state.settings.cf || {};
      if (!cf.token) throw new Error('还没填 Cloudflare API Token（设置卡「Cloudflare API」里填）');
      const out = { ok: true, token: '', accounts: [], zones: [] };
      let verifyErr = '';
      try { await cfApi('/user/tokens/verify'); out.token = '有效'; }
      catch (e) { verifyErr = e.message; }
      try { out.accounts = (await cfApi('/accounts?per_page=50') || []).map((a) => ({ id: a.id, name: a.name })); } catch {}
      try { out.zones = (await cfApi('/zones?per_page=50') || []).map((z) => ({ id: z.id, name: z.name, status: z.status })); } catch {}
      if (!out.token) {
        out.token = (out.accounts.length || out.zones.length)
          ? '有效（这个 token 不能调 /user/tokens/verify，但账号和域名都读到了，够用）'
          : '无效：' + verifyErr;
      }
      if (!out.accounts.length && !out.zones.length) out.ok = false;
      out.suggest = {
        accountId: (cf.accountId || (out.accounts[0] && out.accounts[0].id) || ''),
        zoneId: (cf.zoneId || (out.zones[0] && out.zones[0].id) || ''),
      };
      return sendJson(res, 200, out);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }
  {
    const m = p.match(/^\/api\/cf\/tunnels\/([\w-]+)$/);
    if (m && req.method === 'GET') {
      try {
        const cf = state.settings.cf || {};
        if (!cf.accountId) throw new Error('还没填 Account ID');
        const t = await cfApi(`/accounts/${cf.accountId}/cfd_tunnel/${m[1]}`);
        return sendJson(res, 200, {
          ok: true,
          tunnel: {
            id: t.id,
            name: t.name,
            status: t.status,
            createdAt: t.created_at,
            connections: (t.connections || []).map((c) => ({ colo: c.colo_name, id: c.id, client: c.client_version, opened: c.opened_at })),
          },
        });
      } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    }
    const mt = p.match(/^\/api\/cf\/tunnels\/([\w-]+)\/token$/);
    if (mt && req.method === 'POST') {
      try {
        const cf = state.settings.cf || {};
        if (!cf.accountId) throw new Error('还没填 Account ID');
        const token = await cfApi(`/accounts/${cf.accountId}/cfd_tunnel/${mt[1]}/token`);
        return sendJson(res, 200, { ok: true, token });
      } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    }
  }
  if (p === '/api/cf/dns' && req.method === 'GET') {
    try {
      const cf = state.settings.cf || {};
      if (!cf.zoneId) throw new Error('还没填 Zone ID（设置卡里点「验证 token」可以自动带出来）');
      const name = url.searchParams.get('name') || '';
      const q = `/zones/${cf.zoneId}/dns_records?per_page=100` + (name ? `&name=${encodeURIComponent(name)}` : '');
      const list = await cfApi(q);
      return sendJson(res, 200, { ok: true, records: (list || []).map((r) => ({ id: r.id, type: r.type, name: r.name, content: r.content, proxied: r.proxied, ttl: r.ttl })) });
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (p === '/api/cf/dns' && req.method === 'POST') {
    try {
      const cf = state.settings.cf || {};
      if (!cf.zoneId) throw new Error('还没填 Zone ID');
      const body = await readBody(req);
      const type = String(body.type || 'CNAME').toUpperCase();
      const name = String(body.name || '').trim();
      const content = String(body.content || '').trim();
      if (!/^[A-Z]{1,6}$/.test(type)) throw new Error('记录类型不合法');
      if (!name) throw new Error('要填主机名（例如 panel.example.com）');
      if (!content) throw new Error('要填目标（隧道就是 <隧道ID>.cfargotunnel.com）');
      const rec = await cfApi(`/zones/${cf.zoneId}/dns_records`, {
        method: 'POST',
        body: { type, name, content, proxied: body.proxied !== false, comment: 'created by cf-tunnel-panel' },
      });
      log(`已创建 DNS 记录 ${type} ${name} → ${content}`, 'panel');
      return sendJson(res, 200, { ok: true, record: { id: rec.id, type: rec.type, name: rec.name, content: rec.content } });
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  {
    const md = p.match(/^\/api\/cf\/dns\/([\w-]+)\/delete$/);
    if (md && req.method === 'POST') {
      try {
        const cf = state.settings.cf || {};
        if (!cf.zoneId) throw new Error('还没填 Zone ID');
        await cfApi(`/zones/${cf.zoneId}/dns_records/${md[1]}`, { method: 'DELETE' });
        log(`已删除 DNS 记录 ${md[1]}`, 'panel');
        return sendJson(res, 200, { ok: true });
      } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    }
  }

  if (cdm && req.method === 'POST') {
    try {
      const cf = state.settings.cf || {};
      if (!cf.accountId) throw new Error('还没填 Account ID');
      await cfApi(`/accounts/${cf.accountId}/cfd_tunnel/${cdm[1]}`, { method: 'DELETE' });
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }
  return false;
}

module.exports = { handle };
