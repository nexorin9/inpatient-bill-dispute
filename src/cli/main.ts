#!/usr/bin/env node
/**
 * 运维与排障通道 —— CLI 只做「看一眼、查一下、导一下」，日常出稿走桌面程序。
 *
 * 约定：所有子命令只输出「是否已配置」，不回显密钥；缺必填凭据时非 0 退出码，
 * 不静默降级到本地文件。主入口是桌面程序（npm start），这里供信息科排障与 CI 验证。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  CREDENTIAL_SLOTS,
  GROUP_LABELS,
  describeSlots,
  missingRequiredSlots,
  type SlotGroup,
  type SlotStatus,
} from '../core/adapters/credentials.ts';
import { HisBillingAdapter } from '../core/adapters/his.ts';
import { PricingAdapter } from '../core/adapters/pricing.ts';
import { createCliContext, type CliContext } from './context.ts';
import { runLedger, runExport, runReplay } from './commands/ledger.ts';
import { runDictCheck } from './commands/dict.ts';
import { runExplain, runConfirm, runPrint, runHandoff } from './commands/explain.ts';
import { runCases, runBenchAttribution, runBenchScale, runSlaScan } from './commands/verify.ts';
import { runIntake, runAssign } from './commands/workunit.ts';

const PROJECT_ROOT = resolve(import.meta.dirname, '../..');
const VERSION = '0.1.0';

function loadDotEnv(): void {
  const envPath = resolve(PROJECT_ROOT, '.env');
  if (!existsSync(envPath)) return;
  for (const [key, value] of readEnvFile(envPath)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function readEnvFile(path: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    pairs.push([key, value]);
  }
  return pairs;
}

function pad(text: string, width: number): string {
  const visible = [...text].reduce((sum, ch) => sum + (/[一-龥＀-￯]/.test(ch) ? 2 : 1), 0);
  return text + ' '.repeat(Math.max(0, width - visible));
}

/** 对已配置的入站端点发一次轻量探测，只回显「已配置 / 不可达」，不打印凭据或响应体 */
async function probe(url: string, token: string): Promise<string> {
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000),
    });
    return response.status < 500 ? '已配置·可达' : '已配置·不可达';
  } catch {
    return '已配置·不可达（探测超时或网络不通）';
  }
}

async function printDoctor(): Promise<number> {
  const slots = describeSlots(process.env);
  const groups = [...new Set(slots.map((s) => s.group))];
  console.log('住院费用争议解释系统 · 接口连通性自检（凭据位配置状态）');
  console.log('='.repeat(78));
  for (const group of groups) {
    console.log(`\n【${GROUP_LABELS[group as SlotGroup]}】`);
    console.log(`${pad('配置项', 22)}${pad('状态', 10)}说明`);
    for (const slot of slots.filter((s) => s.group === group)) {
      const status = slot.configured ? '已配置' : slot.required ? '未配置' : '未配置(可选)';
      console.log(`${pad(slot.env, 22)}${pad(status, 10)}${slot.purpose}`);
    }
  }
  console.log('\n【入站端点轻量探测】');
  const his = new HisBillingAdapter(process.env);
  const pricing = new PricingAdapter(process.env);
  console.log(`  HIS 住院费用明细：${his.isConfigured() ? await probe(process.env.HIS_BASE_URL!, process.env.HIS_API_TOKEN!) : '未配置'}`);
  console.log(`  本院价目目录　　：${pricing.isConfigured() ? await probe(process.env.PRICING_BASE_URL!, process.env.PRICING_API_TOKEN!) : '未配置'}`);
  console.log('  工单 / IM 出站端点：仅显示是否已配置，不做写探测（避免产生真实工单）');

  const missing = missingRequiredSlots(process.env);
  console.log('');
  console.log('='.repeat(78));
  if (missing.length === 0) {
    console.log('结论：必填凭据位齐备，可以拉取住院费用明细与价目目录。');
    return 0;
  }
  console.log(`结论：缺少 ${missing.length} 个必填凭据位，归因主路径不可用：`);
  for (const slot of missing) console.log(`  - ${slot.env}（${slot.purpose}）`);
  console.log('请在项目根目录 .env 中补齐（可从 .env.example 复制），凭据一律从环境变量读。');
  return 1;
}

function printHelp(): void {
  console.log(`住院费用争议解释系统 · 运维通道 v${VERSION}

用法：npm run cli -- <子命令> [参数]

产品主入口是桌面程序（npm start）；CLI 仅供信息科排障与 CI 验证。

子命令：
  doctor                 接口凭据位配置状态 + 入站端点轻量探测
  ledger [--seed <path>] [--status S] [--from D] [--to D]   咨询台账（可导入脱敏样例）
  dict:check [--inject-missing <编号>]   口径字典 193 / 7 / 2 自检
  explain --encounter <住院号> --text "<家属原话>"   生成带引用解释稿与争议分类单
  confirm <咨询编号>     收费员确认（唯一放行闸门）
  print <咨询编号>       生成家属可读打印稿（需先确认）
  handoff <咨询编号>     提交转办工单 + 回执写回 + IM 推送
  replay <咨询编号>      原样重放上次解释稿与引用清单（不重跑模型）
  export [--status S] [--from D] [--to D]   引用留痕导出包 CSV + JSON
  intake --channel <counter|phone|online> --encounter <no> --text "<原话>"   多通道登记
  assign <咨询编号>      容量派单（行级幂等）
  cases:run [--break <校验项>]   官方结算清单质控 8 例对照
  bench:attribution      有模型 vs 纯规则基线对照报告
  bench:scale            ≥300 条明细规模验收（零漏行 / 引用覆盖 / 耗时）
  sla:scan [--at ISO]    咨询超时升级扫描（时钟注入）
  version / help        版本 / 本帮助

全量命令参考见 docs/cli.md；界面操作见 README 快速开始。`);
}

type CommandHandler = (argv: readonly string[], ctx: CliContext) => Promise<number>;

const COMMANDS: Record<string, CommandHandler> = {
  ledger: runLedger,
  export: runExport,
  replay: runReplay,
  'dict:check': runDictCheck,
  explain: runExplain,
  confirm: runConfirm,
  print: runPrint,
  handoff: runHandoff,
  intake: runIntake,
  assign: runAssign,
  'cases:run': runCases,
  'bench:attribution': runBenchAttribution,
  'bench:scale': runBenchScale,
  'sla:scan': runSlaScan,
};

async function main(): Promise<number> {
  loadDotEnv();
  const [, , command = 'help', ...rest] = process.argv;
  if (command === 'doctor') return printDoctor();
  if (command === 'version') { console.log(VERSION); return 0; }
  if (command === 'help' || command === '--help' || command === '-h') { printHelp(); return 0; }
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`未知子命令：${command}`);
    printHelp();
    return 2;
  }
  const ctx = createCliContext();
  try {
    return await handler(rest, ctx);
  } finally {
    if (ctx.ownsStore) ctx.repos.store.close();
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });

export { describeSlots, CREDENTIAL_SLOTS };
export type { SlotStatus };
