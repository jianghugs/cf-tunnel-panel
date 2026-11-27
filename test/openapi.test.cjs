'use strict';
/**
 * OpenAPI 覆盖自检
 *
 * 两件事：
 *   1. docs/openapi.json 能被解析，且路径数量没塌（< 80 说明生成器坏了）
 *   2. tools/openapi.js --check 退出码 0 —— 代码里每个 /api 路由都在文档里
 * 目的是：以后新增接口忘了写文档时，测试直接红。
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
let bad = 0;
const check = (name, ok, extra) => {
  if (ok) console.log(`PASS  ${name}`);
  else {
    bad++;
    console.log(`FAIL  ${name}${extra ? '  ' + extra : ''}`);
  }
};

let spec = null;
try {
  spec = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'openapi.json'), 'utf8'));
} catch (e) {
  console.log(`FAIL  能读到 docs/openapi.json  ${e.message}`);
  process.exit(1);
}

const paths = Object.keys(spec.paths || {});
const ops = paths.reduce((n, p) => n + Object.keys(spec.paths[p]).length, 0);
console.log(`INFO  ${paths.length} 条路径 / ${ops} 个操作`);

check('openapi: 有 paths', paths.length > 0);
check('openapi: 路径数量正常（>= 80）', paths.length >= 80, `实际 ${paths.length}`);
check('openapi: 每个操作都有 summary', paths.every((p) => Object.values(spec.paths[p]).every((o) => (o.summary || '').trim())));
check('openapi: info.title 存在', !!(spec.info && spec.info.title));

const r = spawnSync(process.execPath, [path.join(root, 'tools', 'openapi.js'), '--check'], { encoding: 'utf8' });
const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
if (out) console.log(out);
check('openapi: 代码里的路由全部有文档（--check 退出码 0）', r.status === 0);

console.log('');
if (bad) {
  console.log(`${bad} failed`);
  process.exit(1);
}
console.log('OpenAPI 自检通过');
