/* 概览页 */
'use strict';

let logEl;
let logCount = 0;

function paintExits(d) {
  const box = $('#exitMini');
  const list = (d.state.tunnels || []);
  if (!list.length) { box.innerHTML = '<div class="empty">还没有隧道出口</div>'; return; }
  box.innerHTML = list.map((t) => {
    const rt = rtOf(t.id, d);
    const url = rt.publicUrl || rt.url || '';
    return `<div class="exit">
      <div class="grow">
        <div class="nm">${esc(t.name)} <span class="tag">${t.mode === 'named' ? '命名' : '快速'}</span>${statusPill(rt.status)}</div>
        ${url ? `<div class="url mono">${esc(url)}</div>` : '<div class="meta">还没有公网地址</div>'}
      </div>
    </div>`;
  }).join('');
}

function paintRules(d) {
  const box = $('#ruleMini');
  const list = d.state.routes || [];
  if (!list.length) { box.innerHTML = '<div class="empty">还没有规则，所有请求都会 404</div>'; return; }
  // 只有真的存在「仅限单出口」的规则时才显示作用域列；全是全局就是一列「全局」噪音
  const anyScoped = list.some((r) => !!r.tunnelId);
  const rows = list.slice(0, 6).map((r) => `<tr>
      <td class="mono">${esc(r.path || '/')}</td>
      <td class="mono">${r.host ? `<span class="badge-host" title="只对 ${esc(r.host)} 生效">${esc(r.host)}</span>` : '<span class="muted">任意主机</span>'}</td>
      <td class="mono muted">${esc(r.upstream || '')}</td>
      ${anyScoped ? `<td class="nowrap">${r.tunnelId ? '<span class="tag acc" title="只在绑定的那个出口上生效">仅限单出口</span>' : '<span class="muted">全局</span>'}</td>` : ''}
    </tr>`).join('');
  const c = d.runtime.caddy || {};
  const shadowed = c.shadowed || [];
  const dead = (d.runtime.upstreams || []).filter((u) => !u.ok);
  let hint = '';
  if (shadowed.length) {
    hint += `<div class="hint err">${shadowed.length} 条规则被前面的规则挡住、不会生效：` +
      shadowed.map((s) => `<span class="mono">${esc(s.path)}</span>`).join('、') + '</div>';
  }
  if (dead.length) {
    hint += `<div class="hint warn">${dead.length} 个上游端口不通：` +
      dead.map((u) => `<span class="mono">${esc(u.url)}</span>（${esc(u.error || '')}）`).join('、') + '</div>';
  }
  box.innerHTML = hint + `<table><thead><tr><th>路径</th><th>主机</th><th>上游</th>${anyScoped ? '<th>作用域</th>' : ''}</tr></thead><tbody>${rows}</tbody></table>`;
}

async function paintStats(d) {
  const list = d.state.tunnels || [];
  const running = list.filter((t) => rtOf(t.id, d).status === 'running').length;
  $('#statExits').innerHTML = `${running}<small> / ${list.length}</small>`;
  $('#statExitsX').textContent = running ? '有出口在线' : '当前没有出口在线';

  const routes = d.state.routes || [];
  $('#statRules').textContent = (d.runtime.caddy && d.runtime.caddy.routeCount) || 0;
  const scoped = routes.filter((r) => r.tunnelId).length;
  $('#statRulesX').textContent = scoped
    ? `共 ${routes.length} 条规则，其中 ${scoped} 条仅限单出口`
    : `共 ${routes.length} 条规则，全部对所有出口生效`;

  const ok = caddyOk(d);
  const c = (d.runtime.caddy) || {};
  $('#statCaddy').innerHTML = ok ? '<span class="ok-hint">正常</span>' : '<span class="err-hint">异常</span>';
  $('#statCaddyX').textContent = ok ? `监听 ${c.listen || ''}` : (c.error || '下发失败');

  try {
    const a = await api('/api/access?limit=200');
    if (a.available) {
      const s = a.summary || {};
      $('#statReq').textContent = s.total || 0;
      const bs = s.byStatus || {};
      $('#statReqX').textContent = `2xx ${bs['2xx'] || 0} · 4xx ${bs['4xx'] || 0} · 5xx ${bs['5xx'] || 0}`;
    } else {
      $('#statReq').textContent = '0';
      $('#statReqX').textContent = '还没有访问日志';
    }
  } catch {
    $('#statReq').textContent = '–';
    $('#statReqX').textContent = '读取失败';
  }
}

