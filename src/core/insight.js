'use strict';
/**
 * 可观测：访问统计、小时聚合、模拟匹配、遮蔽分析、上游健康、指标与徽章
 * 从 src/server.js 按职责拆出（v0.9.0），仅做搬运，行为不变。
 */

const http=require('http'); const https=require('https');
 const net=require('net'); const fs=require('fs');
const path=require('path'); const os=require('os');
const zlib=require('zlib');

const { ACCESS_LOG_FILE, BACKUP_DIR, CADDY_OWN_LOG_FILE, DATA_DIR, STATE_FILE, VERSION, otherLogPathForCaddy } = require('./paths');
const _state = require('./state');
const state = _state.stateProxy;
const { tunnelById, tunnelRt } = require('./registry');
const { caddy, tunnelHostOf } = require('./caddy');
const history = require('./history');
const ident = require('./ident');
const lease = require('./lease');
// 小时粒度的图不需要秒级新鲜度：日志里 99% 是健康检查噪音，解析一次 600ms 左右，
// 前端 5 秒轮询一次会把 Jetson 的核占住，所以结果缓存 30 秒。
const TRAFFIC_TTL = 30 * 1000;
const _trafficMemo = new Map();
function trafficByHour(hours = 12) { return memoTraffic(`hour:${hours}`, () => _trafficByHour(hours)); }
function trafficByPath(hours = 12, top = 4) { return memoTraffic(`path:${hours}:${top}`, () => _trafficByPath(hours, top)); }


function memoTraffic(key, fn) {
  const hit = _trafficMemo.get(key);
  if (hit && Date.now() - hit.at < TRAFFIC_TTL) return hit.val;
  const val = fn();
  _trafficMemo.set(key, { at: Date.now(), val });
  return val;
}

/**
 * 读访问日志文本：当前文件尾部 + 最近的若干个轮转文件（.gz）。
 * 只读尾部 2MB 是有意的 —— 这些接口 5 秒轮询一次，不能把 10MB 全解析一遍；
 * 但轮转之后当前文件里已经没有更早的行，跨过轮转点时趋势图会缺口，所以补上 .gz。
 */
function readLogText(since, maxBytes = 2 * 1024 * 1024, maxGz = 2) {
  const parts = [];
  let any = false;
  const tailOf = (file, limit) => {
    const st = fs.statSync(file);
    const from = Math.max(0, st.size - limit);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  };
  try { parts.push(tailOf(ACCESS_LOG_FILE, maxBytes)); any = true; } catch { /* 还没产生日志 */ }
  try {
    const dir = path.dirname(ACCESS_LOG_FILE);
    const base = path.basename(ACCESS_LOG_FILE, '.log');          // access
    const gz = fs.readdirSync(dir)
      .filter((f) => f.startsWith(`${base}-`) && f.endsWith('.log.gz'))
      .sort()                                                     // 文件名里带时间戳，字典序即时间序
      .slice(-Math.max(1, maxGz))
      // 轮转时间早于窗口起点的文件里不可能有窗口内的行，不必解压
      .filter((f) => { try { return fs.statSync(path.join(dir, f)).mtimeMs >= since; } catch { return false; } });
    for (const f of gz) {
      let buf;
      try { buf = zlib.gunzipSync(fs.readFileSync(path.join(dir, f))); } catch { continue; }  // 写了一半的轮转文件
      if (buf.length > 4 * 1024 * 1024) buf = buf.subarray(buf.length - 4 * 1024 * 1024);
      parts.unshift(buf.toString('utf8'));                        // 更早的文件放前面，保持时间顺序
      any = true;
    }
  } catch { /* 目录读不到就算了 */ }
  return any ? parts.join('\n') : null;
}

/**
 * 只遍历访问日志行：日志里 99% 是反向代理健康检查的失败重连（槽位停着时每秒一条），
 * 整段 split('\n') 会产生几万个字符串，这里是逐段 indexOf 扫描，只切出要的行。
 */
const ACCESS_MARK = '"logger":"http.log.access';
function forEachAccess(text, fn) {
  let i = text.indexOf(ACCESS_MARK);
  while (i !== -1) {
    const s = text.lastIndexOf('\n', i) + 1;
    let e = text.indexOf('\n', i);
    if (e === -1) e = text.length;
    fn(text.slice(s, e));
    i = text.indexOf(ACCESS_MARK, e);
  }
}

/**
 * 按「归属规则」聚合的流量趋势：回答「哪个服务在吃流量」。
 * 复用 access log 与 simulateMatch，所以看不到 unmatched 的具体去向时至少能看到未匹配量。
 * 返回 { available, hours, groups: [{name, total, ok, err, buckets:[{t,total,err}] }] }（按总量降序，最多 top 组）
 */
