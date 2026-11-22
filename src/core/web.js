'use strict';
/**
 * 页面外壳与静态资源（含 ETag / gzip）
 * 从 src/server.js 按职责拆出（v0.9.0），仅做搬运，行为不变。
 */

  const crypto=require('crypto');
const zlib=require('zlib');  const fs=require('fs');
const path=require('path');

const { PAGES, PAGE_DIR } = require('./paths');
const i18n = require('./i18n');
const { buildInfo } = require('./ident');

// 资源指纹：代码一变，URL 就变 → 可以给 /assets/* 上「一年 immutable」长缓存
const ASSET_V = (() => { try { return (buildInfo().code || 'dev').slice(0, 8); } catch { return 'dev'; } })();
const AV = (f) => `/assets/${f}?v=${ASSET_V}`;
const _state = require('./state');
const state = _state.stateProxy;
function readPage(file) {
  try {
    return fs.readFileSync(path.join(PAGE_DIR, file + '.html'), 'utf8');
  } catch {
    return `<div class="content"><div class="card"><div class="bd"><div class="hint err">页面 ${file} 缺失，请检查 src/web/pages/</div></div></div></div>`;
  }
}

// 整页外壳：左侧导航 + 顶部标题栏 + 页面主体
function pageShell(active, body, lang = 'zh') {
  // 备份实例的页面也要显示「另一个实例刚改过的」配置
  try { require('./state').maybeReloadState(1000); } catch {}
  const title = state.settings.panelTitle || 'Cloudflare 隧道面板';
  const nav = PAGES.map((pg) => {
    const on = pg.path === active ? ' active' : '';
    return `<a class="${on ? 'active' : ''}" href="${pg.path}"><span class="ico">${pg.ico}</span><span>${i18n.t(lang, pg.title)}</span></a>`;
  }).join('');
  const activePage = PAGES.find((x) => x.path === active) || PAGES[0];
  return `<!doctype html>
<html lang="${lang === 'en' ? 'en' : 'zh-CN'}" data-theme="dark">
<head>
<meta charset="utf-8">
<link rel="manifest" href="/assets/manifest.webmanifest" />
  <link rel="icon" href="/assets/icon.svg" type="image/svg+xml" />
  <meta name="theme-color" content="#1b7f5a" />
  <meta name="viewport" content="width=device-width, initial-scale=1">
<title>${i18n.t(lang, activePage.title)} · ${title}</title>
<link rel="stylesheet" href="${AV('app.css')}">
<link rel="icon" href="/badge.svg" type="image/svg+xml">
</head>
<body>
<a class="skip-link" href="#main">${i18n.t(lang, '跳到主内容')}</a>
<div class="shell">
  <aside class="side" aria-label="侧边导航">
    <div class="brand"><span class="logo" aria-hidden="true">CF</span><div><div class="nm">${title}</div><div class="ver">v${VERSION}</div></div></div>
    <div class="side-tools">
      <button class="sm ghost" id="btnTheme" title="切换深色 / 浅色" aria-label="切换深色或浅色主题">🌙</button>
      <button class="sm ghost" id="btnPalette" title="命令面板（Ctrl+K）" aria-label="打开命令面板">⌘K</button>
      <button class="sm ghost" id="btnLang" title="${i18n.t(lang, '切换语言')}" aria-label="${i18n.t(lang, '切换语言')}">${lang === 'en' ? '中文' : 'EN'}</button>
    </div>
    <nav class="nav" aria-label="页面导航">${nav}</nav>
    <a class="nav-quick" href="/monitor#check" title="${i18n.t(lang, '一键体检：12 项检查一次跑完')}"><span class="ico" aria-hidden="true">🩺</span><span>${i18n.t(lang, '一键体检')}</span></a>
    <div class="side-foot">
      <div class="row"><span class="dot" id="healthDot" aria-hidden="true"></span><span class="muted" id="healthText" role="status">${i18n.t(lang, '检测中…')}</span></div>
      <div class="row"><span class="tag warn hidden" id="unsaved" title="有改动还没保存">未保存</span>
      <span class="tag hidden" id="roleTag" aria-live="polite"></span>
      <button class="sm ghost" id="btnLogout" title="${i18n.t(lang, '退出登录')}" aria-label="${i18n.t(lang, '退出登录')}">${i18n.t(lang, '退出')}</button></div>
      <div class="muted" style="font-size:11px">© <span id="year"></span> cf-tunnel-panel</div>
    </div>
  </aside>
  <main class="main" id="main">
${body}
  </main>
</div>
<script src="/boot.js?v=${ASSET_V}"></script>
<script src="${AV('app.js')}"></script>
<script src="${AV(activePage.file + '.js')}"></script>
</body>
</html>`;
}

