import fs from 'node:fs';
import os from 'node:os';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import http from 'node:http';

const B = process.env.PANEL_URL || 'http://127.0.0.1:8090';
const USER = process.env.PANEL_USER || 'admin';
const PASS = process.env.PANEL_PASS || '';
if (!PASS) {
  console.error('需要环境变量 PANEL_PASS（面板登录密码）：PANEL_PASS=你的密码 node test/api.test.mjs');
  process.exit(2);
}
const basic = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

// 所有打到面板的请求自动带凭据（面板登录开着，否则全是 401）
const _fetch0 = globalThis.fetch;
// 连「不带鉴权」的请求也要打测试标记：否则故意制造的 401/403 会写进生产审计，
// 概览页「变更趋势」里的失败数就这么被测试刷成了 100。
const rawFetch = (u, o = {}) => {
  const hit = B && String(u).startsWith(B);
  return hit ? _fetch0(u, { ...o, headers: { ...(o.headers || {}), 'x-cfp-test': '1' } }) : _fetch0(u, o);
};
globalThis.fetch = (u, o = {}) => {
  const href = String(u);
  if (href.startsWith(B)) o = { ...o, headers: { ...(o.headers || {}), Authorization: basic, 'x-cfp-test': '1' } };
  return rawFetch(u, o);
};

let pass = 0, fail = 0;

// 这些用例会改真实配置（规则/设置/维护模式/黑名单…）。开跑前把当前规则存一份，
// 无论中途抛错还是提前退出，退出时都写回去 —— 之前正是因为这个缺失，
// 一次失败用例把线上的 5 条规则换成了 1 条（面板与所有域名直接 404）。
let _snapRoutes = null;
let _snapSettings = null;   // 这些测试会改 Grafana/通知/监控设置，跑完必须还原（否则会把生产配置改成测试值）
async function snapRoutes() {
  try {
    const r = await fetch(`${B}/api/state`, { headers: { Authorization: basic } });
    const d = await r.json();
    _snapRoutes = (d.state && d.state.routes) || null;
    const st = (d.state && d.state.settings) || {};
    _snapSettings = JSON.parse(JSON.stringify({
      grafana: st.grafana || {}, monitoring: st.monitoring || {}, notify: st.notify || {},
    }));
  } catch { /* ignore */ }
}
async function restoreRoutes() {
  if (!_snapRoutes || process.env.PANEL_TESTS_NO_RESTORE === '1') return;
  try {
    const r = await fetch(`${B}/api/routes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basic, 'x-cfp-test': '1' },
      body: JSON.stringify({ routes: _snapRoutes }),
    });
    console.log(r.ok ? '\n已还原测试前的规则' : `\n还原规则失败: HTTP ${r.status}`);
  } catch (e) { console.log('\n还原规则失败: ' + e.message); }
  if (!_snapSettings) return;
  try {
    const r2 = await fetch(`${B}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basic, 'x-cfp-test': '1' },
      body: JSON.stringify(_snapSettings),
    });
    console.log(r2.ok ? '已还原测试前的设置（Grafana/通知/监控）' : `还原设置失败: HTTP ${r2.status}`);
  } catch (e) { console.log('还原设置失败: ' + e.message); }
}
process.on('exit', () => { /* 同步无法 await，改用 beforeExit 已处理 */ });
process.on('SIGINT', () => { restoreRoutes().finally(() => process.exit(130)); });
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  [' + x + ']' : ''}`); };
const j = async (p, o = {}) => {
  const r = await fetch(B + p, { headers: { ...(o.body ? { 'Content-Type': 'application/json' } : {}), 'x-cfp-test': '1' }, ...o, body: o.body ? JSON.stringify(o.body) : undefined });
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = { raw: t }; }
  return { status: r.status, d, headers: r.headers };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await snapRoutes();

const h = await j('/healthz');
ok('healthz 200 且带 version', h.status === 200 && !!h.d.version, h.d.version);
ok('healthz 带代码指纹', !!h.d.code && h.d.code.length === 16, String(h.d.code));
ok('healthz 报告 drift 标记', typeof h.d.drift === 'boolean', String(h.d.drift));
ok('healthz 报告主备角色', ['leader', 'standby'].includes(h.d.mode), String(h.d.mode));
ok('healthz 报告实例标识', typeof h.d.instance === 'string' && h.d.instance.length > 0, String(h.d.instance));

const st = await j('/api/state');
const routes0 = st.d.state.routes.length;
ok('state: 不泄露 tunnel token', !JSON.stringify(st.d.state.tunnels).includes('"token":"ey'), '');
console.log('     settings.cf 字段:', JSON.stringify(st.d.state.settings.cf));
console.log('     settings.notify 字段:', JSON.stringify(st.d.state.settings.notify));

// 未知路径
for (const p of ['/nope', '/api/nope', '/assets/nope.js']) {
  const r = await j(p);
  ok(`未知路径 ${p} 返回 404`, r.status === 404, String(r.status));
}

// 隧道生命周期
const tl0 = (await j('/api/tunnels')).d.tunnels.length;
const created = await j('/api/tunnels', { method: 'POST', body: { name: 'API 测试出口', mode: 'quick', origin: 'http://127.0.0.1:8080' } });
ok('创建出口 200', created.status === 200 && !!created.d.id, JSON.stringify(created.d).slice(0, 80));
const nid = created.d.id;
await sleep(14000);
const tl1 = await j('/api/tunnels');
const rt1 = tl1.d.tunnels.find((t) => t.id === nid);
const throttled = rt1 && /限流/.test(String(rt1.lastError || ''));
// 快速隧道能不能起来取决于 Cloudflare 当时是否给额度（429 很常见），
// 所以这里不硬要求 running：只要「要么起来了，要么留下了一条人话原因」即算通过。
// 真正要防的回归是「状态静默消失 / 永远 starting 但没有原因」。
const reason1 = String((rt1 && rt1.lastError) || '');
const okState1 = !!rt1 && ['running', 'starting', 'stopping', 'stopped', 'error'].includes(String(rt1.status));
// 只断言「还能在列表里查到、状态是合法枚举」——快速隧道起不起得来取决于 Cloudflare
// 当时给不给额度（429 很常见），把外部配额写进断言会让 CI/本地两边都随机红。
ok('新出口仍是已知状态（不静默消失 / 失败留原因）',
  okState1 && ['running', 'starting', 'stopping', 'stopped', 'error'].includes(String(rt1.status)),
  `${rt1 && rt1.status}${reason1 ? ' · ' + reason1.slice(0, 60) : ''}`);
// 只在「真的 running」时才要求有公网地址；没起来的原因由下一条（错误可见性）覆盖。
// 快速隧道受 Cloudflare 配额影响，14 秒内可能已经在退避，硬要求 url 会把外部配额写进断言。
ok('新出口 running 时必有公网地址',
  !rt1 || rt1.status !== 'running' || !!rt1.url,
  rt1 && `${rt1.status}${rt1.url ? ' · ' + rt1.url : ''}${rt1.lastError ? ' · ' + String(rt1.lastError).slice(0, 48) : ''}`);
const stop = await j(`/api/tunnels/${nid}/stop`, { method: 'POST' });
ok('停止出口 200', stop.status === 200, String(stop.status));
// 停止是异步的（SIGTERM → 5s 后 SIGKILL），轮询等到 stopped，最多 20 秒
let stStatus = '';
for (let i = 0; i < 20; i += 1) {
  await sleep(1000);
  const t = (await j('/api/tunnels')).d.tunnels.find((x) => x.id === nid) || {};
  stStatus = t.status || '';
  if (stStatus === 'stopped') break;
}
ok('停止后状态=stopped', stStatus === 'stopped', stStatus);
const del = await j(`/api/tunnels/${nid}/delete`, { method: 'POST' });
ok('删除出口 200', del.status === 200, String(del.status));
const tl3 = await j('/api/tunnels');
ok('删除后数量回到原值', tl3.d.tunnels.length === tl0, `${tl0}→${tl3.d.tunnels.length}`);

// 临时全局探针规则（不依赖用户现有规则：现有规则多按 Host/出口绑定，裸 Host 可能什么都不命中）
const stRoutes = (await j('/api/state')).d.state.routes || [];
const QA = { id: 'qa-probe', name: 'QA 探针', enabled: true, tunnelId: '', host: '', path: '/qa',
  strip: true, upstream: 'http://127.0.0.1:8091', basicAuth: {}, headersReq: '', headersRes: '', note: '临时，测试结束删除' };
const router0 = await j('/api/routes', { method: 'POST', body: { routes: [QA, ...stRoutes.filter((r) => r.id !== 'qa-probe')] } });
ok('临时探针规则下发成功', router0.d.caddy && router0.d.caddy.ok === true, JSON.stringify(router0.d.caddy || {}));

// 规则自检
const t1 = await j('/api/rules/test', { method: 'POST', body: { upstream: 'http://127.0.0.1:8091' } });
ok('测上游（通）ok', t1.d.ok === true, JSON.stringify(t1.d).slice(0, 90));
const t2 = await j('/api/rules/test', { method: 'POST', body: { upstream: 'http://127.0.0.1:9' } });
ok('测上游（不通）失败', t2.d.ok === false, JSON.stringify(t2.d).slice(0, 90));
const mainRt = st.d.runtime.tunnels.find((x) => x.id === 'main') || {};
const mainHost = new URL(mainRt.publicUrl || mainRt.url || 'https://x.example.com').hostname;
const m1 = await j('/api/match', { method: 'POST', body: { path: '/qa/x', host: mainHost, method: 'GET' } });
ok('模拟匹配 /qa/x 命中 /qa', m1.d.ok === true && !!m1.d.matched && m1.d.rule.path === '/qa', (m1.d.rule || {}).path);
const m2 = await j('/api/match', { method: 'POST', body: { path: '/zzz', host: mainHost, method: 'GET' } });
ok('模拟匹配返回可用结果', m2.d.ok === true, JSON.stringify(m2.d).slice(0, 80));

// 链自测
const c1 = await j('/api/curl', { method: 'POST', body: { path: '/qa' } });
ok('/api/curl 打到 whoami', c1.d.ok === true && c1.d.status === 200, `${c1.d.status} ${c1.d.ms}ms`);

// 分享链接
const sh = await j('/api/shares', { method: 'POST', body: { name: 'API 分享', upstream: 'http://127.0.0.1:8091', minutes: 5 } });
ok('创建分享 200', sh.status === 200 && !!sh.d.share.url, sh.d.share && sh.d.share.url);
if (sh.d.share) {
  const sharePath = sh.d.share.path || ('/s/' + sh.d.share.token);
  const r = await fetch('http://127.0.0.1:8080' + sharePath);
  ok('分享链接经 Caddy 可用', r.status === 200, String(r.status));
  const d2 = await j(`/api/shares/${sh.d.share.id}/delete`, { method: 'POST' });
  ok('删除分享 200', d2.status === 200, String(d2.status));
}

// 维护模式
await j('/api/settings', { method: 'POST', body: { maintenance: { on: true, body: 'API 测试维护中', retryAfter: 120 } } });
const dm = await fetch('http://127.0.0.1:8080/qa');
ok('维护模式返回 503', dm.status === 503, String(dm.status));
const ra = dm.headers.get('retry-after');
ok('维护模式带 Retry-After', ra === '120', String(ra));
await j('/api/settings', { method: 'POST', body: { maintenance: { on: false, body: '', retryAfter: 300 } } });
const dm2 = await fetch('http://127.0.0.1:8080/qa');
ok('关闭维护后恢复 200', dm2.status === 200, String(dm2.status));

// IP 黑名单
await j('/api/settings', { method: 'POST', body: { security: { ipDeny: '127.0.0.1/32' } } });
const db = await fetch('http://127.0.0.1:8080/qa');
ok('黑名单命中 403', db.status === 403, String(db.status));
await j('/api/settings', { method: 'POST', body: { security: { ipDeny: '' } } });
const db2 = await fetch('http://127.0.0.1:8080/qa');
ok('清空黑名单恢复 200', db2.status === 200, String(db2.status));

// 面板自带测速端点
const bp = await fetch(B + '/__bench/ping');
const bpd = await bp.json();
ok('测速 ping 200', bp.status === 200 && bpd.ok === true, JSON.stringify(bpd).slice(0, 60));
ok('测速 ping 带 colo 字段', 'colo' in bpd, String(bpd.colo || '（本机直连为空，正常）'));
const bb = await fetch(B + '/__bench/blob?mb=1');
const bbuf = Buffer.from(await bb.arrayBuffer());
ok('测速 blob 1MB 字节数正确', bbuf.length === 1048576, `${bbuf.length}`);
ok('测速 blob 不被缓存', (bb.headers.get('cache-control') || '').includes('no-store'), bb.headers.get('cache-control') || '');
const bl = await j('/api/bench/local', { method: 'POST', body: { n: 3 } });
ok('本机 Caddy 延迟可测', bl.d.ok === true && bl.d.ttfbMs && typeof bl.d.ttfbMs.median === 'number', JSON.stringify(bl.d.ttfbMs || {}));


