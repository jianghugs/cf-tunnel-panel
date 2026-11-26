'use strict';
/**
 * 只走 IPv4 的一次 HTTP(S) 请求。
 *
 * 为什么需要：这台机器（和面板容器）的 DNS 同时返回 A 与 AAAA，但没有 v6 出口。
 * Node 的 fetch 底下是 undici，遇到「AAAA 先回来、v6 又不通」会一路等到超时
 * （实测稳定 ~520ms 后 ETIMEDOUT，而同一容器里 curl 是 200）。
 * 于是「出口自检 / 公网自测 / 边缘缓存探测」这些判断都会假失败，
 * 而 curl 走 happy-eyeballs 会自动回落 v4，不会出这种事。
 *
 * 这里的做法等同 `curl -4`：自己解析 A 记录 → 按 IP 连 → TLS 用 servername 带 SNI
 * → Host 头仍然是原域名。只在 fetch 失败后作为兜底使用，正常路径不受影响。
 *
 * @param {string} url
 * @param {number|{timeout?:number,method?:string,headers?:object,maxBytes?:number}} opts 传数字等价于 timeout
 * @returns {Promise<{status:number,headers:object,body:string,ip:string}>}
 */
const http = require('http');
const https = require('https');
const dns = require('dns');

function getV4(url, opts) {
  const o = typeof opts === 'number' ? { timeout: opts } : (opts || {});
  const ms = Number(o.timeout) || 6000;
  const method = o.method || 'GET';
  const maxBytes = Number(o.maxBytes) || 256 * 1024;
  const headers = Object.assign({ 'user-agent': 'cf-tunnel-panel', accept: '*/*' }, o.headers || {});
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const isTls = u.protocol === 'https:';
    const mod = isTls ? https : http;
    const port = u.port || (isTls ? 443 : 80);
    dns.lookup(u.hostname, { family: 4 }, (de, addr) => {
      if (de || !addr) return reject(de || new Error('没有 A 记录'));
      const req = mod.request({
        host: addr,
        port,
        path: (u.pathname || '/') + (u.search || ''),
        method,
        servername: isTls ? u.hostname : undefined,
        headers: Object.assign({ host: u.hostname }, headers),
        timeout: ms,
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size <= maxBytes) chunks.push(c);
        });
        res.on('end', () => resolve({
          status: res.statusCode || 0,
          headers: res.headers || {},
          body: Buffer.concat(chunks).toString('utf8'),
          ip: addr,
        }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error(`IPv4 也超时（${ms}ms）`)));
      req.on('error', reject);
      req.end();
    });
  });
}

module.exports = { getV4 };