/** 独立登录页：不套外壳（没登录时不该看到导航），自带一点样式。 */
function loginPage({ next = '/', error = '', lang = 'zh' } = {}) {
  const title = (state.settings && state.settings.panelTitle) || 'Cloudflare 隧道面板';
  const safeNext = String(next || '/').startsWith('/') ? String(next || '/') : '/';
  const t = (k) => i18n.t(lang, k);
  return `<!doctype html>
<html lang="${lang === 'en' ? 'en' : 'zh-CN'}" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t('登录')} · ${title}</title>
<link rel="stylesheet" href="${AV('app.css')}">
<link rel="icon" href="/badge.svg" type="image/svg+xml">
</head>
<body class="login-body">
<div class="login-wrap">
  <aside class="login-hero">
    <div class="brand">
      <span class="logo" aria-hidden="true">CF</span>
      <div><div class="nm">${title}</div><div class="ver">v${VERSION}</div></div>
    </div>
    <h2>${t('把家里的服务，安全地放到公网')}</h2>
    <ul class="feat">
      <li><span class="ico" aria-hidden="true">◧</span><div><b>${t('多出口')}</b><em>${t('快速隧道与命名隧道可以同时跑，换域名不用改配置')}</em></div></li>
      <li><span class="ico" aria-hidden="true">⤳</span><div><b>${t('规则分流')}</b><em>${t('一条隧道挂多个服务：路径分流、基础认证、IP 白名单')}</em></div></li>
      <li><span class="ico" aria-hidden="true">◫</span><div><b>${t('看得见')}</b><em>${t('访问统计、审计日志、Prometheus 指标与告警')}</em></div></li>
    </ul>
    <p class="foot">${t('开源 MIT')} · <a href="https://github.com/jianghugs/cf-tunnel-panel" target="_blank" rel="noopener">github.com/jianghugs/cf-tunnel-panel</a></p>
  </aside>
  <main class="login-card">
    <div class="login-tools">
      <button class="mini" type="button" id="btnLang" title="${t('切换语言')}">${lang === 'en' ? '中文' : 'EN'}</button>
      <button class="mini" type="button" id="btnTheme" title="${t('深浅色')}" aria-label="${t('深浅色')}">◐</button>
    </div>
    <h1>${t('管理员登录')}</h1>
    <p class="sub">${t('输入管理员账号登录')}</p>
    <form id="loginForm" autocomplete="on" data-next="${safeNext}">
      <div class="cred">
        <div class="field" id="uField">
          <label for="u">${t('用户名')}</label>
          <input id="u" name="username" autocomplete="username" required autofocus aria-describedby="uErr">
          <p class="fmsg hidden" id="uErr" role="alert"></p>
        </div>
        <div class="field" id="pField">
          <label for="p">${t('密码')}</label>
          <div class="pwd">
            <input id="p" name="password" type="password" autocomplete="current-password" required aria-describedby="pErr">
            <button class="eye" type="button" id="btnReveal" aria-label="${t('显示密码')}" title="${t('显示密码')}" aria-pressed="false">👁</button>
          </div>
          <p class="fmsg hidden" id="pErr" role="alert"></p>
        </div>
        <div class="field hidden" id="tWrap">
          <label for="t">${t('二次验证码')}</label>
          <input id="t" name="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="9" aria-describedby="tHint">
          <p class="fmsg faint" id="tHint">${t('验证器 App 里的 6 位数字，或恢复码（XXXX-XXXX）')}</p>
        </div>
        <label class="remember" for="rem">
          <input class="chk" type="checkbox" id="rem" checked>
          <span>${t('记住这台设备 30 天')}</span>
        </label>
      </div>
      <div class="hint err hidden" id="err" role="alert"></div>
      <button class="primary login-submit" type="submit">${t('登录')}</button>
    </form>
    <p class="tips">${t('不勾选「记住这台设备」时，登录状态保留 7 天；随时可在「设置 → 登录会话」里查看并踢掉其它设备。')}</p>
  </main>
</div>
<script src="/boot.js?v=${ASSET_V}"></script>
<script src="${AV('login.js')}"></script>
</body>
</html>`;
}

// 文本响应：带 ETag（命中 304）+ gzip，省流量也省得每次重传
// extra 用来加 CDN 侧的头（例如 Cloudflare-CDN-Cache-Control：让边缘缓存更久，浏览器只缓存 5 分钟）
function serveText(req, res, body, type, cache = 'no-cache', extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const ae0 = String(req.headers['accept-encoding'] || '');
  const canGz = buf.length > 512 && /\bgzip\b/.test(ae0) && /text|json|javascript|svg/.test(type);
  // ETag 必须区分「压缩版 / 原版」：同一个 URL 两种编码若共用一个 ETag，
  // 中间缓存可能把 gzip 的字节当原文发给不支持 gzip 的客户端。
  const etag = 'W/"' + buf.length.toString(16) + '-' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12) + (canGz ? '-gz' : '-id') + '"';
  const headers = Object.assign({ 'Content-Type': type, 'Cache-Control': cache, ETag: etag, Vary: 'Accept-Encoding' }, SEC_HEADERS, extra);
  if (/^text\/html/.test(type)) {
    // frame-src 只放行「设置里填的那个 Grafana 源」：不写死 *，也不允许任意站点被嵌进来
    // 正式地址和局域网直连地址都要放行：局域网打开面板时嵌的是 lanUrl，
    // 只写 url 会让 iframe 被 CSP 当非法来源拦掉（表现成一块灰板）。
    let frameSrc = "'self'";
    try {
      const g = (state.settings || {}).grafana || {};
      if (g.enabled) {
        for (const raw of [g.url, g.lanUrl]) {
          if (!raw) continue;
          try {
            const u = new URL(raw);
            const origin = `${u.protocol}//${u.host}`;
            if (!frameSrc.includes(origin)) frameSrc += ` ${origin}`;
          } catch { /* 单个地址写坏就跳过它 */ }
        }
      }
    } catch { /* 配置坏了就退化成只允许 self */ }
    headers['Content-Security-Policy'] = `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' https://static.cloudflareinsights.com; connect-src 'self' https://cloudflareinsights.com; frame-src ${frameSrc}; base-uri 'none'; form-action 'self'`;
  }
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  if (canGz) {
    const gz = zlib.gzipSync(buf, { level: 6 });
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = gz.length;
    res.writeHead(200, headers);
    return res.end(gz);
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(200, headers);
  return res.end(buf);
}


const { VERSION } = require('./paths');
const { SEC_HEADERS } = require('./util');

module.exports = { pageShell, readPage, serveText, loginPage };
