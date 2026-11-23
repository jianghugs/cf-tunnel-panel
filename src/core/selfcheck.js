'use strict';
/**
 * 一键体检：把「面板到底哪里不对」一次性查出来。
 *
 * 为什么要有：出问题时，线索分散在四个地方 —— 面板自己的 /healthz、Caddy 的 admin
 * 接口、每个出口的 cloudflared 进程、以及外部依赖（Prometheus / Grafana）。
 * 以前要靠人一个个 curl；现在一个按钮，每条都给「结论 + 证据 + 怎么办」。
 *
 * 设计取舍：
 * - 全部并行、单个超时 3 秒，最慢一次体检 ≈ 3 秒（有一个卡住也不会拖死整页）
 * - 任何一条抛错都只影响它自己，不吞掉其它结论
 * - 状态只有三档：ok / warn / fail（warn = 能用但有隐患，fail = 这条链路断了）
 */

const fs = require('fs');
const path = require('path');
const { ACCESS_LOG_FILE, CADDY_ADMIN, DATA_DIR, STATE_FILE, pkgVersion } = require('./paths');

const TIMEOUT = 3000;

async function fetchText(url, ms = TIMEOUT, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal, redirect: 'manual' });
    const text = await r.text().catch(() => '');
    return { status: r.status, text };
  } finally {
    clearTimeout(timer);
  }
}

const kb = (n) => {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
};
const short = (x) => String(x || '').slice(0, 8);
const trimUrl = (u) => String(u || '').trim().replace(/\/+$/, '');

/** 单条检查的统一外壳：计时 + 兜住异常 */
async function step(id, name, fn) {
  const t0 = Date.now();
  try {
    const out = (await fn()) || {};
    return { id, name, status: out.status || 'ok', detail: out.detail || '', hint: out.hint || '', ms: Date.now() - t0 };
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? `超时（${TIMEOUT}ms 没响应）` : (e && e.message) || String(e);
    return { id, name, status: 'fail', detail: msg, hint: '', ms: Date.now() - t0 };
  }
}

/**
 * @param {object} state   当前 state（含 settings / tunnels / routes）
 * @param {object} ctx     { runtime, version, code, imageCode, drift, role }
 */