// 极简 SVG 图：柱状（总量 + 错误叠加）与折线（在线出口数），不引第三方库
// ---------------------------------------------------------------- 图表工具
// Caddy/浏览器都不会给 SVG 里的 <text> 做等比缩放，之前用 preserveAspectRatio="none"
// 把整张图横向拉伸，刻度字被拉扁且贴着卡片底边。现在：绘图区留在 SVG 里，刻度用 HTML 绝对定位，
// 字号恒定、永远贴着条形中心。
const CH = 44;      // 绘图区高度（viewBox 单位）
const CPAD = 1.2;   // 左右留白，避免首尾柱子被卡片边缘切掉

function chartLabels(keys) {
  const n = Math.max(1, keys.length);
  const step = n > 8 ? 2 : 1;
  // 分钟级采样（相邻点间隔 < 10 分钟）只在整点标一次：否则同一个小时会被标两遍「3:00」
  const minuteLevel = n > 24 && keys.length > 1
    && (new Date(keys[1]).getTime() - new Date(keys[0]).getTime()) < 10 * 60e3;
  const seen = new Set();
  const put = (t, i) => {
    const label = `${new Date(t).getHours()}:00`;
    if (seen.has(label)) return '';
    seen.add(label);
    return `<span style="left:${(((i + 0.5) / n) * 100).toFixed(2)}%">${label}</span>`;
  };
  let items = '';
  keys.forEach((t, i) => {
    if (minuteLevel) { if (new Date(t).getMinutes() === 0) items += put(t, i); return; }
    if (i % step === 0) items += put(t, i);
  });
  if (!seen.size) {
    // 窗口不足一小时（没有整点）时退回均匀取样
    keys.forEach((t, i) => { if (i % step === 0) items += put(t, i); });
  }
  return `<div class="chart-x">${items}</div>`;
}

function gridLines() {
  return `<line x1="0" y1="0.6" x2="100" y2="0.6" stroke="var(--line)" stroke-width="0.4" stroke-dasharray="2 2"></line>`
    + `<line x1="0" y1="${CH / 2}" x2="100" y2="${CH / 2}" stroke="var(--line)" stroke-width="0.4" stroke-dasharray="2 2"></line>`
    + `<line x1="0" y1="${CH}" x2="100" y2="${CH}" stroke="var(--line)" stroke-width="0.5"></line>`;
}

// 一组（或多组堆叠）柱子的公共画法，返回 { svg, labels }
function barsSvg(keys, series, max, label) {
  const n = Math.max(1, keys.length);
  const innerW = 100 - CPAD * 2;
  const bw = innerW / n;
  let body = gridLines();
  keys.forEach((k, i) => {
    // 每根柱子包在 <g><title> 里：鼠标悬停就能看到「几点 · 多少次（其中错误多少）」
    const hh = String(new Date(k).getHours()).padStart(2, '0');
    const parts = series.map((s) => ({ name: s.name || '', v: Number(s.values[i]) || 0 }));
    const tot = parts.reduce((a, p) => a + p.v, 0);
    const tip = `${hh}:00 · 共 ${tot}${series.some((x) => x.unit) ? series.find((x) => x.unit).unit : ''}`
      + parts.filter((p) => p.name).map((p) => ` · ${p.name} ${p.v}`).join('');
    body += `<g><title>${tip}</title>`
      + `<rect x="${(CPAD + i * bw).toFixed(2)}" y="0" width="${bw.toFixed(2)}" height="${CH}" fill="transparent"></rect>`;
    let y = CH;
    series.forEach((s) => {
      const v = Number(s.values[i]) || 0;
      if (!v) return;
      const h = Math.max(0.7, (v / max) * CH);
      y = Math.max(0, y - h);
      body += `<rect x="${(CPAD + i * bw + bw * 0.16).toFixed(2)}" y="${y.toFixed(2)}" width="${(bw * 0.68).toFixed(2)}" height="${h.toFixed(2)}" rx="0.6" fill="${s.color}" opacity="${s.opacity || 0.9}"></rect>`;
    });
    body += '</g>';
  });
  // 读屏软件只看得到 name/desc：把概要数字塞进去，别只说「统计图表」
  const name = label || '统计图表';
  const svg = `<svg class="chart" viewBox="0 0 100 ${CH}" preserveAspectRatio="none" role="img" aria-label="${name}">`
    + `<title>${name}</title><desc>${name}；每根柱子的具体数值可用鼠标悬停查看</desc>${body}</svg>`;
  return { svg, labels: chartLabels(keys) };
}

