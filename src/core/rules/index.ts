/** 守门规则层出口：引擎 / §4 七条 / 勾稽 / 属性守门 / 分类 / 快照 / 官方用例跑批 */

export * from './engine.ts';
export * from './negative-list.ts';
export * from './reconciliation.ts';
export * from './guardrail.ts';
export * from './classification.ts';
export * from './snapshot.ts';
export * from './qc-cases.ts';

import { RuleRegistry } from './engine.ts';
import { registerNegativeListRules } from './negative-list.ts';

/** 默认规则集：七条 §4 + 属性/版本守门两条，新增规则只需注册 */
export function createDefaultRuleRegistry(version = 'RULES-2026-03'): RuleRegistry {
  const registry = new RuleRegistry(version);
  registerNegativeListRules(registry);
  return registry;
}
