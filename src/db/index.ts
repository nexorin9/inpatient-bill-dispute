/**
 * 持久化层出口。
 * 业务层只 import 这里的仓储与 openStore，不接触驱动或 SQL 细节。
 */

export * from './schema.ts';
export * from './store.ts';
export * from './repositories/consultations.ts';
export * from './repositories/sessions.ts';
export * from './repositories/assignments.ts';

import { ConsultationRepository, BillLineRepository } from './repositories/consultations.ts';
import {
  AttributionSessionRepository,
  SnapshotRepository,
  ReplayAuditRepository,
} from './repositories/sessions.ts';
import {
  AssignmentRepository,
  CapacityRepository,
  QueueBindingRepository,
  SlaRepository,
  FingerprintRepository,
} from './repositories/assignments.ts';
import type { Store } from './store.ts';

/** 一次性拿到全部仓储，避免每个调用点重复 new */
export interface Repositories {
  store: Store;
  consultations: ConsultationRepository;
  billLines: BillLineRepository;
  sessions: AttributionSessionRepository;
  snapshots: SnapshotRepository;
  replayAudits: ReplayAuditRepository;
  assignments: AssignmentRepository;
  capacity: CapacityRepository;
  queues: QueueBindingRepository;
  sla: SlaRepository;
  fingerprints: FingerprintRepository;
}

export function createRepositories(store: Store): Repositories {
  return {
    store,
    consultations: new ConsultationRepository(store),
    billLines: new BillLineRepository(store),
    sessions: new AttributionSessionRepository(store),
    snapshots: new SnapshotRepository(store),
    replayAudits: new ReplayAuditRepository(store),
    assignments: new AssignmentRepository(store),
    capacity: new CapacityRepository(store),
    queues: new QueueBindingRepository(store),
    sla: new SlaRepository(store),
    fingerprints: new FingerprintRepository(store),
  };
}