function drawTrend(buckets) {
  const box = $('#trendBox');
  const n = buckets.length;
  if (!n) { box.innerHTML = '<div class="empty">还没有流量数据（有访问后这里会自动出现）</div>'; return; }
  const max = Math.max(1, ...buckets.map((b) => b.total)) * 1.08;
  const keys = buckets.map((b) => b.t);
  const total = buckets.reduce((a, b) => a + b.total, 0);
  const err = buckets.reduce((a, b) => a + b.err, 0);
  const peak = Math.max(0, ...buckets.map((b) => b.total));
  const c = barsSvg(keys, [
    { values: buckets.map((b) => b.total), color: 'var(--acc)', opacity: 0.85, name: '合计', unit: ' 次' },
    { values: buckets.map((b) => b.err), color: 'var(--err)', opacity: 0.95, name: '其中错误' },
  ], max, `最近 ${n} 小时访问量柱状图：合计 ${total} 次，其中错误 ${err} 次，峰值 ${peak} 次/小时`);
  box.innerHTML = `${c.svg}${c.labels}
    <div class="chart-sum">
      <span class="tag">合计 <b>${total}</b> 次</span>
      <span class="tag ${err ? 'err' : ''}">错误 <b>${err}</b> 次${total ? `（${Math.round((err / total) * 100)}%）` : ''}</span>
      <span class="tag">峰值 <b>${Math.max(0, ...buckets.map((b) => b.total))}</b>/小时</span>
    </div>`;
}

function drawHist(points) {
  const box = $('#histBox');
  if (!points.length) { box.innerHTML = '<div class="empty">还在采样中（每分钟一个点），几分钟后这里就有曲线了</div>'; return; }
  const total = Math.max(1, ...points.map((p) => Number(p.total) || 0));
  const scale = total * 1.12;                       // 上留一点余量，避免"全在线"时曲线贴住顶边
  // 只有一个采样点时曲线画不出来（polyline 需要 2 个点），改成画一条水平虚线 + 说明
  if (points.length < 2) {
    const p0 = points[0];
    box.innerHTML = `<div class="row" style="gap:8px;margin-bottom:8px;flex-wrap:wrap">
        <span class="tag ok">当前 ${p0.running} / ${p0.total} 在线</span>
        <span class="tag warn">刚开始采样（1 个点），再等 1~2 分钟就出曲线</span>
      </div>
      <div class="empty" style="padding:6px 0">每分钟采一个点，曲线需要至少两个点才能画出来</div>`;
    return;
  }
  const step = points.length > 1 ? 100 / (points.length - 1) : 100;
  const y = (v) => CH - (Math.max(0, Math.min(v, scale)) / scale) * CH;
  const pts = points.map((p, i) => `${(i * step).toFixed(2)},${y(p.running).toFixed(2)}`).join(' ');
  const area = `0,${CH} ${pts} ${((points.length - 1) * step).toFixed(2)},${CH}`;
  const minUp = Math.min(...points.map((p) => Number(p.running) || 0));
  const last = points[points.length - 1];
  const keys = points.map((p) => p.t);
  const histLabel = `出口在线数历史折线图：当前 ${last.running} / ${last.total} 在线，区间最低 ${minUp}，共 ${points.length} 个采样点`;
  box.innerHTML = `<svg class="chart" viewBox="0 0 100 ${CH}" preserveAspectRatio="none" role="img" aria-label="${histLabel}">
      <title>${histLabel}</title><desc>${histLabel}</desc>
      ${gridLines()}
      <polygon points="${area}" fill="var(--acc)" opacity="0.16"></polygon>
      <polyline points="${pts}" fill="none" stroke="var(--acc)" stroke-width="1.4" vector-effect="non-scaling-stroke" stroke-linejoin="round"></polyline>
      ${points.map((p, i) => `<circle cx="${(i * step).toFixed(2)}" cy="${y(p.running).toFixed(2)}" r="1.1" fill="var(--acc)"><title>${new Date(p.t).getHours()}:00 · ${p.running}/${p.total} 在线</title></circle>`).join('')}
    </svg>${chartLabels(keys)}
    <div class="chart-sum">
      <span class="tag ok">当前 <b>${last.running}</b> / ${last.total} 在线</span>
      <span class="tag">区间最低 <b>${minUp}</b></span>
      <span class="tag">${points.length} 个采样点</span>
    </div>`;
}