function _trafficByPath(hours = 12, top = 4) {
  const h = Math.max(1, Math.min(72, Number(hours) || 12));
  const n = Math.max(1, Math.min(8, Number(top) || 4));
  const now = Date.now();
  const nowHour = new Date(now).setMinutes(0, 0, 0);          // 同上：含当前这一小时
  const keys = [];
  for (let i = h - 1; i >= 0; i -= 1) keys.push(nowHour - i * 3600 * 1000);
  const start = nowHour - (h - 1) * 3600 * 1000;
  const groups = new Map();
  const get = (name) => {
    if (!groups.has(name)) {
      const buckets = new Map(keys.map((k) => [k, { t: k, total: 0, err: 0 }]));
      groups.set(name, { name, total: 0, ok: 0, err: 0, buckets });
    }
    return groups.get(name);
  };
  const text = readLogText(start);
  if (text === null) return { available: false, hours: h, groups: [] };
  forEachAccess(text, (line) => {
    let o;
    try { o = JSON.parse(line); } catch { return; }
    const ts = typeof o.ts === 'number' ? o.ts * 1000 : Date.parse(String(o.ts || ''));
    if (!Number.isFinite(ts) || ts < start) return;
    const key = new Date(ts).setMinutes(0, 0, 0);
    const code = Number(o.status || 0);
    // 原始 Caddy 行里，host/uri/method 在 request 子对象里（readAccess 才把它们拍平）
    const req = o.request || {};
    const uri = o.uri || req.uri || '/';
    const host = o.host || req.host || '';
    const method = o.method || req.method || 'GET';
    let name = '(未匹配规则)';
    let rid = '', rpath = '', rtun = '';
    try {
      const m = simulateMatch(uri, host, method);
      if (m && m.rule && m.rule.name) {
        name = m.rule.name;
        rid = m.rule.id || '';
        rpath = m.rule.path || '';
        rtun = m.rule.tunnelId || '';
      }
    } catch { /* 匹配失败就当未匹配 */ }
    const g = get(name);
    if (rid) { g.id = rid; g.path = rpath; g.tunnelId = rtun; }
    const isErr = code >= 500;
    g.total += 1;
    if (isErr) g.err += 1; else g.ok += 1;
    const b = g.buckets.get(key);
    if (b) { b.total += 1; if (isErr) b.err += 1; }
  });
  // 「未匹配」通常来自健康检查、未知路径，量还经常最大；单独统计，不占图例名额
  const all = [...groups.values()];
  const unmatched = all.find((g) => g.name === '(未匹配规则)') || { total: 0, err: 0 };
  const list = all
    .filter((g) => g.name !== '(未匹配规则)')
    .sort((a, b) => b.total - a.total)
    .slice(0, n)
    .map((g) => ({ id: g.id || '', name: g.name, path: g.path || '', tunnelId: g.tunnelId || '', total: g.total, ok: g.ok, err: g.err, buckets: keys.map((k) => g.buckets.get(k)) }));
  return { available: true, hours: h, groups: list, keys, unmatched: { total: unmatched.total, err: unmatched.err } };
}

function _trafficByHour(hours = 12) {
  const now = Date.now();
  // 桶必须从「整点」往回数：原来从 now-hours 往前推再取整，最后一个桶落在上一小时，
  // 于是当前这一小时的流量全被丢掉（total 显示 0）。用 nowHour 倒推保证含当前小时。
  const nowHour = new Date(now).setMinutes(0, 0, 0);
  const buckets = new Map();
  for (let i = hours - 1; i >= 0; i -= 1) {
    const key = nowHour - i * 3600 * 1000;
    buckets.set(key, { t: key, total: 0, ok: 0, err: 0 });
  }
  const start = nowHour - (hours - 1) * 3600 * 1000;
  const text = readLogText(start);
  if (text === null) return { available: false, hours, buckets: [] };
  forEachAccess(text, (line) => {
    let o;
    try { o = JSON.parse(line); } catch { return; }
    // Caddy 的 ts 是 Unix 秒（浮点），不是 ISO 字符串
    const ts = typeof o.ts === 'number' ? o.ts * 1000 : Date.parse(String(o.ts || ''));
    if (!Number.isFinite(ts) || ts < start) return;
    const key = new Date(ts).setMinutes(0, 0, 0);
    const b = buckets.get(key);
    if (!b) return;
    b.total += 1;
    const code = Number((o.status || 0));
    if (code >= 400) b.err += 1; else b.ok += 1;
  });
  return { available: true, hours, buckets: [...buckets.values()] };
}

