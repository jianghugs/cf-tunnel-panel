'use strict';
/**
 * 路由模块的公共依赖：/api/* 的十个模块共用（C8 拆分时每个模块各抄了一份，
 * 每份 98–112 行、37–39 条 require，改一处要改十遍，还漏过 require —— 0.29.55
 * 的 net is not defined 就是这么漏上线的）。现在只维护这一份。
 *
 * 用法：`const { log, sendJson, state, authOf } = require('./_deps');`
 * 注意 state 是 stateProxy（指向 state 模块内部同一个对象），不要在模块里改它的指向。
 */

const os = require('os');
const { spawn } = require('child_process');
const QRCode = require('qrcode');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const _audit = require('../core/audit');
const { record: auditRecord, list: auditList, stats: auditStats, byHour: auditByHour, actionOf, days: auditDays } = _audit;
const _paths = require('../core/paths');
const { ACCESS_LOG_FILE, ASSET_DIR, ASSET_TYPES, BACKUP_DIR, CADDY_ADMIN, CADDY_LOG_DIR, CLOUDFLARED, CLOUDFLARE_DEFAULT_RANGES, DATA_DIR, LB_POLICIES, LOGLEVELS, LOG_MAX, METHODS, PAGES, PAGE_DIR, PORT, PROTOCOLS, STATE_FILE, VERSION, WEB_DIR, accessLogPathForCaddy, pkgVersion } = _paths;
const _util = require('../core/util');
const { SEC_HEADERS, log, logSeq, logs, parseCidrs, parseHeaderLines, parseUpstream, rateLimited, readBody, rid, rlHits, sendJson, sseClients } = _util;
const _state = require('../core/state');
const { maybeReloadState } = _state;
const { acquireLock } = _state;
const { stateProxy, setState, deepDefault, defaultOrigin, defaultState, isFreshState, loadState, migrateState, newTunnel, normalizeTunnels, publicRoute, publicSettings, saveState, validateRoutes } = _state;
const state = stateProxy;
const _registry = require('../core/registry');
const { firstTunnel, publicUrlOf, runtimes, tunnelById, tunnelRt } = _registry;
const _auth = require('../core/auth');
const { clearBasicCache, AUTH_BLOCK_MS, AUTH_FAIL_LIMIT, AUTH_FAIL_WINDOW, authBlockedFor, authFails, authOk, checkAuth, clearAuthFail, clientIpOf, noteAuthFail, login , completeTotp } = _auth;
const _session = require('../core/session');
const history = require('../core/history');
const session = _session;
const secret = require('../core/secret');
const ident = require('../core/ident');
const _selfcheck = require('../core/selfcheck');
const configcode = require('../core/configcode');
const guard = require('../core/guard');
const lease = require('../core/lease');
const totp = require('../core/totp');
const perm = require('../core/perm');
const _caddy = require('../core/caddy');
const { buildCaddyConfig, buildMatch, buildRouteHandlers, caddy, cloudflareRanges, lastSkipped, maintPage, tunnelHostOf, PANEL_SLOT_RE, panelSlots } = _caddy;
const _pusher = require('../core/pusher');
const { pushCaddy, pushTimer, schedulePush } = _pusher;
const _tunnels = require('../core/tunnels');
const { QUICK_RE, applyTunnelFields, normalizeTunnelToken, publicTunnels, runtimeOf, startAll, startTunnel, stopAll, stopTunnel, syncTunnels, tokenTunnelOf, tunnelArgs } = _tunnels;
const _insight = require('../core/insight');
const { countPanelReq, upstreamHealth, HISTORY_MAX, badgeSvg, diffRoutes, healthOf, histTick, metricsText, readAccess, refreshUpstreamHealth, requestsLastMinute, rtHistory, sampleHistory, securityAttempts, shadowReport, simulateMatch, systemInfo, tcpProbeOnce, trafficByHour, trafficByPath, upstreamTarget } = _insight;
const _bench = require('../core/bench');
const { BENCH_MAX_MB, benchLocalOnce, coloOf, sendBenchBlob } = _bench;
const _probe = require('../core/probe');
const { getV4 } = require('../core/httpv4');
const { curlSelf, probeUpstream, wsProbe } = _probe;
const _integrations = require('../core/integrations');
const { cfApi, dockerApi, dockerContainers, pickWebPort } = _integrations;
const _notify = require('../core/notify');
const { inQuietHours, notify, notifyHistory, recordNotify } = _notify;
const _i18n = require('../core/i18n');
const { langOf } = _i18n;
const _web = require('../core/web');
const { pageShell, readPage, serveText, loginPage } = _web;
const _monitor = require('../core/monitor');
const { seenCaddyOk, shareJanitor, shareUrl, startMonitor } = _monitor;
const _httpStatic = require('../http/static');
const _httpBoot = require('../http/boot');
const _httpOnReq = require('../http/onreq');
const dns = require('dns');
const http = require('http');
const crypto = require('crypto');
const net = require('net');

