'use strict';
/**
 * authroutes 相关路由（C8 拆分自 src/server.js，块内逻辑逐行未改）。
 * 公共依赖统一在 ./_deps.js（十份样板合并后的唯一一份）。
 */
const {
  QRCode,
  bcrypt,
  path,
  auditRecord,
  log,
  readBody,
  sendJson,
  saveState,
  state,
  publicUrlOf,
  clearBasicCache,
  clientIpOf,
  session,
  secret,
  totp,
  perm,
  authOf,
} = require('./_deps');

async function handle(p, req, res, url) {
  // 会话管理
  if (p === '/api/sessions' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, cookie: session.COOKIE, sessions: session.list(authOf(req).sid), ttlDays: Math.round(session.TTL_MS / 86400000) });
  }

  if (p === '/api/sessions/revoke' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const full = session.resolveKey(body && body.id);
    if (!full) return sendJson(res, 404, { ok: false, error: '这个会话已经不存在了（可能已过期或被踢）' });
    const isSelf = full === authOf(req).sid;
    session.revoke(full);
    if (isSelf) res.setHeader('Set-Cookie', session.clearCookieHeader());
    return sendJson(res, 200, { ok: true, self: isSelf });
  }

  if (p === '/api/sessions/revoke-all' && req.method === 'POST') {
    const n = session.revokeAll();
    res.setHeader('Set-Cookie', session.clearCookieHeader());
    auditRecord({ actor: authOf(req).who, ip: clientIpOf(req), method: 'POST', path: p, status: 200, action: '退出全部登录会话', target: `${n} 个` });
    return sendJson(res, 200, { ok: true, revoked: n });
  }

  if (p === '/api/sessions/revoke-others' && req.method === 'POST') {
    const n = session.revokeOthers(authOf(req).sid);
    return sendJson(res, 200, { ok: true, revoked: n });
  }

  // ---------- 运维账号（admin 专属，perm 已挡） ----------
  if (p === '/api/operator' && req.method === 'POST') {
    const body = await readBody(req);
    const oUser = String(body.user || '').trim();
    const oPass = String(body.pass || '');
    if (oUser && !/^[\w.@-]{1,40}$/.test(oUser)) return sendJson(res, 400, { ok: false, error: '账号只能是字母数字和 . _ @ -' });
    if (oUser && oPass && oPass.length < 6) return sendJson(res, 400, { ok: false, error: '运维账号密码至少 6 位' });
    state.operator.user = oUser;
    if (!oUser) state.operator.pass = '';
    else if (oPass) state.operator.pass = secret.hash(oPass);
    saveState('operator');
    clearBasicCache();
    const kicked = oUser ? session.revokeUser(oUser, authOf(req).sid) : 0;
    log(oUser ? `运维账号已设置：${oUser}` + (kicked ? `（该账号 ${kicked} 个会话已失效）` : '') : '运维账号已关闭', 'panel');
    return sendJson(res, 200, { ok: true, operator: { user: oUser, hasPass: !!state.operator.pass }, revoked: kicked, relogin: kicked > 0 });
  }

  // ---------- 二次验证 TOTP（admin 专属） ----------
  if (p === '/api/totp/setup' && req.method === 'POST') {
    const s3 = totp.newSecret();
    state.totp.pending = s3;
    saveState('totp-setup');
    const otpauth = totp.otpauthUrl({ secret: s3, label: state.panel.user || 'admin', issuer: 'cf-tunnel-panel' });
    let qr = '';
    try { qr = await QRCode.toDataURL(otpauth, { margin: 1, width: 240 }); } catch { qr = ''; }
    log('已生成 TOTP 密钥，等待验证码确认', 'panel');
    return sendJson(res, 200, { ok: true, secret: s3, otpauth, qr });
  }

  if (p === '/api/totp/enable' && req.method === 'POST') {
    const body = await readBody(req);
    const pending = (state.totp && state.totp.pending) || '';
    if (!pending) return sendJson(res, 400, { ok: false, error: '先点「生成二维码」，用手机 App 扫一下' });
    if (totp.verify(pending, body.code) === null) return sendJson(res, 400, { ok: false, error: '验证码不对：确认手机时间准确，再输入当前 6 位数字' });
    const rec = totp.newRecovery(10);
    state.totp = { enabled: true, secret: pending, pending: '', recovery: rec.hashed };
    saveState('totp-enable');
    auditRecord({ actor: authOf(req).who, ip: clientIpOf(req), method: 'POST', path: p, status: 200, action: '开启二次验证', target: 'TOTP' });
    log('二次验证已开启（下次登录需要 6 位验证码）', 'panel');
    return sendJson(res, 200, { ok: true, enabled: true, recoveryCodes: rec.plain });
  }

  if (p === '/api/totp/disable' && req.method === 'POST') {
    const body = await readBody(req);
    const conf = state.totp || {};
    let okCode = false;
    if (conf.secret && /^\d{6}$/.test(String(body.code || '').trim())) okCode = totp.verify(conf.secret, body.code) !== null;
    if (!okCode && body.code) {
      const h = totp.hashRecovery(body.code);
      okCode = ((conf.recovery || []).indexOf(h) >= 0);
    }
    if (!okCode) return sendJson(res, 400, { ok: false, error: '要关掉二次验证，得先输入一个当前验证码或恢复码' });
    state.totp = { enabled: false, secret: '', pending: '', recovery: [] };
    saveState('totp-disable');
    auditRecord({ actor: authOf(req).who, ip: clientIpOf(req), method: 'POST', path: p, status: 200, action: '关闭二次验证', target: '' });
    log('二次验证已关闭', 'panel');
    return sendJson(res, 200, { ok: true, enabled: false });
  }

  if (p === '/api/totp/recovery' && req.method === 'POST') {
    const body = await readBody(req);
    const conf = state.totp || {};
    if (!conf.enabled || !conf.secret) return sendJson(res, 400, { ok: false, error: '二次验证还没开启' });
    const code = String(body.code || '').trim();
    let pass = false;
    if (/^\d{6}$/.test(code)) pass = totp.verify(conf.secret, code) !== null;
    if (!pass && code) pass = ((conf.recovery || []).indexOf(totp.hashRecovery(code)) >= 0);
    if (!pass) return sendJson(res, 400, { ok: false, error: '要重新生成恢复码，得先输入当前验证码或一个旧恢复码' });
    const pack = totp.newRecovery(10);
    state.totp.recovery = pack.hashed;
    saveState('totp-recovery');
    auditRecord({ actor: authOf(req).who, ip: clientIpOf(req), method: 'POST', path: p, status: 200, action: '重新生成恢复码', target: '10 个' });
    log('已重新生成 10 个恢复码，旧的全部作废', 'panel');
    return sendJson(res, 200, { ok: true, recovery: pack.plain });
  }

  if (p === '/api/panel-auth' && req.method === 'POST') {
    const body = await readBody(req);
    const pUser = String(body.user || '').trim();
    const pPass = String(body.pass || '');
    if (pUser && pPass.length < 4) return sendJson(res, 400, { ok: false, error: '面板密码至少 4 位' });
    state.panel.user = pUser;
    // 口令只存 bcrypt 哈希：state.json、备份、导出里都不再出现明文
    state.panel.pass = pPass ? secret.hash(pPass) : '';
    saveState('panel-auth');
    clearBasicCache();
    // 改口令等于「我不相信现在所有还登着的设备」：全踢，让所有人重新登录。
    const kicked = state.panel.user ? session.revokeAll() : 0;
    if (kicked) {
      res.setHeader('Set-Cookie', session.clearCookieHeader());
      log(`面板口令已更新，已踢掉 ${kicked} 个登录会话`, 'panel');
      auditRecord({ actor: authOf(req).who, ip: clientIpOf(req), method: 'POST', path: p, status: 200, action: '改面板口令并踢掉所有会话', target: `${kicked} 个` });
    }
    return sendJson(res, 200, { ok: true, authEnabled: !!state.panel.user, relogin: kicked > 0, revoked: kicked });
  }

  if (p === '/api/qr' && req.method === 'GET') {
    const text = url.searchParams.get('text') || state.tunnels.map(publicUrlOf).filter(Boolean)[0] || '';
    if (!text) return sendJson(res, 400, { ok: false, error: '没有可编码的内容' });
    if (text.length > 1200) return sendJson(res, 400, { ok: false, error: '内容太长（最多 1200 字符），二维码会密到扫不出来' });
    try {
      return sendJson(res, 200, { ok: true, text, dataUrl: await QRCode.toDataURL(text, { margin: 1, width: 360, errorCorrectionLevel: 'M' }) });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  return false;
}

module.exports = { handle };
