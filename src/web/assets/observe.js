/* 观测页：访问统计（可筛选/分页）+ 面板日志（可暂停/只看错误） */
'use strict';
(function () {

let rows = [];
let summary = null;
let page = 1;
let only5xx = false;
let logEl = null;
let paused = false;
let auditRows = [];
let auditOnlyFail = false;
let auditPage = 1;
let auditTotal = 0;
const AUDIT_PER_PAGE = 10;

function rangeSec() { return Number(($('#accRange') || {}).value || 0) || 0; }

function filteredRows() {
  const st = ($('#accStatus').value || '').trim();
  const q = ($('#accPath').value || '').trim().toLowerCase();
  const ip = (($('#accIp') || {}).value || '').trim();
  const span = rangeSec();
  const since = span ? Date.now() - span * 1000 : 0;
  return rows.filter((r) => {
    if (since && r.ts) {
      const t = Date.parse(r.ts.replace(' ', 'T'));
      if (Number.isFinite(t) && t < since) return false;
    }
    if (ip && !String(r.ip || '').includes(ip)) return false;
    if (only5xx && !(r.status >= 500)) return false;
    if (st === 'err' && !(r.status >= 400)) return false;
    if (/^[2-5]$/.test(st) && Math.floor(Number(r.status) / 100) !== Number(st)) return false;
    if (q && !String(r.uri || '').toLowerCase().includes(q)) return false;
    return true;
  });
}

function syncAccessCsv(total) {
  const a = $('#btnAccessCsv');
  if (!a) return;
  const n = Math.max(1, Math.min(2000, Number(total) || 200));
  a.href = '/api/access.csv?limit=' + n;
}

function renderAccess() {
  const box = $('#accessBody');
  const s = summary || {};
  const st = (k) => (s.byStatus && s.byStatus[k]) || 0;
  const list = filteredRows();
  const pages = pageCount(list.length);
  if (page > pages) page = pages;
  if (page < 1) page = 1;
  const slice = list.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const filtering = !!(only5xx || $('#accStatus').value || ($('#accPath').value || '').trim() || rangeSec());
  syncAccessCsv(list.length);
  const body = slice.map((r) => `<tr>
      <td class="mono" data-label="时间">${esc((r.ts || '').slice(11, 19))}</td>
      <td class="mono sm-hide" data-label="方法">${esc(r.method)}</td>
      <td class="mono" data-label="路径" title="${esc((r.host || '') + (r.ua ? ' · ' + r.ua : ''))}">${r.rule
        ? `<a class="jump" href="/rules?focus=${encodeURIComponent(r.rule.id)}" title="命中规则：${esc(r.rule.name || r.rule.id)}（点这里跳到规则）">${esc((r.uri || '').slice(0, 80))}</a>`
        : esc((r.uri || '').slice(0, 80))}</td>
      <td class="mono ${r.status >= 500 ? 'err-hint' : r.status >= 400 ? '' : 'ok-hint'}" data-label="状态">${r.status}</td>
      <td class="mono" data-label="耗时">${r.durMs}ms</td>
      <td class="mono muted sm-hide" data-label="来源 IP">${r.ip ? `<a class="jump" href="#" data-ip="${esc(r.ip)}" title="只看这个 IP">${esc(r.ip)}</a>` : ''}</td>
    </tr>`).join('');
  box.innerHTML = `
    <div class="row" style="padding:10px 12px;gap:8px;border-bottom:1px solid var(--line);flex-wrap:wrap">
      <span class="tag">最近 ${s.total || 0} 条</span>
      <span class="tag ok">2xx ${st('2xx')}</span>
      <span class="tag">3xx ${st('3xx')}</span>
      <span class="tag warn">4xx ${st('4xx')}</span>
      <span class="tag err">5xx ${st('5xx')}</span>
      ${filtering ? `<span class="tag info">筛选后 ${list.length} 条</span>` : ''}
      ${(s.topPaths || []).slice(0, 3).map((x) => `<span class="tag">${esc(x.k)} × ${x.v}</span>`).join('')}
    </div>
    <div class="tbl-wrap">
      <table class="stackable"><thead><tr><th>时间</th><th>方法</th><th>路径</th><th>状态</th><th>耗时</th><th>来源 IP</th></tr></thead>
      <tbody>${body || `<tr><td colspan="6" class="muted">${only5xx
        ? '最近这段时间没有 5xx。<a href="#" data-only5xx="0">关掉「只看 5xx」</a>看看全部请求。'
        : (filtering ? '这组筛选条件下没有请求' : '这段时间还没有流量')}</td></tr>`}</tbody></table>
    </div>
    ${pagerHtml(page, pages, list.length)}`;
  bindPager(box, (p) => { page = p; renderAccess(); });
}

async function loadAccess() {
  try {
    const d = await api('/api/access?limit=200');
    if (!d.available) {
      $('#accessBody').innerHTML = `<div class="hint">${esc(d.note || '还没有访问日志（有流量后这里会自动出现）')}</div>`;
      return;
    }
    rows = d.rows || [];
    summary = d.summary || {};
    renderAccess();
    $('#accessMsg').textContent = '更新于 ' + fmtClock();
  } catch (e) {
    $('#accessBody').innerHTML = `<div class="hint err">读取失败：${esc(e.message)}</div>`;
  }
}

function logVisible(node) {
  const q = ($('#logFilter').value || '').trim().toLowerCase();
  const onlyErr = $('#logOnlyErr').checked;
  const text = node.textContent || '';
  if (q && !text.toLowerCase().includes(q)) return false;
  if (onlyErr && !/error|fail|失败|错误|异常|refused|timeout|超时|429|500|502|503/i.test(text)) return false;
  return true;
}

function appendLog(rec) {
  if (!logEl) return;
  if (paused) return;
  const span = document.createElement('span');
  span.className = 'l-' + (rec.source || 'panel');
  span.textContent = `${new Date(rec.t || rec.at).toLocaleTimeString('zh-CN', { hour12: false })} [${rec.source}] ${rec.line}\n`;
  if (!logVisible(span)) span.classList.add('hidden');
  logEl.appendChild(span);
  if (logEl.childNodes.length > 1500) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}

function applyFilter() {
  for (const node of logEl.childNodes) {
    if (node.nodeType !== 1) continue;
    node.classList.toggle('hidden', !logVisible(node));
  }
}

function auditPill(ok, status) {
  const cls = ok ? 'ok' : 'err';
  return `<span class="pill ${cls}">${status || (ok ? '成功' : '失败')}</span>`;
}

function renderAudit() {
  const box = $('#auditBody');
  if (!box) return;
  if (!auditRows.length) { box.innerHTML = '<div class="empty">还没有审计记录（改一次配置或失败一次请求就会出现）</div>'; return; }
  const pages = Math.max(1, Math.ceil(auditTotal / AUDIT_PER_PAGE));
  if (auditPage > pages) auditPage = pages;
  const slice = auditRows.slice((auditPage - 1) * AUDIT_PER_PAGE, auditPage * AUDIT_PER_PAGE);
  box.innerHTML = `<div class="tbl-wrap"><table class="stackable">
    <thead><tr><th>时间</th><th>谁</th><th>从哪</th><th>做了什么</th><th>请求</th><th>结果</th></tr></thead>
    <tbody>${slice.map((r) => `<tr>
      <td data-label="时间">${fmtTime(r.at)}</td>
      <td data-label="谁">${esc(r.actor || '-')}${r.actor && r.actor.includes('只读') ? ' <span class="tag">只读</span>' : ''}</td>
      <td data-label="从哪"><span class="mono">${esc(r.ip || '-')}</span></td>
      <td data-label="做了什么">${esc(r.action || r.path || '-')}</td>
      <td data-label="请求"><span class="mono">${esc(r.method)} ${esc(r.path)}</span></td>
      <td data-label="结果">${auditPill(r.ok, r.status)}</td>
    </tr>`).join('')}</tbody></table></div>
    ${pagerHtml(auditPage, pages, auditTotal)}`;
  bindPager(box, (pg) => { auditPage = pg; renderAudit(); });
}

function auditQuery() {
  const q = ($('#auditQ') || {}).value || '';
  const date = ($('#auditDate') || {}).value || '';
  const act = ($('#auditAct') || {}).value || '';
  const parts = ['limit=200'];
  if (q) parts.push('q=' + encodeURIComponent(q));
  if (date) parts.push('date=' + encodeURIComponent(date));
  if (act) parts.push('act=' + encodeURIComponent(act));
  if (auditOnlyFail) parts.push('bad=1');
  return parts.join('&');
}

/** 审计文件按天分文件了（v0.20.0）：把可选日期灌进下拉，导出 CSV 也跟着选中日期走 */
async function loadAuditDays() {
  const sel = $('#auditDate');
  if (!sel) return;
  try {
    const d = await api('/api/audit/days');
    const cur = sel.value;
    const keep = d.keepDays || 30;
    sel.innerHTML = `<option value="">最近两天</option>` +
      (d.days || []).map((x) => `<option value="${esc(x.date)}">${esc(x.date)}（${Math.max(1, Math.round(x.bytes / 1024))} KB）</option>`).join('');
    sel.value = cur;
    sel.title = `保留最近 ${keep} 天，每天一个文件`;
  } catch { /* 读不到就只留「最近两天」 */ }
}

function fillAuditActions(list) {
  const sel = $('#auditAct');
  if (!sel || !Array.isArray(list) || !list.length) return;
  const cur = sel.value;
  const opts = ['<option value="">全部动作</option>'].concat(list.map((x) =>
    `<option value="${esc(x.action)}">${esc(x.action)} ×${x.count}</option>`));
  if (sel.dataset.n === String(list.length) && !cur) { /* 已经灌过且没选中，跳过重绘 */ }
  sel.innerHTML = opts.join('');
  if (cur) sel.value = cur;
}

async function loadAudit() {
  const d = await api(`/api/audit?${auditQuery()}`);
  fillAuditActions(d.actions);
  auditRows = d.rows || [];
  auditTotal = Number(d.count || 0) || (d.stats && d.stats.count) || auditRows.length;
  renderAudit();
}

document.addEventListener('DOMContentLoaded', () => {
  logEl = $('#logBox');
  $('#btnAccessRefresh').addEventListener('click', loadAccess);
  $('#accessAuto').addEventListener('change', (e) => {
    if (e.target.checked) loadAccess();
  });
  const ipBox = $('#accIp');
  if (ipBox) ipBox.addEventListener('input', () => { page = 1; renderAccess(); });
  const fromUrl = new URLSearchParams(location.search).get('ip');
  if (fromUrl && ipBox && !ipBox.value) ipBox.value = fromUrl;
  for (const id of ['#accStatus', '#accRange']) {
    $(id).addEventListener('change', () => { page = 1; renderAccess(); });
  }
  $('#accPath').addEventListener('input', () => { page = 1; renderAccess(); });
  const actSel = $('#auditAct');
  if (actSel) actSel.addEventListener('change', () => { auditPage = 1; loadAudit(); });
  const afBtn = $('#btnAuditFail');
  if (afBtn) afBtn.addEventListener('click', () => {
    auditOnlyFail = !auditOnlyFail;
    afBtn.setAttribute('aria-pressed', auditOnlyFail ? 'true' : 'false');
    afBtn.classList.toggle('on', auditOnlyFail);
    afBtn.textContent = auditOnlyFail ? '只看失败 · 开' : '只看失败';
    auditPage = 1;
    loadAudit();
  });
  const only5 = $('#btnOnly5xx');
  const paintOnly5 = () => {
    if (!only5) return;
    only5.setAttribute('aria-pressed', only5xx ? 'true' : 'false');
    only5.classList.toggle('on', only5xx);
    only5.textContent = only5xx ? '只看 5xx · 开' : '只看 5xx';
  };
  // 刷新页面后保留「只看 5xx」——排查错误时最常按的那一下不该每次重来
  try { only5xx = localStorage.getItem('cfp-only5xx') === '1'; } catch (e) { only5xx = false; }
  paintOnly5();
  if (only5) only5.addEventListener('click', () => {
    only5xx = !only5xx;
    try { localStorage.setItem('cfp-only5xx', only5xx ? '1' : '0'); } catch (e) {}
    paintOnly5();
    page = 1;
    renderAccess();
  });
  const bodyEl = document.querySelector('#accessBody');
  if (bodyEl) bodyEl.addEventListener('click', (e) => {
    const off5 = e.target.closest && e.target.closest('a[data-only5xx]');
    if (off5) {
      e.preventDefault();
      only5xx = false;
      try { localStorage.setItem('cfp-only5xx', '0'); } catch (err) {}
      const bb = $('#btnOnly5xx');
      if (bb) { bb.setAttribute('aria-pressed', 'false'); bb.classList.remove('on'); bb.textContent = '只看 5xx'; }
      page = 1;
      renderAccess();
      return;
    }
    const a = e.target.closest && e.target.closest('a[data-ip]');
    if (!a) return;
    e.preventDefault();
    const box = $('#accIp');
    if (box) { box.value = a.getAttribute('data-ip'); page = 1; renderAccess(); }
  });
  $('#logFilter').addEventListener('input', applyFilter);
  $('#logOnlyErr').addEventListener('change', applyFilter);
  $('#btnLogPause').addEventListener('click', (e) => {
    paused = !paused;
    e.target.textContent = paused ? '继续' : '暂停';
    e.target.setAttribute('aria-pressed', paused ? 'true' : 'false');
    e.target.classList.toggle('primary', paused);
    if (!paused) { logEl.scrollTop = logEl.scrollHeight; }
  });
  $('#btnLogDownload').addEventListener('click', () => { location.href = '/api/logs/download'; });

  loadAccess();

// ---------------- 规则命中统计 ----------------
async function loadRouteStats() {
  const box = $('#rstatBody');
  const msg = $('#rstatMsg');
  if (!box) return;
  try {
    const d = await api('/api/routes/stats?limit=2000');
    msg.textContent = d.available ? `采样 ${d.sampled} 条` : '还没有访问日志';
    if (!d.routes.length) { box.innerHTML = '<div class="empty">这个窗口里没有规则被命中</div>'; return; }
    const rows = d.routes.map((r) => {
      const errTag = r.err5 ? `<span class="tag err">${r.err5} 个 5xx</span>`
        : r.err4 ? `<span class="tag warn">${r.err4} 个 4xx</span>` : '<span class="tag ok">正常</span>';
      return `<tr>
        <td><strong>${esc(r.name)}</strong><div class="muted mono" style="font-size:11px">${esc(r.path || '/')}${r.host ? ' · ' + esc(r.host) : ''}</div></td>
        <td>${r.count}</td>
        <td>${errTag}<div class="muted" style="font-size:11px">${r.errRate}% 错误</div></td>
        <td>${r.p50} / <strong>${r.p95}</strong>${r.max ? ` / ${r.max}` : ''}</td>
        <td>${(r.bytes / 1024).toFixed(0)} KB</td>
      </tr>`;
    }).join('');
    box.innerHTML = `<div class="tbl-wrap"><table class="stackable"><thead><tr><th>规则</th><th>命中</th><th>结果</th><th>P50 / P95 / 最慢 (ms)</th><th>流量</th></tr></thead><tbody>${rows}</tbody></table></div>`
      + (d.unmatched.count ? `<div class="hint warn">另有 ${d.unmatched.count} 个请求没有命中任何规则（其中 ${d.unmatched.s4} 个 4xx、${d.unmatched.s5} 个 5xx），通常是被兜底 404 接住了。</div>` : '');
  } catch (e) {
    box.innerHTML = `<div class="hint warn">${esc(e.message)}</div>`;
  }
}


async function loadSecurity() {
  const box = $('#secBody');
  if (!box) return;
  const hours = Number($('#secHours').value || 24);
  try {
    const d = await api(`/api/security/attempts?hours=${hours}`);
    // 黑名单从状态里取：这样表格能直接显示「已封禁 / 封禁」
    let denyList = [];
    try {
      const st = await loadState(true);
      const raw = ((st.state.settings || {}).security || {}).ipDeny || '';
      denyList = String(raw).split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
    } catch { /* 状态拿不到就只显示封禁按钮 */ }
    const isDenied = (ip) => denyList.some((c) => c === ip || c === ip + '/32' || c === ip + '/128');
    $('#secMsg').textContent = d.available
      ? `窗口内共 ${d.total} 次被拒${d.last ? '，最后一次 ' + d.last.slice(11, 19) : ''}`
      : (d.note || '');
    if (!d.available || !d.total) {
      box.innerHTML = `<div class="empty">这个窗口内没有被拒的请求（世界很安静）</div>`;
      return;
    }
    const ruleRows = (d.byRule || []).map((r) => `<tr>
      <td class="mono" data-label="规则">${r.id
        ? `<a class="jump" href="/rules?focus=${encodeURIComponent(r.id)}">${esc(r.name)}</a>`
        : esc(r.name)}</td>
      <td class="mono" data-label="路径">${esc(r.path || '—')}</td>
      <td class="mono err-hint" data-label="被拒次数">${r.count}</td>
      <td class="mono muted" data-label="主要来源">${esc((r.ips || []).map((x) => x.ip + ' ×' + x.count).join('，'))}</td>
    </tr>`).join('');
    const ipRows = (d.byIp || []).map((x) => {
      const off = isDenied(x.ip);
      return `<tr>
      <td class="mono" data-label="来源 IP">${esc(x.ip)} ${off ? '<span class="tag err">已封禁</span>' : ''}</td>
      <td class="mono err-hint" data-label="被拒次数">${x.count}</td>
      <td class="mono muted" data-label="打的规则">${esc((x.rules || []).join('、') || '未命中规则')}</td>
      <td class="mono muted" data-label="最后">${esc((x.last || '').slice(11, 19))}</td>
      <td class="nowrap" data-label="操作"><button class="sm ${off ? 'ghost' : 'danger'}" data-deny="${esc(x.ip)}" data-off="${off ? '1' : ''}">${off ? '解封' : '封禁'}</button></td>
    </tr>`;
    }).join('');
    box.innerHTML = `
      <div class="row" style="padding:10px 12px;gap:8px;border-bottom:1px solid var(--line);flex-wrap:wrap">
        <span class="tag err">共 ${d.total} 次</span>
        <span class="tag">${(d.byIp || []).length} 个来源 IP</span>
      </div>
      <div class="tbl-wrap"><table class="stackable">
        <thead><tr><th>规则</th><th>路径</th><th>被拒次数</th><th>主要来源</th></tr></thead>
        <tbody>${ruleRows || '<tr><td colspan="4" class="empty">没有命中规则的拒绝</td></tr>'}</tbody>
      </table></div>
      <div class="tbl-wrap"><table class="stackable">
        <thead><tr><th>来源 IP</th><th>被拒次数</th><th>打的规则</th><th>最后</th><th class="nowrap">操作</th></tr></thead>
        <tbody>${ipRows}</tbody>
      </table></div>`;
  } catch (e) {
    box.innerHTML = `<div class="hint warn">读取失败：${esc(e.message)}</div>`;
  }
}

// 一键封禁：把「可疑访问」里看到的 IP 直接写进 security.ipDeny，再顺带刷新
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-deny]');
  if (!b) return;
  e.preventDefault();
  const ip = b.dataset.deny;
  const off = b.dataset.off === '1';
  if (!off && !confirm(`把 ${ip} 加进 IP 黑名单？\n\n之后来自这个地址的请求会被 Caddy 直接回 403。`)) return;
  b.disabled = true;
  try {
    const d = await api('/api/security/' + (off ? 'allow' : 'deny'), { method: 'POST', body: { ip } });
    if (d.warning) toast(d.warning, 'warn', 9000);
    else toast(off ? `已解封 ${ip}` : `已封禁 ${ip}`, 'ok');
    await loadState(true);
    await loadSecurity();
  } catch (err) {
    toast(err.message, 'err');
    b.disabled = false;
  }
});

  loadAuditDays().then(() => loadAudit()).catch(() => {});
  const syncCsv = () => {
    const el = $('#btnAuditCsv');
    if (!el) return;
    const q = ($('#auditQ') || {}).value || '';
    const date = ($('#auditDate') || {}).value || '';
    el.href = '/api/audit.csv?limit=2000' + (q ? '&q=' + encodeURIComponent(q) : '') + (date ? '&date=' + encodeURIComponent(date) : '');
  };
  syncCsv();
  if ($('#auditDate')) $('#auditDate').addEventListener('change', () => { syncCsv(); loadAudit().catch((e) => toast(e.message)); });
  if ($('#auditQ')) $('#auditQ').addEventListener('input', syncCsv);
  $('#btnAuditRefresh').addEventListener('click', () => { syncCsv(); loadAuditDays().then(() => loadAudit()).catch((e) => toast(e.message)); });
  if ($('#btnSecRefresh')) $('#btnSecRefresh').addEventListener('click', () => loadSecurity().catch((e) => toast(e.message)));
  if ($('#secHours')) $('#secHours').addEventListener('change', () => loadSecurity().catch(() => {}));
  loadSecurity().catch(() => {});
  if ($('#btnRstatRefresh')) $('#btnRstatRefresh').addEventListener('click', () => loadRouteStats().catch((e) => toast(e.message)));
  loadRouteStats().catch(() => {});
  // 更多筛选（来源 IP / 时间范围）默认收起，1280 宽下四个控件刚好占满一整行
  const moreBtn = $('#btnMoreFilters');
  const moreBox = $('#accMore');
  const paintMore = () => {
    if (!moreBtn || !moreBox) return;
    const on = !moreBox.classList.contains('hidden');
    const used = [$('#accIp').value.trim(), $('#accRange').value !== '0'].filter(Boolean).length;
    moreBtn.textContent = on ? '收起筛选' : (used ? `更多筛选 · ${used}` : '更多筛选');
    moreBtn.setAttribute('aria-expanded', String(on));
  };
  if (moreBtn && moreBox) {
    moreBtn.addEventListener('click', () => { moreBox.classList.toggle('hidden'); paintMore(); });
    $('#accIp').addEventListener('input', paintMore);
    $('#accRange').addEventListener('change', paintMore);
    paintMore();
  }
  let auditTimer = null;
  $('#auditQ').addEventListener('input', () => {
    clearTimeout(auditTimer);
    auditTimer = setTimeout(() => { auditPage = 1; loadAudit().catch(() => {}); }, 300);
  });
  // 面板日志默认折叠（流式日志一展开就是一屏），按钮管展开/收起
  const setLogOpen = (on) => {
    const box = $('#logBox'); const b = $('#btnLogToggle2');
    if (box) box.classList.toggle('collapsed', !on);
    if (b) { b.textContent = on ? '收起' : '展开'; b.setAttribute('aria-expanded', String(on)); }
  };
  if ($('#btnLogToggle2')) {
    setLogOpen(false);
    $('#btnLogToggle2').addEventListener('click', () => {
      setLogOpen($('#logBox').classList.contains('collapsed'));
    });
  }
  // 日志为空时给一句状态，别留一条黑框（刚打开、或流还没吐数据）
  const logHint = () => {
    const box = $('#logBox');
    if (box && !box.querySelector('span') && !box.textContent.trim()) box.textContent = '正在连接面板日志…';
  };
  setTimeout(logHint, 2500);
  openLogStream((line) => {
    const box = $('#logBox');
    if (box && /^正在连接面板日志…$/.test(box.textContent.trim())) box.textContent = '';
    appendLog(line);
  });
  cfpEvery(8000, () => {
    if (!$('#accessAuto').checked) return;
    const a = document.activeElement;
    if (a && a.closest && a.closest('#accessBody')) return;        // 光标在表里（点分页/选文字）
    const sel = window.getSelection && window.getSelection();
    if (sel && String(sel).length) return;                         // 正在复制某行数据，别把它抢走
    loadAccess();
  });
});

})();
