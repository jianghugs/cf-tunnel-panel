'use strict';
/**
 * i18n 字典自检（包一层，让 npm test 也能跑到）
 *
 * 真正的逻辑在 tools/i18n-check.js，这里只负责调用 + 判定：
 *   - 退出码必须是 0（重复键 / 空译文算硬失败）
 *   - 输出里「重复键: 0」与「空译文: 0」
 * 覆盖率缺口只打印，不算失败。
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const r = spawnSync(process.execPath, [path.join(root, 'tools', 'i18n-check.js')], { encoding: 'utf8' });

const out = `${r.stdout || ''}${r.stderr || ''}`;
process.stdout.write(out.endsWith('\n') ? out : out + '\n');

let bad = 0;
const check = (name, ok) => {
  if (ok) console.log(`PASS  ${name}`);
  else {
    bad++;
    console.log(`FAIL  ${name}`);
  }
};

check('i18n: 自检脚本正常结束', r.status === 0);
check('i18n: 没有重复键', /重复键: 0/.test(out));
check('i18n: 没有空译文', /空译文: 0/.test(out));

// 覆盖率只报告，不判死
const cov = out.match(/未收录中文: (\d+) 处/);
if (cov) console.log(`INFO  未收录中文 ${cov[1]} 处（覆盖率告警，不阻塞）`);

console.log('');
if (bad) {
  console.log(`${bad} failed`);
  process.exit(1);
}
console.log('i18n 自检通过');