async function runChecks(state, ctx = {}) {
  const s = state || {};
  const settings = s.settings || {};
  const runtime = ctx.runtime || {};
  const tasks = [];                 // 先全部发出去，最后一起等：12 项并行最慢 ≈ 6 秒

  // 1) 版本与代码指纹：docker cp 部署过的老坑
  tasks.push(step('version', '版本与代码一致', async () => {
    const drift = ctx.drift === true;
    return {
      status: drift ? 'warn' : 'ok',
      detail: `${ctx.version || pkgVersion()} · 代码 ${short(ctx.code)}${ctx.imageCode || ctx.build ? ` · 镜像 ${short(ctx.imageCode || ctx.build)}` : ''}`,
      hint: drift ? '运行中的代码和镜像里打包的不一样（很可能是 docker cp 临时改过）。重新构建镜像再滚动升级即可消除。' : '',
    };
  }));

  // 2) 实例角色
  tasks.push(step('role', '实例角色', async () => {
    const role = ctx.role || 'leader';
    return {
      status: role === 'standby' ? 'warn' : 'ok',
      detail: role === 'standby' ? '只读备份实例（写操作会 409）' : '主实例（leader，负责下发配置）',
      hint: role === 'standby' ? '这是滚动升级期间的正常状态。如果一直停在 standby，说明主实例的租约没释放。' : '',
    };
  }));

  // 3) Caddy 管理接口
  tasks.push(step('caddy', 'Caddy 管理接口', async () => {
    // Caddy 的 admin 接口会校验 Origin，必须带（和 pusher.js 下发时同一个值）
    const r = await fetchText(`${CADDY_ADMIN}/config/`, TIMEOUT, { Origin: CADDY_ADMIN });
    if (r.status >= 200 && r.status < 300) return { status: 'ok', detail: `${CADDY_ADMIN} 有响应（HTTP ${r.status}）` };
    return {
      status: 'fail',
      detail: `HTTP ${r.status}`,
      hint: 'Caddy 容器可能没起来，或 admin 端口不是 20190。看 `docker ps | grep caddy`。',
    };
  }));

  // 4) 已载入的路由数
  tasks.push(step('routes', '规则数一致', async () => {
    const loaded = runtime.caddy ? runtime.caddy.routeCount : null;
    const local = (s.routes || []).filter((x) => !x.disabled).length;
    const caddyOk = !!(runtime.caddy && runtime.caddy.ok);
    if (!caddyOk) return { status: 'fail', detail: '最后一次下发失败', hint: (runtime.caddy && runtime.caddy.error) || '看「规则」页顶部提示' };
    if (loaded === null || loaded === undefined) return { status: 'warn', detail: '拿不到 Caddy 的规则数' };
    return {
      status: loaded === local ? 'ok' : 'warn',
      detail: `本地 ${local} 条 · Caddy 里 ${loaded} 条`,
      hint: loaded === local ? '' : '两边不一致说明最后一次下发没完全生效；点「规则」页的「下发到 Caddy」重试。',
    };
  }));

  // 5) 遮蔽检测（path:/ 吃掉同域名其它路径那个坑）
  tasks.push(step('shadow', '规则遮蔽', async () => {
    const list = (runtime.caddy && runtime.caddy.shadowed) || [];
    if (!list.length) return { status: 'ok', detail: '没有规则被同域名的更宽规则吃掉' };
    return {
      status: 'warn',
      detail: `${list.length} 条被遮蔽`,
      hint: list.slice(0, 3).map((x) => `${x.path || x.host} 被 ${x.by || '?'} 覆盖`).join('；'),
    };
  }));

  // 6) 出口：进程状态 + 公网可访问性（最多查 5 个，免得一次体检拖太久）
  const exits = (s.tunnels || []).filter((t) => t.mode === 'named');
  for (const t of exits.slice(0, 5)) {
    tasks.push(step(`exit-${t.id}`, `出口：${t.name || t.id}`, async () => {
      const rt = runtime.tunnels && runtime.tunnels[t.id];
      const st = rt ? rt.status : 'stopped';
      const url = (rt && (rt.publicUrl || rt.url)) || '';
      if (st !== 'running') {
        return { status: 'fail', detail: `进程没在跑（${st}）`, hint: '在「隧道出口」页点「启动」；反复退出看日志里的 cloudflared 报错。' };
      }
      if (!url) return { status: 'warn', detail: '在跑，但没有公网地址' };
      // 走公网（过 Cloudflare 边缘）本来就慢：一个来回 1.5–2.5 秒很常见，
      // 给 6 秒，超时只算「注意」——超时常常只是慢，不代表坏了，误报比漏报更烦人
      let r = null;
      try {
        r = await fetchText(url, 6000);
      } catch (e) {
        const slow = e && e.name === 'AbortError';
        return {
          status: 'warn',
          detail: slow ? '6 秒没响应（可能只是慢）' : `请求失败：${(e && e.message) || e}`,
          hint: slow ? '经 Cloudflare 边缘访问本来就慢；连续几次都这样，再看 cloudflared 日志和上游服务。' : '检查 cloudflared 是否真的注册到了边缘（看面板日志）。',
        };
      }
      const healthy = r.status < 500;
      return {
        status: healthy ? 'ok' : 'warn',
        detail: `${url} → HTTP ${r.status}`,
        hint: healthy ? '' : 'cloudflared 在跑但对端返回 5xx；多半是背后那个上游服务挂了，或 Cloudflare 侧的 ingress 没指到这里。',
      };
    }));
  }

  // 6b) 出口链路稳定性：cloudflared 与边缘之间的 QUIC 断线重连不会让进程退出，
  // 面板上原本完全看不见 —— 但访客那一刻就是「网站抽了一下」，所以单独查一次。
  tasks.push(step('flaps', '出口链路稳定性', async () => {
    const running = (s.tunnels || [])
      .filter((t) => t.mode === 'named')
      .map((t) => ({ name: t.name || t.id, rt: (runtime.tunnels || {})[t.id] }))
      .filter((x) => x.rt && x.rt.status === 'running');
    if (!running.length) return { status: 'ok', detail: '没有在运行的出口' };
    // 刚启动/刚重启的出口一定会重连一次，那是启动过程不是链路抖动
    const fresh = running.filter((x) => x.rt.startedAt && Date.now() - x.rt.startedAt < 60000);
    if (fresh.length === running.length) {
      return { status: 'ok', detail: `出口刚启动不到 1 分钟（${fresh.map((x) => x.name).join('、')}），先不判定链路稳定性` };
    }
    const steady = running.filter((x) => !fresh.includes(x));
    const total = steady.reduce((n, x) => n + (x.rt.flaps10m || 0), 0);
    const worst = steady.slice().sort((a2, b2) => (b2.rt.flaps10m || 0) - (a2.rt.flaps10m || 0))[0];
    if (total >= 3) {
      return {
        status: 'warn',
        detail: `最近 10 分钟共 ${total} 次网络重连（最多的是「${worst.name}」${worst.rt.flaps10m} 次）`,
        hint: 'cloudflared 到 Cloudflare 边缘的 QUIC 连接在抖，常见原因是家宽上行丢包或 NAT 会话超时。可在「出口设置」里把协议从 auto 改成 http2（走 TCP，穿 NAT 更稳），改完点保存并重启该出口。',
      };
    }
    return { status: 'ok', detail: total ? `最近 10 分钟 ${total} 次网络重连（偶发，属正常）` : '最近 10 分钟没有网络重连' };
  }));

  // 7) Prometheus
  const prom = trimUrl((settings.monitoring || {}).promUrl);
  tasks.push(step('prometheus', 'Prometheus', async () => {
    if (!prom) return { status: 'warn', detail: '没配地址', hint: '设置 → 监控嵌入 → Prometheus 地址' };
    const r = await fetchText(`${prom}/-/ready`);
    return {
      status: r.status === 200 ? 'ok' : 'fail',
      detail: `${prom} → HTTP ${r.status}`,
      hint: r.status === 200 ? '' : 'Prometheus 容器没起来，或地址写错（端口默认 9090）。',
    };
  }));

  // 7b) Prometheus 有没有真的抓到面板（ready 只是它自己活着）
  tasks.push(step('scrape', 'Prometheus 抓到面板', async () => {
    if (!prom) return { status: 'warn', detail: '没配 Prometheus 地址' };
    const r = await fetchText(`${prom}/api/v1/targets`);
    let list = [];
    try { list = (JSON.parse(r.text).data.activeTargets) || []; } catch { return { status: 'warn', detail: '拿不到 targets（接口格式变了？）' }; }
    const up = list.filter((t) => t.health === 'up').length;
    const down = list.filter((t) => t.health !== 'up');
    // 双槽位部署：滚动升级时总有一色停着，它的 target 必然 down，不算故障
    const SLOT = /:(8090|8095)\b/;
    const realDown = down.filter((t) => !SLOT.test(t.scrapeUrl || t.labels.instance || ''));
    return {
      status: realDown.length ? 'fail' : up ? 'ok' : 'warn',
      detail: `${up}/${list.length} 在抓${down.length && !realDown.length ? `（另 ${down.length} 个是停着的备份槽位）` : ''}`,
      hint: realDown.length
        ? `抓不到：${realDown.map((t) => t.scrapeUrl).slice(0, 3).join('、')}`
        : up ? '' : '一个目标都没抓到，看 prometheus.yml 的 targets 与面板端口。',
    };
  }));

  // 8) Grafana
  const gf = settings.grafana || {};
  tasks.push(step('grafana', 'Grafana', async () => {
    if (!gf.enabled) return { status: 'warn', detail: '没启用嵌入', hint: '设置 → 监控嵌入 → 打开「嵌入 Grafana」' };
    // 优先打局域网地址：走公网主机名的话这一枪要穿过 Cloudflare，3 秒经常不够，
    // 会变成「体检时好时坏」的假失败（v0.29.18 前它就是这样反复报超时）
    const lan = trimUrl(gf.lanUrl);
    const base = lan || trimUrl(gf.url);
    if (!base) return { status: 'warn', detail: '没配地址' };
    let r;
    try {
      r = await fetchText(`${base}/api/health`, 6000);
    } catch (e) {
      const to = /abort|timeout/i.test(String((e && e.message) || e));
      return { status: 'warn', detail: `${base} → ${to ? '6 秒没响应（可能只是慢）' : String((e && e.message) || e)}`,
        hint: to ? '体检走的是面板本机出口；如果一直超时，看 Grafana 是不是正在重启。' : '' };
    }
    let db = '';
    try { db = (JSON.parse(r.text) || {}).database || ''; } catch { /* 不是 JSON 就只看状态码 */ }
    const healthy = r.status === 200 && (!db || db === 'ok');
    return {
      status: healthy ? 'ok' : 'fail',
      detail: `${base} → HTTP ${r.status}${db ? ` · 数据库 ${db}` : ''}`,
      hint: healthy ? '' : 'Grafana 没起来或数据库没就绪；`docker logs cfp-grafana` 看原因。',
    };
  }));

  // 9) 数据盘
  tasks.push(step('disk', '数据盘空间', async () => {
    const st = fs.statfsSync(DATA_DIR);
    const free = st.bavail * st.bsize;
    const total = st.blocks * st.bsize;
    const pct = total ? free / total : 1;
    const status = pct < 0.05 ? 'fail' : pct < 0.15 ? 'warn' : 'ok';
    return {
      status,
      detail: `剩余 ${kb(free)} / 共 ${kb(total)}（${Math.round(pct * 100)}%）`,
      hint: status === 'ok' ? '' : '审计与备份都写在数据盘上，满了会写不进去；清 audit/ 与 backups/ 里的老文件。',
    };
  }));

  // 10) 状态文件可写 + 新鲜度
  tasks.push(step('state', '状态文件', async () => {
    const st = fs.statSync(STATE_FILE);
    const ageMin = Math.round((Date.now() - st.mtimeMs) / 60000);
    fs.accessSync(STATE_FILE, fs.constants.W_OK);
    return {
      status: 'ok',
      detail: `${path.basename(STATE_FILE)} ${kb(st.size)} · ${ageMin} 分钟前改过`,
    };
  }));

  // 11) 访问日志：最近 10 分钟的噪音占比 + 访问行能回溯多久（趋势图的可用窗口）
  tasks.push(step('logs', '访问日志', async () => {
    let st;
    try { st = fs.statSync(ACCESS_LOG_FILE); } catch {
      return { status: 'ok', detail: '还没有访问日志（面板有流量后会自动出现）' };
    }
    const take = Math.min(st.size, 512 * 1024);
    const buf = Buffer.alloc(take);
    const fd = fs.openSync(ACCESS_LOG_FILE, 'r');
    try { fs.readSync(fd, buf, 0, take, Math.max(0, st.size - take)); } finally { fs.closeSync(fd); }
    const since = Date.now() - 10 * 60 * 1000;
    let access = 0, health = 0, oldest = 0, newest = 0;
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.includes('"logger":"')) continue;
      const m = line.match(/"ts":([\d.]+)/);
      const ts = m ? Number(m[1]) * 1000 : 0;
      const isAccess = line.includes('"logger":"http.log.access');
      const isHealth = line.includes('health_checker');
      if (!isAccess && !isHealth) continue;
      if (isAccess) {
        if (ts && (!oldest || ts < oldest)) oldest = ts;
        if (ts > newest) newest = ts;
      }
      if (!ts || ts < since) continue;                 // 只统计最近 10 分钟，历史噪音不算现状
      if (isAccess) access += 1; else health += 1;
    }
    const noise = access + health ? Math.round((health / (access + health)) * 100) : 0;
    const spanH = oldest && newest ? (newest - oldest) / 3600000 : 0;
    const status = health > 200 && noise >= 80 ? 'warn' : 'ok';
    return {
      status,
      detail: `最近 10 分钟：访问行 ${access} 条、健康检查 ${health} 条（噪音 ${noise}%）；访问行可回溯 ${spanH.toFixed(1)} 小时`,
      hint: status === 'ok' ? ''
        : '健康检查正在刷日志（两台面板同时在线时才会这样），趋势图能覆盖的窗口会缩水；滚动结束后自动恢复。',
    };
  }));

  const checks = await Promise.all(tasks);             // 顺序与上面声明一致

  const fail = checks.filter((c) => c.status === 'fail').length;
  const warn = checks.filter((c) => c.status === 'warn').length;
  return { ok: fail === 0, fail, warn, total: checks.length, checkedAt: Date.now(), checks };
}

