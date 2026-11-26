/* cf-tunnel-panel · 公共前端工具（所有页面共用） */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- HTTP ---------------- */
async function api(path, { method = 'GET', body, raw = false } = {}) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const r = await fetch(path, opt);
  if (raw) return r;
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { ok: r.ok, raw: text }; }
  if (!r.ok || (data && data.ok === false)) {
    const msg = (data && data.error) || `HTTP ${r.status}`;
    if (r.status === 403 && /只读/.test(msg)) showReadonly(msg);
    // 横向扩展：Caddy 会把请求轮流分给两台实例，轮到备份实例时写操作会被 409 拦住。
    // 备份实例随时会接管，所以提示后刷新一次即可（这次的改动需要重做一次）。
    if (r.status === 409 && data && data.code === 'STANDBY') {
      toast('这次请求落在备份实例上（只读），已自动刷新，请重新操作一次', 'warn', 6000);
      setTimeout(() => location.reload(), 900);
    }
    const err = new Error(msg);
    err.status = r.status;
    err.payload = data;
    throw err;
  }
  return data;
}

const RO_KEY = 'cfp-readonly-notice';
function showReadonly(msg) {
  try { if (sessionStorage.getItem(RO_KEY)) return; sessionStorage.setItem(RO_KEY, '1'); } catch {}
  const bar = document.createElement('div');
  bar.className = 'hint warn robar';
  bar.setAttribute('role', 'status');
  bar.innerHTML = `<b>当前是只读账号</b>：能看所有页面，但改不了任何配置（${esc(msg)}）。要用管理员账号重新登录：<a href="/">点这里</a>`;
  document.body.prepend(bar);
  toast('只读账号不能修改配置', 'warn');
}

