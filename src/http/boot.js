'use strict';
/**
 * /boot.js —— 首帧就绪脚本。
 *
 * 为什么它值得单独一个模块：它必须**先于样式表**加载（页面 head 里排在 app.css 前面），
 * 而且在第一次绘制之前就把 data-theme 贴到 <html> 上，否则浅色主题会闪一下深色。
 * CSP 不允许内联脚本，所以这十几行只能走外部文件。
 *
 * 内容三件事：
 *   1. 读 localStorage 的 cfp-theme，没有就跟系统偏好（prefers-color-scheme）；
 *   2. 写 window.__CFP_LANG（当前语言）；
 *   3. 写 window.__CFP_DICT（前端字典，供 app.js 的 dictLookup 查表）。
 */
const zlib = require('zlib');

const THEME_BOOT =
  'try{var t=localStorage.getItem("cfp-theme");'
  + 'if(!t)t=(window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches)?"light":"dark";'
  + 'document.documentElement.setAttribute("data-theme",t)}catch(e){}';

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {{lang: string, dict: string}} payload
 */
function serve(req, res, payload) {
  const js = THEME_BOOT
    + `window.__CFP_LANG=${JSON.stringify(payload.lang)};window.__CFP_DICT=${payload.dict};`;
  const buf = Buffer.from(js);
  const ae = String(req.headers['accept-encoding'] || '');
  const gz = buf.length > 1024 && /gzip/.test(ae);
  const out = gz ? zlib.gzipSync(buf, { level: 6 }) : buf;
  const head = {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Accept-Encoding',
  };
  if (gz) head['Content-Encoding'] = 'gzip';
  head['Content-Length'] = out.length;
  res.writeHead(200, head);
  return res.end(out);
}

module.exports = { serve, THEME_BOOT };
