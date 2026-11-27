'use strict';
/**
 * 域名体检（GET /api/diag?host=&path=&public=1）
 *
 * 把「这个域名/路径为什么不工作」串成一条链路，逐段给结论：
 *   ① 规则命中 → ② 隧道出口 → ③ 经本机 Caddy 实测 → ④ 上游服务 → ⑤ 公网经 Cloudflare → ⑥ 拦截策略
 * 断在哪一段就说哪一段，别让人去别处翻。
 */
const http = require('http');
const {
  state,
  log,
  sendJson,
  simulateMatch,
  probeUpstream,
} = require('./_deps');
const { getV4 } = require('../core/httpv4');

const STEP_TIMEOUT = 6000;
const PUBLIC_TIMEOUT = 8000;

function normHost(raw) {
  let h = String(raw || '').trim().toLowerCase();
  h = h.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  return h;
}

function normPath(raw) {
  let p = String(raw || '').trim();
  if (!p) return '/';
  try {
    if (/^https?:\/\//i.test(p)) p = new URL(p).pathname || '/';
  } catch (e) { /* 保持原样 */ }
  if (p[0] !== '/') p = '/' + p;
  return p;
}

function tunnelList() {
  const t = state && state.tunnels;
  if (Array.isArray(t)) return t.map((x, i) => Object.assign({ id: (x && x.id) || String(i) }, x));
  if (t && typeof t === 'object') return Object.keys(t).map((k) => Object.assign({ id: k }, t[k]));
  return [];
}

function hostOfUrl(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; }
}

function headerOf(headers, name) {
  if (!headers) return '';
  const want = String(name).toLowerCase();
  if (typeof headers.get === 'function') return String(headers.get(want) || '');
  for (const k of Object.keys(headers)) {
    if (String(k).toLowerCase() === want) {
      const v = headers[k];
      return String(Array.isArray(v) ? v[0] : (v || ''));
    }
  }
  return '';
}

/** 用 http.request 打本机 Caddy，可以自定义 Host 头（undici 的 fetch 会强制用 URL 主机名）。 */
function caddyGet(host, pathname) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const rq = http.request({
      host: '127.0.0.1',
      port: 8080,
      path: pathname,
      method: 'GET',
      headers: { Host: host, 'User-Agent': 'cf-tunnel-panel-diag', 'x-cfp-test': '1' },
      timeout: STEP_TIMEOUT,
    }, (resp) => {
      resp.resume();
      resolve({ status: resp.statusCode || 0, headers: resp.headers, ms: Date.now() - t0 });
    });
    rq.on('timeout', () => rq.destroy(new Error('超时 ' + STEP_TIMEOUT + 'ms')));
    rq.on('error', (e) => resolve({ error: e }));
    rq.end();
  });
}

