/* 工具箱页 */
'use strict';
(function () {

let ST = null;

async function loadDocker() {
  const box = $('#dockerBody');
  box.innerHTML = '<div class="empty">读取中…</div>';
  try {
    const d = await api('/api/docker/containers');
    if (!d.available) {
      box.innerHTML = `<div class="empty empty-act">
          <div class="t">读不到 Docker</div>
          <div class="hint">${esc(d.error || d.note || '面板容器连不上 Docker，所以看不到本机容器。')}</div>
          <div class="sub">挂载是 <span class="mono">/var/run/docker.sock:/var/run/docker.sock:ro</span>，权限靠 <span class="mono">group_add</span> 补上宿主 docker 组 gid；改完要滚动升级一次才生效，不修也不影响其它功能。</div>
          <button class="sm ghost" data-dockretry="1">重试</button>
        </div>`;
      const rb2 = box.querySelector('[data-dockretry]');
      if (rb2) rb2.addEventListener('click', () => loadDocker());
      return;
    }
    const rows = (d.containers || []).map((c) => `<tr>
        <td><span class="mono">${esc(c.name)}</span><div class="muted" style="font-size:11px">${esc(c.image)}</div></td>
        <td class="mono muted">${esc(c.ports || '—')}</td>
        <td class="mono">${esc(c.upstream || '—')}</td>
        <td class="nowrap">${c.upstream ? `<button class="sm ghost" data-dock="${esc(c.upstream)}">加规则</button>` : '<span class="muted">无可用端口</span>'}</td>
      </tr>`).join('');
    box.innerHTML = `<div class="tbl-wrap"><table><thead><tr><th>容器</th><th>端口</th><th>建议上游</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  } catch (e) {
    box.innerHTML = `<div class="hint err">${esc(e.message)}</div>`;
  }
}

function fmtLeft(sec) {
  if (sec <= 0) return '已过期';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s2 = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `剩余 ${h}:${p(m)}:${p(s2)}` : `剩余 ${m}:${p(s2)}`;
}
setInterval(() => {
  const now = Date.now();
  document.querySelectorAll('[data-countdown]').forEach((el) => {
    el.textContent = fmtLeft(Math.max(0, Math.round((Number(el.dataset.countdown) - now) / 1000)));
  });
}, 1000);

async function loadShares() {
  const box = $('#shareList');
  try {
    const d = await api('/api/shares');
    const list = d.shares || [];
    if (!list.length) {
      box.innerHTML = `<div class="empty empty-act">
          <div class="t">还没有分享链接</div>
          <div class="hint">填好上面三项点「生成链接」，会得到一个带 token 的临时地址。到期会自动从 Caddy 摘掉，不用手动删。</div>
        </div>`;
      return;
    }
    box.innerHTML = list.map((s) => `<div class="share-item">
        <div class="share-qrw">
          ${s.qr ? `<img class="share-qr" src="${esc(s.qr)}" alt="二维码">` : `<div class="share-qr share-qr-none">QR</div>`}
          <button class="primary sm share-copy" data-copy="${esc(s.url)}">复制链接</button>
        </div>
        <div class="grow">
          <div><strong>${esc(s.name)}</strong> <span class="tag">${esc(s.upstream)}</span></div>
          <div class="mono share-url">${esc(s.url)}</div>
          <div class="muted share-cd" data-countdown="${s.expiresAt}">${fmtLeft(s.leftSec)}</div>
        </div>
        <div class="row share-ops">
          <button class="sm ghost" data-copy="${esc(s.url)}">复制</button>
          <button class="sm danger" data-del="${esc(s.id)}">删除</button>
        </div>
      </div>`).join('');
  } catch (e) {
    box.innerHTML = `<div class="hint err">${esc(e.message)}</div>`;
  }
}

async function loadCf() {
  const box = $('#cfList');
  $('#cfMsg').textContent = '';
  try {
    const d = await api('/api/cf/tunnels');
    const list = d.tunnels || [];
    box.innerHTML = list.length
      ? `<div class="tbl-wrap"><table><thead><tr><th>名字</th><th>状态</th><th>连接</th><th>ID</th><th>操作</th></tr></thead><tbody>${list.map((t) => `<tr>
          <td>${esc(t.name)}</td>
          <td>${t.status ? `<span class="tag ${t.status === 'healthy' ? 'ok' : t.status === 'down' ? 'err' : ''}">${esc(t.status)}</span>` : '—'}</td>
          <td>${t.connections ? `<span class="tag">${t.connections} 条</span>` : '<span class="muted">0（没跑 connector）</span>'}</td>
          <td class="mono muted" style="font-size:11px">${esc(t.id)}</td>
          <td><button class="mini" data-cfhost="${esc(t.id)}">主机名</button> <button class="mini" data-cfget="${esc(t.id)}">复制 token</button> <button class="mini" data-cfdel="${esc(t.id)}">删除</button></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">云端还没有隧道</div>';
    const sel = $('#cfDnsTunnel');
    if (sel) {
      const keep = sel.value;
      sel.innerHTML = '<option value="">最近创建的那条</option>' +
        list.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}（${esc(String(t.id).slice(0, 8))}…）</option>`).join('');
      if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
    }
  } catch (e) {
    box.innerHTML = `<div class="hint warn">${esc(e.message)}</div>`;
  }
}

async function saveCf() {
  const body = { cf: { accountId: $('#cfAccount').value.trim(), zoneId: $('#cfZone').value.trim() } };
  const tk = $('#cfToken').value.trim();
  if (tk) body.cf.token = tk;
  try {
    await api('/api/settings', { method: 'POST', body });
    $('#cfToken').value = '';
    $('#cfMsg').textContent = '已保存';
    toast('Cloudflare API 配置已保存', 'ok');
  } catch (e) {
    $('#cfMsg').textContent = e.message;
    toast('保存失败：' + e.message, 'err');
  }
}

// ---- 域名体检
const DIAG_TAG = { ok: ['ok', '正常'], warn: ['warn', '注意'], fail: ['err', '失败'], skip: ['', '跳过'] };
function diagRow(s) {
  const t = DIAG_TAG[s.status] || ['', s.status || ''];
  const tag = t[0] ? `<span class="tag ${t[0]}">${t[1]}</span>` : `<span class="tag">${t[1]}</span>`;
  const ms = s.ms != null ? `<span class="diag-ms">${s.ms}ms</span>` : '';
  return `<div class="diag-row">${tag}<b>${esc(s.name || '')}</b><span class="diag-detail">${esc(s.detail || '')}</span>${ms}</div>`;
}

async function runDiag() {
  const out = $('#diagOut');
  if (!out) return;
  const host = ($('#diagHost').value || '').trim();
  const path = ($('#diagPath').value || '/').trim() || '/';
  if (!host) { toast('先填个域名，比如 demo.jianghugs.shop', 'warn'); $('#diagHost').focus(); return; }
  const pub = $('#diagPublic').checked ? '&public=1' : '';
  out.innerHTML = '<div class="hint">正在体检…</div>';
  try {
    const q = '/api/diag?host=' + encodeURIComponent(host) + '&path=' + encodeURIComponent(path) + pub;
    const d = await api(q);
    if (!d.ok) { out.innerHTML = `<div class="hint err">${esc(d.error || '体检失败')}</div>`; return; }
    const v = d.verdict || {};
    const icon = v.level === 'ok' ? '✅' : v.level === 'warn' ? '⚠️' : '❌';
    out.innerHTML = `<div class="diag-verdict ${esc(v.level || '')}">${icon} <b>${esc(v.at || '')}</b> · ${esc(v.text || '')}</div>`
      + (d.steps || []).map(diagRow).join('');
  } catch (e) {
    out.innerHTML = `<div class="hint err">${esc(e.message)}</div>`;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('#btnDockerRefresh').addEventListener('click', loadDocker);

  // ---- 域名体检（支持 /tools?host=x&path=/y 预填并自动跑，规则页「体检」按钮跳过来）
  if ($('#btnDiag')) {
    $('#btnDiag').addEventListener('click', runDiag);
    $('#diagPath').addEventListener('keydown', (e) => { if (e.key === 'Enter') runDiag(); });
    $('#diagHost').addEventListener('keydown', (e) => { if (e.key === 'Enter') runDiag(); });
    const qs = new URLSearchParams(location.search);
    const qh = qs.get('host');
    if (qh) {
      $('#diagHost').value = qh;
      $('#diagPath').value = qs.get('path') || '/';
      if (qs.get('public') === '1') $('#diagPublic').checked = true;
      runDiag();
    }
  }
  $('#dockerBody').addEventListener('click', (e) => {
    const b = e.target.closest('[data-dock]');
    if (!b) return;
    sessionStorage.setItem('cfp-prefill-upstream', b.dataset.dock);
    toast('已带上上游，去规则页点「＋ 添加规则」', 'ok');
    location.href = '/rules?prefill=' + encodeURIComponent(b.dataset.dock);
  });

  $('#btnShareAdd').addEventListener('click', async () => {
    try {
      $('#shareMsg').textContent = '生成中…';
      const d = await api('/api/shares', { method: 'POST', body: { name: $('#shareName').value.trim(), upstream: $('#shareUpstream').value.trim(), minutes: Number($('#shareMinutes').value) || 30 } });
      $('#shareMsg').textContent = '';
      copyText(d.share.url);
      loadShares();
    } catch (e) {
      $('#shareMsg').textContent = e.message;
      toast('生成失败：' + e.message, 'err');
    }
  });
  $('#shareList').addEventListener('click', async (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) return copyText(c.dataset.copy);
    const d = e.target.closest('[data-del]');
    if (d) {
      if (!confirm('删除这条分享链接？')) return;
      try { await api('/api/shares/' + d.dataset.del + '/delete', { method: 'POST' }); loadShares(); }
      catch (err) { toast(err.message, 'err'); }
    }
  });

  $('#btnWsTest').addEventListener('click', async () => {
    const out = $('#wsOut');
    const msg = $('#wsMsg');
    msg.textContent = '握手中…';
    out.textContent = '';
    try {
      const d = await api('/api/ws-test', { method: 'POST', body: { path: $('#wsPath').value.trim() || '/', host: $('#wsHost').value.trim() } });
      out.textContent = JSON.stringify(d, null, 2);
      msg.textContent = d.ok ? `可以升级（101，${d.ms}ms）` : `不能升级：${d.error || ''}`;
      msg.className = d.ok ? 'muted ok-hint' : 'muted err';
    } catch (e) {
      msg.textContent = '失败：' + e.message;
      msg.className = 'muted err';
    }
  });

  $('#btnCurl').addEventListener('click', async () => {
    const out = $('#curlOut');
    out.textContent = '请求中…';
    try {
      const d = await api('/api/curl', { method: 'POST', body: { path: $('#curlPath').value || '/', host: $('#curlHost').value.trim() } });
      const head = Object.entries(d.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
      out.textContent = `HTTP ${d.status}   ${d.ms}ms   ${d.bytes} 字节\n${head}\n\n${d.preview || ''}`;
    } catch (e) {
      out.textContent = '失败：' + e.message;
    }
  });

  async function cfVerify() {
    const msg = $('#cfMsg');
    msg.textContent = '验证中…';
    try {
      const d = await api('/api/cf/verify');
      msg.textContent = d.token || '';
      const acc = $('#cfAccount'), zn = $('#cfZone');
      if (!acc.value && d.suggest && d.suggest.accountId) acc.value = d.suggest.accountId;
      if (!zn.value && d.suggest && d.suggest.zoneId) zn.value = d.suggest.zoneId;
      const list = [];
      if ((d.accounts || []).length > 1) {
        list.push('<div class="hint">这个 token 能看到 ' + d.accounts.length + ' 个账号：' + d.accounts.map((a) => esc(a.name) + ' <code class="mono">' + esc(a.id) + '</code>').join(' ｜ ') + '</div>');
      }
      if ((d.zones || []).length) {
        list.push('<div class="tbl-wrap"><table><thead><tr><th>域名</th><th>状态</th><th>Zone ID</th><th></th></tr></thead><tbody>' +
          d.zones.map((z) => `<tr><td>${esc(z.name)}</td><td>${esc(z.status)}</td><td class="mono">${esc(z.id)}</td>
            <td><button class="mini" data-cfzone="${esc(z.id)}">用这个</button></td></tr>`).join('') + '</tbody></table></div>');
      } else {
        list.push('<div class="hint">读不到域名列表（token 可能没有 Zone · Zone · Read 权限），可以手动把 Zone ID 粘进去。</div>');
      }
      $('#cfList').innerHTML = list.join('');
      loadCf();
    } catch (e) { msg.textContent = '验证失败：' + e.message; }
  }

  async function cfDns(create) {
    const msg = $('#cfMsg');
    try {
      if (create) {
        const name = ($('#cfDnsName').value || '').trim();
        if (!name) return toast('先填要绑定的域名', 'warn');
        const sel = $('#cfDnsTunnel');
        const tid = (sel && sel.value) || '';
        const content = tid ? `${tid.trim()}.cfargotunnel.com` : '';
        const d = await api('/api/cf/dns', { method: 'POST', body: { type: 'CNAME', name, content } });
        toast('已创建 CNAME ' + d.record.name, 'ok');
      }
      const q = ($('#cfDnsName').value || '').trim();
      const r = await api('/api/cf/dns' + (q ? '?name=' + encodeURIComponent(q) : ''));
      const rows = (r.records || []);
      $('#cfDnsList').innerHTML = rows.length
        ? '<div class="tbl-wrap"><table><thead><tr><th>类型</th><th>名字</th><th>内容</th><th>代理</th><th></th></tr></thead><tbody>' +
          rows.map((x) => `<tr><td>${esc(x.type)}</td><td>${esc(x.name)}</td><td class="mono">${esc(x.content)}</td><td>${x.proxied ? '是' : '否'}</td>
            <td><button class="mini" data-cfdnsdel="${esc(x.id)}">删除</button></td></tr>`).join('') + '</tbody></table></div>'
        : '<div class="hint">没有匹配的记录</div>';
    } catch (e) { msg.textContent = 'DNS 操作失败：' + e.message; }
  }


/* ---------------- 公共主机名（隧道 ingress 直改） ---------------- */
let hostTunnelId = '';

async function loadHostnames(id) {
  hostTunnelId = id;
  $('#hostBox').classList.remove('hidden');
  $('#hostTun').textContent = id ? `· ${String(id).slice(0, 8)}…` : '';
  const box = $('#hostList');
  $('#hostMsg').textContent = '';
  box.innerHTML = '<div class="muted">读取中…</div>';
  try {
    const d = await api('/api/cf/tunnels/' + id + '/ingress');
    const rows = d.ingress || [];
    box.innerHTML = rows.length
      ? rows.map((x) => `<div class="row" style="justify-content:space-between;align-items:center;gap:8px">
          <div><span class="mono">${esc(x.hostname)}</span> <span class="muted">→</span> <span class="mono">${esc(x.service || '')}</span></div>
          <button class="mini ghost" data-hostdel="${esc(x.hostname)}">删除</button>
        </div>`).join('')
      : '<div class="empty">还没有公共主机名（只有兜底 404）</div>';
    if (rows.length && !$('#hostSvc').value) $('#hostSvc').value = rows[0].service || '';
  } catch (e) {
    box.innerHTML = `<div class="hint err">${esc(e.message)}</div>`;
  }
}

async function addHostname() {
  const hostname = $('#hostName').value.trim();
  const service = $('#hostSvc').value.trim();
  const msg = $('#hostMsg');
  if (!hostname || !service) { msg.textContent = '域名和上游都要填'; return; }
  msg.textContent = '提交中…';
  try {
    await api(`/api/cf/tunnels/${hostTunnelId}/hostnames`, { method: 'POST', body: { hostname, service } });
    msg.textContent = '已添加，DNS 也建好了';
    $('#hostName').value = '';
    toast(`已添加 ${hostname}`, 'ok');
    await loadHostnames(hostTunnelId);
    loadCf();
  } catch (e) { msg.textContent = e.message; }
}

function bindHostnames() {
  const list = $('#hostList');
  if (list) list.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-hostdel]');
    if (!b) return;
    if (!confirm(`删除 ${b.dataset.hostdel}？会同时删掉它的 CNAME。`)) return;
    try {
      await api(`/api/cf/tunnels/${hostTunnelId}/hostnames/delete`, { method: 'POST', body: { hostname: b.dataset.hostdel } });
      toast('已删除', 'ok');
      await loadHostnames(hostTunnelId);
    } catch (err) { toast(err.message, 'err'); }
  });
  const addBtn = $('#btnHostAdd');
  if (addBtn) addBtn.addEventListener('click', addHostname);
  const close = $('#btnHostClose');
  if (close) close.addEventListener('click', () => $('#hostBox').classList.add('hidden'));
}

  $('#btnCfVerify').addEventListener('click', cfVerify);
  bindHostnames();
  $('#btnCfDnsAdd').addEventListener('click', () => cfDns(true));
  $('#btnCfDnsList').addEventListener('click', () => cfDns(false));
  $('#btnQuick').addEventListener('click', () => {
    const box = $('#quickBox');
    box.classList.toggle('hidden');
    $('#btnQuick').setAttribute('aria-expanded', box.classList.contains('hidden') ? 'false' : 'true');
    if (!box.classList.contains('hidden')) $('#qkHost').focus();
  });
  $('#btnQkClose').addEventListener('click', () => {
    $('#quickBox').classList.add('hidden');
    $('#btnQuick').setAttribute('aria-expanded', 'false');
    $('#qkMsg').textContent = '';
  });
  $('#btnQkRun').addEventListener('click', async () => {
    const hostname = ($('#qkHost').value || '').trim();
    const service = ($('#qkSvc').value || '').trim();
    const name = ($('#qkName').value || '').trim();
    const addLocal = $('#qkLocal').checked;
    const dry = $('#qkDry').checked;
    const out = $('#qkOut');
    const msg = $('#qkMsg');
    if (!hostname) { msg.textContent = '先填公共主机名，例如 dsh2.example.com'; return; }
    msg.textContent = dry ? '演练中…' : '创建中（最多等 20 秒做公网自测）…';
    out.innerHTML = '';
    $('#btnQkRun').disabled = true;
    try {
      const d = await api('/api/cf/tunnels/quick', { method: 'POST', body: { hostname, service, name, addLocal, dry } });
      if (d.dry) {
        out.innerHTML = '<div class="hint" style="margin-top:0">演练模式：下面是真正执行时会依次调用的接口</div>' +
          '<table class="stackable"><thead><tr><th>#</th><th>接口</th><th>动作</th></tr></thead><tbody>' +
          (d.plan || []).map((x) => `<tr><td class="mono">${x.step}</td><td class="mono">${esc(x.api)}</td><td>${esc(x.note)}</td></tr>`).join('') +
          '</tbody></table>';
        msg.textContent = '演练完成（没有动任何东西）';
        return;
      }
      out.innerHTML = '<table class="stackable"><thead><tr><th>步骤</th><th>结果</th><th>说明</th></tr></thead><tbody>' +
        (d.steps || []).map((x) => `<tr><td>${esc(x.name)}</td><td>${x.ok ? '<span class="tag ok">成功</span>' : '<span class="tag err">失败</span>'}</td><td class="mono">${esc(x.detail)}</td></tr>`).join('') +
        '</tbody></table>' +
        (d.url ? `<div class="hint">公网入口：<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.url)}</a>${d.publicStatus ? ' · 自测 ' + esc(String(d.publicStatus)) : ''}</div>` : '');
      msg.textContent = d.ok ? '完成了' : '有步骤失败，看下面那张表';
      toast(d.ok ? '出口已就绪' : '部分步骤失败', d.ok ? 'ok' : 'warn');
      loadCf();
      refresh(true);
    } catch (e) {
      msg.textContent = e.message;
      toast('失败：' + e.message, 'err');
    } finally {
      $('#btnQkRun').disabled = false;
    }
  });
  $('#cfList').addEventListener('click', async (e) => {
    const z = e.target.closest('[data-cfzone]');
    if (z) { $('#cfZone').value = z.dataset.cfzone; toast('已填入 Zone ID，记得点「保存 API 配置」'); return; }
    const h = e.target.closest('[data-cfhost]');
    if (h) { loadHostnames(h.dataset.cfhost); return; }
    const got = e.target.closest('[data-cfget]');
    if (got) {
      try {
        const d = await api('/api/cf/tunnels/' + got.dataset.cfget + '/token', { method: 'POST' });
        await copyText(d.token);
        toast('已复制这条隧道的 token，粘到「隧道出口」新建出口即可');
      } catch (err) { toast(err.message, 'err'); }
      return;
    }
    const del = e.target.closest('[data-cfdnsdel]');
    if (del) {
      if (!confirm('删掉这条 DNS 记录？')) return;
      try { await api('/api/cf/dns/' + del.dataset.cfdnsdel + '/delete', { method: 'POST' }); cfDns(false); }
      catch (err) { toast(err.message, 'err'); }
    }
  });

  $('#btnCfSave').addEventListener('click', saveCf);
  $('#btnCfList').addEventListener('click', loadCf);
  $('#btnCfCreate').addEventListener('click', () => {
    const box = $('#newTunBox');
    box.classList.toggle('hidden');
    $('#btnCfCreate').setAttribute('aria-expanded', box.classList.contains('hidden') ? 'false' : 'true');
    if (!box.classList.contains('hidden')) $('#newTunName').focus();
  });
  $('#btnNewTunCancel').addEventListener('click', () => {
    $('#newTunBox').classList.add('hidden');
    $('#newTunName').value = ''; $('#newTunHost').value = ''; $('#newTunMsg').textContent = '';
    $('#btnCfCreate').setAttribute('aria-expanded', 'false');
  });
  $('#btnNewTunDo').addEventListener('click', async () => {
    const name = ($('#newTunName').value || '').trim();
    const host = ($('#newTunHost').value || '').trim();
    const wantCname = $('#newTunCname').checked;
    const wantLocal = $('#newTunLocal').checked;
    if (!name) { $('#newTunMsg').textContent = '先给隧道起个名字'; return; }
    try {
      $('#newTunMsg').textContent = '创建中…';
      const d = await api('/api/cf/tunnels', { method: 'POST', body: { name, hostname: wantCname ? host : '', addLocal: false } });
      $('#cfMsg').textContent = '已创建';
      toast('已创建云端隧道' + (host ? '并写好 CNAME' : ''), 'ok');
      loadCf();
      if (wantLocal && d.token) {
        const t = await api('/api/tunnels', { method: 'POST', body: { name, mode: 'named', origin: 'http://127.0.0.1:8080', token: d.token, publicHostname: host } });
        toast('已在本机加好出口「' + t.id + '」', 'ok');
      }
      $('#newTunBox').classList.add('hidden');
      $('#btnCfCreate').setAttribute('aria-expanded', 'false');
      $('#newTunName').value = ''; $('#newTunHost').value = ''; $('#newTunMsg').textContent = '';
      $('#cfMsg').textContent = '已创建';
      toast('已创建云端隧道' + (wantCname && host ? '并写好 CNAME' : ''), 'ok');
    } catch (e) {
      $('#newTunMsg').textContent = e.message;
      toast('创建失败：' + e.message, 'err');
    }
  });
  $('#cfList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-cfdel]');
    if (!b) return;
    if (!confirm('删掉云端这条隧道？本地出口不会被删，但会失效。')) return;
    try { await api('/api/cf/tunnels/' + b.dataset.cfdel + '/delete', { method: 'POST' }); loadCf(); }
    catch (err) { toast(err.message, 'err'); }
  });

  $('#btnCaddyCfg').addEventListener('click', async () => {
    try {
      const r = await api('/api/caddy/config');
      const box = $('#caddyCfg');
      box.style.display = 'block';
      box.textContent = r.ok ? JSON.stringify(r.config, null, 2) : '生成失败：' + r.error;
      $('#caddyCfgMsg').textContent = r.ok ? '已生成当前配置' : '';
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#btnCaddyCopy').addEventListener('click', () => {
    const t = $('#caddyCfg').textContent;
    if (!t) return toast('先点“生成并查看”', 'warn');
    copyText(t).then(() => toast('已复制'));
  });


/** ---------------- 测速 ---------------- */
function fmtMs(v) { return v == null ? '—' : (v < 10 ? v.toFixed(1) : String(Math.round(v))); }
function pick(arr, p) {
  if (!arr.length) return null;
  const a = arr.slice().sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.round((p / 100) * (a.length - 1))));
  return a[i];
}

