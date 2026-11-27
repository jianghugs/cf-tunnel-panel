#!/usr/bin/env node
'use strict';
/* 从 src/server.js 与 src/routes/*.js 里扫出真实注册的 /api 路由，生成 / 校验 docs/openapi.json。
   用法：
     node tools/openapi.js --gen     重新生成 docs/openapi.json
     node tools/openapi.js --check   CI 用：代码里有、文档里没有 → 非零退出
   设计原则：路由表以代码为唯一事实源，文档只是镜像；新增接口忘了写文档会被 CI 挡下。 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'src', 'server.js');
const META = path.join(ROOT, 'docs', 'openapi.meta.json');
const OUT = path.join(ROOT, 'docs', 'openapi.json');

/* 非 /api 的入口（网页、静态资源、指标）不进 OpenAPI，但 check 时要认得，别报缺失 */
const NON_API = new Set(['/', '/login', '/logout', '/metrics', '/healthz', '/badge.svg', '/boot.js']);

/** 从一行代码里抽出正则字面量的源码：/^\/api\/x$/ → ^\/api\/x$ */
function regexSrcAt(line, slashIdx) {
  let i = slashIdx + 1;
  let out = '';
  let inClass = false;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '\\') { out += ch + (line[i + 1] || ''); i += 2; continue; }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    if (ch === '/' && !inClass) break;
    out += ch;
    i += 1;
  }
  return out;
}

/** 把正则源码规整成 OpenAPI 路径：去锚点、反转义、参数段统一成 {id}/{id2}… */
function regexToPath(src) {
  let s = src.replace(/^\^/, '').replace(/\$$/, '');
  s = s.replace(/\\\//g, '/');
  /* 非捕获分组与可选量词先摊平：(?:x)? → (x)，避免分组内容被整段丢掉 */
  s = s.replace(/\(\?:/g, '(').replace(/\)\?/g, ')');
  /* 字符类 + 量词：[0-9a-fA-F-]{36} */
  s = s.replace(/\[[^\]]*\]\{\d+(?:,\d*)?\}/g, '{p}');
  /* 其余字符类（可能带 * + ? 量词）：[^/]+ 之类 */
  s = s.replace(/\[[^\]]*\][*+?]?/g, '{p}');
  /* 捕获组 / 内联分组：(a|b) */
  s = s.replace(/\(([^()]*)\)/g, '{p}');
  /* 已经写成 {xxx} 的占位符 */
  s = s.replace(/\{[^}]*\}/g, '{p}');
  /* 依次命名，避免同名重复：第一个叫 id，往后 id2、id3… */
  let i = 0;
  s = s.replace(/\{p\}/g, () => {
    const n = i;
    i += 1;
    return n === 0 ? '{id}' : `{id${n + 1}}`;
  });
  /* 清掉参数两侧残留的括号（来自 (?:…) / (…) 的分组结构） */
  s = s.replace(/\(\/?(\{id[0-9]*\})\)/g, '/$1');
  s = s.replace(/\/\/+/g, '/');
  return s;
}