/** 面板自身占用情况：状态文件、备份数、日志大小、内存。 */
function systemInfo() {
  const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
  let backups = 0;
  try { backups = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.json')).length; } catch {}
  return {
    history: history.stats(),
    panelRequests: panelReqSnapshot(),
    version: VERSION,
    node: process.version,
    uptimeSec: Math.round(process.uptime()),
    startedAt: Date.now() - Math.round(process.uptime() * 1000),
    dataDir: DATA_DIR,
    stateBytes: sizeOf(STATE_FILE),
    backupCount: backups,
    logBytes: sizeOf(ACCESS_LOG_FILE),
    caddyLogBytes: sizeOf(ACCESS_LOG_FILE),
    memMB: Math.round(process.memoryUsage().rss / 1048576),
    host: os.hostname(),
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
  };
}

function readAccess(limit = 100, opts = {}) {
  // opts.maxBytes：往回读多少字节（默认 512KB）；opts.since：只要这个毫秒时间戳之后的记录
  const MB = 1024 * 1024;
  const maxBytes = Math.min(Math.max(Number(opts.maxBytes) || 512 * 1024, 32 * 1024), 8 * MB);
  const since = Number(opts.since) || 0;
  let raw = '';
  try {
    const st = fs.statSync(ACCESS_LOG_FILE);
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(ACCESS_LOG_FILE, 'r');
    const buf = Buffer.alloc(Math.min(maxBytes, st.size - start));
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    raw = buf.toString('utf8');
  } catch {
    return { ok: true, available: false, file: ACCESS_LOG_FILE, rows: [], summary: null,
      note: '还没有访问日志（Caddy 需重启一次以启用 access log，或暂时没有流量）' };
  }
  const lines = raw.split('\n').filter((l) => l.trim().startsWith('{'));
  const rows = [];
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    // 只收 HTTP 访问日志；同一文件里还混着 admin / tls 等其它 logger 的行
    if (!String(o.logger || '').includes('http.log.access')) continue;
    const req = o.request || {};
    rows.push({
      ts: o.ts ? new Date(o.ts * 1000).toISOString() : '',
      host: req.host || '',
      method: req.method || '',
      uri: req.uri || '',
      status: Number(o.status) || 0,
      durMs: o.duration ? Math.round(o.duration * 1000) : 0,
      size: Number(o.size) || 0,
      ip: req.remote_ip || '',
      ua: (req.headers && req.headers['User-Agent'] && req.headers['User-Agent'][0]) || '',
      at: o.ts ? Math.round(o.ts * 1000) : 0,
    });
  }
  // 按时间窗过滤（opts.since），再取最后 limit 条；at 字段之前缺失，导致 monitor 的
  // 「最近 5 分钟」判断永远为空（5xx 尖峰告警其实从来没触发过）
  const pool = since ? rows.filter((r) => (r.at || 0) >= since) : rows;
  const tail = pool.slice(-limit).reverse();
  const byStatus = {};
  const byPath = {};
  const byHost = {};
  for (const r of tail) {
    const c = r.status >= 500 ? '5xx' : r.status >= 400 ? '4xx' : r.status >= 300 ? '3xx' : r.status >= 200 ? '2xx' : '其他';
    byStatus[c] = (byStatus[c] || 0) + 1;
    const key = (r.uri || '/').split('?')[0];
    byPath[key] = (byPath[key] || 0) + 1;
    byHost[r.host || '(无 Host)'] = (byHost[r.host || '(无 Host)'] || 0) + 1;
  }
  const top = (obj, n = 6) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ k, v }));
  return {
    ok: true, available: true, file: ACCESS_LOG_FILE, rows: tail,
    summary: { total: tail.length, byStatus, topPaths: top(byPath), topHosts: top(byHost) },
  };
}

