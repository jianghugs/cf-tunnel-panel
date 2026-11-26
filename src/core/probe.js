'use strict';
/**
 * 探测工具（上游 TCP+HTTP、链路自测、WebSocket 升级）
 * 从 src/server.js 按职责拆出（v0.9.0），仅做搬运，行为不变。
 */

const http=require('http'); const https=require('https'); const crypto=require('crypto');
 const net=require('net');
const dns=require('dns');
const path=require('path');
const { getV4 } = require('./httpv4');

const _state = require('./state');
const state = _state.stateProxy;
async function probeUpstream(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    return { ok: false, error: '上游地址不合法，应为 http://127.0.0.1:8096 这种形式' };
  }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, error: '只支持 http / https 上游' };
  const host = u.hostname;
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  const t0 = Date.now();
  // 先拿 A 记录再连：net.connect(hostname) 会优先用 AAAA，而本机通常没有 v6 出口，
  // 结果是 2.5s 超时、误报「上游连不上」（curl 走 happy-eyeballs 不会）
  const v4addr = await new Promise((resolve) => {
    dns.lookup(host, { family: 4 }, (de, addr) => resolve(de ? '' : addr));
  });
  const tcp = await new Promise((resolve) => {
    const sock = net.connect({ host: v4addr || host, port });
    const finish = (v) => { try { sock.destroy(); } catch {} resolve(v); };
    sock.setTimeout(2500, () => finish({ ok: false, error: '连接超时（2.5s 没响应）' }));
    sock.once('connect', () => finish({ ok: true }));
    sock.once('error', (e) => finish({
      ok: false,
      error: e.code === 'ECONNREFUSED' ? `端口 ${port} 没人监听（connection refused）`
        : e.code === 'ENOTFOUND' ? `域名解析失败：${host}`
        : e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH' ? '主机不可达'
        : e.message,
    }));
  });
  const tcpMs = Date.now() - t0;
  if (!tcp.ok) return { ok: false, tcpMs, port, error: tcp.error };
  try {
    const r = await fetch(u.toString(), {
      method: 'GET', redirect: 'manual',
      headers: { 'User-Agent': 'cf-tunnel-panel-probe' },
      signal: AbortSignal.timeout(4000),
    });
    const totalMs = Date.now() - t0;
    return {
      ok: r.status < 500, tcpMs, totalMs, port, status: r.status,
      note: r.status >= 500 ? 'TCP 通，但上游返回 5xx —— 服务可能没起好' : '',
    };
  } catch (e) {
    // 公网上游（比如 https://xx.trycloudflare.com）在本机没有 v6 出口时 fetch 会假失败，
    // 再兜一次 IPv4（见 core/httpv4.js）；还是不行才按「TCP 通、HTTP 不通」报
    try {
      const v4 = await getV4(u.toString(), { timeout: 4000, headers: { 'User-Agent': 'cf-tunnel-panel-probe' } });
      return {
        ok: v4.status < 500, tcpMs, totalMs: Date.now() - t0, port, status: v4.status,
        note: v4.status >= 500 ? 'TCP 通，但上游返回 5xx —— 服务可能没起好' : `已用 IPv4 直连（${v4.ip}）拿到响应`,
      };
    } catch (e2) {
      return { ok: true, tcpMs, totalMs: Date.now() - t0, port, status: 0, note: 'TCP 通，但 HTTP 请求失败：' + e.message };
    }
  }
}

// ---------------------------------------------------------------- 访问统计
/** 读 Caddy access log 的最后若干行，解析成面板能直接展示的表格 + 汇总。 */
/** 按小时聚合 access.log：总数 / 2xx / 4xx-5xx，给概览页画趋势图。 */
/**
 * 用面板自己的身份去请求本机 Caddy（链路自测：规则有没有生效、返回什么状态码）。
 *
 * 为什么不用 fetch：Node 的 fetch/undici **不允许覆盖 Host 头**，
 * 而 Caddy 是按 Host 分流规则的 —— 用 fetch 测「指定域名」永远是错的
 * （测出来像是规则没配，其实是 Host 没发出去）。这里用 http.request 手写 Host。
 */
async function curlSelf(target) {
  const listen = String(state.settings.caddyListen || ':8080');
  const port = listen.split(':').pop() || '8080';
  let p = String(target || '/').trim();
  if (!p.startsWith('/')) p = '/' + p;
  let host = '';
  try { host = new URL(`http://x${p}`).searchParams.get('__host') || ''; } catch { host = ''; }
  const url = `http://127.0.0.1:${port}${p}`;
  const started = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (obj) => { if (!done) { done = true; resolve(obj); } };
    const req = http.request({
      host: '127.0.0.1', port: Number(port), path: p, method: 'GET',
      headers: Object.assign({ 'User-Agent': 'cf-tunnel-panel-curl' }, host ? { Host: host } : {}),
      timeout: 10000,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (chunks.length < 64 && size <= 512 * 1024) chunks.push(c);
      });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const headers = {};
        for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
        finish({
          ok: true, url, status: res.statusCode, ms: Date.now() - started, bytes: size,
          host, headers,
          preview: buf.toString('utf8', 0, 600).replace(/\s+/g, ' ').trim(),
        });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时（10 秒）')); });
    req.on('error', (e) => finish({ ok: false, url, error: e.message, ms: Date.now() - started, host }));
    req.end();
  });
}

/** 走本机 Caddy 做一次 WebSocket 握手，判断这条规则到底能不能升级成功。 */
function wsProbe(target, hostHeader, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(target); } catch (e) { return resolve({ ok: false, error: '路径不合法' }); }
    const t0 = Date.now();
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'GET',
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key,
        Host: hostHeader || u.host,
      },
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ ok: false, error: `超时（${timeoutMs}ms 内没有响应升级）` }); });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve({ ok: true, status: 101, ms: Date.now() - t0 });
    });
    req.on('response', (res) => {
      res.resume();
      resolve({ ok: false, status: res.statusCode, ms: Date.now() - t0, error: `没有升级成 WebSocket（HTTP ${res.statusCode}，多半是上游不是 WS 服务或规则路径不对）` });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.end();
  });
}

/** 把某份备份的规则和当前规则对比，返回增/删/改。 */

module.exports = { curlSelf, probeUpstream, wsProbe };