function drawAudit(buckets) {
  const box = $('#auditBox');
  if (!box) return;
  const n = buckets.length;
  if (!n) { box.innerHTML = '<div class="empty">还没有变更记录</div>'; return; }
  const max = Math.max(1, ...buckets.map((b) => b.total)) * 1.08;
  const keys = buckets.map((b) => b.t);
  const total = buckets.reduce((a, b) => a + b.total, 0);
  const err = buckets.reduce((a, b) => a + b.err, 0);
  const c = barsSvg(keys, [
    { values: buckets.map((b) => b.total), color: 'var(--acc)', opacity: 0.85, name: '合计', unit: ' 次改动' },
    { values: buckets.map((b) => b.err), color: 'var(--err)', opacity: 0.95, name: '失败' },
  ], max, `最近 ${n} 小时变更趋势柱状图：合计 ${total} 次改动，失败 ${err} 次`);
  box.innerHTML = `${c.svg}${c.labels}
    <div class="chart-sum">
      <span class="tag">合计 <b>${total}</b> 次改动</span>
      <span class="tag ${err ? 'err' : ''}">失败 <b>${err}</b> 次</span>
      <span class="tag">${total === 0 ? '这段时间没人动过' : '峰值 ' + Math.max(0, ...buckets.map((b) => b.total)) + '/小时'}</span>
      <a class="sm" href="/observe">看明细 →</a>
    </div>`;
}

// 按规则堆叠柱状图：一眼看出哪个服务在吃流量
const PATH_COLORS = ['var(--acc)', 'var(--warn)', 'var(--err)', 'var(--dim)'];

function drawPaths(groups, hours, unmatched) {
  const box = $('#pathBox');
  if (!box) return;
  if (!groups || !groups.length) {
    const extra = (unmatched && unmatched.total) ? `（另有 ${unmatched.total} 次没命中任何规则）` : '';
    box.innerHTML = `<div class="empty">这段时间还没有命中任何规则的访问${extra}</div>`;
    return;
  }
  const keys = groups[0].buckets.map((b) => b.t);
  let stackMax = 1;
  keys.forEach((_, i) => {
    const sum = groups.reduce((a, g) => a + ((g.buckets[i] || {}).total || 0), 0);
    if (sum > stackMax) stackMax = sum;
  });
  stackMax *= 1.08;
  const c = barsSvg(keys, groups.map((g, gi) => ({
    values: keys.map((_, i) => (g.buckets[i] || {}).total || 0),
    color: PATH_COLORS[gi % PATH_COLORS.length],
    opacity: 0.9,
    name: g.name,
    unit: ' 次请求',
  })), stackMax, `最近 ${hours} 小时各规则流量堆叠图：${groups.map((g) => `${g.name} ${g.total} 次`).join('，')}`);
  const legend = groups.map((g, gi) => {
    const color = PATH_COLORS[gi % PATH_COLORS.length];
    const label = `${esc(g.name)} · ${g.total}${g.err ? ` · 5xx ${g.err}` : ''}`;
    const tip = `跳到规则页定位这条规则${g.path ? `（路径 ${esc(g.path)}）` : ''}`;
    return g.id
      ? `<a class="tag jump" href="/rules?focus=${encodeURIComponent(g.id)}" title="${tip}" style="border-left:3px solid ${color}">${label} →</a>`
      : `<span class="tag" style="border-left:3px solid ${color}">${label}</span>`;
  }).join('');
  box.innerHTML = `${c.svg}${c.labels}
    <div class="chart-legend">${legend}</div>
    <div class="chart-note">最近 ${hours} 小时；另有 <b>${(unmatched && unmatched.total) || 0}</b> 次没命中任何规则（健康检查、未知路径）${(unmatched && unmatched.err) ? `，其中 5xx <b>${unmatched.err}</b> 次` : ''}</div>`;
}

