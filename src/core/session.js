'use strict';
/**
 * 会话式登录（cookie + 服务端会话表）
 *
 * 为什么要有：Basic 认证每个请求都带一次明文口令，浏览器记一辈子，而且**没法踢人**。
 * 会话化之后：登录一次发一个 cookie，服务端有一张会话表，可以逐个撤销，
 * 也能看到"谁在什么 IP、什么设备上登录着、最后一次活动是什么时候"。
 *
 * v0.12 起可选持久化（`session.init(file)`）：
 * - 落盘的只有 cookie 值的 SHA-256，拿到 sessions.json 也登不进来；
 * - 「记住我」= 30 天，普通登录 = 7 天 + 12 小时闲置失效；
 * - 重启后会话还在，不用每次改代码都重新登录。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE = 'cfp_sid';
const TTL_MS = 7 * 24 * 3600 * 1000;        // 普通登录：7 天
const REMEMBER_MS = 30 * 24 * 3600 * 1000;  // 记住我：30 天
const IDLE_MS = 12 * 3600 * 1000;           // 12 小时无活动也失效
const MAX_SESSIONS = 50;
const ROLES = ['admin', 'operator', 'viewer'];

/** key = sha256(cookie 值) -> { key, user, role, ip, ua, createdAt, lastSeenAt, expiresAt, ttl } */
const sessions = new Map();

let storeFile = '';
let saveTimer = null;
let lastLoadAt = 0;                  // 上次从磁盘合并的时间（横向扩展：另一实例会随时写这个文件）
const LOAD_THROTTLE_MS = 1500;
/** 本实例刚撤销的 key -> 时间。合并磁盘时不能把它们「捞回来」（否则踢人不生效） */
const revocations = new Map();
const REVOKE_KEEP_MS = 10 * 60 * 1000;

const KEY_RE = /^[a-f0-9]{64}$/;

function hashId(id) {
  return crypto.createHash('sha256').update(String(id || '')).digest('hex');
}