/* ---------------- Toast ---------------- */
function toast(msg, kind = '', action = null) {
  let box = $('#toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = 't ' + kind;
  el.textContent = t(msg);
  // 第三参给 {label, fn} 时就多一个按钮：误操作能当场撤回，不用再翻菜单
  if (action && action.label && typeof action.fn === 'function') {
    const b = document.createElement('button');
    b.className = 'sm ghost';
    b.style.marginLeft = '10px';
    b.textContent = action.label;
    b.addEventListener('click', () => {
      try { action.fn(); } finally { el.remove(); }
    });
    el.appendChild(b);
  }
  box.appendChild(el);
  const life = action ? 6000 : 2600;
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .2s'; }, life);
  setTimeout(() => el.remove(), life + 300);
}

/* ---------------- Ctrl+K 命令面板 ---------------- */
const CMDS = [
  { t: '概览', s: '总览 状态 图表', h: '/' },
  { t: '隧道出口', s: 'tunnels 出口 cloudflared', h: '/tunnels' },
  { t: '代理规则', s: 'rules 规则 分流', h: '/rules' },
  { t: '工具箱', s: 'tools docker 分享 curl cloudflare', h: '/tools' },
  { t: '观测', s: 'observe 访问 日志 统计', h: '/observe' },
  { t: '监控', s: 'monitor 指标 告警 prometheus grafana', h: '/monitor' },
  { t: '设置', s: 'settings 维护 通知 备份 只读', h: '/settings' },
  // 动作：不是跳页面，选中就直接做（省掉「先跳过去再点按钮」）
  { t: '一键体检', s: '体检 自检 selfcheck 检查 排障', h: '/monitor#check', act: 'check' },
  { t: '重新预热边缘缓存', s: '预热 warm 缓存 cloudflare 资源', h: '', act: 'warm' },
  { t: '重启全部出口', s: '重启 restart 出口 隧道 cloudflared', h: '', act: 'restartTunnels' },
  // 概览页原来的「快捷动作」按钮，统一收进这里
  { t: '新建出口', s: '新建 出口 tunnels cloudflared 隧道', h: '/tunnels' },
  { t: '新建规则', s: '新建 规则 rules 分流', h: '/rules' },
  { t: '一次性分享链接', s: '一次性 分享 share tools', h: '/tools' },
  { t: '访问统计', s: '访问 统计 observe 日志', h: '/observe' },
  { t: '维护模式 / 备份', s: '维护 maintenance 备份 backup settings', h: '/settings' },
  { t: 'Prometheus 指标', s: 'metrics prometheus 指标 抓取', h: '/metrics' },
];

/** 命令面板里的「动作项」：直接在面板里执行，不跳页面。返回一句提示。 */
async function runPaletteAction(act) {
  if (act === 'check') {
    // 体检结果要看得见，所以跳到监控页并自动展开/运行
    location.href = '/monitor#check';
    return '';
  }
  if (act === 'warm') {
    const r = await api('/api/cf/cache/warm', { method: 'POST', body: {} });
    return `已预热 ${(r && (r.total || (r.results || []).length)) || 0} 个资源（边缘缓存下一跳就是 HIT）`;
  }
  if (act.indexOf('restart:') === 0) {
    const id = act.slice(8);
    await api('/api/tunnels/' + encodeURIComponent(id) + '/restart', { method: 'POST', body: {} });
    return '已重启这个出口（域名不变）';
  }
  if (act === 'restartTunnels') {
    const d = await loadState(true);
    const ids = (d.state.tunnels || []).filter((t) => t.mode === 'token' && t.token).map((t) => t.id);
    if (!ids.length) return '没有可重启的命名隧道出口';
    for (const id of ids) await api('/api/tunnels/' + encodeURIComponent(id) + '/restart', { method: 'POST', body: {} });
    return `已重启 ${ids.length} 个出口`;
  }
  return '';
}

function paletteItems(extra) {
  const q = ($('#palQ') || {}).value;
  const kw = String(q || '').trim().toLowerCase();
  const all = CMDS.concat(extra || []);
  // 12 条装不下「页面 + 动作 + 出口 + 单出口重启」了，放宽到 24（列表本身可滚动）
  if (!kw) return all.slice(0, 24);
  return all.filter((x) => (x.t + ' ' + (x.s || '')).toLowerCase().includes(kw)).slice(0, 24);
}

function renderPalette(extra, active) {
  const items = paletteItems(extra);
  const box = $('#palList');
  box.innerHTML = items.map((it, i) => `<div class="pal-item${i === active ? ' on' : ''}" data-h="${esc(it.h)}" role="option" aria-selected="${i === active ? 'true' : 'false'}">
      <span class="ico">${it.act === 'check' ? '🩺' : it.act === 'warm' ? '♨️' : it.act === 'restartTunnels' ? '↻' : it.h === '/tunnels' ? '🛰' : it.h === '/rules' ? '⑃' : it.h === '/tools' ? '🧰' : it.h === '/observe' ? '📈' : it.h === '/settings' ? '⚙️' : it.h === '/monitor' ? '📊' : '▦'}</span>
      <span class="t">${esc(it.t)}</span><span class="s">${esc(it.s || '')}</span></div>`).join('')
    || '<div class="empty">没有匹配项</div>';
  return items;
}

async function openPalette() {
  if ($('#palWrap')) { $('#palWrap').remove(); return; }
  const wrap = document.createElement('div');
  wrap.id = 'palWrap';
  wrap.className = 'pal-wrap';
  wrap.innerHTML = `<div class="pal" role="dialog" aria-modal="true" aria-label="命令面板">
      <input id="palQ" placeholder="搜索页面、出口、规则…（↑↓ 选择，回车打开，Esc 关闭）" aria-label="命令面板搜索" />
      <div id="palList" role="listbox"></div></div>`;
  document.body.appendChild(wrap);
  $('#palQ').focus();
  let extra = [];
  let active = 0;
  try {
    const d = await loadState(true);
    extra = (d.state.tunnels || []).map((t) => ({ t: '出口：' + t.name, s: '隧道 ' + t.id, h: '/tunnels' }))
      // 只给命名隧道加「重启这一个」的动作项：quick 隧道每次重启都换域名，不适合随手点
      .concat((d.state.tunnels || []).filter((t) => t.mode === 'named').map((t) => ({
        t: '重启出口：' + t.name, s: '只重启这一个出口（域名不变）', h: '', act: 'restart:' + t.id,
      })))
      .concat((d.state.routes || []).map((r) => ({ t: '规则：' + (r.name || r.path), s: (r.path || '') + ' → ' + (r.upstream || ''), h: '/rules' })));
  } catch {}
  renderPalette(extra, active);
  const go = async (i) => {
    const items = paletteItems(extra);
    const it = items[i];
    if (!it) return;
    if (it.act) {
      wrap.remove();
      try {
        const msg = await runPaletteAction(it.act);
        if (msg) toast(msg, 'ok');
      } catch (e) { toast(e.message || '这个动作没成功'); }
      return;
    }
    location.href = it.h;
  };
  $('#palQ').addEventListener('input', () => { active = 0; renderPalette(extra, active); });
  $('#palQ').addEventListener('keydown', (e) => {
    const items = paletteItems(extra);
    if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); renderPalette(extra, active); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); renderPalette(extra, active); e.preventDefault(); }
    else if (e.key === 'Enter') { go(active); e.preventDefault(); }
    else if (e.key === 'Escape') { wrap.remove(); }
  });
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) { wrap.remove(); return; }
    const it = e.target.closest('.pal-item');
    if (!it) return;
    const idx = [...box.children].indexOf(it);   // 动作项也要走 go()，不能直接跳
    go(idx >= 0 ? idx : 0);
  });
}

