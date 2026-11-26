/**
 * 真 Caddy 端到端：证明「面板下发的配置真的能被 Caddy 接受，并且真的按预期工作」。
 *
 * 为什么需要别的测试不够：单元/接口测试都不启动 Caddy，`buildCaddyConfig()` 生成的
 * JSON 对不对、字段名有没有拼错（`load_balancing.selection` vs `selection_policy`）、
 * 匹配顺序对不对，只有真加载才知道。
 *
 * 覆盖：路径转发 / strip 前缀 / 未命中 404 / 基础认证 / 按域名隔离 / WebSocket 升级 /
 *       维护模式 503 / IP 黑名单 403 / admin 端口 / access log。
 *
 * 安全约定（血泪教训）：本脚本会临时改写线上规则与两项全局设置。
 *   1. 先把规则表快照到 /tmp，无论成败都在 finally 里还原；
 *   2. 全局设置只改「维护模式」和「IP 黑名单」，改前记原值，还原用原值覆盖；
 *   3. 任何未捕获异常都走同一套还原逻辑（process.on('uncaughtException')）。
 *
 * 用法：PANEL_URL=http://127.0.0.1:8090 PANEL_PASS=... CADDY_PORT=8080 node test/e2e-caddy.mjs
 */
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';

const B = process.env.PANEL_URL || 'http://127.0.0.1:8090';
const USER = process.env.PANEL_USER || 'admin';
const PASS = process.env.PANEL_PASS || '';
const basic = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
const CADDY_PORT = Number(process.env.CADDY_PORT || 8080);
const PANEL_PORT = Number(new URL(B).port || 8090);
const SNAP = `/tmp/e2e-routes-${process.pid}.json`;

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  [' + x + ']' : ''}`); };
const j = async (p, o = {}) => {
  const init = { ...o, headers: { 'Content-Type': 'application/json', Authorization: basic, ...(o.headers || {}) } };
  if (init.body && typeof init.body !== 'string') init.body = JSON.stringify(init.body);
  const r = await fetch(B + p, init);
  return { status: r.status, d: await r.json().catch(() => ({})) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 快照与还原 ----------
let snapRoutes = null, snapMaint = null, snapIpDeny = null, restored = false;
async function restoreAll() {
  if (restored) return;
  restored = true;
  try {
    if (snapRoutes) await j('/api/routes', { method: 'POST', body: { routes: snapRoutes } });
    if (snapMaint) await j('/api/settings', { method: 'POST', body: { maintenance: snapMaint } });
    if (snapIpDeny !== null) await j('/api/settings', { method: 'POST', body: { security: { ipDeny: snapIpDeny } } });
    if (existsSync(SNAP)) unlinkSync(SNAP);
  } catch (e) { console.log('⚠️ 还原失败：' + e.message); }
}
process.on('uncaughtException', async (e) => { console.log('未捕获异常：' + e.message); await restoreAll(); process.exit(1); });
process.on('SIGINT', async () => { await restoreAll(); process.exit(1); });

// ---------- 一个最小的 WebSocket 上游（用来验证 101 升级能穿过 Caddy） ----------
const wsServer = http.createServer((req, res) => {
  // 回显请求，用来验证 strip / 前缀保留 / 域名 / 认证头到底有没有到上游
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ url: req.url, host: req.headers.host || '', auth: req.headers.authorization || '' }));
});
wsServer.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'] || '';
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.end();
});
await new Promise((r) => wsServer.listen(0, '127.0.0.1', r));
const WS_PORT = wsServer.address().port;

const st = await j('/api/state');
ok('面板可达', st.status === 200, String(st.status));
ok('Caddy 已就绪', !!(st.d.runtime && st.d.runtime.caddy && st.d.runtime.caddy.ok), JSON.stringify(st.d.runtime && st.d.runtime.caddy).slice(0, 80));

snapRoutes = st.d.state.routes || [];
const set0 = st.d.state.settings || {};
snapMaint = set0.maintenance;
snapIpDeny = (set0.security && set0.security.ipDeny) || '';
writeFileSync(SNAP, JSON.stringify(snapRoutes));

