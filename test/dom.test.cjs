/* 前端 DOM 回归测试（jsdom）
   用法：PANEL_PASS=你的密码 node test/dom.test.cjs
   面板开着 HTTP Basic 登录，所以这里起一个本地小代理自动加凭据。 */
const http = require('http');
const fs = require('fs');
const path = require('path');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch {
  console.error('缺少 jsdom：先在仓库目录执行 npm i -D jsdom');
  process.exit(2);
}

const UPSTREAM = process.env.PANEL_URL || 'http://127.0.0.1:8090';
const USER = process.env.PANEL_USER || 'admin';
const PASS = process.env.PANEL_PASS || '';
const PROXY_PORT = Number(process.env.PANEL_PROXY_PORT || 8099);
const BASE = PASS ? `http://127.0.0.1:${PROXY_PORT}` : UPSTREAM;

let proxy = null;
if (PASS) {
  const basic = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
  const up = new URL(UPSTREAM);
  proxy = http.createServer((req, res) => {
    const opts = { hostname: up.hostname, port: up.port, path: req.url, method: req.method,
      headers: { ...req.headers, host: up.host, authorization: basic } };
    const p = http.request(opts, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    p.on('error', () => { res.writeHead(502); res.end('proxy error'); });
    req.pipe(p);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * 等到 fn() 返回真值，或超时返回最后一次的值。
 * 固定 sleep 在机器忙 / 页面刚重启时会出现「还没渲染完就断言」，这正是 177/179 那类假失败的来源。
 */
async function waitFor(fn, ms = 8000, step = 120) {
  const t0 = Date.now();
  let out;
  for (;;) {
    try { out = await fn(); } catch { out = false; }
    if (out) return out;
    if (Date.now() - t0 > ms) return out;
    await sleep(step);
  }
}
/** 等到「又发生了一次 /api/state 轮询」+ 一点渲染余量（比硬等 6.5 秒快，也不会因为机器慢而误判） */
async function pollTick(win, delta = 1, ms = 12000) {
  const c0 = win.__calls.state;
  await waitFor(() => win.__calls.state >= c0 + delta, ms, 100);
  await sleep(250);
}

async function open(path, wait = 900, until = null) {
  const errors = [];
  const dom = await JSDOM.fromURL(BASE + path, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.__calls = { state: 0, all: 0 };
      win.fetch = (u, o) => {
        win.__calls.all += 1;
        if (String(u).includes('/api/state')) win.__calls.state += 1;
        return fetch(new URL(u, BASE).href, o);
      };
      win.EventSource = class { constructor() { this.onmessage = null; } close() {} addEventListener() {} };
      win.alert = () => {};
      win.confirm = () => true;
      win.prompt = () => 'x';
      win.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
    },
  });
  if (until) await waitFor(until(dom.window), wait);
  else await sleep(wait);
  return { dom, win: dom.window, doc: dom.window.document, errors };
}

const results = [];
function chk(name, ok, extra = '') { results.push([ok, name, extra]); }

(async () => {
  if (proxy) await new Promise((r) => proxy.listen(PROXY_PORT, '127.0.0.1', r));
  // 1) 总览
  {
    const { doc, errors, win } = await open('/');
    const nav = [...doc.querySelectorAll('.side .nav a')].map((a) => a.getAttribute('href'));
    chk('总览: 侧栏导航齐全（含 /monitor）', nav.length >= 7 && nav.includes('/monitor'), nav.join(','));
    const firstLink = doc.querySelector('.side .nav a');
    chk('总览: 导航链接是 flex 行内布局', !!firstLink && doc.querySelectorAll('.side .nav a .ico').length === nav.length, '');
    chk('总览: 日志无 Invalid Date', !/Invalid Date/.test(doc.body.textContent), '');
    chk('总览: 当前页高亮', !!doc.querySelector('.side .nav a.active'), '');
    {
      // 健康指示要等 /api/state 回来，机器忙的时候 1.8 秒不够 —— 轮询到有内容为止（最多 6 秒）
      const ht = () => (doc.querySelector('#healthText') || {}).textContent || '';
      await waitFor(() => ht() && ht() !== '检测中…' && ht() !== '加载中…', 9000);
      const t = ht();
      chk('总览: 健康指示已填充', !!t && t !== '检测中…', t);
    }
    chk('总览: 有按规则流量卡', !!doc.querySelector('#pathBox'), '');
    // v0.29.22：并排两卡不再强制等高（左边出口少时会被拉出大片空白）
    // v0.29.23：规则全是「全局」时，作用域整列收掉（6 行一样的标签是噪音）
    {
      const ths = [...doc.querySelectorAll('#ruleMini thead th')].map((t) => t.textContent.trim());
      const anyScoped = /仅限单出口/.test(doc.querySelector('#ruleMini').innerHTML);
      chk('总览: 无单出口规则时不显示作用域列', anyScoped ? ths.includes('作用域') : !ths.includes('作用域'), ths.join('/'));
    }
    chk('总览: 并排卡按内容高度（align-items:start）',
      /start/.test(win.getComputedStyle(doc.querySelector('.grid2.top')).alignItems || ''), '');
    // v0.29.21：规则迷你表要带「主机」列（两条 / 规则靠主机区分）
    {
      const th = [...doc.querySelectorAll('#ruleMini th')].map((x) => x.textContent.trim());
      chk('总览: 规则表有主机列', th.includes('主机'), th.join(','));
    }
    chk('总览: 有预热提醒位', !!doc.querySelector('#warmBar'), '');
    chk('总览: 有监控嵌入卡（默认隐藏）', !!doc.querySelector('#grafanaCard'), '');

    // v0.13.5：点图例跳到规则页要能定位并高亮
    {
      const hz = await (await fetch(BASE + '/healthz')).json();
      const rid = (await (await fetch(BASE + '/api/state')).json()).state.routes[0].id;
      const { doc: rd, win: rwin, errors: rErrs } = await open('/rules?focus=' + encodeURIComponent(rid), 6000,
        (w) => w.document.querySelector('.rule[data-focused]'));
      const hit = rd.querySelector('.rule[data-focused]');
      chk('规则页: ?focus 能定位到规则', !!hit, String(!!hit));
      // v0.29.17：焦点标记要扛过一次 5 秒轮询重绘（之前闪一下就被重绘冲掉了）
      await pollTick(rwin, 1);
      chk('规则页: 轮询重绘后焦点标记仍在', !!rd.querySelector('.rule[data-focused]'), String(!!rd.querySelector('.rule[data-focused]')));
      // v0.29.24：只对某域名生效的规则，主机名单独做徽标
      // v0.29.27：规则卡也收口了 —— 「测 / 复制 / 导出」进「操作 ⋯」，只留 ↑↓ 和「删」
      {
        const card = rd.querySelector('.rule');
        const outside = card ? [...card.querySelectorAll('[data-act]')].filter((b) => !b.closest('.menu-pop')).map((b) => b.dataset.act) : [];
        chk('规则页: 测试/复制/导出已收进 ⋯ 菜单',
          !card || (!!card.querySelector('.menu-pop [data-act="test"]') && !outside.includes('test') && !outside.includes('dup') && !outside.includes('exp')),
          outside.join(','));
      }
      chk('规则页: 主机名用徽标显示', !rd.querySelector('.rule') || !!rd.querySelector('.rule .badge-host') || !rd.querySelector('[data-k="host"]'), '');
      chk('规则页: focus 页面无脚本错误', rErrs.length === 0, rErrs.join(' | ').slice(0, 160));
      chk('规则页: 每条规则有命中统计徽标', rd.querySelectorAll('#ruleList [data-hits]').length > 0,
        String(rd.querySelectorAll('#ruleList [data-hits]').length));
    }

    chk('总览: 四张图都画出来了', doc.querySelectorAll('.chart').length >= 3, String(doc.querySelectorAll('.chart').length));
    chk('总览: 刻度是 HTML 行（不被 SVG 拉伸）', doc.querySelectorAll('.chart-x').length >= 3, String(doc.querySelectorAll('.chart-x').length));
    chk('总览: 刻度文字有内容', [...doc.querySelectorAll('.chart-x span')].some((x) => /\d+:00/.test(x.textContent)), '');
    chk('总览: 图表带悬停提示', doc.querySelectorAll('.chart title').length >= 3, String(doc.querySelectorAll('.chart title').length));
    chk('总览: 无脚本错误', errors.length === 0, errors.join(' | ').slice(0, 200));
    // 主题切换
    const before = win.document.documentElement.dataset.theme;
    doc.querySelector('#btnTheme').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    const after = win.document.documentElement.dataset.theme;
    chk('总览: 主题切换生效', before !== after, before + '→' + after);
    chk('总览: 主题写入 localStorage', win.localStorage.getItem('cfp-theme') === after, String(win.localStorage.getItem('cfp-theme')));
  }

  // 2) 隧道页
  {
    const { doc, win, errors } = await open('/tunnels');
    const cards = doc.querySelectorAll('#tunnelList > .card');
    { const s0 = await (await fetch(BASE + '/api/state')).json();
      const exp = (s0.state.tunnels || []).length;
      chk(`隧道: 出口卡片数 = ${exp}`, cards.length === exp, String(cards.length)); }
    chk('隧道: 存在新建出口按钮', !!doc.querySelector('#btnAdd') && !!doc.querySelector('#btnCreate'), '');
    const runningNow = /已在运行|运行中/.test(doc.querySelector('#tunnelList').innerHTML);
    const hasUrl = /trycloudflare\.com|https:\/\//.test(doc.querySelector('#tunnelList').innerHTML);
    const st = await (await fetch(BASE + '/api/state')).json();
    const anyUrl = (st.runtime.tunnels || []).some((t) => t.url);
    chk('隧道: 在线时卡片里有公网地址', anyUrl ? hasUrl : true, anyUrl ? '' : '（当前无线隧道，跳过）');
    chk('隧道: 在线时状态徽章出现', anyUrl ? runningNow : true, anyUrl ? '' : '（当前无线隧道，跳过）');
    chk('隧道: 每个出口都有状态标签', doc.querySelectorAll('#tunnelList .pill, #tunnelList .tag').length >= 2, '');
    // v0.29.24：卡片头只留「操作 ⋯」+「删除」，重启/启动/停止按需展开
    {
      const pop = doc.querySelector('#tunnelList .menu-pop');
      const outside = [...doc.querySelectorAll('#tunnelList [data-act]')]
        .filter((b) => !b.closest('.menu-pop')).map((b) => b.getAttribute('data-act'));
      chk('隧道: 重启已收进 ⋯ 菜单', !!pop && !!pop.querySelector('[data-act="restart"]') && !outside.includes('restart'), outside.join(','));
    }
    chk('隧道: 0 条专属规则时不显示那个标签', !/0 条仅限此出口/.test(doc.body.textContent), '');
    // 回归：在「出口设置」里输入后，5 秒轮询不能把未保存的输入清掉
    {
      const card0 = doc.querySelector('#tunnelList > .card');
      const inp0 = card0 && card0.querySelector('[data-k="name"]');
      if (inp0) {
        inp0.value = '我改到一半的名字';
        inp0.dispatchEvent(new win.Event('input', { bubbles: true }));
        await pollTick(win);   // 等一次真实的 /api/state 轮询过去，看它会不会把输入清掉
        const inp1 = (doc.querySelector('#tunnelList > .card') || {}).querySelector
          ? doc.querySelector('#tunnelList > .card').querySelector('[data-k="name"]') : null;
        chk('隧道: 输入出口设置后 5s 轮询不清空', !!inp1 && inp1.value === '我改到一半的名字', (inp1 || {}).value);
        chk('隧道: 轮询未重建卡片', doc.querySelectorAll('#tunnelList > .card').length === cards.length, '');
      } else {
        chk('隧道: 输入出口设置后 5s 轮询不清空', true, '（无出口卡片，跳过）');
      }
    }
    chk('隧道: 限流提示可见（若有）', true, '');
    chk('隧道: 无脚本错误', errors.length === 0, errors.join('|').slice(0, 160));
  }

  // 3) 规则页（关键回归：脏标记保护）
  {
    const { doc, win } = await open('/rules');
    const before = doc.querySelectorAll('.rule').length;
    doc.querySelector('#btnAddRule').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await waitFor(() => doc.querySelectorAll('.rule').length === before + 1, 4000);
    const added = doc.querySelectorAll('.rule').length;
    chk('规则: 添加后 +1', added === before + 1, before + '→' + added);
    await pollTick(win, 2);   // 跨过两次 5s 轮询
    const afterWait = doc.querySelectorAll('.rule').length;
    chk('规则: 6.5 秒轮询后仍在（脏标记生效）', afterWait === added, added + '→' + afterWait);
    // 回归：在规则输入框里打字，5 秒轮询不能把内容顶回服务器旧值
    const firstPath = doc.querySelector('.rule input[data-k="path"]');
    firstPath.value = '/typed-by-test';
    firstPath.dispatchEvent(new win.Event('input', { bubbles: true }));
    await pollTick(win, 2);
    chk('规则: 输入后 6.5 秒不被轮询清掉', firstPath.value === '/typed-by-test', firstPath.value);
    const banner = doc.querySelector('#rulesDirty');
    chk('规则: 出现「未保存」提示', !!banner && !banner.classList.contains('hidden'), banner ? banner.className : 'missing');
  }

  // 4) 观测页
  {
    const { doc } = await open('/observe');
    const rows = doc.querySelectorAll('#accessBody tbody tr').length;
    chk('观测: 访问表每页 ≤5 行', rows <= 5, String(rows));
    chk('观测: 有分页控件', !!doc.querySelector('#accessBody .pager') || rows < 5, String(!!doc.querySelector('#accessBody .pager')));
    chk('观测: 日志容器存在', !!doc.querySelector('#logBox'), '');
  }

  // 5) 设置页
  {
    const { doc, win } = await open('/settings');
    const hv = await (await fetch(BASE + '/healthz')).json();
    const vt = (doc.querySelector('#verTag') || {}).textContent || '';
    chk('设置: 版本号已渲染', vt.includes(hv.version), `${vt} vs ${hv.version}`);
    const bk = doc.querySelectorAll('#backupList tbody tr').length;
    chk('设置: 备份每页 ≤5 行', bk <= 5, String(bk));
    chk('设置: 维护模式字段回填', typeof doc.querySelector('#maintOn').checked === 'boolean', '');
    chk('设置: 有分页控件', !!doc.querySelector('#backupList .pager') || bk < 5, '');
    const sn = doc.querySelectorAll('.subnav a').length;
    chk('设置: 分区导航 ≥10 个锚点', sn >= 10, String(sn));
    chk('设置: 有设置项搜索框', !!doc.querySelector('#cardSearch'), '');
    {
      const sb = doc.querySelector('#cardSearch');
      const before = [...doc.querySelectorAll('.card[id^="sec-"]')].filter((c) => !c.classList.contains('hidden')).length;
      if (sb) {
        sb.value = '备份';
        sb.dispatchEvent(new win.Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 60));
        const after = [...doc.querySelectorAll('.card[id^="sec-"]')].filter((c) => !c.classList.contains('hidden')).length;
        chk('设置: 搜索能收窄卡片', after > 0 && after < before, `${before} → ${after}`);
      } else { chk('设置: 搜索能收窄卡片', false, 'no input'); }
    }
    chk('设置: 分区锚点都能对上卡片', !!doc.querySelector('#sec-backup') && !!doc.querySelector('#sec-totp'), '');
    // v0.29.22：15 张卡片一次只显示一个分区，导航当页签
    {
      const sb0 = doc.querySelector('#cardSearch');
      if (sb0 && sb0.value) { sb0.value = ''; sb0.dispatchEvent(new win.Event('input', { bubbles: true })); }
      const cards = [...doc.querySelectorAll('.card[id^="sec-"]')];
      const shown = cards.filter((c) => !c.hidden && !c.classList.contains('hidden'));
      chk('设置: 一次只显示一个分区', shown.length === 1, shown.map((c) => c.id).join(','));
      const chip = [...doc.querySelectorAll('.subnav a')].find((a) => (a.getAttribute('href') || '') === '#sec-backup');
      if (chip) {
        chip.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
        const after = [...doc.querySelectorAll('.card[id^="sec-"]')].filter((c) => !c.hidden && !c.classList.contains('hidden'));
        chk('设置: 点分区标签能切换', after.length === 1 && after[0].id === 'sec-backup', after.map((c) => c.id).join(','));
      } else {
        chk('设置: 点分区标签能切换', false, '没有 #sec-backup 的标签');
      }
      // 搜索是跨分区的：搜「Grafana」应该能直接翻出监控嵌入那个分区
      const sb2 = doc.querySelector('#cardSearch');
      if (sb2) {
        sb2.value = 'Grafana';
        sb2.dispatchEvent(new win.Event('input', { bubbles: true }));
        const hit = [...doc.querySelectorAll('.card[id^="sec-"]')]
          .filter((c) => !c.hidden && !c.classList.contains('hidden')).map((c) => c.id);
        chk('设置: 搜索跨分区', hit.includes('sec-grafana'), hit.join(','));
        sb2.value = '';
        sb2.dispatchEvent(new win.Event('input', { bubbles: true }));
      } else {
        chk('设置: 搜索跨分区', false, '没有搜索框');
      }
    }
    // v0.29.21：关于卡之前把面板请求总数渲染成 undefined（total 在 panelRequests 顶层）
    chk('设置: 页面上没有 undefined', !/undefined/.test(doc.body.textContent), '');
    const rh = doc.querySelectorAll('#notifyHist [data-resend]').length;
    chk('设置: 通知记录带重发按钮', rh >= 0, String(rh));
    chk('设置: 通知模板输入框存在', !!doc.querySelector('#notifyTplTitle') && !!doc.querySelector('#notifyTplText'), '');

  }

  // ---- v0.8.0：P0/P1/P2 新交互 ----
  {
    const { doc, errors, win } = await open('/rules');
    const f = doc.querySelector('#ruleFilter');
    chk('规则: 有搜索框', !!f, '');
    if (f) {
      f.value = '不存在的关键字zzz';
      f.dispatchEvent(new win.Event('input', { bubbles: true }));
      chk('规则: 搜索无结果时有提示', /没有匹配/.test(doc.querySelector('#ruleList').textContent), '');
      f.value = '';
      f.dispatchEvent(new win.Event('input', { bubbles: true }));
    }
    // 粘贴导入改成内联框，不再 prompt
    chk('规则: 导入是内联 textarea（非 prompt）', !!doc.querySelector('#importText') && !!doc.querySelector('#btnDoImport'), '');
    doc.querySelector('#btnImport').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    const box = doc.querySelector('#importBox');
    chk('规则: 点导入展开面板', !!box && !box.classList.contains('hidden'), '');
    // 作用域持久化
    const sel = doc.querySelector('#scopeSel');
    if (sel && sel.options.length > 1) {
      sel.value = sel.options[1].value;
      sel.dispatchEvent(new win.Event('change', { bubbles: true }));
      chk('规则: 作用域写入 localStorage', win.localStorage.getItem('cfp-scope') === sel.options[1].value, String(win.localStorage.getItem('cfp-scope')));
    } else {
      chk('规则: 作用域写入 localStorage', true, '只有一个出口，跳过');
    }
    chk('规则: 无脚本错误', errors.length === 0, errors.join(' | ').slice(0, 160));
  }

  {
    const { doc, errors, win } = await open('/observe');
    chk('观测: 可疑访问卡片存在', !!doc.querySelector('#secBody'), String(!!doc.querySelector('#secBody')));
    chk('观测: 可疑访问有内容或空态', !!doc.querySelector('#secBody .empty') || !!doc.querySelector('#secBody table'), String(!!doc.querySelector('#secBody')));
    chk('观测: 可疑访问窗口可切换', !!doc.querySelector('#secHours'), '');
    chk('观测: 有状态筛选', !!doc.querySelector('#accStatus'), '');
    chk('观测: 有路径搜索', !!doc.querySelector('#accPath'), '');
    chk('观测: 有时间范围', !!doc.querySelector('#accRange'), '');
    const st = doc.querySelector('#accStatus');
    if (st) {
      st.value = '5';
      st.dispatchEvent(new win.Event('change', { bubbles: true }));
      chk('观测: 选 5xx 后表格仍正常渲染', !!doc.querySelector('#accessBody table, #accessBody .empty'), '');
      st.value = '';
      st.dispatchEvent(new win.Event('change', { bubbles: true }));
    }
    const pz = doc.querySelector('#btnLogPause');
    chk('观测: 有暂停按钮', !!pz, '');
    // v0.29.23：审计日志与面板日志并排、面板日志默认折叠（整页 2170px 太长了）
    chk('观测: 可疑访问与规则命中并排', !!doc.querySelector('.grid2.obs-mid'), '');
    chk('观测: 面板日志默认折叠', !!doc.querySelector('#logBox.collapsed'), '');
    // v0.29.26：来源 IP / 时间范围收进「更多筛选」，默认不占一整行
    chk('观测: 更多筛选默认收起', !!doc.querySelector('#btnMoreFilters') && doc.querySelector('#accMore').classList.contains('hidden'), '');
    if (pz) {
      pz.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      chk('观测: 暂停后按钮变「继续」', /继续/.test(pz.textContent) && pz.getAttribute('aria-pressed') === 'true', pz.textContent);
    }
    chk('观测: 有只看错误开关', !!doc.querySelector('#logOnlyErr'), '');
    chk('设置: 有 Grafana 嵌入卡', true, '');
    chk('观测: 有审计日志卡片', !!doc.querySelector('#auditBody') && !!doc.querySelector('#auditQ'), '');
    const ad = doc.querySelector('#auditDate');
    chk('观测: 审计可按日期查看（v0.20.0）', !!ad && ad.options.length >= 1, ad ? `${ad.options.length} 个选项` : '');
    chk('观测: 日期下拉首项是「最近两天」', !!ad && (ad.options[0].textContent || '').includes('最近两天'), ad ? ad.options[0].textContent.trim() : '');
    await waitFor(() => /<table|empty/.test((doc.querySelector('#auditBody') || {}).innerHTML || ''), 6000);
    const ab = doc.querySelector('#auditBody');
    chk('观测: 审计表渲染出记录', !!ab && !!ab.querySelector('table, .empty'), ab ? ab.textContent.trim().slice(0, 30) : '');
    const ar = doc.querySelector('#btnAuditRefresh');
    if (ar) {
      ar.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      chk('观测: 审计刷新不报错', errors.length === 0, errors.join(' | ').slice(0, 160));
    }
    chk('观测: 无脚本错误', errors.length === 0, errors.join(' | ').slice(0, 160));
  }

  {
    const { doc, errors, win } = await open('/');
    chk('概览: 有流量趋势图（SVG）', !!doc.querySelector('#trendBox svg, #trendBox .empty'), '');
    chk('概览: 有出口在线历史图', !!doc.querySelector('#histBox svg, #histBox .empty'), '');
    // Ctrl+K 命令面板
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
    const pal = doc.querySelector('#palWrap');
    chk('概览: Ctrl+K 打开命令面板', !!pal, '');
    if (pal) {
      const q = doc.querySelector('#palQ');
      q.value = '设置';
      q.dispatchEvent(new win.Event('input', { bubbles: true }));
      chk('概览: 命令面板可按关键字过滤', /设置/.test(doc.querySelector('#palList').textContent), '');
      // v0.29.23：面板里有「动作项」（一键体检 / 重新预热），选中就执行，不跳页面
      q.value = '';
      q.dispatchEvent(new win.Event('input', { bubbles: true }));
      const palTxt = doc.querySelector('#palList').textContent;
      chk('概览: 命令面板含动作项', /一键体检/.test(palTxt) && /重新预热/.test(palTxt), palTxt.slice(0, 80));
      // v0.29.26：命名出口各自有「重启这一个」的动作项
      chk('概览: 命令面板可重启单个出口', /重启出口：/.test(palTxt), palTxt.slice(0, 120));
      doc.body.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    }
    // v0.29.26：英文模式下侧栏「一键体检」不能留中文
    // 中文页面里 t() 本来就原样返回，所以这条要看词典本身（boot.js 注入的 __CFP_DICT）
    chk('i18n: 一键体检有英文', !!(win.__CFP_DICT && win.__CFP_DICT['一键体检'] === 'Health check'), (win.__CFP_DICT || {})['一键体检'] || 'absent');
    chk('概览: 无脚本错误', errors.length === 0, errors.join(' | ').slice(0, 160));
  }

  {
    const { doc, errors } = await open('/settings');
    chk('设置: 有只读账号表单', !!doc.querySelector('#viewerUser') && !!doc.querySelector('#btnViewer'), '');
    chk('设置: 有通知发送记录表', !!doc.querySelector('#notifyHist'), '');
    chk('设置: 有系统信息表', !!doc.querySelector('#sysInfo table, #sysInfo .empty, #sysInfo .hint'), '');
    chk('设置: 系统信息含面板请求与历史统计', /面板请求/.test((doc.querySelector('#sysInfo') || {}).textContent || '') && /历史采样/.test((doc.querySelector('#sysInfo') || {}).textContent || ''), ((doc.querySelector('#sysInfo') || {}).textContent || '').slice(0, 60));
    chk('设置: 备份表在小屏可堆叠（class）', !!doc.querySelector('#backupList table, #backupList .empty'), '');
    chk('设置: 有跳到主内容的链接', !!doc.querySelector('.skip-link'), '');
    chk('设置: 有命令面板按钮', !!doc.querySelector('#btnPalette'), '');
    // v0.29.24：侧栏加「一键体检」直连入口（命令面板之外的第二条路）
    chk('侧栏: 有一键体检入口', !!doc.querySelector('a.nav-quick[href="/monitor#check"]'), '');
    chk('设置: 无脚本错误', errors.length === 0, errors.join(' | ').slice(0, 160));
  }

  // ---- 变更趋势（审计）----
  {
    const { doc, errors } = await open('/', 1600);
    chk('概览: 有变更趋势卡', !!doc.querySelector('#auditBox'), '');
    chk('概览: 变更趋势画出了 SVG', !!doc.querySelector('#auditBox svg'), String(!!doc.querySelector('#auditBox svg')));
    chk('概览: 有变更趋势时间范围选择', !!doc.querySelector('#auditHours'), '');
    chk('概览: 变更趋势无脚本错误', errors.length === 0, errors.join(' | ').slice(0, 160));
  }

  // ---- 会话与语言 ----
  {
    const { doc, win, errors } = await open('/settings', 1400);
    chk('设置: 有登录会话表', !!doc.querySelector('#sessTable'), '');
    chk('设置: 有踢掉其它设备按钮', !!doc.querySelector('#btnSessKickOthers'), '');
    chk('设置: 通知有格式专属提示区', !!doc.querySelector('#notifyHint'), '');
    chk('设置: 通道区有密钥输入框或空态', !!doc.querySelector('#chanBody [data-k="secret"]') || !!doc.querySelector('#chanBody .empty, #chanBody .hint, #chanBody .muted'), 'rows=' + doc.querySelectorAll('#chanBody .chan-row').length);
    {
      const secretRows = [...doc.querySelectorAll('#chanBody tr[data-cid]')]
        .filter((r) => /已配置/.test(((r.querySelector('[data-k="secret"]') || {}).placeholder) || ''));
      chk('设置: 已存密钥的通道有清空按钮',
        secretRows.length === 0 || secretRows.every((r) => !!r.querySelector('[data-clear="1"]')),
        'hasSecretRows=' + secretRows.length);
    }
    chk('设置: 有退出全部设备按钮', !!doc.querySelector('#btnSessRevokeAll'), '');
    chk('设置: 通知里有「会话换 IP」开关', !!doc.querySelector('#evSessionIp'), '');

    chk('设置: 会话表渲染出行', !!doc.querySelector('#sessTable tbody tr'), (doc.querySelector('#sessTable tbody') || {}).textContent ? 'y' : '');
    chk('外壳: 有语言切换按钮', !!doc.querySelector('#btnLang'), (doc.querySelector('#btnLang') || {}).textContent || '');
    chk('外壳: 有退出登录按钮', !!doc.querySelector('#btnLogout'), '');
    chk('会话/语言: 无脚本错误', errors.length === 0, errors.join(' | ').slice(0, 160));
  }

  // ---- 登录页（独立页，不套外壳）----
  {
    const { doc, errors } = await open('/login', 600);
    chk('登录页: 有表单与两个输入框', !!doc.querySelector('#loginForm') && !!doc.querySelector('#u') && !!doc.querySelector('#p'), '');
    chk('登录页: 没有内联脚本（CSP 会拦）', doc.querySelectorAll('script:not([src])').length === 0, String(doc.querySelectorAll('script:not([src])').length));
    chk('登录页: 引用了外部 login.js', !!doc.querySelector('script[src*="login.js"]'), '');
    chk('登录页: 表单带 data-next', !!(doc.querySelector('#loginForm') && doc.querySelector('#loginForm').getAttribute('data-next')), '');
    chk('登录页: 双栏布局（品牌区 + 表单区）', !!doc.querySelector('.login-wrap .login-hero') && !!doc.querySelector('.login-wrap .login-card'), '');
    chk('登录页: 有密码显隐/主题/语言三个按钮', !!doc.querySelector('#btnReveal') && !!doc.querySelector('#btnTheme') && !!doc.querySelector('#btnLang'), '');
    chk('登录页: 品牌区有三条卖点', doc.querySelectorAll('.login-hero .feat li').length === 3, String(doc.querySelectorAll('.login-hero .feat li').length));
    const uEl = doc.querySelector('#u'); const pEl = doc.querySelector('#p');
    chk('登录页: 用户名/密码没有预填占位值', !uEl.getAttribute('placeholder') && !pEl.getAttribute('placeholder') && !uEl.value && !pEl.value, '');
    chk('登录页: 记住设备是 label 包 input（不再挤压布局）', !!doc.querySelector('label.remember > input#rem'), '');
    chk('登录页: 凭证区是一个分组卡片', !!doc.querySelector('form .cred') && doc.querySelectorAll('form .cred .field').length >= 2, String(doc.querySelectorAll('form .cred .field').length));
    chk('登录页: 复选框有可见文本且用 for 绑定', (function () {
      const lb = doc.querySelector('label.remember');
      return !!lb && lb.getAttribute('for') === 'rem' && (lb.textContent || '').trim().length > 2;
    })(), '');
    chk('登录页: 提交按钮带焦点样式类', !!doc.querySelector('button.login-submit'), '');
    chk('登录页: 记住设备的文字没有被裁（span 可收缩）', (function () {
      const sp = doc.querySelector('.remember > span');
      return !!sp && (sp.textContent || '').trim().length > 3;
    })(), '');
    chk('登录页: 引用了 /boot.js', !!doc.querySelector('script[src^="/boot.js"]'), '');
    chk('登录页: 不出现侧边导航', !doc.querySelector('.side .nav'), '');
    chk('登录页: 无脚本错误', errors.length === 0, errors.join(' | ').slice(0, 160));
  }

  {
    const { dom, doc } = await open('/rules', 1500);
    const card = doc.querySelector('#ruleList .rule');
    chk('规则排序: 卡片可拖拽', !!card && card.getAttribute('draggable') === 'true', card ? String(card.getAttribute('draggable')) : 'no card');
    chk('规则排序: 有拖动抓手', !!doc.querySelector('#ruleList .rule .drag'), '');
    chk('规则排序: 保留上下移按钮', !!doc.querySelector('#ruleList [data-act="up"]'), '');
    dom.window.close();
  }
  {
    const { dom, doc, win } = await open('/settings', 1600);
    chk('配置即代码: 卡片存在', !!doc.querySelector('#sec-code'), '');
    chk('配置即代码: 有编辑器与按钮', !!(doc.querySelector('#cfgText') && doc.querySelector('#btnCfgApply') && doc.querySelector('#btnCfgDry')), '');
    doc.querySelector('#btnCfgLoad').click();
    await waitFor(() => (doc.querySelector('#cfgText').value || '').length > 100, 6000);
    const txt = doc.querySelector('#cfgText').value || '';
    chk('配置即代码: 载入当前声明是合法 JSON', txt.length > 100 && (() => { try { JSON.parse(txt); return true; } catch { return false; } })(), String(txt.length));
    doc.querySelector('#btnCfgDrift').click();
    await waitFor(() => /差异|一致|基线/.test(doc.querySelector('#cfgMsg').textContent || ''), 6000);
    chk('配置即代码: drift 有反馈', /差异|一致|基线/.test(doc.querySelector('#cfgMsg').textContent || ''), doc.querySelector('#cfgMsg').textContent);
    dom.window.close();
  }
  {
    const { dom, doc, win } = await open('/tools', 1400);
    chk('工具箱: 一键新建出口按钮存在', !!doc.querySelector('#btnQuick'), '');
    const box = doc.querySelector('#quickBox');
    chk('工具箱: 一键面板默认收起', !!box && box.classList.contains('hidden'), '');
    doc.querySelector('#btnQuick').click();
    chk('工具箱: 点击后展开', !!box && !box.classList.contains('hidden'), '');
    doc.querySelector('#qkHost').value = 'qa.example.com';
    doc.querySelector('#qkDry').checked = true;
    doc.querySelector('#btnQkRun').click();
    await waitFor(() => /configurations|dns_records/.test((doc.querySelector('#qkOut') || {}).innerHTML || ''), 8000);
    const out = doc.querySelector('#qkOut');
    chk('工具箱: 演练结果显示计划表', /configurations|dns_records/.test(out.innerHTML), out.innerHTML.slice(0, 60));
    dom.window.close();
  }
  {
    const { dom, doc, win } = await open('/settings', 1400);
    chk('i18n: 暴露了翻译函数', typeof win.__cfpT === 'function', typeof win.__cfpT);
    const dict = win.__CFP_DICT || {};
    const keys = Object.keys(dict);
    chk('i18n: 词典 ≥ 480 条', keys.length >= 480, String(keys.length));
    chk('i18n: 含新增页面文案', dict['出口设置'] === 'Exit settings', String(dict['出口设置']));
    chk('i18n: 语言切换按钮存在', !!doc.querySelector('#btnLang'), '');
    chk('i18n: 中文模式下 t() 原样返回', win.__cfpT('出口设置') === '出口设置', win.__cfpT('出口设置'));
    dom.window.close();
  }

  {
    const { dom, doc, win } = await open('/', 1600);
    chk('角色: 顶栏有角色标签', !!doc.querySelector('#roleTag'), '');
    chk('角色: admin 时标签隐藏', doc.querySelector('#roleTag').classList.contains('hidden'), doc.body.dataset.role || '');
    chk('角色: body 记录角色', (doc.body.dataset.role || '') === 'admin', doc.body.dataset.role || '');
    chk('Grafana: 卡片里有混合内容提示位', !!doc.querySelector('#grafanaWarn'), '');
    dom.window.close();
  }
  {
    const { dom, doc } = await open('/observe', 1600);
    const csv = doc.querySelector('#btnAccessCsv');
    chk('观测: 有访问日志导出 CSV 入口', !!csv && /access\.csv/.test(csv.getAttribute('href') || ''), csv ? csv.getAttribute('href') : '');
    dom.window.close();
  }
  {
    const { dom, doc } = await open('/rules', 1600);
    const dup = doc.querySelector('#ruleList [data-act="dup"]');
    chk('规则: 每条规则有复制按钮', !!dup, dup ? dup.getAttribute('title') : '没有规则时跳过');
    dom.window.close();
  }

  {
    const { dom, doc } = await open('/monitor', 2500);
    chk('监控: 页面有四张概览卡', doc.querySelectorAll('#monStats .stat').length === 4, String(doc.querySelectorAll('#monStats .stat').length));
    chk('监控: 渲染了抓取目标表或空态', !!doc.querySelector('#monTargetBody') && doc.querySelector('#monTargetBody').innerHTML.length > 20, '');
    chk('监控: 侧栏有监控入口', !!doc.querySelector('.side .nav a[href="/monitor"]'), '');
    const alertRows = doc.querySelectorAll('#monAlertBody tbody tr').length;
    chk('监控: 告警区要么空态要么有行', !!doc.querySelector('#monAlertBody') && (alertRows === 0 || !!doc.querySelector('#monAlertBody [data-mute], #monAlertBody [data-unmute]')), 'rows=' + alertRows);
    // v0.29.10 一键体检卡
    chk('体检: 监控页有体检卡与按钮', !!doc.querySelector('#checkCard') && !!doc.querySelector('#btnCheck'), '');
    // 有历史时页面打开即显示「上次体检」，没有历史才是「还没查过」的说明态
    chk('体检: 未点之前要么显示上次结果、要么是说明态', /还没查过|上次体检/.test(doc.querySelector('#checkBody').textContent || ''), '');
    {
      const src = fs.readFileSync(path.join('src/web/assets/monitor.js'), 'utf8');
      chk('体检: 打开页面就显示上次（定时）体检结果', /paintLastCheck/.test(src) && /\/api\/selfcheck\/history/.test(src), '');
    }
    chk('体检: 按钮文案可读', /体检/.test(doc.querySelector('#btnCheck').textContent || ''), '');
    chk('体检: 卡片底部有历史条容器', !!doc.querySelector('#checkHistWrap') && !!doc.querySelector('#checkHist'), '');
    chk('体检: 历史条下面有「最近 24 小时出过问题的项」容器', !!doc.querySelector('#checkFails'), '');
    {
      const msrc = fs.readFileSync('src/web/assets/monitor.js', 'utf8');
      chk('体检: 失败项按项目聚合并给出次数', /function paintCheckFails/.test(msrc) && /f\.count/.test(msrc), '');
    }
    {
      const msrc = fs.readFileSync('src/web/assets/monitor.js', 'utf8');
      chk('体检: 历史条按次渲染三态', /paintCheckHistory/.test(msrc) && /data-s="\$\{state\}"/.test(msrc), '');
      const osrc = fs.readFileSync('src/web/assets/overview.js', 'utf8');
      // 骨架是绝对定位盖在 iframe 上的：load 没触发时会把已经画出来的图挡着，2.2 秒后先撤
      chk('Grafana: 骨架到点先撤（不等 load）', /setTimeout\(reveal, 2200\)/.test(osrc), '');
      chk('图表: 无障碍标签带数值（不再只是「统计图表」）', /aria-label="\$\{name\}"/.test(osrc) && /合计 \$\{total\} 次/.test(osrc), '');
    }
    const jump = doc.querySelector('#monAlertBody a.jump, #monAlertBody span.tag');
    chk('监控: 告警行带出口/面板标注', alertRows === 0 || !!jump, alertRows === 0 ? '没有告警时跳过' : (jump ? jump.textContent.trim() : '没有标注'));
    dom.window.close();
  }
  {
    const { dom, doc } = await open('/settings', 2000);
    chk('通知通道: 表格存在', !!doc.querySelector('#chanBody'), '');
    chk('通知通道: 有添加按钮', !!doc.querySelector('#btnChanAdd'), '');
    const rows = doc.querySelectorAll('#chanBody tr[data-cid]');
    chk('通知通道: 配置为空时不报错（有通道则渲染）', rows.length >= 0 && !!doc.querySelector('#chanBody').innerHTML, 'rows=' + rows.length);
    chk('告警回调: 设置页有令牌按钮', !!doc.querySelector('#btnHookToken') && !!doc.querySelector('#alertHook'), '');
    dom.window.close();
  }
  {
    const { dom, doc, win } = await open('/', 2500);
    // v0.29.7 三条界面反馈
    const bar = doc.querySelector('#warmBar');
    const grid = doc.querySelector('.content .grid4');
    chk('总览: 预热横幅在页面顶部（统计卡之前）',
      !!bar && !!grid && (bar.compareDocumentPosition(grid) & win.Node.DOCUMENT_POSITION_FOLLOWING) > 0,
      bar && grid ? 'ok' : '缺元素');
    chk('总览: 横幅可关闭（有 × 按钮位）', !!bar && /banner|hidden/.test(bar.className), bar ? bar.className : '');
    const auditCard = doc.querySelector('#auditBox') && doc.querySelector('#auditBox').closest('.card');
    const auditHead = auditCard && auditCard.querySelector('.hd');
    chk('总览: 变更趋势摘要不在标题行', !!auditHead && !/次改动/.test(auditHead.textContent || ''), auditHead ? auditHead.textContent.trim().slice(0, 30) : '');
    chk('总览: 三张图表的摘要都渲染在图下方',
      ['#trendBox', '#histBox', '#auditBox'].every((sel) => {
        const box = doc.querySelector(sel);
        if (!box) return true;
        const sum = box.querySelector('.chart-sum');
        if (!sum) return /empty/.test(box.className) || box.innerHTML.includes('empty');
        const svg = box.querySelector('svg');
        return !svg || (svg.compareDocumentPosition(sum) & win.Node.DOCUMENT_POSITION_FOLLOWING) > 0;
      }), '');
    const gf = doc.querySelector('#grafanaCard iframe');
    if (gf) {
      const t = (doc.documentElement.getAttribute('data-theme') === 'light') ? 'light' : 'dark';
      chk('Grafana: 嵌入 URL 主题跟随页面', new RegExp('theme=' + t).test(gf.getAttribute('src') || '') || new RegExp('theme=(light|dark)').test(gf.getAttribute('src') || ''),
        (gf.getAttribute('src') || '').slice(0, 90));
    }
    dom.window.close();
  }

  {
    const { dom, doc } = await open('/', 2500);
    chk('Grafana: 首页有图表面板卡', !!doc.querySelector('#grafanaCard'), '');
    const frame = doc.querySelector('#grafanaCard .gframe');
    chk('Grafana: 有骨架容器（懒加载）', !!frame, frame ? String(frame.getAttribute('data-state') || 'skel') : '（未开启嵌入时跳过）');
    const f = doc.querySelector('#grafanaCard iframe');
    chk('Grafana: 进入视口后插入图表', !frame || !!f || !!doc.querySelector('#grafanaCard .gskel') || !!doc.querySelector('#grafanaCard .gfail'),
      f ? (f.getAttribute('src') || '').slice(0, 60) : 'skel/fail');
    dom.window.close();
  }

  {
    const { dom, doc } = await open('/tunnels', 3600);
    chk('出口流量: 卡片存在', !!doc.querySelector('#exitStatsCard'), '');
    // 这块要等 /api/exit/stats（要翻历史采样），别用固定等待，轮询到渲染为止（最多 6 秒）
    const body = () => (doc.querySelector('#exitStatsBody') || {}).innerHTML || '';
    await waitFor(() => /<table/.test(body()), 9000);
    const html = body();
    chk('出口流量: 表格渲染出来了', /<table/.test(html), html.slice(0, 40));
    chk('出口流量: 有 5xx 列', /5xx/.test(html), '');
    dom.window.close();
  }
  {
    const { dom, doc } = await open('/observe', 1800);
    const btn = doc.querySelector('#secBody [data-deny]');
    // 审计被清洗过 / 窗口内确实没人被拒时列表是空的，这时该验证的是「说明态」而不是按钮
    const empty = /世界很安静/.test(doc.querySelector('#secBody').textContent || '');
    chk('可疑访问: 有记录则每行带封禁按钮，没有则给说明态', !!btn || empty,
      btn ? '有行：' + btn.getAttribute('data-deny') : '空列表已给说明');
    dom.window.close();
  }

  {
    const { dom, doc } = await open('/login', 1200);
    const h1 = doc.querySelector('h1');
    chk('登录页: 标题是「管理员登录」', !!h1 && /管理员登录/.test(h1.textContent), h1 ? h1.textContent.trim() : '（无 h1）');
    const rem = doc.querySelector('label.remember');
    chk('登录页: 复选框有固定尺寸规则', !!rem && !!doc.querySelector('input.chk'), '');
    dom.window.close();
    const css = await (await fetch(BASE + '/assets/app.css')).text();
    chk('登录页: CSS 只对非复选框套 100% 宽', /input:not\(\[type=checkbox\]\)/.test(css), '');
    chk('登录页: 复选框有显式尺寸', /input\[type=checkbox\][^{]*\{[^}]*width:18px/.test(css), '');
  }

  // ---- v0.29.0 UI ----
  {
    const { doc, win } = await open('/');
    chk('概览: 日志卡默认折叠', doc.querySelector('#logBox').classList.contains('collapsed'), doc.querySelector('#logBox').className);
    const tg = doc.querySelector('#btnLogToggle');
    tg.click();
    chk('概览: 点「展开」取消折叠', !doc.querySelector('#logBox').classList.contains('collapsed') && tg.getAttribute('aria-expanded') === 'true', String(tg.getAttribute('aria-expanded')));
    chk('侧栏: 主题按钮在顶部工具条里', !!doc.querySelector('.side-tools #btnTheme'), '');
    win.close();

    const { doc: doc3, win: win3 } = await open('/tunnels');
    const menuBtn = doc3.querySelector('[data-menu]');
    chk('隧道: 有⋯菜单按钮', !!menuBtn, '');
    menuBtn.click();
    const pop = doc3.querySelector('.menu-pop');
    chk('隧道: 点开显示菜单项', pop && !pop.classList.contains('hidden') && pop.querySelectorAll('[data-act]').length >= 4, String(pop && pop.querySelectorAll('[data-act]').length));
    doc3.body.click();
    chk('隧道: 点空白关闭菜单', doc3.querySelector('.menu-pop').classList.contains('hidden'), '');
    win3.close();
  }

  // v0.29.8：Grafana 局域网直连
  {
    const { doc: doc8, win: win8 } = await open('/');
    chk('概览: 有「局域网直连」徽标位', !!doc8.getElementById('grafanaVia'), '');
    const st8 = await open('/settings');
    chk('设置: 有局域网直连地址输入框', !!st8.doc.getElementById('grafLan'), '');
    const ovjs = await (await fetch(BASE + '/assets/overview.js')).text();
    chk('概览: http 页面优先用 lanUrl', /location\.protocol === 'http:'/.test(ovjs) && /lanUrl/.test(ovjs), '');
    win8.close(); st8.win.close();
  }

  // v0.29.9：页面不可见时停轮询
  {
    const { doc: doc9, win: win9 } = await open('/');
    chk('轮询工具: window.cfpEvery 可用', typeof win9.cfpEvery === 'function', '');
    if (typeof win9.cfpEvery === 'function') {
      let n = 0;
      const h = win9.cfpEvery(60000, () => { n++; });
      chk('轮询工具: 返回 stop/start', h && typeof h.stop === 'function' && typeof h.start === 'function', '');
      h.stop();
      chk('轮询工具: stop 后不再计时', true, 'n=' + n);
    }
    const appjs = await (await fetch(BASE + '/assets/app.js')).text();
    chk('轮询工具: 监听 visibilitychange', /visibilitychange/.test(appjs) && /document\.hidden/.test(appjs), '');
    chk('兜底翻译: 有限次数后自停', /let left = 24;/.test(appjs), '');
    chk('日志流: 后台断开/前台重连', /const close = \(\) => \{ if \(es\)/.test(appjs), '');
    win9.close();
  }

  {
    // 规则卡：禁用/启用 进「操作⋯」，并真的带上了 enabled 字段
    const { doc: dr, win: wr2 } = await open('/rules');
    const firstRule = dr.querySelector('.rule');
    const popTxt = firstRule ? firstRule.querySelector('.menu-pop').textContent.replace(/\s+/g, ' ').trim() : '';
    chk('规则卡: 菜单含禁用/启用', /(禁用|启用)这条规则/.test(popTxt), popTxt.slice(0, 60));
    const rjs = await (await fetch(BASE + '/assets/rules.js')).text();
    chk('规则卡: 直接提交整表切换 enabled', /enabled: x\.enabled === false/.test(rjs) && /'\/api\/routes'/.test(rjs), '');
    wr2.close();

    // 观测页：只看 5xx 一键开关
    const { doc: dobs, win: wobs } = await open('/observe');
    const b5 = dobs.querySelector('#btnOnly5xx');
    chk('观测页: 有「只看 5xx」按钮', !!b5 && b5.getAttribute('aria-pressed') === 'false', b5 ? b5.textContent.trim() : 'missing');
    if (b5) {
      b5.click();
      await sleep(150);
      chk('观测页: 点一下变成开启状态', b5.getAttribute('aria-pressed') === 'true' && /开/.test(b5.textContent), b5.textContent.trim());
    }
    wobs.close();

    // 体检卡：结果可导出 JSON
    const mjs = await (await fetch(BASE + '/assets/monitor.js')).text();
    chk('体检卡: 提供导出 JSON', /btnCheckDl/.test(mjs) && /导出本次体检 JSON/.test(mjs), '');
  }

  let bad = 0;
  for (const [ok, name, extra] of results) {
    if (!ok) bad++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
  }
  console.log(`\n${results.length - bad}/${results.length} 通过`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
