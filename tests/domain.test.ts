import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALLOWED_TRANSITIONS,
  AppError,
  ErrorCode,
  applyTransition,
  assertTransition,
  canTransition,
  errorMessage,
  isConfirmedStatus,
  isRetryable,
  isUnconfirmed,
  maskEncounterNo,
  nextStatus,
  normalizeError,
} from '../src/core/domain/index.ts';
import type { Consultation, ConsultationStatus } from '../src/core/domain/index.ts';

function makeConsultation(overrides: Partial<Consultation> = {}): Consultation {
  return {
    consultationNo: 'CS202611090001',
    channel: 'counter',
    encounterNo: 'ZY20260001234',
    encounterNoMasked: maskEncounterNo('ZY20260001234'),
    requestText: '上次多算了 3200',
    status: 'pending_reply',
    amount: 3200,
    createdAt: '2026-11-09T09:00:00.000Z',
    updatedAt: '2026-11-09T09:00:00.000Z',
    ...overrides,
  };
}

test('六态齐备：状态集合与中文标签一一对应', () => {
  const statuses: ConsultationStatus[] = [
    'pending_reply',
    'draft_pending_confirm',
    'answered',
    'transferred',
    'closed',
    'withdrawn',
  ];
  assert.equal(statuses.length, 6);
  for (const s of statuses) {
    assert.ok(ALLOWED_TRANSITIONS[s], `${s} 缺少跃迁表条目`);
  }
});

test('合法跃迁：表内每一对都放行', () => {
  for (const [from, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
    for (const to of targets) {
      assert.equal(canTransition(from as ConsultationStatus, to as ConsultationStatus), true);
      assert.doesNotThrow(() => assertTransition(from as ConsultationStatus, to as ConsultationStatus));
      assert.equal(nextStatus(from as ConsultationStatus, to as ConsultationStatus), to);
    }
  }
});

test('非法跃迁：抛 ERR_ILLEGAL_TRANSITION 且状态不变', () => {
  const illegal: Array<[ConsultationStatus, ConsultationStatus]> = [
    ['pending_reply', 'answered'],
    ['pending_reply', 'transferred'],
    ['pending_reply', 'closed'],
    ['draft_pending_confirm', 'closed'],
    ['answered', 'withdrawn'],
    ['answered', 'transferred'],
    ['transferred', 'answered'],
    ['closed', 'answered'],
    ['withdrawn', 'pending_reply'],
    ['withdrawn', 'draft_pending_confirm'],
  ];
  for (const [from, to] of illegal) {
    assert.throws(
      () => assertTransition(from, to),
      (err: unknown) => err instanceof AppError && err.code === ErrorCode.ILLEGAL_TRANSITION,
      `${from} → ${to} 应被拒绝`,
    );
  }
  const c = makeConsultation();
  assert.throws(() => applyTransition(c, 'answered'), AppError);
  assert.equal(c.status, 'pending_reply', '被拒跃迁不得改写原对象');
});

test('确认闸门：未确认不得直接进入已答复 / 已转办', () => {
  const c = makeConsultation({ status: 'draft_pending_confirm' });
  assert.throws(
    () => applyTransition(c, 'answered'),
    (err: unknown) => err instanceof AppError && err.code === ErrorCode.CONFIRM_REQUIRED,
  );
  const confirmed = applyTransition(c, 'answered', { confirmedBy: 'clerk-07' });
  assert.equal(confirmed.status, 'answered');
  assert.equal(confirmed.confirmedBy, 'clerk-07');
  assert.ok(confirmed.confirmedAt);
});

test('未确认态可撤回，已确认态不可撤回', () => {
  assert.equal(isUnconfirmed('pending_reply'), true);
  assert.equal(isUnconfirmed('draft_pending_confirm'), true);
  assert.equal(isConfirmedStatus('answered'), true);
  const withdrawn = applyTransition(makeConsultation({ status: 'draft_pending_confirm' }), 'withdrawn');
  assert.equal(withdrawn.status, 'withdrawn');
  assert.throws(
    () => applyTransition(makeConsultation({ status: 'answered', confirmedAt: '2026-11-09T10:00:00.000Z' }), 'withdrawn'),
    (err: unknown) => err instanceof AppError && err.code === ErrorCode.ILLEGAL_TRANSITION,
  );
});

test('七类技术错误码齐备且可读', () => {
  const required = [
    ErrorCode.TIMEOUT,
    ErrorCode.HTTP_5XX,
    ErrorCode.HTTP_4XX,
    ErrorCode.PARSE_FAILED,
    ErrorCode.SCHEMA_INVALID,
    ErrorCode.EVIDENCE_MISSING,
    ErrorCode.AMBIGUOUS,
  ];
  for (const code of required) {
    assert.ok(errorMessage(code).length > 0, `${code} 缺少文案`);
  }
  assert.equal(isRetryable(ErrorCode.TIMEOUT), true);
  assert.equal(isRetryable(ErrorCode.HTTP_5XX), true);
  assert.equal(isRetryable(ErrorCode.HTTP_4XX), false);
  assert.equal(isRetryable(ErrorCode.SCHEMA_INVALID), false);
});

test('错误归一：未知异常收敛为 ERR_PARSE_FAILED，已归一异常原样透传', () => {
  const known = new AppError(ErrorCode.AMBIGUOUS, { candidates: [1, 2] });
  assert.equal(normalizeError(known), known);
  const unknown = normalizeError(new Error('boom'));
  assert.equal(unknown.code, ErrorCode.PARSE_FAILED);
  assert.equal(normalizeError('plain string').code, ErrorCode.PARSE_FAILED);
});

test('住院号掩码：只保留后 4 位', () => {
  assert.equal(maskEncounterNo('ZY20260001234'), '*********1234');
  assert.equal(maskEncounterNo('ZY20260001234').length, 'ZY20260001234'.length);
  assert.equal(maskEncounterNo('1234'), '1234');
  assert.equal(maskEncounterNo('  '), '****');
});