/* ---------------- 主题 ---------------- */
const THEME_KEY = 'cfp-theme';
function applyTheme(v) {
  if (v === 'light' || v === 'dark') document.documentElement.dataset.theme = v;
  const b = $('#btnTheme');
  if (b) b.textContent = document.documentElement.dataset.theme === 'light' ? '☀️' : '🌙';
}
/** 退出登录：清掉服务端会话再回登录页。 */
async function doLogout() {
  try { await fetch('/api/logout', { method: 'POST', headers: { 'X-Requested-With': 'cfp' } }); } catch {}
  location.href = '/login';
}

/* ---------------- 界面语言（中 / 英） ----------------
 * 服务端把 <html lang> 与 window.__CFP_LANG / __CFP_DICT 注进来；
 * 这里按「中文原文 → 英文」精确匹配替换文本与常用属性。
 * 翻译不到的保留中文，避免机翻翻车。
 */
const LANG = window.__CFP_LANG === 'en' ? 'en' : 'zh';
const DICT = window.__CFP_DICT || {};
const LANG_COOKIE = 'cfp_lang';

// 带数字/时间的动态文案：先整串模式匹配，再退回「词组替换」
const NUMPAT = [
  [/^(\d{1,2}:\d{2}) · 共 (\d+) 次改动 · 合计 ([\d.]+) · 失败 (\d+)$/, '$1 · $2 changes · total $3 · failed $4'],
  [/^(\d{1,2}:\d{2}) · 共 (\d+) 次 · 合计 ([\d.]+) · 其中错误 (\d+)$/, '$1 · $2 requests · total $3 · errors $4'],
  [/^(\d{1,2}:\d{2}) · 共 (\d+) 次请求 · (.+)$/, '$1 · $2 requests · $3'],
  [/^(\d{1,2}:\d{2}) · 共 (\d+) 次$/, '$1 · $2 requests'],
  [/^(\d{1,2}:\d{2}) · (\d+)\/(\d+) 在线$/, '$1 · $2/$3 online'],
  [/^(\d{1,2}:\d{2}) · 面板(.*?) (\d+) · (.+?) (\d+)$/, '$1 · panel$2 $3 · $4 $5'],
  [/^(\d+)\/(\d+) 出口在线$/, '$1/$2 exits online'],
  [/^(\d+)\/(\d+) 在线$/, '$1/$2 online'],
  [/^共 (\d+) 条 · 第 (\d+) ?\/ ?(\d+) 页$/, '$1 rows · page $2/$3'],
  [/^共 (\d+) 次$/, '$1 requests'],
  [/^合计 (\d+) 次$/, 'sum $1'],
  [/^失败 (\d+) 次$/, '$1 failures'],
  [/^峰值 (\d+)\/小时$/, 'peak $1/h'],
  [/^(\d+) 个采样点$/, '$1 samples'],
  [/^(\d+) 份（上限 (\d+)）$/, '$1 backups (max $2)'],
  [/^(\d+) 分钟$/, '$1 min'],
  [/^(\d+) 秒$/, '$1 s'],
  [/^命中 (\d+) · 错 (\d+) · p95 (\d+)ms$/, '$1 hits · $2 errors · p95 $3ms'],
  [/^另有 (\d+) 个请求没有命中任何规则（其中 (\d+) 个 4xx、(\d+) 个 5xx）.*$/, '$1 requests matched no rule ($2 4xx, $3 5xx).'],
  [/^(.+?)（失败）$/, '$1 (failed)'],
  [/^配置里 (\d+) 条，?(\d+) 条专属$/, 'config: $1 rules, $2 scoped'],
  [/^监听 ([:\d.]+)$/, 'listening on $1'],
  [/^错误 (\d+) 次（(\d+)%）$/, '$1 errors ($2%)'],
  [/^TCP 通 · (\d+)ms$/, 'TCP OK · $1ms'],
  [/^TCP 不通 · (.+)$/, 'TCP failed · $1'],
  [/^最近 (\d+) 条$/, 'latest $1'],
  [/^(\d+) 个来源 IP$/, '$1 source IP'],
  [/^窗口内共 (\d+) 次被拒，最后一次 (.+)$/, '$1 rejected in window, last at $2'],
  [/^采样 (\d+) 条$/, 'sampled $1 rows'],
  [/^已运行 (\d+) 秒$/, 'uptime $1s'],
  [/^已运行 (.+)$/, 'uptime $1'],
  [/^更新于 ([:\d]+)$/, 'updated $1'],
  [/^最近 (\d+) 小时；另有 (\d+) 次没命中任何规则（(.+?)），其中 5xx (\d+) 次$/, 'last $1h; $2 more matched no rule ($3), $4 of them 5xx'],
  [/^(\d+) 条专属规则$/, '$1 scoped rules'],
  [/^出口：(.+?)（(\d+)）$/, 'exit: $1 ($2)'],
  [/^出口：(.+)$/, 'exit: $1'],
  [/^粘贴一条规则的 JSON，例如 (.+)$/, 'Paste a rule as JSON, e.g. $1'],
  [/^版本 (.+)$/, 'version $1'],
  [/^(.+?)（Caddy 侧 (\d+)MB × (\d+) 份自动轮转）$/, '$1 (Caddy side rotates ${2}MB × ${3})'],
  [/^(.+?) · (\d+) →$/, '$1 · $2 →'],
];

