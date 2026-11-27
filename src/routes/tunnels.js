'use strict';
/**
 * tunnels 相关路由（C8 拆分自 src/server.js，块内逻辑逐行未改）。
 * 公共依赖统一在 ./_deps.js（十份样板合并后的唯一一份）。
 */
const {
  readBody,
  sendJson,
  newTunnel,
  saveState,
  state,
  firstTunnel,
  runtimes,
  tunnelById,
  tunnelRt,
  applyTunnelFields,
  publicTunnels,
  runtimeOf,
  startAll,
  startTunnel,
  stopAll,
  stopTunnel,
} = require('./_deps');

async function handle(p, req, res, url) {
  // ---- 多隧道出口 CRUD
  if (p === '/api/tunnels' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, tunnels: publicTunnels().map((t) => ({ ...t, ...runtimeOf(t.id) })) });
  }
  if (p === '/api/tunnels' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      if (state.tunnels.length >= 8) throw new Error('最多 8 个隧道出口，够用了吧');
      const t = applyTunnelFields(newTunnel(), body);
      state.tunnels.push(t);
      saveState('tunnel-add');
      if (t.enabled) startTunnel(t.id);
      return sendJson(res, 200, { ok: true, id: t.id, tunnels: publicTunnels().map((x) => ({ ...x, ...runtimeOf(x.id) })) });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (p === '/api/tunnels/start-all' && req.method === 'POST') { startAll(); return sendJson(res, 200, { ok: true }); }
  if (p === '/api/tunnels/stop-all' && req.method === 'POST') { stopAll(); return sendJson(res, 200, { ok: true }); }

  const tm = p.match(/^\/api\/tunnels\/([\w-]+)(?:\/(start|stop|restart|delete))?$/);
  if (tm && req.method === 'POST') {
    const t = tunnelById(tm[1]);
    if (!t) return sendJson(res, 404, { ok: false, error: '这个隧道出口不存在（可能已被删除）' });
    const action = tm[2];
    if (action === 'delete') {
      stopTunnel(t.id, true);
      state.tunnels = state.tunnels.filter((x) => x.id !== t.id);
      if (!state.tunnels.length) state.tunnels = [newTunnel({ id: 'main', name: '主隧道出口' })];
      runtimes.delete(t.id);
      saveState('tunnel-del');
      return sendJson(res, 200, { ok: true, tunnels: publicTunnels() });
    }
    if (action === 'start') { startTunnel(t.id); return sendJson(res, 200, { ok: true, status: tunnelRt(t.id).status }); }
    if (action === 'stop') { stopTunnel(t.id); return sendJson(res, 200, { ok: true, status: tunnelRt(t.id).status }); }
    if (action === 'restart') { startTunnel(t.id); return sendJson(res, 200, { ok: true, status: tunnelRt(t.id).status }); }
    try {
      const body = await readBody(req);
      applyTunnelFields(t, body);
      saveState('tunnel');
      startTunnel(t.id);
      return sendJson(res, 200, { ok: true, id: t.id, status: tunnelRt(t.id).status, tunnels: publicTunnels() });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  // 旧接口（单隧道时代）保留，作用于第一个出口，方便老脚本/书签继续用
  if (p === '/api/tunnel' && req.method === 'POST') {
    const t0 = firstTunnel();
    const body = await readBody(req);
    applyTunnelFields(t0, body);
    saveState('tunnel');
    startTunnel(t0.id);
    return sendJson(res, 200, { ok: true, tunnel: { status: tunnelRt(t0.id).status, mode: t0.mode } });
  }
  if (p === '/api/tunnel/start' && req.method === 'POST') { startAll(); return sendJson(res, 200, { ok: true }); }
  if (p === '/api/tunnel/stop' && req.method === 'POST') { stopAll(); return sendJson(res, 200, { ok: true }); }
  return false;
}

module.exports = { handle };
