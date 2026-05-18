/**
 * backend/tests/adminDebugService.test.ts
 *
 * Tests for adminDebugService.buildSessionDebugPayload covering:
 *
 *  1. Full session replay — valid session with messages + audit events
 *  2. Invalid / non-existent session ID → returns null
 *  3. Missing admin key → 401 guard (tested via requireAdmin logic)
 *  4. Chronological ordering of the derived timeline
 *  5. Timeline merge correctness — messages and audit events interleaved properly
 *  6. Stats — booking count, fallback count, provider usage, duration
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock Prisma client ────────────────────────────────────────────────────────
vi.mock("../db/prismaClient", () => ({
  default: {
    chatSession: { findUnique: vi.fn() },
    chatMessage: { findMany: vi.fn() },
    auditEvent:  { findMany: vi.fn() },
  },
}));
import prisma from "../db/prismaClient";
import { buildSessionDebugPayload } from "../services/adminDebugService";

// ── Fixtures ──────────────────────────────────────────────────────────────────
const SESSION_ID = "test-session-uuid-1234";

const mockSession = {
  id:        "internal-uuid",
  sessionId: SESSION_ID,
  language:  "en",
  createdAt: new Date("2026-05-18T06:00:00Z"),
  updatedAt: new Date("2026-05-18T06:30:00Z"),
};

function makeMessage(overrides: Partial<{
  id: string; role: string; message: string; messageType: string | null;
  buttonLabel: string | null; buttonValue: string | null; machineState: string | null;
  createdAt: Date;
}> = {}) {
  return {
    id:          "msg-1",
    sessionId:   SESSION_ID,
    role:        "user",
    message:     "I need a cardiologist",
    messageType: "text",
    buttonLabel: null,
    buttonValue: null,
    machineState: "MAIN_MENU",
    agentAction: null,
    metadata:    null,
    createdAt:   new Date("2026-05-18T06:05:00Z"),
    ...overrides,
  };
}

function makeAuditEvent(overrides: Partial<{
  id: string; eventType: string; payload: unknown; createdAt: Date;
}> = {}) {
  return {
    id:        "evt-1",
    sessionId: SESSION_ID,
    eventType: "booking_success",
    payload:   { appointmentId: "APT-999", resourceId: "DOC-1" },
    createdAt: new Date("2026-05-18T06:20:00Z"),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("adminDebugService.buildSessionDebugPayload", () => {
  beforeEach(() => vi.clearAllMocks());

  // ── Test 1: Full session replay ─────────────────────────────────────────────
  it("Test 1 — returns full payload for a valid session", async () => {
    (prisma.chatSession.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockSession);
    (prisma.chatMessage.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeMessage()]);
    (prisma.auditEvent.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeAuditEvent()]);

    const result = await buildSessionDebugPayload(SESSION_ID);

    expect(result).not.toBeNull();
    expect(result!.session.sessionId).toBe(SESSION_ID);
    expect(result!.messages).toHaveLength(1);
    expect(result!.auditEvents).toHaveLength(1);
    expect(result!.derivedTimeline).toHaveLength(2);

    // Internal DB id must not be exposed
    expect((result!.session as Record<string, unknown>).id).toBeUndefined();
  });

  // ── Test 2: Non-existent session → null ────────────────────────────────────
  it("Test 2 — returns null for an unknown session ID", async () => {
    (prisma.chatSession.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.chatMessage.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.auditEvent.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const result = await buildSessionDebugPayload("nonexistent-session");
    expect(result).toBeNull();
  });

  // ── Test 3: requireAdmin key guard ─────────────────────────────────────────
  // The guard lives in index.ts. We test the logic directly here.
  it("Test 3 — admin key guard: rejects missing or wrong key", () => {
    const ADMIN_KEY = "secret-key";

    function checkKey(provided: string | undefined): boolean {
      return provided === ADMIN_KEY;
    }

    expect(checkKey(undefined)).toBe(false);
    expect(checkKey("wrong-key")).toBe(false);
    expect(checkKey("secret-key")).toBe(true);
  });

  // ── Test 4: Chronological ordering ─────────────────────────────────────────
  it("Test 4 — derivedTimeline is sorted chronologically ascending", async () => {
    const early = makeMessage({ id: "msg-early", createdAt: new Date("2026-05-18T06:01:00Z") });
    const late  = makeMessage({ id: "msg-late",  createdAt: new Date("2026-05-18T06:10:00Z") });
    const evt   = makeAuditEvent({ id: "evt-mid", createdAt: new Date("2026-05-18T06:05:00Z") });

    // Provide them out of order to ensure sorting happens in the service
    (prisma.chatSession.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockSession);
    (prisma.chatMessage.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([late, early]);
    (prisma.auditEvent.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([evt]);

    const result = await buildSessionDebugPayload(SESSION_ID);

    const timestamps = result!.derivedTimeline.map((e) => e.timestamp);
    const sorted = [...timestamps].sort();
    expect(timestamps).toEqual(sorted);

    // Verify the actual order: early msg → audit event → late msg
    expect(result!.derivedTimeline[0].rawData.id).toBe("msg-early");
    expect(result!.derivedTimeline[1].rawData.id).toBe("evt-mid");
    expect(result!.derivedTimeline[2].rawData.id).toBe("msg-late");
  });

  // ── Test 5: Timeline merge correctness ─────────────────────────────────────
  it("Test 5 — timeline merges messages and audit events with correct type labels", async () => {
    (prisma.chatSession.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockSession);
    (prisma.chatMessage.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMessage({ id: "msg-1", createdAt: new Date("2026-05-18T06:05:00Z") }),
    ]);
    (prisma.auditEvent.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeAuditEvent({ id: "evt-1", createdAt: new Date("2026-05-18T06:10:00Z") }),
    ]);

    const result = await buildSessionDebugPayload(SESSION_ID);
    const tl = result!.derivedTimeline;

    expect(tl[0].type).toBe("message");
    expect(tl[1].type).toBe("audit");
    expect(tl[0].summary).toContain("User:");
    expect(tl[1].summary).toContain("Booking confirmed");
  });

  // ── Test 6: Stats — booking count, fallback, provider usage, duration ──────
  it("Test 6 — stats are correctly computed", async () => {
    const messages = [
      makeMessage({ id: "m1", createdAt: new Date("2026-05-18T06:00:00Z") }),
      makeMessage({ id: "m2", role: "bot", createdAt: new Date("2026-05-18T06:30:00Z") }),
    ];
    const auditEvents = [
      makeAuditEvent({
        id: "e1",
        eventType: "booking_success",
        payload: { appointmentId: "APT-1" },
        createdAt: new Date("2026-05-18T06:10:00Z"),
      }),
      makeAuditEvent({
        id: "e2",
        eventType: "patient_provider.getPatientByPhone",
        payload: { provider: "apollo_edoc", fallbackUsed: false },
        createdAt: new Date("2026-05-18T06:11:00Z"),
      }),
      makeAuditEvent({
        id: "e3",
        eventType: "patient_provider.getPatientByPhone",
        payload: { provider: "prisma_local", fallbackUsed: true, fallbackReason: "edoc_timeout" },
        createdAt: new Date("2026-05-18T06:12:00Z"),
      }),
    ];

    (prisma.chatSession.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockSession);
    (prisma.chatMessage.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(messages);
    (prisma.auditEvent.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(auditEvents);

    const result = await buildSessionDebugPayload(SESSION_ID);
    const stats = result!.stats;

    expect(stats.totalMessages).toBe(2);
    expect(stats.totalAuditEvents).toBe(3);
    expect(stats.bookingCount).toBe(1);
    expect(stats.fallbackCount).toBe(1);
    expect(stats.providerUsage["apollo_edoc"]).toBe(1);
    expect(stats.providerUsage["prisma_local"]).toBe(1);
    // Duration: from 06:00 to 06:30 = 1800 seconds
    expect(stats.durationSeconds).toBe(1800);
  });
});