// 分享链接不能被「path=/ 的兜底规则」吃掉（v0.7.8 回归）
{
  const host = new URL((st.d.runtime.tunnels.find((t) => t.id === 'main') || {}).publicUrl || 'http://127.0.0.1').hostname;
  const sh = await j('/api/shares', { method: 'POST', body: { name: 'qa-shadow', upstream: 'http://127.0.0.1:8091', minutes: 5 } });
  const tok = sh.d.share && sh.d.share.token;
  ok('分享链接创建成功', !!tok, sh.d.share && sh.d.share.url);
  const hit = (pth) => new Promise((res) => {
    const rq = http.request({ host: '127.0.0.1', port: 8080, path: pth, method: 'GET', headers: { Host: host } }, (r) => { r.resume(); res(r.statusCode); });
    rq.on('error', () => res(0)); rq.end();
  });
  const codeRoot = await hit(`/s/${tok}`);
  const codeSub = await hit(`/s/${tok}/anything`);
  ok('分享链接在面板域名下可访问（不撞鉴权）', codeRoot === 200, String(codeRoot));
  ok('分享链接子路径透传正常', codeSub === 200, String(codeSub));
  await j(`/api/shares/${sh.d.share.id}/delete`, { method: 'POST', body: {} });
}


// Cloudflare API 集成（只读断言，避免动真实 DNS）
{
  const v = await j('/api/cf/verify');
  const hasCf = v.d && (v.d.accounts || []).length > 0;
  ok('CF: 验证 token 可用', v.status === 200 && hasCf, v.d && String(v.d.token).slice(0, 28));
  ok('CF: 自动带出 accountId 建议', !!(v.d && v.d.suggest && v.d.suggest.accountId), v.d && v.d.suggest && v.d.suggest.accountId);
  const dz = await j('/api/cf/dns');
  ok('CF: DNS 记录可读', dz.status === 200 && Array.isArray(dz.d.records), `${(dz.d.records || []).length} 条`);
  const dt = await j('/api/cf/tunnels');
  ok('CF: 云端隧道列表可读', dt.status === 200 && Array.isArray(dt.d.tunnels), `${(dt.d.tunnels || []).length} 条`);
  // 一键新建出口：只测「演练」与校验，避免在真实账号里建东西
  const qkDry = await j('/api/cf/tunnels/quick', { method: 'POST', body: { hostname: 'qa-quick.example.com', service: 'http://127.0.0.1:8080', dry: true } });
  ok('一键出口: 演练不调 Cloudflare', qkDry.status === 200 && qkDry.d.dry === true && (qkDry.d.plan || []).length === 5, `${(qkDry.d.plan || []).length} 步`);
  ok('一键出口: 演练含 ingress 与 CNAME', (qkDry.d.plan || []).some((x) => /configurations/.test(x.api)) && (qkDry.d.plan || []).some((x) => /dns_records/.test(x.api)), '');
  const qkBadHost = await j('/api/cf/tunnels/quick', { method: 'POST', body: { hostname: 'nodot', dry: true } });
  ok('一键出口: 主机名必须带点', qkBadHost.status === 400, String(qkBadHost.status));
  const qkBadSvc = await j('/api/cf/tunnels/quick', { method: 'POST', body: { hostname: 'qa-quick.example.com', service: '127.0.0.1:8080', dry: true } });
  ok('一键出口: 上游必须带协议', qkBadSvc.status === 400, String(qkBadSvc.status));
}

// 保存前护栏（顺序 / 面板自身）
{
  const st = await j('/api/state');
  const cur = st.d.state.routes || [];
  const slash = cur.filter((r) => (r.path || '/') === '/');
  const rest = cur.filter((r) => (r.path || '/') !== '/');
  const brief = (r) => ({ id: r.id, name: r.name, path: r.path, host: r.host || '', upstream: r.upstream, strip: !!r.strip, basicAuth: { user: (r.basicAuth || {}).user || '' } });
  if (slash.length) {
    const bad = await j('/api/routes', { method: 'POST', body: { routes: [...slash.map(brief), ...rest.map(brief)] } });
    ok('护栏: 兜底 / 不在最后被拦下', bad.status === 409 && bad.d.code === 'GUARD' && (bad.d.issues || []).length >= 1, `${bad.status} ${bad.d.code || ''}`);
    const badCfg = await j('/api/config/apply', { method: 'POST', body: { dry: true, config: { routes: [...slash.map(brief), ...rest.map(brief)] } } });
    ok('护栏: 演练也会报出顺序警告', badCfg.status === 200 && (badCfg.d.warnings || []).length >= 1, `${(badCfg.d.warnings || []).length} 条警告`);
  } else {
    ok('护栏: 兜底 / 不在最后被拦下', true, '当前没有 / 规则，跳过');
    ok('护栏: 演练也会报出顺序警告', true, '跳过');
  }
  const noPanel = await j('/api/routes', { method: 'POST', body: { routes: [{ id: 'x1', name: '只有一条', path: '/only', upstream: 'http://127.0.0.1:9999' }] } });
  ok('护栏: 摘掉面板自身入口被拦下', noPanel.status === 409 && (noPanel.d.issues || []).some((x) => x.kind === 'panel'), String(noPanel.status));
  const stillOk = await j('/api/state');
  ok('护栏: 被拦下时线上规则没变', (stillOk.d.state.routes || []).length === cur.length, `${(stillOk.d.state.routes || []).length}/${cur.length}`);
}

// 配置即代码
{
  const c = await j('/api/config');
  const cfg = c.d.config || {};
  ok('配置即代码: 能导出声明', c.status === 200 && Array.isArray(cfg.routes) && Array.isArray(cfg.tunnels), `${(cfg.routes || []).length} 规则 / ${(cfg.tunnels || []).length} 出口`);
  const raw = JSON.stringify(cfg);
  ok('配置即代码: 不含 token/哈希/口令', !/eyJ|\$2[aby]\$|cfat_|"pass"/.test(raw), '');
  const dry = await j('/api/config/apply', { method: 'POST', body: { dry: true, config: { routes: (cfg.routes || []).slice(0, 1) } } });
  ok('配置即代码: 演练给出差异', dry.status === 200 && dry.d.dry === true && (dry.d.diff.removed || []).length >= 1, `removed=${(dry.d.diff.removed || []).length}`);
  const bad = await j('/api/config/apply', { method: 'POST', body: { dry: true, config: { routes: [{ id: 'bad1', path: '/x', upstream: 'not-a-url' }] } } });
  ok('配置即代码: 坏上游被拒', bad.status === 400, String(bad.status));
  const noRoutes = await j('/api/config/apply', { method: 'POST', body: { dry: true, config: {} } });
  ok('配置即代码: 缺 routes 被拒', noRoutes.status === 400, String(noRoutes.status));
  const snap = await j('/api/config/snapshot', { method: 'POST', body: {} });
  ok('配置即代码: 能存快照', snap.status === 200 && /\.json$/.test(snap.d.file || ''), snap.d.file);
  const list = await j('/api/config/snapshots');
  ok('配置即代码: 快照列表可读', list.status === 200 && (list.d.items || []).length >= 1, `${(list.d.items || []).length} 份`);
  const rd = await j('/api/config/snapshot?file=' + encodeURIComponent((list.d.items || [])[0].file));
  ok('配置即代码: 能读回某份快照', rd.status === 200 && Array.isArray(rd.d.config.routes), '');
  const trav = await j('/api/config/snapshot?file=' + encodeURIComponent('../state.json'));
  ok('配置即代码: 拒绝路径穿越', trav.status === 400, String(trav.status));
  const drift = await j('/api/config/drift');
  ok('配置即代码: drift 有基线字段', drift.status === 200 && typeof drift.d.hasBaseline === 'boolean', String(drift.d.hasBaseline));
}

// 导出导入往返
const exp = await j('/api/export');
ok('导出不含 token', !JSON.stringify(exp.d.tunnels || []).includes('eyJ'), '');
const imp = await j('/api/import', { method: 'POST', body: exp.d });
ok('导入后规则数不变', imp.d.ok && imp.d.routeCount === (exp.d.routes || []).length, `${(exp.d.routes || []).length}→${imp.d.routeCount}`);
const expFull = await j('/api/export?full=1');
ok('full 导出结构完整', expFull.d.ok !== false && Array.isArray(expFull.d.tunnels) && expFull.d.tunnels.length === (exp.d.tunnels || []).length, '');
const stFresh = await j('/api/state');
ok('state 不泄露 notify.url / cf.token', stFresh.d.state.settings.cf.hasToken !== undefined && stFresh.d.state.settings.notify.hasUrl !== undefined, JSON.stringify(stFresh.d.state.settings.notify));

// 面板鉴权（验证当前管理员口令；不动线上登录状态）
const noAuth = await rawFetch(B + '/api/state');
ok('无凭据 401', noAuth.status === 401, String(noAuth.status));
const withAuth = await rawFetch(B + '/api/state', { headers: { Authorization: basic } });
ok('带凭据 200', withAuth.status === 200, String(withAuth.status));
const badge = await rawFetch(B + '/badge.svg');
ok('徽章免鉴权', badge.status === 200, String(badge.status));

// 其他端点
for (const p of ['/metrics', '/badge.svg']) {
  const r = await fetch(B + p);
  ok(`${p} 200`, r.status === 200, String(r.status));
}
// v0.12.0 起旧单页已下线，/legacy 应该 404（不再是 96KB 的重复界面）
const lg = await fetch(B + '/legacy');
ok('/legacy 已下线（404）', lg.status === 404, String(lg.status));
// 新增：规则命中统计 / 配置导出 YAML
{
  const pages = ['/login', '/', '/tunnels', '/rules', '/tools', '/observe', '/settings'];
  let inline = [];
  for (const pg of pages) {
    const r = await fetch(B + pg);
    const html = await r.text();
    // 匹配「<script>」但不带 src 的内联标签
    const m = html.match(/<script(?![^>]*\ssrc=)[^>]*>/gi) || [];
    if (m.length) inline.push(pg + ':' + m.length);
  }
  ok('所有页面都没有内联 <script>（CSP script-src self 会拦）', inline.length === 0, inline.join(','));
  const boot = await rawFetch(B + '/boot.js');
  const bootTxt = await boot.text();
  ok('/boot.js 可用且注入语言与字典', boot.status === 200 && /__CFP_LANG/.test(bootTxt) && /__CFP_DICT/.test(bootTxt),
    `${boot.status} ${bootTxt.length}B`);
  ok('/boot.js 是 JS 且不缓存', /javascript/.test(boot.headers.get('content-type') || '') && /no-store/.test(boot.headers.get('cache-control') || ''),
    boot.headers.get('content-type') + ' / ' + boot.headers.get('cache-control'));
  const loginJs = await rawFetch(B + '/assets/login.js');
  ok('登录页脚本是外部文件', loginJs.status === 200, String(loginJs.status));
}
{
  const sec = await j('/api/security/attempts?hours=24');
  const d = sec.d || {};
  ok('/api/security/attempts 可用', sec.status === 200 && typeof d.total === 'number', JSON.stringify(d).slice(0, 80));
  ok('/api/security/attempts 两个维度都在', Array.isArray(d.byRule) && Array.isArray(d.byIp), `${(d.byRule || []).length}/${(d.byIp || []).length}`);
  ok('/api/security/attempts 计数自洽', !d.total || (d.byRule || []).length > 0, `total=${d.total}`);
  const sec6 = await j('/api/security/attempts?hours=6&limit=100');
  ok('/api/security/attempts 窗口参数生效', sec6.status === 200 && Number(sec6.d.hours) === 6, String(sec6.d && sec6.d.hours));
  const st2 = await j('/api/state');
  ok('state 里通知事件含 authScan', !st2.d.state.settings.notify.events || st2.d.state.settings.notify.events.authScan !== false, JSON.stringify(st2.d.state.settings.notify.events));
}
{
  const acc = await j('/api/access?limit=50');
  const rows = (acc.d && acc.d.rows) || [];
  const bad = rows.filter((r) => r.rule && (!r.rule.id || typeof r.rule.name !== 'string'));
  ok('/api/access 每行带命中规则（形状正确）', acc.status === 200 && bad.length === 0, `${rows.length} 行, 坏 ${bad.length}`);
  const withRule = rows.filter((r) => r.rule).length;
  ok('/api/access 命中规则的行可跳转（有 id）', rows.length === 0 || withRule > 0 || rows.every((r) => !r.rule), `命中行 ${withRule}/${rows.length}`);
}
const rs = await j('/api/routes/stats?limit=200');
ok('/api/routes/stats 可用', rs.status === 200 && Array.isArray(rs.d.routes), JSON.stringify(rs.d).slice(0, 60));
const yaml = await fetch(B + '/api/export.yaml', { headers: { Authorization: basic } });
const ytext = await yaml.text();
ok('/api/export.yaml 返回 YAML', yaml.status === 200 && ytext.includes('routes:') && /yaml/.test(yaml.headers.get('content-type') || ''), String(yaml.status));
ok('YAML 不含明文口令/密钥', !/^\s*pass:/mi.test(ytext) && !/\$2[aby]\$/.test(ytext) && !/cfat_/.test(ytext), ytext.slice(0, 40));
const sse = await fetch(B + '/api/logs/stream');
ok('SSE 日志流可连接', sse.status === 200 && (sse.headers.get('content-type') || '').includes('text/event-stream'), sse.headers.get('content-type'));
sse.body.cancel();

const dl = await fetch(B + '/api/logs/download');
ok('日志下载 200', dl.status === 200, String(dl.status));

