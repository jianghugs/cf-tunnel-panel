'use strict';
/**
 * 审计日志：谁、从哪个 IP、什么时候、对什么做了什么。
 *
 * 为什么要有：面板已经能通过隧道从公网访问，改一条规则、关一次维护模式、
 * 换一次面板密码，都可能是"别人干的"。配置备份只能告诉你"被改过"，
 * 审计日志才能告诉你"谁改的、从哪里改的、改完成没成"。
 *
 * 落盘策略（v0.20.0 起按天分文件）：
 *   DATA_DIR/audit/audit-YYYY-MM-DD.jsonl   每天一个，JSON Lines，追加写
 *   - 单文件超过 8MB 就截断成最后 5000 行（防一天写爆，又不丢最近的痕迹）
 *   - 保留 PANEL_AUDIT_DAYS 天（默认 30），启动时和每小时清理一次
 *   - 老的 data/audit.log（v0.19 及以前）首次启动自动搬进 audit/ 目录，不丢历史
 * 为什么改：以前是单个 audit.log + 2MB 截断，等于只留最近几小时，
 * 想查"上周三谁改的规则"根本查不到。按天分文件后既能长期保留，也能按日期翻。
 */

const fs = require('fs');
const path = require('path');

const { DATA_DIR } = require('./paths');

const AUDIT_MAX = 500;                                  // 内存环形（只作写盘失败的兜底 + 最近一条去重用）
const FILE_MAX_BYTES = 8 * 1024 * 1024;                 // 单个日文件上限
const KEEP_LINES = 5000;                                // 截断时保留的行数
const KEEP_DAYS = Math.max(1, Number(process.env.PANEL_AUDIT_DAYS) || 30);

const AUDIT_DIR = path.join(DATA_DIR, 'audit');
const LEGACY_FILE = path.join(DATA_DIR, 'audit.log');
const buffer = [];
let seq = 0;
let lastPrune = 0;

/** 本地日期 YYYY-MM-DD（审计是给人看的，用本地时区更自然） */
// 只有真正改变状态/安全的请求才算「变更」：登录、/api/match、/api/rules/test、/api/curl
// 这类只读探测虽然用 POST，但不应污染「每小时改动了多少次」的统计。
const MUTATING = [
  /^\/api\/settings$/,
  /^\/api\/routes$/,
  /^\/api\/tunnels?(\/|$)/,
  /^\/api\/shares(\/|$)/,
  /^\/api\/config\/(apply|snapshot)$/,
  /^\/api\/(panel-auth|viewer|operator)$/,
  /^\/api\/totp\//,
  /^\/api\/import$/,
  /^\/api\/backups\/restore$/,
  /^\/api\/security\/(deny|allow)$/,
  /^\/api\/cf\/(tunnels|dns|cache)(\/|$)/,
  /^\/api\/monitor\/(mute|unmute)$/,
  /^\/api\/notify\/resend$/,
  /^\/api\/sessions\/revoke/,
];
function isMutation(method, path) {
  if (method === 'GET' || method === 'HEAD') return false;
  const p = String(path || '').split('?')[0];
  return MUTATING.some((re) => re.test(p));
}

function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fileFor(ts = Date.now()) {
  return path.join(AUDIT_DIR, `audit-${dayKey(ts)}.jsonl`);
}

