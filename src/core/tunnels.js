'use strict';
/**
 * cloudflared 进程池（启停、限流退避、致命错误）
 * 从 src/server.js 按职责拆出（v0.9.0），仅做搬运，行为不变。
 */

 const https=require('https');

  const { spawn }=require('child_process');

const { CLOUDFLARED, LOGLEVELS, PROTOCOLS } = require('./paths');
const { log, parseUpstream } = require('./util');
const _state = require('./state');
const state = _state.stateProxy;
const { publicUrlOf, runtimes, tunnelById, tunnelRt } = require('./registry');
const { schedulePush } = require('./pusher');
const QUICK_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/gi;
function tunnelArgs(t) {
  const args = ['tunnel', '--no-autoupdate', '--loglevel', t.loglevel || 'info'];
  if (t.protocol && t.protocol !== 'auto') args.push('--protocol', t.protocol);
  if (t.metricsPort) args.push('--metrics', `127.0.0.1:${t.metricsPort}`);
  if (t.extraArgs && t.extraArgs.trim()) args.push(...t.extraArgs.trim().split(/\s+/));
  if (t.mode === 'named') args.push('run');
  else args.push('--url', t.origin);
  return args;
}

function stopTunnel(id, silent = false) {
  const t = tunnelById(id);
  const rt = tunnelRt(id);
  const tag = t ? `[${t.name}] ` : '';
  rt.desired = false;
  if (!rt.proc) { rt.status = 'stopped'; return; }
  rt.status = 'stopping';
  const p = rt.proc;
  try { p.kill('SIGTERM'); } catch {}
  // 兜底必须无条件执行：如果这 5 秒里 startTunnel 又起了新进程，rt.proc 已经换人，
  // 旧条件 `rt.proc === p` 就永远不成立，旧进程会带着旧 token 一直挂在 Cloudflare 上
  // （2026-11-26 的「幽灵连接器」事故：同一个域名被多台机器/多个残留进程分流）。
  setTimeout(() => {
    try {
      if (p.exitCode === null && p.signalCode === null) {
        p.kill('SIGKILL');
        log(`${tag}子进程 5 秒没有退出，已强制结束（pid ${p.pid}）`, 'cloudflared');
      }
    } catch {}
  }, 5000);
  if (!silent) log(`${tag}已请求停止隧道`, 'cloudflared');
}