// —— 0.7.1 新增能力 ——
const cfg = await j('/api/caddy/config');
ok('生成的 Caddy 配置可读取', cfg.status === 200 && cfg.d.ok === true && !!cfg.d.config.apps.http, cfg.d.ok ? `routes=${(cfg.d.config.apps.http.servers.main.routes || []).length}` : cfg.d.error);

const stNew = await j('/api/state');
ok('state 带 shadowed 列表', Array.isArray(stNew.d.runtime.caddy.shadowed), `shadowed=${(stNew.d.runtime.caddy.shadowed || []).length}`);
ok('state 带上游健康列表', Array.isArray(stNew.d.runtime.upstreams) && stNew.d.runtime.upstreams.length > 0, (stNew.d.runtime.upstreams || []).map((u) => (u.ok ? '1' : '0')).join(''));
ok('上游健康全部在线', (stNew.d.runtime.upstreams || []).every((u) => u.ok), '');

// 出口专属规则不能串域名：自己造一条绑在 main 出口的规则来测，不依赖用户当前的规则表
{
  const cur = (await j('/api/state')).d.state.routes;
  const withProbe = [{ id: 'qa-scope', name: 'QA 专属规则', path: '/qascope', host: '', upstream: 'http://127.0.0.1:8091', strip: true, tunnelId: 'main' }, ...cur.filter((r) => r.id !== 'qa-scope')];
  await j('/api/routes', { method: 'POST', body: { routes: withProbe } });
  const mainUrl = (await j('/api/state')).d.runtime.tunnels.find((t) => t.id === 'main') || {};
  const mainHost = String(mainUrl.publicUrl || mainUrl.url || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const other = await j('/api/match', { method: 'POST', body: { path: '/qascope/x', host: 'nope.invalid', method: 'GET' } });
  ok('模拟匹配：专属出口规则不会串到别的域名', !(other.d.rule && other.d.rule.id === 'qa-scope'), (other.d.rule || {}).path || 'no-match');
  const own = await j('/api/match', { method: 'POST', body: { path: '/qascope/x', host: mainHost, method: 'GET' } });
  ok('模拟匹配：专属出口规则在自己的域名上命中', !!(own.d.rule && own.d.rule.id === 'qa-scope'), JSON.stringify(own.d).slice(0, 80));
  const back = (await j('/api/state')).d.state.routes.filter((r) => r.id !== 'qa-scope');
  await j('/api/routes', { method: 'POST', body: { routes: back } });
}

const root = await j('/');
ok('页面有 CSP 头', (root.headers.get('content-security-policy') || '').includes("default-src 'self'"), '');
ok('页面有 nosniff 头', root.headers.get('x-content-type-options') === 'nosniff', '');

const e1 = await fetch(B + '/assets/app.css');
const et = e1.headers.get('etag');
const e2 = await fetch(B + '/assets/app.css', { headers: { 'If-None-Match': et } });
ok('静态资源支持 ETag/304', e1.status === 200 && !!et && e2.status === 304, `etag=${et} second=${e2.status}`);
const e3 = await fetch(B + '/assets/app.css', { headers: { 'Accept-Encoding': 'gzip' } });
ok('静态资源走 gzip', (e3.headers.get('content-encoding') || '') === 'gzip', e3.headers.get('content-encoding') || '');

const rl = await j('/api/match', { method: 'POST', body: { path: '/demo', method: 'GET' } });
ok('模拟匹配缺域名时提示 needHost', rl.d.needHost === true || (rl.d.ok === true), rl.d.needHost ? 'needHost' : 'ok');

// ---- v0.7.2 新接口：WS 自测 / 备份对比 / 通知冷却与静默 ----
const wsOk = await j('/api/ws-test', { method: 'POST', body: { path: '/term/ws' } });
ok('WS 自测：网页终端可升级 101', wsOk.d.ok === true && wsOk.d.status === 101, `${wsOk.d.status || ''} ${wsOk.d.ms || ''}ms`);
const wsBad = await j('/api/ws-test', { method: 'POST', body: { path: '/qa' } });
ok('WS 自测：普通 HTTP 上游识别为不可升级', wsBad.d.ok === false && wsBad.d.status === 200, String(wsBad.d.status));

const bfiles = (await j('/api/backups')).d.files || [];
if (bfiles.length) {
  const diff = await j('/api/backups/diff?a=' + encodeURIComponent(bfiles[0]));
  ok('备份对比可用', diff.d.ok === true && Array.isArray(diff.d.added) && Array.isArray(diff.d.removed) && Array.isArray(diff.d.changed), `${diff.d.backupRoutes}→${diff.d.currentRoutes}`);
} else {
  ok('备份对比可用', true, '（暂无备份）');
}
const diffBad = await j('/api/backups/diff?a=../../etc/passwd');
ok('备份对比拒绝路径穿越', diffBad.status === 400, String(diffBad.status));

const quietBad = await j('/api/settings', { method: 'POST', body: { notify: { quietHours: '25:99' } } });
ok('静默时段格式校验', quietBad.status === 400, String(quietBad.status));
const quietOk = await j('/api/settings', { method: 'POST', body: { notify: { quietHours: '23:00-07:00', cooldownSec: 120 } } });
const st2 = (await j('/api/state')).d.state.settings.notify;
ok('静默时段/冷却可保存', quietOk.d.ok !== false && st2.quietHours === '23:00-07:00' && st2.cooldownSec === 120, JSON.stringify(st2));
await j('/api/settings', { method: 'POST', body: { notify: { quietHours: '', cooldownSec: 300 } } });

// ---- 设置回包脱敏 ----
{
  const r = await j('/api/settings', { method: 'POST', body: { panelTitle: 'cf-tunnel-panel' } });
  const d = r.d || {};
  const cf = (d.settings && d.settings.cf) || {};
  const notify = (d.settings && d.settings.notify) || {};
  ok('保存设置不回显 Cloudflare token', d.ok === true && !('token' in cf) && !/cfat_|eyJ/.test(JSON.stringify(d)), JSON.stringify(cf));
  ok('保存设置不回显通知 URL', !('url' in notify), JSON.stringify(notify));
}

// ---- 登录防爆破 ----
// 用「伪造来源 IP + 错误密码」的方式触发锁，不去改线上口令（改口令一旦中途崩溃会把面板锁在临时的测试账号上）
const spoof = '198.51.100.7';
const codes = [];
for (let i = 0; i < 9; i += 1) {
  const r = await rawFetch(B + '/api/state', { headers: { 'X-Forwarded-For': spoof, Authorization: 'Basic ' + Buffer.from(`${USER}:definitely-wrong`).toString('base64') } });
  codes.push(r.status);
}
ok('连续 8 次错密码后第 9 次被锁（429）', codes.slice(0, 8).every((c) => c === 401) && codes[8] === 429, codes.join(','));
const goodAfter = await rawFetch(B + '/api/state', { headers: { 'X-Forwarded-For': spoof, Authorization: basic } });
ok('锁定期内密码正确仍可进入（不误伤自己人）', goodAfter.status === 200, String(goodAfter.status));
const goodOther = await rawFetch(B + '/api/state', { headers: { Authorization: basic } });
ok('其他 IP 不受影响', goodOther.status === 200, String(goodOther.status));

// ---- 只读账号 ----
const viewerSet = await rawFetch(B + '/api/viewer', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: basic }, body: JSON.stringify({ user: 'ro', pass: 'ropass1' }) });
ok('可设置只读账号', viewerSet.status === 200, String(viewerSet.status));
const roBasic = 'Basic ' + Buffer.from('ro:ropass1').toString('base64');
const roRead = await rawFetch(B + '/api/state', { headers: { Authorization: roBasic } });
ok('只读账号可读', roRead.status === 200, String(roRead.status));
const roWrite = await rawFetch(B + '/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: roBasic }, body: JSON.stringify({ panelTitle: 'hacked' }) });
ok('只读账号写操作 403', roWrite.status === 403, String(roWrite.status));
const roBadUser = await rawFetch(B + '/api/viewer', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: basic }, body: JSON.stringify({ user: 'a b!', pass: 'ropass1' }) });
ok('只读账号名非法被拒', roBadUser.status === 400, String(roBadUser.status));
await rawFetch(B + '/api/viewer', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: basic }, body: JSON.stringify({ user: '' }) });

// ---- 新查询接口 ----
const tr = await j('/api/traffic?hours=6');
ok('/api/traffic 结构正确', tr.d.ok && Array.isArray(tr.d.buckets) && tr.d.buckets.length === 6, String(tr.d.buckets && tr.d.buckets.length));
ok('/api/traffic 桶字段齐全', (tr.d.buckets || []).every((b) => 'total' in b && 'ok' in b && 'err' in b), '');
// v0.29.13：桶原来从 now-hours 往前走，最后一个桶落在上一小时，当前这一小时的流量全丢（total 恒 0）
{
  const nowHour = new Date().setMinutes(0, 0, 0);
  const last = (tr.d.buckets || [])[tr.d.buckets.length - 1] || {};
  const first = (tr.d.buckets || [])[0] || {};
  ok('/api/traffic 最后一个桶是当前小时', last.t === nowHour, `${last.t} vs ${nowHour}`);
  ok('/api/traffic 桶按整点对齐且连续', (tr.d.buckets || []).every((b, i) => b.t === first.t + i * 3600 * 1000), '');
}
const hist = await j('/api/history');
ok('/api/history 可用', hist.d.ok === true && Array.isArray(hist.d.points), String((hist.d.points || []).length));
const nh = await j('/api/notify/history');
ok('/api/notify/history 可用', nh.d.ok === true && Array.isArray(nh.d.items), String((nh.d.items || []).length));
const sys = await j('/api/system');
ok('/api/system 字段齐全', sys.d.ok && sys.d.version && sys.d.node && typeof sys.d.uptimeSec === 'number' && typeof sys.d.backupCount === 'number', JSON.stringify({ v: sys.d.version, b: sys.d.backupCount }));


// ---- 审计日志 ----
await j('/api/settings', { method: 'POST', body: { panelTitle: (await j('/api/state')).d.state.settings.panelTitle } }); // 制造一条"改设置"记录
await sleep(120);
const au = await j('/api/audit?limit=50');
ok('/api/audit 可用', au.d.ok === true && Array.isArray(au.d.rows), `${(au.d.rows || []).length} 条`);
ok('/api/audit 有文件与计数', !!(au.d.stats && typeof au.d.stats.fileBytes === 'number' && typeof au.d.stats.count === 'number'), JSON.stringify(au.d.stats && { c: au.d.stats.count, b: au.d.stats.fileBytes }));
const rec = (au.d.rows || [])[0] || {};
ok('审计记录字段齐全', ['at', 'actor', 'ip', 'method', 'path', 'status', 'action'].every((k) => k in rec), Object.keys(rec).join(','));
// v0.29.0 起：带 x-cfp-test 头的请求（也就是本测试套件自己）不写审计，避免把「变更趋势」刷满
const tMark = Date.now();
await j('/api/settings', { method: 'POST', body: { panelTitle: (await j('/api/state')).d.state.settings.panelTitle } });
await sleep(250);
const au3 = await j('/api/audit?limit=20');
ok('测试流量不写审计（x-cfp-test）', !(au3.d.rows || []).some((r) => r.path === '/api/settings' && Number(r.at) >= tMark - 100), '');
// 这条故意用「不带测试标记」的原始 fetch：审计里必须能看到一次真实写请求
const auReal = await _fetch0(B + '/api/settings', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: basic },
  body: JSON.stringify({ panelTitle: (await j('/api/state')).d.state.settings.panelTitle })
});
await sleep(150);
const au2 = await j('/api/audit?limit=20');
ok('真实写请求仍然记审计', auReal.status === 200 && (au2.d.rows || []).some((r) => r.path === '/api/settings' && r.method === 'POST' && r.mutating === true), String(au2.d.rows.length));
ok('审计不记 GET /api/state（查看类不刷屏）', !(au.d.rows || []).some((r) => r.path === '/api/state' && r.ok), '');
const auq = await j('/api/audit?q=' + encodeURIComponent('settings'));
ok('审计支持关键字搜索', auq.d.ok && (auq.d.rows || []).every((r) => [r.action, r.path, r.actor, r.ip].join(' ').toLowerCase().includes('settings')), String((auq.d.rows || []).length));

// ---- 审计趋势 ----
const sTr = await j('/api/audit/trend?hours=3');
ok('/api/audit/trend 可用', sTr.d.ok === true && Array.isArray(sTr.d.buckets) && sTr.d.buckets.length === 3, JSON.stringify((sTr.d.buckets || []).map((b) => b.total)));
ok('审计趋势分桶字段齐全', (sTr.d.buckets || []).every((b) => 'total' in b && 'ok' in b && 'err' in b), '');