// 词组级兜底：只替换单位词，尽量不破坏语法
const WORDS = [
  ['次改动', ' changes'], ['次请求', ' requests'], ['其中错误', 'errors '], ['合计', 'sum '],
  ['个采样点', ' samples'], ['出口在线', ' exits online'], ['在线', ' online'],
  ['峰值', 'peak '], ['每秒', '/s'], ['小时', 'h'], ['分钟', 'min'], ['毫秒', 'ms'],
];

function tNum(s) {
  if (LANG !== 'en') return null;
  for (const [re, rep] of NUMPAT) {
    if (re.test(s)) return s.replace(re, rep);
  }
  if (/[\u4e00-\u9fff]/.test(s) && /\d/.test(s)) {
    let out = s;
    for (const [a, b] of WORDS) out = out.split(a).join(b);
    if (!/[\u4e00-\u9fff]/.test(out)) return out;
  }
  return null;
}

function t(zh) {
  if (LANG !== 'en') return zh;
  const hit = DICT[zh];
  if (hit) return hit;
  const num = tNum(String(zh || '').trim());
  return num || zh;
}

// 词典以「原文」为键，但页面里的文本节点常带换行/多空格（HTML 缩进），
// 直接查会漏。加一份「空白归一化」的索引做兜底。
let DICT_NORM = null;
function normKey(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function dictLookup(raw) {
  const s = normKey(raw);
  if (!s) return null;
  if (DICT[s]) return DICT[s];
  if (!DICT_NORM) {
    DICT_NORM = Object.create(null);
    for (const k of Object.keys(DICT)) DICT_NORM[normKey(k)] = DICT[k];
  }
  if (DICT_NORM[s]) return DICT_NORM[s];
  // 「🔄 刷新」「＋ 添加规则」这类带前缀符号的，剥掉符号再查
  const stripped = s.replace(/^[^\p{L}\p{N}]+/u, '').trim();
  const hit = DICT[stripped] || (DICT_NORM && DICT_NORM[stripped]);
  if (stripped && hit) return (s.slice(0, s.length - stripped.length) + hit);
  const num = tNum(s);
  if (num) return num;
  if (stripped) {
    const n2 = tNum(stripped);
    if (n2) return s.slice(0, s.length - stripped.length) + n2;
  }
  return null;
}

// 原生弹窗也走词典（toast/confirm/alert/prompt 的文案都是中文原文做键）
const _confirm = window.confirm.bind(window);
const _alert = window.alert.bind(window);
const _prompt = window.prompt.bind(window);
window.confirm = (m) => _confirm(t(String(m == null ? '' : m)));
window.alert = (m) => _alert(t(String(m == null ? '' : m)));
window.prompt = (m, d) => _prompt(t(String(m == null ? '' : m)), d);
window.__cfpT = t;

const LANG_SKIP = /^(SCRIPT|STYLE|PRE|CODE|TEXTAREA)$/;
const translated = new WeakSet();

/** 把文本节点按字典换掉：整段精确匹配才翻，匹配不到就保持原文（不机翻）。 */
function translateText(root) {
  if (LANG !== 'en') return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const jobs = [];
  let n = walker.nextNode();
  while (n) {
    if (!translated.has(n)) {
      const p = n.parentElement;
      if (p && !LANG_SKIP.test(p.tagName)) {
        const raw = n.nodeValue || '';
        const key = raw.replace(/\s+/g, ' ').trim();
        const en = key.length > 0 ? dictLookup(raw) : null;
        if (en && en !== key) jobs.push([n, raw, en]);
        else translated.add(n);
      }
    }
    n = walker.nextNode();
  }
  jobs.forEach(([node, raw, en]) => {
    const lead = (raw.match(/^\s*/) || [''])[0];
    const tail = (raw.match(/\s*$/) || [''])[0];
    node.nodeValue = lead + en + tail;
    translated.add(node);
  });
}

/** 属性也翻：title / placeholder / aria-label / value（按钮文字走文本节点） */
function translateAttrs(root) {
  if (LANG !== 'en') return;
  root.querySelectorAll('[title],[placeholder],[aria-label]').forEach((el) => {
    ['title', 'placeholder', 'aria-label'].forEach((attr) => {
      const v = el.getAttribute(attr);
      if (!v) return;
      const hit = dictLookup(v);
      if (hit && hit.trim() !== v.trim()) el.setAttribute(attr, hit);
    });
  });
}

function translateTree(root) {
  if (LANG !== 'en') return;
  translateText(root && root.nodeType ? root : document);
  translateAttrs(root && root.querySelectorAll ? root : document);
}

function setLang(lang) {
  document.cookie = `${LANG_COOKIE}=${lang}; path=/; max-age=31536000; samesite=lax`;
  location.reload();
}

function initLang() {
  const b = $('#btnLang');
  if (b) b.addEventListener('click', () => setLang(LANG === 'en' ? 'zh' : 'en'));
  translateTree(document);
  // 各页会不停重画局部区域：优先用 MutationObserver，另加低频兜底扫描
  if (window.MutationObserver && document.body) {
    let queued = false;
    const mo = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      setTimeout(() => { queued = false; translateTree(document); }, 40);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }
  // 兜底整树扫描：MutationObserver 已经覆盖「新节点/文本改动」，
  // 这里只在页面启动后补 24 次（约 60 秒），之后停掉 —— 别让它 2.5 秒一次扫到天荒地老。
  let left = 24;
  const safety = setInterval(() => {
    translateTree(document);
    if (--left <= 0) clearInterval(safety);
  }, 2500);
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved) applyTheme(saved);
  else applyTheme(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  initLang();
  const lo = $('#btnLogout');
  if (lo) lo.addEventListener('click', doLogout);
  const pal = $('#btnPalette');
  if (pal) pal.addEventListener('click', () => openPalette());
  const qp = $('#btnQuickPal');
  if (qp) qp.addEventListener('click', () => openPalette());
  const b = $('#btnTheme');
  if (b) b.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    localStorage.setItem(THEME_KEY, next);
  });
  window.addEventListener('storage', (e) => { if (e.key === THEME_KEY) applyTheme(e.newValue); });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
  });
}

