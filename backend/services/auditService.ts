/**
 * backend/services/auditService.ts
 *
 * Writes structured audit events to apollo_audit.AuditEvent.
 *
 * Event types (convention):
 *   workflow_switch      — agent/decide routed to a new workflow
 *   booking_success      — EDOC BookAppointment returned retcode 0
 *   booking_failure      — EDOC BookAppointment returned an error / non-0 retcode
 *   api_failure          — any EDOC API returned 500
 *   button_click         — user pressed a quick reply, doctor card, or slot button
 *   tool_call            — agent tool invoked (fetch_doctors, get_live_slots, etc.)
 *
 * Design rules:
 *   - Fire-and-forget at the call site: `void logEvent(...)` — never await in request handler
 *   - Never throws to the caller — errors are logged internally
 */

import prisma from "../db/prismaClient";
import type { AuditEvent, Prisma } from "@prisma/client";

/**
 * Insert one audit event row.
 * Safe to call fire-and-forget — swallows all DB errors.
 */
export async function logEvent(
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
    console.error("[auditService] logEvent failed:", err);
    return null;
  }
}

/**
 * Retrieve all audit events for a session in chronological order.
 * Useful for replaying session history or debugging.
 */
export async function getSessionEvents(sessionId: string): Promise<AuditEvent[]> {
  return prisma.auditEvent.findMany({
    where: { sessionId },
    orderBy: { createdAt: "asc" },
  });
}
