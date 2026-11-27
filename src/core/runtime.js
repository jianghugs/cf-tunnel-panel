'use strict';

// 跨模块运行时句柄：由 server.js 在启动阶段填好，路由模块按需取用。
// 这样「谁定义」和「谁调用」解耦，避免为了一个函数把整段顶层依赖一起搬走。
module.exports = {
  runSelfcheckOnce: null,   // server.js 启动后赋值
  runSelfcheckQuiet: null,
};