/* ---------------- 时间 / 数字 ---------------- */
const pad2 = (n) => String(n).padStart(2, '0');
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d)) return '';
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function fmtClock() {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function hm(ms) { return ms == null || ms === '' ? '' : ms + 'ms'; }

/* ---------------- 状态词 ---------------- */
const STATUS = {
  stopped: ['已停止', ''],
  starting: ['启动中', 'warn'],
  running: ['运行中', 'ok'],
  stopping: ['停止中', 'warn'],
  error: ['异常', 'err'],
};
function statusPill(st) {
  const [text, cls] = STATUS[st] || [st || '未知', ''];
  return `<span class="pill ${cls}"><span class="dot ${cls}"></span>${esc(text)}</span>`;
}

/* ---------------- 分页 ---------------- */
const PER_PAGE = 5;
const pageCount = (n) => Math.max(1, Math.ceil(n / PER_PAGE));
function pagerHtml(page, pages, total) {
  if (!total) return '';
  return `<div class="pager">
      <span class="muted">共 ${total} 条 · 第 ${page} / ${pages} 页</span>
      <button class="sm ghost" data-page="1" ${page <= 1 ? 'disabled' : ''}>« 首页</button>
      <button class="sm ghost" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>← 上一页</button>
      <button class="sm ghost" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>下一页 →</button>
      <button class="sm ghost" data-page="${pages}" ${page >= pages ? 'disabled' : ''}>末页 »</button>
    </div>`;
}
function bindPager(box, onPage) {
  $$('[data-page]', box).forEach((b) => b.addEventListener('click', () => {
    const p = parseInt(b.dataset.page, 10);
    if (p >= 1) onPage(p);
  }));
}

/* ---------------- 剪贴板 ---------------- */
async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
    toast('已复制到剪贴板', 'ok');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = t;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制到剪贴板', 'ok'); } catch { toast('复制失败，请手动选择', 'err'); }
    ta.remove();
  }
}