const HOST_A = 'e2e-a.example.test';
const HOST_B = 'e2e-b.example.test';
const UP = `http://127.0.0.1:${WS_PORT}`;
// 注意：Caddy 是前缀匹配，探针前缀必须互不嵌套（/e2strip 与 /e2keep 不能一个有 /e2 前缀）
const probeRoutes = [
  { id: 'e2e-strip', name: 'E2E strip', path: '/e2strip', upstream: UP, strip: true, tunnelId: '' },
  { id: 'e2e-keep', name: 'E2E keep-prefix', path: '/e2keep', upstream: UP, strip: false, tunnelId: '' },
  { id: 'e2e-auth', name: 'E2E basic auth', path: '/e2auth', upstream: UP, strip: true, tunnelId: '', basicAuth: { user: 'e2e', password: 'e2epass' } },
  { id: 'e2e-hostA', name: 'E2E host A', path: '/e2host', host: HOST_A, upstream: UP, strip: true, tunnelId: '' },
  { id: 'e2e-hostB', name: 'E2E host B', path: '/e2host', host: HOST_B, upstream: UP, strip: true, tunnelId: '' },
  { id: 'e2e-ws', name: 'E2E websocket', path: '/e2ws', upstream: UP, strip: true, tunnelId: '' },
];
const setR = await j('/api/routes', { method: 'POST', body: { routes: [...probeRoutes, ...snapRoutes.filter((r) => !probeRoutes.some((p) => p.id === r.id))] } });
ok('下发的配置被 Caddy 接受', setR.status === 200 && setR.d.caddy && setR.d.caddy.ok, JSON.stringify(setR.d.caddy || setR.d).slice(0, 90));
await sleep(500);

const get = (path, headers = {}) => fetch(`http://127.0.0.1:${CADDY_PORT}${path}`, { headers, redirect: 'manual' });

