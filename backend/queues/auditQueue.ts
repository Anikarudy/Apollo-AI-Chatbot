/**
 * backend/queues/auditQueue.ts
 *
 * BullMQ queue for audit event writes.
 *
 * Each job carries the exact data needed to insert one AuditEvent row:
 *   { sessionId, eventType, payload }
 *
 * Default job options:
 *  - attempts: 3           — retry up to 3 times on DB errors
 *  - backoff: exponential  — 1s → 2s → 4s
 *  - removeOnComplete: 100 — keep last 100 completed jobs for debugging
 *  - removeOnFail: 500     — keep last 500 failed jobs for post-mortem
 *
 * The queue is created lazily so the chatbot starts even when Redis is down.
 */

import { Queue } from "bullmq";
import { getRedisConnection } from "../lib/redis";

export const AUDIT_QUEUE_NAME = "apollo-audit";

export interface AuditJobData {
  sessionId:  string;
  eventType:  string;
  payload:    Record<string, unknown>;
  enqueuedAt: string; // ISO timestamp for observability
}

const defaultJobOptions = {
  attempts: 3,
  backoff: {
    type:  "exponential" as const,
    delay: 1000, // 1s base → 2s → 4s
  },
  removeOnComplete: { count: 100 },
  removeOnFail:     { count: 500 },
};

let _auditQueue: Queue<AuditJobData> | null = null;

export function getAuditQueue(): Queue<AuditJobData> {
  if (_auditQueue) return _auditQueue;
  _auditQueue = new Queue<AuditJobData>(AUDIT_QUEUE_NAME, {
    connection:     getRedisConnection(),
    defaultJobOptions,
  });
  return _auditQueue;
}

/** Enqueue a single audit event. Never throws — safe for fire-and-forget. */
export async function enqueueAuditEvent(
  sessionId:  string,
  eventType:  string,
  payload:    Record<string, unknown> = {},
): Promise<void> {
  try {
    await getAuditQueue().add(
      eventType,
      { sessionId, eventType, payload, enqueuedAt: new Date().toISOString() },
    );
  } catch (err) {
    // Redis may be offline — log and continue; the chatbot must not crash.
    console.error("[auditQueue] Failed to enqueue audit event:", (err as Error).message);
  }
}
