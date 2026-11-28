/* 监控页：把 Prometheus 的 targets / 告警 聚合进来，并复用 Grafana 嵌入 */
(function () {
  let gKey = '';

  const SLOT_RE = /:(8090|8095)\b/;           // 蓝绿两槽，滚动升级时互换身份

  function badge(health, target) {
    const inst = (target && (target.instance || target.scrapeUrl)) || '';
    // 停着的那一色不是故障：它只是备份槽位，UP 的那一色才是当前 leader
    if (health === 'down' && SLOT_RE.test(inst)) {
      return '<span class="tag muted" title="这是备份槽位（另一色在跑），滚动升级时会互换，不是故障">备份槽位</span>';
    }
    const map = { up: ['正常', 'ok'], down: ['DOWN', 'err'], unknown: ['未知', 'warn'] };
    const [t, k] = map[health] || ['未知', 'warn'];
    return `<span class="tag ${k === 'ok' ? 'ok' : k === 'err' ? 'err' : 'warn'}">${t}</span>`;
  }

  function ago(iso) {
    if (!iso) return '—';
    const d = Date.parse(iso);
    if (!Number.isFinite(d)) return '—';
    const s = Math.max(0, Math.round((Date.now() - d) / 1000));
    if (s < 90) return s + ' 秒前';
    if (s < 5400) return Math.round(s / 60) + ' 分钟前';
    return Math.round(s / 3600) + ' 小时前';
  }

  function grafanaUrl(g, panel) {
    const dash = String(g.dashboard || '').split('/');
    if (!g.url || !dash[0]) return '';
    const q = new URLSearchParams({ orgId: '1', kiosk: '' });
    if (panel && panel.panelId) q.set('panelId', String(panel.panelId));
    if (g.theme) q.set('theme', g.theme);
    return `${String(g.url).replace(/\/+$/, '')}/d-solo/${encodeURIComponent(dash[0])}/${encodeURIComponent(dash[1] || dash[0])}?${q}`;
  }

  function paintGrafana(g) {
    const card = $('#monGrafanaCard');
    const body = $('#monGrafanaBody');
    if (!card || !body) return;
    const panels = (g && g.panels) || [];
    if (!g || !g.enabled || !g.url || !panels.length) { card.hidden = true; return; }
    card.hidden = false;
    const open = $('#btnMonOpen');
    if (open && g.url) { open.href = g.url; open.style.display = ''; }
    const mixed = location.protocol === 'https:' && /^http:\/\//i.test(g.url);
    const key = JSON.stringify([g.url, g.dashboard, g.theme, mixed, panels]);
    if (key === gKey) return;
    gKey = key;
    if (mixed) {
      // 混合内容拦的是 iframe，不是链接 → 至少给一个能点开的入口
      body.innerHTML = '<div class="gmixed">'
        + '<b>Grafana 是 http，当前页面是 https，iframe 会被浏览器拦掉</b>'
        + '<span>把 Grafana 也挂到 https 域名就能嵌；只是想看图，直接在新窗口打开。</span>'
        + '<a class="btn ghost sm" href="' + esc(g.url) + '" target="_blank" rel="noopener noreferrer">在新窗口打开 Grafana ↗</a>'
        + '</div>';
      return;
    }
    body.innerHTML = '<div class="sub gnote">滚动到这里会自动加载 Grafana，第一次会慢一点。</div>' + panels.map((p) => `
      <div class="field"><label>${esc(p.title || ('panel ' + p.panelId))}</label>
        <iframe class="chart" style="border:1px solid var(--line);border-radius:10px;width:100%;height:${Number(p.h) || 200}px"
          src="${esc(grafanaUrl(g, p))}" loading="lazy" referrerpolicy="no-referrer"></iframe></div>`).join('');
  }

// 告警行：如果标签里带出口 id，就链到隧道页并高亮那条出口
function aLink(a) {
  const id = (a.labels && a.labels.id) || '';
  const nm = (a.labels && a.labels.name) || '';
  if (!id) return nm ? ` <span class="tag">出口 ${esc(nm)}</span>` : '';
  return ` <a class="tag jump" href="/tunnels?focus=${encodeURIComponent(id)}" title="跳到这个出口">出口 ${esc(nm || id)}</a>`;
}

// 抓取目标：面板槽位（8090/8095）标一下「面板」，其他原样显示
function slotLink(instance) {
  const m = /:(\d+)$/.exec(String(instance || ''));
  const port = m ? Number(m[1]) : 0;
  const panelPort = Number(location.port) || 80;
  if (port && (port === panelPort || ((port === 8090 || port === 8095) && (/^(127\.0\.0\.1|localhost)$/.test(String(instance).replace(/:\d+$/, '')))))) {
    return '<span class="tag">面板</span> ';
  }
  return '';
}

const CHECK_LABEL = { ok: ['通过', 'ok'], warn: ['注意', 'warn'], fail: ['失败', 'err'] };

let lastCheckData = null;

function renderCheck(r) {
  const box = $('#checkBody');
  if (!box) return;
  if (!r || !r.checks || !r.checks.length) { box.innerHTML = '<div class="empty">没拿到体检结果</div>'; return; }
  lastCheckData = r;
  const head = r.fail
    ? `<div class="hint banner" style="margin-bottom:12px"><span class="bico">!</span><div class="msg">${r.fail} 项失败、${r.warn} 项需要注意（共 ${r.total} 项）</div></div>`
    : `<div class="muted" style="margin-bottom:12px">${r.total} 项全部通过${r.warn ? `，其中 ${r.warn} 项值得留意` : ''}</div>`;
  const rows = r.checks.map((c) => {
    const [txt, cls] = CHECK_LABEL[c.status] || [c.status, 'muted'];
    return `<tr>
      <td><span class="tag ${cls}">${txt}</span></td>
      <td class="nowrap">${esc(c.name)}</td>
      <td class="mono sm">${esc(c.detail || '')}</td>
      <td class="muted sm">${c.hint ? esc(c.hint) : ''}</td>
      <td class="mono sm muted nowrap">${c.ms}ms</td>
    </tr>`;
  }).join('');
  box.innerHTML = head + `<div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>状态</th><th>项目</th><th>结果</th><th>怎么办</th><th>耗时</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <div class="row" style="margin-top:10px"><button class="sm ghost" id="btnCheckDl">导出本次体检 JSON</button></div>`;
}

/** 页面打开时先把「上次（定时）体检」的结果亮出来，不用非点按钮 */
async function paintLastCheck() {
  const box = $('#checkBody');
  if (!box) return;
  try {
    const h = await api('/api/selfcheck/history?limit=1');
    const last = h && h.last;
    if (!last) return;
    const mins = Math.max(0, Math.round((Date.now() - last.at) / 60000));
    const when = mins < 1 ? '刚刚' : mins < 60 ? `${mins} 分钟前` : `${Math.round(mins / 60)} 小时前`;
    if (last.fail) {
      box.innerHTML = `<div class="hint banner"><span class="bico">!</span><div class="msg">上次体检（${when}）有 ${last.fail} 项失败：${esc((last.bad || []).map((x) => x.name).join('、'))}。点右上角「开始体检」重查。</div></div>`;
    } else {
      box.innerHTML = `<div class="muted">上次体检：${when}，${last.total} 项全部通过（定时每 5 分钟跑一次，出问题会走通知通道告警）。</div>`;
    }
  } catch { /* 拿不到就保持「还没查过」的说明态 */ }
}

/* 体检历史：每个小条 = 一次体检，绿=全通过、琥珀=有警告、红=有失败 */
function histTip(h) {
  const t = new Date(h.at);
  const p2 = (x) => String(x).padStart(2, '0');
  const hm = `${p2(t.getMonth() + 1)}-${p2(t.getDate())} ${p2(t.getHours())}:${p2(t.getMinutes())}`;
  const bad = (h.bad || []).map((b) => b.name).filter(Boolean);
  return `${hm} · ${h.scope === 'quick' ? '快速 · ' : ''}${h.total - h.fail}/${h.total} 通过`
    + (h.warn ? ` · ${h.warn} 项警告` : '')
    + (bad.length ? `\n失败：${bad.join('、')}` : '');
}

async function paintCheckHistory() {
  const wrap = $('#checkHistWrap');
  const box = $('#checkHist');
  if (!wrap || !box) return;
  let items = [];
  let store = null;
  let scopes = null;
  let hoursN = 24;
  try {
    const r = await api('/api/selfcheck/history?limit=40');
    items = (r && r.items) || [];
    store = (r && r.store) || null;
    scopes = (r && r.scopes) || null;
    hoursN = (r && r.hours) || 24;
    paintCheckFails(r);
  } catch { return; }
  if (!items.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const dropped = !!(store && store.count >= store.keep);
  box.innerHTML = (dropped
    ? `<button type="button" class="bar drop" data-note="1" title="更早的记录已被丢弃（只保留最近 ${store.keep} 次）—— 点一下看说明" aria-label="更早的体检记录已被丢弃"></button>`
    : '')
    + items.slice().reverse().map((h) => {                       // 左旧右新
    const state = h.fail ? 'fail' : (h.warn ? 'warn' : 'ok');
    const q = h.scope === 'quick' ? ' data-q="1"' : '';
    return `<i class="bar" data-s="${state}"${q} title="${esc(histTip(h))}"></i>`;
  }).join('');
  const last = items[0];
  const mins = Math.max(0, Math.round((Date.now() - Number(last.at || 0)) / 60000));
  const agoTxt = mins < 1 ? '刚刚'
    : mins < 60 ? `${mins} 分钟前`
      : mins < 1440 ? `${Math.floor(mins / 60)} 小时 ${mins % 60} 分前`
        : `${Math.floor(mins / 1440)} 天前`;
  $('#checkHistNote').textContent = `最近 ${items.length} 次体检（左旧右新）· 上次 `
    + `${agoTxt}：${last.total - last.fail}/${last.total} 通过`
    + (last.fail ? `，${last.fail} 项失败` : '')
    + (last.warn ? `，${last.warn} 项警告` : '');
  if (scopes && (scopes.all + scopes.quick) > 1) {
    $('#checkHistNote').textContent += `　·　最近 ${hoursN} 小时：全量 ${scopes.all} 次、快速 ${scopes.quick} 次`;
  }
  const st2 = store;
  if (st2 && typeof st2.bytes === 'number') {
    const kb2 = st2.bytes >= 1024 * 1024 ? (st2.bytes / 1024 / 1024).toFixed(1) + ' MB' : Math.round(st2.bytes / 1024) + ' KB';
    $('#checkHistNote').textContent += `　·　留痕 ${st2.count} 条 / ${kb2}（上限 ${st2.keep} 条 / ${Math.round(st2.maxBytes / 1024)} KB）`;
    const leftRuns = st2.keep - st2.count;
    if (leftRuns <= 40) {
      $('#checkHistNote').textContent += leftRuns > 0
        ? `；再跑 ${leftRuns} 次就会开始丢最早的记录`
        : '；已满，正在丢弃最早的记录';
    }
  }
}

/** 最近 24 小时哪些检查项出过问题（反复失败的老毛病比「刚刚失败一次」更值得看） */
function paintCheckFails(r) {
  const box = $('#checkFails');
  if (!box) return;
  const fails = (r && r.fails) || [];
  const hours = (r && r.hours) || 24;
  const runs = (r && r.runs) || 0;
  if (!fails.length) {
    // 别整块藏掉：藏起来会让人以为没这个功能
    box.hidden = false;
    box.innerHTML = runs >= 2
      ? `<div class="sub">最近 ${hours} 小时跑了 ${runs} 次体检，没有失败项。</div>`
      : `<div class="sub">还没攒够体检记录（${runs} 次），跑了两次以上这里会显示哪些项出过问题。</div>`;
    return;
  }
  box.hidden = false;
  // 每条失败项右侧画一排小格：左边最早、右边最近，红格=那次体检这项失败
  const items = (r.items || []).slice().sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0)).slice(-60);
  const strip = (id) => items.map((it) => {
    const badList = Array.isArray(it.bad) ? it.bad : [];
    const hit = badList.some((x) => (x && x.id) === id);
    const when = String(it.at || '').replace('T', ' ').slice(5, 16);
    return `<i class="sbar" data-s="${hit ? 'fail' : 'ok'}" title="${esc(when)}${hit ? ' · 这项失败' : ' · 通过'}"></i>`;
  }).join('');
  const rows = fails.map((f) => {
    const ago = f.lastAt ? Math.max(0, Math.round((Date.now() - Date.parse(f.lastAt)) / 60000)) : null;
    const when = ago === null ? '' : (ago < 60 ? `${ago} 分钟前` : `${Math.round(ago / 60)} 小时前`);
    return `<tr><td>${esc(f.name || f.id)}</td><td class="num">${f.count}</td><td class="sub">${esc(when)}</td>`
      + `<td class="strip">${strip(f.id)}</td>`
      + `<td class="sub">${esc(String(f.lastDetail || '').slice(0, 80))}</td></tr>`;
  }).join('');
  box.innerHTML = `<div class="tbl-wrap"><table class="tbl compact"><thead><tr>`
    + `<th>项目</th><th class="num">次数</th><th>最后一次</th><th>最近 ${items.length} 次</th><th>说明</th></tr></thead><tbody>${rows}</tbody></table></div>`
    + `<div class="sub">最近 ${hours} 小时共 ${runs} 次体检里，上面这些项出过问题（次数多的优先修）。</div>`;
}

async function runCheck() {
  const btn = $('#btnCheck');
  if (btn) { btn.disabled = true; btn.textContent = '体检中…'; }
  const box = $('#checkBody');
  if (box) box.innerHTML = '<div class="empty">正在查（每个依赖最多等 3 秒）…</div>';
  try {
    const sc = ($('#checkScope') || {}).value || 'all';
    try { localStorage.setItem('cfp-checkScope', sc); } catch (e) {}
    const r = await api('/api/selfcheck' + (sc === 'quick' ? '?scope=quick' : ''));
    renderCheck(r);
  paintCheckHistory();
    if (r && r.fail) toast(`${r.fail} 项失败`, 'err');
  } catch (e) {
    if (box) box.innerHTML = `<div class="empty">体检没跑成：${esc(e.message)}</div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '重新体检'; }
  }
}

async function load() {
    const tb = $('#monTargetBody');
    const ab = $('#monAlertBody');
    try {
      const d = await api('/api/monitor/status');
      $('#monReady').textContent = d.ok ? (d.ready ? '就绪' : '未就绪') : '连不上';
      $('#monReady').className = 'v ' + (d.ok && d.ready ? 'ok-hint' : 'err-hint');
      $('#monPromUrl').textContent = d.promUrl || '';
      if (!d.ok) {
        tb.innerHTML = `<div class="hint warn">${esc(d.error || '查询失败')}</div>`;
        ab.innerHTML = '<div class="empty">—</div>';
        $('#monTargets').textContent = '—';
        $('#monAlerts').textContent = '—';
        return;
      }
      const s = d.summary || {};
      // 面板是双槽位部署（8090/8095），滚动升级时总有一色停着 —— 那一色的 target 必然 down，
      // 但这不是故障。只有「非槽位」的目标也挂了才标红。
      const SLOT = SLOT_RE;
      const slotDownOnly = (d.targets || []).every((t) => t.health === 'up' || SLOT.test(t.instance || t.scrapeUrl || ''));
      // 停着的那一色是备份槽位，写出来免得「1/2 正常」看着像有故障
      const slotDown = s.down && slotDownOnly ? s.down : 0;
      $('#monTargets').textContent = `${s.up}/${s.total} 正常` + (slotDown ? ` · 备份槽位 ${slotDown}` : '');
      $('#monTargets').className = 'v ' + (!s.down ? 'ok-hint' : slotDownOnly ? 'muted' : 'err-hint');
      $('#monTargets').title = s.down && slotDownOnly ? '停着的是备份槽位（滚动升级时会互换），不是故障' : '';
      const firing = (d.alerts || []).filter((a) => a.state === 'firing');
      $('#monAlerts').textContent = firing.length ? String(firing.length) : '0';
      $('#monAlerts').className = 'v ' + (firing.length ? 'err-hint' : 'ok-hint');

      tb.innerHTML = (d.targets || []).length
        ? `<div class="tbl-wrap"><table class="stackable"><thead><tr><th>任务</th><th>实例</th><th>状态</th><th>最近抓取</th><th>错误</th></tr></thead><tbody>${
          d.targets.map((t) => `<tr>
            <td class="mono" data-label="任务">${esc(t.job)}</td>
            <td class="mono muted" data-label="实例">${slotLink(t.instance)}${esc(t.scrapeUrl || t.instance)}</td>
            <td data-label="状态">${badge(t.health, t)}</td>
            <td class="mono" data-label="最近抓取">${esc(ago(t.lastScrape))}</td>
            <td class="mono muted" data-label="错误">${t.health === 'down' && SLOT_RE.test(t.instance || t.scrapeUrl || '') ? '—' : esc(t.lastError || '—')}</td>
          </tr>`).join('')}</tbody></table></div>`
        : '<div class="empty">没有抓取目标</div>';

      const mutedCount = (d.alerts || []).filter((a) => a.muted).length;
      ab.innerHTML = (d.alerts || []).length
        ? `<div class="tbl-wrap"><table class="stackable"><thead><tr><th>告警</th><th>状态</th><th>级别</th><th>开始</th><th>说明</th><th>操作</th></tr></thead><tbody>${
          d.alerts.map((a) => `<tr${a.muted ? ' class="muted-row"' : ''}>
            <td data-label="告警"><b>${esc(a.name)}</b>${aLink(a)}${a.muted ? ` <span class="tag warn" title="静默到 ${esc(a.muteUntil || '')}">已静默</span>` : ''}</td>
            <td data-label="状态"><span class="tag ${a.state === 'firing' ? 'err' : 'warn'}">${a.state === 'firing' ? '正在告警' : '待定'}</span></td>
            <td class="muted" data-label="级别">${esc(a.severity || '—')}</td>
            <td class="mono" data-label="开始">${esc(ago(a.activeAt))}</td>
            <td class="muted" data-label="说明">${esc(a.summary || '—')}</td>
            <td data-label="操作">${a.muted
              ? `<button class="sm ghost" data-unmute="${esc(a.name)}">解除</button>`
              : `<button class="sm ghost" data-mute="${esc(a.name)}">静默 1h</button>`}</td>
          </tr>`).join('')}</tbody></table></div>${
            mutedCount ? `<div class="sub" style="margin-top:6px">已静默 ${mutedCount} 条：只影响本页提醒，Prometheus 侧照常记录与评估。</div>` : ''}`
        : '<div class="empty empty-inline">当前没有告警 —— 这是好事，Prometheus 里的规则都还绿着。</div>';
    } catch (e) {
      tb.innerHTML = `<div class="hint err">${esc(e.message)}</div>`;
    }
    const st = await loadState(true).catch(() => null);
    if (st) {
      paintGrafana(((st.state || {}).settings || {}).grafana);
      const role = st.role || 'admin';
      $('#monRole').textContent = (st.mode === 'standby' ? '备份（只读）' : '主实例') + ' · ' + role;
    }
  }

  async function loadUpHealth() {
    const b = $('#upHealthBody');
    if (!b) return;
    try {
      const d = await api('/api/upstream/health');
      const note = $('#upHealthNote');
      if (note) note.textContent = d.available ? (d.rows.length + ' 条上游') : '';
      if (!d.available || !d.rows || !d.rows.length) {
        b.innerHTML = '<div class="empty empty-inline">没有可探测的上游（停用规则不计）——启用规则后，服务端每分钟探一次</div>';
        return;
      }
      b.innerHTML = d.rows.map((r) => {
        const dot = r.ok
          ? `<span class="dot ok" title="TCP 通 · ${r.ms}ms"></span>`
          : `<span class="dot err" title="不通：${esc(r.error || '')}"></span>`;
        const backup = r.backup ? ' <span class="tag warn">备用</span>' : '';
        return `<div class="uprow"><div class="uprow-main"><b>${esc(r.name || r.id)}</b> ${dot} <span class="muted mono">${esc(r.upstream)}</span>${backup}</div>`
          + `<div class="uprow-meta">可用率 <b>${r.avail24h == null ? '—' : r.avail24h + '%'}</b> · 平均 ${r.avgMs24h == null ? '—' : r.avgMs24h + 'ms'} · P95 ${r.p95Ms24h == null ? '—' : r.p95Ms24h + 'ms'} · ${r.samples} 次采样</div>`
          + miniBars(r.hist || []) + `</div>`;
      }).join('');
    } catch (e) { b.innerHTML = `<div class="hint err">${esc(e.message)}</div>`; }
  }

  function miniBars(hist) {
    if (!hist.length) return '<div class="sub">还没有历史：服务端每 60 秒探一次，过几分钟再来看</div>';
    const N = 96;
    const step = Math.max(1, Math.ceil(hist.length / N));
    const bars = [];
    for (let i = 0; i < hist.length; i += step) {
      const chunk = hist.slice(i, i + step);
      const ok = chunk.filter((x) => x.ok).length;
      const k = ok === chunk.length ? 'ok' : ok === 0 ? 'fail' : 'warn';
      bars.push(`<span class="bar" data-s="${k}" style="height:${4 + 14 * (ok / chunk.length)}px" title="${chunk.length} 次探测 · ${ok} 通 · ${new Date(chunk[0].t).toTimeString().slice(0, 5)}"></span>`);
    }
    return `<div class="sc-hist uphist" role="img" aria-label="24 小时上游健康">${bars.join('')}</div>`;
  }

  document.addEventListener('DOMContentLoaded', () => {
    load().catch((e) => toast(e.message, 'err'));
    if ($('#btnMonRefresh')) $('#btnMonRefresh').addEventListener('click', () => { load().catch((e) => toast(e.message, 'err')); loadUpHealth().catch(() => {}); });
    if ($('#btnCheck')) $('#btnCheck').addEventListener('click', () => runCheck());
    // 体检范围记一下：常点「快速」的人不用每次重选
    const scSel = $('#checkScope');
    if (scSel) {
      try { const v = localStorage.getItem('cfp-checkScope'); if (v === 'quick' || v === 'all') scSel.value = v; } catch (e) {}
      scSel.addEventListener('change', () => { try { localStorage.setItem('cfp-checkScope', scSel.value); } catch (e) {} });
    }
    const hbox = $('#checkHist');
    if (hbox) hbox.addEventListener('click', (e) => {
      const hit = e.target.closest && e.target.closest('[data-note]');
      if (!hit) return;
      toast('留痕只保留最近 300 次体检（约 25 小时）。更早的记录会被丢掉，好在小条上仍能看出「这里之前还有」。', '', null);
    });
    const cbody = $('#checkBody');
    if (cbody) cbody.addEventListener('click', async (e) => {
      const hit = e.target.closest && e.target.closest('#btnCheckDl');
      if (!hit || !lastCheckData) return;
      const meta = await fetch('/healthz').then((r2) => r2.json()).catch(() => ({}));
      const payload = {
        exportedAt: new Date().toISOString(),
        panel: {
          version: meta.version || '', code: meta.code || '', imageCode: meta.imageCode || '',
          mode: meta.mode || '', instance: meta.instance || '', drift: meta.drift,
        },
        result: lastCheckData,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a2 = document.createElement('a');
      a2.href = URL.createObjectURL(blob);
      a2.download = 'selfcheck-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json';
      a2.click();
      setTimeout(() => URL.revokeObjectURL(a2.href), 3000);
      toast('已导出这次体检的结果', 'ok');
    });
    paintLastCheck();
    paintCheckHistory();
    loadUpHealth().catch(() => {});
    // /monitor#check：命令面板「一键体检」跳过来时，滚到体检卡并直接跑一次
    if (location.hash === '#check' && $('#checkCard')) {
      $('#checkCard').scrollIntoView({ block: 'start', behavior: 'smooth' });
      if ($('#btnCheck')) runCheck();
    }

    const abx = $('#monAlertBody');
    if (abx) abx.addEventListener('click', async (e) => {
      const m = e.target.closest('[data-mute]');
      const u = e.target.closest('[data-unmute]');
      if (!m && !u) return;
      const name = (m || u).getAttribute('data-mute') || (m || u).getAttribute('data-unmute');
      try {
        if (m) {
          const minutes = Number(window.prompt('静默多久（分钟，5–1440）？', '60') || 0);
          if (!minutes) return;
          await api('/api/monitor/mute', { method: 'POST', body: { name, minutes } });
          toast('已静默 ' + name + '（' + minutes + ' 分钟）');
        } else {
          await api('/api/monitor/unmute', { method: 'POST', body: { name } });
          toast('已取消静默 ' + name);
        }
        await load();
      } catch (err) { toast(err.message, 'err'); }
    });
    cfpEvery(30000, () => load());
  });
})();
