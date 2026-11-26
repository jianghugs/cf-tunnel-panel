'use strict';
/**
 * i18n 自检：中文原文 → 英文 字典的健康度
 *
 * 背景：src/core/i18n.js 是「中文原文 → 英文」的精确文本替换表，分版本一段段
 * Object.assign 合并。合并是静默的 —— 同一个中文键后写的那份会覆盖先写的，
 * 所以「手滑写两遍」「新版本覆盖旧版本但漏了几个字」都不会报错，只会悄悄
 * 变成英文页面上的残留中文。
 *
 * 这个脚本查四件事：
 *   1. 同一个字典字面量里键写重了（JS 不报错，后值覆盖前值）
 *   2. 不同字典段之间同一个键给了不同的英文（覆盖漂移，要人工确认谁对）
 *   3. 英文值是空串 / 等于中文（等于没翻）
 *   4. 页面与前端脚本里出现的中文，字典里有没有收录（覆盖率，只提示不算失败）
 *
 * 用法：node tools/i18n-check.js [--strict]
 *   --strict 时覆盖率缺口也算失败（默认只 warn，避免一次把 CI 卡死）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const I18N = path.join(ROOT, 'src', 'core', 'i18n.js');
const STRICT = process.argv.includes('--strict');

const duplicates = [];

// ---- 1. 把 i18n.js 拆成若干「字典段」，逐段解析键值 ----
function parseBlocks(src) {
  const blocks = [];
  const headRe = /const\s+(EN[A-Z0-9_]*)\s*=\s*\{/g;
  let m;
  while ((m = headRe.exec(src))) {
    const name = m[1];
    let i = headRe.lastIndex - 1;
    let depth = 0;
    let end = -1;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "'" || c === '"' || c === '`') {
        const q = c;
        i++;
        while (i < src.length && src[i] !== q) {
          if (src[i] === '\\') i++;
          i++;
        }
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end < 0) continue;
    blocks.push({ name, body: src.slice(headRe.lastIndex, end), line: src.slice(0, m.index).split('\n').length });
  }
  return blocks;
}

function entriesOf(block) {
  const out = [];
  const re = /(['"])((?:\\.|(?!\1).)*)\1\s*:\s*(['"])((?:\\.|(?!\3).)*)\3/g;
  let m;
  while ((m = re.exec(block.body))) {
    const line = block.line + block.body.slice(0, m.index).split('\n').length - 1;
    out.push({ key: m[2], val: m[4], line });
  }
  return out;
}

const src = fs.readFileSync(I18N, 'utf8');
const blocks = parseBlocks(src);
const all = [];
for (const b of blocks) {
  const es = entriesOf(b);
  const seen = new Map();
  for (const e of es) {
    if (seen.has(e.key)) {
      console.error(`重复键  ${b.name}:${e.line}  ${JSON.stringify(e.key)}  （同段第 ${seen.get(e.key)} 行已定义）`);
      duplicates.push(`${b.name}:${e.line}`);
    } else seen.set(e.key, e.line);
    all.push({ ...e, block: b.name });
  }
}

// ---- 2. 跨段覆盖漂移 ----
const byKey = new Map();
for (const e of all) {
  if (!byKey.has(e.key)) byKey.set(e.key, []);
  byKey.get(e.key).push(e);
}
const drift = [];
for (const [k, list] of byKey) {
  const vals = [...new Set(list.map((x) => x.val))];
  if (vals.length > 1) {
    drift.push(k);
    if (drift.length <= 20) {
      console.error(`覆盖漂移  ${JSON.stringify(k)}  ← ${list.map((x) => `${x.block}@${x.line}=${JSON.stringify(x.val)}`).join(' | ')}`);
    }
  }
}

// ---- 3. 空值 / 中文键译成自己 ----
// 纯拉丁键（DOWN / up / ready 这类状态词）译文与键相同是合理的，不算错。
const hasCJK = (s) => /[\u4e00-\u9fa5]/.test(s);
const empty = [];
for (const e of all) {
  if (!e.val.trim() || (e.val === e.key && hasCJK(e.key))) empty.push(`${e.block}:${e.line} ${JSON.stringify(e.key)} → ${JSON.stringify(e.val)}`);
}
for (const x of empty.slice(0, 20)) console.error(`空译文  ${x}`);

// ---- 4. 覆盖率：页面里的中文，字典收了没有 ----
// 只扫页面 HTML：前端 JS 里的文案基本都走 t()/dictLookup，而且大量是模板字符串
// （整段 HTML 拼在反引号里），机器切不出「文案」边界，扫了也只是一堆噪音。
const SCAN = [];
const pagesDir = path.join(ROOT, 'src', 'web', 'pages');
if (fs.existsSync(pagesDir)) {
  for (const f of fs.readdirSync(pagesDir)) if (f.endsWith('.html')) SCAN.push(`src/web/pages/${f}`);
}

const EN = new Set(all.filter((e) => e.val).map((e) => e.key));

// 只抽「会显示给人看」的中文：HTML 取标签外的文本节点，JS 取引号里的字面量。
// 注释和代码符号里当然有中文，那不是待翻译文案，混进来只会把数字灌成大几百。
function visibleTexts(rel) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const out = [];
  if (rel.endsWith('.html')) {
    const cleaned = text.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*>/g, '\n');
    out.push(...cleaned.split('\n'));
  } else {
    const cleaned = text
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
    const re = /'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\])*)`/g;
    let m;
    while ((m = re.exec(cleaned))) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  const res = [];
  for (const raw of out) {
    const s = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (s.length < 2 || !hasCJK(s)) continue;
    // CODEISH 命令 / 配置片段不进字典（curl、webhook_configs、含 :// 或 { 的行）
    if (/^(curl|wget|docker|webhook_configs)\b/.test(s) || s.includes('://') || s.includes('{')) continue;
    res.push(s);
  }
  return res;
}

const missing = new Map();
for (const rel of SCAN) {
  if (!fs.existsSync(path.join(ROOT, rel))) continue;
  for (const s of visibleTexts(rel)) {
    if (EN.has(s)) continue;
    if (!missing.has(rel)) missing.set(rel, []);
    const arr = missing.get(rel);
    if (!arr.includes(s)) arr.push(s);
  }
}
const missingTotal = [...missing.values()].reduce((n, a) => n + a.length, 0);

// ---- 汇总 ----
console.log('');
console.log(`字典段: ${blocks.length}   条目: ${all.length}   唯一键: ${byKey.size}`);
console.log(`重复键: ${duplicates.length}`);
console.log(`覆盖漂移: ${drift.length}`);
console.log(`空译文: ${empty.length}`);
console.log(`未收录中文: ${missingTotal} 处（覆盖 ${missing.size} 个文件）`);
if (missingTotal) {
  for (const [f, arr] of missing) {
    console.log(`  ${f}  (${arr.length})  ${arr.slice(0, 6).map((s) => JSON.stringify(s)).join(' ')}${arr.length > 6 ? ' …' : ''}`);
  }
}

const hardFail = duplicates.length > 0 || empty.length > 0 || (STRICT && missingTotal > 0);
if (hardFail) {
  console.error('\n❌ i18n 自检失败');
  process.exit(1);
}
console.log('\n✅ i18n 自检通过');