function scanRoutes() {
  // 路由可能分散在 src/server.js 与 src/routes/*.js（C8 拆分后），一起扫
  const ROUTE_DIR = path.join(ROOT, 'src', 'routes');
  const files = [SERVER];
  if (fs.existsSync(ROUTE_DIR)) {
    for (const f of fs.readdirSync(ROUTE_DIR)) {
      if (f.endsWith('.js')) files.push(path.join(ROUTE_DIR, f));
    }
  }
  const src = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const found = new Map(); /* "METHOD /path" -> {method, path, kind} */
  const lines = src.split('\n');

  lines.forEach((line) => {
    if (!line.includes('/api') && !line.includes('NON_API')) return;
    const mMethod = line.match(/req\.method === '([A-Z]+)'/);
    const method = mMethod ? mMethod[1] : 'GET';

    /* 1) 字面量：p === '/api/xxx'，一行可能有多个（用 || 串起来） */
    const litRe = /p\s*===\s*'(\/api\/[^']*)'/g;
    let m;
    while ((m = litRe.exec(line)) !== null) {
      const p = m[1];
      found.set(`${method} ${p}`, { method, path: p, kind: 'exact' });
    }

    /* 2) 正则：p.match(/^\/api\/...$/) 或 /^\/api\/...$/.test(p) */
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] !== '/') continue;
      const next = line[i + 1];
      if (next !== '^' && next !== '(') continue;
      const body = regexSrcAt(line, i);
      if (!body.includes('\\/api\\/') && !body.includes('/api/')) continue;
      const p = regexToPath(body);
      if (!p.startsWith('/api/')) continue;
      found.set(`${method} ${p}`, { method, path: p, kind: 'regex' });
      i += body.length;
    }
  });

  return [...found.values()].sort((a, b) =>
    (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
}

function loadMeta() {
  try {
    return JSON.parse(fs.readFileSync(META, 'utf8'));
  } catch (e) {
    return { info: {}, summaries: {}, tags: {}, prefixTags: [] };
  }
}

function tagOf(p, meta) {
  let best = '';
  let tag = '其他';
  (meta.prefixTags || []).forEach(([prefix, t]) => {
    if (p === prefix || p.startsWith(prefix.endsWith('/') ? prefix : prefix + '/') || p.startsWith(prefix)) {
      if (prefix.length > best.length) { best = prefix; tag = t; }
    }
  });
  return tag;
}

function buildSpec(routes, meta) {
  const paths = {};
  routes.forEach((r) => {
    const key = `${r.method} ${r.path}`;
    const summaries = meta.summaries || {};
    const summary = summaries[key] || summaries[r.path] || '';
    const tag = tagOf(r.path, meta);
    const params = [];
    if (r.path.includes('{id}')) {
      params.push({ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: '资源标识' });
    }
    paths[r.path] = paths[r.path] || {};
    paths[r.path][r.method.toLowerCase()] = {
      tags: [tag],
      summary: summary || `${r.method} ${r.path}`,
      description: summary ? undefined : '（未填写说明：见 src/server.js 对应分支）',
      parameters: params.length ? params : undefined,
      responses: {
        200: { description: '成功返回 JSON，包含 ok: true 与结果字段' },
        400: { description: '参数或后端错误，JSON 里 error 字段给出原因' },
        401: { description: '未登录或会话过期' },
        409: { description: '本实例为备份槽位（STANDBY），写操作被拒绝' },
      },
    };
  });

  return {
    openapi: '3.0.3',
    info: Object.assign({ title: 'cf-tunnel-panel API', version: 'auto' }, meta.info || {}),
    servers: [{ url: '/' }],
    tags: Object.entries(meta.tags || {}).map(([name, description]) => ({ name, description })),
    paths,
  };
}

function main() {
  const mode = process.argv.includes('--check') ? 'check' : 'gen';
  const meta = loadMeta();
  const routes = scanRoutes();
  const spec = buildSpec(routes, meta);

  if (mode === 'gen') {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(spec, null, 2) + '\n');
    const opCount = Object.values(spec.paths).reduce((n, x) => n + Object.keys(x).length, 0);
    console.log(`已写入 ${path.relative(ROOT, OUT)}：${Object.keys(spec.paths).length} 条路径 / ${opCount} 个操作`);
    const summaries = meta.summaries || {};
    const missing = routes.filter((r) => !(summaries[`${r.method} ${r.path}`] || summaries[r.path]));
    if (missing.length) {
      console.log(`提示：${missing.length} 个操作还没有写说明（不阻塞）`);
    }
    return 0;
  }

  /* check：代码里扫到的 /api 路由必须在文档里出现 */
  const doc = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const missing = [];
  routes.forEach((r) => {
    const item = doc.paths && doc.paths[r.path];
    if (!item || !item[r.method.toLowerCase()]) missing.push(`${r.method} ${r.path}`);
  });
  if (missing.length) {
    console.error(`OpenAPI 文档缺了 ${missing.length} 个接口（改完接口记得跑 node tools/openapi.js --gen）：`);
    missing.forEach((x) => console.error('  - ' + x));
    return 1;
  }
  const opCount = Object.values(doc.paths).reduce((n, x) => n + Object.keys(x).length, 0);
  console.log(`OpenAPI 覆盖检查通过：${Object.keys(doc.paths).length} 条路径 / ${opCount} 个操作，代码里的路由全部有文档`);
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { scanRoutes, buildSpec, regexToPath };