/* ---------------- 全局状态（每页各自拉，存在 window.ST） ---------------- */
window.ST = null;
let stateInflight = null;
async function loadState(force = false) {
  if (!force && window.ST) return window.ST;
  if (stateInflight) return stateInflight;
  stateInflight = api('/api/state').then((d) => {
    window.ST = d;
    stateInflight = null;
    applyRole(d);
    return d;
  }).catch((e) => {
    stateInflight = null;
    throw e;
  });
  return stateInflight;
}
/* ---------------- 角色感知 ----------------
   以前只读账号要「点一下才 403」，看起来像坏了。现在 /api/state 会下发 role，
   页面一进来就知道自己能不能改，写入口直接禁用并说明原因。 */
const WRITE_IDS = new Set([
  'btnSave', 'btnSaveSettings', 'btnAdd', 'btnCreate', 'btnAddRule', 'btnImport', 'btnDoImport',
  'btnAddTunnel', 'btnPanelAuth', 'btnViewer', 'btnOper', 'btnTotpSetup', 'btnTotpEnable',
  'btnTotpDisable', 'btnShareAdd', 'btnCfCreate', 'btnNewTunDo', 'btnHostAdd', 'btnCfgApply',
  'btnCfgSnap', 'btnSessRevokeAll', 'btnSessKickOthers', 'btnCfSave', 'btnOperator',
]);
const WRITE_ACT = new Set(['del', 'start', 'stop', 'restart', 'save', 'dup', 'restore']);
let CFP_ROLE = 'admin';
let roWarned = false;