// 部署提醒（页面顶部横幅）：三种状态 —— 没预热过 / 预热的是旧版本 / 正常（隐藏）。
// 注意：预热接口存的是 8 位短指纹（ident.buildInfo().code.slice(0,8)），
// 这里必须同样截 8 位比较，否则「旧 vs 新」永远不相等，横幅永远关不掉。
const WARM_DKEY = 'cfp-warm-dismissed';
const shortCode = (x) => String(x || '').slice(0, 8);

async function paintWarmHint(d) {
  const bar = $('#warmBar');
  if (!bar) return;
  let code = '';
  try { code = String(((await api('/healthz')) || {}).code || ''); } catch { return; }
  const w = (d && d.state && d.state.warm) || null;
  const cur = shortCode(code);
  bar.dataset.code = cur;

  const show = (html) => {
    bar.className = 'hint warn banner';
    bar.innerHTML = `<span class="bico" aria-hidden="true">!</span><div class="msg">${html}</div>`
      + '<button class="bx" type="button" data-close aria-label="关闭这条提示" title="关闭">×</button>';
  };
  const hide = () => { bar.className = 'hint warn hidden'; bar.innerHTML = ''; };

  if (!w) {
    show('边缘缓存还没预热过，第一个访客要等资源从源站拉一遍。点'
      + ' <a href="/tools">工具箱 → 预热缓存</a> 先跑一次就好。');
    return;
  }
  if (shortCode(w.code) && cur && shortCode(w.code) !== cur) {
    let dismissed = '';
    try { dismissed = localStorage.getItem(WARM_DKEY) || ''; } catch { dismissed = ''; }
    if (dismissed === cur) { hide(); return; }
    show(`面板换过版本（<code>${esc(shortCode(w.code))}</code> → <code>${esc(cur)}</code>）：`
      + '边缘缓存里还是上一版的资源，首个访客会慢一点。点'
      + '<a href="/tools">重新预热</a>把新资源准备好（十几秒）。');
    return;
  }
  hide();
}

async function paintCharts() {
  const hours = Number($('#trendHours').value || 12);
  try {
    const d = await api('/api/traffic?hours=' + hours);
    drawTrend(d.buckets || []);
  } catch (e) {
    $('#trendBox').innerHTML = `<div class="hint warn">${esc(e.message)}</div>`;
  }
  try {
    const h = await api('/api/history');
    drawHist(h.points || []);
  } catch (e) {
    $('#histBox').innerHTML = `<div class="hint warn">${esc(e.message)}</div>`;
  }
  try {
    const a = await api('/api/audit/trend?hours=' + Number(($('#auditHours') || {}).value || 12));
    drawAudit(a.buckets || []);
  } catch (e) {
    if ($('#auditBox')) $('#auditBox').innerHTML = `<div class="hint warn">${esc(e.message)}</div>`;
  }
  try {
    const ph = Number(($('#pathHours') || {}).value || 12);
    const pr = await api('/api/traffic/paths?hours=' + ph + '&top=4');
    drawPaths(pr.groups || [], pr.hours || ph, pr.unmatched || null);
  } catch (e) {
    if ($('#pathBox')) $('#pathBox').innerHTML = `<div class="hint warn">${esc(e.message)}</div>`;
  }
}

function logLevel(line) {
  const t = String(line || '');
  if (/\bERR\b|error|fail|panic|refused|timeout/iu.test(t)) return ['err', 'ERR'];
  if (/\bWRN\b|warn/iu.test(t)) return ['warn', 'WRN'];
  if (/\bINF\b|info/iu.test(t)) return ['inf', 'INF'];
  return ['dbg', '···'];
}
function appendLog(rec) {
  if (!logEl) return;
  const span = document.createElement('span');
  const [lv, lvText] = logLevel(rec.line);
  span.className = 'l-' + (rec.source || 'panel') + ' lv-' + lv;
  const ts = new Date(rec.t || rec.at).toLocaleTimeString('zh-CN', { hour12: false });
  span.innerHTML = `<i class="dot" title="${lvText}"></i><time>${ts}</time> ${esc(rec.line)}\n`;
  logEl.appendChild(span);
  logCount++;
  if (logEl.childNodes.length > 400) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}

