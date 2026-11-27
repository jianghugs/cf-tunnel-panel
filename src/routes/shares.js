'use strict';
/**
 * shares 相关路由（C8 拆分自 src/server.js，块内逻辑逐行未改）。
 * 公共依赖统一在 ./_deps.js（十份样板合并后的唯一一份）。
 */
const {
  path,
  log,
  logs,
  parseUpstream,
  readBody,
  rid,
  sendJson,
  saveState,
  state,
  caddy,
  pushCaddy,
  metricsText,
  curlSelf,
  wsProbe,
  shareUrl,
  http,
  crypto,
} = require('./_deps');

async function handle(p, req, res, url) {
  if (p === '/api/shares' && req.method === 'GET') {
    return sendJson(res, 200, {
      shares: (state.shares || []).map((s) => ({ ...s, url: shareUrl(s.token), leftSec: Math.max(0, Math.round((s.expiresAt - Date.now()) / 1000)) })),
    });
  }
  if (p === '/api/shares' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const up = String(body.upstream || '').trim();
      if (!up) throw new Error('上游地址不能为空');
      parseUpstream(up);
      const minutes = Math.max(1, Math.min(10080, Number(body.minutes) || 30));
      const s = {
        id: rid(), token: crypto.randomBytes(9).toString('base64url'),
        name: String(body.name || '临时分享').slice(0, 60), upstream: up,
        createdAt: Date.now(), expiresAt: Date.now() + minutes * 60000,
      };
      state.shares = [...(state.shares || []), s];
      saveState('share-add');
      await pushCaddy();
      log(`已生成分享链接 ${s.name} → ${up}（${minutes} 分钟）`, 'panel');
      return sendJson(res, 200, { ok: true, share: { ...s, url: shareUrl(s.token) }, caddy });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }
  const sm = p.match(/^\/api\/shares\/([\w-]+)\/delete$/);
  if (sm && req.method === 'POST') {
    const before = (state.shares || []).length;
    state.shares = (state.shares || []).filter((s) => s.id !== sm[1]);
    if (state.shares.length === before) return sendJson(res, 404, { ok: false, error: '这条分享链接不存在' });
    saveState('share-del');
    await pushCaddy();
    return sendJson(res, 200, { ok: true, caddy });
  }

  // ---- 面板内 curl 测试器（只打本机 Caddy，安全）
  if (p === '/api/ws-test' && req.method === 'POST') {
    const body = await readBody(req);
    const caddyPort = (String((state.settings || {}).caddyListen || ':8080').split(':').pop() || '8080');
    const target = `http://127.0.0.1:${caddyPort}${body.path || '/'}`;
    const r = await wsProbe(target, body.host ? String(body.host).trim() : `127.0.0.1:${caddyPort}`);
    log(`WS 自测 ${body.path || '/'} → ${r.ok ? '可升级（101）' : r.error}`, 'panel');
    return sendJson(res, 200, { ok: !!r.ok, target, ...r });
  }

  if (p === '/api/curl' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, await curlSelf(body.path || '/'));
  }

  // ---- 日志下载
  if (p === '/api/logs/download' && req.method === 'GET') {
    const text = logs.map((l) => `[${new Date(l.t || Date.now()).toISOString()}] (${l.source}) ${l.line}`).join('\n');
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="cf-tunnel-panel-log-${Date.now()}.txt"`,
    });
    return res.end(text);
  }

  // ---- Prometheus metrics
  if (p === '/metrics' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(metricsText() + exitMetricsLines());
  }

  // ---- Cloudflare API
  // ---- 命名隧道的「公共主机名」管理（Cloudflare 隧道配置 API，v0.12 新增）----
  // 以前这一步只能去 Cloudflare 后台点，面板只能提醒"只建 CNAME 会 1033"。
  // 现在直接读写 cf d_tunnel/{id}/configurations：加/删主机名 = 改 ingress 规则。
  return false;
}

module.exports = { handle };
