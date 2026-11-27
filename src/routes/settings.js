'use strict';
/**
 * settings 相关路由（C8 第三步从 src/server.js 剪出，块内逻辑逐行未改）。
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
    if (full && (authOf(req).role || 'admin') !== 'admin') {
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
    auditRecord({ actor: authOf(req).who, ip: clientIpOf(req), method: 'POST', path: p, status: 200, action: '保存配置快照', target: file });
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
      auditRecord({ actor: authOf(req).who, ip: clientIpOf(req), method: 'POST', path: p, status: 200, action: '按声明应用配置', target: `+${d.added.length} -${d.removed.length} ~${d.changed.length}` });
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

  return false;
}

module.exports = { handle };