/**
 * Grafana 嵌入：只读 settings.grafana，拼 /d-solo/ 单 panel 地址。
 * 为什么用 d-solo：整块 dashboard 嵌进首页会带自己的时间选择器和侧栏，太小太挤；
 * d-solo 只给一张图，尺寸可控（height 由设置里每条决定）。
 * 注意 Grafana 侧必须 allow_embedding = true，否则它自己会回 X-Frame-Options: deny。
 */
/**
 * 选这次实际要嵌的 Grafana 基地址：
 * - 面板自己是 http 打开的（局域网 http://192.168.x.x:8090）→ 优先 lanUrl，绕开 Cloudflare 隧道：
 *   几十个 bundle 各自过一趟隧道要 40 秒，走局域网不到 1 秒。
 * - 其余情况（公网 https 页面）→ 用正式地址；https 页面里嵌 http 会被浏览器按混合内容拦掉。
 */
function grafanaBase(g) {
  const lan = String(g.lanUrl || '').trim().replace(/\/+$/, '');
  const pub = String(g.url || '').trim().replace(/\/+$/, '');
  if (lan && location.protocol === 'http:') return { url: lan, via: 'lan' };
  return { url: pub, via: 'public' };
}

function grafanaUrl(g, panel) {
  const dash = String(g.dashboard || '').replace(/^\/+|\/+$/g, '');
  const parts = dash.split('/');
  const uid = parts[0] || '';
  const slug = parts[1] || uid;
  const theme = g.theme || (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  const qs = new URLSearchParams({ orgId: '1', panelId: String(panel.panelId), kiosk: '', theme });
  return `${grafanaBase(g).url}/d-solo/${encodeURIComponent(uid)}/${encodeURIComponent(slug)}?${qs.toString()}`;
}

// 「这次是直连还是过隧道、花了多久」由 loadGFrame 测出来存这里；
// 5 秒轮询会重绘卡头，不记住的话徽标每轮都会变回「局域网直连」（看不到耗时）。
let gVia = null;

function paintGrafana(d) {
  const card = $('#grafanaCard');
  const box = $('#grafanaBox');
  if (!card || !box) return;
  const g = (d && d.state && d.state.settings && d.state.settings.grafana) || {};
  if (!g.enabled || !g.url || !g.dashboard || !(g.panels || []).length) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');

  // https 页面里嵌 http 的 Grafana：浏览器按「混合内容」直接拦掉，frame-src 放行也没用。
  // 与其显示两块白板，不如说清原因。
  const base = grafanaBase(g);
  const mixed = location.protocol === 'https:' && /^http:\/\//i.test(String(base.url));
  const via = $('#grafanaVia');
  if (via) {
    if (gVia) {
      via.className = 'tag ' + gVia.cls;
      via.textContent = gVia.text;
      via.title = gVia.title;
      via.classList.remove('hidden');
    } else {
      via.className = 'tag' + (base.via === 'lan' ? ' ok' : '');
      via.textContent = base.via === 'lan' ? '局域网直连' : '';
      via.classList.toggle('hidden', base.via !== 'lan');
      via.title = base.via === 'lan' ? ('图直接从 ' + base.url + ' 取，没走 Cloudflare 隧道') : '';
    }
  }
  const warn = $('#grafanaWarn');
  if (warn) {
    warn.classList.toggle('hidden', !mixed);
    if (mixed) {
      warn.innerHTML = '当前页面是 https，而 Grafana 地址是 <code>' + esc(base.url) + '</code>，浏览器会按混合内容拦截这类 iframe。'
        + '想让公网也能看到图：给 Grafana 也配一个 https 域名；只看局域网的话用 <code>http://' + esc(location.hostname) + ':8090</code> 打开本面板即可。';
    }
  }
  const open = $('#btnGrafanaOpen');
  if (open) {
    const dash = String(g.dashboard).replace(/^\/+|\/+$/g, '').split('/');
    open.href = `${base.url}/d/${encodeURIComponent(dash[0])}/${encodeURIComponent(dash[1] || dash[0])}`;
  }
  // 已渲染过同样的配置就不重建（iframe 重建会闪、也会重新拉一次 Grafana）
  const key = JSON.stringify({ url: base.url, lan: g.lanUrl || '', dash: g.dashboard, theme: g.theme, panels: g.panels, mixed });
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  if (mixed) { box.innerHTML = ''; return; }
  box.innerHTML = (g.panels || []).map((p, i) => `
    <div class="gpanel">
      ${p.title ? `<div class="gtitle">${esc(p.title)}</div>` : ''}
      <div class="gframe" data-i="${i}" style="height:${Number(p.h) || 220}px">
        <div class="gskel"><span>正在连接 Grafana…</span></div>
      </div>
    </div>`).join('');
  // 懒加载：滚到可视区才开始拉 iframe；12 秒没 load 就当失败，给「重试」按钮，别留白板
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting) { loadGFrame(e.target, g, i => (g.panels || [])[i]); io.unobserve(e.target); } });
  }, { rootMargin: '120px' });
  box.querySelectorAll('.gframe').forEach((el) => io.observe(el));
}