function isWriteTarget(el) {
  if (!el || !el.closest) return false;
  const idEl = el.closest('[id]');
  if (idEl && WRITE_IDS.has(idEl.id)) return true;
  if (el.closest('[data-write="1"]')) return true;
  const actEl = el.closest('[data-act]');
  if (actEl && WRITE_ACT.has(actEl.dataset.act)) return true;
  const btn = el.closest('button');
  if (btn && btn.type === 'submit') return true;
  return false;
}

function applyRole(d) {
  const role = (d && d.role) || CFP_ROLE || 'admin';
  CFP_ROLE = role;
  document.body.dataset.role = role;
  const ro = role === 'viewer' || (d && d.canWrite === false);
  document.body.dataset.readonly = ro ? '1' : '';
  const tag = $('#roleTag');
  if (tag) {
    tag.textContent = role === 'viewer' ? '只读账号' : role === 'operator' ? '运维账号' : '';
    tag.classList.toggle('hidden', role === 'admin');
    tag.classList.toggle('warn', role === 'viewer');
  }
  // 主按钮视觉上弱化（真正拦截在点击守卫里，动态生成的按钮也能盖住）
  document.querySelectorAll('.btn.primary').forEach((b) => {
    b.disabled = ro;
    if (ro) b.title = '只读账号不能修改配置';
  });
}

function markRoleHint() {
  if (CFP_ROLE === 'admin') return;
  const bar = document.getElementById('roBanner');
  if (bar) return;
  const el = document.createElement('div');
  el.id = 'roBanner';
  el.className = 'hint warn robar';
  el.setAttribute('role', 'status');
  el.innerHTML = CFP_ROLE === 'viewer'
    ? '<b>只读账号</b>：可以看所有页面，改不了任何配置。需要改的话用管理员账号登录。'
    : '<b>运维账号</b>：能管隧道、规则、分享，不能改安全设置与账号。';
  document.body.prepend(el);
}

document.addEventListener('click', (e) => {
  if (CFP_ROLE === 'admin') return;
  if (!isWriteTarget(e.target)) return;
  markRoleHint();
  e.preventDefault();
  e.stopPropagation();
  if (!roWarned) { roWarned = true; toast('只读账号不能修改配置', 'warn'); }
}, true);

window.__cfpRole = () => CFP_ROLE;

function rtOf(id, d = window.ST) {
  const list = (d && d.runtime && d.runtime.tunnels) || [];
  return list.find((x) => x.id === id) || { status: 'stopped', url: '' };
}
function tunnelUrl(t, d = window.ST) {
  const rt = rtOf(t.id, d) || {};
  return rt.publicUrl || rt.url || '';
}
function caddyOk(d = window.ST) { return !!(d && d.runtime && d.runtime.caddy && d.runtime.caddy.ok); }

/* ---------------- 轮询工具 ---------------- */
/**
 * 页面不可见时彻底停表：定时器在后台照样跑，手机锁屏、切到别的标签页时
 * 每 5 秒拉一次 /api/state、重画三张图，纯属白耗流量和电。
 * 回到前台立刻补跑一次，用户不会看到过期数据。
 */
function cfpEvery(ms, fn) {
  let timer = null;
  const run = () => {
    if (document.hidden) return;
    try {
      const r = fn();
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch { /* 单次失败不该拖垮整条轮询链 */ }
  };
  const start = () => { if (timer === null) timer = setInterval(run, ms); };
  const stop = () => { if (timer !== null) { clearInterval(timer); timer = null; } };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else { start(); run(); }
  });
  start();
  return { stop, start, run };
}
window.cfpEvery = cfpEvery;

/* ---------------- 日志流 ---------------- */
/**
 * 日志流（SSE）。页面切到后台就断开、回到前台重连：
 * SSE 连接即使在后台也会被服务端持续推送，手机流量伤不起；反正回到前台会补拉一次最近的日志。
 */