async function runDiag(host, pathname, wantPublic) {
  const steps = [];
  const add = (id, name, status, detail, ms) => {
    steps.push({ id, name, status, detail, ms: ms == null ? null : Math.round(ms) });
  };

  // ① 规则命中
  let hit = null;
  try {
    hit = simulateMatch(pathname, host, 'GET');
  } catch (e) {
    add('rule', '规则命中', 'warn', '模拟匹配出错：' + e.message);
  }
  const rule = hit && hit.matched && hit.rule ? hit.rule : null;
  if (!steps.length) {
    if (rule) {
      const bits = [`第 ${hit.index}/${hit.total} 条`, rule.name || rule.id, '→ ' + (rule.upstream || '（无上游）')];
      if (rule.strip) bits.push('条带前缀');
      if (rule.matchMethod) bits.push('只接 ' + rule.matchMethod);
      add('rule', '规则命中', 'ok', bits.join(' · '));
    } else if (hit && hit.needHost) {
      add('rule', '规则命中', 'warn', '这条规则限定了域名，请填写要体检的域名（' + (hit.hosts || []).join(' / ') + '）');
    } else {
      add('rule', '规则命中', 'fail', (hit && hit.note) || '没有规则匹配这个域名/路径 —— 请求会落到 404 或兜底规则');
    }
  }

  // ② 隧道出口
  const tunnels = tunnelList();
  const tun = tunnels.find((t) => hostOfUrl(t.publicUrl) === host) || null;
  const scope = (hit && hit.scope) || '';
  if (tun) {
    const st = tun.status || (tun.running ? 'running' : 'stopped');
    const okTun = st === 'running';
    add('tunnel', '隧道出口', okTun ? 'ok' : 'fail',
      `${tun.name || tun.id}：${st}${tun.publicUrl ? ' · ' + tun.publicUrl : ''}${tun.lastError ? ' · ' + tun.lastError : ''}`);
  } else if (scope && scope !== '全局') {
    add('tunnel', '隧道出口', 'warn', scope + '（没找到对应运行时的公网域名，按全局规则处理）');
  } else {
    add('tunnel', '隧道出口', 'ok', '走全局规则，不依赖命名隧道');
  }

  // ③ 经本机 Caddy 实测
  const r3 = await caddyGet(host, pathname).catch((e) => ({ error: e }));
  if (r3 && r3.error) {
    add('caddy', '经本机 Caddy', 'fail', '请求失败：' + r3.error.message);
  } else {
    const st = r3.status;
    const loc = (r3.headers && r3.headers.location) || '';
    let level = 'ok';
    if (st >= 500) level = 'fail';
    else if (st === 404) level = 'warn';
    else if (st === 401 || st === 403) level = 'warn';
    const notes = [];
    if (st === 401) notes.push('要账号密码（basicAuth）');
    if (st === 403) notes.push('被拒绝（黑名单 / 规则限制）');
    if (st === 404) notes.push('Caddy 里没有这条路径');
    if (st >= 500) notes.push('Caddy 连不上上游');
    add('caddy', '经本机 Caddy', level, `HTTP ${st}${loc ? ' → ' + loc : ''}${notes.length ? '（' + notes.join('；') + '）' : ''}`,
      r3.ms);
  }

  // ④ 上游服务
  const upstream = (rule && rule.upstream) || '';
  if (!upstream) {
    add('upstream', '上游服务', 'skip', rule ? '这条规则没配上游' : '没有命中规则，跳上游探测');
  } else {
    const up = await probeUpstream(upstream).catch((e) => ({ ok: false, error: e.message }));
    const d = up && up.ok
      ? `TCP ${up.tcpMs || 0}ms · HTTP ${up.status || '-'} · 总 ${up.totalMs || 0}ms`
      : `上游不可达：${(up && (up.error || up.note)) || '未知原因'}`;
    add('upstream', '上游服务', (up && up.ok) ? 'ok' : 'fail', `${upstream} · ${d}`);
    if (rule && rule.backupUpstream) {
      const bu = await probeUpstream(rule.backupUpstream).catch((e) => ({ ok: false, error: e.message }));
      if (bu && bu.ok) steps.push({ id: 'backup', name: '备用上游', status: 'ok', detail: `${rule.backupUpstream} · 可用`, ms: bu.totalMs || null });
    }
  }

  // ⑤ 公网经 Cloudflare
  if (!wantPublic) {
    add('public', '公网（经 Cloudflare）', 'skip', '这次没勾「从公网实测」');
  } else {
    const t0 = Date.now();
    const r = await getV4(`https://${host}${pathname}`, {
      timeout: PUBLIC_TIMEOUT,
      headers: { 'User-Agent': 'cf-tunnel-panel-diag' },
      maxBytes: 65536,
    }).catch((e) => ({ error: e }));
    const ms = Date.now() - t0;
    if (r.error) {
      add('public', '公网（经 Cloudflare）', 'fail', '请求失败：' + r.error.message);
    } else {
      const ray = headerOf(r.headers, 'cf-ray');
      const colo = ray && ray.indexOf('-') > -1 ? ray.split('-').pop() : '';
      add('public', '公网（经 Cloudflare）', r.status < 500 ? 'ok' : 'fail',
        `HTTP ${r.status}${colo ? ' · colo ' + colo : ''}${ray ? ' · ' + ray : ''} · IP ${r.ip || '-'}`, ms);
    }
  }

  // ⑥ 拦截策略
  const pol = [];
  const set = (state && state.settings) || {};
  const maint = set.maintenance;
  if (maint && maint.on) pol.push('维护模式开着（全站 503）');
  if (rule && rule.basicAuth) pol.push('这条规则开了 basicAuth（会先要账号密码）');
  const deny = (state && state.security && state.security.ipDeny) || '';
  if (String(deny).trim()) {
    const n = String(deny).split(/[\s,]+/).filter(Boolean).length;
    pol.push('IP 黑名单非空：' + n + ' 条');
  }
  add('policy', '拦截策略', pol.length ? 'warn' : 'ok',
    pol.length ? pol.join('；') : '维护模式关、无 IP 黑名单、这条规则没开 basicAuth');

  const first = steps.find((s) => s.status === 'fail') || steps.find((s) => s.status === 'warn') || null;
  const verdict = first
    ? { level: first.status, at: first.name, text: first.detail }
    : { level: 'ok', at: '全链路', text: '每一段都正常' };

  return { host, path: pathname, steps, verdict };
}

async function handle(p, req, res, url) {
  if (p === '/api/diag' && req.method === 'GET') {
    const q = Object.fromEntries(url && url.searchParams ? url.searchParams.entries() : []);
    const host = normHost(q.host);
    const pathname = normPath(q.path);
    if (!host) {
      return sendJson(res, 400, { ok: false, error: '给我一个域名，比如 demo.jianghugs.shop' });
    }
    const wantPublic = String(q.public || '') === '1' || String(q.public || '') === 'true';
    try {
      const out = await runDiag(host, pathname, wantPublic);
      log(`域名体检 ${host}${pathname} → ${out.verdict.level} @ ${out.verdict.at}`, 'panel');
      return sendJson(res, 200, Object.assign({ ok: true }, out));
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e.message });
    }
  }
  return false;
}

module.exports = { handle, runDiag };
