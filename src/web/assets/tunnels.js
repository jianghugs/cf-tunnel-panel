/* 隧道出口页 */
'use strict';
(function () {


function fmtDur(sec) {
  const n = Math.max(0, Math.floor(Number(sec) || 0));
  if (n < 60) return `${n} 秒`;
  const m = Math.floor(n / 60);
  if (m < 60) return `${m} 分 ${n % 60} 秒`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时 ${m % 60} 分`;
  const d = Math.floor(h / 24);
  return `${d} 天 ${h % 24} 小时`;
}
let ST = null;
let openedOnce = {};

function exitCard(t, d) {
  const rt = rtOf(t.id, d);
  const url = rt.publicUrl || rt.url || '';
  const scoped = (d.state.routes || []).filter((r) => r.tunnelId === t.id).length;
  const isNamed = t.mode === 'named';
  const metricsWarn = t.metricsPort && (d.state.tunnels || []).some((x) => x.id !== t.id && String(x.metricsPort) === String(t.metricsPort))
    ? '<span class="tag warn">metrics 端口与其他出口冲突</span>' : '';
  const tokenWarn = isNamed && !t.hasToken ? '<span class="tag warn" title="命名隧道必须有 Cloudflare 给的 token">还没填 Token</span>' : '';
  const hostWarn = isNamed && !String(t.publicHostname || '').trim() ? '<span class="tag warn" title="命名隧道要有公网域名才能被访问">还没填公网域名</span>' : '';
  return `<div class="card" data-id="${esc(t.id)}">
    <div class="hd">
      <h2>${esc(t.name || t.id)}</h2>
      <span class="tag">${isNamed ? '命名隧道' : '快速隧道'}</span>
      <span data-live="pill">${statusPill(rt.status)}</span>
      ${scoped ? `<span class="tag" title="绑定到这条出口的规则数（其他规则全局生效）">${scoped} 条仅限此出口</span>` : ''}
      ${metricsWarn}
      ${tokenWarn}
      ${hostWarn}
      <div class="right">
        <div class="menu">
          <button class="sm ghost" data-menu="1" aria-haspopup="true" aria-expanded="false" title="重启 / 启动 / 停止 / 二维码…">操作 ⋯</button>
          <div class="menu-pop hidden">
            <button type="button" data-act="restart">重启（域名不变）</button>
            <button type="button" data-act="start">启动</button>
            <button type="button" data-act="stop">停止</button>
            <button type="button" data-act="qr">二维码</button>
            <button type="button" data-act="copy">复制地址</button>
            <button type="button" data-act="dup">复制成新出口</button>
          </div>
        </div>
        <button class="sm danger" data-act="del" title="删除这条出口（会第二次确认）">删除</button>
      </div>
    </div>
    <div class="bd stack">
      <div class="row" data-live="url">${liveRow(t, d)}</div>
      <details ${openedOnce[t.id] ? 'open' : ''} data-edit>
        <summary>出口设置</summary>
        <div class="stack" style="margin-top:10px">
          <div class="form-grid">
            <div class="field"><label>名字</label><input data-k="name" value="${esc(t.name)}" /></div>
            <div class="field"><label>模式</label>
              <select data-k="mode">
                <option value="quick" ${t.mode !== 'named' ? 'selected' : ''}>快速隧道</option>
                <option value="named" ${t.mode === 'named' ? 'selected' : ''}>命名隧道</option>
              </select>
            </div>
            <div class="field"><label>上游地址</label><input data-k="origin" value="${esc(t.origin)}" /></div>
            <div class="field"><label>公网域名</label><input data-k="publicHostname" value="${esc(t.publicHostname || '')}" placeholder="dsh.example.com" />
              <div class="muted" style="margin-top:4px">必须和 Cloudflare → 隧道 → 公共主机名里填的那个域名一致（快速隧道可留空）</div></div>
          </div>
          <div class="form-grid">
            <div class="field"><label>Tunnel Token ${t.hasToken ? '（已保存，留空不改）' : ''}</label>
              <input data-k="token" type="password" placeholder="${t.hasToken ? '已配置，留空不改' : '粘贴 eyJ 开头的那一串（不是整条 docker 命令）'}" autocomplete="off" />
              <div class="muted" style="margin-top:4px">${t.tokenTunnelId
                ? `当前 token 属于隧道 <code class="mono">${esc(t.tokenTunnelId.slice(0, 8))}…${esc(t.tokenTunnelId.slice(-4))}</code>`
                : (t.hasToken
                  ? '<span style="color:var(--err)">已保存的 token 解析不了（像是整条命令或复制不全），请重新粘贴</span>'
                  : (isNamed ? '还没有 token：Cloudflare 该隧道页里复制 <code>--token</code> 后面那一串' : '快速隧道不需要 token'))}</div>
            </div>
            <div class="field"><label>协议</label>
              <select data-k="protocol">
                ${['auto', 'http2', 'quic'].map((x) => `<option value="${x}" ${t.protocol === x ? 'selected' : ''}>${x}</option>`).join('')}
              </select>
            </div>
            <div class="field"><label>日志级别</label>
              <select data-k="loglevel">
                ${['debug', 'info', 'warn', 'error'].map((x) => `<option value="${x}" ${t.loglevel === x ? 'selected' : ''}>${x}</option>`).join('')}
              </select>
            </div>
            <div class="field"><label>metrics 端口</label><input data-k="metricsPort" value="${esc(t.metricsPort || '')}" placeholder="留空不用" /></div>
            <div class="field"><label>额外参数</label><input data-k="extraArgs" value="${esc(t.extraArgs || '')}" placeholder="--edge-ip-version 4" /></div>
          </div>
          <div class="row">
            <button class="primary" data-act="save">保存并重启</button>
            <span class="muted" data-msg></span>
          </div>
        </div>
      </details>
    </div>
  </div>`;
}

function liveRow(t, d) {
  const rt = rtOf(t.id, d);
  const url = rt.publicUrl || rt.url || '';
  const errText = rt.fatal ? 'Token 无效 · 已停止自动重试' : (rt.lastError ? String(rt.lastError).slice(0, 70) : '');
  const tags = [
    errText ? `<span class="tag err" title="${esc(rt.lastError || '')}">${esc(errText)}</span>` : '',
    rt.pid ? `<span class="tag">pid ${rt.pid}</span>` : '',
    rt.uptimeSec ? `<span class="tag" title="本次运行时长">已运行 ${fmtDur(rt.uptimeSec)}</span>` : '',
    (!rt.fatal && rt.reconnects) ? `<span class="tag warn" title="启动后 cloudflared 异常退出并自动重连的次数；持续增长说明网络或 token 有问题">重连 ×${rt.reconnects}</span>` : '',
    // 网络层重连（进程没退出）：访客感知是「网站抽了一下」，但以前面板上完全看不到
    (rt.flaps10m >= 3) ? `<span class="tag warn" title="cloudflared 到 Cloudflare 边缘的连接在抖：最近 10 分钟 ${rt.flaps10m} 次，本次启动累计 ${rt.flaps} 次${rt.lastFlapAt ? '，最近一次 ' + new Date(rt.lastFlapAt).toLocaleTimeString() : ''}。改协议为 http2 通常更稳">网络重连 ×${rt.flaps10m}</span>`
      : (rt.flaps ? `<span class="tag" title="本次启动后累计网络重连 ${rt.flaps} 次（偶发属正常）">网络重连 ×${rt.flaps}</span>` : ''),
  ].join('');
  return (url
    ? `<a class="mono" href="${esc(url)}" target="_blank" rel="noreferrer">${esc(url)}</a><button class="sm ghost" data-act="copy">复制</button>`
    : '<span class="muted">还没有公网地址（启动后会显示）</span>') + tags;
}

/** 只改状态/地址这些小片段，绝不重建卡片 —— 否则正在输入的出口设置会被 5 秒轮询清空。 */
function updateLive() {
  $$('#tunnelList > .card').forEach((card) => {
    const id = card.dataset.id;
    const t = (ST.state.tunnels || []).find((x) => x.id === id);
    if (!t) return;
    const rt = rtOf(id, ST);
    const pill = card.querySelector('[data-live="pill"]');
    if (pill) pill.innerHTML = statusPill(rt.status);
    const row = card.querySelector('[data-live="url"]');
    if (row) row.innerHTML = liveRow(t, ST);
  });
}

let renderedIds = '';

function render() {
  const box = $('#tunnelList');
  const list = (ST.state.tunnels || []);
  if (!list.length) {
    box.innerHTML = '<div class="card"><div class="empty"><span class="big">⇄</span>还没有隧道出口，点右上角「新建出口」</div></div>';
    return;
  }
  box.innerHTML = list.map((t) => exitCard(t, ST)).join('');
  renderedIds = list.map((t) => t.id).join(',');
  $$('#tunnelList [data-edit]').forEach((el) => el.addEventListener('toggle', () => {
    const id = el.closest('[data-id]').dataset.id;
    openedOnce[id] = el.open;
  }));
}

function collect(card) {
  const g = (k) => {
    const el = card.querySelector(`[data-k="${k}"]`);
    return el ? el.value.trim() : '';
  };
  const body = {
    name: g('name'), mode: g('mode'), origin: g('origin'), publicHostname: g('publicHostname'),
    protocol: g('protocol'), loglevel: g('loglevel'), metricsPort: g('metricsPort'), extraArgs: g('extraArgs'),
  };
  const tok = g('token');
  if (tok) body.token = tok;
  return body;
}

async function act(card, action) {
  const id = card.dataset.id;
  const t = (ST.state.tunnels || []).find((x) => x.id === id);
  const msg = card.querySelector('[data-msg]');
  try {
    if (action === 'save') {
      if (msg) msg.textContent = '保存中…';
      await api('/api/tunnels/' + id, { method: 'POST', body: collect(card) });
      toast('已保存并重启该出口', 'ok');
      if (window.__cfpSetUnsaved) window.__cfpSetUnsaved('tunnels', false);
      await refresh(true);
      return;
    }
    if (action === 'del') {
      if (!confirm(`删除出口「${t.name}」？\n它下面绑定的专属规则会失效（规则本身保留），云端隧道不会被删除。`)) return;
      await api(`/api/tunnels/${id}/delete`, { method: 'POST' });
      toast('已删除', 'ok');
      await refresh(true);
      return;
    }
    if (action === 'dup') {
      const body = { name: (t.name || '出口') + ' 副本', mode: t.mode, origin: t.origin, token: t.token || '', publicHostname: '', protocol: t.protocol, loglevel: t.loglevel, metricsPort: '', extraArgs: t.extraArgs };
      delete body.token;
      await api('/api/tunnels', { method: 'POST', body });
      toast('已复制为新出口（token 需要重新填）', 'ok');
      await refresh(true);
      return;
    }
    if (action === 'qr') {
      const url = rtOf(id, ST).publicUrl || rtOf(id, ST).url;
      if (!url) return toast('这个出口还没有公网地址', 'err');
      const d = await api('/api/qr?text=' + encodeURIComponent(url));
      const w = window.open('', '_blank');
      if (w) w.document.write(`<title>二维码</title><body style="margin:0;display:grid;place-items:center;height:100vh;background:#0b0f14"><div style="text-align:center;color:#e6edf3;font:14px sans-serif"><img src="${d.dataUrl}" style="width:320px;background:#fff;padding:12px;border-radius:12px"/><div style="margin-top:10px;word-break:break-all">${esc(url)}</div></div></body>`);
      return;
    }
    if (action === 'copy') {
      const r0 = rtOf(id, ST) || {};
      return copyText(r0.publicUrl || r0.url || '');
    }
    await api(`/api/tunnels/${id}/${action}`, { method: 'POST' });
    toast(action === 'start' ? '正在启动…' : action === 'stop' ? '正在停止…' : '正在重启…', 'ok');
    setTimeout(() => refresh(true), 1200);
  } catch (e) {
    toast('操作失败：' + e.message, 'err');
    if (msg) msg.textContent = e.message;
  }
}

async function refresh(force) {
  try {
    ST = await loadState(force);
    paintHealth(ST);
    $('#caddyListenHint').textContent = (ST.state.settings && ST.state.settings.caddyListen) || ':8080';
    const ids = (ST.state.tunnels || []).map((t) => t.id).join(',');
    // 出口集合没变就只改状态片段，绝不重建卡片 —— 否则正在输入的「出口设置」会被 5 秒轮询清空
    if (force || ids !== renderedIds) render();
    else updateLive();
  } catch (e) {
    toast('读取状态失败：' + e.message, 'err');
  }
}


/* 出口级流量：访问日志里的 Host 归属到具体出口（命名隧道按 publicHostname，快速按当前域名） */
function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
  return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

async function loadExitStats() {
  const box = $('#exitStatsBody');
  if (!box) return;
  const hours = Number(($('#exitStatsHours') || {}).value || 24);
  try {
    const d = await api(`/api/tunnels/stats?hours=${hours}`);
    const rows = (d.tunnels || []).map((t) => `<tr>
      <td data-label="出口"><b>${esc(t.name)}</b> <span class="tag">${t.mode === 'named' ? '命名' : '快速'}</span></td>
      <td class="mono muted" data-label="域名">${esc(t.host || '（还没有公网域名）')}</td>
      <td class="mono" data-label="请求">${t.count}</td>
      <td class="mono ${t.err5 ? 'err-hint' : ''}" data-label="5xx">${t.err5}</td>
      <td class="mono" data-label="4xx">${t.err4}</td>
      <td class="mono" data-label="p95">${t.p95 ? t.p95 + 'ms' : '—'}</td>
      <td class="mono muted" data-label="流量">${fmtBytes(t.bytes)}</td>
    </tr>`).join('');
    const others = (d.other && d.other.hosts) || [];
    const otherRow = others.length
      ? `<details class="longtail" style="margin-top:8px"><summary>另外 ${d.other.count} 条请求打在不属于任何出口的域名上（点开看是哪些）</summary><div class="hint">${others.map((x) => `<span class="mono">${esc(x.host)} ×${x.count}</span>`).join('、')}</div></details>`
      : '';
    box.innerHTML = `<div class="tbl-wrap"><table class="stackable">
      <thead><tr><th>出口</th><th>域名</th><th>请求</th><th>5xx</th><th>4xx</th><th>p95</th><th>流量</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="empty">还没有出口</td></tr>'}</tbody>
    </table></div>${otherRow}`;
  } catch (e) {
    box.innerHTML = `<div class="hint warn">读取失败：${esc(e.message)}</div>`;
  }
}

// 从监控页的告警点过来时，定位到对应出口
function focusExit() {
  const id = new URLSearchParams(location.search).get('focus');
  if (!id) return;
  const el = document.querySelector(`#tunnelList [data-id="${id}"]`);
  if (!el) { toast('这个出口不在当前列表里（可能刚被删掉）', 'warn'); return; }
  if (el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.setAttribute('data-focused', '1');
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1600);
}

document.addEventListener('DOMContentLoaded', () => {
  $('#btnStartAll').addEventListener('click', async () => {
    try { await api('/api/tunnels/start-all', { method: 'POST' }); toast('正在启动全部出口', 'ok'); setTimeout(() => refresh(true), 1500); }
    catch (e) { toast(e.message, 'err'); }
  });
  $('#btnStopAll').addEventListener('click', async () => {
    try { await api('/api/tunnels/stop-all', { method: 'POST' }); toast('正在停止全部出口', 'ok'); setTimeout(() => refresh(true), 1200); }
    catch (e) { toast(e.message, 'err'); }
  });
  $('#btnAdd').addEventListener('click', () => {
    const nc = $('#newCard');
    if (nc && nc.scrollIntoView) nc.scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('#newName').focus();
  });
  // 出口卡片里任何输入都算「未保存」，保存成功后由 saveTunnel 清掉
  document.addEventListener('input', (e) => {
    if (e.target.closest && e.target.closest('#tunnelList, #newTunnel')) {
      if (window.__cfpSetUnsaved) window.__cfpSetUnsaved('tunnels', true);
    }
  });
  $('#newMode').addEventListener('change', (e) => {
    $('#newNamedBox').classList.toggle('hidden', e.target.value !== 'named');
  });
  $('#btnCreate').addEventListener('click', async () => {
    const mode = $('#newMode').value;
    const body = {
      name: $('#newName').value.trim() || '新出口',
      mode,
      origin: $('#newOrigin').value.trim() || 'http://127.0.0.1:8080',
    };
    if (mode === 'named') {
      body.token = $('#newToken').value.trim();
      body.publicHostname = $('#newHost').value.trim();
      if (!body.token) return toast('命名隧道需要填 Tunnel Token', 'err');
    }
    try {
      $('#newMsg').textContent = '创建中…';
      await api('/api/tunnels', { method: 'POST', body });
      $('#newMsg').textContent = '';
      $('#newName').value = ''; $('#newToken').value = ''; $('#newHost').value = '';
      toast('已创建，正在启动', 'ok');
      await refresh(true);
    } catch (e) {
      $('#newMsg').textContent = e.message;
      toast('创建失败：' + e.message, 'err');
    }
  });
  $('#tunnelList').addEventListener('click', (e) => {
    const mb = e.target.closest('[data-menu]');
    if (mb) {
      const wrap = mb.closest('.menu');
      const pop = wrap && wrap.querySelector('.menu-pop');
      const open = pop && !pop.classList.contains('hidden');
      document.querySelectorAll('#tunnelList .menu-pop').forEach((x) => x.classList.add('hidden'));
      document.querySelectorAll('#tunnelList [data-menu]').forEach((x) => x.setAttribute('aria-expanded', 'false'));
      if (pop && !open) { pop.classList.remove('hidden'); mb.setAttribute('aria-expanded', 'true'); }
      e.stopPropagation();
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const card = b.closest('[data-id]');
    const pop = b.closest('.menu-pop');
    if (pop) { pop.classList.add('hidden'); const tg = card && card.querySelector('[data-menu]'); if (tg) tg.setAttribute('aria-expanded', 'false'); }
    act(card, b.dataset.act);
  });
  document.addEventListener('click', (e) => {
    if (e.target.closest('.menu')) return;
    document.querySelectorAll('#tunnelList .menu-pop').forEach((x) => x.classList.add('hidden'));
    document.querySelectorAll('#tunnelList [data-menu]').forEach((x) => x.setAttribute('aria-expanded', 'false'));
  });

  refresh();
  focusExit();
  cfpEvery(5000, () => refresh(false));
  loadExitStats();
  cfpEvery(30000, () => loadExitStats());
  if ($('#btnExitStats')) $('#btnExitStats').addEventListener('click', () => loadExitStats().catch((e) => toast(e.message, 'err')));
  if ($('#exitStatsHours')) $('#exitStatsHours').addEventListener('change', () => loadExitStats().catch((e) => toast(e.message, 'err')));
});
})();
