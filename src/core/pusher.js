'use strict';
/**
 * Caddy 配置下发（防抖 + 失败记录）
 * 从 src/server.js 按职责拆出（v0.9.0），仅做搬运，行为不变。
 */

const http=require('http'); const https=require('https');

const { CADDY_ADMIN } = require('./paths');
const { log } = require('./util');
const { buildCaddyConfig, caddy } = require('./caddy');
let pushTimer = null;
// 规则按出口域名收窄，所以出口上线/掉线/换域名后必须重新下发一次
function schedulePush(delay = 500) {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushCaddy().catch(() => {});
  }, delay);
  if (pushTimer.unref) pushTimer.unref();
}

// Cloudflare 公布的边缘节点 IP 段（https://www.cloudflare.com/ips/）。
// 隧道进来的流量对端是这些节点，真实访客 IP 在 CF-Connecting-IP 头里；
// 要按真实访客做 IP 白名单/黑名单，必须先让 Caddy 信任这些代理段。
// 段表会变（Cloudflare 偶尔新增），可用环境变量 CLOUDFLARE_IPS 覆盖（逗号分隔）。
async function pushOnce() {
  let cfg;
  try {
    cfg = buildCaddyConfig();
  } catch (e) {
    caddy.ok = false;
    caddy.error = '生成配置失败: ' + e.message;
    log(caddy.error, 'caddy');
    return caddy;
  }
  try {
    // admin 端口可能刚从旧地址搬过来（2019 → 20190）：挨个试，先成功的那条以后优先用
    // 每项是 [admin 地址, 该地址允许的 Origin]：Caddy 会校验 Origin 是否在 admin.origins 里
    // 默认只认 CADDY_ADMIN 这一个地址。历史上有过一条"挨个试 2019/20190"的兜底，
    // 结果一个把 CADDY_ADMIN 指向假端口（9999）的测试实例，靠兜底打到了线上 Caddy，
    // 用它的空白配置把生产规则冲掉（2026-11-16）。要迁移 admin 端口就显式设
    // PANEL_ADMIN_FALLBACK=1，或者改完 CADDY_ADMIN 重启一次。
    const cands = [[CADDY_ADMIN, CADDY_ADMIN]];
    if (process.env.PANEL_ADMIN_FALLBACK === '1') {
      cands.push(['http://127.0.0.1:2019', 'http://localhost:2019']);
      cands.push(['http://localhost:2019', 'http://localhost:2019']);
      cands.push(['http://127.0.0.1:20190', 'http://127.0.0.1:20190']);
    }
    let res = null;
    let lastErr = null;
    for (const [base, origin] of cands) {
      try {
        const r = await fetch(`${base}/load`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: origin },
          body: JSON.stringify(cfg),
          signal: AbortSignal.timeout(8000),
        });
        if (r.ok) { res = r; if (base !== CADDY_ADMIN) log(`Caddy admin 走备用地址 ${base}`, 'caddy'); break; }
        lastErr = new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
      } catch (e) {
        lastErr = e;
      }
    }
    if (!res) throw lastErr || new Error('Caddy admin 不可达');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    caddy.ok = true;
    caddy.error = null;
    caddy.lastPush = Date.now();
    caddy.routeCount = cfg.apps.http.servers.main.routes.length - 1;
    log(`已下发 ${caddy.routeCount} 条代理规则到 Caddy（监听 ${state.settings.caddyListen}）`, 'caddy');
  } catch (e) {
    caddy.ok = false;
    caddy.error = e.message;
    log(`Caddy 配置下发失败: ${e.message}`, 'caddy');
  }
  return caddy;
}

// 单飞 + 脏标记：Caddy 的 /load 是「后到覆盖先到」，并发下发会让旧配置冲掉新状态
// （典型：建分享推 A、设维护推 B，两条同时在飞，A 后到就把维护路由冲掉 → 本该 503 的请求变 401）。
// 这里保证任何时刻最多一条 /load 在飞；飞行途中的改动打脏标记，结束后只补推一次，
// 补推时重新 buildCaddyConfig() 拿最新 state。
let running = null;
let dirty = false;

async function pushLoop() {
  let r;
  do {
    dirty = false;
    r = await pushOnce();
  } while (dirty);
  return r;
}

function pushCaddy() {
  if (running) {
    dirty = true;
    return running.then(() => (dirty ? pushCaddy() : caddy));
  }
  running = pushLoop().finally(() => { running = null; });
  return running;
}

// ---------------------------------------------------------------- cloudflared（多隧道出口）
// 每个出口 = 一条独立的 cloudflared 进程，互不影响。典型用法：
//   ① 快速隧道试跑 + 命名隧道长期并存
//   ② 多个命名隧道（不同 Cloudflare 账号 / 不同域名 / 不同机房）
// 它们在 Caddy 这一层汇合：默认都指向 http://127.0.0.1:8080，再由面板规则分流。

const _state = require('./state');
const state = _state.stateProxy;

module.exports = { pushCaddy, pushTimer, schedulePush };
