/**
 * CLI 共享上下文：环境变量 / 台账仓储 / 配置 / 口径字典。
 * 所有子命令经这里拿依赖，便于测试注入 :memory: 台账。
 */

import { loadConfig, type AppConfig } from '../core/config.ts';
import { loadDictionaries, type DictionaryBundle } from '../core/dictionary/loader.ts';
import { createRepositories, openStore, type Repositories } from '../db/index.ts';

export interface CliContext {
  env: NodeJS.ProcessEnv;
  repos: Repositories;
  config: AppConfig;
  bundle: DictionaryBundle;
  /** 仅测试注入：传入时不关闭外部持有的连接 */
  ownsStore: boolean;
}

export function createCliContext(options: {
  env?: NodeJS.ProcessEnv;
  repos?: Repositories;
  config?: AppConfig;
  bundle?: DictionaryBundle;
} = {}): CliContext {
  const env = options.env ?? process.env;
  const repos = options.repos ?? createRepositories(openStore());
  return {
    env,
    repos,
    config: options.config ?? loadConfig(env),
    bundle: options.bundle ?? loadDictionaries(),
    ownsStore: !options.repos,
  };
}

/** 解析 --key value / --key=value / --flag 三种写法 */
export function parseArgs(argv: readonly string[]): { flags: Record<string, string | boolean>; positional: string[] } {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq > 0) {
      flags[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { flags, positional };
}

export function strFlag(flags: Record<string, string | boolean>, key: string, fallback = ''): string {
  const value = flags[key];
  return typeof value === 'string' ? value : fallback;
}

export function numFlag(flags: Record<string, string | boolean>, key: string, fallback: number): number {
  const value = Number(flags[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