async function benchPing(n = 10) {
  const out = [];
  let colo = '';
  for (let i = 0; i < n; i += 1) {
    const t0 = performance.now();
    const r = await fetch('/__bench/ping?t=' + Date.now() + Math.random(), { cache: 'no-store' });
    const d = await r.json();
    out.push(performance.now() - t0);
    if (d && d.colo) colo = d.colo;
  }
  return { samples: out, min: pick(out, 0), median: pick(out, 50), p95: pick(out, 95), colo };
}

async function benchDownload(mb) {
  const t0 = performance.now();
  const res = await fetch('/__bench/blob?mb=' + mb + '&t=' + Date.now(), { cache: 'no-store' });
  let firstByte = null;
  let bytes = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstByte == null) firstByte = performance.now() - t0;
    bytes += value ? value.length : 0;
  }
  const total = (performance.now() - t0) / 1000;
  return { mb: bytes / 1048576, sec: total, ttfbMs: firstByte, mbps: bytes / 1048576 / total };
}

function benchRow(label, value, note) {
  return `<tr><td>${esc(label)}</td><td class="mono">${value}</td><td class="muted">${esc(note || '')}</td></tr>`;
}

async function runBench() {
  const btn = $('#btnBenchAll');
  const mb = Number(($('#benchMb') || {}).value || 5);
  btn.disabled = true;
  try {
    $('#benchMsg').textContent = '测延迟…';
    const ping = await benchPing(10);
    $('#benchMsg').textContent = `测带宽（${mb} MB）…`;
    const dl = await benchDownload(mb);
    $('#benchMsg').textContent = '测本机 Caddy…';
    let local = null;
    try { const r = await api('/api/bench/local', { method: 'POST', body: { n: 5 } }); local = r.ttfbMs; } catch (e) { local = null; }
    const where = ping.colo
      ? `经 Cloudflare <b>${esc(ping.colo)}</b> 机房`
      : '本机 / 局域网直连（没看到 cf-ray，说明这条路径没经过 Cloudflare）';
    const verdict = dl.mbps >= 20 ? '这条链路很宽，大文件也能过'
      : dl.mbps >= 5 ? '够用：网页、后台、远程终端都顺'
        : dl.mbps >= 1 ? '能看网页，大文件会慢'
          : '带宽被回源上行卡住了（家宽上行典型值），别拿它传大文件';
    $('#benchOut').innerHTML = `
      <div class="hint">当前路径：${where}</div>
      <div class="tbl-wrap"><table>
        <thead><tr><th>项目</th><th>结果</th><th>说明</th></tr></thead>
        <tbody>
          ${benchRow('延迟（中位）', `${fmtMs(ping.median)} ms`, `最小 ${fmtMs(ping.min)} / p95 ${fmtMs(ping.p95)}，10 次小请求`)}
          ${local ? benchRow('本机 → Caddy 延迟', `${fmtMs(local.median)} ms`, '不经隧道、不经公网，纯回环') : ''}
          ${benchRow(`下载 ${dl.mb.toFixed(1)} MB`, `${dl.mbps.toFixed(2)} MB/s`, `${dl.sec.toFixed(2)} 秒，首字节 ${fmtMs(dl.ttfbMs)} ms`)}
          ${benchRow('估算速率', `${(dl.mbps * 8).toFixed(1)} Mbps`, verdict)}
        </tbody>
      </table></div>
      <div class="hint">想换个机房再测：把浏览器地址换成别的优选 IP（见文档「速度实测」一节）；测速数字受你当前网络影响，同一台机器测到的公网数会比自己从外网访问偏乐观一点。</div>`;
    $('#benchMsg').textContent = '完成';
  } catch (e) {
    $('#benchMsg').textContent = '测速失败：' + e.message;
  } finally {
    btn.disabled = false;
  }
}

  loadDocker();
  loadShares();
  loadState().then((d) => {
    ST = d;
    const cf = (d.state.settings && d.state.settings.cf) || {};
    $('#cfAccount').value = cf.accountId || '';
    $('#cfZone').value = cf.zoneId || '';
    $('#cfToken').placeholder = cf.hasToken ? '已保存（留空不改）' : '粘贴 Cloudflare API Token';
  }).catch(() => {});
  $('#btnBenchAll').addEventListener('click', runBench);
  cfpEvery(20000, () => loadShares());
});

})();