function parseCookies(req) {
  const out = {};
  const raw = String((req.headers && req.headers.cookie) || '');
  raw.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    if (!k) return;
    out[k] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

/** 读磁盘：兼容两种格式——旧的纯数组，以及 v2 的 {version, sessions, revoked} */
function readStore() {
  if (!storeFile) return { rows: [], revoked: [] };
  try {
    const j = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    if (Array.isArray(j)) return { rows: j.filter((x) => x && KEY_RE.test(x.key || '')), revoked: [] };
    return {
      rows: (Array.isArray(j.sessions) ? j.sessions : []).filter((x) => x && KEY_RE.test(x.key || '')),
      revoked: (Array.isArray(j.revoked) ? j.revoked : []).filter((x) => x && KEY_RE.test(x.key || '')),
    };
  } catch { return { rows: [], revoked: [] }; }
}

/**
 * 吸收「共享墓碑」：另一个实例撤销的会话，本实例也必须立刻不认。
 * 光靠内存里的 revocations 不够 —— 每个实例各有一份，谁都不知道别人踢了人。
 */
function absorbRevoked(list) {
  const now = Date.now();
  for (const r of list) {
    const at = Number(r.at) || 0;
    if (now - at > REVOKE_KEEP_MS) continue;
    if (!revocations.has(r.key)) revocations.set(r.key, at);
    sessions.delete(r.key);
  }
}

function rowToSession(s, now) {
  return {
    key: s.key,
    user: String(s.user || ''),
    role: ROLES.includes(s.role) ? s.role : 'viewer',
    ip: String(s.ip || ''),
    ua: String(s.ua || '').slice(0, 160),
    createdAt: Number(s.createdAt) || now,
    lastSeenAt: Number(s.lastSeenAt) || now,
    expiresAt: Number(s.expiresAt) || now,
    ttl: s.ttl === REMEMBER_MS ? REMEMBER_MS : TTL_MS,
    prevIp: String(s.prevIp || ''),
    ipChangedAt: Number(s.ipChangedAt) || 0,
  };
}

/** 从磁盘恢复会话（只恢复未过期、未被撤销的） */
function load() {
  if (!storeFile) return 0;
  const now = Date.now();
  const { rows, revoked } = readStore();
  absorbRevoked(revoked);
  let n = 0;
  for (const s of rows) {
    if (revocations.has(s.key)) continue;
    if (!s.expiresAt || s.expiresAt <= now) continue;
    if (now - (s.lastSeenAt || 0) > IDLE_MS) continue;
    sessions.set(s.key, rowToSession(s, now));
    n += 1;
  }
  return n;
}

/** 落盘（防抖 800ms；只写哈希，不写 cookie 原值） */
function persistNow() {
  if (!storeFile) return;
  try {
    const now = Date.now();
    for (const [k, at] of revocations) if (now - at > REVOKE_KEEP_MS) revocations.delete(k);
    const rows = [...sessions.values()]
      .filter((s) => !revocations.has(s.key))
      .map((s) => ({
        key: s.key, user: s.user, role: s.role, ip: s.ip, ua: s.ua,
        createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, expiresAt: s.expiresAt, ttl: s.ttl,
        prevIp: s.prevIp || '', ipChangedAt: s.ipChangedAt || 0,
      }));
    // 横向扩展：另一个实例也在写同一个文件。先读回来做并集，
    // 否则「本实例没见过的会话」会被这次写盘整批抹掉（表现就是随机掉登录）；
    // 同时把两边的墓碑合起来，撤销才能传达到对方。
    const disk = readStore();
    absorbRevoked(disk.revoked);
    for (const r of disk.rows) {
      if (sessions.has(r.key) || revocations.has(r.key)) continue;
      rows.push(r);
    }
    const payload = {
      version: 2,
      sessions: rows,
      revoked: [...revocations].map(([key, at]) => ({ key, at })),
    };
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    const tmp = `${storeFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, storeFile);
  } catch {}
}

function persist() {
  if (!storeFile) return;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; persistNow(); }, 800);
  if (saveTimer.unref) saveTimer.unref();
}


/** 从磁盘重新加载（另一实例新建/撤销的会话都靠这个同步）。限流，避免每个请求都读盘。 */
function reload(force) {
  if (!storeFile) return 0;
  const now = Date.now();
  if (!force && now - lastLoadAt < LOAD_THROTTLE_MS) return 0;
  lastLoadAt = now;
  const { rows, revoked } = readStore();
  absorbRevoked(revoked);
  const alive = new Map();
  for (const r of rows) {
    if (revocations.has(r.key)) continue;
    if (!r.expiresAt || r.expiresAt <= now) continue;
    if (now - (r.lastSeenAt || 0) > IDLE_MS) continue;
    alive.set(r.key, rowToSession(r, now));
  }
  // 内存里可能比磁盘更新（刚 touch/刚换 IP，防抖还没落盘）——以「更活跃的那份」为准，
  // 否则读一次盘就把刚发生的 IP 变更/最后活动时间抹掉了。
  for (const [k, s] of sessions) {
    if (revocations.has(k)) continue;
    const d = alive.get(k);
    if (!d) { alive.set(k, s); continue; }
    if ((s.lastSeenAt || 0) >= (d.lastSeenAt || 0)) {
      alive.set(k, Object.assign({}, d, {
        ip: s.ip || d.ip,
        prevIp: s.prevIp || d.prevIp,
        ipChangedAt: s.ipChangedAt || d.ipChangedAt,
        lastSeenAt: s.lastSeenAt || d.lastSeenAt,
        expiresAt: Math.max(s.expiresAt || 0, d.expiresAt || 0),
      }));
    }
  }
  sessions.clear();
  for (const [k, s] of alive) sessions.set(k, s);
  return sessions.size;
}

function init(file) {
  storeFile = file || '';
  const n = load();
  lastLoadAt = Date.now();
  return n;
}

function prune() {
  const now = Date.now();
  let changed = false;
  for (const [k, s] of sessions) {
    if (s.expiresAt <= now || now - s.lastSeenAt > IDLE_MS) { sessions.delete(k); changed = true; }
  }
  if (changed) persist();
  return changed;
}

function create({ user, role = 'admin', ip = '', ua = '', remember = false }) {
  prune();
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0];
    if (oldest) sessions.delete(oldest.key);
  }
  const id = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  const ttl = remember ? REMEMBER_MS : TTL_MS;
  const s = {
    key: hashId(id),
    user: String(user || ''),
    role: ROLES.includes(role) ? role : 'admin',
    ip: String(ip || ''),
    ua: String(ua || '').slice(0, 160),
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + ttl,
    ttl,
  };
  sessions.set(s.key, s);
  persistNow();
  // 返回体带上明文 id（只有这一次机会，之后服务端只存哈希）
  return { ...s, id, token: id };
}

function get(id) {
  if (!id) return null;
  const key = hashId(id);
  // 横向扩展：会话表由多个实例共享。
  // ① 本实例没见过的会话（在另一个实例登录的）要能从磁盘捞到；
  // ② 在另一个实例上被撤销的会话，本实例也必须尽快失效 —— 所以每次取会话
  //    都先做一次限流合并（1.5 秒最多读一次盘），而不是只在"没命中"时读。
  reload(false);
  let s = sessions.get(key);
  if (!s) {
    // 限流窗口内可能刚好漏掉另一个实例刚写下去的会话：没命中时强制读一次盘。
    reload(true);
    s = sessions.get(key);
  }
  if (!s) return null;
  s.rawId = String(id); // 只在内存里回挂原始 cookie 值，便于 touch/revoke；不落盘
  const now = Date.now();
  if (s.expiresAt <= now || now - s.lastSeenAt > IDLE_MS) { sessions.delete(s.key); persist(); return null; }
  return s;
}

function touch(id) {
  const s = get(id);
  if (!s) return null;
  s.lastSeenAt = Date.now();
  s.expiresAt = Date.now() + (s.ttl || TTL_MS);
  persist();
  return s;
}

function fromReq(req) {
  return get(parseCookies(req)[COOKIE]);
}

function revoke(shortOrFull) {
  const key = resolveKey(shortOrFull);
  if (!key) return false;
  sessions.delete(key);
  revocations.set(key, Date.now());
  persistNow();
  return true;
}

/** 全踢（含自己）。改密码、或点「退出全部设备」时用。 */
function revokeAll() {
  const n = sessions.size;
  const now = Date.now();
  sessions.clear();
  // 共享盘上的其它实例也会持有会话：全部打墓碑，落盘后它们再读就登不进来
  for (const r of readStore().rows) revocations.set(r.key, now);
  persistNow();
  return n;
}

/** 保留当前会话，其余全踢；返回踢掉的数量 */
/**
 * 只踢某个账号的会话（改只读/运维账号口令时用）。
 * 早先用 revokeAll()：管理员给自己加一个只读账号，结果把自己也踢下线了 ——
 * 「改别人的口令」不该波及操作者本人。
 */
function revokeUser(user, keepId) {
  const u = String(user || '').trim();
  if (!u) return 0;
  const keepKey = keepId ? hashId(keepId) : '';
  const now = Date.now();
  let n = 0;
  for (const [k, s] of [...sessions]) {
    if (s.user !== u || k === keepKey) continue;
    sessions.delete(k);
    revocations.set(k, now);
    n += 1;
  }
  for (const r of readStore().rows) {
    if (r.user !== u || r.key === keepKey) continue;
    revocations.set(r.key, now);
  }
  persistNow();
  return n;
}

function revokeOthers(keepId) {
  const keepKey = keepId ? hashId(keepId) : '';
  let n = 0;
  const now = Date.now();
  for (const k of [...sessions.keys()]) {
    if (k === keepKey) continue;
    sessions.delete(k);
    revocations.set(k, now);
    n += 1;
  }
  for (const r of readStore().rows) if (r.key !== keepKey) revocations.set(r.key, now);
  if (n) persistNow();
  return n;
}

function list(currentId) {
  // 会话表是所有实例共享的：先合一次盘，页面上才不会只看到"本实例登录的那几个"
  reload(true);
  prune();
  const curKey = currentId ? hashId(currentId) : '';
  return [...sessions.values()]
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .map((s) => ({
      id: s.key.slice(0, 8),
      user: s.user,
      role: s.role,
      ip: s.ip,
      ua: s.ua,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt,
      remember: s.ttl === REMEMBER_MS,
      prevIp: s.prevIp || '',
      ipChangedAt: s.ipChangedAt || 0,
      current: s.key === curKey,
    }));
}

function resolveKey(shortOrKey) {
  const s = String(shortOrKey || '');
  if (!s) return null;
  // 三种输入都要认：完整 cookie 值（先哈希再查）、落盘的 key、界面上显示的 8 位短 id
  const h = hashId(s);
  if (sessions.has(h)) return h;
  if (KEY_RE.test(s) && sessions.has(s)) return s;
  // 也可能是另一个实例登录的会话：回读磁盘再找一次
  reload(true);
  if (sessions.has(h)) return h;
  if (KEY_RE.test(s) && sessions.has(s)) return s;
  for (const k of sessions.keys()) if (k.slice(0, 8) === s) return k;
  return null;
}

function cookieHeader(id, { secure = false, remember = false } = {}) {
  const maxAge = Math.floor((remember ? REMEMBER_MS : TTL_MS) / 1000);
  const parts = [`${COOKIE}=${id}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function clearCookieHeader() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** 请求是不是走 HTTPS（经过 Caddy/Cloudflare 时看转发头） */
function isSecure(req) {
  const h = (req && req.headers) || {};
  // 先看 Cloudflare 的 CF-Visitor（{"scheme":"https"}）：这才是访客浏览器的真实协议。
  // 走隧道时 Caddy 到面板这一跳是明文 http，光看 x-forwarded-proto 会把 https 访问判成 http，
  // 于是会话 cookie 少了 Secure 标志。
  const visitor = String(h['cf-visitor'] || '');
  if (visitor) {
    try {
      const v = JSON.parse(visitor);
      if (v && v.scheme) return String(v.scheme).toLowerCase() === 'https';
    } catch {}
  }
  const proto = String(h['x-forwarded-proto'] || '').split(',')[0].trim();
  if (proto) return proto.toLowerCase() === 'https';
  return !!(req.socket && req.socket.encrypted);
}

module.exports = {
  COOKIE, TTL_MS, REMEMBER_MS, IDLE_MS, ROLES, sessions, init, load, persist, persistNow, hashId,
  parseCookies, create, get, touch, fromReq, revoke, revokeAll, revokeOthers, list, resolveKey,
  cookieHeader, clearCookieHeader, isSecure, prune, reload, revokeUser,
};