function startTunnel(id, opts = {}) {
  const t = tunnelById(id);
  if (!t) return;
  const rt = tunnelRt(id);
  const tag = `[${t.name}] `;
  rt.fatal = false; // 每次启动都重新判断，别把上一次的致命标记永久带下去
  rt.throttled = false;
  if (rt.proc) {
    // 先 SIGKILL 再起新的：SIGTERM 是优雅退出，cloudflared 要好几秒才断开，
    // 这期间新进程已经连上 Cloudflare，同一条隧道就会多出连接器（2026-11-26 事故形态）。
    const old2 = rt.proc;
    try { old2.kill('SIGKILL'); } catch {}
    log(`${tag}结束上一个 cloudflared（pid ${old2.pid}）后再启动`, 'cloudflared');
  }

  if (t.mode === 'named' && !t.token) {
    rt.status = 'error';
    rt.lastError = '命名隧道模式需要先填写 Tunnel Token';
    log(`${tag}${rt.lastError}`, 'cloudflared');
    return;
  }
  // metrics 端口撞车会让 cloudflared 直接退出，这里提前提示
  if (t.metricsPort) {
    const clash = state.tunnels.find((o) => o.id !== t.id && o.metricsPort === t.metricsPort && tunnelRt(o.id).proc);
    if (clash) log(`${tag}注意：metrics 端口 ${t.metricsPort} 与「${clash.name}」重复，可能启动失败`, 'cloudflared');
  }

  const args = tunnelArgs(t);
  const env = Object.assign({}, process.env);
  if (t.mode === 'named') env.TUNNEL_TOKEN = t.token;
  else delete env.TUNNEL_TOKEN;

  log(`${tag}启动: cloudflared ${args.join(' ')}`, 'cloudflared');
  let proc;
  try {
    proc = spawn(CLOUDFLARED, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    rt.status = 'error';
    rt.lastError = e.message;
    log(`${tag}启动失败: ${e.message}`, 'cloudflared');
    return;
  }
  rt.proc = proc;
  rt.status = 'starting';
  rt.pid = proc.pid;
  rt.startedAt = Date.now();
  // 自动重试时保留上一次的失败原因：否则「启动中」这一小段里界面上什么提示都没有，
  // 看起来像隧道凭空消失了。手动点「启动」才清空（用户点了就是想要个干净的开始）。
  if (!opts.keepError) rt.lastError = null;
  rt.url = null;
  rt.desired = true;

  const onData = (buf) =>
    String(buf)
      .split('\n')
      .filter((l) => l.trim())
      .forEach((l) => {
        log(`${tag}${l}`, 'cloudflared');
        if (/Registered tunnel connection|Your quick Tunnel has been created/i.test(l)) {
          if (rt.status !== 'running') {
            rt.status = 'running'; rt.failCount = 0; rt.lastError = null; schedulePush();
          }
        }
        const m = l.match(QUICK_RE);
        if (m && m[0] !== rt.url) {
          rt.url = m[0];
          log(`${tag}公网地址已就绪: ${m[0]}`, 'cloudflared');
          schedulePush(200);
        }
        // 网络层面的重连：cloudflared 的 QUIC 连接断了会自己重连，进程没退出、reconnects 不涨，
        // 但访客那一刻就是「网站抽了一下」。同一波重连会按 connIndex 连着刷好几行，5 秒内只记一次。
        if (/Retrying connection|Serve tunnel error|Unable to establish connection|Connection terminated/i.test(l)) {
          const nowMs = Date.now();
          const times = rt.flapTimes || (rt.flapTimes = []);
          if (!times.length || nowMs - times[times.length - 1] > 5000) {
            times.push(nowMs);
            if (times.length > 50) times.shift();
            rt.flaps = (rt.flaps || 0) + 1;
            rt.lastFlapAt = nowMs;
          }
        }
        if (/status 429|provisioning failed with status 429|rate.?limit/i.test(l)) rt.throttled = true;
        if (/token.{0,24}(not valid|invalid|expired|revoked)|invalid tunnel secret|unauthorized|failed to unmarshal tunnel token/i.test(l)) {
          // token 错/被吊销：重试再多次也没用，停止自动重试，把话说人话
          rt.fatal = true;
          rt.lastError = 'Tunnel Token 无效（Cloudflare 返回 “token is not valid”）—— 到 Cloudflare → Tunnels → 该隧道页重新复制 token，粘贴到「出口设置」里保存并启动';
        }
      });
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('exit', (code) => {
    if (rt.proc && rt.proc !== proc) {
      // 这个子进程已经被新进程取代了：不要再把 rt.proc 置空、也不要触发自动重试，
      // 否则会多起一个连接器，越重启越多。
      log(`${tag}旧 cloudflared 已退出（pid ${proc.pid}，已被新进程取代）`, 'cloudflared');
      return;
    }
    log(`${tag}cloudflared 退出 code=${code}`, 'cloudflared');
    const desired = rt.desired;
    rt.proc = null;
    rt.pid = null;
    rt.status = desired ? 'error' : 'stopped';
    if (desired) rt.reconnects = (rt.reconnects || 0) + 1;
    let delay = 5000;
    if (desired && rt.fatal) {
      // 致命错误（token 无效等）：不再自动重试，避免每 5 秒刷一次日志把面板刷满
      log(`${tag}检测到致命错误，已停止自动重试：${rt.lastError}`, 'cloudflared');
      if (!rt.lastError || rt.lastError.startsWith('进程退出')) rt.lastError = `进程退出 code=${code}（不会自动重试）`;
      schedulePush();
      return;
    }
    if (desired && rt.throttled) {
      // Cloudflare 对匿名快速隧道做限流（每天/每小时能建的数量有限）：指数退避，别每 5 秒重试一次把它惹更久
      rt.failCount = (rt.failCount || 0) + 1;
      delay = Math.min(30000 * Math.pow(2, rt.failCount - 1), 15 * 60000);
      rt.lastError = `Cloudflare 限流（快速隧道创建太频繁，第 ${rt.failCount} 次），${Math.round(delay / 1000)} 秒后自动重试`;
      log(`${tag}${rt.lastError}`, 'cloudflared');
    } else if (desired) {
      // 兜底：token 没配好、域名冲突、二进制坏了…… 连续失败 5 次就停下，别无声地每 5 秒刷日志
      rt.failCount = (rt.failCount || 0) + 1;
      rt.lastError = `进程退出 code=${code}`;
      if (rt.failCount >= 5) {
        rt.fatal = true;
        rt.lastError = `连续 ${rt.failCount} 次启动失败（code=${code}），已暂停自动重试。看看上面的日志，修好后点「启动」。`;
        log(`${tag}${rt.lastError}`, 'cloudflared');
        schedulePush();
        return;
      }
    } else {
      rt.failCount = 0;
      rt.lastError = null;
    }
    rt.throttled = false;
    schedulePush();
    const cur = tunnelById(id);
    if (desired && cur && cur.enabled) setTimeout(() => { const c2 = tunnelById(id); if (c2 && c2.enabled) startTunnel(id, { keepError: true }); }, delay);
  });
  setTimeout(() => { if (rt.proc && rt.status === 'starting') rt.status = 'running'; }, 8000);
}

function startAll() {
  for (const t of state.tunnels) if (t.enabled) startTunnel(t.id);
}
function stopAll() {
  for (const t of state.tunnels) stopTunnel(t.id, true);
}
function runtimeOf(id) {
  const rt = tunnelRt(id);
  return {
    status: rt.status, pid: rt.pid, url: rt.url,
    publicUrl: publicUrlOf(tunnelById(id)) || null,
    startedAt: rt.startedAt, lastError: rt.lastError,
    reconnects: rt.reconnects || 0,
    // 网络层重连（非进程重启）：flaps 是本次启动后的累计，flaps10m 只数最近 10 分钟
    flaps: rt.flaps || 0,
    lastFlapAt: rt.lastFlapAt || null,
    flaps10m: (rt.flapTimes || []).filter((x) => Date.now() - x < 600000).length,
    fatal: !!rt.fatal,
    uptimeSec: rt.status === 'running' && rt.startedAt ? Math.round((Date.now() - rt.startedAt) / 1000) : 0,
  };
}

// ---------------------------------------------------------------- 测速（面板自带，不依赖外部脚本）
function tokenTunnelOf(t) {
  if (!t) return '';
  if (t.tokenTunnelId) return t.tokenTunnelId;
  const tk = normalizeTunnelToken(t.token || '');
  if (tk.ok && tk.tunnelId) { t.tokenTunnelId = tk.tunnelId; return tk.tunnelId; }
  return '';
}

function publicTunnels() {
  return state.tunnels.map((t) => ({
    id: t.id,
    name: t.name,
    enabled: !!t.enabled,
    mode: t.mode,
    origin: t.origin,
    publicHostname: t.publicHostname,
    protocol: t.protocol,
    loglevel: t.loglevel,
    metricsPort: t.metricsPort,
    extraArgs: t.extraArgs,
    tokenTunnelId: tokenTunnelOf(t),
    hasToken: !!t.token,
  }));
}
function applyTunnelFields(t, body, { allowToken = true } = {}) {
  if (typeof body.name === 'string') t.name = body.name.trim().slice(0, 40) || t.name;
  if (['quick', 'named'].includes(body.mode)) t.mode = body.mode;
  if (allowToken && typeof body.token === 'string' && body.token.trim()) {
    const tk = normalizeTunnelToken(body.token);
    if (!tk.ok) throw new Error(tk.error);
    t.token = tk.token;
    t.tokenTunnelId = tk.tunnelId;
    if (tk.stripped) log(`[${t.name}] 粘贴的是整条命令，已自动抠出其中的隧道 token（隧道 ${tk.tunnelId.slice(0, 8)}…）`, 'cloudflared');
  }
  if (allowToken && body.clearToken === true) t.token = '';
  if (typeof body.origin === 'string' && body.origin.trim()) {
    parseUpstream(body.origin);
    t.origin = body.origin.trim();
  }
  if (typeof body.publicHostname === 'string') t.publicHostname = body.publicHostname.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (PROTOCOLS.includes(body.protocol)) t.protocol = body.protocol;
  if (LOGLEVELS.includes(body.loglevel)) t.loglevel = body.loglevel;
  if (typeof body.metricsPort === 'string') t.metricsPort = body.metricsPort.replace(/\D/g, '').slice(0, 5);
  if (typeof body.extraArgs === 'string') t.extraArgs = body.extraArgs.slice(0, 500);
  if (typeof body.enabled === 'boolean') t.enabled = body.enabled;
  return t;
}

// ---------------------------------------------------------------- HTTP 工具
function normalizeTunnelToken(raw) {
  const src = String(raw == null ? '' : raw).trim();
  if (!src) return { ok: false, error: '没填' };
  const candidates = String(src).match(/eyJ[A-Za-z0-9_\-+/=]{20,}/g) || [];
  const pool = candidates.length ? candidates : (/^[A-Za-z0-9_\-+/=]{40,}$/.test(src) ? [src] : []);
  const tried = [];
  for (const c of pool.slice().sort((a, b) => b.length - a.length)) {
    const cleaned = c.replace(/=+$/, '');
    try {
      const txt = Buffer.from(cleaned.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      const obj = JSON.parse(txt);
      if (!obj || typeof obj.a !== 'string' || typeof obj.t !== 'string' || typeof obj.s !== 'string') {
        tried.push('缺 a/t/s 字段'); continue;
      }
      return {
        ok: true,
        token: c,
        accountId: obj.a,
        tunnelId: obj.t,
        stripped: src !== c, // 说明用户粘的是整条命令，我们帮他抠出来了
      };
    } catch (e) { tried.push(e.message.slice(0, 40)); }
  }
  return {
    ok: false,
    error: '这段内容里找不到隧道 token（token 是一长串 `eyJ` 开头的字符）。到 Cloudflare → 网络 → Tunnels → 该隧道 → 配置，复制 `--token` 后面那一串。',
    tried,
  };
}

function syncTunnels(prevTunnels = []) {
  const sig = (x) => JSON.stringify([x.mode, x.token, x.origin, x.publicHostname, x.protocol, x.loglevel, x.metricsPort, x.extraArgs, x.enabled]);
  const prevMap = new Map(prevTunnels.map((t) => [t.id, t]));
  const restarted = [];
  for (const id of Array.from(runtimes.keys())) if (!tunnelById(id)) stopTunnel(id, true);
  for (const t of state.tunnels) {
    const prev = prevMap.get(t.id);
    const rt = tunnelRt(t.id);
    if (!prev) { if (t.enabled) startTunnel(t.id); continue; }
    if (sig(prev) !== sig(t)) {
      restarted.push(t.name || t.id);
      stopTunnel(t.id, true);
      if (t.enabled) startTunnel(t.id);
    } else if (t.enabled && rt.status === 'stopped') startTunnel(t.id);
  }
  return restarted;
}

// ---------------------------------------------------------------- 路由
// ---------------------------------------------------------------- 维护页 / 通知

module.exports = { QUICK_RE, applyTunnelFields, normalizeTunnelToken, publicTunnels, runtimeOf, startAll, startTunnel, stopAll, stopTunnel, syncTunnels, tokenTunnelOf, tunnelArgs };
