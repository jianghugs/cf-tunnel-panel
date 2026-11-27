'use strict';
/**
 * 隧道出口路由（多出口 CRUD + 单出口动作 + 旧版单隧道接口）。
 *
 * 为什么要整块搬到模块里、而不是只搬 `/api/tunnels/start-all`：
 * 单出口动作走的是正则 `/^\/api\/tunnels\/([\w-]+)(?:\/(start|stop|restart|delete))?$/`，
 * 它会先吃掉 `/api/tunnels/start-all`（把 start-all 当成 id）。所以这几条必须在**同一个
 * 匹配序列**里按「精确路径在前、正则在后」的顺序处理，拆出去就会互相抢。
 */
const path = require('path');
const fs = require('fs');

const _state = require('../core/state');
const _registry = require('../core/registry');
const _tunnels = require('../core/tunnels');
const _util = require('../core/util');

const { newTunnel, saveState } = _state;
const state = _state.stateProxy;
const { firstTunnel, runtimes, tunnelById, tunnelRt } = _registry;
const { applyTunnelFields, publicTunnels, runtimeOf, startAll, startTunnel, stopAll, stopTunnel } = _tunnels;
const { log, readBody, sendJson } = _util;

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
