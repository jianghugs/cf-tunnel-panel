'use strict';
/**
 * backups 相关路由（C8 拆分自 src/server.js，块内逻辑逐行未改）。
 * 公共依赖统一在 ./_deps.js（十份样板合并后的唯一一份）。
 */
const {
  fs,
  path,
  BACKUP_DIR,
  SEC_HEADERS,
  log,
  readBody,
  sendJson,
  setState,
  deepDefault,
  defaultState,
  migrateState,
  normalizeTunnels,
  saveState,
  validateRoutes,
  state,
  clearBasicCache,
  session,
  secret,
  pushCaddy,
  syncTunnels,
  diffRoutes,
  dockerContainers,
  _notify,
  notify,
  authOf,
} = require('./_deps');

async function handle(p, req, res, url) {
  if (p === '/api/backups/diff' && req.method === 'GET') {
    try {
      const name = String(url.searchParams.get('a') || '').trim();
      if (!/^[\w.\-]+\.json$/.test(path.basename(name))) throw new Error('备份文件名不合法');
      const file = path.join(BACKUP_DIR, path.basename(name));
      if (!fs.existsSync(file)) throw new Error('找不到这份备份');
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      migrateState(parsed);
      const oldState = deepDefault(parsed, defaultState());
      const d = diffRoutes(oldState.routes, state.routes);
      return sendJson(res, 200, { ok: true, against: path.basename(name), currentRoutes: state.routes.length, backupRoutes: oldState.routes.length, ...d });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (p === '/api/backups' && req.method === 'GET') {
    try {
      const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, 20);
      return sendJson(res, 200, { ok: true, files });
    } catch {
      return sendJson(res, 200, { ok: true, files: [] });
    }
  }

  // 备份单份下载（要把某份配置拿走看/存档时用）
  if (p === '/api/backups/download' && req.method === 'GET') {
    const name = String(url.searchParams.get('file') || '');
    if (!/^[\w.\-]+\.json$/.test(name)) return sendJson(res, 400, { ok: false, error: '文件名不合法' });
    const full = path.join(BACKUP_DIR, name);
    try {
      const body = fs.readFileSync(full);
      res.writeHead(200, {
        ...SEC_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'no-store',
        'Content-Length': body.length,
      });
      return res.end(body);
    } catch {
      return sendJson(res, 404, { ok: false, error: '没有这份备份（可能已被清理）' });
    }
  }

  // 一键回滚到某份滚动备份
  if (p === '/api/backups/restore' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const name = path.basename(String(body.file || ''));
      if (!/^[\w.\-]+\.json$/.test(name)) throw new Error('备份文件名不合法');
      const file = path.join(BACKUP_DIR, name);
      if (!fs.existsSync(file)) throw new Error('备份不存在：' + name);
      const prevTunnels = JSON.parse(JSON.stringify(state.tunnels));
      const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
      migrateState(obj);
      const next = deepDefault(obj, defaultState());
      next.routes = validateRoutes(next.routes || [], state.routes);
      next.version = 3;
      setState(next);
      normalizeTunnels();
      saveState('restore');
      await pushCaddy();
      const restarted = syncTunnels(prevTunnels);
      log(`已回滚到备份 ${name}（${state.routes.length} 条规则${restarted.length ? '，重启出口：' + restarted.join('、') : ''}）`, 'panel');
      return sendJson(res, 200, { ok: true, file: name, routeCount: state.routes.length, restarted });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  // ---- Docker 容器（一键加规则）
  if (p === '/api/docker/containers' && req.method === 'GET') {
    return sendJson(res, 200, await dockerContainers());
  }

  // ---- 通知测试
  if (p === '/api/viewer' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const user = String(body.user || '').trim();
      const pass = String(body.pass || '');
      if (user && !/^[\w.@-]{1,40}$/.test(user)) throw new Error('只读账号名只能用字母数字和 . _ - @');
      if (user && pass && pass.length < 6) throw new Error('只读密码至少 6 位');
      if (!user) state.viewer = { user: '', pass: '' };
      else {
        state.viewer = { user, pass: pass ? secret.hash(pass) : ((state.viewer && state.viewer.pass) || '') };
        if (!state.viewer.pass) throw new Error('只读账号还要给一个密码');
      }
      saveState('viewer');
      clearBasicCache();
      // 只踢「这个只读账号」自己的会话：管理员在设置页加/改只读账号，不该把自己踢下线
      const kickedViewer = user ? session.revokeUser(user, authOf(req).sid) : 0;
      log(user ? `已设置只读账号 ${user}` + (kickedViewer ? `（该账号 ${kickedViewer} 个会话已失效）` : '') : '已关闭只读账号', 'panel');
      return sendJson(res, 200, { ok: true, viewer: { user: state.viewer.user, hasPass: !!state.viewer.pass }, relogin: kickedViewer > 0, revoked: kickedViewer });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (p === '/api/notify/test' && req.method === 'POST') {
    let channelId = '';
    try { const b = await readBody(req); channelId = String(b.channelId || ''); } catch { /* 无 body 就发全部 */ }
    const channels = _notify.channelList();
    const okSent = await notify('test', '面板通知测试', `${state.tunnels.length} 个出口，${state.routes.length} 条规则`,
      { force: true, ignoreDisabled: true, channelId });
    return sendJson(res, 200, {
      ok: okSent,
      configured: channels.length > 0,
      channels: channels.map((c) => ({ id: c.id, name: c.name, format: c.format })),
      channelId: channelId || 'all',
    });
  }

  // ---- 一次性分享链接
  return false;
}

module.exports = { handle };
