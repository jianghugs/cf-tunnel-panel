'use strict';
/**
 * 运行期指标（进程内存，重启归零）。
 *
 * 只放"Prometheus 想要、但原来没有"的那几项：
 *   - Caddy 配置下发耗时 / 失败累计（原来只能看 caddy.ok 的瞬时真假）
 *   - 最近一次体检的失败/警告项数（原来只有 /api/selfcheck 的 JSON）
 *   - 进程 RSS、事件循环延迟（判断"面板卡了"还是"边缘卡了"）
 *
 * 之所以单独一个模块而不是塞进 insight.js：insight 是纯计算 + 读历史文件，
 * 这里是被 pusher / monitor / server 反过来写的计数，放一起会绕成环。
 */
const counters = Object.create(null);
const gauges = Object.create(null);

function inc(name, by = 1) { counters[name] = (counters[name] || 0) + by; return counters[name]; }
function set(name, v) { const n = Number(v); gauges[name] = Number.isFinite(n) ? n : 0; return gauges[name]; }
function get(name) { return counters[name] || 0; }

// 事件循环延迟：每 20ms 一个采样点，取 p99 与 max（毫秒）
let _el = null;
try {
  const { monitorEventLoopDelay } = require('perf_hooks');
  _el = monitorEventLoopDelay({ resolution: 20 });
  _el.enable();
  if (_el.unref) _el.unref();
} catch { _el = null; }

function loopDelay() {
  if (!_el) return null;
  const p99 = _el.percentile(99) / 1e6;
  const max = _el.max / 1e6;
  _el.reset();
  if (!Number.isFinite(p99) || !Number.isFinite(max)) return null;
  return { p99, max };
}

function snapshot() {
  return { counters: Object.assign({}, counters), gauges: Object.assign({}, gauges), loop: loopDelay(), rss: process.memoryUsage().rss };
}

module.exports = { inc, set, get, snapshot, loopDelay };