// ---------------------------------------------------------------- 模拟匹配
/** 用面板自己的规则表模拟一次「这个路径会命中哪条规则」，不经过 Caddy。 */
function simulateMatch(pathname, host, method) {
  let pn = String(pathname || '/').trim();
  if (!pn.startsWith('/')) pn = '/' + pn;
  const h = String(host || '').trim().toLowerCase();
  const m = String(method || 'GET').trim().toUpperCase();
  const list = state.routes.map((r, idx) => ({ r, idx })).filter((x) => x.r.enabled && x.r.upstream);
  for (let i = 0; i < list.length; i++) {
    const r = list[i].r;
    let hosts = String(r.host || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!hosts.length && r.tunnelId) {
      const fh = tunnelHostOf(r.tunnelId);
      if (fh) hosts = [fh.toLowerCase()];
      // 出口当前没有公网域名（没起/被删）时，Caddy 里这条规则根本不会下发 —— 模拟也要跳过，
      // 否则会把"专属规则"当成"任意域名都匹配"，和真实行为不符。
      else continue;
    }
    if (hosts.length) {
      if (!h) return { ok: true, matched: false, needHost: true, hosts, note: '这条规则限定了域名，请填写要模拟的域名' };
      const okHost = hosts.some((x) => (x.startsWith('*.') ? h.endsWith(x.slice(1)) : x === h));
      if (!okHost) continue;
    }
    if (r.matchMethod) {
      const ms = String(r.matchMethod).split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
      if (ms.length && !ms.includes(m)) continue;
    }
    const rp = String(r.path || '');
    const prefix = rp.endsWith('*') ? rp.slice(0, -1) : rp.replace(/\/+$/, '');
    if (prefix && !pn.startsWith(prefix)) continue;
    const t = r.tunnelId ? tunnelById(r.tunnelId) : null;
    return {
      ok: true, matched: true, index: i + 1, ofIndex: list[i].idx, total: list.length,
      rule: { id: r.id, name: r.name, path: r.path, host: r.host, upstream: r.upstream, backupUpstream: r.backupUpstream,
        strip: !!r.strip, basicAuth: !!(r.basicAuth && r.basicAuth.user), ipAllow: r.ipAllow || '',
        matchMethod: r.matchMethod || '', timeoutSec: r.timeoutSec || 0, note: r.note || '' },
      scope: t ? `出口：${t.name || t.id}` : '全局',
      note: '',
    };
  }
  return { ok: true, matched: false, index: 0, total: list.length,
    note: '没有任何规则命中 —— 会落到自定义 404（这条路径在 Caddy 里被拒绝了）' };
}

/** 每条规则用自己的路径+域名跑一遍模拟，找出被前面规则挡住的（永远不会生效的）。 */
function shadowReport() {
  const out = [];
  state.routes.forEach((r, idx) => {
    if (!r.enabled || !r.upstream) return;
    // 绑定到某个出口、而那个出口当前还没有公网域名时，这条规则压根没下发给 Caddy，
    // 它只会出现在 skipped 里，不能算「被谁拦住」（否则会误报）。
    if (r.tunnelId && !tunnelHostOf(r.tunnelId)) return;
    if (!String(r.host || '').trim() && r.tunnelId && !tunnelHostOf(r.tunnelId)) return;
    const host = String(r.host || '').split(',')[0].trim() || (r.tunnelId ? tunnelHostOf(r.tunnelId) : '') || '';
    const res = simulateMatch(r.path || '/', host, String(r.matchMethod || 'GET').split(',')[0] || 'GET');
    if (res.needHost) return;
    if (!res.matched) { out.push({ index: idx, id: r.id, name: r.name, path: r.path, reason: '没有命中任何规则' }); return; }
    if (res.ofIndex !== idx) {
      const by = state.routes[res.ofIndex] || {};
      out.push({ index: idx, id: r.id, name: r.name, path: r.path, byIndex: res.ofIndex,
        byName: by.name || by.path || '前面的规则', reason: `被「${by.name || by.path}」拦住` });
    }
  });
  return out;
}

// ---------------------------------------------------------------- 上游健康（定时轻量 TCP 探测）
function upstreamTarget(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    if (!/^https?:$/.test(u.protocol)) return null;
    return { url: u.origin + u.pathname.replace(/\/+$/, ''), host: u.hostname, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)) };
  } catch { return null; }
}

function tcpProbeOnce(host, port, timeout = 900) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.connect({ host, port });
    const fin = (ok, error) => { try { sock.destroy(); } catch {} resolve({ ok, error: error || null, ms: Date.now() - t0 }); };
    sock.setTimeout(timeout, () => fin(false, 'timeout'));
    sock.once('connect', () => fin(true));
    sock.once('error', (e) => fin(false, e.code === 'ECONNREFUSED' ? 'connection refused' : e.code || e.message));
  });
}