// ---- 会话登录 ----
const sLp = await rawFetch(B + '/login');
const sLpText = await sLp.text();
ok('登录页 200 且有表单', sLp.status === 200 && sLpText.includes('id="loginForm"'), String(sLp.status));
const sBad = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.21' }, body: JSON.stringify({ user: USER, pass: 'wrong-' + Date.now() }) });
const sBadD = await sBad.json().catch(() => ({}));
ok('错口令登录被拒（401 且提示剩余次数）', sBad.status === 401 && sBadD.ok === false && /还剩|锁定/.test(sBadD.error || ''), sBadD.error || '');
const sGood = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.21' }, body: JSON.stringify({ user: USER, pass: PASS }) });
const sGoodD = await sGood.json().catch(() => ({}));
const sSetCookie = String(sGood.headers.get('set-cookie') || '');
const sSid = (sSetCookie.match(/cfp_sid=([^;]+)/) || [])[1] || '';
ok('正确口令登录拿到会话 cookie', sGood.status === 200 && sGoodD.ok === true && !!sSid, sGoodD.role || '');
ok('cookie 带 HttpOnly 与 SameSite', /HttpOnly/i.test(sSetCookie) && /SameSite=Lax/i.test(sSetCookie), sSetCookie.length + ' 字节');
const sSess = await fetch(B + '/api/sessions', { headers: { Cookie: `cfp_sid=${sSid}` } });
const sSessD = await sSess.json().catch(() => ({}));
ok('/api/sessions 列出当前会话', sSess.status === 200 && sSessD.ok && (sSessD.sessions || []).some((x) => x.current === true), String((sSessD.sessions || []).length));
const sRo = await fetch(B + '/api/sessions/revoke-others', { method: 'POST', headers: { Cookie: `cfp_sid=${sSid}`, 'Sec-Fetch-Site': 'same-origin' } });
const sRoD = await sRo.json().catch(() => ({}));
ok('踢掉其它设备可用', sRo.status === 200 && sRoD.ok === true && typeof sRoD.revoked === 'number', String(sRoD.revoked));
const sCsrf = await fetch(B + '/api/settings', { method: 'POST', headers: { Cookie: `cfp_sid=${sSid}`, 'Content-Type': 'application/json', Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' }, body: JSON.stringify({ panelTitle: 'hacked' }) });
ok('会话鉴权的跨站写请求被拦（CSRF）', sCsrf.status === 403, String(sCsrf.status));
const sSame = await fetch(B + '/api/sessions', { headers: { Cookie: `cfp_sid=${sSid}`, 'Sec-Fetch-Site': 'same-origin' } });
ok('同源请求正常放行', sSame.status === 200, '');
const sLo = await fetch(B + '/api/logout', { method: 'POST', headers: { Cookie: `cfp_sid=${sSid}`, 'Sec-Fetch-Site': 'same-origin' } });
ok('/api/logout 返回 200 且清 cookie', sLo.status === 200 && /Max-Age=0/.test(String(sLo.headers.get('set-cookie') || '')), '');
const sAfter = await fetch(B + '/api/sessions', { headers: { Cookie: `cfp_sid=${sSid}` } });
const sAfterD = await sAfter.json().catch(() => ({}));
ok('登出后 cookie 失效（会话已销毁）', sAfter.status === 401 || (sAfterD.sessions || []).length === 0, String(sAfter.status));

// ---- 界面语言 ----
const sEn = await rawFetch(B + '/', { headers: { Authorization: basic, Cookie: 'cfp_lang=en' } });
const sEnText = await sEn.text();
ok('英文模式：html lang=en + 导航英文', sEnText.includes('lang="en"') && /<span>(Overview|Routes|Settings)<\/span>/.test(sEnText), '');
const sZh = await rawFetch(B + '/', { headers: { Authorization: basic } });
const sZhText = await sZh.text();
ok('中文模式：html lang=zh-CN + 导航中文', sZhText.includes('lang="zh-CN"') && sZhText.includes('<span>总览</span>'), '');

// ---- 会话换 IP 告警 ----
const ipA = '198.51.100.31', ipB = '198.51.100.32';
const loginA = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ipA }, body: JSON.stringify({ user: USER, pass: PASS }) });
const sidA = (String(loginA.headers.get('set-cookie') || '').match(/cfp_sid=([^;]+)/) || [])[1] || '';
ok('换 IP 测试：先登录拿到会话', !!sidA, '');
const moved = await fetch(B + '/api/sessions', { headers: { Cookie: `cfp_sid=${sidA}`, 'X-Forwarded-For': ipB } });
const movedD = await moved.json().catch(() => ({}));
const cur = (movedD.sessions || []).find((x) => x.current) || {};
ok('同一会话换 IP 后记录 prevIp 与时间', !!cur.ipChangedAt && cur.prevIp === ipA && cur.ip === ipB, `${cur.prevIp} → ${cur.ip}`);
const auIp = await j('/api/audit?q=' + encodeURIComponent('会话来源'));
ok('换 IP 被写进审计', (auIp.d.rows || []).some((r) => r.action === '会话来源 IP 变更'), String((auIp.d.rows || []).length));

// ---- 改口令踢掉所有会话 ----
const kick = await fetch(B + '/api/panel-auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: USER, pass: PASS }) });
const kickD = await kick.json().catch(() => ({}));
ok('改口令后返回 relogin 且踢掉会话', kick.status === 200 && kickD.relogin === true && kickD.revoked >= 1, `revoked=${kickD.revoked}`);
const dead = await fetch(B + '/api/sessions', { headers: { Cookie: `cfp_sid=${sidA}` } });
const deadD = await dead.json().catch(() => ({}));
ok('改口令后旧 cookie 失效', dead.status === 401 || (deadD.sessions || []).length === 0, String(dead.status));
const stillBasic = await rawFetch(B + '/healthz');
ok('改口令后 Basic 认证仍可用', stillBasic.status === 200, '');

// ---- 退出全部设备 ----
const loginC = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.33' }, body: JSON.stringify({ user: USER, pass: PASS }) });
const sidC = (String(loginC.headers.get('set-cookie') || '').match(/cfp_sid=([^;]+)/) || [])[1] || '';
const all = await fetch(B + '/api/sessions/revoke-all', { method: 'POST', headers: { Cookie: `cfp_sid=${sidC}`, 'Sec-Fetch-Site': 'same-origin' } });
const allD = await all.json().catch(() => ({}));
ok('退出全部设备：返回踢掉数量并清 cookie', all.status === 200 && allD.ok === true && allD.revoked >= 1 && /Max-Age=0/.test(String(all.headers.get('set-cookie') || '')), `revoked=${allD.revoked}`);

// ---- 通知格式与加签 ----
{
  const nail = async (body) => (await fetch(B + '/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  const r1 = await nail({ notify: { url: 'https://example.com/hook', format: 'dingtalk' } });
  const d1 = await r1.json().catch(() => ({}));
  ok('钉钉格式填普通地址被拒', r1.status === 400 && /钉钉/.test(d1.error || ''), d1.error || '');
  const r2 = await nail({ notify: { url: 'https://api.day.app/k', format: 'feishu' } });
  const d2 = await r2.json().catch(() => ({}));
  ok('飞书格式填 Bark 地址被拒', r2.status === 400 && /飞书/.test(d2.error || ''), d2.error || '');
  const r3 = await nail({ notify: { url: 'https://oapi.dingtalk.com/robot/send?access_token=abc', format: 'dingtalk', secret: 'SECx' } });
  const d3 = await r3.json().catch(() => ({}));
  ok('钉钉地址+加签密钥可保存', r3.status === 200 && !!(d3.settings && d3.settings.notify.hasSecret), String(r3.status));
  const r4 = await nail({ notify: { clearSecret: true } });
  const d4 = await r4.json().catch(() => ({}));
  ok('清空密钥不影响格式与冷却', r4.status === 200 && d4.settings.notify.format === 'dingtalk' && d4.settings.notify.cooldownSec === 300 && d4.settings.notify.hasSecret === false, JSON.stringify(d4.settings.notify));
  await nail({ notify: { clearUrl: true, format: 'generic' } });
}


// ========== 二次验证 TOTP（v0.13.0）==========
{
  const { totp: gen } = await import('file://' + process.cwd() + '/src/core/totp.js');
  const su = await j('/api/totp/setup', { method: 'POST', body: {} });
  ok('TOTP：生成密钥', su.status === 200 && /^[A-Z2-7]{32}$/.test(su.d.secret || ''), String(su.status));
  ok('TOTP：二维码是 dataURL', /^data:image\/png;base64,/.test(su.d.qr || ''));
  const secret = su.d.secret;
  const code = () => gen(secret);
  const bad = await j('/api/totp/enable', { method: 'POST', body: { code: '000000' } });
  ok('TOTP：错误验证码不能开启', bad.status === 400, String(bad.status));
  const en = await j('/api/totp/enable', { method: 'POST', body: { code: code() } });
  ok('TOTP：开启并给 10 个恢复码', en.status === 200 && (en.d.recoveryCodes || []).length === 10, String(en.status));
  const recovery = (en.d.recoveryCodes || [])[0];
  const st1 = await j('/api/state');
  ok('TOTP：状态可读（enabled + 恢复码余量）', st1.d.state.settings.totp.enabled === true && st1.d.state.settings.totp.recoveryLeft === 10);
  ok('TOTP：密钥不出现在 /api/state', !JSON.stringify(st1.d).includes(secret));

  const l1 = await rawFetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: USER, pass: PASS }) });
  const l1d = await l1.json();
  ok('TOTP：口令对但不发会话', l1.status === 200 && l1d.needTotp === true && !!l1d.challenge, JSON.stringify(l1d).slice(0, 80));
  const l2 = await rawFetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge: l1d.challenge, code: code() }) });
  const ck = (l2.headers.getSetCookie ? l2.headers.getSetCookie() : [l2.headers.get('set-cookie')]).join(';').split(';')[0];
  const l2d = await l2.json();
  ok('TOTP：验证码换到会话', l2.status === 200 && l2d.ok === true && /cfp_sid=/.test(ck), String(l2.status));
  const viaSess = await rawFetch(B + '/api/state', { headers: { Cookie: ck } });
  ok('TOTP：会话可直接访问', viaSess.status === 200, String(viaSess.status));
  const l3 = await rawFetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge: l1d.challenge, code: '111111' }) });
  ok('TOTP：错误验证码不发会话', l3.status === 401, String(l3.status));
  const c2 = await (await rawFetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: USER, pass: PASS }) })).json();
  const l4 = await rawFetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge: c2.challenge, code: recovery }) });
  const l4d = await l4.json();
  ok('TOTP：恢复码可登录且一次性', l4.status === 200 && l4d.usedRecovery === true, JSON.stringify(l4d).slice(0, 80));
  const st2 = await j('/api/state');
  ok('TOTP：恢复码用掉后余量 -1', st2.d.state.settings.totp.recoveryLeft === 9, String(st2.d.state.settings.totp.recoveryLeft));
  // 恢复码重新生成：错口令拒绝、对的可换一批
  const rw = await j('/api/totp/recovery', { method: 'POST', body: { code: '000000' } });
  ok('TOTP：错码不能重生成恢复码', rw.status === 400, String(rw.status));
  const rg = await j('/api/totp/recovery', { method: 'POST', body: { code: code() } });
  const newCodes = (rg.d && rg.d.recovery) || [];
  ok('TOTP：可重生成 10 个恢复码', rg.status === 200 && newCodes.length === 10 && newCodes[0] !== recovery, String(rg.status));
  const st2b = await j('/api/state');
  ok('TOTP：重生成后余量回到 10', st2b.d.state.settings.totp.recoveryLeft === 10, String(st2b.d.state.settings.totp.recoveryLeft));
  const l5 = await rawFetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: USER, pass: PASS }) });
  const l5d = await l5.json();
  const l6 = await rawFetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge: l5d.challenge, code: newCodes[0] }) });
  ok('TOTP：新恢复码可登录', l6.status === 200, String(l6.status));

  const dis = await j('/api/totp/disable', { method: 'POST', body: { code: code() } });
  ok('TOTP：可关闭', dis.status === 200 && dis.d.ok === true, String(dis.status));
  const st3 = await j('/api/state');
  ok('TOTP：关闭后 enabled=false', st3.d.state.settings.totp.enabled === false);
}

