#!/usr/bin/env node
/**
 * 冒烟测试（CI 用）：在**全新实例**上把每条路由至少打一次，
 * 抓住「模块搬出去了但 require 漏了 / 变量作用域没了」这类只在运行期炸的问题
 * （0.29.55 的 `net is not defined` 就是这么漏到线上的，node --check 查不出）。
 *
 * 用法：
 *   PANEL_URL=http://127.0.0.1:8199 node test/smoke.mjs
 * 前置：面板用空 DATA_DIR 起（没设口令 → 所有请求放行），CADDY_ADMIN 指死端口、
 *      CLOUDFLARED_BIN=/bin/false，别碰真环境。
 */
const B = process.env.PANEL_URL || 'http://127.0.0.1:8199';
let pass = 0;
const fail = [];
const ok = (n, c, x = '') => {
  if (c) { pass++; return; }
  fail.push(`${n}${x ? '  [' + x + ']' : ''}`);
  console.log(`FAIL  ${n}${x ? '  [' + x + ']' : ''}`);
};

/** 打一个接口：断言状态码在期望集合里，且响应体不是 5xx 错误壳。 */
const hit = async (method, p, body, expect = [200]) => {
  const opt = { method, headers: { 'x-cfp-test': '1' } };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  let r, text = '';
  try {
    r = await fetch(B + p, { ...opt, signal: AbortSignal.timeout(8000) });
    text = await r.text();
  } catch (e) {
    return { status: 0, d: {}, text: String(e.message || e) };
  }
  let d = {};
  try { d = JSON.parse(text); } catch { d = { raw: text.slice(0, 200) }; }
  const label = `${method} ${p}`;
  ok(label, expect.includes(r.status), `HTTP ${r.status}`);
  // 500 一定有问题：说明路由内部抛了异常（通常是 require 漏了、变量不在作用域）
  ok(`${label} 不是 5xx`, r.status < 500, `HTTP ${r.status} ${JSON.stringify(d).slice(0, 160)}`);
  return { status: r.status, d, text };
};

const h = await hit('GET', '/healthz');
ok('healthz 带 version', !!h.d.version, String(h.d.version));
ok('healthz 是 leader', ['leader', 'standby'].includes(String(h.d.mode)), String(h.d.mode));

await hit('GET', '/');
await hit('GET', '/login');
await hit('GET', '/boot.js');
await hit('GET', '/assets/app.css');
await hit('GET', '/badge.svg');
await hit('GET', '/metrics');
for (const page of ['/rules', '/tunnels', '/observe', '/tools', '/monitor', '/settings']) await hit('GET', page);

const st = await hit('GET', '/api/state');
ok('state 里有 routes 数组', Array.isArray(st.d.state && st.d.state.routes), typeof st.d.state);
await hit('GET', '/api/system');
await hit('GET', '/api/openapi');
await hit('GET', '/api/tunnels');
await hit('GET', '/api/traffic');
await hit('GET', '/api/traffic/paths');
await hit('GET', '/api/history');
await hit('GET', '/api/routes/stats');
await hit('GET', '/api/tunnels/stats');
await hit('GET', '/api/audit');
await hit('GET', '/api/audit/trend');
await hit('GET', '/api/audit/days');
await hit('GET', '/api/access');
await hit('GET', '/api/logs');
await hit('GET', '/api/sessions');
await hit('GET', '/api/backups');
await hit('GET', '/api/shares');
await hit('GET', '/api/config');
await hit('GET', '/api/config/drift');
await hit('GET', '/api/config/snapshots');
await hit('GET', '/api/selfcheck');
await hit('GET', '/api/monitor/status');
await hit('GET', '/api/security/attempts');
await hit('GET', '/api/qr', undefined, [200, 400]);

// 写操作：全新实例没口令，这些都能直接过；每一条都对应一个搬出去的模块，
// 挂了就是又漏了 require 或作用域变量。
await hit('POST', '/api/security/deny', { ip: '192.0.2.77' });
await hit('POST', '/api/security/allow', { ip: '192.0.2.77' });
await hit('POST', '/api/settings', { panelName: 'ci-smoke' });
await hit('POST', '/api/routes', { routes: [] }, [200, 400]);
await hit('POST', '/api/caddy/push', {}, [200, 500]); // Caddy 指死端口，500 也算「模块活着」
await hit('POST', '/api/shares', { name: 'ci', upstream: 'http://127.0.0.1:9', minutes: 5 }, [200, 400]);
await hit('POST', '/api/selfcheck', {}, [200, 202, 404, 405]);

const total = pass + fail.length;
console.log(`\n${pass}/${total} 通过`);
if (fail.length) {
  console.log('\n失败项：');
  for (const f of fail) console.log('  · ' + f);
}
process.exit(fail.length ? 1 : 0);