async function refreshUpstreamHealth() {
  const targets = new Map();
  for (const r of state.routes) {
    if (r.enabled === false) continue;
    for (const raw of [r.upstream, r.backupUpstream]) {
      const t = upstreamTarget(raw);
      if (t && !targets.has(t.url)) targets.set(t.url, t);
    }
  }
  const now = Date.now();
  for (const [url, t] of targets) {
    const res = await tcpProbeOnce(t.host, t.port);
    upstreamHealth.set(url, { url, ok: res.ok, ms: res.ms, error: res.error, at: now });
    let arr = upstreamHist.get(url);
    if (!arr) { arr = []; upstreamHist.set(url, arr); }
    arr.push({ t: now, ok: res.ok, ms: res.ms });
    const cutoff = now - 86400000;
    while (arr.length && arr[0].t < cutoff) arr.shift();
  }
  for (const url of Array.from(upstreamHealth.keys())) if (!targets.has(url)) { upstreamHealth.delete(url); upstreamHist.delete(url); }
}

/** 规则上游可能带路径前缀，匹配时按 origin+path 前缀宽松比对。 */
function healthOf(raw) {
  const t = upstreamTarget(raw);
  if (!t) return null;
  if (upstreamHealth.has(t.url)) return upstreamHealth.get(t.url);
  for (const [url, v] of upstreamHealth) if (t.url.startsWith(url)) return v;
  return null;
}

// ---------------------------------------------------------------- 运行同步
/** 恢复/导入配置后让运行时跟上：新增的启动、删掉的停掉、参数变了的重启。 */
function requestsLastMinute() {
  try {
    const st = fs.statSync(ACCESS_LOG_FILE);
    const span = Math.min(96 * 1024, st.size);
    const fd = fs.openSync(ACCESS_LOG_FILE, 'r');
    const buf = Buffer.alloc(span);
    fs.readSync(fd, buf, 0, span, Math.max(0, st.size - span));
    fs.closeSync(fd);
    const since = Date.now() - 60000;
    let n = 0;
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim().startsWith('{')) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (!String(o.logger || '').includes('http.log.access')) continue;
      const ts = typeof o.ts === 'number' ? o.ts * 1000 : Date.parse(String(o.ts || ''));
      if (Number.isFinite(ts) && ts >= since) n += 1;
    }
    return n;
  } catch { return null; }
}

function sampleHistory() {
  const running = state.tunnels.filter((t) => (tunnelRt(t.id) || {}).status === 'running').length;
  // v0.19.0：采样落盘（DATA_DIR/history/samples.jsonl），两台实例共享同一份历史，
  // 谁在当 leader 谁写；同分钟内重复写入会被 history 模块去重。
  return history.appendSample({
    t: Date.now(), running, total: state.tunnels.length,
    caddyOk: caddy.ok ? 1 : 0, req: requestsLastMinute(), inst: (() => { try { return lease.instanceId(); } catch { return null; } })(),
  });
}

const HISTORY_MAX = 240;       // 每分钟一个点，240 点 = 4 小时
const rtHistory = [];          // [{t, running, total, caddyOk, req}]
let histTick = 0;

// 最近一分钟的请求数（只读日志尾部 96KB，够一分钟用）
// ---------------------------------------------------------------- 面板自身请求计数
// Caddy 的 access.log 只覆盖「经由代理的业务流量」，面板自己的 /api 请求不在里面。
// 想回答「面板最近是不是被谁狂扫」就得自己数：这里只做内存计数（每实例一份，
// 进程重启归零），通过 /metrics 暴露，别指望它当持久审计（那是 audit.log 的活）。
const panelReq = { total: 0, since: Date.now(), byStatus: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 }, byPath: new Map() };

function countPanelReq(status, pathname) {
  panelReq.total += 1;
  const cls = status >= 500 ? '5xx' : status >= 400 ? '4xx' : status >= 300 ? '3xx' : '2xx';
  panelReq.byStatus[cls] = (panelReq.byStatus[cls] || 0) + 1;
  if (panelReq.byPath.size < 300) {
    const key = String(pathname).split('?')[0];
    panelReq.byPath.set(key, (panelReq.byPath.get(key) || 0) + 1);
  }
  return panelReq;
}

function panelReqSnapshot() {
  const top = [...panelReq.byPath.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([k, v]) => ({ path: k, count: v }));
  return { total: panelReq.total, since: panelReq.since, byStatus: { ...panelReq.byStatus }, top };
}

// Caddy 访问日志目录占用：抓取时扫目录，30 秒缓存（目录里就几个文件，代价可忽略）。
// 用途是「按天看得见增长」，替代做不到的「按天切文件」（Caddy 2.11.9 不认 roll_keep_for）。
let _caddyLogMemo = { at: 0, bytes: 0, files: 0 };
/**
 * 读 Caddy 自身日志（caddy.log：启动、admin API、证书、自动 https）。
 * 访问日志是另一个文件（access.log，见 readAccess），两者在 0.29.64 起分开写。
 */
