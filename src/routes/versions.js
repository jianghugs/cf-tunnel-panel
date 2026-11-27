'use strict';
/**
 * 版本与回滚相关路由（GET /api/versions、GET/POST /api/versions/rollback）。
 *
 * 面板容器里没有 docker CLI，也不该拿特权：这里只做两件事 ——
 *   ① 通过 /var/run/docker.sock 的 HTTP API 读出本机有哪些 cf-tunnel-panel:<tag> 镜像；
 *   ② POST 回滚时把请求写进 DATA_DIR/ops/rollback.json，由宿主机 cron 的
 *      tools/ops-agent.sh 执行 tools/rollback.sh，跑完把结果写回 rollback-result.json。
 * 这样「点一下就回滚」是有的，但真正动 docker 的手在宿主机上，容器保持非特权。
 */

const { fs, path, DATA_DIR, VERSION, log, sendJson, readBody, authOf, clientIpOf, auditRecord } = require('./_deps');
const _integrations = require('../core/integrations');

const VER_RE = /^\d+\.\d+\.\d+$/;

function opsDir() {
  const d = path.join(DATA_DIR, 'ops');
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  return d;
}
const reqFile = () => path.join(opsDir(), 'rollback.json');
const resultFile = () => path.join(opsDir(), 'rollback-result.json');

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function writeJson(p, obj) {
  const t = `${p}.tmp`;
  fs.writeFileSync(t, JSON.stringify(obj, null, 2));
  fs.renameSync(t, p);
}

async function localImages() {
  let raw;
  try {
    raw = await _integrations.dockerApi('/images/json');
  } catch (e) {
    return { available: false, error: e.message, images: [] };
  }
  const images = [];
  for (const it of Array.isArray(raw) ? raw : []) {
    for (const t of it.RepoTags || []) {
      const m = /^cf-tunnel-panel:(\S+)$/.exec(String(t));
      if (!m) continue;
      images.push({
        tag: m[1],
        id: String(it.Id || '').replace(/^sha256:/, '').slice(0, 12),
        created: (Number(it.Created) || 0) * 1000,
        size: Number(it.Size) || 0,
      });
    }
  }
  images.sort((a, b) => b.created - a.created);
  return { available: true, error: null, images };
}

function audit(req, action, target, status) {
  try {
    auditRecord({
      actor: authOf(req).who,
      ip: clientIpOf(req),
      method: req.method,
      path: req.url,
      status: status || 200,
      action,
      target,
    });
  } catch (e) {}
}

// ---- 新版本检查（GitHub releases/latest，6 小时缓存，失败静默）
const GH_REPO = 'jianghugs/cf-tunnel-panel';
let _verCache = { at: 0, data: null };
function cmpVer(a, b) {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}
async function latestRelease() {
  if (_verCache.data && Date.now() - _verCache.at < 6 * 3600e3) return _verCache.data;
  const url = 'https://api.github.com/repos/' + GH_REPO + '/releases/latest';
  let body = null;
  const hdr = { 'User-Agent': 'cf-tunnel-panel', Accept: 'application/vnd.github+json' };
  try {
    const r = await getV4(url, { timeout: 8000, headers: hdr, maxBytes: 256 * 1024 });
    if (r.status === 200) body = r.body;
  } catch (e) {
    try {
      const r = await fetch(url, { headers: hdr, signal: AbortSignal.timeout(8000) });
      if (r.ok) body = await r.text();
    } catch (e2) { body = null; }
  }
  if (!body) throw new Error('读取 GitHub 版本信息失败');
  let j = null;
  try { j = JSON.parse(body); } catch (e) { throw new Error('GitHub 返回的不是 JSON'); }
  const tag = String(j.tag_name || '').replace(/^v/, '');
  if (!tag) throw new Error('GitHub 没有返回版本号');
  const data = {
    latest: tag,
    url: j.html_url || ('https://github.com/' + GH_REPO + '/releases/latest'),
    publishedAt: j.published_at || null,
    notes: String(j.body || '').slice(0, 1200),
  };
  _verCache = { at: Date.now(), data };
  return data;
}

async function handle(p, req, res, url) {
  if (p === '/api/versions' && req.method === 'GET') {
    const imgs = await localImages();
    sendJson(res, 200, {
      ok: true,
      current: VERSION,
      available: imgs.available,
      error: imgs.error,
      images: imgs.images,
      pending: readJson(reqFile()),
      lastRun: readJson(resultFile()),
    });
    return true;
  }

  if (p === '/api/versions/rollback' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      current: VERSION,
      pending: readJson(reqFile()),
      lastRun: readJson(resultFile()),
    });
    return true;
  }

  if (p === '/api/versions/rollback' && req.method === 'POST') {
    let body = {};
    try {
      body = await readBody(req);
      if (typeof body === 'string') body = JSON.parse(body || '{}');
    } catch (e) {
      sendJson(res, 400, { ok: false, error: '请求体读不出来（要 JSON）' });
      return true;
    }
    body = body || {};
    const want = String(body.version || '').trim();
    const confirm = String(body.confirm || '').trim();
    if (!VER_RE.test(want)) { sendJson(res, 400, { ok: false, error: '版本号要写成 0.29.60 这种三段式' }); return true; }
    if (confirm !== want) { sendJson(res, 400, { ok: false, error: '二次确认没对上：要手动输入目标版本号' }); return true; }
    if (want === VERSION) { sendJson(res, 400, { ok: false, error: `当前已经在 ${want}，不用回滚` }); return true; }
    const imgs = await localImages();
    if (!imgs.available) { sendJson(res, 503, { ok: false, error: `读不到 Docker：${imgs.error}` }); return true; }
    if (!imgs.images.some((x) => x.tag === want)) {
      const avail = imgs.images.map((x) => x.tag).join(' / ') || '（没有）';
      sendJson(res, 400, { ok: false, error: `本机没有 cf-tunnel-panel:${want} 镜像。可回滚的版本：${avail}` });
      return true;
    }
    const prev = readJson(reqFile());
    if (prev && prev.version) {
      sendJson(res, 409, { ok: false, error: `已有一个回滚请求在排队（目标 ${prev.version}），等它跑完再点` });
      return true;
    }
    writeJson(reqFile(), { version: want, from: VERSION, at: Date.now(), by: authOf(req).who || '' });
    audit(req, '回滚面板', `${VERSION} → ${want}`);
    log(`回滚请求已排队：${VERSION} → ${want}（等宿主机 ops-agent 执行）`, 'panel');
    sendJson(res, 200, { ok: true, queued: true, version: want });
    return true;
  }

  if (p === '/api/version/latest' && req.method === 'GET') {
    try {
      const rel = await latestRelease();
      return sendJson(res, 200, {
        ok: true, current: VERSION, latest: rel.latest,
        hasUpdate: cmpVer(rel.latest, VERSION) > 0,
        url: rel.url, publishedAt: rel.publishedAt, notes: rel.notes,
        checkedAt: Date.now(),
      });
    } catch (e) {
      return sendJson(res, 200, { ok: false, current: VERSION, error: e.message, checkedAt: Date.now() });
    }
  }

  return false;
}

module.exports = { handle };
