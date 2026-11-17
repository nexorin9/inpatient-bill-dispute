/** 留痕与台账出口：超时升级 / 检索重放 / 引用留痕导出包 */

export * from './sla.ts';
export * from './ledger.ts';
export * from './export.ts';

import type { Repositories } from '../../db/index.ts';
import type { AppConfig } from '../config.ts';
import { SystemClock, SlaEscalationService } from './sla.ts';
import { LedgerService } from './ledger.ts';

/** 一次性构造审计服务（主进程与 CLI 共用） */
export function createAuditServices(repos: Repositories, config: AppConfig) {
  return {
    sla: new SlaEscalationService(repos, config, new SystemClock()),
    ledger: new LedgerService(repos),
  };
}