function openLogStream(onLine) {
  let es = null;
  const open = () => {
    if (es) return;
    try {
      es = new EventSource('/api/logs/stream');
      es.onmessage = (ev) => {
        try { onLine(JSON.parse(ev.data)); } catch { /* 忽略坏帧 */ }
      };
      es.onerror = () => { /* 浏览器自己会重连；断网/休眠时靠可见性事件再拉一次 */ };
    } catch { es = null; }
  };
  const close = () => { if (es) { try { es.close(); } catch { /* 已经关了 */ } es = null; } };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) close();
    else { open(); }
  });
  open();
  return { close, reopen: open };
}

/* ---------------- 顶部健康指示 ---------------- */
function paintHealth(d) {
  const list = (d.state && d.state.tunnels) || [];
  const running = list.filter((t) => rtOf(t.id, d).status === 'running').length;
  const box = $('#healthDot');
  const txt = $('#healthText');
  const standby = d.mode === 'standby';
  // 自检摘要：定时每 5 分钟跑一次（见 server.js），侧栏顺手带一句，不用特意去监控页看
  const sc = (d.runtime || {}).selfcheck;
  const scOk = !sc || !sc.fail;
  if (box) box.className = 'dot ' + (sc && sc.fail ? 'err' : standby ? 'warn' : running ? 'ok' : 'err');
  if (txt) {
    let line = (standby ? '备份实例 · ' : '') + (running ? `${running}/${list.length} 出口在线` : '没有出口在线');
    if (sc && sc.at) line += ` · 体检 ${sc.total - sc.fail}/${sc.total}`;
    txt.textContent = line;
    const bits = [];
    if (standby) bits.push('当前是只读备份实例；写操作会被拒绝，主实例接管后自动恢复');
    if (sc && sc.at) {
      bits.push(`上次体检 ${Math.round((Date.now() - sc.at) / 60000)} 分钟前：${sc.total - sc.fail}/${sc.total} 项通过`);
      if (!scOk) bits.push('失败项：' + (sc.bad || []).map((x) => x.name).join('、'));
      bits.push('点进「监控」页可以重新体检');
    }
    txt.title = bits.join('\n');
  }
}


// ---------------- 未保存改动：离开前提醒 ----------------
// 各页面在 markDirty()/保存成功时调用 __cfpSetUnsaved('rules', true/false)。
// 页面内跳转用 confirm 拦，关标签/刷新用 beforeunload 拦。
const unsaved = { rules: false, tunnels: false, settings: false };
function anyUnsaved() { return unsaved.rules || unsaved.tunnels || unsaved.settings; }
function renderUnsaved() {
  const b = $('#unsaved');
  if (b) b.classList.toggle('hidden', !anyUnsaved());
  document.body.classList.toggle('has-unsaved', anyUnsaved());
}
function setUnsaved(kind, val) {
  if (!(kind in unsaved)) return;
  unsaved[kind] = !!val;
  renderUnsaved();
}
window.__cfpSetUnsaved = setUnsaved;
window.__cfpAnyUnsaved = anyUnsaved;

window.addEventListener('beforeunload', (e) => {
  if (!anyUnsaved()) return undefined;
  e.preventDefault();
  e.returnValue = '';
  return '';
});
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[href]');
  if (!a || !anyUnsaved()) return;
  if (a.target === '_blank' || e.metaKey || e.ctrlKey) return;
  if (!confirm('有还没保存的改动，离开这些改动会丢失。确定要走吗？')) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

document.addEventListener('DOMContentLoaded', () => {
  // PWA：装上后像 App 一样打开；只缓存静态资源，配置类请求永不缓存
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('/assets/sw.js').catch(() => {});
  }
  initTheme();
  const y = $('#year');
  if (y) y.textContent = new Date().getFullYear();
  // 侧栏健康指示：每页都刷一次，失败静默
  loadState().then((d) => { paintHealth(d); markRoleHint(); }).catch(() => {});
  cfpEvery(15000, () => loadState(true).then(paintHealth));
});