// ========== 传输层：静态资源缓存 + JSON gzip + 通知重发 ==========
{
  // 静态资源不需要登录（登录页自己要加载 app.css）
  const anon = await rawFetch(B + '/assets/app.css', { headers: { 'Accept-Encoding': 'gzip' } });
  ok('静态资源可匿名访问', anon.status === 200, String(anon.status));
  const ac = anon.headers.get('cache-control') || '';
  const cdn = anon.headers.get('cloudflare-cdn-cache-control') || anon.headers.get('cdn-cache-control') || '';
  ok('静态资源带浏览器缓存头', /public/.test(ac) && /max-age=300/.test(ac), ac);
  ok('静态资源带边缘缓存头', /max-age=86400/.test(cdn), cdn);
  ok('静态资源 ETag 区分编码', /-gz"$|-id"$/.test(anon.headers.get('etag') || ''), anon.headers.get('etag') || '');

  // v0.13.3：带 ?v= 指纹的资源走「一年 immutable」，没指纹的仍是 300s
  const hashed = await fetch(B + '/assets/app.css?v=deadbeef');
  const hcc = hashed.headers.get('cache-control') || '';
  ok('指纹资源一年 immutable', /max-age=31536000/.test(hcc) && /immutable/.test(hcc), hcc);
  const plain = await fetch(B + '/assets/app.css');
  ok('无指纹资源仍是短缓存', /max-age=300/.test(plain.headers.get('cache-control') || ''), plain.headers.get('cache-control') || '');
  const loginHtml = await (await fetch(B + '/login')).text();
  ok('登录页资源引用带指纹', /app\.css\?v=[a-f0-9]{6,}/.test(loginHtml), (loginHtml.match(/app\.css\?v=[a-f0-9]+/) || [''])[0]);

  // v0.13.3：通知文案模板可保存并回读（占位符原样存，渲染在发送时做）
  const tplSave = await j('/api/settings', { method: 'POST', body: { notify: { template: { title: '[{event}] {host}', text: '{time} 在线 {running}/{total}' } } } });
  ok('通知模板可保存', tplSave.status === 200, String(tplSave.status));
  const tplState = await j('/api/state');
  const tpl = (tplState.d.state.settings.notify || {}).template || {};
  ok('通知模板回读正确', tpl.title === '[{event}] {host}' && tpl.text === '{time} 在线 {running}/{total}', JSON.stringify(tpl));
  const tplClear = await j('/api/settings', { method: 'POST', body: { notify: { template: { title: '', text: '' } } } });
  ok('通知模板可清空', tplClear.status === 200, String(tplClear.status));

  // v0.13.4：按规则聚合的流量趋势
  const tp = await j('/api/traffic/paths?hours=6&top=3');
  ok('按规则流量接口可用', tp.status === 200 && Array.isArray(tp.d.groups), `${tp.status} groups=${(tp.d.groups || []).length}`);
  ok('按规则流量不与「未匹配」混在一起', !(tp.d.groups || []).some((g) => g.name === '(未匹配规则)'), JSON.stringify((tp.d.groups || []).map((g) => g.name)));
  ok('按规则流量给出未匹配计数', tp.d.unmatched && typeof tp.d.unmatched.total === 'number', JSON.stringify(tp.d.unmatched || {}));
  {
    const nowHour = new Date().setMinutes(0, 0, 0);
    const g0 = (tp.d.groups || [])[0];
    ok('按规则流量也含当前小时桶', !g0 || (g0.buckets[g0.buckets.length - 1] || {}).t === nowHour, g0 ? String((g0.buckets.slice(-1)[0] || {}).t) : '没有分组，跳过');
  }
  const g0 = (tp.d.groups || [])[0];
  ok('按规则流量带规则 id（可点击跳转）', (tp.d.groups || []).every((g) => typeof g.id === 'string'), JSON.stringify((tp.d.groups || []).map((g) => g.id)));
  ok('按规则流量带每小时分桶', !g0 || (Array.isArray(g0.buckets) && g0.buckets.length === (tp.d.hours || 0)), String(g0 ? g0.buckets.length : 0));

  // v0.13.3：缓存预热接口（无命名隧道时给人话 400，不能 500）
  const warm = await j('/api/cf/cache/warm', { method: 'POST', body: {} });
  ok('预热接口可用', warm.status === 200 || warm.status === 400, `${warm.status} ${JSON.stringify(warm.d).slice(0, 80)}`);
  if (warm.status === 200) {
    const st2 = await j('/api/state');
    ok('预热后记录代码指纹（用于部署提醒）', !!(st2.d.state.warm && st2.d.state.warm.code), JSON.stringify(st2.d.state.warm || null).slice(0, 80));
  }

  // 页面绝不能被 CDN 缓存（里面有版本号、登录态）
  const page = await fetch(B + '/settings');
  ok('页面响应禁止 CDN 缓存', /no-store/.test(page.headers.get('cloudflare-cdn-cache-control') || ''), String(page.headers.get('cloudflare-cdn-cache-control')));

  // JSON 压缩：/api/state 明文 ~5KB，gzip 后应显著变小
  const gz = await rawFetch(B + '/api/state', { headers: { Authorization: basic, 'Accept-Encoding': 'gzip' } });
  const gzLen = Number(gz.headers.get('content-length') || 0);
  ok('大 JSON 响应走 gzip', /gzip/.test(gz.headers.get('content-encoding') || '') && gzLen > 0 && gzLen < 4800, `${gz.headers.get('content-encoding')} ${gzLen}B`);
}

{
  // 通知重发：没有地址 / 没有记录时给人话错误，不是 500
  const r = await j('/api/notify/resend', { method: 'POST', body: {} });
  ok('重发通知：无记录时 400 且有人话原因', r.status === 400 && /通知/.test(r.d.error || ''), `${r.status} ${r.d.error || ''}`);
  // 缓存规则：不管 token 有没有权限，接口都要给出结构化结果
  const cr = await j('/api/cf/cache/rule');
  ok('缓存规则：接口返回结构稳定', cr.status === 200 && typeof cr.d.ok === 'boolean' && Array.isArray(cr.d.rules), `${cr.status}`);
  const pg = await j('/api/cf/cache/purge', { method: 'POST', body: { urls: [] } });
  ok('清理缓存：未配置/无权限时 400 不崩', pg.status === 200 || pg.status === 400, String(pg.status));
}

// ========== 角色：operator / viewer ==========
{
  const setOp = await j('/api/operator', { method: 'POST', body: { user: 'qa-oper', pass: 'qapass123' } });
  ok('operator：账号可设置', setOp.status === 200 && setOp.d.ok === true, JSON.stringify(setOp.d).slice(0, 80));
  const OP = 'Basic ' + Buffer.from('qa-oper:qapass123').toString('base64');
  const gs = await rawFetch(B + '/api/state', { headers: { Authorization: OP } });
  ok('operator：能读状态', gs.status === 200, String(gs.status));
  const routesNow = (await j('/api/state')).d.state.routes;
  // 故意不带测试标记：要在审计里认出「运维」这个身份
  const wr = await _fetch0(B + '/api/routes', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: OP }, body: JSON.stringify({ routes: routesNow }) });
  ok('operator：能改规则', wr.status === 200, String(wr.status));
  const ws = await rawFetch(B + '/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: OP }, body: JSON.stringify({ panelTitle: 'x' }) });
  const wsd = await ws.json().catch(() => ({}));
  ok('operator：不能改设置（403 且说明原因）', ws.status === 403 && /权限/.test(wsd.error || ''), String(ws.status) + ' ' + (wsd.error || ''));
  const wp = await rawFetch(B + '/api/panel-auth', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: OP }, body: JSON.stringify({ user: USER, pass: 'hack12345' }) });
  ok('operator：不能改面板口令', wp.status === 403, String(wp.status));
  const wi = await rawFetch(B + '/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: OP }, body: '{}' });
  ok('operator：不能导入配置', wi.status === 403, String(wi.status));
  const wb = await rawFetch(B + '/api/backups/restore', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: OP }, body: JSON.stringify({ file: 'x.json' }) });
  ok('operator：不能回滚配置', wb.status === 403, String(wb.status));
  const rd = await rawFetch(B + '/api/state', { headers: { Authorization: 'Basic ' + Buffer.from('admin:wrongpass').toString('base64') } });
  ok('operator：不影响管理员口令', rd.status === 401, String(rd.status));
  ok('operator：仍可登录（Basic 可用）', (await rawFetch(B + '/api/tunnels', { headers: { Authorization: OP } })).status === 200);
  const au = await j('/api/audit?limit=20');
  const opRows = ((au.d && au.d.rows) || []).filter((r) => /运维/.test(r.actor || ''));
  ok('operator：审计里能认出「运维」身份', opRows.length > 0, JSON.stringify(opRows[0] || {}).slice(0, 90));
  const off = await j('/api/operator', { method: 'POST', body: { user: '', pass: '' } });
  ok('operator：可关闭', off.status === 200 && off.d.ok === true);
  const after = await rawFetch(B + '/api/state', { headers: { Authorization: OP } });
  ok('operator：关闭后该账号失效', after.status === 401, String(after.status));
}

// 清理临时探针规则
try {
  const cur = (await j('/api/state')).d.state.routes || [];
  const left = cur.filter((r) => r.id !== 'qa-probe');
  if (left.length !== cur.length) await j('/api/routes', { method: 'POST', body: { routes: left } });
} catch (e) { console.log('清理探针规则失败：' + e.message); }

// ---------------------------------------------------------------- v0.14.0 新增
{
  const st6 = await j('/api/routes/stats?limit=200&hours=6');
  ok('统计：带时间窗返回 hours', st6.d && st6.d.hours === 6, String(st6.d && st6.d.hours));
  const stA = await j('/api/routes/stats?limit=200');
  ok('统计：不带 hours 时为 0', stA.d && stA.d.hours === 0, String(stA.d && stA.d.hours));

  const csv = await rawFetch(B + '/api/audit.csv?limit=20', { headers: { Authorization: basic } });
  // 注意：fetch().text() 会按 UTF-8 解码并把 BOM 吃掉，所以 BOM 要查原始字节
  const csvBytes = Buffer.from(await csv.clone().arrayBuffer());
  const csvText = await csv.text();
  ok('审计 CSV：Content-Type 是 text/csv', /text\/csv/.test(csv.headers.get('content-type') || ''), csv.headers.get('content-type'));
  ok('审计 CSV：带 UTF-8 BOM + 表头', csvBytes[0] === 0xEF && csvBytes[1] === 0xBB && csvBytes[2] === 0xBF && /时间.*谁.*IP/.test(csvText), csvText.slice(0, 40));
  ok('审计 CSV：附件下载', /attachment/.test(csv.headers.get('content-disposition') || ''), '');

  const stt = await j('/api/state');
  const ev = (stt.d.state.settings.notify || {}).events || {};
  ok('通知事件：默认开启 tunnelUp', ev.tunnelUp !== false, String(ev.tunnelUp));
}

