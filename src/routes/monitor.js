'use strict';
/**
 * monitor 相关路由（C8 拆分自 src/server.js，块内逻辑逐行未改）。
 * 公共依赖统一在 ./_deps.js（十份样板合并后的唯一一份）。
 */
const {
  path,
  auditRecord,
  PORT,
  readBody,
  sendJson,
  saveState,
  state,
  clientIpOf,
  history,
  _selfcheck,
  http,
  crypto,
  authOf,
} = require('./_deps');

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