/** 路径 → 人话动作。匹配不到的就不做翻译，直接记原始路径（宁可糙也别瞎猜）。 */
const ACTIONS = [
  [/^\/api\/panel-auth$/, '面板登录口令/账号变更'],
  [/^\/api\/viewer$/, '只读账号变更'],
  [/^\/api\/operator$/, '运维账号变更'],
  [/^\/api\/totp\/(setup|enable|disable|recovery)$/, '二次验证设置变更'],
  [/^\/api\/routes$/, '修改代理规则'],
  [/^\/api\/settings$/, '修改全局设置'],
  [/^\/api\/tunnels\/start-all$/, '启动全部出口'],
  [/^\/api\/tunnels\/stop-all$/, '停止全部出口'],
  [/^\/api\/tunnels\/[^/]+\/delete$/, '删除隧道出口'],
  [/^\/api\/tunnels\/[^/]+\/(start|stop|restart)$/, '启停隧道出口'],
  [/^\/api\/tunnels\/[^/]+$/, '修改隧道出口'],
  [/^\/api\/tunnels$/, '新建隧道出口'],
  [/^\/api\/shares$/, '新建一次性分享'],
  [/^\/api\/shares\/[^/]+\/delete$/, '删除分享链接'],
  [/^\/api\/backups\/restore$/, '回滚配置'],
  [/^\/api\/config\/apply$/, '按声明应用配置'],
  [/^\/api\/import$/, '导入配置'],
  [/^\/api\/cf\/dns$/, '新建 DNS 记录'],
  [/^\/api\/cf\/dns\/[^/]+\/delete$/, '删除 DNS 记录'],
  [/^\/api\/cf\/tunnels$/, '云端建隧道'],
  [/^\/api\/cf\/tunnels\/quick$/, '一键新建出口'],
  [/^\/api\/cf\/tunnels\/[^/]+\/delete$/, '云端删隧道'],
  [/^\/api\/cf\/tunnels\/[^/]+\/hostnames$/, '加公共主机名'],
  [/^\/api\/cf\/tunnels\/[^/]+\/hostnames\/delete$/, '删公共主机名'],
  [/^\/api\/cf\/cache\/purge$/, '清除边缘缓存'],
  [/^\/api\/notify\/test$/, '发测试通知'],
  [/^\/api\/notify\/resend$/, '重发通知'],
  [/^\/api\/login$/, '登录'],
  [/^\/api\/sessions\/revoke$/, '踢掉登录会话'],
  [/^\/api\/sessions\/revoke-others$/, '踢掉其它会话'],
  [/^\/api\/sessions\/revoke-all$/, '退出全部会话'],
  [/^\/api\/curl$/, '链路自测'],
  [/^\/api\/ws-test$/, 'WebSocket 自测'],
  [/^\/api\/bench\/local$/, '本机回环测速'],
  [/^\/api\/rules\/test$/, '测上游可达性'],
];

function actionOf(method, url) {
  const p = String(url || '').split('?')[0];
  for (const [re, label] of ACTIONS) if (re.test(p)) return label;
  if (method === 'GET' || method === 'HEAD') return '查看';
  return `${method} ${p}`;
}

function ensureDir() {
  try { fs.mkdirSync(AUDIT_DIR, { recursive: true }); } catch { /* 交给写盘时报错 */ }
}

/** 把 v0.19 及以前的单个 audit.log 搬进按天目录（只做一次） */
function migrateLegacy() {
  try {
    if (!fs.existsSync(LEGACY_FILE)) return;
    ensureDir();
    const st = fs.statSync(LEGACY_FILE);
    const target = path.join(AUDIT_DIR, `audit-${dayKey(st.mtimeMs)}.jsonl`);
    if (fs.existsSync(target)) {
      // 已经有当天文件：追加过去再删旧的，避免覆盖
      fs.appendFileSync(target, fs.readFileSync(LEGACY_FILE));
      fs.unlinkSync(LEGACY_FILE);
    } else {
      fs.renameSync(LEGACY_FILE, target);
    }
  } catch { /* 迁移失败不影响新文件写入 */ }
}

/** 删除超过保留天数的日文件 */
function prune() {
  const now = Date.now();
  if (now - lastPrune < 3600 * 1000) return;
  lastPrune = now;
  try {
    const cutoff = now - KEEP_DAYS * 86400 * 1000;
    for (const f of fs.readdirSync(AUDIT_DIR)) {
      if (!/^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
      const full = path.join(AUDIT_DIR, f);
      try { if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full); } catch {}
    }
  } catch {}
}