/* ---------------- 结果留痕：手动跑和定时跑都写这里 ---------------- */
const STORE_DIR = path.join(DATA_DIR, 'selfcheck');
const LAST_FILE = path.join(STORE_DIR, 'last.json');
const HIST_FILE = path.join(STORE_DIR, 'history.jsonl');
const KEEP = 300;   // 每 5 分钟一条 → 300 条约等于 25 小时，够「最近 24 小时」聚合                                       // 历史最多留 200 次
const HIST_MAX_BYTES = 256 * 1024;                      // 超过就裁剪（正常一条 ~300B，200 条 ~60KB）
const REC_MAX_BYTES = 2 * 1024;                         // 单条记录上限
const LINE_MAX_BYTES = 8 * 1024;                        // 比这更长的行视为损坏（曾出现 200MB 的爆炸行）

const clip = (v, n) => { const t = String(v == null ? '' : v); return t.length > n ? t.slice(0, n) + '…' : t; };

/**
 * 从文件尾部倒着读，凑够 n 行就停。
 * 不用 readFileSync 整读：历史上曾有一个 360MB 的 history.jsonl，
 * 整读+整写把事件循环卡了 20 秒，接口直接挂死。
 */
function tailLines(file, n, maxBytes = 4 * 1024 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let window = Math.min(size, 64 * 1024);
    for (;;) {
      const start = Math.max(0, size - window);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const parts = buf.toString('utf8').split('\n');
      if (start > 0) parts.shift();                     // 起始处大概率是半行，丢掉
      const lines = parts.filter(Boolean);
      if (lines.length > n || start === 0 || window >= maxBytes) return lines.slice(-n);
      window = Math.min(window * 2, maxBytes);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function parseLine(line) {
  if (line.length > LINE_MAX_BYTES) return null;        // 损坏行直接忽略
  try {
    const x = JSON.parse(line);
    return x && typeof x === 'object' ? x : null;
  } catch { return null; }
}

function trimHist() {
  try {
    const keep = tailLines(HIST_FILE, KEEP).map(parseLine).filter(Boolean).slice(-KEEP);
    const tmp = HIST_FILE + '.tmp';
    fs.writeFileSync(tmp, keep.map((x) => JSON.stringify(x)).join('\n') + (keep.length ? '\n' : ''));
    fs.renameSync(tmp, HIST_FILE);
  } catch { /* 裁剪失败不影响体检本身 */ }
}

function persist(result) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    const rec = {
      at: result.checkedAt || Date.now(),
      ok: result.ok, fail: result.fail, warn: result.warn, total: result.total,
      bad: (result.checks || []).filter((c) => c.status === 'fail')
        .slice(0, 8)
        .map((c) => ({ id: clip(c.id, 40), name: clip(c.name, 60), detail: clip(c.detail, 200) })),
    };
    fs.writeFileSync(LAST_FILE, JSON.stringify(rec));

    let line = JSON.stringify(rec);
    if (line.length > REC_MAX_BYTES) {                  // 兜底：异常大的记录退化成摘要
      line = JSON.stringify({ at: rec.at, ok: rec.ok, fail: rec.fail, warn: rec.warn, total: rec.total,
        bad: rec.bad.slice(0, 1).map((x) => ({ id: x.id, name: x.name, detail: clip(x.detail, 80) })) });
    }
    fs.appendFileSync(HIST_FILE, line + '\n');          // 追加是 O(1)，不再整文件重写
    try { if (fs.statSync(HIST_FILE).size > HIST_MAX_BYTES) trimHist(); } catch { /* 忽略 */ }
    return rec;
  } catch {
    return null;                                        // 留痕失败不该影响体检本身
  }
}