// CSP 拦掉 iframe 时浏览器仍会触发 load 事件，于是看起来"加载完成了"、实际是一块灰板。
// 监听 securitypolicyviolation 记时间戳，load 紧跟着来就判定为"被拦"，把真实原因说清楚。
let cspBlockedAt = 0;
document.addEventListener('securitypolicyviolation', (e) => {
  const d = String((e && (e.effectiveDirective || e.violatedDirective)) || '');
  if (d.indexOf('frame-src') >= 0 || d.indexOf('child-src') >= 0) cspBlockedAt = Date.now();
});

function loadGFrame(el, g, getPanel) {
  const p = getPanel(Number(el.dataset.i)) || {};
  el.dataset.state = 'loading';
  el.innerHTML = '<div class="gskel"><span>正在连接 Grafana…</span></div>';
  const url = grafanaUrl(g, p) + '&_=' + Date.now();
  const f = document.createElement('iframe');
  f.src = url;
  f.title = p.title || ('Grafana panel ' + p.panelId);
  f.setAttribute('referrerpolicy', 'no-referrer');
  f.style.cssText = 'width:100%;height:100%;border:0;background:transparent;display:block';
  const done = (ok, reason) => {
    if (el.dataset.state === 'done') return;
    el.dataset.state = ok ? 'done' : 'error';
    if (!ok) {
      const why = reason || '等了 50 秒还没出来。可能是 Grafana 没启动、被浏览器拦了混合内容，或这条隧道太慢（经 Cloudflare 首次加载常要 40 秒以上）。';
      el.innerHTML = '<div class="gfail"><b>这块图没加载出来</b><span>' + esc(why) + '</span>'
        + '<button class="btn mini" type="button" data-retry="1">重试</button>'
        + `<a class="sm" href="${esc(url.replace(/&_=\d+$/, ''))}" target="_blank" rel="noopener">在新窗口打开 →</a></div>`;
      el.querySelector('[data-retry]').addEventListener('click', () => loadGFrame(el, g, getPanel));
      markVia(Date.now() - startedAt);
    }
  };
  const startedAt = Date.now();
  // 卡片右上角标「走哪条路 + 花了多久」：局域网直连通常 1 秒内，经隧道经常几十秒。
  const markVia = (ms, doing) => {
    const via = $('#grafanaVia');
    if (!via) return;
    const base = grafanaBase(g);
    const secs = Math.max(0.1, ms / 1000);
    const took = secs < 10 ? secs.toFixed(1) + 's' : Math.round(secs) + 's';
    const text = (base.via === 'lan' ? '局域网直连' : '经公网') + ' · ' + (doing || took);
    const title = base.via === 'lan'
      ? '图直接从 ' + base.url + ' 取，没走 Cloudflare 隧道'
      : '经 Cloudflare 隧道取图（首次通常 40 秒以上）；在 http 下打开本面板并配置「局域网直连」会快很多';
    gVia = { text, cls: base.via === 'lan' ? 'ok' : 'info', title };
    via.className = 'tag ' + gVia.cls;
    via.textContent = text;
    via.title = title;
    via.classList.remove('hidden');
  };
  // 骨架是绝对定位盖在 iframe 上的：只要 `load` 没触发，图就算已经画出来了也被它挡着。
  // Grafana 的 d-solo 页 `load` 要等所有 bundle 跑完（局域网实测 6–10 秒，走公网更久），
  // 所以 2.2 秒后先把骨架撤掉 —— 图正在画总比"正在连接"盖着好看。
  const reveal = () => {
    const sk = el.querySelector('.gskel'); if (sk && sk.parentNode) sk.parentNode.removeChild(sk);
    if (el.dataset.state === 'loading') markVia(Date.now() - startedAt, '画图中…');
  };
  const revealTimer = setTimeout(reveal, 2200);
  f.addEventListener('load', () => {
    clearTimeout(revealTimer);
    // 被 CSP 拦掉的 iframe 也会 load，但里面是一块灰板：靠违规事件的时间戳区分
    if (cspBlockedAt && cspBlockedAt >= startedAt - 50) {
      done(false, '面板的内容安全策略（CSP）没放行这个地址。到「设置 → 监控嵌入」把地址存一遍即可自动放行；如果刚改过地址，刷新页面再看。');
      return;
    }
    // iframe 的 load 只代表「Grafana 的文档加载完」，它还要再画几秒图；
    // 立刻撤骨架会露出一块灰底 Loading…，所以先把文案换成「正在画图」，1.2 秒后再撤。
    const skel = el.querySelector('.gskel');
    const sk = skel && skel.querySelector('span');
    if (sk) sk.textContent = 'Grafana 已连上，正在画图…';
    markVia(Date.now() - startedAt);
    if (skel) setTimeout(() => { if (skel.parentNode) skel.parentNode.removeChild(skel); }, 1200);
    done(true);
  });
  f.addEventListener('error', () => done(false));
  // 第一次经 Cloudflare 隧道加载 Grafana 会比较慢（几十个 bundle，每个都要过一次隧道），
  // 8 秒后先给个"还在加载"的安抚，25 秒才判定失败。
  // 实测：经 Cloudflare 隧道第一次打开 d-solo 面板要 40 秒左右（几十个 bundle 各自走一遍隧道），
  // 所以 8s / 30s 只换安抚文案，50s 才判定失败 —— 判定太早会把"慢"误报成"坏"，用户点重试也还是慢。
  const hint = (ms, text) => setTimeout(() => {
    const sk = el.querySelector('.gskel span');
    if (sk && el.dataset.state === 'loading') sk.textContent = text;
  }, ms);
  hint(8000, '正在连接 Grafana…（第一次会慢一些）');
  hint(30000, '还在等 Grafana，经隧道首次加载通常要 40 秒左右…');
  setTimeout(() => { if (el.dataset.state !== 'done') done(false); }, 50000);
  el.appendChild(f);
}