function readCaddyOwnLog(limit = 200, opts = {}) {
  const file = CADDY_OWN_LOG_FILE;
  const maxBytes = Math.min(2 * 1024 * 1024, Math.max(64 * 1024, Number(opts.bytes) || 512 * 1024));
  let size = 0;
  try { size = fs.statSync(file).size; } catch (e) {
    return { exists: false, file, size: 0, lines: [], note: e.code === 'ENOENT' ? '还没有 caddy.log —— Caddy 大概刚启动，或者它还没写过一行' : String(e.message || e) };
  }
  let text = '';
  try {
    const from = Math.max(0, size - maxBytes);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (e) {
    return { exists: true, file, size, lines: [], note: `读取失败：${e.message || e}` };
  }
  const raw = text.split('\n');
  if (raw.length && raw[0] && !raw[0].startsWith('{')) raw.shift();   // 尾部截断可能切坏首行
  const lines = raw.filter(Boolean).slice(-limit).map((s) => {
    try {
      const o = JSON.parse(s);
      return { t: Number(o.ts || 0) * 1000 || 0, level: String(o.level || ''), logger: String(o.logger || ''), msg: String(o.msg || o.message || '') };
    } catch { return { t: 0, level: '', logger: '', msg: s }; }
  });
  return { exists: true, file, size, lines };
}

function caddyLogStats() {
  if (Date.now() - _caddyLogMemo.at < 30000) return _caddyLogMemo;
  let bytes = 0;
  let files = 0;
  try {
    const dir = path.join(DATA_DIR, 'caddy-logs');
    for (const f of fs.readdirSync(dir)) {
      try {
        const st = fs.statSync(path.join(dir, f));
        if (st.isFile()) { bytes += st.size; files += 1; }
      } catch (e) {}
    }
  } catch (e) {}
  _caddyLogMemo = { at: Date.now(), bytes, files };
  return _caddyLogMemo;
}

function metricsText() {
  const lines = [];
  const run = state.tunnels.filter((t) => tunnelRt(t.id).status === 'running').length;
  lines.push('# HELP cf_tunnel_panel_up 面板本身是否在线');
  lines.push('# TYPE cf_tunnel_panel_up gauge');
  lines.push('cf_tunnel_panel_up 1');
  lines.push('# HELP cf_tunnel_running 正在运行的隧道出口数');
  lines.push('# TYPE cf_tunnel_running gauge');
  lines.push(`cf_tunnel_running ${run}`);
  lines.push('# HELP cf_tunnel_routes 生效的代理规则数');
  lines.push('# TYPE cf_tunnel_routes gauge');
  lines.push(`cf_tunnel_routes ${caddy.routeCount || 0}`);
  lines.push('# HELP cf_caddy_ok Caddy 配置是否下发成功');
  lines.push('# TYPE cf_caddy_ok gauge');
  lines.push('cf_caddy_ok ' + (caddy.ok ? 1 : 0));
  lines.push('# HELP cf_tunnel_up 单个出口是否在线（1=在线）');
  lines.push('# TYPE cf_tunnel_up gauge');
  for (const t of state.tunnels) {
    const rt = tunnelRt(t.id);
    lines.push(`cf_tunnel_up{id="${t.id}",name="${String(t.name).replace(/"/g, '')}"} ${rt.status === 'running' ? 1 : 0}`);
  }
  // ---- 集群视角（v0.19.2）：任何一台实例被抓都能说明「谁是主、历史累计多少、面板挨了多少请求」 ----
  let role = 'leader';
  let leaderId = '';
  try { role = lease.isLeader() ? 'leader' : 'standby'; leaderId = String((lease.status().holder || {}).id || ''); } catch {}
  lines.push('# HELP cf_role 本实例在集群里的角色（1=当前角色）');
  lines.push('# TYPE cf_role gauge');
  lines.push(`cf_role{role="leader"} ${role === 'leader' ? 1 : 0}`);
  lines.push(`cf_role{role="standby"} ${role === 'standby' ? 1 : 0}`);
  lines.push('# HELP cf_leader_info 当前主实例 id（值恒为 1）');
  lines.push('# TYPE cf_leader_info gauge');
  lines.push(`cf_leader_info{id="${leaderId.replace(/"/g, '')}"} 1`);
  lines.push('# HELP cf_build_info 版本与代码指纹');
  lines.push('# TYPE cf_build_info gauge');
  try {
    const bi = ident.buildInfo();
    lines.push(`cf_build_info{version="${VERSION}",code="${bi.code || ''}",mode="${role}"} 1`);
    lines.push('# HELP cf_code_drift 运行代码与镜像代码是否不一致');
    lines.push('# TYPE cf_code_drift gauge');
    lines.push(`cf_code_drift ${bi.drift ? 1 : 0}`);
  } catch {}
  const hs = history.stats();
  lines.push('# HELP cf_history_samples 历史采样点总数（两台实例共享同一份文件）');
  lines.push('# TYPE cf_history_samples gauge');
  lines.push(`cf_history_samples ${hs.samples}`);
  lines.push('# HELP cf_notify_total 通知发送结果统计（共享，不含手动测试）');
  lines.push('# TYPE cf_notify_total counter');
  {
    const by = {};
    for (const n of history.notifyList()) {
      if (n.event === 'test') continue;   // 手动「发测试」不算运营故障，别把告警顶起来
      by[n.status || 'unknown'] = (by[n.status || 'unknown'] || 0) + 1;
    }
    for (const [k, v] of Object.entries(by)) lines.push(`cf_notify_total{status="${k}"} ${v}`);
    if (!Object.keys(by).length) lines.push('cf_notify_total{status="none"} 0');
  }
  const pr = panelReqSnapshot();
  lines.push('# HELP cf_panel_requests_total 面板自身收到的请求（不含静态资源，每实例内存计数）');
  lines.push('# TYPE cf_panel_requests_total counter');
  for (const [k, v] of Object.entries(pr.byStatus)) lines.push(`cf_panel_requests_total{status="${k}"} ${v}`);
  lines.push('# HELP cf_panel_uptime_seconds 面板进程运行时长');
  lines.push('# TYPE cf_panel_uptime_seconds gauge');
  lines.push(`cf_panel_uptime_seconds ${Math.round((Date.now() - pr.since) / 1000)}`);

  const acc = readAccess(200);
  if (acc.available) {
    lines.push('# HELP cf_tunnel_requests_total 访问日志里的请求数（按状态码分组）');
    lines.push('# TYPE cf_tunnel_requests_total counter');
    for (const [k, v] of Object.entries((acc.summary && acc.summary.byStatus) || {})) lines.push(`cf_tunnel_requests_total{status="${k}"} ${v}`);
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------- Cloudflare API
function badgeSvg(label, value, ok) {
  const color = ok ? '#16a34a' : '#dc2626';
  const lw = 8 + label.length * 6.6, vw = 12 + String(value).length * 6.6;
  const w = Math.round(lw + vw);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${label}: ${value}">
<rect width="${w}" height="20" rx="3" fill="#555"/><rect x="${lw}" width="${vw}" height="20" rx="3" fill="${color}"/>
<rect x="${lw}" width="4" height="20" fill="${color}"/><g fill="#fff" font-family="DejaVu Sans,Verdana,sans-serif" font-size="11">
<text x="6" y="14">${label}</text><text x="${lw + 6}" y="14">${value}</text></g></svg>`;
}

function diffRoutes(backupRoutes, currentRoutes) {
  const key = (r) => `${r.path || '/'}|${r.tunnelId || ''}|${r.host || ''}`;
  const bm = new Map((backupRoutes || []).map((r) => [r.id, r]));
  const cm = new Map((currentRoutes || []).map((r) => [r.id, r]));
  const skip = new Set(['id']);
  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, r] of cm) {
    const b = bm.get(id);
    if (!b) { added.push({ id, name: r.name, path: r.path, key: key(r) }); continue; }
    const fields = [];
    for (const k of new Set([...Object.keys(b), ...Object.keys(r)])) {
      if (skip.has(k)) continue;
      const a = JSON.stringify(b[k] === undefined ? null : b[k]);
      const c = JSON.stringify(r[k] === undefined ? null : r[k]);
      if (a !== c) fields.push(k);
    }
    if (fields.length) changed.push({ id, name: r.name, path: r.path, fields });
  }
  for (const [id, b] of bm) {
    if (!cm.has(id)) removed.push({ id, name: b.name, path: b.path, key: key(b) });
  }
  return { added, removed, changed };
}

// ---------------------------------------------------------------- 徽章 / metrics

const upstreamHealth = new Map(); // upstream url -> { ok, ms, error, at }
const upstreamHist = new Map(); // upstream url -> [{ t, ok, ms }]（24h 环形，60s 一个点）


/**
 * 可疑访问：401/403（认证失败、被拒）按「规则」和「来源 IP」两个维度聚合。
 * 面板挂了 /db、/term 这类服务后，公网天天有人扫，这里回答「谁在试、试的哪条、试了多少次」。
 * @returns {{available:boolean, hours:number, total:number, byRule:Array, byIp:Array, last:string, note:string}}
 */
function securityAttempts(hours = 24, limit = 3000) {
  const h = Math.max(0.1, Math.min(168, Number(hours) || 24));
  const cap = Math.max(50, Math.min(8000, Number(limit) || 3000));
  const now = Date.now();
  const start = now - h * 3600 * 1000;
  const out = { available: false, hours: h, total: 0, byRule: [], byIp: [], last: '', note: '' };
  let text = '';
  try {
    if (!fs.existsSync(ACCESS_LOG_FILE)) { out.note = '还没有访问日志（有流量后这里会自动出现）'; return out; }
    const st = fs.statSync(ACCESS_LOG_FILE);
    const size = st.size;
    const from = Math.max(0, size - 4 * 1024 * 1024);
    const fd = fs.openSync(ACCESS_LOG_FILE, 'r');
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    fs.closeSync(fd);
    text = buf.toString('utf8');
    out.available = true;
  } catch (e) {
    out.note = '日志读不出来：' + (e && e.message ? e.message : e);
    return out;
  }
  const lines = text.split('\n');
  if (lines.length && !lines[0].trim().startsWith('{')) lines.shift(); // 首行可能被截断
  const byRule = new Map();
  const byIp = new Map();
  let last = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch (_) { continue; }
    if (!String(o.logger || '').includes('http.log.access')) continue;
    const ts = typeof o.ts === 'number' ? o.ts * 1000 : Date.parse(String(o.ts || ''));
    if (!ts || ts < start) continue;
    const status = Number(o.status) || 0;
    if (status !== 401 && status !== 403) continue;
    const rq = o.request || {};
    const uri = o.uri || rq.uri || '/';
    const host = o.host || rq.host || '';
    const method = o.method || rq.method || 'GET';
    const pathOnly = String(uri).split('?')[0];
    const ip = String(o.remote_ip || rq.remote_ip || (rq.headers && (rq.headers['cf-connecting-ip'] || [])[0]) || o.client_ip || '') || 'unknown';
    const m = simulateMatch(pathOnly, host, method);
    const idx = m && m.matched ? (m.ofIndex != null ? m.ofIndex : m.index - 1) : -1;
    const rule = idx >= 0 ? state.routes[idx] : null;
    const rid = rule ? rule.id : '';
    const rname = rule ? (rule.name || rule.path || '(未命名)') : '(没命中规则)';
    out.total += 1;
    if (ts > last) last = ts;
    let a = byRule.get(rid);
    if (!a) { a = { id: rid, name: rname, path: rule ? rule.path || '/' : '', count: 0, ips: new Map() }; byRule.set(rid, a); }
    a.count += 1;
    const pa = a.ips.get(ip);
    if (!pa) a.ips.set(ip, { ip, count: 1, last: ts }); else { pa.count += 1; pa.last = ts; }
    let b = byIp.get(ip);
    if (!b) { b = { ip, count: 0, last: ts, rules: new Set() }; byIp.set(ip, b); }
    b.count += 1; if (ts > b.last) b.last = ts;
    b.rules.add(rname);
  }
  const iso = (t) => (t ? new Date(t).toISOString() : '');
  out.byRule = [...byRule.values()]
    .map((a) => ({ id: a.id, name: a.name, path: a.path, count: a.count, ips: [...a.ips.values()].sort((x, y) => y.count - x.count).slice(0, 5).map((x) => ({ ip: x.ip, count: x.count, last: iso(x.last) })) }))
    .sort((x, y) => y.count - x.count)
    .slice(0, 20);
  out.byIp = [...byIp.values()]
    .map((b) => ({ ip: b.ip, count: b.count, last: iso(b.last), rules: [...b.rules].slice(0, 5) }))
    .sort((x, y) => y.count - x.count)
    .slice(0, 20);
  out.last = iso(last);
  if (!text) out.note = '日志为空';
  return out;
}

module.exports = { caddyLogStats, readCaddyOwnLog, countPanelReq, panelReqSnapshot, upstreamHealth, upstreamHist, HISTORY_MAX, badgeSvg, diffRoutes, healthOf, histTick, metricsText, readAccess, readLogText, refreshUpstreamHealth, requestsLastMinute, rtHistory, sampleHistory, shadowReport, simulateMatch, systemInfo, tcpProbeOnce, trafficByHour, trafficByPath, securityAttempts, upstreamTarget };
