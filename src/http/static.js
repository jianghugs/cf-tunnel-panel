'use strict';
/**
 * 静态资源应答（/assets/*）。
 *
 * 这段逻辑原来长在 server.js 的路由大函数里，和业务分支挤在一起；
 * 抽出来的原因只有一个：它免登录、只读、无状态，是最适合先搬走的一块。
 *
 * 缓存策略：页面引用资源时带 `?v=<代码指纹>`，URL 跟着代码变，
 * 所以带指纹的可以放心给一年 + immutable；不带的只给 5 分钟。
 */
const fs = require('fs');
const path = require('path');
const { serveText } = require('../core/web');

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} p  已解析的 pathname（必须以 /assets/ 开头）
 * @param {{assetDir: string, assetTypes: Record<string,string>}} cfg
 */
function serveAsset(req, res, p, cfg) {
  const name = path.basename(p.slice('/assets/'.length));
  const file = path.join(cfg.assetDir, name);
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    const type = cfg.assetTypes[path.extname(name).toLowerCase()] || 'application/octet-stream';
    const hashed = /[?&]v=/.test(req.url || '');
    const cc = hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=300';
    const cdn = hashed ? 'public, max-age=31536000' : 'public, max-age=86400';
    return serveText(req, res, fs.readFileSync(file), type, cc, {
      'CDN-Cache-Control': cdn,
      'Cloudflare-CDN-Cache-Control': cdn,
    });
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  return res.end('404');
}

module.exports = { serveAsset };
