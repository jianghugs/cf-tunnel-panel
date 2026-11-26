'use strict';
/**
 * 外部集成（Docker API、Cloudflare API）
 * 从 src/server.js 按职责拆出（v0.9.0），仅做搬运，行为不变。
 */

const http=require('http'); const https=require('https');

const path=require('path');

function dockerApi(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: '/var/run/docker.sock', path: pathname, method: 'GET', timeout: 5000 }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`docker API ${res.statusCode}: ${d.slice(0, 160)}`));
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('docker API 返回的不是 JSON')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('docker API 超时')));
    req.end();
  });
}

// 猜哪个端口更像 Web 界面：避开 ssh/数据库/管理端口，优先 80/443/8080/8000/3000/5000 一类
function pickWebPort(list) {
  const bad = new Set([22, 21, 25, 139, 445, 2019, 2022, 2121, 3306, 5432, 6379, 27017, 5672, 9092, 6789, 37291]);
  const good = new Set([80, 443, 3000, 5000, 8000, 8008, 8080, 8081, 8082, 8090, 8443, 9000]);
  const score = (p) => (good.has(p) ? 0 : bad.has(p) ? 3 : p > 1024 && p < 10000 ? 1 : 2);
  return [...list].sort((a, b) => score(a) - score(b) || a - b)[0];
}

async function dockerContainers() {
  let list;
  try {
    list = await dockerApi('/containers/json');
  } catch (e) {
    const hint = e.code === 'ENOENT' || /ENOENT/.test(e.message)
      ? '容器里没有 /var/run/docker.sock（在 docker-compose.yml 的 panel 服务加一行挂载）'
      : e.message;
    return { available: false, error: hint, containers: [] };
  }
  const details = await Promise.all(list.map(async (c) => {
    try { return await dockerApi(`/containers/${c.Id}/json`); } catch { return null; }
  }));
  const containers = list.map((c, idx) => {
    const det = details[idx] || {};
    const hostNet = ((det.HostConfig || {}).NetworkMode === 'host');
    const exposed = Object.keys((det.Config || {}).ExposedPorts || {}).map((x) => Number(String(x).split('/')[0])).filter(Boolean);

    const name = ((c.Names && c.Names[0]) || '').replace(/^\//, '');
    const ports = (c.Ports || []).map((x) => ({ private: x.PrivatePort, public: x.PublicPort, type: x.Type, ip: x.IP }));
    const pub = ports.find((x) => x.type === 'tcp' && x.public);
    const priv = ports.find((x) => x.type === 'tcp' && x.private);
    let upstream = '';
    if (pub) upstream = `http://127.0.0.1:${pub.public}`;
    // host 网络（本栈和很多家庭服务都这么跑）：没有端口映射，容器内端口就是宿主机端口
    if (!upstream && hostNet && exposed.length) upstream = `http://127.0.0.1:${pickWebPort(exposed)}`;
    if (!upstream && priv) {
      const nets = (c.NetworkSettings && c.NetworkSettings.Networks) || {};
      const ip = Object.values(nets).map((n) => n && n.IPAddress).filter(Boolean)[0];
      if (ip) upstream = `http://${ip}:${priv.private}`;
    }
    const allPorts = ports.filter((x) => x.type === 'tcp').map((x) => (x.public ? `${x.public}→${x.private}` : `${x.private}`));
    if (!allPorts.length && exposed.length) allPorts.push(...exposed.map((p) => `${p}(host)`));
    return {
      id: String(c.Id || '').slice(0, 12), name: name || '(未命名)', image: c.Image, state: c.State, status: c.Status,
      ports: allPorts, hostNetwork: hostNet,
      upstream, created: c.Created,
    };
  }).sort((a, b) => (a.state === 'running' ? -1 : 1) - (b.state === 'running' ? -1 : 1) || a.name.localeCompare(b.name));
  return { available: true, containers };
}

// ---------------------------------------------------------------- 面板内 curl 测试器
async function cfApi(pathname, { method = 'GET', body } = {}) {
  const cf = state.settings.cf || {};
  if (!cf.token) throw new Error('还没填 Cloudflare API Token（设置卡「Cloudflare API」里填）');
  const url = `https://api.cloudflare.com/client/v4${pathname}`;
  const headers = { Authorization: `Bearer ${cf.token}`, 'Content-Type': 'application/json' };
  const payload = body ? JSON.stringify(body) : undefined;
  let status = 0;
  let j = null;
  try {
    const r = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(15000) });
    status = r.status;
    j = await r.json().catch(() => null);
  } catch (e) {
    // 本机没有 v6 出口时 fetch 会假失败；再兜一次 IPv4（见 core/httpv4.js），还是不行才抛原错
    const r4 = await getV4(url, { method, headers, body: payload, timeout: 15000, maxBytes: 512 * 1024 });
    status = r4.status;
    try { j = JSON.parse(r4.body); } catch { j = null; }
  }
  if (!j) throw new Error(`Cloudflare API 返回的不是 JSON（HTTP ${status}）`);
  if (status >= 400 || j.success === false) {
    const msg = (j.errors || []).map((e) => e.message).join('；') || `HTTP ${status}`;
    throw new Error(`Cloudflare API 失败：${msg}`);
  }
  return j.result;
}

const { getV4 } = require('./httpv4');
const _state = require('./state');
const state = _state.stateProxy;

module.exports = { cfApi, dockerApi, dockerContainers, pickWebPort };
