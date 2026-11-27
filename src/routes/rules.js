'use strict';
/**
 * rules 相关路由（C8 拆分自 src/server.js，块内逻辑逐行未改）。
 * 公共依赖统一在 ./_deps.js（十份样板合并后的唯一一份）。
 */
const {
  path,
  auditRecord,
  PORT,
  readBody,
  sendJson,
  publicRoute,
  saveState,
  validateRoutes,
  state,
  clientIpOf,
  guard,
  buildCaddyConfig,
  caddy,
  pushCaddy,
  simulateMatch,
  probeUpstream,
  authOf,
} = require('./_deps');

async function handle(p, req, res, url) {
  if (p === '/api/caddy/config' && req.method === 'GET') {
    try {
      return sendJson(res, 200, { ok: true, config: buildCaddyConfig() });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e.message });
    }
  }

  if (p === '/api/rules/test' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      return sendJson(res, 200, await probeUpstream(body.upstream));
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (p === '/api/match' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      return sendJson(res, 200, simulateMatch(body.path, body.host, body.method));
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (p === '/api/routes' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const nextRoutes = validateRoutes(body.routes, state.routes);
      const g = guard.inspect(nextRoutes, { panelPort: PORT, prevRoutes: state.routes });
      if (g.blocked && !body.force) {
        return sendJson(res, 409, { ok: false, code: 'GUARD', issues: g.issues, error: g.issues[0].reason, hint: '确认无误就带 force:true 再提交' });
      }
      const prevEnabled = new Map((state.routes || []).map((r) => [r.id, r.enabled !== false]));
      state.routes = nextRoutes;
      saveState('routes');
      await pushCaddy();
      const flipped = nextRoutes.filter((r) => prevEnabled.has(r.id) && prevEnabled.get(r.id) !== (r.enabled !== false));
      if (flipped.length === 1) {
        const f0 = flipped[0];
        auditRecord({
          action: f0.enabled === false ? '停用规则' : '启用规则',
          target: String(f0.name || f0.path || f0.id),
          actor: authOf(req).who, ip: clientIpOf(req), method: req.method, path: p, status: 200, ms: 0,
        });
      }
      return sendJson(res, 200, { ok: true, routes: state.routes.map(publicRoute), caddy });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (p === '/api/caddy/push' && req.method === 'POST') { const c = await pushCaddy(); return sendJson(res, 200, { ok: c.ok, caddy: c }); }

  return false;
}

module.exports = { handle };