// 鉴权结果按请求缓存：一次请求里多个分支取同一个 auth 对象。
const _authCache = new WeakMap();
function authOf(req) {
  let a = _authCache.get(req);
  if (!a) {
    a = require('../core/auth').checkAuth(req);
    _authCache.set(req, a);
  }
  return a;
}

// GET /api/openapi 用：首次读盘后进程内缓存。
let _openapiCache = null;
function readOpenapi() {
  if (_openapiCache) return _openapiCache;
  const f = path.join(__dirname, '..', '..', 'docs', 'openapi.json');
  _openapiCache = JSON.parse(fs.readFileSync(f, 'utf8'));
  return _openapiCache;
}

module.exports = {
  os,
  spawn,
  QRCode,
  bcrypt,
  fs,
  path,
  _audit,
  auditRecord,
  auditList,
  auditStats,
  auditByHour,
  actionOf,
  auditDays,
  _paths,
  ACCESS_LOG_FILE,
  ASSET_DIR,
  ASSET_TYPES,
  BACKUP_DIR,
  CADDY_ADMIN,
  CADDY_LOG_DIR,
  CLOUDFLARED,
  CLOUDFLARE_DEFAULT_RANGES,
  DATA_DIR,
  LB_POLICIES,
  LOGLEVELS,
  LOG_MAX,
  METHODS,
  PAGES,
  PAGE_DIR,
  PORT,
  PROTOCOLS,
  STATE_FILE,
  VERSION,
  WEB_DIR,
  accessLogPathForCaddy,
  pkgVersion,
  _util,
  SEC_HEADERS,
  log,
  logSeq,
  logs,
  parseCidrs,
  parseHeaderLines,
  parseUpstream,
  rateLimited,
  readBody,
  rid,
  rlHits,
  sendJson,
  sseClients,
  _state,
  maybeReloadState,
  acquireLock,
  stateProxy,
  setState,
  deepDefault,
  defaultOrigin,
  defaultState,
  isFreshState,
  loadState,
  migrateState,
  newTunnel,
  normalizeTunnels,
  publicRoute,
  publicSettings,
  saveState,
  validateRoutes,
  state,
  _registry,
  firstTunnel,
  publicUrlOf,
  runtimes,
  tunnelById,
  tunnelRt,
  _auth,
  clearBasicCache,
  AUTH_BLOCK_MS,
  AUTH_FAIL_LIMIT,
  AUTH_FAIL_WINDOW,
  authBlockedFor,
  authFails,
  authOk,
  checkAuth,
  clearAuthFail,
  clientIpOf,
  noteAuthFail,
  login,
  completeTotp,
  _session,
  history,
  session,
  secret,
  ident,
  _selfcheck,
  configcode,
  guard,
  lease,
  totp,
  perm,
  _caddy,
  buildCaddyConfig,
  buildMatch,
  buildRouteHandlers,
  caddy,
  cloudflareRanges,
  lastSkipped,
  maintPage,
  tunnelHostOf,
  PANEL_SLOT_RE,
  panelSlots,
  _pusher,
  pushCaddy,
  pushTimer,
  schedulePush,
  _tunnels,
  QUICK_RE,
  applyTunnelFields,
  normalizeTunnelToken,
  publicTunnels,
  runtimeOf,
  startAll,
  startTunnel,
  stopAll,
  stopTunnel,
  syncTunnels,
  tokenTunnelOf,
  tunnelArgs,
  _insight,
  countPanelReq,
  upstreamHealth,
  HISTORY_MAX,
  badgeSvg,
  diffRoutes,
  healthOf,
  histTick,
  metricsText,
  readAccess,
  refreshUpstreamHealth,
  requestsLastMinute,
  rtHistory,
  sampleHistory,
  securityAttempts,
  shadowReport,
  simulateMatch,
  systemInfo,
  tcpProbeOnce,
  trafficByHour,
  trafficByPath,
  upstreamTarget,
  _bench,
  BENCH_MAX_MB,
  benchLocalOnce,
  coloOf,
  sendBenchBlob,
  _probe,
  getV4,
  curlSelf,
  probeUpstream,
  wsProbe,
  _integrations,
  cfApi,
  dockerApi,
  dockerContainers,
  pickWebPort,
  _notify,
  inQuietHours,
  notify,
  notifyHistory,
  recordNotify,
  _i18n,
  langOf,
  _web,
  pageShell,
  readPage,
  serveText,
  loginPage,
  _monitor,
  seenCaddyOk,
  shareJanitor,
  shareUrl,
  startMonitor,
  _httpStatic,
  _httpBoot,
  _httpOnReq,
  dns,
  http,
  crypto,
  net,
  authOf,
  readOpenapi,
};