function lastResult() {
  try { return JSON.parse(fs.readFileSync(LAST_FILE, 'utf8')); } catch { return null; }
}

/** 记录里的 at 是毫秒时间戳（v0.29.12 起），老/手工数据可能是 ISO 串，两种都认 */
function atMs(v) {
  if (typeof v === 'number') return v;
  const n = Number(v);
  if (Number.isFinite(n) && n > 1e12) return n;
  return Date.parse(v) || 0;
}

/** 把一段历史记录按检查项聚合：窗口内哪些项出过问题、各几次、最后一次的说明 */
function fails(items, nowMs = Date.now()) {
  const map = new Map();
  for (const h of items || []) {
    const at = atMs(h && h.at);
    if (!at || at > nowMs) continue;
    for (const b of (h.bad || [])) {
      if (!b || !b.id) continue;
      const cur = map.get(b.id) || { id: b.id, name: b.name || b.id, count: 0, lastAt: 0, lastDetail: '' };
      cur.count += 1;
      if (at >= cur.lastAt) { cur.lastAt = at; cur.lastDetail = String(b.detail || '').slice(0, 200); cur.name = b.name || cur.name; }
      map.set(b.id, cur);
    }
  }
  return [...map.values()]
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
    .map((x) => ({ ...x, lastAt: x.lastAt ? new Date(x.lastAt).toISOString() : '' }));
}

function history(n = 20) {
  const limit = Math.max(1, Math.min(KEEP, Number(n) || 20));
  try {
    return tailLines(HIST_FILE, limit).map(parseLine).filter(Boolean).slice(-limit).reverse();
  } catch { return []; }
}

module.exports = { fails, history, lastResult, persist, runChecks };