/** 写一条审计记录（内存 + 当天文件） */
function record(entry = {}) {
  const rec = {
    seq: ++seq,
    at: entry.at || Date.now(),
    actor: String(entry.actor || '').slice(0, 60) || '(未登录)',
    ip: String(entry.ip || '').slice(0, 60),
    method: String(entry.method || ''),
    path: String(entry.path || '').slice(0, 300),
    status: Number(entry.status || 0),
    ms: Number(entry.ms || 0),
    action: String(entry.action || '').slice(0, 80),
    target: String(entry.target || '').slice(0, 200),
    ok: entry.ok !== false,
    mutating: entry.mutating !== undefined
      ? !!entry.mutating
      : isMutation(String(entry.method || ''), String(entry.path || '')),
  };
  // 同一次请求可能被「显式记账」和「收尾兜底」各记一条：兜底那条的 action 是「POST /api/xxx」形式，
  // 若前一条同 method+path+status 且间隔 <1s、action 是人话，就丢弃这条兜底记录，避免审计里成对出现。
  const generic = /^(?:GET|POST|PUT|PATCH|DELETE) \/api\//.test(rec.action);
  const prev = buffer[buffer.length - 1];
  if (generic && prev && prev.method === rec.method && prev.path === rec.path && prev.status === rec.status
      && Math.abs(rec.at - prev.at) < 1000 && !/^(?:GET|POST|PUT|PATCH|DELETE) \/api\//.test(prev.action)) {
    return prev;
  }
  buffer.push(rec);
  if (buffer.length > AUDIT_MAX) buffer.splice(0, buffer.length - AUDIT_MAX);
  try {
    ensureDir();
    const file = fileFor(rec.at);
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    trimIfBig(file);
    prune();
  } catch { /* 写不进去不影响主流程 */ }
  return rec;
}

function trimIfBig(file) {
  try {
    if (fs.statSync(file).size <= FILE_MAX_BYTES) return;
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    fs.writeFileSync(file, lines.slice(-KEEP_LINES).join('\n') + '\n');
  } catch {}
}

function matches(rec, q) {
  if (!q) return true;
  const s = q.toLowerCase();
  return [rec.actor, rec.ip, rec.action, rec.path, rec.target]
    .some((v) => String(v || '').toLowerCase().includes(s));
}

/** 可选的日期列表（新→旧） */
function days() {
  const out = [];
  try {
    for (const f of fs.readdirSync(AUDIT_DIR)) {
      const m = f.match(/^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!m) continue;
      const full = path.join(AUDIT_DIR, f);
      let bytes = 0;
      try { bytes = fs.statSync(full).size; } catch {}
      if (!bytes) continue;   // 空文件（清理/新建后还没写入）不该出现在日期下拉里
      out.push({ date: m[1], bytes, file: f });
    }
  } catch { return []; }
  return out.sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** 读某一天（或最近两天）的行，旧→新 */
function readRows(date, limit = 20000) {
  const files = [];
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    files.push(path.join(AUDIT_DIR, `audit-${date}.jsonl`));
  } else {
    // 不指定日期时读「今天 + 昨天」：凌晨那段时间两边都有数据，否则会看着像丢了
    const now = Date.now();
    files.push(fileFor(now), fileFor(now - 86400 * 1000));
  }
  const rows = [];
  for (const f of files) {
    try {
      const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
      for (const l of lines) {
        if (!l) continue;
        try {
          const o = JSON.parse(l);
          if (o && typeof o === 'object') rows.push(o);
        } catch {}
      }
    } catch { /* 文件不存在正常 */ }
  }
  rows.sort((a, b) => (a.at || 0) - (b.at || 0));
  return rows.slice(-limit);
}

/**
 * 按整点聚合「变更频率」：观测页趋势图用它画第二根柱子。
 * 窗口可能跨天，所以按日期文件逐个读（不再只看今天那一个）。
 */
