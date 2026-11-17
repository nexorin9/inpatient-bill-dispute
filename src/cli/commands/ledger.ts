/**
 * 台账 / 导出 / 重放 CLI（Tasks 2 / 42 / 43）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { maskEncounterNo } from '../../core/domain/mask.ts';
import { STATUS_LABELS } from '../../core/domain/state-machine.ts';
import { CATEGORY_LABELS, CHANNEL_LABELS } from '../../core/config.ts';
import { parseBillLine } from '../../core/adapters/his.ts';
import type { LedgerSeedConsultation } from '../../core/adapters/samples.ts';
import { LedgerService } from '../../core/audit/ledger.ts';
import { exportAuditPackage } from '../../core/audit/export.ts';
import type { CliContext } from '../context.ts';
import { parseArgs, strFlag, numFlag } from '../context.ts';

interface LedgerSeedFile {
  consultations: LedgerSeedConsultation[];
  bill_lines: Record<string, Array<Record<string, unknown>>>;
}

/** 只需要仓储；CLI 传完整 CliContext，Electron 主进程传 Repositories 包装即可 */
type SeedHost = Pick<CliContext, 'repos'>;

export function seedLedger(ctx: SeedHost, seedPath?: string): number {
  const path = seedPath
    ? resolve(process.cwd(), seedPath)
    : new URL('../../../samples/ledger-seed.json', import.meta.url).pathname;
  if (!existsSync(path)) {
    console.error(`种子文件不存在：${path}`);
    return -1;
  }
  const file = JSON.parse(readFileSync(path, 'utf8')) as LedgerSeedFile;
  let inserted = 0;
  for (const consultation of file.consultations) {
    if (ctx.repos.consultations.find(consultation.consultation_no)) continue;
    ctx.repos.consultations.insert({
      consultationNo: consultation.consultation_no,
      channel: consultation.channel,
      encounterNo: consultation.encounter_no,
      encounterNoMasked: maskEncounterNo(consultation.encounter_no),
      requestText: consultation.request_text,
      status: consultation.status as 'pending_reply',
      amount: consultation.amount,
      handoffFailed: false,
      createdAt: consultation.created_at,
      updatedAt: consultation.created_at,
    });
    const lines = file.bill_lines[consultation.consultation_no] ?? [];
    if (lines.length > 0) {
      ctx.repos.billLines.replaceAll(
        consultation.consultation_no,
        lines.map((line) => parseBillLine(line, consultation.encounter_no)),
      );
    }
    inserted += 1;
  }
  console.log(`导入脱敏样例：新增 ${inserted} 条咨询单（来自 ${path}）`);
  return inserted;
}

/** 台账：按状态与日期范围分页列出，表头字段齐全 */
export async function runLedger(argv: readonly string[], ctx: CliContext): Promise<number> {
  const { flags } = parseArgs(argv);
  if (flags.seed) {
    const inserted = seedLedger(ctx, typeof flags.seed === 'string' ? flags.seed : undefined);
    if (inserted < 0) return 1;
  }
  const rows = ctx.repos.consultations.list({
    ...(typeof flags.status === 'string' ? { status: flags.status as 'pending_reply' } : {}),
    ...(typeof flags.from === 'string' ? { from: flags.from } : {}),
    ...(typeof flags.to === 'string' ? { to: flags.to } : {}),
    limit: numFlag(flags, 'limit', 100),
    offset: numFlag(flags, 'offset', 0),
  });
  console.log('咨询编号\t渠道\t掩码住院号\t状态\t金额(元)\t争议分类\t在手人\t创建时间');
  for (const row of rows) {
    console.log([
      row.consultationNo,
      CHANNEL_LABELS[row.channel] ?? row.channel,
      row.encounterNoMasked,
      STATUS_LABELS[row.status] ?? row.status,
      row.amount.toFixed(2),
      row.disputeCategory ? CATEGORY_LABELS[row.disputeCategory] ?? row.disputeCategory : '—',
      row.assignedTo ?? '未派单',
      row.createdAt.slice(0, 19).replace('T', ' '),
    ].join('\t'));
  }
  console.log(`共 ${rows.length} 条（status=${strFlag(flags, 'status', '全部')}，from=${strFlag(flags, 'from', '不限')}，to=${strFlag(flags, 'to', '不限')}）`);
  return 0;
}

export async function runExport(argv: readonly string[], ctx: CliContext): Promise<number> {
  const { flags } = parseArgs(argv);
  const pkg = exportAuditPackage(ctx.repos, {
    ...(typeof flags.status === 'string' ? { status: flags.status as 'pending_reply' } : {}),
    ...(typeof flags.from === 'string' ? { from: flags.from } : {}),
    ...(typeof flags.to === 'string' ? { to: flags.to } : {}),
  });
  if (pkg.rows.length === 0) console.log('提示：当前过滤条件下没有咨询单，导出件为空表头。');
  console.log(`引用留痕导出完成：${pkg.rows.length} 条`);
  console.log(`  CSV ：${pkg.csvPath}`);
  console.log(`  JSON：${pkg.jsonPath}`);
  console.log(`  引用相关字段：引用条数 / 引用清单 / 依据出处 / 模型名与版本 / 版本快照`);
  return 0;
}

export async function runReplay(argv: readonly string[], ctx: CliContext): Promise<number> {
  const { flags, positional } = parseArgs(argv);
  const consultationNo = positional[0] ?? strFlag(flags, 'consultation', '');
  if (!consultationNo) {
    console.error('用法：npm run cli -- replay <咨询编号>');
    return 2;
  }
  try {
    const result = new LedgerService(ctx.repos).replay(consultationNo, strFlag(flags, 'operator', 'cli'));
    console.log(result.explanationText);
    console.log(`\n重放留痕：归因轮次 ${result.sessionRoundsBefore} → ${result.sessionRoundsAfter}（未新增），模型调用 ${result.modelCalls}`);
    return 0;
  } catch (err) {
    console.error(`重放失败：${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** 供桌面端复用：默认种子导入（samples/ledger-seed.json） */
export function ensureSeeded(ctx: SeedHost): void {
  if (ctx.repos.consultations.count() === 0) seedLedger(ctx);
}
