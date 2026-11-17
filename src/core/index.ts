/**
 * 核心库统一出口 —— CLI 与 Electron 主进程共用，渲染层只经 preload 受限接口访问。
 * 核心库零 Electron 依赖，可在无 GUI 环境独立跑全部验收。
 */

export * from './domain/index.ts';
export * from './config.ts';
export * from './dictionary/loader.ts';
export * from './adapters/credentials.ts';
export * from './adapters/http.ts';
export * from './adapters/his.ts';
export * from './adapters/pricing.ts';
export * from './adapters/samples.ts';
export * from './adapters/workorder.ts';
export * from './adapters/im.ts';
export * from './rules/index.ts';
export * from './attribution/index.ts';
export * from './workunit/index.ts';
export * from './dispatch/index.ts';
export * from './audit/index.ts';
export * from '../db/index.ts';
