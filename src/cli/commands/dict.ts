/**
 * 口径字典自检 CLI（Task 4）：校验 193 项 / §4 七条 / 勾稽 2 组、编号唯一性与官方对照。
 * 缺项显式报「依据缺失」并以非 0 退出码结束；支持注入缺失项验证失败路径。
 */

import { checkDictionaries, type DictionaryBundle } from '../../core/dictionary/loader.ts';
import type { CliContext } from '../context.ts';
import { parseArgs, strFlag } from '../context.ts';

export async function runDictCheck(argv: readonly string[], ctx: CliContext): Promise<number> {
  const { flags } = parseArgs(argv);
  let bundle: DictionaryBundle = ctx.bundle;
  const injected = strFlag(flags, 'inject-missing');
  if (injected) {
    // 自检用：在内存里删掉一个编号，验证退出码与缺失项点名（不改动字典文件）
    bundle = {
      ...bundle,
      settlement: {
        ...bundle.settlement,
        fields: bundle.settlement.fields.filter((field) => field.code !== injected),
      },
    };
    console.log(`[自检] 人为移除编号 ${injected}`);
  }
  const report = checkDictionaries(bundle);
  console.log('口径字典自检');
  console.log('='.repeat(64));
  console.log(`结算清单字段：${report.totalFields} 项（期望 193）`);
  for (const [partition, count] of Object.entries(report.partitionCounts)) {
    console.log(`  ${partition}：${count} 项`);
  }
  console.log(`§4 智能审核规则：${report.smartRuleCount} 条（期望 7）`);
  console.log(`§3.3 收费类定义：${report.chargeDefinitionCount} 条（期望 3）`);
  console.log(`金额勾稽关系：${report.reconciliationGroups} 组（期望 2）`);
  console.log(`版本：结算清单 ${report.versions.settlement} ｜ 负面清单 ${report.versions.negativeList} ｜ 勾稽 ${report.versions.reconciliation}`);
  console.log('='.repeat(64));
  if (!report.ok) {
    for (const problem of report.problems) console.error(`依据缺失/校验失败：${problem}`);
    if (report.missingCodes.length > 0) {
      console.error(`缺少项编号：${report.missingCodes.join(', ')}`);
    }
    return 1;
  }
  console.log('结论：193 / 7 / 2 全部通过，编号唯一且与官方关键字段对照一致。');
  return 0;
}
