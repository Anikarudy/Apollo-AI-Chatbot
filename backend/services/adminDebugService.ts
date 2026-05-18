/**
 * backend/services/adminDebugService.ts
 *
 * Constructs a full session replay/debug payload for a given sessionId.
 *
 * Responsibilities:
 *   - Fetch ChatSession + all messages (no limit — admin view wants full history)
 *   - Fetch all AuditEvents for the session
 *   - Merge into a chronological derived timeline
 *   - Compute summary stats (duration, message count, provider usage, booking count, fallbacks)
 *
 * Security rules enforced here:
 *   - NEVER include AuthKey, EDOC secrets, or env vars in output
 *   - Payload fields from audit events are included but already stripped at write time
 *   - Endpoint is read-only
 */

import prisma from "../db/prismaClient";
import type { ChatSession, ChatMessage, AuditEvent } from "@prisma/client";

// ── Output types ──────────────────────────────────────────────────────────────

export interface DebugMessage {
  id:          string;
  role:        string;
  content:     string;
  messageType: string | null;
  buttonLabel: string | null;
  buttonValue: string | null;
  machineState: string | null;
  createdAt:   string; // ISO
}

export interface DebugAuditEvent {
  id:        string;
  eventType: string;
  payload:   unknown;
  createdAt: string; // ISO
}

export interface TimelineEntry {
  type:      "message" | "audit";
  timestamp: string; // ISO
  summary:   string;
  rawData:   DebugMessage | DebugAuditEvent;
}

export interface SessionStats {
  totalMessages:   number;
  totalAuditEvents: number;
  durationSeconds: number | null;  // null if only one timestamp exists
  bookingCount:    number;
  fallbackCount:   number;
  providerUsage:   Record<string, number>; // e.g. { apollo_edoc: 3, prisma_local: 1 }
}

export interface AdminSessionPayload {
  session:        Omit<ChatSession, "id">;
  messages:       DebugMessage[];
  auditEvents:    DebugAuditEvent[];
  derivedTimeline: TimelineEntry[];
  stats:          SessionStats;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function summariseMessage(msg: ChatMessage): string {
  const who = msg.role === "user" ? "User" : "Bot";
  if (msg.buttonLabel) return `${who} clicked "${msg.buttonLabel}"`;
  if (msg.messageType === "doctor_selection") return `${who} selected a doctor`;
  if (msg.messageType === "slot_selection")   return `${who} selected a slot`;
  if (msg.messageType === "system_event")     return `System: ${msg.message.substring(0, 80)}`;
  // Truncate long text messages
  const text = msg.message.length > 100 ? msg.message.substring(0, 100) + "…" : msg.message;
  return `${who}: ${text}`;
}

function summariseAuditEvent(ev: AuditEvent): string {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  switch (ev.eventType) {
    case "booking_success":
      return `Booking confirmed — Appt ID: ${p.appointmentId ?? "unknown"}`;
    case "booking_failure":
      return `Booking failed — ${p.error ?? "unknown error"}`;
    case "workflow_switch":
      return `Workflow → ${p.workflow ?? p.to ?? "unknown"}`;
    case "patient_provider.getPatientByPhone":
    case "patient_provider.createPatient":
    case "patient_provider.setUhid": {
      const op = ev.eventType.split(".")[1];
      const src = p.provider ?? "unknown";
      const fb  = p.fallbackUsed ? ` (fallback: ${p.fallbackReason})` : "";
      return `Patient op "${op}" via ${src}${fb}`;
    }
    case "api_failure":
      return `API failure — ${p.endpoint ?? "unknown endpoint"}`;
    default:
      return ev.eventType.replace(/_/g, " ");
  }
}

function toDebugMessage(msg: ChatMessage): DebugMessage {
  return {
    id:          msg.id,
    role:        msg.role,
    content:     msg.message,
    messageType: msg.messageType,
    buttonLabel: msg.buttonLabel,
    buttonValue: msg.buttonValue,
    machineState: msg.machineState,
    createdAt:   msg.createdAt.toISOString(),
  };
}

function toDebugAuditEvent(ev: AuditEvent): DebugAuditEvent {
  return {
    id:        ev.id,
    eventType: ev.eventType,
    payload:   ev.payload,
    createdAt: ev.createdAt.toISOString(),
  };
}

function buildTimeline(
  messages: ChatMessage[],
  auditEvents: AuditEvent[]
): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...messages.map((m): TimelineEntry => ({
      type:      "message",
      timestamp: m.createdAt.toISOString(),
      summary:   summariseMessage(m),
      rawData:   toDebugMessage(m),
    })),
    ...auditEvents.map((e): TimelineEntry => ({
      type:      "audit",
      timestamp: e.createdAt.toISOString(),
      summary:   summariseAuditEvent(e),
      rawData:   toDebugAuditEvent(e),
    })),
  ];
  return entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function computeStats(
  messages: ChatMessage[],
  auditEvents: AuditEvent[]
): SessionStats {
  const bookingCount = auditEvents.filter((e) => e.eventType === "booking_success").length;
  const fallbackCount = auditEvents.filter((e) => {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    return p.fallbackUsed === true;
  }).length;

  // Provider usage: count how many times each provider was the one that served the request
  const providerUsage: Record<string, number> = {};
  for (const e of auditEvents) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (typeof p.provider === "string") {
      providerUsage[p.provider] = (providerUsage[p.provider] ?? 0) + 1;
    }
  }

  // Session duration: time between first and last event across both tables
  const timestamps = [
    ...messages.map((m) => m.createdAt.getTime()),
    ...auditEvents.map((e) => e.createdAt.getTime()),
  ].filter(Boolean).sort((a, b) => a - b);

  const durationSeconds =
    timestamps.length >= 2
      ? Math.round((timestamps[timestamps.length - 1] - timestamps[0]) / 1000)
      : null;

  return {
    totalMessages:    messages.length,
    totalAuditEvents: auditEvents.length,
    durationSeconds,
    bookingCount,
    fallbackCount,
    providerUsage,
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Build the full admin debug payload for a session.
 * Returns null if the session does not exist.
 */
export async function buildSessionDebugPayload(
  sessionId: string
): Promise<AdminSessionPayload | null> {
  // Fetch all three in parallel
  const [sessionRow, messages, auditEvents] = await Promise.all([
    prisma.chatSession.findUnique({ where: { sessionId } }),
    prisma.chatMessage.findMany({
      where:   { sessionId },
      orderBy: { createdAt: "asc" },
    }),
    prisma.auditEvent.findMany({
      where:   { sessionId },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  if (!sessionRow) return null;

  const { id: _id, ...sessionWithoutInternalId } = sessionRow;

  return {
    session:         sessionWithoutInternalId,
    messages:        messages.map(toDebugMessage),
    auditEvents:     auditEvents.map(toDebugAuditEvent),
    derivedTimeline: buildTimeline(messages, auditEvents),
    stats:           computeStats(messages, auditEvents),
  };
}