(function bindCacheTools() {
  const msg = document.getElementById('cacheRuleMsg');
  const out = document.getElementById('cacheRuleOut');
  const pmsg = document.getElementById('purgeMsg');
  const on = document.getElementById('btnCacheRuleState');
  if (!on) return;
  const show = (t) => { if (out) { out.textContent = t; out.classList.remove('hidden'); } };
  on.addEventListener('click', async () => {
    msg.textContent = '读取中…';
    try {
      const d = await api('/api/cf/cache/rule');
      if (!d.ok) { msg.textContent = d.error || '读不到'; show(''); return; }
      msg.textContent = (d.rules || []).length + ' 条缓存规则';
      show((d.rules || []).map((r) => `${r.enabled ? '✅' : '⏸'} ${r.description || r.id}\n   ${r.expression}`).join('\n\n') || '（这个域名的缓存阶段还没有任何规则）');
    } catch (e) { msg.textContent = e.message; }
  });
  document.getElementById('btnCacheRuleOn').addEventListener('click', async () => {
    msg.textContent = '写入中…';
    try { const d = await api('/api/cf/cache/rule', { method: 'POST', body: { enable: true } }); msg.textContent = '已开启（共 ' + d.rules + ' 条规则）'; }
    catch (e) { msg.textContent = e.message; }
  });
  document.getElementById('btnCacheRuleOff').addEventListener('click', async () => {
    if (!confirm('关掉静态资源边缘缓存？')) return;
    msg.textContent = '写入中…';
    try { const d = await api('/api/cf/cache/rule', { method: 'POST', body: { enable: false } }); msg.textContent = '已关闭（剩 ' + d.rules + ' 条规则）'; }
    catch (e) { msg.textContent = e.message; }
  });
  const wmsg = document.getElementById('warmMsg');
  document.getElementById('btnWarm').addEventListener('click', async () => {
    if (wmsg) wmsg.textContent = '预热中…（会从公网把关键资源拉一遍）';
    try {
      const d = await api('/api/cf/cache/warm', { method: 'POST', body: {} });
      const rows = (d.results || []).map((r) => `${r.path} → ${r.status || 'ERR'} ${r.cache || ''}${r.age ? ' age=' + r.age : ''}${r.colo ? ' [' + r.colo + ']' : ''} ${r.ms}ms`).join('\n');
      // hit 是「这次请求本来就命中」的数量。第一次预热必然是 0/4（MISS 到源站），
      // 那不是失败，是把资源推进缓存 —— 别用「0/4 命中」这种看着像出错的说法。
      const msg = d.hit === 0
        ? `${d.host}：已把 ${d.total} 个资源推进边缘缓存（版本 ${d.version}），下一次访问就是 HIT`
        : `${d.host}：${d.total} 个资源，其中 ${d.hit} 个本来就在缓存里（版本 ${d.version}）`;
      if (wmsg) wmsg.textContent = msg;
      const out = document.getElementById('cacheRuleOut');
      if (out) { out.textContent = rows; out.classList.remove('hidden'); }
    } catch (e) { if (wmsg) wmsg.textContent = e.message; }
  });

  document.getElementById('btnPurge').addEventListener('click', async () => {
    const urls = (document.getElementById('purgeUrls').value || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!confirm(urls.length ? `清理这 ${urls.length} 个 URL 的边缘缓存？` : '清空整个域名的边缘缓存？')) return;
    pmsg.textContent = '清理中…';
    try { const d = await api('/api/cf/cache/purge', { method: 'POST', body: { urls } }); pmsg.textContent = '已清理：' + d.purged; }
    catch (e) { pmsg.textContent = e.message; }
  });
})();
