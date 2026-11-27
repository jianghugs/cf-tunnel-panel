/* 设置页 */
'use strict';
(function () {

let ST = null;
let backups = [];
let page = 1;

function renderBackups() {
  const box = $('#backupList');
  const pages = pageCount(backups.length);
  if (page > pages) page = pages;
  const slice = backups.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  if (!backups.length) { box.innerHTML = '<div class="empty">还没有备份</div>'; return; }
  const REASON = {
    routes: '改了代理规则', settings: '改了设置', restore: '回滚过配置', viewer: '改了只读账号',
    'share-expire': '清理过期分享', import: '导入了配置', maintenance: '切换维护模式',
    'panel-auth': '改了面板登录', tunnel: '改了隧道出口', tunnels: '改了隧道出口',
    create: '新建出口', delete: '删除出口', start: '启动出口', stop: '停止出口', save: '保存',
  };
  const when = (f) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(f);
    if (!m) return esc(f);
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`);
    return `<span title="${esc(f)}">${d.toLocaleString('zh-CN', { hour12: false })}</span>`;
  };
  box.innerHTML = `<div class="tbl-wrap"><table class="stackable"><thead><tr><th>时间</th><th>为什么存了这一份</th><th></th></tr></thead><tbody>${slice.map((f) => {
    const m = /^(.+?)-([a-z-]+)\.json$/.exec(f) || [];
    const reason = m[2] || '';
    return `<tr><td class="mono" data-label="时间">${when(f)}</td><td data-label="原因"><span class="tag">${esc(REASON[reason] || reason || '保存')}</span></td>
      <td class="nowrap" data-label="操作"><button class="sm ghost" data-restore="${esc(f)}">回滚到这份</button>
        <a class="btn sm ghost" href="/api/backups/download?file=${encodeURIComponent(f)}" download="${esc(f)}">下载</a>
        <button class="sm ghost" data-diff="${esc(f)}">对比当前</button></td></tr>`;
  }).join('')}</tbody></table></div>${pagerHtml(page, pages, backups.length)}`;
  bindPager(box, (p) => { page = p; renderBackups(); });
}

async function showDiff(file) {
  const box = $('#diffOut');
  box.innerHTML = '<div class="hint">对比中…</div>';
  try {
    const d = await api('/api/backups/diff?a=' + encodeURIComponent(file));
    const part = (title, arr, fn) => (arr.length
      ? `<div style="margin-top:6px"><b>${title}（${arr.length}）</b><ul class="list">${arr.map((x) => `<li>${fn(x)}</li>`).join('')}</ul></div>`
      : '');
    const body = part('新增规则', d.added, (x) => `+ <code>${esc(x.path || '/')}</code> ${esc(x.name || '')}`)
      + part('删除规则', d.removed, (x) => `− <code>${esc(x.path || '/')}</code> ${esc(x.name || '')}`)
      + part('修改规则', d.changed, (x) => `<code>${esc(x.path || '/')}</code> ${esc(x.name || '')} —— 改了 ${x.fields.map((f) => `<code>${esc(f)}</code>`).join('、')}`);
    box.innerHTML = body
      ? `<div class="hint"><b>${esc(d.against)}</b> 与本机当前配置对比（${d.backupRoutes} → ${d.currentRoutes} 条）${body}</div>`
      : `<div class="hint ok-hint"><b>${esc(d.against)}</b> 和当前配置完全一致（${d.currentRoutes} 条规则）</div>`;
  } catch (e) {
    box.innerHTML = `<div class="hint err">对比失败：${esc(e.message)}</div>`;
  }
}

async function loadBackups() {
  try {
    const d = await api('/api/backups');
    backups = d.files || [];
    page = 1;
    renderBackups();
  } catch (e) {
    $('#backupList').innerHTML = `<div class="hint err">${esc(e.message)}</div>`;
  }
}

const NOTIFY_STATUS = { ok: ['已发送', 'ok'], fail: ['发送失败', 'err'], skipped: ['被拦下', 'warn'], error: ['发送失败', 'err'] };

async function loadNotifyHist() {
  const box = $('#notifyHist');
  try {
    const d = await api('/api/notify/history');
    const items = d.items || [];
    box.innerHTML = items.length
      ? `<div class="tbl-wrap"><table class="stackable"><thead><tr><th>时间</th><th>事件</th><th>标题</th><th>结果</th><th>详情</th><th>操作</th></tr></thead><tbody>${items.map((it) => {
        const st = NOTIFY_STATUS[it.status] || [it.status || '—', ''];
        return `<tr><td class="mono" data-label="时间">${new Date(it.t).toLocaleTimeString('zh-CN', { hour12: false })}</td>
          <td data-label="事件"><span class="mono">${esc(it.event)}</span></td>
          <td data-label="标题">${esc(it.title || '')}</td>
          <td data-label="结果"><span class="tag ${st[1]}">${esc(st[0])}</span></td>
          <td class="muted" data-label="详情">${esc(it.extra || '')}</td>
          <td data-label="操作"><button class="mini" data-resend="${it.seq || ''}">重发</button></td></tr>`;
      }).join('')}</tbody></table></div>`
      : '<div class="empty">还没有发过通知（配置 webhook 后，掉线/换域名会走这里）</div>';
    box.querySelectorAll('[data-resend]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true; b.textContent = '发送中…';
      try { await api('/api/notify/resend', { method: 'POST', body: { seq: Number(b.dataset.resend) || 0 } }); b.textContent = '已重发'; await loadNotifyHist(); }
      catch (e) { b.disabled = false; b.textContent = '重发'; alert('重发失败：' + e.message); }
    }));
  } catch (e) {
    box.innerHTML = `<div class="hint err">${esc(e.message)}</div>`;
  }
}

async function loadSystem() {
  const box = $('#sysInfo');
  try {
    const d = await api('/api/system');
    const kb = (n) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');
    const dur = (s) => {
      s = Math.round(s);
      const d2 = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m2 = Math.floor((s % 3600) / 60);
      return d2 ? `${d2} 天 ${h} 小时` : h ? `${h} 小时 ${m2} 分` : `${m2} 分钟`;
    };
    const prAll = d.panelRequests || {};
    const pr = prAll.byStatus || {};   // 2xx/3xx/… 在 byStatus 里，total 在顶层
    box.innerHTML = `<table><tbody>
      <tr><td class="muted">面板版本</td><td class="mono">v${esc(d.version)}</td></tr>
      <tr><td class="muted">Node / 平台</td><td class="mono">${esc(d.node)} · ${esc(d.platform || '')}</td></tr>
      <tr><td class="muted">已运行</td><td>${dur(d.uptimeSec)}</td></tr>
      <tr><td class="muted">数据目录</td><td class="mono">${esc(d.dataDir)}</td></tr>
      <tr><td class="muted">state.json</td><td>${kb(d.stateBytes)}</td></tr>
      <tr><td class="muted">备份份数</td><td>${d.backupCount} 份（上限 20）</td></tr>
      <tr><td class="muted">面板日志缓存</td><td>${kb(d.logBytes)}</td></tr>
      <tr><td class="muted">Caddy 访问日志</td><td>${kb(d.caddyLogBytes)}（Caddy 侧 10MB × 3 份自动轮转）</td></tr>
      <tr><td class="muted">内存占用</td><td>${d.memMB} MB</td></tr>
      <tr><td class="muted">主机</td><td class="mono">${esc(d.host)}</td></tr>
      <tr><td class="muted">面板请求</td><td class="mono">${prAll.total || 0} 次（2xx ${pr['2xx'] || 0} · 3xx ${pr['3xx'] || 0} · 4xx ${pr['4xx'] || 0} · 5xx ${pr['5xx'] || 0}）</td></tr>
      <tr><td class="muted">历史采样</td><td class="mono">${(d.history && d.history.samples) || 0} 点 · 通知 ${(d.history && d.history.notifies) || 0} 条（两台共享）</td></tr>
      <tr><td class="muted">体检留痕</td><td class="mono" id="aboutSelfcheck">读取中…</td></tr>
      <tr><td class="muted">最热的面板路径</td><td class="mono">${(d.panelRequests && d.panelRequests.top || []).slice(0, 3).map((x) => esc(x.path) + ' ×' + x.count).join('　') || '—'}</td></tr>
    </tbody></table>`;
    // 单独取一次留痕概况：不塞进 /api/about，免得这个接口为了两行字去读文件
    api('/api/selfcheck/history?limit=1').then((h) => {
      const cell = $('#aboutSelfcheck');
      if (!cell || !h || !h.store) return;
      const kb = (n) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');
      const age = h.store.oldestAt ? Math.max(0, Math.round((Date.now() - h.store.oldestAt) / 36e5 * 10) / 10) : 0;
      cell.textContent = `${h.store.count} 条 / ${kb(h.store.bytes)}（上限 ${h.store.keep} 条 / ${Math.round(h.store.maxBytes / 1024)} KB）`
        + (age ? `，最早一条 ${age} 小时前` : '');
    }).catch(() => { const c2 = $('#aboutSelfcheck'); if (c2) c2.textContent = '读取失败'; });
  } catch (e) {
    box.innerHTML = `<div class="hint err">${esc(e.message)}</div>`;
  }
}

const NOTIFY_FMT = {
  generic: {
    label: 'Webhook 地址', ph: 'https://example.com/hook', secret: false,
    hint: '会 POST 一个 JSON：{title, text, event, ts, host}。任何能收 JSON 的服务都行（自建接收端、n8n、Node-RED…）。',
  },
  dingtalk: {
    label: '钉钉机器人 Webhook', ph: 'https://oapi.dingtalk.com/robot/send?access_token=…', secret: true,
    hint: '群 → 群设置 → 智能群助手 → 添加机器人 → 自定义。安全设置勾了「加签」就把 SEC 开头的密钥填到上面；只勾「自定义关键词」则留空密钥，但要保证关键词出现在「面板」「掉线」「失败」里任一个（消息标题会带上）。',
  },
  feishu: {
    label: '飞书机器人 Webhook', ph: 'https://open.feishu.cn/open-apis/bot/v2/hook/…', secret: true,
    hint: '群 → 设置 → 群机器人 → 添加 → 自定义机器人。开了「签名校验」就把密钥填到上面。',
  },
  bark: {
    label: 'Bark 推送地址', ph: 'https://api.day.app/你的Key', secret: false,
    hint: '在 Bark App 里复制推送地址，末尾不要带斜杠；面板会自动拼成 /标题/正文。自建服务器就填你的域名/Key。',
  },
};

function bindHook() {
  const btn = $('#btnHookToken');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    try {
      const d = await api('/api/alerts/hook-token');
      $('#alertHook').value = d.token;
      $('#hookMsg').textContent = '本机回调地址：' + d.localUrl;
    } catch (e) { toast(e.message, 'err'); }
  });
  const cp = $('#btnHookCopy');
  if (cp) cp.addEventListener('click', () => {
    const v = $('#alertHook').value;
    if (!v) { toast('先点「生成 / 查看」', 'warn'); return; }
    copyText(v);
  });
}

function fillMonitoring() {
  const mon = (ST.state.settings || {}).monitoring || {};
  if ($('#monProm')) $('#monProm').value = mon.promUrl || '';
}

function fillGrafana() {
  const g = (ST && ST.state && ST.state.settings && ST.state.settings.grafana) || {};
  const set = (id, v) => { const el = $(id); if (el) el.value = v == null ? '' : String(v); };
  const chk = (id, v) => { const el = $(id); if (el) el.checked = !!v; };
  chk('#grafEnabled', g.enabled);
  set('#grafUrl', g.url || '');
  set('#grafLan', g.lanUrl || '');
  set('#grafDash', g.dashboard || '');
  const th = $('#grafTheme');
  if (th) th.value = g.theme || '';
  const panels = g.panels || [];
  for (const i of [1, 2, 3]) {
    const p = panels[i - 1] || {};
    set('#grafPid' + i, p.panelId || '');
    set('#grafTitle' + i, p.title || '');
    set('#grafH' + i, p.h || '');
  }
  syncGrafanaOpen();
}

/** 把「在 Grafana 打开」的链接跟着输入实时拼出来（省得用户自己算 uid/slug） */
function syncGrafanaOpen() {
  const a = $('#btnGrafTest');
  if (!a) return;
  const url = (($('#grafUrl') || {}).value || '').trim().replace(/\/+$/, '');
  const dash = ((($('#grafDash') || {}).value || '').trim().replace(/^\/+|\/+$/g, '')).split('/');
  if (!url || !dash[0]) { a.removeAttribute('href'); a.style.opacity = 0.5; return; }
  a.style.opacity = 1;
  a.href = `${url}/d/${encodeURIComponent(dash[0])}/${encodeURIComponent(dash[1] || dash[0])}`;
}

/* ---- 通知通道表：多通道，各自独立启停/测试 ---- */
let chanKey = 0;
function chanRow(c) {
  const id = c.id || 'n' + (++chanKey);
  const fmt = c.format || 'generic';
  const need = (NOTIFY_FMT[fmt] || NOTIFY_FMT.generic).secret;
  return `<tr data-cid="${esc(id)}">
    <td data-label="名称"><input data-k="name" value="${esc(c.name || '')}" placeholder="例如：飞书群" /></td>
    <td data-label="格式"><select data-k="format">${Object.keys(NOTIFY_FMT).map((k) => `<option value="${k}"${k === fmt ? ' selected' : ''}>${esc(NOTIFY_FMT[k].label)}</option>`).join('')}</select></td>
    <td data-label="地址"><input data-k="url" value="" placeholder="${esc(c.hasUrl ? '已配置（留空不改）' : (NOTIFY_FMT[fmt] || NOTIFY_FMT.generic).ph)}" /></td>
    <td data-label="密钥"><input data-k="secret" type="password" value="" placeholder="${esc(c.hasSecret ? '已配置（留空不改）' : (need ? '有加签才需要' : '不需要'))}" ${need ? '' : 'disabled'} />
      ${c.hasSecret ? '<button class="sm ghost" data-clear="1" title="清空这条通道的密钥">清空</button>' : ''}</td>
    <td data-label="启用"><input class="chk" data-k="enabled" type="checkbox" ${c.enabled === false ? '' : 'checked'} /></td>
    <td data-label="操作" class="nowrap"><button class="sm ghost" data-test="1">测试</button> <button class="sm danger" data-del="1">删除</button></td>
  </tr>`;
}

function renderChannels(list) {
  const body = $('#chanBody');
  if (!body) return;
  chanKey = 0;
  const rows = (list && list.length) ? list : [];
  body.innerHTML = rows.length ? rows.map(chanRow).join('')
    : '<tr><td colspan="6" class="empty">还没有通道 —— 点下面「添加通道」（飞书 / 钉钉 / Bark / 通用 Webhook 都行）</td></tr>';
  if ($('#notifyHint')) {
    $('#notifyHint').textContent = rows.length
      ? '同一条通知会发到所有「启用」的通道；格式决定 payload 长相，填错地址保存时会被挡下。'
      : '没有通道时不会发任何通知。';
  }
}

function collectChannels() {
  const out = [];
  document.querySelectorAll('#chanBody tr[data-cid]').forEach((tr, i) => {
    const q = (k) => tr.querySelector(`[data-k="${k}"]`);
    const clearBtn = tr.querySelector('[data-clear="1"]');
    const c = {
      id: tr.dataset.cid || `n${i + 1}`,
      name: (q('name').value || '').trim() || `通道 ${i + 1}`,
      format: q('format').value,
      url: (q('url').value || '').trim(),
      secret: (q('secret').value || '').trim(),
      enabled: q('enabled').checked,
    };
    if (clearBtn && clearBtn.dataset.cleared === '1') c.clearSecret = true;
    out.push(c);
  });
  return out;
}

function fillNotifyChannels() {
  const n = (ST.state.settings || {}).notify || {};
  renderChannels(n.channels || []);
}

function fill() {
  const s = ST.state.settings || {};
  $('#panelTitle').value = s.panelTitle || '';
  $('#caddyListen').value = s.caddyListen || ':8080';
  $('#notFoundBody').value = s.notFoundBody || '';
  const m = s.maintenance || {};
  $('#maintOn').checked = !!m.on;
  $('#maintBody').value = m.body || '';
  $('#maintRetry').value = m.retryAfter || 300;
  const sec = s.security || {};
  $('#ipDeny').value = sec.ipDeny || '';
  const rl = sec.rateLimit || {};
  $('#rlOn').checked = !!rl.enabled;
  $('#rlRps').value = rl.rps || 20;
  $('#rlBurst').value = rl.burst || 40;
  const n = s.notify || {};
  $('#evDown').checked = !!(n.events && n.events.tunnelDown);
  $('#evUrl').checked = !!(n.events && n.events.urlChange);
  $('#evCaddy').checked = !!(n.events && n.events.caddyFail);
  if ($('#evSessionIp')) $('#evSessionIp').checked = !!(n.events && n.events.sessionIp);

  if ($('#evTunnelUp')) $('#evTunnelUp').checked = !(n.events && n.events.tunnelUp === false);
  if ($('#evErrorSpike')) $('#evErrorSpike').checked = !!(n.events && n.events.errorSpike);
  if ($('#evLoginFail')) $('#evLoginFail').checked = !!(n.events && n.events.loginFail);
  if ($('#evAuthScan')) $('#evAuthScan').checked = !!(n.events && n.events.authScan);
  $('#notifyCool').value = n.cooldownSec === undefined ? 300 : n.cooldownSec;
  $('#notifyQuiet').value = n.quietHours || '';
  const tpl = n.template || {};
  if ($('#notifyTplTitle')) $('#notifyTplTitle').value = tpl.title || '';
  if ($('#notifyTplText')) $('#notifyTplText').value = tpl.text || '';
  $('#panelUser').value = (ST.state.panel && ST.state.panel.user) || '';
  $('#verTag').textContent = '版本 ' + (ST.version || '—');
  fillNotifyChannels();
  fillMonitoring();
  fillGrafana();
}

async function save() {
  const body = {
    panelTitle: $('#panelTitle').value.trim(),
    caddyListen: $('#caddyListen').value.trim(),
    notFoundBody: $('#notFoundBody').value,
    maintenance: { on: $('#maintOn').checked, body: $('#maintBody').value, retryAfter: Number($('#maintRetry').value) || 300 },
    security: {
      ipDeny: $('#ipDeny').value.trim(),
      rateLimit: { enabled: $('#rlOn').checked, rps: Number($('#rlRps').value) || 20, burst: Number($('#rlBurst').value) || 40 },
    },
    notify: {
      channels: collectChannels(),
      events: { tunnelDown: $('#evDown').checked, urlChange: $('#evUrl').checked, caddyFail: $('#evCaddy').checked, sessionIp: $('#evSessionIp') ? $('#evSessionIp').checked : true,
        tunnelUp: $('#evTunnelUp') ? $('#evTunnelUp').checked : true,
        errorSpike: $('#evErrorSpike') ? $('#evErrorSpike').checked : true,
        authScan: $('#evAuthScan') ? $('#evAuthScan').checked : true,
        loginFail: $('#evLoginFail') ? $('#evLoginFail').checked : true },
      cooldownSec: Number($('#notifyCool').value) || 0,
      quietHours: $('#notifyQuiet').value.trim(),
      template: {
        title: ($('#notifyTplTitle') && $('#notifyTplTitle').value.trim()) || '',
        text: ($('#notifyTplText') && $('#notifyTplText').value.trim()) || '',
      },
    },
  };
  const gpanels = [];
  for (const i of [1, 2, 3]) {
    const pid = Number(($('#grafPid' + i) || {}).value || 0);
    if (!pid) continue;
    gpanels.push({
      panelId: Math.round(pid),
      title: (($('#grafTitle' + i) || {}).value || '').trim(),
      h: Number(($('#grafH' + i) || {}).value || 220) || 220,
    });
  }
  body.grafana = {
    enabled: $('#grafEnabled') ? $('#grafEnabled').checked : false,
    url: (($('#grafUrl') || {}).value || '').trim(),
    lanUrl: (($('#grafLan') || {}).value || '').trim(),
    dashboard: (($('#grafDash') || {}).value || '').trim(),
    theme: (($('#grafTheme') || {}).value || ''),
    panels: gpanels,
  };
  try {
    const r = await api('/api/settings', { method: 'POST', body });
    const warn = (r && Array.isArray(r.warnings)) ? r.warnings : [];
    if (warn.length) toast('设置已保存，但有 ' + warn.length + ' 项没生效：' + warn[0], 'warn', 8000);
    else toast('设置已保存并下发', 'ok');
    const d = await loadState();
    ST = d;
    fill();
    if (window.__cfpSetUnsaved) window.__cfpSetUnsaved('settings', false);
    loadBackups();
  } catch (e) {
    toast('保存失败：' + e.message, 'err');
  }
}


/* ---------------- 登录会话 ---------------- */
async function loadSessions() {
  const tb = document.querySelector('#sessTable tbody');
  if (!tb) return;
  try {
    const d = await api('/api/sessions');
    const rows = d.sessions || [];
    tb.innerHTML = rows.length ? rows.map((x) => `<tr>
        <td data-label="账号">${esc(x.user)}${x.current ? ' <span class="tag ok">当前</span>' : ''}</td>
        <td data-label="角色">${x.role === 'viewer' ? '只读' : '管理员'}</td>
        <td data-label="来源 IP"><span class="mono">${esc(x.ip || '-')}</span>${x.ipChangedAt ? ` <span class="tag err" title="原来是 ${esc(x.prevIp || '?')}，${fmtTime(x.ipChangedAt)} 变过来">换过 IP</span>` : ''}</td>
        <td data-label="设备"><span class="muted" style="font-size:12px">${esc(String(x.ua || '-').slice(0, 48))}</span></td>
        <td data-label="登录时间">${fmtTime(x.createdAt)}</td>
        <td data-label="最后活动">${fmtTime(x.lastSeenAt)}</td>
        <td data-label=""><button class="sm ghost" data-kick="${esc(x.id)}">踢掉</button></td>
      </tr>`).join('') : '<tr><td colspan="7" class="muted">没有活动中的会话（可能是用 Basic 认证或脚本访问）</td></tr>';
  } catch (e) {
    tb.innerHTML = `<tr><td colspan="7" class="hint err">${esc(e.message)}</td></tr>`;
  }
}

function bindSessions() {
  const tb = document.querySelector('#sessTable tbody');
  if (tb) tb.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-kick]');
    if (!b) return;
    if (!confirm('踢掉这个会话？那台设备需要重新登录。')) return;
    try {
      const d = await api('/api/sessions/revoke', { method: 'POST', body: { id: b.dataset.kick } });
      if (d.self) { location.href = '/login'; return; }
      toast('已踢掉');
      loadSessions();
  bindHook();
    } catch (x) { toast(x.message, 'err'); }
  });
  const r = document.querySelector('#btnSessRefresh'); if (r) r.addEventListener('click', loadSessions);
  const all = document.querySelector('#btnSessRevokeAll');
  if (all) all.addEventListener('click', async () => {
    if (!confirm('退出全部设备？包括你现在这台，之后所有人都要重新登录。')) return;
    try { const d = await api('/api/sessions/revoke-all', { method: 'POST' }); toast(`已退出 ${d.revoked} 个会话，正在跳转登录…`); setTimeout(() => { location.href = '/login'; }, 700); }
    catch (x) { toast(x.message, 'err'); }
  });
  const k = document.querySelector('#btnSessKickOthers');
  if (k) k.addEventListener('click', async () => {
    if (!confirm('把除当前设备以外所有登录都踢掉？')) return;
    try { const d = await api('/api/sessions/revoke-others', { method: 'POST' }); toast(`已踢掉 ${d.revoked} 个会话`); loadSessions(); }
    catch (x) { toast(x.message, 'err'); }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  // 设置页：任何输入都标记「未保存」，保存成功后清掉
  document.addEventListener('input', (e) => {
    if (e.target.closest && e.target.closest('#settingsForm, .card') && e.target.matches('input,select,textarea')) {
      if (window.__cfpSetUnsaved) window.__cfpSetUnsaved('settings', true);
    }
  });
  $('#btnSave').addEventListener('click', save);
  if ($('#btnSave2')) $('#btnSave2').addEventListener('click', save);
  for (const id of ['#grafUrl', '#grafDash']) {
    const el = $(id);
    if (el) el.addEventListener('input', () => { syncGrafanaOpen(); if (window.__cfpSetUnsaved) window.__cfpSetUnsaved('settings', true); });
  }
  $('#btnBackupRefresh').addEventListener('click', loadBackups);
  $('#backupList').addEventListener('click', async (e) => {
    const dbtn = e.target.closest('[data-diff]');
    if (dbtn) { showDiff(dbtn.dataset.diff); return; }
    const b = e.target.closest('[data-restore]');
    if (!b) return;
    if (!confirm('回滚到 ' + b.dataset.restore + ' ？当前配置会先自动备份一份。')) return;
    try {
      const d = await api('/api/backups/restore', { method: 'POST', body: { file: b.dataset.restore } });
      $('#diffOut').innerHTML = '';
      toast('已回滚，' + d.routeCount + ' 条规则' + (d.restarted.length ? '，重启出口：' + d.restarted.join('、') : ''), 'ok');
      ST = await loadState();
      fill();
      loadBackups();
    } catch (err) {
      toast('回滚失败：' + err.message, 'err');
    }
  });

  if ($('#btnChanAdd')) {
    $('#btnChanAdd').addEventListener('click', () => {
      const body = $('#chanBody');
      if (body.querySelector('.empty') || !body.querySelector('tr[data-cid]')) body.innerHTML = '';
      body.insertAdjacentHTML('beforeend', chanRow({ name: '', format: 'generic', enabled: true, hasUrl: false, hasSecret: false }));
      if ($('#chanMsg')) $('#chanMsg').textContent = '填好地址后点「保存设置」才会生效';
    });
  }
  if ($('#chanBody')) {
    $('#chanBody').addEventListener('click', async (e) => {
      const tr = e.target.closest('tr[data-cid]');
      if (!tr) return;
      if (e.target.closest('[data-del]')) { tr.remove(); if ($('#chanMsg')) $('#chanMsg').textContent = '已移除，记得保存'; return; }
      const clear = e.target.closest('[data-clear]');
      if (clear) {
        clear.dataset.cleared = clear.dataset.cleared === '1' ? '' : '1';
        clear.textContent = clear.dataset.cleared === '1' ? '将清空' : '清空';
        return;
      }
      if (e.target.closest('[data-test]')) {
        const id = tr.dataset.cid;
        e.target.disabled = true;
        try {
          // 先存盘再测：测试按钮用的是服务端已保存的地址
          await save();
          const d = await api('/api/notify/test', { method: 'POST', body: { channelId: id } });
          toast(d.ok ? '这条通道发送成功' : '发送失败，看通知记录里的原因', d.ok ? 'ok' : 'err');
          if ($('#chanMsg')) $('#chanMsg').textContent = d.ok ? '已发送' : '失败，见「通知记录」';
        } catch (err) { toast(err.message, 'err'); }
        e.target.disabled = false;
      }
    });
  }
  $('#btnNotifyClear').addEventListener('click', async () => {
    if (!confirm('清空所有通知通道？（关掉通知）')) return;
    try {
      await api('/api/settings', { method: 'POST', body: { notify: { channels: [], clearUrl: true, clearSecret: true } } });
      $('#notifyMsg').textContent = '已清空';
      ST = await loadState();
      fill();
    } catch (e) { $('#notifyMsg').textContent = e.message; }
  });

  $('#btnNotifyTest').addEventListener('click', async () => {
    $('#notifyMsg').textContent = '发送中…';
    try {
      const d = await api('/api/notify/test', { method: 'POST' });
      $('#notifyMsg').textContent = d.ok ? '已发送' : '失败（先填 Webhook 地址并保存）';
    } catch (e) {
      $('#notifyMsg').textContent = e.message;
    }
  });

  $('#btnPanelAuth').addEventListener('click', async () => {
    const user = $('#panelUser').value.trim();
    const pass = $('#panelPass').value;
    if (user && !pass) { $('#authMsg').textContent = '要设用户名就得一起填密码'; return; }
    try {
      const d = await api('/api/panel-auth', { method: 'POST', body: { user, pass } });
      $('#panelPass').value = '';
      if (d.relogin) {
        $('#authMsg').textContent = '口令已更新，所有登录已失效，正在跳转登录页…';
        toast(`口令已更新，已踢掉 ${d.revoked} 个会话`, 'ok');
        setTimeout(() => { location.href = '/login'; }, 900);
        return;
      }
      $('#authMsg').textContent = d.authEnabled ? '已开启登录（刷新后浏览器会要密码）' : '已关闭登录';
      toast(d.authEnabled ? '已开启面板登录' : '已关闭面板登录', 'ok');
    } catch (e) {
      $('#authMsg').textContent = e.message;
    }
  });

  $('#btnViewer').addEventListener('click', async () => {
    const user = $('#viewerUser').value.trim();
    const pass = $('#viewerPass').value;
    try {
      const d = await api('/api/viewer', { method: 'POST', body: { user, pass } });
      $('#viewerPass').value = '';
      $('#viewerMsg').textContent = d.viewer.user ? `只读账号 ${d.viewer.user} 已生效${d.relogin ? '（旧会话已全部失效）' : ''}` : '已关闭只读账号';
      toast(d.viewer.user ? '只读账号已保存' : '只读账号已关闭', 'ok');
      loadNotifyHist();
    } catch (e) {
      $('#viewerMsg').textContent = e.message;
    }
  });

  $('#btnNotifyHist').addEventListener('click', loadNotifyHist);
  $('#btnSysRefresh').addEventListener('click', loadSystem);

  $('#btnExport').addEventListener('click', () => { location.href = '/api/export'; });
  $('#btnExportFull').addEventListener('click', () => {
    if (!confirm('含 token 的完整配置，注意别外传。继续？')) return;
    location.href = '/api/export?full=1';
  });
  $('#btnImport').addEventListener('click', () => $('#fileImport').click());
  $('#fileImport').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      const obj = JSON.parse(text);
      if (!confirm('导入会覆盖当前配置（并自动备份一份），继续？')) return;
      const d = await api('/api/import', { method: 'POST', body: obj });
      toast('已导入，' + d.routeCount + ' 条规则', 'ok');
      ST = await loadState();
      fill();
      loadBackups();
    } catch (err) {
      toast('导入失败：' + err.message, 'err');
    } finally {
      e.target.value = '';
    }
  });

  loadState().then((d) => {
    ST = d; fill();
    const v = (d.state.settings || {}).viewer || {};
    const tp = (S.settings && S.settings.totp) || {};
    const on = !!tp.enabled;
    const eOn = $('#totpOn'), eOff = $('#totpOff');
    if (eOn && eOff) { eOn.classList.toggle('hidden', !on); eOff.classList.toggle('hidden', on); }
    if ($('#totpLeft')) $('#totpLeft').textContent = on ? `剩余恢复码 ${tp.recoveryLeft || 0} 个` : '';
    const op = (S.settings && S.settings.operator) || {};
    if ($('#operUser')) { $('#operUser').value = op.user || ''; $('#operUser').placeholder = op.hasPass ? `当前运维账号：${op.user}` : '不填 = 不开启'; }
    $('#viewerUser').value = v.user || '';
    $('#viewerUser').placeholder = v.hasPass ? '当前只读账号：' + v.user : '不填 = 不开启只读账号';
  }).catch(() => {});
  loadBackups();
  loadNotifyHist();
  loadSystem();
  bindSessions();
  loadSessions();
  bindCfg();
  loadCfgSnaps();
});

// ---------- 配置即代码 ----------
let cfgSnaps = [];

function renderCfgDiff(d) {
  const box = $('#cfgDiff');
  if (!d) { box.innerHTML = ''; return; }
  const part = (label, list) => list.length
    ? `<div class="hint" style="margin:2px 0">${label}：${list.map((x) => `<code class="mono">${esc(x.kind)}/${esc(x.name || x.id)}</code>`).join('、')}</div>`
    : '';
  const changed = (d.changed || []).map((x) => `<tr><td class="mono">${esc(x.kind)}</td><td>${esc(x.name || x.id)}</td><td class="mono">${esc((x.fields || []).join(', '))}</td></tr>`).join('');
  box.innerHTML =
    `<div class="row" style="margin-top:6px"><span class="tag">+${(d.added || []).length}</span><span class="tag">-${(d.removed || []).length}</span><span class="tag">~${(d.changed || []).length}</span>${d.settingsChanged ? '<span class="tag warn">设置也变了</span>' : ''}</div>` +
    part('新增', d.added || []) + part('删除', d.removed || []) +
    (changed ? `<div class="tbl-wrap"><table class="stackable"><thead><tr><th>类型</th><th>名字</th><th>变了的字段</th></tr></thead><tbody>${changed}</tbody></table></div>` : '');
}

async function loadCfgSnaps() {
  try {
    const d = await api('/api/config/snapshots');
    cfgSnaps = d.items || [];
    $('#cfgSnapCount').textContent = String(cfgSnaps.length);
    $('#cfgSnaps').innerHTML = cfgSnaps.length
      ? `<table class="stackable"><thead><tr><th>时间</th><th>文件</th><th>大小</th><th>操作</th></tr></thead><tbody>${cfgSnaps.map((x) => `<tr><td class="mono">${esc(fmtTime(x.at))}</td><td class="mono">${esc(x.file)}</td><td class="mono">${kb(x.bytes)}</td><td><button class="mini" data-cfgsnap="${esc(x.file)}">填回编辑器</button></td></tr>`).join('')}</tbody></table>`
      : '<div class="empty">还没有快照（点「存一份快照」或应用一次配置）</div>';
  } catch (e) {
    $('#cfgSnaps').innerHTML = `<div class="hint">${esc(e.message)}</div>`;
  }
}

function bindCfg() {
  const msg = $('#cfgMsg');
  $('#btnCfgLoad').addEventListener('click', async () => {
    try {
      const d = await api('/api/config');
      $('#cfgText').value = JSON.stringify(d.config, null, 2);
      msg.textContent = '已载入当前声明';
    } catch (e) { msg.textContent = e.message; }
  });
  const readCfg = () => {
    try { return JSON.parse($('#cfgText').value || '{}'); } catch (e) { throw new Error('JSON 解析失败：' + e.message); }
  };
  $('#btnCfgDry').addEventListener('click', async () => {
    try {
      const cfg = readCfg();
      const d = await api('/api/config/apply', { method: 'POST', body: { config: cfg, dry: true } });
      renderCfgDiff(d.diff);
      msg.textContent = `预览：${d.routes} 条规则 / ${d.tunnels} 个出口${d.touchesTunnels ? '（会重启出口）' : ''}`;
    } catch (e) { msg.textContent = e.message; toast(e.message, 'err'); }
  });
  $('#btnCfgApply').addEventListener('click', async () => {
    let cfg;
    try { cfg = readCfg(); } catch (e) { msg.textContent = e.message; return; }
    const applyCfg = async (force) => {
      msg.textContent = '应用中…';
      return api('/api/config/apply', { method: 'POST', body: force ? { config: cfg, force: true } : { config: cfg } });
    };
    if (!confirm('用这份配置整份替换？routes 会全量替换，apply 前会自动存一份快照。')) return;
    try {
      let d;
      try {
        d = await applyCfg(false);
      } catch (e) {
        if (e.status === 409 && e.payload && e.payload.code === 'GUARD') {
          const list = (e.payload.issues || []).map((x, i) => `${i + 1}. ${x.reason}`).join('\n');
          if (!confirm(`这份配置有问题：\n\n${list}\n\n仍然要应用吗？`)) { msg.textContent = '已取消'; return; }
          d = await applyCfg(true);
        } else {
          throw e;
        }
      }
      renderCfgDiff(d.diff);
      msg.textContent = `已应用：${d.routes} 条规则 / ${d.tunnels} 个出口（快照 ${d.file}）`;
      toast('配置已应用', 'ok');
      loadCfgSnaps();
      if (typeof refresh === 'function') refresh();
    } catch (e) { msg.textContent = e.message; toast('应用失败：' + e.message, 'err'); }
  });
  $('#btnCfgSnap').addEventListener('click', async () => {
    try { const d = await api('/api/config/snapshot', { method: 'POST', body: {} }); msg.textContent = '已存快照 ' + d.file; loadCfgSnaps(); }
    catch (e) { msg.textContent = e.message; }
  });
  $('#btnCfgDrift').addEventListener('click', async () => {
    try {
      const d = await api('/api/config/drift');
      if (!d.hasBaseline) { msg.textContent = '还没有「应用过」的基线（应用一次配置后才有）'; renderCfgDiff(null); return; }
      renderCfgDiff(d.drift);
      const n = (d.drift.added || []).length + (d.drift.removed || []).length + (d.drift.changed || []).length;
      msg.textContent = n ? `相对上次应用有 ${n} 处差异（可能有人手改过面板）` : '与上次应用的声明一致';
    } catch (e) { msg.textContent = e.message; }
  });
  $('#cfgSnaps').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-cfgsnap]');
    if (!b) return;
    try {
      const d = await api('/api/config/snapshots');
      const row = (d.items || []).find((x) => x.file === b.dataset.cfgsnap);
      if (!row) throw new Error('这份快照不在了');
      const r = await api('/api/config/snapshot?file=' + encodeURIComponent(row.file));
      $('#cfgText').value = JSON.stringify(r.config, null, 2);
      msg.textContent = '已填入 ' + row.file + '（改完点「预览差异」再应用）';
    } catch (x) { toast(x.message, 'err'); }
  });
}

})();

// ---- 二次验证 TOTP ----
$('#btnTotpSetup').addEventListener('click', async () => {
  const b = $('#btnTotpSetup'); b.disabled = true;
  try {
    const d = await api('/api/totp/setup', { method: 'POST', body: {} });
    if (!d.ok) throw new Error(d.error || '生成失败');
    $('#totpSecret').value = d.secret;
    if (d.qr) $('#totpQr').src = d.qr;
    $('#totpBox').classList.remove('hidden');
    $('#totpCode').focus();
  } catch (e) { $('#totpMsg').textContent = '生成失败：' + e.message; }
  b.disabled = false;
});

$('#btnTotpEnable').addEventListener('click', async () => {
  const code = ($('#totpCode').value || '').trim();
  if (!/^\d{6}$/.test(code)) { $('#totpSetupMsg').textContent = '请输入 6 位数字'; return; }
  try {
    const d = await api('/api/totp/enable', { method: 'POST', body: { code } });
    if (!d.ok) throw new Error(d.error || '开启失败');
    $('#totpRecovery').textContent = (d.recoveryCodes || []).join('\n');
    $('#totpRecoveryBox').classList.remove('hidden');
    $('#totpSetupMsg').textContent = '已开启，下次登录需要验证码';
    toast('二次验证已开启', 'ok');
    await refresh();
  } catch (e) { $('#totpSetupMsg').textContent = e.message; }
});

$('#btnTotpRecovery').addEventListener('click', async () => {
  const code = ($('#totpRecoveryCode').value || '').trim();
  if (!code) { $('#totpRecoveryMsg').textContent = '要先输入当前验证码或一个旧恢复码'; return; }
  $('#totpRecoveryMsg').textContent = '生成中…';
  try {
    const r = await api('/api/totp/recovery', { method: 'POST', body: { code } });
    const box = $('#totpRecoveryNew');
    box.textContent = '新的恢复码（只显示这一次，请立刻抄下来）：\n\n' + (r.recovery || []).join('\n');
    box.classList.remove('hidden');
    $('#totpRecoveryCode').value = '';
    $('#totpRecoveryMsg').textContent = '已重新生成，旧恢复码全部作废';
    $('.hidden', '#totpRecoveryBox') && $('#totpRecoveryBox').classList.remove('hidden');
    $('#totpRecovery').textContent = (r.recovery || []).join('  ');
  } catch (e) { $('#totpRecoveryMsg').textContent = e.message; }
});

$('#btnTotpDisable').addEventListener('click', async () => {
  const code = ($('#totpDisableCode').value || '').trim();
  if (!code) { $('#totpDisableMsg').textContent = '要先输入一个验证码或恢复码'; return; }
  if (!confirm('确定关闭二次验证？关闭后只用口令就能登录。')) return;
  try {
    const d = await api('/api/totp/disable', { method: 'POST', body: { code } });
    if (!d.ok) throw new Error(d.error || '关闭失败');
    toast('二次验证已关闭', 'ok');
    $('#totpDisableCode').value = '';
    $('#totpBox').classList.add('hidden');
    await refresh();
  } catch (e) { $('#totpDisableMsg').textContent = e.message; }
});

// ---- 运维账号 ----
$('#btnOper').addEventListener('click', async () => {
  const user = ($('#operUser').value || '').trim();
  const pass = $('#operPass').value || '';
  if (user && !pass) { $('#operMsg').textContent = '首次设置运维账号要同时给密码'; return; }
  try {
    const d = await api('/api/operator', { method: 'POST', body: { user, pass } });
    if (!d.ok) throw new Error(d.error || '保存失败');
    $('#operPass').value = '';
    $('#operMsg').textContent = user ? '已保存（旧会话已全部失效）' : '已关闭运维账号';
    toast('运维账号已更新', 'ok');
    await refresh();
  } catch (e) { $('#operMsg').textContent = e.message; }
});

// 设置项搜索：按卡片标题 + 正文做包含匹配（不区分大小写），没命中的整张卡隐藏
function applyCardSearch() {
  const box = $('#cardSearch');
  if (!box) return;
  const q = (box.value || '').trim().toLowerCase();
  const cards = [...document.querySelectorAll('.card[id^="sec-"]')];
  let shown = 0;
  if (!q) {
    // 搜索清空：回到「当前分区」，不要把所有卡片都摊开
    showSection(currentSection(), { silent: true, noScroll: true });
    if ($('#searchHint')) $('#searchHint').textContent = '';
    return;
  }
  cards.forEach((c) => {
    const title = (c.querySelector('h2') || {}).textContent || '';
    const hit = (title + ' ' + (c.textContent || '')).toLowerCase().includes(q);
    c.hidden = false;                       // 搜索跨分区：先都放开
    c.classList.toggle('hidden', !hit);
    if (hit) shown += 1;
  });
  const chips = [...document.querySelectorAll('.subnav a')];
  chips.forEach((a) => {
    const id = (a.getAttribute('href') || '').slice(1);
    const card = document.getElementById(id);
    a.classList.toggle('hidden', !!(card && card.classList.contains('hidden')));
  });
  const hint = $('#searchHint');
  if (hint) hint.textContent = q ? `${shown} / ${cards.length} 个分区匹配` : '';
}

// ---- 分区切换（v0.29.22）----
// 15 张卡片连起来 6200px，滚到底要滑半天。这里把左侧导航当页签用：一次只显示一个分区，
// 搜索时例外（跨分区搜，匹配的都显示），清空搜索回到当前分区。卡片仍然都在 DOM 里，
// 只是用 hidden 属性控制显示 —— 这样"跳转锚点/表单校验/测试选择器"都不会受影响。
const SEC_KEY = 'cfp-settings-sec';
const secCards = () => [...document.querySelectorAll('.card[id^="sec-"]')];

function currentSection() {
  const h = (location.hash || '').replace('#', '');
  if (h) return h;
  try { return localStorage.getItem(SEC_KEY) || ''; } catch { return ''; }
}

function showSection(id, opts = {}) {
  const cards = secCards();
  if (!cards.length) return;
  const want = cards.some((c) => c.id === id) ? id : cards[0].id;
  cards.forEach((c) => { c.hidden = (c.id !== want); c.classList.remove('hidden'); });
  [...document.querySelectorAll('.subnav a')].forEach((a) => {
    const on = (a.getAttribute('href') || '') === '#' + want;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
  });
  if (!opts.silent) { try { localStorage.setItem(SEC_KEY, want); } catch {} }
  if (!opts.noScroll) window.scrollTo(0, 0);
}

document.addEventListener('DOMContentLoaded', () => {
  if (secCards().length) showSection(currentSection(), { silent: true, noScroll: true });
  [...document.querySelectorAll('.subnav a')].forEach((a) => {
    a.addEventListener('click', (e) => {
      const id = (a.getAttribute('href') || '').replace('#', '');
      if (!id) return;
      e.preventDefault();
      const box = $('#cardSearch');
      if (box && box.value.trim()) { box.value = ''; applyCardSearch(); }
      showSection(id);
      try { history.replaceState(null, '', '#' + id); } catch {}
    });
  });
  window.addEventListener('hashchange', () => showSection(currentSection()));
  const box = $('#cardSearch');
  if (box) box.addEventListener('input', applyCardSearch);
});

/* ---- 版本与回滚（v0.29.61）---- */
function verTime(ts) { try { return new Date(Number(ts) || 0).toLocaleString(); } catch { return '—'; } }
function verSize(n) { return n ? Math.round(Number(n) / 1048576) + ' MB' : '—'; }

function renderVersionRun(d) {
  const box = $('#verRun');
  if (!box) return;
  const p = d && d.pending;
  const r = d && d.lastRun;
  box.innerHTML = '';
  const add = (html) => { const row = document.createElement('div'); row.innerHTML = html; box.appendChild(row); };
  if (p && p.version) {
    add('<span class="tag warn">排队中</span> 目标 <b>' + p.version + '</b>（' + verTime(p.at)
      + '，由 ' + (p.by || '—') + ' 发起）—— 宿主机每分钟处理一次，最多等 1 分钟。');
  }
  if (r && r.version) {
    add('<span class="tag ' + (r.ok ? 'ok' : 'err') + '">上次回滚 ' + (r.ok ? '成功' : '失败') + '</span> 目标 <b>'
      + r.version + '</b> · 退出码 ' + r.exitCode + ' · 用时 ' + (r.seconds || '—') + 's · ' + verTime(r.finishedAt));
    if (Array.isArray(r.tail) && r.tail.length) {
      const pre = document.createElement('pre');
      pre.className = 'log collapsed';
      pre.style.marginTop = '8px';
      pre.textContent = r.tail.join('\n');
      box.appendChild(pre);
    }
  }
  if (!box.textContent.trim()) box.textContent = '还没有回滚记录。';
}

async function loadVersions() {
  const list = $('#verList');
  if (!list) return;
  let d;
  try { d = await api('/api/versions'); }
  catch (e) { list.innerHTML = '<div class="hint err">读不到版本信息：' + (e.message || e) + '</div>'; return; }
  const cur = d.current || '';
  if ($('#verCur')) $('#verCur').textContent = '当前 ' + (cur || '—');
  const imgs = d.images || [];
  if ($('#verAvail')) {
    $('#verAvail').textContent = d.available === false ? ('读不到 Docker：' + (d.error || '')) : (imgs.length + ' 个版本');
  }
  if (!imgs.length) {
    list.innerHTML = '<div class="empty">没有找到 cf-tunnel-panel 的版本镜像</div>';
  } else {
    const rows = imgs.map((x) => {
      const isCur = x.tag === cur ? ' <span class="tag ok">当前</span>' : '';
      return '<tr><td class="mono">' + x.tag + isCur + '</td><td>' + verTime(x.created) + '</td><td>' + verSize(x.size)
        + '</td><td class="mono muted">' + (x.id || '') + '</td><td><button class="sm ghost" data-pick="' + x.tag + '">选它</button></td></tr>';
    }).join('');
    list.innerHTML = '<table class="tbl"><thead><tr><th>版本</th><th>构建时间</th><th>大小</th><th>镜像</th><th></th></tr></thead><tbody>'
      + rows + '</tbody></table>';
    list.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
      const inp = $('#verInput');
      if (inp) { inp.value = b.dataset.pick; inp.focus(); }
      const msg = $('#verMsg');
      if (msg) { msg.textContent = '再点一次「回滚到这个版本」确认'; msg.className = 'muted'; }
    }));
  }
  renderVersionRun(d);
  if (d.pending && d.pending.version) setTimeout(loadVersions, 5000);
}

async function doRollback() {
  const inp = $('#verInput');
  const msg = $('#verMsg');
  const v = ((inp && inp.value) || '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(v)) {
    if (msg) { msg.textContent = '版本号要写成 0.29.58 这种三段式'; msg.className = 'muted err'; }
    return;
  }
  const cur = (($('#verCur') && $('#verCur').textContent) || '').replace('当前 ', '').trim();
  if (v === cur) {
    if (msg) { msg.textContent = '当前已经是 ' + v + ' 了'; msg.className = 'muted err'; }
    return;
  }
  if (!window.confirm('确认把面板回滚到 ' + v + '？\n\n容器会重建，15–30 秒内不可用；当前版本 ' + cur + ' 的镜像还留着，随时可以改回去。')) return;
  const btn = $('#btnRollback');
  if (btn) btn.disabled = true;
  try {
    const r = await api('/api/versions/rollback', { method: 'POST', body: { version: v, confirm: v } });
    if (msg) { msg.textContent = '已排队，宿主机每分钟处理一次…'; msg.className = 'muted'; }
    toast('回滚请求已排队：' + (r.version || v), 'ok');
    if (inp) inp.value = '';
    await loadVersions();
  } catch (e) {
    if (msg) { msg.textContent = e.message || String(e); msg.className = 'muted err'; }
    toast(e.message || '回滚请求失败', 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  if (!$('#sec-version')) return;
  const rf = $('#btnVerRefresh');
  if (rf) rf.addEventListener('click', loadVersions);
  const rb = $('#btnRollback');
  if (rb) rb.addEventListener('click', doRollback);
  loadVersions();
});