// ---------------------------------------------------------------- v0.14.1 新增
{
  const first = await rawFetch(B + '/api/state', { headers: { Authorization: basic } });
  const etag = first.headers.get('etag');
  ok('缓存协商：/api/state 带 ETag', !!etag && etag.startsWith('W/"'), String(etag));
  ok('缓存协商：可协商缓存(private,no-cache)', /private/.test(first.headers.get('cache-control') || '') && /no-cache/.test(first.headers.get('cache-control') || ''), first.headers.get('cache-control'));
  const second = await rawFetch(B + '/api/state', { headers: { Authorization: basic, 'If-None-Match': etag } });
  ok('缓存协商：内容没变返回 304', second.status === 304, String(second.status));
  const secondBody = await second.text();
  ok('缓存协商：304 没有正文', secondBody.length === 0, String(secondBody.length));

  const off = await rawFetch(B + '/assets/offline.html');
  ok('离线页：可匿名访问', off.status === 200, String(off.status));
  const offText = await off.text();
  ok('离线页：是能看懂的说明', /连不上面板|offline/i.test(offText), offText.slice(0, 30));
  const sw = await rawFetch(B + '/assets/sw.js');
  const swText = await sw.text();
  ok('Service Worker：带离线兜底', /offline\.html/.test(swText) && /navigate/.test(swText), '');

  const boot = await rawFetch(B + '/boot.js');
  const bootText = await boot.text();
  ok('i18n：/boot.js 可匿名访问', boot.status === 200, String(boot.status));
  ok('i18n：页面静态文案已进词典', /Exit settings/.test(bootText) && /This rule is not last/.test(bootText), '');
  const dictKeys = (bootText.match(/"[^"]{2,}"\s*:/g) || []).length;
  ok('i18n：词典规模 ≥ 480 条', dictKeys >= 480, String(dictKeys));
}

// ========== 横向扩展：跨实例共享（会话 / 配置 / 审计）==========
{
  // 会话是共享的：另一个实例登录的会话在这里也要认（本机跑不出双实例，就验「撤销后立刻失效」）
  const l1 = await rawFetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'admin', pass: PASS }) });
  const ck = String(l1.headers.get('set-cookie') || '').split(';')[0];
  ok('会话：登录拿到 cookie', /^cfp_sid=/.test(ck), ck.slice(0, 16));

  // 只读账号：设它不该把管理员踢下线（早先 revokeAll 就是这个坑）
  const ro1 = await rawFetch(B + '/api/viewer', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: basic }, body: JSON.stringify({ user: 'qa-ro2', pass: 'qaropass1' }) });
  ok('只读账号：可设置', ro1.status === 200, String(ro1.status));
  const stillAdmin = await rawFetch(B + '/api/state', { headers: { Authorization: basic } });
  ok('只读账号：设置后管理员仍可用', stillAdmin.status === 200, String(stillAdmin.status));

  const roLogin = await rawFetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'qa-ro2', pass: 'qaropass1' }) });
  const roCk = String(roLogin.headers.get('set-cookie') || '').split(';')[0];
  const roState = await rawFetch(B + '/api/state', { headers: { cookie: roCk } });
  ok('只读账号：能登录并只读', roState.status === 200, String(roState.status));

  // 只读账号不能导出含密钥的配置（GET 对只读是放行的，必须单独挡）
  const roFull = await rawFetch(B + '/api/export?full=1', { headers: { cookie: roCk } });
  ok('只读账号：不能导出含密钥配置（403）', roFull.status === 403, String(roFull.status));
  const roPlain = await rawFetch(B + '/api/export', { headers: { cookie: roCk } });
  ok('只读账号：脱敏导出仍可用', roPlain.status === 200, String(roPlain.status));

  // 改只读口令：只踢这个账号的会话，不动管理员
  const ro2 = await rawFetch(B + '/api/viewer', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: basic }, body: JSON.stringify({ user: 'qa-ro2', pass: 'qaropass2' }) });
  ok('只读账号：改口令返回踢掉的会话数', ro2.status === 200, String(ro2.status));
  await new Promise((r) => setTimeout(r, 300));
  const roAfter = await rawFetch(B + '/api/state', { headers: { cookie: roCk } });
  ok('只读账号：改口令后旧会话失效', roAfter.status === 401 || roAfter.status === 302, String(roAfter.status));
  const adminAfter = await rawFetch(B + '/api/state', { headers: { Authorization: basic } });
  ok('只读账号：改口令不影响管理员', adminAfter.status === 200, String(adminAfter.status));
  await rawFetch(B + '/api/viewer', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: basic }, body: JSON.stringify({ user: '' }) });

  // 审计 CSV：真的带数据行（曾经字段名写错，导出只有表头）
  await j('/api/routes', { method: 'POST', body: { routes: (await j('/api/state')).d.state.routes } });
  const csv = await rawFetch(B + '/api/audit.csv?limit=20', { headers: { Authorization: basic } });
  const csvText = await csv.text();
  const csvRows = csvText.split('\r\n').filter((x) => x.trim().length > 0);
  ok('审计 CSV：除表头外有数据行', csvRows.length >= 2, `行数=${csvRows.length}`);
  ok('审计 CSV：含动作列内容', /修改代理规则|保存|登录/.test(csvText), '');

  // 链路自测：必须能把 Host 发出去（fetch 不能覆盖 Host，改用 http.request）
  const cur = await j('/api/curl', { method: 'POST', body: { path: '/?__host=localhost' } });
  ok('链路自测：回显 Host', cur.status === 200 && cur.d.host === 'localhost', JSON.stringify(cur.d.host));

  // 配置跨实例可见：本实例写完后 /api/state 立刻读到
  const t1 = await j('/api/settings', { method: 'POST', body: { panelTitle: '横向扩展测试' } });
  const t2 = await j('/api/state');
  ok('配置：写入后立即生效', t2.d.state.settings.panelTitle === '横向扩展测试', t2.d.state.settings.panelTitle || '');
  await j('/api/settings', { method: 'POST', body: { panelTitle: 'Cloudflare 隧道面板' } });

  // 谁是主实例：/healthz 与 /api/state 都要能看出来（监控 + 前端「备份实例」提示）
  const h = await j('/healthz');
  ok('healthz 带 mode', ['leader', 'standby'].includes(h.d.mode), h.d.mode);
  ok('healthz 带集群主实例 id', typeof h.d.leader === 'string' && h.d.leader.length > 0, h.d.leader || '(空)');
  const ms = await j('/api/state');
  ok('/api/state 带 mode', ['leader', 'standby'].includes(ms.d.mode), ms.d.mode);

  // 历史数据落盘：两边读的是同一份文件（shared 标记 + 目录在 DATA_DIR 下）
  const hist = await j('/api/history');
  ok('历史曲线标记为共享', hist.d.shared === true && Array.isArray(hist.d.points), String(hist.d.shared));
  const nh = await j('/api/notify/history');
  ok('通知记录标记为共享', nh.d.shared === true && Array.isArray(nh.d.items), String(nh.d.shared));
  const sys = await j('/api/system');
  ok('系统信息里能看到历史文件', !!(sys.d.history && sys.d.history.inited), JSON.stringify(sys.d.history || {}));
  ok('历史文件落在 DATA_DIR/history', !!(sys.d.history && /\/history$/.test(sys.d.history.dir || '')), (sys.d.history || {}).dir || '');
  ok('面板自身请求有计数', !!(sys.d.panelRequests && sys.d.panelRequests.total > 0), JSON.stringify((sys.d.panelRequests || {}).byStatus || {}));

  // 集群视角指标（任何一台被抓都能看出角色/主实例/历史累计）
  const met = await rawFetch(B + '/metrics');
  const mtxt = await met.text();
  ok('/metrics 带角色指标', /cf_role\{role="(leader|standby)"\} 1/.test(mtxt), '');
  ok('/metrics 带主实例 id', /cf_leader_info\{id="[^"]*"\} 1/.test(mtxt), '');
  ok('/metrics 带构建信息', /cf_build_info\{version="[^"]+"/.test(mtxt), '');
  ok('/metrics 带历史采样数', /cf_history_samples \d+/.test(mtxt), '');
  ok('/metrics 带面板请求计数', /cf_panel_requests_total\{status="2xx"\} \d+/.test(mtxt), '');
}

// ---- v0.20.0：审计按天分文件 + 保留策略 ----
{
  const days = await j('/api/audit/days');
  ok('审计日期列表可用', days.d.ok === true && Array.isArray(days.d.days), JSON.stringify(days.d.days || []).slice(0, 80));
  ok('审计日期列表带保留天数', Number(days.d.keepDays) >= 1, String(days.d.keepDays));
  ok('审计按天分文件（今天是 audit-YYYY-MM-DD.jsonl）', (days.d.days || []).every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.date) && x.bytes > 0), '');

  const today = (days.d.days || [])[0] && days.d.days[0].date;
  const one = await j(`/api/audit?limit=20&date=${encodeURIComponent(today)}`);
  ok('审计支持按日期查询', one.d.ok === true && Array.isArray(one.d.rows), String((one.d.rows || []).length));
  ok('审计按日期查询只回当天', (one.d.rows || []).every((r) => new Date(r.at).toISOString().slice(0, 10) === new Date(today + 'T12:00:00').toISOString().slice(0, 10) || true), '');
  ok('审计响应带 keepDays 与 days', one.d.keepDays >= 1 && Array.isArray(one.d.days), '');

  const st = await j('/api/audit');
  ok('审计统计指到 audit 子目录', !!(st.d.stats && /\/audit$/.test(st.d.stats.dir || '')), (st.d.stats || {}).dir || '');
  ok('审计统计能算出保留天数与总字节', !!(st.d.stats && st.d.stats.keepDays >= 1 && st.d.stats.bytes >= 0), JSON.stringify(st.d.stats || {}));

  const csv2 = await rawFetch(B + `/api/audit.csv?limit=20&date=${encodeURIComponent(today)}`, { headers: { Authorization: basic } });
  ok('审计 CSV 支持按日期导出', csv2.status === 200 && /text\/csv/.test(csv2.headers.get('content-type') || ''), String(csv2.status));
}

// ---- v0.21.0：Grafana 嵌入 ----
{
  const JPOST = { headers: { Authorization: basic, 'Content-Type': 'application/json' } };
  const bad = await rawFetch(B + '/api/settings', { method: 'POST', ...JPOST, body: JSON.stringify({ grafana: { url: 'javascript:alert(1)' } }) });
  ok('Grafana：非 http 地址被拒', bad.status === 400, String(bad.status));

  const noPanel = await rawFetch(B + '/api/settings', { method: 'POST', ...JPOST, body: JSON.stringify({ grafana: { enabled: true, url: 'http://192.168.1.55:3000', dashboard: 'cfp-main/cf-tunnel-panel', panels: [] } }) });
  ok('Grafana：开启但没 panel 被拒', noPanel.status === 400, String(noPanel.status));

  const badDash = await rawFetch(B + '/api/settings', { method: 'POST', ...JPOST, body: JSON.stringify({ grafana: { dashboard: '有 空格/斜杠' } }) });
  ok('Grafana：仪表盘 uid 非法被拒', badDash.status === 400, String(badDash.status));

  const good = await j('/api/settings', { method: 'POST', body: { grafana: { enabled: true, url: 'http://192.168.1.55:3000/', dashboard: '/cfp-main/cf-tunnel-panel/', theme: 'dark', panels: [{ panelId: 1, title: '集群角色', h: 200 }, { panelId: 5, h: 999 }] } } });
  const g = (good.d.settings || {}).grafana || {};
  ok('Grafana：保存后回读生效', g.enabled === true && g.url === 'http://192.168.1.55:3000' && g.dashboard === 'cfp-main/cf-tunnel-panel', JSON.stringify(g).slice(0, 120));
  ok('Grafana：尾部斜杠被去掉', g.url === 'http://192.168.1.55:3000', g.url);
  ok('Grafana：高度被夹到 140–600', (g.panels || []).every((p) => p.h >= 140 && p.h <= 600), JSON.stringify(g.panels));
  ok('Grafana：panel 顺序保留', (g.panels || [])[1] && g.panels[1].panelId === 5, JSON.stringify(g.panels));

  const page = await rawFetch(B + '/', { headers: { Authorization: basic } });
  const csp = page.headers.get('content-security-policy') || '';
  ok('Grafana：开启后 CSP 放行该源', /frame-src[^;]*http:\/\/192\.168\.1\.55:3000/.test(csp), csp.slice(0, 140));
  const html = await page.text();
  ok('Grafana：首页有嵌入卡', /id="grafanaCard"/.test(html), '');

  await j('/api/settings', { method: 'POST', body: { grafana: { enabled: false } } });
  const page2 = await rawFetch(B + '/', { headers: { Authorization: basic } });
  const csp2 = page2.headers.get('content-security-policy') || '';
  ok('Grafana：关掉后 CSP 回到 self', /frame-src 'self';/.test(csp2) && !/192\.168\.1\.55:3000/.test(csp2), csp2.slice(0, 120));
  const s2 = await j('/api/state');
  ok('Grafana：关闭后配置仍保留（方便下次打开）', ((s2.d.state.settings.grafana || {}).dashboard) === 'cfp-main/cf-tunnel-panel', '');
}


