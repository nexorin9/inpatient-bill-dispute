/**
 * 窄 Store 接口 —— 业务层只依赖这三个动作，不 import 任何 SQLite 驱动。
 *
 * 本机 Node 22 起内置 `node:sqlite`（同步 API，形状接近 better-sqlite3），
 * 避免原生编译；若院内机换成别的驱动，只替换本文件的实现类即可。
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.ts';

export type Row = Record<string, unknown>;

export interface RunResult {
  changes: number;
  lastInsertRowid?: number | bigint;
}

export interface Store {
  /** 查询多行 */
  query<T extends Row = Row>(sql: string, params?: readonly unknown[]): T[];
  /** 查询单行 */
  get<T extends Row = Row>(sql: string, params?: readonly unknown[]): T | undefined;
  /** 执行写入 */
  run(sql: string, params?: readonly unknown[]): RunResult;
  /** 事务：回调内任一步抛错即整体回滚（Task 2 事务回滚用例） */
  transaction<T>(fn: () => T): T;
  /** 关闭连接 */
  close(): void;
  /** 驱动标识，仅供 doctor 回显 */
  readonly driver: string;
}

type BindValue = null | number | bigint | string | Uint8Array;

/** node:sqlite 只接受 null / number / bigint / string / Uint8Array，这里统一归一化 */
function bind(params: readonly unknown[]): BindValue[] {
  return params.map((value): BindValue => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') return value;
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Uint8Array) return value;
    return JSON.stringify(value);
  });
}

export class SqliteStore implements Store {
  readonly driver = 'node:sqlite';
  private readonly db: DatabaseSync;
  private depth = 0;

  constructor(path: string = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA journal_mode = DELETE');
    // 两个派单进程并发抢同一条时，让第二个连接等待而不是直接 SQLITE_BUSY（Task 37）
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(SCHEMA_SQL);
    this.db.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)').run(
      'schema_version',
      String(SCHEMA_VERSION),
    );
  }

  query<T extends Row = Row>(sql: string, params: readonly unknown[] = []): T[] {
    return this.db.prepare(sql).all(...bind(params)) as T[];
  }

  get<T extends Row = Row>(sql: string, params: readonly unknown[] = []): T | undefined {
    return this.db.prepare(sql).get(...bind(params)) as T | undefined;
  }

  run(sql: string, params: readonly unknown[] = []): RunResult {
    const result = this.db.prepare(sql).run(...bind(params));
    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
  }

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) {
      // 嵌套调用复用外层事务，避免 SQLite 报「cannot start a transaction within a transaction」
      this.depth += 1;
      try {
        return fn();
      } finally {
        this.depth -= 1;
      }
    }
    this.depth = 1;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.depth = 0;
    }
  }

  close(): void {
    this.db.close();
  }
}

/** 默认台账路径：data/ledger.sqlite（data/ 已在 .gitignore 中排除） */
export function defaultLedgerPath(): string {
  if (process.env.LEDGER_DB_PATH && process.env.LEDGER_DB_PATH.trim().length > 0) {
    return process.env.LEDGER_DB_PATH;
  }
  return new URL('../../data/ledger.sqlite', import.meta.url).pathname;
}

/** 打开（必要时创建）本地台账 */
export function openStore(path: string = defaultLedgerPath()): Store {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  return new SqliteStore(path);
}