// 手写一个 HTTP/1.1 请求，唯一目的是能自定义 Host 头（fetch/undici 不允许）
function rawGet(path, host, extra = '') {
  return new Promise((resolve) => {
    const sock = net.connect(CADDY_PORT, '127.0.0.1', () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nAccept: */*\r\n${extra}\r\n`);
    });
    let buf = '';
    sock.on('data', (d) => { buf += d.toString('latin1'); });
    sock.on('end', () => {
      const head = buf.split('\r\n\r\n')[0] || '';
      const status = parseInt((head.split('\r\n')[0] || '').split(' ')[1], 10) || 0;
      let body = buf.split('\r\n\r\n').slice(1).join('\r\n\r\n');
      if (/transfer-encoding:\s*chunked/i.test(head)) {
        // 解 chunked：长度行(hex) + 内容 + CRLF，直到 0 块
        const out = [];
        let i = 0;
        while (i < body.length) {
          const nl = body.indexOf('\r\n', i);
          if (nl < 0) break;
          const size = parseInt(body.slice(i, nl), 16);
          if (!size) break;
          out.push(body.slice(nl + 2, nl + 2 + size));
          i = nl + 2 + size + 2;
        }
        body = out.join('');
      }
      resolve({ status, body, head });
    });
    sock.on('error', (e) => resolve({ status: 0, body: '', head: 'ERR ' + e.message }));
    setTimeout(() => { sock.destroy(); resolve({ status: 0, body: '', head: 'timeout' }); }, 5000);
  });
}

// 1) 路径转发 + strip 前缀（上游回显看到的是 /deep/path，说明前缀被切掉）
{
  const r = await get('/e2strip/deep/path?x=1');
  const d = await r.json().catch(() => ({}));
  ok('strip 前缀：/e2strip/deep/path → 上游 /deep/path', r.status === 200 && d.url === '/deep/path?x=1', `status=${r.status} url=${d.url}`);
}
// 2) 不 strip 时前缀原样透传
{
  const r = await get('/e2keep/deep/path');
  const d = await r.json().catch(() => ({}));
  ok('不 strip：前缀原样透传 /e2keep/deep/path', r.status === 200 && d.url === '/e2keep/deep/path', `url=${d.url}`);
}
// 3) 基础认证
{
  const no = await get('/e2auth/x');
  const yes = await get('/e2auth/x', { Authorization: 'Basic ' + Buffer.from('e2e:e2epass').toString('base64') });
  const bad = await get('/e2auth/x', { Authorization: 'Basic ' + Buffer.from('e2e:wrong').toString('base64') });
  ok('基础认证：无凭证 401', no.status === 401, String(no.status));
  ok('基础认证：错密码 401', bad.status === 401, String(bad.status));
  ok('基础认证：有凭证 200', yes.status === 200, String(yes.status));
}
// 4) 按域名隔离：同一路径，不同 Host 各自命中自己的规则（fetch 会忽略 Host 头，必须手写请求）
{
  const a = await rawGet('/e2host/x', HOST_A);
  const ad = JSON.parse(a.body || '{}');
  ok('域名隔离：A 域名命中 A 规则', a.status === 200 && /e2e-a/.test(ad.host || ''), `host=${ad.host}`);
  const b = await rawGet('/e2host/x', HOST_B);
  const bd = JSON.parse(b.body || '{}');
  ok('域名隔离：B 域名命中 B 规则', b.status === 200 && /e2e-b/.test(bd.host || ''), `host=${bd.host}`);
  const none = await rawGet('/e2host/x', 'e2e-z.example.test');
  ok('域名隔离：未登记的域名不命中这两条', none.status === 404, String(none.status));
}
// 5) WebSocket 升级真的能穿过 Caddy（101）
{
  const res = await new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(CADDY_PORT, '127.0.0.1', () => {
      sock.write(`GET /e2ws/ws HTTP/1.1\r\nHost: 127.0.0.1:${CADDY_PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let buf = '';
    sock.on('data', (d) => { buf += d.toString('latin1'); if (buf.includes('\r\n\r\n')) { sock.destroy(); resolve(buf.split('\r\n')[0] + '|' + (buf.match(/sec-websocket-accept: *(\S+)/i) || [])[1]); } });
    sock.on('error', (e) => resolve('ERR ' + e.message));
    setTimeout(() => { sock.destroy(); resolve(buf.split('\r\n')[0] || 'timeout'); }, 4000);
  });
  ok('WebSocket 升级：Caddy 返回 101', /101 Switching Protocols/.test(res), String(res).slice(0, 80));
}
// 6) 未命中 → 自定义 404
// 不能用 fetch 直打 127.0.0.1: 本部署有一条 host=127.0.0.1 path=/ 的兜底规则（带 basicAuth），
// 任何路径都会被它接住变成 401。要验 404 兜底，必须换一个没有任何规则匹配的 Host。
{
  const r = await rawGet('/definitely-not-a-route-' + Date.now(), 'e2e-no-rule.example.test');
  ok('未命中规则返回 404', r.status === 404, String(r.status));
}
// 7) 维护模式：整站 503 + Retry-After
{
  const on = await j('/api/settings', { method: 'POST', body: { maintenance: { on: true, body: '维护中（E2E）', retryAfter: 60 } } });
  await sleep(400);
  const r = await get('/e2strip/healthz');
  ok('维护模式下返回 503', on.status === 200 && r.status === 503, `set=${on.status} get=${r.status}`);
  ok('维护模式带 Retry-After', !!r.headers.get('retry-after'), r.headers.get('retry-after') || '');
  await j('/api/settings', { method: 'POST', body: { maintenance: { on: false, body: snapMaint && snapMaint.body, retryAfter: snapMaint && snapMaint.retryAfter } } });
  await sleep(400);
  const after = await get('/e2strip/healthz');
  ok('关掉维护模式后恢复 200', after.status === 200, String(after.status));
}
// 8) IP 黑名单：本机 IP 拉黑 → 403
{
  await j('/api/settings', { method: 'POST', body: { security: { ipDeny: '127.0.0.1/32' } } });
  await sleep(400);
  const r = await get('/e2strip/healthz');
  ok('IP 黑名单命中返回 403', r.status === 403, String(r.status));
  await j('/api/settings', { method: 'POST', body: { security: { ipDeny: snapIpDeny } } });
  await sleep(400);
  const back = await get('/e2strip/healthz');
  ok('清空黑名单后恢复 200', back.status === 200, String(back.status));
}
// 8.5) 监控页与静默接口（不依赖 Prometheus 是否在跑）
{
  const page = await fetch(B + '/monitor', { headers: { Authorization: basic } });
  const html = await page.text();
  ok('监控页可打开', page.status === 200, String(page.status));
  ok('监控页有概览卡容器', html.includes('id="monStats"') && html.includes('/assets/monitor.js'), '');
  const st = await j('/api/monitor/status');
  ok('监控状态接口返回结构', st.status === 200 && typeof st.d.ok === 'boolean', String(st.d.ok));
  ok('监控状态带 mutes 数组', Array.isArray(st.d.mutes), String((st.d.mutes || []).length));
  const mute = await j('/api/monitor/mute', { method: 'POST', body: { name: 'E2eProbe', minutes: 10 } });
  ok('静默：写入成功', mute.status === 200 && mute.d.ok === true, String(mute.d.until || ''));
  const st2 = await j('/api/monitor/status');
  ok('静默：出现在状态里', (st2.d.mutes || []).some((m) => m.name === 'E2eProbe'), '');
  const un = await j('/api/monitor/unmute', { method: 'POST', body: { name: 'E2eProbe' } });
  ok('静默：可解除', un.status === 200 && un.d.removed >= 1, String(un.d.removed));
}

// 9) 生成的配置本身
{
  const cfg = await j('/api/caddy/config');
  const conf = JSON.stringify(cfg.d.config || {});
  ok('admin 不再监听众所周知的 2019', !/"listen":"127\.0\.0\.1:2019"/.test(conf), '');
  ok('配置带 access log writer', conf.includes('"writer"') && conf.includes('access.log'), '');
  ok('配置带 trusted_proxies（真实客户端 IP）', conf.includes('trusted_proxies') && conf.includes('CF-Connecting-IP'), '');
}

// 10) 双实例：租约选主 + 只读备份（滚动升级的地基）
// 这台机器上已经跑着一个 leader，我们再起一个共享同一份 data/ 的实例，
// 它应当拿到「只读备份」身份：页面能看，写操作必须被 409 挡住，
// 而且不能去推 Caddy（否则两个进程会互相覆盖配置）。
{
  const sys = await j('/api/system');
  const dataDir = (sys.d && sys.d.dataDir) || '/data';
  const standbyPort = Number(process.env.E2E_STANDBY_PORT || 8096);
  const env = {
    ...process.env,
    PORT: String(standbyPort),
    DATA_DIR: dataDir,
    CADDY_ADMIN: process.env.CADDY_ADMIN || 'http://127.0.0.1:9999',
    PANEL_SLOT_PEERS: String(PANEL_PORT),
    PANEL_INSTANCE: 'e2e-standby',
    LOG_STDOUT: '1',
  };
  const child = spawn(process.execPath, ['src/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let childErr = '';
  child.stderr.on('data', (b) => { childErr += b.toString(); });
  child.stdout.on('data', () => {});
  const wait = async (want, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try {
        const r = await fetch(`http://127.0.0.1:${standbyPort}/healthz`);
        const d = await r.json();
        if (d.mode === want) return d;
      } catch { /* 还没起来 */ }
      await sleep(400);
    }
    return null;
  };
  const sb = await wait('standby');
  ok('第二实例以「只读备份」起来', !!sb, sb ? `instance=${sb.instance}` : childErr.slice(-120));
  if (sb) {
    const r = await fetch(`http://127.0.0.1:${standbyPort}/api/state`, { headers: { Authorization: basic } });
    ok('备份实例可以读', r.status === 200, String(r.status));
    const w = await fetch(`http://127.0.0.1:${standbyPort}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basic },
      body: JSON.stringify({ panelTitle: 'should not be written' }),
    });
    const wd = await w.json().catch(() => ({}));
    ok('备份实例写操作被 409 拦住', w.status === 409 && wd.code === 'STANDBY', `${w.status} ${wd.code || ''}`);
    ok('409 里指出谁是 leader', !!(wd.leader), String(wd.leader || ''));
    const lead = await j('/healthz');
    ok('leader 仍是原来那个', lead.d.mode === 'leader', String(lead.d.mode));

    // 会话跨实例：在 leader 登录的会话，备份实例也必须认（否则页面被轮询到备份实例就掉登录）
    // 没开面板登录（没有面板账号）时无从登录，跳过这两条。
    const st0 = (await j('/api/state')).d.state || {};
    const authOn = !!(st0.panel && st0.panel.user) && !!PASS;
    const lg = authOn ? await fetch(B + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: USER, pass: PASS }),
    }) : { status: 0, headers: new Map() };
    const ck = String(lg.headers.get('set-cookie') || '').split(';')[0];
    if (authOn) ok('登录成功（用于跨实例会话检查）', lg.status === 200 && /^cfp_sid=/.test(ck), String(lg.status));
    if (authOn && /^cfp_sid=/.test(ck)) {
      const st = await fetch(`http://127.0.0.1:${standbyPort}/api/state`, { headers: { cookie: ck } });
      ok('备份实例认得 leader 登录的会话', st.status === 200, String(st.status));
      const pg = await fetch(`http://127.0.0.1:${standbyPort}/`, { headers: { cookie: ck }, redirect: 'manual' });
      ok('备份实例的页面不会把已登录用户弹回登录页', pg.status === 200, String(pg.status));
    }

    // 配置跨实例：leader 改完，备份实例的 /api/state 要能反映（否则用户看到旧配置）
    const beforeTitle = (await j('/api/state')).d.state.settings.panelTitle;
    const tmpTitle = 'e2e 跨实例标题';
    await j('/api/settings', { method: 'POST', body: { panelTitle: tmpTitle } });
    await sleep(2600);
    const sbR = await fetch(`http://127.0.0.1:${standbyPort}/api/state`, { headers: { Authorization: basic } });
    const sbD = await sbR.json().catch(() => ({}));
    ok('备份实例看到 leader 刚改的配置', !!(sbD.state && sbD.state.settings && sbD.state.settings.panelTitle === tmpTitle),
      (sbD.state && sbD.state.settings && sbD.state.settings.panelTitle) || '');
    await j('/api/settings', { method: 'POST', body: { panelTitle: beforeTitle } });
  }
  child.kill('SIGTERM');
  await sleep(600);
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
}

await restoreAll();
const now = (await j('/api/state')).d;
ok('规则表已还原', (now.state.routes || []).length === snapRoutes.length, `${(now.state.routes || []).length} vs ${snapRoutes.length}`);
const nowM = (now.state.settings || {}).maintenance || {};
ok('维护模式已还原', !!nowM.on === !!(snapMaint && snapMaint.on), String(nowM.on));

wsServer.close();
console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
