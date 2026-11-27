#!/usr/bin/env node
'use strict';
/**
 * 校验告警规则的两份副本是否一致。
 *
 *   tools/monitoring/prometheus/alerts.yml   ← 监控栈真正加载的那份
 *   docs/prometheus-alerts.yml               ← 仓库里给人看的那份（docs/ 会被烘进镜像供 /api/openapi 之外的文档用）
 *
 * 为什么要单独一条检查：这两份是手工同步的，改一份忘了另一份，线上告警就会跟文档说的不一样。
 * 以前只在 api 套件里断言（跑得慢、CI 里不一定跑），现在提到独立脚本，CI 单独一步就能挡。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MON = path.join(ROOT, 'tools/monitoring/prometheus/alerts.yml');
const DOC = path.join(ROOT, 'docs/prometheus-alerts.yml');

function read(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

const mon = read(MON);
const doc = read(DOC);

if (mon === null || doc === null) {
  console.error('✗ 缺文件：' + (mon === null ? MON : DOC));
  process.exit(1);
}
if (mon === doc) {
  const n = mon.split('\n').length;
  console.log('✓ 告警规则两份副本一致（' + mon.length + ' 字节 / ' + n + ' 行）');
  process.exit(0);
}

const a = mon.split('\n');
const b = doc.split('\n');
let i = 0;
while (i < a.length && i < b.length && a[i] === b[i]) i += 1;

console.error('✗ 告警规则两份副本不一致');
console.error('  监控栈 ' + MON + '  ' + mon.length + ' 字节 / ' + a.length + ' 行');
console.error('  文档   ' + DOC + '  ' + doc.length + ' 字节 / ' + b.length + ' 行');
console.error('  首个差异在第 ' + (i + 1) + ' 行：');
console.error('    监控栈: ' + JSON.stringify(a[i] === undefined ? '<没有这一行>' : a[i]));
console.error('    文档  : ' + JSON.stringify(b[i] === undefined ? '<没有这一行>' : b[i]));
console.error('  修法：改完 tools/monitoring/prometheus/alerts.yml 之后复制到 docs/prometheus-alerts.yml（或反过来）。');
process.exit(1);
