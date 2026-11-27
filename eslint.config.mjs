// 极简 ESLint 配置：只开两件最值得开的事
//   no-undef       —— 抓「变量不在作用域」。路由模块拆分时几次栽在这类问题上
//                     （`auth is not defined`、`net is not defined`），而 `node --check` 与 check-requires 都看不见。
//   no-unused-vars —— 顺手提醒没用到的解构（warn，不挡 CI）。
// 前端 src/web/assets 是浏览器代码（window/document/localStorage 一大套），这里不纳入，由 test/dom.test.cjs 覆盖。
const NODE_GLOBALS = {
  require: 'readonly',
  module: 'readonly',
  exports: 'readonly',
  process: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  Buffer: 'readonly',
  console: 'readonly',
  global: 'readonly',
  globalThis: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
  queueMicrotask: 'readonly',
  fetch: 'readonly',
  Headers: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  WebSocket: 'readonly',
  structuredClone: 'readonly',
  performance: 'readonly',
  crypto: 'readonly',
  atob: 'readonly',
  btoa: 'readonly',
};

const RULES = {
  'no-undef': 'error',
  'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
};

export default [
  {
    ignores: [
      'node_modules/**',
      'data/**',
      'docs/**',
      'src/web/assets/**',
      'tools/monitoring/**',
    ],
  },
  {
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: NODE_GLOBALS,
    },
    rules: RULES,
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: NODE_GLOBALS,
    },
    rules: RULES,
  },
];
