'use strict';
/**
 * 路径与全局常量
 * 从 src/server.js 按职责拆出（v0.9.0），仅做搬运，行为不变。
 */

const SRC_DIR = require('path').join(__dirname, '..'); // src/

const http=require('http');
  const fs=require('fs');
const path=require('path');

function pkgVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(SRC_DIR, '..', 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}
const VERSION = pkgVersion();

// 负载均衡策略白名单（Caddy reverse_proxy 内置策略）
const LB_POLICIES = ['round_robin', 'random', 'first', 'least_conn', 'ip_hash', 'uri_hash', 'header', 'cookie'];

const PORT = Number(process.env.PORT || 8090);
const DATA_DIR = process.env.DATA_DIR || path.join(SRC_DIR, '..', 'data');
const CADDY_ADMIN = process.env.CADDY_ADMIN || 'http://127.0.0.1:2019';
const CLOUDFLARED = process.env.CLOUDFLARED_BIN || '/usr/local/bin/cloudflared';
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

const WEB_DIR = path.join(SRC_DIR, 'web');
const ASSET_DIR = path.join(WEB_DIR, 'assets');
const PAGE_DIR = path.join(WEB_DIR, 'pages');
const ASSET_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};
const PAGES = [
  { path: '/', file: 'overview', title: '总览', ico: '◎' },
  { path: '/tunnels', file: 'tunnels', title: '隧道出口', ico: '⇄' },
  { path: '/rules', file: 'rules', title: '代理规则', ico: '⛓' },
  { path: '/tools', file: 'tools', title: '工具箱', ico: '⚒' },
  { path: '/observe', file: 'observe', title: '观测', ico: '◔' },
  { path: '/monitor', file: 'monitor', title: '监控', ico: '◈' },
  { path: '/settings', file: 'settings', title: '设置', ico: '⚙' },
];
// Caddy 把 access log 以 JSON 行写到这里；Caddy 容器里挂在 /logs，面板侧读同一份文件
const CADDY_LOG_DIR = process.env.CADDY_LOG_DIR || '/logs';
const ACCESS_LOG_FILE = path.join(DATA_DIR, 'caddy-logs', 'access.log');
const accessLogPathForCaddy = () => path.join(CADDY_LOG_DIR, 'access.log');
// 非访问类日志（admin.api / tls / 启动信息）单独一个文件，避免混进 access.log
const otherLogPathForCaddy = () => path.join(CADDY_LOG_DIR, 'caddy.log');
const CADDY_OWN_LOG_FILE = path.join(DATA_DIR, 'caddy-logs', 'caddy.log');

const LOG_MAX = 1200;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const PROTOCOLS = ['auto', 'quic', 'http2', 'http2_ws'];
const LOGLEVELS = ['debug', 'info', 'warn', 'error'];

// ---------------------------------------------------------------- 状态
const CLOUDFLARE_DEFAULT_RANGES = ["173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22", "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"];

module.exports = { ACCESS_LOG_FILE, ASSET_DIR, ASSET_TYPES, BACKUP_DIR, CADDY_ADMIN, CADDY_LOG_DIR, CLOUDFLARED, CLOUDFLARE_DEFAULT_RANGES, DATA_DIR, LB_POLICIES, LOGLEVELS, LOG_MAX, METHODS, PAGES, PAGE_DIR, PORT, PROTOCOLS, STATE_FILE, VERSION, WEB_DIR, accessLogPathForCaddy, otherLogPathForCaddy, CADDY_OWN_LOG_FILE, pkgVersion };
