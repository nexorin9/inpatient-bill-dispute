#!/usr/bin/env node
/**
 * Electron 启动包装（Task 14 / 16：可重复的截图采集与桌面启动入口）。
 *
 * 解决两个真实环境坑：
 * 1) 某些 Electron 宿主（IDE / 终端复用）会往子进程注入 ELECTRON_RUN_AS_NODE=1，
 *    导致 electron 二进制以「纯 Node」模式运行，主进程 require('electron') 拿到的
 *    只是 npm 包导出的可执行文件路径字符串，app 为 undefined。这里显式删除该变量。
 * 2) 受限 / 无 GPU 环境里 Chromium sandbox 与 GPU 进程无法初始化，截图会直接 SIGTRAP。
 *    --capture 模式附加无沙箱 + 软件渲染参数，保证 capturePage 可用；正常启动不加这些参数。
 *
 * 用法：
 *   node scripts/launch.mjs            等价于 npm start（GUI 正常启动）
 *   node scripts/launch.mjs --capture 采集 docs/screenshots/ 真实截图
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronBin = require('electron');
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const capture = process.argv.includes('--capture');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = [projectRoot];
if (capture) {
  args.push(
    '--capture',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-gpu-sandbox',
    '--disable-dev-shm-usage',
    '--disable-features=Vulkan',
  );
}

const child = spawn(electronBin, args, { cwd: projectRoot, env, stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (code === null) {
    console.error(`[launch] Electron 异常退出：${signal ?? 'unknown signal'}`);
    process.exit(1);
  }
  process.exit(code);
});
child.on('error', (err) => {
  console.error('[launch] 无法启动 Electron：', err);
  process.exit(1);
});