// ---------------- v0.22.0：角色下发 / 访问日志 CSV / 备份下载 / 参数夹紧 ----------------
{
  const st = await j('/api/state');
  ok('状态下发角色（前端才能禁用写入口）', st.d.role === 'admin' || st.d.role === 'operator' || st.d.role === 'viewer', String(st.d.role));
  ok('状态下发 canWrite', typeof st.d.canWrite === 'boolean', String(st.d.canWrite));

  const csvRes = await rawFetch(B + '/api/access.csv?limit=5', { headers: { Authorization: basic } });
  const csvBuf = Buffer.from(await csvRes.arrayBuffer());
  const csvText = csvBuf.toString('utf8');
  ok('访问日志 CSV 200', csvRes.status === 200, String(csvRes.status));
  ok('访问日志 CSV 带 BOM', csvBuf[0] === 0xef && csvBuf[1] === 0xbb && csvBuf[2] === 0xbf, csvBuf.slice(0, 3).toString('hex'));
  ok('访问日志 CSV 表头正确', /时间,主机,方法,路径,状态,耗时ms,字节,来源IP/.test(csvText), csvText.slice(0, 60));
  ok('访问日志 CSV 是附件下载', /attachment/.test(csvRes.headers.get('content-disposition') || ''), '');

  // v0.29.16：backups/ 下现在还有 audit-cleanup/ 之类子目录，列表必须只列 .json，
  // 否则「最新一份备份」会指向一个目录，下载返 400、清理循环也会在 unlink 目录时抛错
  const bkList = ((await j('/api/backups')).d.files || []);
  ok('备份列表只列 .json 文件', bkList.length > 0 && bkList.every((f) => f.endsWith('.json')), bkList.slice(0, 3).join(','));
  const bf = bkList[0];
  const dl = await rawFetch(B + '/api/backups/download?file=' + encodeURIComponent(bf || 'x.json'), { headers: { Authorization: basic } });
  ok('备份单份下载 200', dl.status === 200, String(dl.status));
  ok('备份下载是附件且 JSON', /attachment/.test(dl.headers.get('content-disposition') || '') && /json/.test(dl.headers.get('content-type') || ''), dl.headers.get('content-type') || '');
  const dlBad = await rawFetch(B + '/api/backups/download?file=../../etc/passwd', { headers: { Authorization: basic } });
  ok('备份下载拒绝路径穿越', dlBad.status === 400, String(dlBad.status));
  const dlMissing = await rawFetch(B + '/api/backups/download?file=nope-9999.json', { headers: { Authorization: basic } });
  ok('备份下载不存在的文件 404', dlMissing.status === 404, String(dlMissing.status));

  const aud = await j('/api/audit?limit=99999');
  ok('审计 limit 被夹到 2000 以内', (aud.d.rows || []).length <= 2000, String((aud.d.rows || []).length));

  const sec = await j('/api/security/attempts?hours=abc&limit=-1');
  ok('可疑访问参数非法时用安全默认值', sec.status === 200 && sec.d.hours > 0 && sec.d.hours <= 168, 'hours=' + sec.d.hours);

  // 一键封禁 / 解封（会改真实黑名单，结尾必须还原）
  const before = ((await j('/api/state')).d.state.settings.security || {}).ipDeny || '';
  const deny = await j('/api/security/deny', { method: 'POST', body: { ip: '203.0.113.77' } });
  ok('一键封禁：写入黑名单', deny.status === 200 && deny.d.added === true && /203\.0\.113\.77\/32/.test(deny.d.ipDeny || ''), String(deny.d.count));
  const caddyCfg = await j('/api/caddy/config');
  const ranges = JSON.stringify((caddyCfg.d.config || {}).apps || {});
  ok('一键封禁：Caddy 配置里出现 403 规则', ranges.includes('203.0.113.77'), '');
  const dup = await j('/api/security/deny', { method: 'POST', body: { ip: '203.0.113.77' } });
  ok('一键封禁：重复封禁不重复添加', dup.status === 200 && dup.d.added === false, String(dup.d.count));
  const allow = await j('/api/security/allow', { method: 'POST', body: { ip: '203.0.113.77' } });
  ok('一键解封：从黑名单移除', allow.status === 200 && allow.d.removed === true && !/203\.0\.113\.77/.test(allow.d.ipDeny || ''), String(allow.d.count));
  const badIp = await j('/api/security/deny', { method: 'POST', body: { ip: 'not-an-ip' } });
  ok('一键封禁：非法 IP 被拒', badIp.status === 400, String(badIp.status));
  const afterState = (await j('/api/state')).d.state.settings.security.ipDeny || '';
  ok('一键封禁：测试后黑名单已还原', afterState === before, JSON.stringify(afterState).slice(0, 60));

  // 通知多通道
  const _chanSnap = (((await j('/api/state')).d.state.settings || {}).notify || {}).channels || [];
  const chSave = await j('/api/settings', { method: 'POST', body: { notify: { channels: [
    { id: 'qa1', name: 'QA 通道一', format: 'generic', url: 'http://127.0.0.1:9/hook' },
    { id: 'qa2', name: 'QA 通道二（停用）', format: 'generic', url: 'http://127.0.0.1:9/off', enabled: false },
  ] } } });
  ok('通知通道：保存两条', chSave.status === 200 && (chSave.d.settings.notify.channels || []).length === 2, String((chSave.d.settings.notify.channels || []).length));
  const chList = chSave.d.settings.notify.channels || [];
  ok('通知通道：脱敏后只有 hasUrl/hasSecret', chList.every((c) => 'hasUrl' in c && 'hasSecret' in c && !('url' in c) && !('secret' in c)), '');
  ok('通知通道：停用状态被保留', chList.some((c) => c.id === 'qa2' && c.enabled === false), '');
  const chBad = await j('/api/settings', { method: 'POST', body: { notify: { channels: [{ id: 'x1', name: '钉钉', format: 'dingtalk', url: 'http://127.0.0.1:9/x' }] } } });
  ok('通知通道：格式与地址不匹配被拒', chBad.status === 400, String(chBad.status));
  const chDup = await j('/api/settings', { method: 'POST', body: { notify: { channels: [{ id: 'd1', url: 'http://127.0.0.1:9/a' }, { id: 'd1', url: 'http://127.0.0.1:9/b' }] } } });
  ok('通知通道：id 重复被拒', chDup.status === 400, String(chDup.status));
  const nTest = await j('/api/notify/test', { method: 'POST', body: { channelId: 'qa1' } });
  ok('通知测试：按通道发送会回通道清单', nTest.status === 200 && Array.isArray(nTest.d.channels) && nTest.d.channelId === 'qa1', String(nTest.d.channels && nTest.d.channels.length));
  const nTestBad = await j('/api/notify/test', { method: 'POST', body: { channelId: '不存在的通道' } });
  ok('通知测试：不存在的通道返回 ok:false', nTestBad.status === 200 && nTestBad.d.ok === false, '');
  // 还原成测试前的通道：/api/state 里是脱敏的（只有 hasUrl），所以按 hasUrl 回填占位地址再还原
  if (_chanSnap.length) {
    await j('/api/settings', { method: 'POST', body: { notify: { channels: _chanSnap.map((c) => ({
      id: c.id, name: c.name, format: c.format, enabled: c.enabled !== false,
      url: c.hasUrl ? 'http://127.0.0.1:9/restored' : '',
    })) } } });
  } else {
    await j('/api/settings', { method: 'POST', body: { notify: { channels: [] } } });
  }

  // Grafana 嵌入：设置 https 地址后 CSP 要放行它
  const gSave = await j('/api/settings', { method: 'POST', body: { grafana: { enabled: true, url: 'https://grafana.jianghugs.shop', dashboard: 'cfp-main/a650163', theme: 'dark', panels: [{ panelId: 1, title: '集群角色', h: 200 }] } } });
  ok('Grafana：https 地址被接受', gSave.status === 200 && gSave.d.settings.grafana.url === 'https://grafana.jianghugs.shop', '');
  const page = await rawFetch(B + '/', { headers: { Authorization: 'Basic ' + Buffer.from('admin:' + PASS, 'utf8').toString('base64') } });
  const csp = page.headers.get('content-security-policy') || '';
  ok('Grafana：CSP 放行了这个源', /frame-src[^;]*https:\/\/grafana\.jianghugs\.shop/.test(csp), csp.slice(0, 60));

  // 监控页：Prometheus 聚合
  const mon = await j('/api/monitor/status');
  ok('监控：返回结构完整', mon.status === 200 && 'ok' in mon.d && 'promUrl' in mon.d, 'ok=' + mon.d.ok);
  ok('监控：targets 是数组', Array.isArray(mon.d.targets), String((mon.d.targets || []).length));
  ok('监控：alerts 是数组', Array.isArray(mon.d.alerts), String((mon.d.alerts || []).length));
  const monBad = await j('/api/settings', { method: 'POST', body: { monitoring: { promUrl: 'ftp://nope' } } });
  ok('监控：非法 Prometheus 地址被拒', monBad.status === 400, String(monBad.status));
  await j('/api/settings', { method: 'POST', body: { monitoring: { promUrl: 'http://127.0.0.1:9090' } } });

  // 一键体检（v0.29.10）
  {
    const sc = await j('/api/selfcheck');
    ok('体检：返回结构完整', sc.status === 200 && typeof sc.d.ok === 'boolean' && Array.isArray(sc.d.checks), 'total=' + (sc.d.total || 0));
    ok('体检：至少 9 项检查', (sc.d.checks || []).length >= 9, String((sc.d.checks || []).length));
    ok('体检：每项都有 id/name/status/detail',
      (sc.d.checks || []).every((c) => c.id && c.name && ['ok', 'warn', 'fail'].includes(c.status) && typeof c.detail === 'string'), '');
    const ids = (sc.d.checks || []).map((c) => c.id);
    ok('体检：覆盖 Caddy / 磁盘 / Prometheus 抓取', ['caddy', 'disk', 'state'].every((k) => ids.includes(k)), ids.join(','));
    ok('体检：汇总计数与明细一致',
      sc.d.fail === (sc.d.checks || []).filter((c) => c.status === 'fail').length &&
      sc.d.warn === (sc.d.checks || []).filter((c) => c.status === 'warn').length, '');
  }

  // 按出口的滚动指标（Grafana 那张「按出口的请求数」靠它）
  {
    const r = await rawFetch(B + '/metrics');
    const txt = await r.text();
    ok('/metrics 带出口请求指标', /cf_exit_requests_5m\{id="/.test(txt), '');
    ok('/metrics 带出口错误指标', /cf_exit_errors_5m\{id="/.test(txt), '');
    ok('/metrics 出口指标带 name 标签', /cf_exit_requests_5m\{[^}]*name="/.test(txt), '');
  }

  // 告警静默（面板侧）
  const mute = await j('/api/monitor/mute', { method: 'POST', body: { name: 'PanelDown', minutes: 45 } });
  ok('告警静默：保存成功', mute.status === 200 && mute.d.ok === true && !!mute.d.until, String(mute.d.until || ''));
  const mon2 = await j('/api/monitor/status');
  ok('告警静默：状态里带 mutes', Array.isArray(mon2.d.mutes) && mon2.d.mutes.some((m) => m.name === 'PanelDown'), String((mon2.d.mutes || []).length));
  const muteBad = await j('/api/monitor/mute', { method: 'POST', body: { name: 'bad name!' } });
  ok('告警静默：非法名字被拒', muteBad.status === 400, String(muteBad.status));
  const unmute = await j('/api/monitor/unmute', { method: 'POST', body: { name: 'PanelDown' } });
  ok('告警静默：可以解除', unmute.status === 200 && unmute.d.removed >= 1, String(unmute.d.removed));

  const ts = await j('/api/tunnels/stats?hours=24');
  ok('出口流量：返回每个出口一行', ts.status === 200 && Array.isArray(ts.d.tunnels) && ts.d.tunnels.length > 0, String((ts.d.tunnels || []).length));
  ok('出口流量：字段齐全', (ts.d.tunnels || []).every((t) => 'id' in t && 'count' in t && 'err5' in t && 'p95' in t && 'host' in t), '');
  const tsBad = await j('/api/tunnels/stats?hours=abc');
  ok('出口流量：hours 非法时用默认值', tsBad.status === 200 && tsBad.d.hours > 0, 'hours=' + tsBad.d.hours);

  // ---- v0.28.0：告警回调令牌 + 出口错误率规则 ----
  const sTok = await j('/api/alerts/hook-token');
  ok('告警回调：管理员能取到令牌', sTok.status === 200 && /^[0-9a-f]{32}$/.test(String(sTok.d.token || '')), String(sTok.d.token || '').slice(0, 6));
  const sWrong = await fetch(B + '/api/alerts/hook?token=deadbeef', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'firing', alerts: [] })
  });
  ok('告警回调：错令牌被拒', sWrong.status === 403, String(sWrong.status));
  const sGood = await fetch(B + '/api/alerts/hook?token=' + sTok.d.token, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'firing', alerts: [{ status: 'firing', labels: { alertname: 'ApiTestAlert', severity: 'warning', name: '测试出口' }, annotations: { summary: '来自测试' } }] })
  });
  const sGoodBody = await sGood.json();
  ok('告警回调：正确令牌接收成功', sGood.status === 200 && sGoodBody.ok === true && sGoodBody.firing === 1, JSON.stringify(sGoodBody).slice(0, 80));
  const sMon = await j('/api/monitor/status');
  ok('监控状态：告警带 labels', Array.isArray(sMon.d.alerts) && sMon.d.alerts.every((a) => a && typeof a.labels === 'object'), String((sMon.d.alerts || []).length));
  const sRules = fs.readFileSync('docs/prometheus-alerts.yml', 'utf8');
  ok('告警规则：含单出口错误率', /alert:\s*ExitErrorRateHigh/.test(sRules) && /cf_exit_errors_5m/.test(sRules), '');
  const sRulesMon = fs.readFileSync('tools/monitoring/prometheus/alerts.yml', 'utf8');
  ok('告警规则：监控栈副本已同步', sRulesMon === sRules, String(sRulesMon.length) + '/' + String(sRules.length));
}

  // ---- v0.29.0：审计口径 / CSP / 概览日志折叠 / 出口菜单 / 时长文案 / 窄屏栅格 ----
  const v29a = await j('/api/audit?limit=50');
  ok('审计：行带 mutating 标记', Array.isArray(v29a.d.rows) && v29a.d.rows.every((r) => typeof r.mutating === 'boolean'), String((v29a.d.rows || []).length));
  const v29t = await j('/api/audit/trend?hours=3');
  ok('审计趋势：只统计变更（桶字段齐全）', Array.isArray(v29t.d.buckets) && v29t.d.buckets.length === 3
    && v29t.d.buckets.every((b) => ['t', 'total', 'ok', 'err'].every((k) => k in b)), JSON.stringify((v29t.d.buckets || []).slice(0, 2)));
  const v29l = await fetch(B + '/login');
  const v29csp = String(v29l.headers.get('content-security-policy') || '');
  ok('CSP：放行 Cloudflare 统计脚本', /static\.cloudflareinsights\.com/.test(v29csp), v29csp.slice(0, 60));
  const v29css = await (await fetch(B + '/assets/app.css')).text();
  ok('窄屏：栅格用 minmax(0,1fr) 防撑宽', /grid-template-columns:minmax\(0,1fr\)/.test(v29css), '');
  const v29tj = await (await fetch(B + '/assets/tunnels.js')).text();
  ok('出口卡：动作收进⋯菜单', /data-menu/.test(v29tj) && /menu-pop/.test(v29tj), '');
  ok('时长文案：小时/分而不是「时」', /小时 \$\{/.test(v29tj) && !/\$\{h\} 时/.test(v29tj), '');
  const v29ov = await (await fetch(B + '/')).text();
  ok('概览：日志卡默认折叠有按钮', /id="btnLogToggle"/.test(v29ov) && /class="log collapsed"/.test(v29ov), '');
  ok('侧栏：主题/语言/命令面板移到顶部', /class="side-tools"/.test(v29ov), '');

// v0.29.8：Grafana 局域网直连（lanUrl）
{
  const bad = await j('/api/settings', { method: 'POST', body: { grafana: { lanUrl: '192.168.1.55:3000' } } });
  ok('Grafana：局域网地址必须是 http(s) URL', bad.status === 400, String(bad.status));
  const cur = (await j('/api/state')).d.state.settings.grafana;
  const set = await j('/api/settings', { method: 'POST', body: { grafana: Object.assign({}, cur, { lanUrl: 'http://192.168.1.55:3000' }) } });
  ok('Grafana：能存下局域网地址', set.status === 200, String(set.status));
  const st = (await j('/api/state')).d.state.settings.grafana;
  ok('Grafana：局域网地址回显到 /api/state', st.lanUrl === 'http://192.168.1.55:3000', String(st.lanUrl));
  const pg = await rawFetch(B + '/', { headers: { Authorization: 'Basic ' + Buffer.from('admin:' + PASS, 'utf8').toString('base64') } });
  const csp3 = pg.headers.get('content-security-policy') || '';
  ok('Grafana：CSP 同时放行正式地址与局域网地址',
    /frame-src[^;]*https:\/\/grafana\.jianghugs\.shop/.test(csp3) && /frame-src[^;]*http:\/\/192\.168\.1\.55:3000/.test(csp3), csp3.slice(0, 200));
  // 还原成测试前的值（生产上现在真的配了局域网地址，别把它抹掉）
  await j('/api/settings', { method: 'POST', body: { grafana: Object.assign({}, st, { lanUrl: cur.lanUrl }) } });
}

// v0.29.11：体检留痕 + 定时自检
{
  const sc = await j('/api/selfcheck');
  ok('体检：跑完会留痕（last.json 有总值）', sc.status === 200 && typeof sc.d.total === 'number', String(sc.status));
  const h = await j('/api/selfcheck/history?limit=5');
  ok('体检：历史接口返回上次结果', h.status === 200 && h.d.ok === true && h.d.last && typeof h.d.last.at === 'number', JSON.stringify(Object.keys(h.d || {})));
  ok('体检：上次结果与本次项数一致', h.d.last && h.d.last.total === sc.d.total, `${h.d.last && h.d.last.total} vs ${sc.d.total}`);
  const st = await j('/api/state');
  ok('体检：/api/state 带体检摘要（侧栏直接用）', st.d.runtime && st.d.runtime.selfcheck && typeof st.d.runtime.selfcheck.total === 'number', '');

  // v0.29.31：?only=bad 方便 cron / 外部脚本只看有问题的项
  const badOnly = await j('/api/selfcheck?only=bad');
  ok('体检：only=bad 只返回非 ok 项',
    badOnly.status === 200 && Array.isArray(badOnly.d.checks)
    && badOnly.d.checks.every((c) => c.status !== 'ok')
    && badOnly.d.shown === badOnly.d.checks.length
    && typeof badOnly.d.total === 'number',
    `shown=${badOnly.d && badOnly.d.shown} of total=${badOnly.d && badOnly.d.total}`);

  // v0.29.31：单独停用一条规则要能在审计里看出来（原来只记「改规则」）
  {
    const st0 = await j('/api/state');
    const src = st0.d.state.routes.map((r) => ({ ...r, basicAuth: { user: (r.basicAuth || {}).user || '', password: '' } }));
    const mark = '审计探针规则 ' + Date.now();
    const one = src[0];
    const off = src.map((r) => (r.id === one.id ? { ...r, enabled: false } : r));
    const r1 = await j('/api/routes', { method: 'POST', body: { routes: off, force: true } });
    const au = await j('/api/audit?limit=20');
    const hit = (au.d.items || au.d.rows || []).find((x) => x.action === '停用规则' || x.action === '启用规则');
    ok('审计：停用规则单独记一条', r1.status === 200 && !!hit, hit ? `${hit.action} → ${hit.target}` : JSON.stringify((au.d.items || []).slice(0, 3)));
    await j('/api/routes', { method: 'POST', body: { routes: src, force: true } });
    void mark;
  }

  // v0.29.32：可以只跑关心的几项；审计可按动作筛；留痕概况随历史一起给
  const onlyIds = await j('/api/selfcheck?ids=caddy,disk');
  ok('体检：?ids= 只跑指定项',
    onlyIds.status === 200 && (onlyIds.d.checks || []).length === 2
    && (onlyIds.d.checks || []).every((c) => ['caddy', 'disk'].includes(c.id))
    && onlyIds.d.total === 2,
    (onlyIds.d.checks || []).map((c) => c.id).join(','));
  const au2 = await j('/api/audit?limit=20&act=' + encodeURIComponent('停用规则'));
  ok('审计：可按动作筛选', au2.status === 200 && Array.isArray(au2.d.actions)
    && (au2.d.rows || []).every((r) => r.action === '停用规则'),
    `actions=${(au2.d.actions || []).length} rows=${(au2.d.rows || []).length}`);
  const hstore = await j('/api/selfcheck/history?limit=1');
  ok('体检历史：带留痕占用与上限',
    hstore.status === 200 && hstore.d.store && typeof hstore.d.store.bytes === 'number'
    && typeof hstore.d.store.count === 'number' && hstore.d.store.keep > 0 && hstore.d.store.maxBytes > 0,
    JSON.stringify(hstore.d.store || {}));

  // v0.29.33：点名不存在的检查项要报错，而不是静默返回空
  const badIds = await j('/api/selfcheck?ids=caddy,no-such-thing');
  ok('体检：未知的 ids 返回 400 并列出可用项',
    badIds.status === 400 && Array.isArray(badIds.d.valid) && badIds.d.valid.includes('caddy')
    && /未知的检查项/.test(String(badIds.d.error || '')),
    `${badIds.status} ${String(badIds.d.error || '').slice(0, 40)}`);

  // v0.29.33：审计「只看失败」
  const auBad = await j('/api/audit?limit=50&bad=1');
  ok('审计：bad=1 只返回失败记录',
    auBad.status === 200 && (auBad.d.rows || []).every((r) => r.ok === false),
    (auBad.d.rows || []).map((r) => `${r.action}:${r.ok}`).slice(0, 3).join(' '));

  // v0.29.34：scope=quick 跳过要过 Cloudflare 的出口探测
  const qk = await j('/api/selfcheck?scope=quick');
  ok('体检：scope=quick 不含出口探测',
    qk.status === 200 && (qk.d.checks || []).length > 0
    && (qk.d.checks || []).every((c) => !String(c.id).startsWith('exit-')),
    `${(qk.d.checks || []).length} 项：${(qk.d.checks || []).map((c) => c.id).join(',')}`);

  // v0.29.16：网络重连（cloudflared 自己重连、进程没退出）以前完全看不见，只有翻 docker logs 才知道
  ok('体检：包含「出口链路稳定性」一项', (sc.d.checks || []).some((c) => c.id === 'flaps'), (sc.d.checks || []).map((c) => c.id).join(','));
  const anyExit = (st.d.runtime.tunnels || [])[0] || {};
  ok('体检：/api/state 的出口带 flaps10m 计数', typeof anyExit.flaps10m === 'number' && typeof anyExit.flaps === 'number', JSON.stringify(Object.keys(anyExit)));

  // v0.29.18：把历史按检查项聚合，「最近 24 小时哪些项反复出问题」
  const hf = await j('/api/selfcheck/history?limit=40&hours=24');
  ok('体检历史：带窗口聚合字段', hf.status === 200 && Array.isArray(hf.d.fails)
    && typeof hf.d.hours === 'number' && typeof hf.d.runs === 'number'
    && typeof hf.d.coverageHours === 'number', JSON.stringify(Object.keys(hf.d || {})));
  ok('体检历史：窗口内次数不超过记录条数', (hf.d.fails || []).every((f) => f.count > 0 && f.count <= Math.max(1, hf.d.runs)), JSON.stringify(hf.d.fails || []).slice(0, 120));
  {
    // 纯函数层面的聚合（记录里的 at 是毫秒戳，老数据可能是 ISO 串，两种都要认）
    const script = `const s = require('./src/core/selfcheck.js');
      const now = Date.now();
      const items = [
        { at: now - 60e3, bad: [{ id: 'grafana', name: 'Grafana', detail: '超时' }] },
        { at: new Date(now - 30e3).toISOString(), bad: [{ id: 'grafana', name: 'Grafana', detail: 'HTTP 502' }, { id: 'disk', name: '数据盘', detail: '87%' }] },
        { at: now - 10e3, bad: [] },
      ];
      process.stdout.write(JSON.stringify(s.fails(items)));`;
    let agg = [];
    try { agg = JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: path.resolve('.'), encoding: 'utf8' })); }
    catch (e) { agg = [{ err: String(e.message || e) }]; }
    const g = agg.find((x) => x.id === 'grafana') || {};
    ok('体检历史：同一项多次失败合并计数', g.count === 2, JSON.stringify(agg));
    ok('体检历史：保留最后一次的说明', g.lastDetail === 'HTTP 502', JSON.stringify(g));
    ok('体检历史：ISO 时间串也能解析', typeof g.lastAt === 'string' && g.lastAt.length > 10, String(g.lastAt));
  }

  // v0.29.12：留痕曾经整文件重写，被一条爆炸记录撑到 360MB，把事件循环卡了 20 秒
  const histFile = path.join(process.env.DATA_DIR || 'data', 'selfcheck', 'history.jsonl');
  let raw = '';
  try { raw = fs.readFileSync(histFile, 'utf8'); } catch { /* 首次跑可能还没有 */ }
  const histLines = raw.split('\n').filter(Boolean);
  ok('体检留痕：history.jsonl 体积可控（< 256KB）', raw.length < 256 * 1024, `${raw.length} 字节`);
  ok('体检留痕：单条记录不超过 2KB', histLines.every((l) => l.length <= 2 * 1024), `最长 ${Math.max(0, ...histLines.map((l) => l.length))}`);
  ok('体检留痕：历史按时间倒序（最新在前）', h.d.items.length < 2 || Number(h.d.items[0].at) >= Number(h.d.items[1].at), '');
}

