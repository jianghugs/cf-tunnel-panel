#!/usr/bin/env node
'use strict';
/**
 * 模块 require 自检。
 *
 * 为什么需要它：把路由从 server.js 拆到 src/routes/*.js 时，模块头是整体复制的，
 * 很容易漏掉某个 Node 内置模块（net / dns / http / crypto / fs / path…）。
 * 漏掉时 `node --check` 完全看不出问题（`net.isIP(...)` 语法上完全合法），
 * 只在**运行到那一行**才抛 `net is not defined` —— 0.29.55 就是这样把「一键封禁」打挂的。
 *
 * 检查两件事：
 *   1) 相对路径的 require 能否真的解析到文件（`./core/audit` 搬到别的目录就会挂）；
 *   2) Node 内置模块被用到却没 require（`net.` / `dns.` …）。
 *
 * 注意：用法判定直接看原文，不做「先剥字符串再剥注释」那套——那段剥法在含模板字符串的
 * 文件上会因为反引号配对错位吞掉整段代码，导致检查器对真问题视而不见（实测踩过）。
 * 代价是注释里写 `net.` 也会被当成用法，可以接受：补一行 require 或改注释都行。
 *
 * 用法：node tools/check-requires.js [--quiet]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const CORE = ['assert','buffer','child_process','crypto','dgram','dns','events','fs','http','http2','https',
  'net','os','path','perf_hooks','querystring','readline','stream','string_decoder','tls','tty','url','util',
  'v8','vm','worker_threads','zlib'];

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const errors = [];
const files = walk(SRC, []);

for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);

  // 1) 相对 require 必须能解析到真实文件
  const reqRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = reqRe.exec(raw))) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    const base = path.resolve(path.dirname(file), spec);
    const hit = [base, base + '.js', base + '.json',
      path.join(base, 'index.js'), path.join(base, 'index.json')].some((x) => {
      try { return fs.statSync(x).isFile(); } catch { return false; }
    });
    if (!hit) errors.push(`${rel}: require('${spec}') 解析不到文件`);
  }

  // 2) 内置模块被用却没 require
  for (const mod of CORE) {
    if (!new RegExp(`(^|[^\\w$.])${mod}\\s*\\.`).test(raw)) continue;
    const declared =
      new RegExp(`(?:const|let|var)\\s+${mod}\\s*=\\s*require\\(\\s*['"]${mod}['"]\\s*\\)`).test(raw)
      || new RegExp(`require\\(\\s*['"]${mod}['"]\\s*\\)`).test(raw);
    // 同名局部变量/参数也算声明：参数位、赋值、解构、箭头参数
    const shadowed =
      new RegExp(`(?:const|let|var)\\s+${mod}\\b`).test(raw)
      || new RegExp(`[\\[(,]\\s*${mod}\\s*[,)=]`).test(raw)
      || new RegExp(`\\b${mod}\\s*=>`).test(raw);
    if (!declared && !shadowed) errors.push(`${rel}: 用到 ${mod}. 但没 require('${mod}')`);
  }
}

if (!errors.length) {
  if (!process.argv.includes('--quiet')) console.log(`require 自检通过：${files.length} 个文件，0 处问题`);
  process.exit(0);
}
console.error('require 自检失败：');
for (const e of errors) console.error('  · ' + e);
console.error(`\n共 ${errors.length} 处。漏 require 只在运行期炸（node --check 查不出），改完请跑 test/api.test.mjs。`);
process.exit(1);