async function refresh() {
  try {
    const d = await loadState(true);
    paintHealth(d);
    paintExits(d);
    paintRules(d);
    await paintStats(d);
    await paintCharts();
    paintGrafana(d);
    await paintWarmHint(d);
    $('#updAt').textContent = '更新于 ' + fmtClock();
  } catch (e) {
    toast('读取状态失败：' + e.message, 'err');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  logEl = $('#logBox');
  const lt = $('#btnLogToggle');
  if (lt) lt.addEventListener('click', () => {
    const collapsed = logEl.classList.toggle('collapsed');
    lt.textContent = collapsed ? '展开' : '收起';
    lt.setAttribute('aria-expanded', String(!collapsed));
    if (!collapsed) logEl.scrollTop = logEl.scrollHeight;
  });
  $('#btnRefresh').addEventListener('click', refresh);
  const wb = $('#warmBar');
  if (wb) wb.addEventListener('click', (e) => {
    if (!e.target.closest('[data-close]')) return;
    try { localStorage.setItem(WARM_DKEY, wb.dataset.code || ''); } catch {}
    wb.className = 'hint warn hidden';
    wb.innerHTML = '';
  });
  $('#trendHours').addEventListener('change', paintCharts);
  const ah = $('#auditHours');
  if (ah) ah.addEventListener('change', paintCharts);
  const ph = $('#pathHours');
  if (ph) ph.addEventListener('change', paintCharts);
  refresh();
  cfpEvery(5000, refresh);
  openLogStream(appendLog);
});
