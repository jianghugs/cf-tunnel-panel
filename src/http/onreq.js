'use strict';
/**
 * 请求入口包装层（server.js 里原来那个 `onReq`）。
 *
 * 它干的都是"每个请求都要过一遍"的横切事，和业务无关：
 *   1. 记账 —— 谁在什么时候改了什么（只记会改东西的、鉴权相关的、以及失败的 API 调用）；
 *   2. 计数 —— 面板自身请求量（静态资源与探针端点不算，免得健康检查把 2xx 刷成噪声）；
 *   3. 限流 —— /api/* 每 IP 每秒请求数超了直接 429；
 *   4. 兜底 —— handler 抛错转成 500，不让进程挂掉。
 *
 * 抽出来的动机：这四件事跟路由表毫无关系，却原来埋在 2000 多行的 handler 文件末尾，
 * 想给它加一条规则得先把整个文件读一遍。
 */
const TEST_HEADER = 'x-cfp-test';

/**
 * 审计时整条跳过的路径：高频只读、或者本身就是访问日志。
 * 注意 /api/logs 与 /api/logs/stream 在这里 —— 看日志的动作不该把自己的读取行为再写进日志。
 */
const SKIP_EXACT = ['/metrics', '/badge.svg', '/boot.js', '/api/audit', '/api/audit.csv', '/api/logs', '/api/logs/stream'];
const SKIP_PREFIX = ['/assets/', '/__bench/'];

/** 不算"面板请求"的探针路径：健康检查 / 指标 / 徽章 / 静态资源 / 压测 */
const PROBE_EXACT = ['/healthz', '/metrics', '/badge.svg'];
const PROBE_PREFIX = ['/assets/', '/__bench/'];

function isSkipPath(pathname) {
  if (SKIP_EXACT.indexOf(pathname) >= 0) return true;
  return SKIP_PREFIX.some((pre) => pathname.startsWith(pre));
}

function isProbePath(pathname) {
  if (PROBE_EXACT.indexOf(pathname) >= 0) return true;
  return PROBE_PREFIX.some((pre) => pathname.startsWith(pre));
}

/**
 * @param {{
 *   handler: (req: any, res: any) => Promise<any>,
 *   log: (msg: string, channel?: string) => void,
 *   sendJson: (res: any, status: number, body: any) => any,
 *   rateLimited: (ip: string) => boolean,
 *   auditRecord: (entry: any) => void,
 *   actionOf: (method: string, pathname: string) => string,
 *   isMutation: (method: string, pathname: string) => boolean,
 *   countPanelReq: (status: number, pathname: string) => void,
 *   clientIpOf: (req: any) => string,
 * }} deps
 */
function create(deps) {
  return function onReq(req, res) {
    const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
    const t0 = Date.now();
    const path0 = String(req.url || '').split('?')[0];

    res.on('finish', () => {
      try {
        const skip = isSkipPath(path0);
        if (!isProbePath(path0)) {
          try { deps.countPanelReq(res.statusCode, path0); } catch { /* 计数失败不影响请求 */ }
        }
        if (skip) return;
        if (String(req.headers[TEST_HEADER] || '') === '1') return;   // 测试流量不写审计
        const mutating = req.method !== 'GET' && req.method !== 'HEAD';
        const failed = res.statusCode >= 400 && path0.startsWith('/api');
        if (!mutating && !failed) return;
        deps.auditRecord({
          at: t0,
          actor: req.__who || '(未登录)',
          ip: deps.clientIpOf(req),
          method: req.method,
          path: path0,
          status: res.statusCode,
          ms: Date.now() - t0,
          action: res.statusCode < 400
            ? deps.actionOf(req.method, path0)
            : `${req.method} ${path0}（失败）`,
          ok: res.statusCode < 400,
          mutating: deps.isMutation(req.method, path0),
        });
      } catch { /* 记账失败不影响请求 */ }
    });

    // 跨站防护：写操作如果带了 Origin/Referer 且与当前 Host 不同源 → 403。
    // 只靠 SameSite=Lax 挡不住"同站子域"与老浏览器；curl/测试脚本不带头，照常放行。
    if (req.method !== 'GET' && req.method !== 'HEAD' && String(req.url || '').startsWith('/api/')) {
      const ref = String(req.headers.origin || req.headers.referer || '');
      if (ref) {
        let rh = '';
        try { rh = new URL(ref).host.toLowerCase(); } catch { rh = ''; }
        const host = String(req.headers.host || '').toLowerCase();
        if (rh && host && rh !== host) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end('{"ok":false,"error":"跨站请求被拒绝（Origin 与 Host 不一致）"}');
        }
      }
    }

    if (String(req.url || '').startsWith('/api/') && deps.rateLimited(ip)) {
      res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '10' });
      return res.end('{"ok":false,"error":"请求太频繁，稍后再试"}');
    }

    deps.handler(req, res).catch((e) => {
      deps.log(`请求处理异常 ${req.method} ${req.url}: ${e.stack || e.message}`, 'panel');
      try { deps.sendJson(res, 500, { ok: false, error: e.message }); } catch { /* 响应可能已经发出 */ }
    });
  };
}

module.exports = { create, isSkipPath, isProbePath };