function byHour(hours = 12) {
  const n = Math.min(Math.max(Number(hours) || 12, 1), 168);
  const now = new Date();
  const buckets = [];
  const index = new Map();
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(now);
    d.setHours(d.getHours() - i, 0, 0, 0);
    const k = d.getTime();
    const b = { t: k, total: 0, ok: 0, err: 0 };
    buckets.push(b);
    index.set(k, b);
  }
  const from = buckets.length ? buckets[0].t : 0;
  // 需要的日期文件（窗口跨天时不止一个）
  const need = new Set();
  for (let i = 0; i < n; i += 1) {
    const d = new Date(now);
    d.setHours(d.getHours() - i, 0, 0, 0);
    need.add(dayKey(d.getTime()));
  }
  let rows = [];
  for (const day of need) rows = rows.concat(readRows(day, 20000));
  if (!rows.length) rows = buffer.slice();
  for (const r of rows) {
    if (!r || !r.at || r.at < from) continue;
    const mut = r.mutating !== undefined ? !!r.mutating : isMutation(r.method, r.path);
    if (!mut) continue;                        // 只读探测与登录不算「改动」
    const d = new Date(r.at);
    d.setMinutes(0, 0, 0);
    const b = index.get(d.getTime());
    if (!b) continue;
    b.total += 1;
    if (r.ok) b.ok += 1; else b.err += 1;
  }
  return buckets;
}

/** 读审计：读文件（跨实例共享、重启也在），支持按日期翻 */
function list({ limit = 100, q = '', date = '', act = '', bad = false } = {}) {
  const n = Math.min(Math.max(Number(limit) || 100, 1), 2000);
  let rows = readRows(date);
  if (!rows.length) rows = buffer.slice();
  const total = rows.length;
  rows = rows.filter((r) => matches(r, q)
    && (!act || String(r.action || '') === act)
    && (!bad || r.ok === false)).reverse().slice(0, n);
  return { ok: true, available: rows.length > 0 || total > 0, count: total, rows, date: date || 'recent', keepDays: KEEP_DAYS };
}

/** 动作下拉用的候选：最近记录里去重后的动作名（按出现次数排） */
function actions(limit = 24) {
  const rows = readRows('').length ? readRows('') : buffer.slice();
  const cnt = new Map();
  for (const r of rows) {
    const a = String(r.action || '').trim();
    if (!a) continue;
    cnt.set(a, (cnt.get(a) || 0) + 1);
  }
  return [...cnt.entries()].sort((x, y) => y[1] - x[1]).slice(0, limit).map(([k, v]) => ({ action: k, count: v }));
}

function stats() {
  const ds = days();
  const bytes = ds.reduce((s, d) => s + d.bytes, 0);
  const today = fileFor();
  let todayBytes = 0;
  try { todayBytes = fs.statSync(today).size; } catch {}
  // count = 今天文件里能查到的条数（不是本进程写了多少条）：新实例刚起来时内存是空的，
  // 用 buffer.length 会让界面显示「0 条」但表格里明明有记录，容易误判成审计丢了。
  let todayCount = 0;
  try { todayCount = readRows(dayKey(), 20000).length; } catch {}
  return {
    count: todayCount,
    days: ds.length,
    bytes,
    dir: AUDIT_DIR,
    keepDays: KEEP_DAYS,
    newest: (ds[0] || {}).date || '',
    // 兼容 v0.19 及以前的字段（有调用方/测试在读它们）
    file: today,
    fileBytes: todayBytes,
  };
}

migrateLegacy();
ensureDir();

module.exports = { record, list, stats, byHour, actionOf, days, isMutation, actions, AUDIT_MAX, AUDIT_DIR, KEEP_DAYS };
/** 兼容旧调用：AUDIT_FILE 现在指向「今天」的分日文件 */
Object.defineProperty(module.exports, 'AUDIT_FILE', { enumerable: true, get: () => fileFor() });
