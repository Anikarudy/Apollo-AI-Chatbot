/**
 * backend/services/auditService.ts
 *
 * Writes structured audit events to apollo_audit.AuditEvent.
 *
 * Phase 9 change:
 *   logEvent() now enqueues a BullMQ job instead of writing directly to Postgres.
 *   The auditWorker consumes the job and performs the actual DB write.
 *
 *   Benefits:
 *     - Request handlers are no longer blocked by audit DB latency.
 *     - Audit writes are automatically retried (3× exponential backoff) on failure.
 *     - Worker can be restarted without losing queued events (Redis durability).
 *
 *   Trade-off:
 *     - Audit events appear in Prisma Studio with a slight delay (eventual consistency).
 *     - If both Redis AND Postgres are down, events are lost — acceptable for observability.
 *
 * logEventDirect() remains for contexts that require an immediate synchronous write
 * (e.g. admin replay endpoint building session snapshots at query time).
 *
 * Event types (convention):
 *   workflow_switch          — agent/decide routed to a new workflow
 *   booking_success          — EDOC BookAppointment returned retcode 0
 *   booking_failure          — EDOC BookAppointment returned an error / non-0 retcode
 *   api_failure              — any EDOC API returned 500
 *   button_click             — user pressed a quick reply, doctor card, or slot button
 *   tool_call                — agent tool invoked (fetch_doctors, get_live_slots, etc.)
 *   idempotency_hit          — booking duplicate prevented
 *   booking_duplicate_prevented — stored response returned for duplicate bookingRequestId
 *   edoc_retry               — EDOC call retried after transient failure
 *   edoc_timeout             — EDOC call timed out
 *   edoc_failure             — EDOC retries exhausted
 *
 * Design rules:
 *   - Fire-and-forget at the call site: `void logEvent(...)` — never await in request handler
 *   - Never throws to the caller — errors are logged internally
 */

import prisma from "../db/prismaClient";
import type { AuditEvent, Prisma } from "@prisma/client";
import { enqueueAuditEvent } from "../queues/auditQueue";

/**
 * Async audit log — enqueues a BullMQ job.
 * Safe to call fire-and-forget. Never throws.
 * The job will be written to Postgres by the auditWorker with retry logic.
 */
export async function logEvent(
  sessionId: string,
  eventType: string,
  payload?: Record<string, unknown>
): Promise<void> {
  await enqueueAuditEvent(sessionId, eventType, payload ?? {});
}

/**
 * Synchronous audit log — writes directly to Postgres.
 * Use only where you need an immediate, guaranteed write (e.g. critical path).
 * In most cases prefer logEvent() for async enqueueing.
 */
export async function logEventDirect(
  sessionId: string,
  eventType: string,
  payload?: Record<string, unknown>
): Promise<AuditEvent | null> {
  try {
    return await prisma.auditEvent.create({
      data: {
        sessionId,
        eventType,
        payload: (payload ?? {}) as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    console.error("[auditService] logEventDirect failed:", err);
    return null;
  }
}

/**
 * Retrieve all audit events for a session in chronological order.
 * Used by the admin replay endpoint — always reads directly from Postgres.
 * Note: recently enqueued events may not yet be written (eventual consistency).
 */
export async function getSessionEvents(sessionId: string): Promise<AuditEvent[]> {
  return prisma.auditEvent.findMany({
    where: { sessionId },
    orderBy: { createdAt: "asc" },
  });
}