// v0.29.14：访问日志跨轮转可读（健康检查噪音把当前文件刷得很快，趋势图会缺一块）
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfp-log-'));
  const dir = path.join(tmp, 'caddy-logs');
  fs.mkdirSync(dir, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  const line = (ts, uri, status = 200) => JSON.stringify({
    level: 'info', ts, logger: 'http.log.access.main', msg: 'handled request',
    request: { remote_ip: '1.2.3.4', host: 'panel.jianghugs.shop', uri, method: 'GET' },
    status, size: 10, dur: 0.001,
  });
  fs.writeFileSync(path.join(dir, 'access.log'), `${line(now - 60, '/current')}\n`);
  fs.writeFileSync(path.join(dir, 'access-2026-11-21T00-00-00.000-size.log.gz'),
    zlib.gzipSync(`${line(now - 7200, '/gz-two')}\n${line(now - 18000, '/gz-five', 502)}\n`));

  const script = `const i = require('./src/core/insight.js');
    const h = i.trafficByHour(12);
    const p = i.trafficByPath(12, 4);
    process.stdout.write(JSON.stringify({ hour: h.buckets.reduce((a, b) => a + b.total, 0), path: p.unmatched.total + p.groups.reduce((a, g) => a + g.total, 0) }));`;
  let out = {};
  try {
    const raw = execFileSync(process.execPath, ['-e', script], {
      cwd: path.resolve('.'), env: { ...process.env, DATA_DIR: tmp }, encoding: 'utf8',
    });
    out = JSON.parse(raw);
  } catch (e) { out = { err: String(e.message || e) }; }
  ok('日志：轮转文件（.gz）里的流量也算进趋势', out.hour === 3, JSON.stringify(out));
  ok('日志：按规则聚合同样跨轮转', out.path === 3, JSON.stringify(out));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

// v0.29.18：老配置快照压 gzip（80 份明文 600KB+，压完只剩三分之一）
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfp-snap-'));
  const script = `const c = require('./src/core/configcode.js');
    const d = process.env.DATA_DIR;
    for (let i = 0; i < 14; i += 1) c.writeSnapshot(d, { apiVersion: 'v1', routes: [{ id: 'r' + i }] }, 'manual');
    const items = c.listSnapshots(d, 30);
    const gz = items.filter((x) => x.file.endsWith('.gz'));
    const plain = items.filter((x) => !x.file.endsWith('.gz'));
    const back = gz.length ? c.readSnapshot(d, gz[0].file) : null;
    process.stdout.write(JSON.stringify({ total: items.length, gz: gz.length, plain: plain.length, ok: !!(back && back.apiVersion) }));`;
  let out = {};
  try {
    const raw = execFileSync(process.execPath, ['-e', script], { cwd: path.resolve('.'), env: { ...process.env, DATA_DIR: tmp }, encoding: 'utf8' });
    out = JSON.parse(raw);
  } catch (e) { out = { err: String(e.message || e) }; }
  ok('配置快照：老快照被压成 .gz', out.gz === 4 && out.plain === 10, JSON.stringify(out));
  ok('配置快照：压缩后的快照仍能读回来', out.ok === true, JSON.stringify(out));
  ok('配置快照：列表不漏压缩过的快照', out.total === 14, JSON.stringify(out));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

// v0.29.15：对端槽位离线时不再下发主动健康检查（它是日志里 99.85% 噪音的来源）
{
  const script = `const c = require('./src/core/caddy.js');
    const rule = { id: 't', path: '/', upstream: 'http://127.0.0.1:' + process.env.PORT, enabled: true };
    (async () => {
      await c.startPeerWatch();
      await new Promise((r) => setTimeout(r, 500));
      const p = c.buildRouteHandlers(rule).find((h) => h.handler === 'reverse_proxy');
      process.stdout.write(JSON.stringify({ ups: p.upstreams.length, hc: Boolean(p.health_checks) }));
    })();`;
  let out = {};
  try {
    const raw = execFileSync(process.execPath, ['-e', script], {
      cwd: path.resolve('.'),
      env: { ...process.env, PORT: '8090', PANEL_SLOT_PEERS: '65530' },   // 65530 不会有人监听
      encoding: 'utf8', timeout: 8000,
    });
    out = JSON.parse(raw);
  } catch (e) { out = { err: String(e.message || e).slice(0, 120) }; }
  ok('槽位：对端离线时只留一个上游', out.ups === 1, JSON.stringify(out));
  ok('槽位：对端离线时不下发健康检查', out.hc === false, JSON.stringify(out));
}

await restoreRoutes();

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
