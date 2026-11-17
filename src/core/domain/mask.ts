/**
 * 掩码工具 —— 本地台账之外的任何位置（日志、留痕、界面、模型上下文）只用掩码值。
 */

/** 住院号掩码：只保留后 4 位，其余以 * 代替；长度不足 4 位时全部打码 */
export function maskEncounterNo(encounterNo: string): string {
  const trimmed = encounterNo.trim();
  if (trimmed.length === 0) return '****';
  const tail = trimmed.slice(-4);
  return '*'.repeat(Math.max(0, trimmed.length - 4)) + tail;
}

/** 证件号掩码：只保留后 4 位 */
export function maskIdCardNo(idCardNo: string): string {
  return maskEncounterNo(idCardNo);
}

/** 姓名掩码：保留姓氏，其余打码 */
export function maskName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length <= 1) return '*';
  return trimmed.slice(0, 1) + '*'.repeat(trimmed.length - 1);
}
