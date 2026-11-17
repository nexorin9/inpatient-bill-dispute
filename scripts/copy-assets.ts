#!/usr/bin/env node
/**
 * 构建期资产复制：把版本化口径字典 JSON 与脱敏样例复制到 dist 对应位置。
 * TypeScript 编译只输出 .js，JSON 资产需要显式复制，否则 dist 运行时装载器找不到依据。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DICT_SRC = join(ROOT, 'src/core/dictionary');
const DICT_DST = join(ROOT, 'dist/core/dictionary');
const SAMPLES_SRC = join(ROOT, 'samples');
const SAMPLES_DST = join(ROOT, 'dist/samples');

function copyJsonTree(src: string, dst: string): number {
  if (!existsSync(src)) throw new Error(`资产源目录不存在：${src}`);
  mkdirSync(dst, { recursive: true });
  let count = 0;
  for (const entry of readdirSync(src)) {
    const from = join(src, entry);
    const to = join(dst, entry);
    if (statSync(from).isDirectory()) {
      count += copyJsonTree(from, to);
    } else if (entry.endsWith('.json')) {
      copyFileSync(from, to);
      count += 1;
    }
  }
  return count;
}

const dictCount = copyJsonTree(DICT_SRC, DICT_DST);
const sampleCount = copyJsonTree(SAMPLES_SRC, SAMPLES_DST);
console.log(`构建资产复制：字典 JSON ${dictCount} 份 → dist/core/dictionary；脱敏样例 ${sampleCount} 份 → dist/samples`);
