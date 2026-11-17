import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError, ErrorCode } from '../src/core/domain/errors.ts';
import {
  CREDENTIAL_SLOTS,
  describeSlots,
  missingRequiredSlots,
  requireSlot,
} from '../src/core/adapters/credentials.ts';

const ALL_SET: NodeJS.ProcessEnv = Object.fromEntries(
  CREDENTIAL_SLOTS.map((slot) => [slot.env, 'placeholder-value']),
);

test('凭据位登记表覆盖 5 个外部系统分组', () => {
  const groups = new Set(CREDENTIAL_SLOTS.map((s) => s.group));
  assert.deepEqual([...groups].sort(), ['his', 'im', 'model', 'pricing', 'workorder']);
  assert.equal(CREDENTIAL_SLOTS.length, 12);
});

test('配置状态只说「有没有」，不回显取值', () => {
  const statuses = describeSlots(ALL_SET);
  assert.equal(statuses.length, CREDENTIAL_SLOTS.length);
  for (const status of statuses) {
    assert.equal(status.configured, true);
    const serialized = JSON.stringify(status);
    assert.ok(!serialized.includes('placeholder-value'), '状态结构里不得出现凭据取值');
  }
});

test('缺必填项时列出缺哪些，缺可选项不算阻断', () => {
  const env: NodeJS.ProcessEnv = { ...ALL_SET };
  delete env.HIS_API_TOKEN;
  delete env.IM_WEBHOOK_URL;
  const missing = missingRequiredSlots(env);
  assert.deepEqual(missing.map((m) => m.env), ['HIS_API_TOKEN']);
  assert.equal(describeSlots(env).find((s) => s.env === 'IM_WEBHOOK_URL')?.configured, false);
});

test('取凭据位：缺失抛 ERR_CREDENTIALS_MISSING，不静默降级', () => {
  const slot = CREDENTIAL_SLOTS.find((s) => s.env === 'HIS_API_TOKEN')!;
  assert.throws(
    () => requireSlot({}, slot),
    (err: unknown) => err instanceof AppError && err.code === ErrorCode.CREDENTIALS_MISSING,
  );
  assert.equal(requireSlot(ALL_SET, slot), 'placeholder-value');
});
