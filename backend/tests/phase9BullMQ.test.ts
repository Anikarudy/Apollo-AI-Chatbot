/**
 * backend/tests/phase9BullMQ.test.ts
 *
 * Phase 9 — BullMQ + Redis async infrastructure tests.
 *
 * All external dependencies are mocked so no real Redis or Postgres is needed.
 *
 * Test 1:  Redis — getRedisConnection() returns an IORedis instance
 * Test 2:  auditQueue — enqueueAuditEvent() calls queue.add() with correct data
 * Test 3:  auditQueue — Redis offline → enqueue swallows error, does not throw
 * Test 4:  auditService — logEvent() calls enqueueAuditEvent (not prisma directly)
 * Test 5:  auditService — logEventDirect() writes directly to Prisma
 * Test 6:  auditWorker — processAuditJob() writes to Prisma and logs completed
 * Test 7:  auditWorker — failed job logs retry warning
 * Test 8:  auditWorker — retries exhausted logs error without crashing
 * Test 9:  auditService — logEvent() does NOT call prisma.auditEvent.create directly
 * Test 10: analyticsQueue — enqueueAnalyticsEvent() calls queue.add() with correct data
 * Test 11: auditService — getSessionEvents() reads directly from Prisma (not queue)
 * Test 12: auditWorker — stopAuditWorker() calls worker.close()
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock ioredis using class syntax (required to be used with `new`) ──────────
vi.mock("ioredis", () => {
  class IORedis {
    on    = vi.fn().mockReturnThis();
    quit  = vi.fn().mockResolvedValue("OK");
    status = "ready";
  }
  return { default: IORedis };
});

// ── Mock BullMQ Queue and Worker using class syntax ───────────────────────────
vi.mock("bullmq", () => {
  class Queue {
    add = vi.fn().mockResolvedValue({ id: "job-1" });
  }
  class Worker {
    on    = vi.fn().mockReturnThis();
    close = vi.fn().mockResolvedValue(undefined);
    // Expose the processor for direct testing
    _processor: (job: unknown) => Promise<void>;
    constructor(_name: string, processor: (job: unknown) => Promise<void>) {
      this._processor = processor;
    }
  }
  return { Queue, Worker };
});

// ── Mock Prisma (audit client) ────────────────────────────────────────────────
vi.mock("../db/prismaClient", () => ({
  default: {
    auditEvent: {
      create:   vi.fn().mockResolvedValue({ id: "evt-1", sessionId: "s1", eventType: "booking_success", payload: {}, createdAt: new Date() }),
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 9 — Redis connection", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); });

  // ── Test 1 ─────────────────────────────────────────────────────────────────
  it("Test 1 — getRedisConnection() returns an IORedis instance", async () => {
    const { getRedisConnection } = await import("../lib/redis");
    const conn = getRedisConnection();
    expect(conn).toBeDefined();
    // Should have ioredis-like methods
    expect(typeof conn.on).toBe("function");
    expect(typeof conn.quit).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 9 — auditQueue", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); });

  // ── Test 2 ─────────────────────────────────────────────────────────────────
  it("Test 2 — enqueueAuditEvent() calls queue.add() with correct data", async () => {
    const { enqueueAuditEvent, getAuditQueue } = await import("../queues/auditQueue");
    const queue = getAuditQueue();
    const addSpy = vi.spyOn(queue, "add").mockResolvedValue({ id: "job-2" } as never);

    await enqueueAuditEvent("sess-abc", "booking_success", { appointmentId: "APT-1" });

    expect(addSpy).toHaveBeenCalledTimes(1);
    const [jobName, jobData] = addSpy.mock.calls[0];
    expect(jobName).toBe("booking_success");
    expect(jobData).toMatchObject({
      sessionId: "sess-abc",
      eventType: "booking_success",
      payload:   { appointmentId: "APT-1" },
    });
    expect(typeof (jobData as { enqueuedAt: string }).enqueuedAt).toBe("string");
  });

  // ── Test 3 ─────────────────────────────────────────────────────────────────
  it("Test 3 — Redis offline: enqueue swallows error and does not throw", async () => {
    const { enqueueAuditEvent, getAuditQueue } = await import("../queues/auditQueue");
    const queue = getAuditQueue();
    vi.spyOn(queue, "add").mockRejectedValueOnce(new Error("ECONNREFUSED — Redis is offline"));

    // Must not throw
    await expect(
      enqueueAuditEvent("sess-offline", "booking_failure", {}),
    ).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 9 — auditService", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); });

  // ── Test 4 ─────────────────────────────────────────────────────────────────
  it("Test 4 — logEvent() enqueues a job (does NOT call prisma directly)", async () => {
    const { enqueueAuditEvent, getAuditQueue } = await import("../queues/auditQueue");
    const queue = getAuditQueue();
    const addSpy = vi.spyOn(queue, "add").mockResolvedValue({ id: "job-4" } as never);

    // Re-import auditService AFTER spying so it picks up the same queue instance
    const { logEvent } = await import("../services/auditService");
    const prisma = (await import("../db/prismaClient")).default;

    await logEvent("sess-1", "workflow_switch", { from: "MAIN_MENU" });

    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(prisma.auditEvent.create).not.toHaveBeenCalled();
  });

  // ── Test 5 ─────────────────────────────────────────────────────────────────
  it("Test 5 — logEventDirect() writes directly to Prisma, not queue", async () => {
    const { enqueueAuditEvent, getAuditQueue } = await import("../queues/auditQueue");
    const queue = getAuditQueue();
    const addSpy = vi.spyOn(queue, "add").mockResolvedValue({ id: "job-5" } as never);

    const { logEventDirect } = await import("../services/auditService");
    const prisma = (await import("../db/prismaClient")).default;

    const result = await logEventDirect("sess-2", "tool_call", { tool: "fetch_doctors" });

    expect(prisma.auditEvent.create).toHaveBeenCalledTimes(1);
    expect(addSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: "evt-1" });
  });

  // ── Test 9 ─────────────────────────────────────────────────────────────────
  it("Test 9 — logEvent() never calls prisma.auditEvent.create directly", async () => {
    const { getAuditQueue } = await import("../queues/auditQueue");
    const queue = getAuditQueue();
    const addSpy = vi.spyOn(queue, "add").mockResolvedValue({ id: "job-9" } as never);

    const { logEvent } = await import("../services/auditService");
    const prisma = (await import("../db/prismaClient")).default;

    await logEvent("sess-9", "edoc_retry",   { attempt: 1 });
    await logEvent("sess-9", "edoc_timeout", { attempt: 2 });

    expect(prisma.auditEvent.create).not.toHaveBeenCalled();
    expect(addSpy).toHaveBeenCalledTimes(2);
  });

  // ── Test 11 ────────────────────────────────────────────────────────────────
  it("Test 11 — getSessionEvents() reads directly from Prisma", async () => {
    const { getAuditQueue } = await import("../queues/auditQueue");
    const queue = getAuditQueue();
    const addSpy = vi.spyOn(queue, "add").mockResolvedValue({ id: "j" } as never);

    const { getSessionEvents } = await import("../services/auditService");
    const prisma = (await import("../db/prismaClient")).default;
    (prisma.auditEvent.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: "e1", sessionId: "sess-11", eventType: "booking_success", payload: {}, createdAt: new Date() },
    ]);

    const events = await getSessionEvents("sess-11");

    expect(prisma.auditEvent.findMany).toHaveBeenCalledWith({
      where:   { sessionId: "sess-11" },
      orderBy: { createdAt: "asc" },
    });
    expect(events).toHaveLength(1);
    expect(addSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 9 — auditWorker", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); });

  // ── Test 6 ─────────────────────────────────────────────────────────────────
  it("Test 6 — worker processor writes AuditEvent to Prisma", async () => {
    const { startAuditWorker } = await import("../workers/auditWorker");
    const prisma = (await import("../db/prismaClient")).default;

    const workerInstance = startAuditWorker() as unknown as {
      _processor: (job: unknown) => Promise<void>;
    };

    const fakeJob = {
      id:           "job-test-6",
      data:         { sessionId: "sess-6", eventType: "booking_success", payload: { appointmentId: "APT-006" }, enqueuedAt: new Date().toISOString() },
      opts:         { attempts: 3 },
      attemptsMade: 1,
    };

    await workerInstance._processor(fakeJob);

    expect(prisma.auditEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditEvent.create).toHaveBeenCalledWith({
      data: {
        sessionId: "sess-6",
        eventType: "booking_success",
        payload:   { appointmentId: "APT-006" },
      },
    });
  });

  // ── Test 7 ─────────────────────────────────────────────────────────────────
  it("Test 7 — failed job (with retries remaining) logs warn", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { startAuditWorker } = await import("../workers/auditWorker");
    const workerInstance = startAuditWorker() as unknown as {
      on: ReturnType<typeof vi.fn>;
    };

    // Get the "failed" handler that was registered via worker.on("failed", ...)
    const failedHandler = workerInstance.on.mock.calls.find((c) => c[0] === "failed")?.[1] as
      ((job: unknown, err: Error) => void) | undefined;

    expect(failedHandler).toBeDefined();
    failedHandler!(
      { id: "job-7", data: { eventType: "workflow_switch" }, opts: { attempts: 3 }, attemptsMade: 1 },
      new Error("DB timeout"),
    );

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("job:failed"));
    consoleSpy.mockRestore();
  });

  // ── Test 8 ─────────────────────────────────────────────────────────────────
  it("Test 8 — retries exhausted (attemptsMade === attempts) logs error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { startAuditWorker } = await import("../workers/auditWorker");
    const workerInstance = startAuditWorker() as unknown as {
      on: ReturnType<typeof vi.fn>;
    };

    const failedHandler = workerInstance.on.mock.calls.find((c) => c[0] === "failed")?.[1] as
      ((job: unknown, err: Error) => void) | undefined;

    failedHandler!(
      { id: "job-8", data: { eventType: "edoc_timeout" }, opts: { attempts: 3 }, attemptsMade: 3 },
      new Error("All retries failed"),
    );

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("retries_exhausted"));
    errorSpy.mockRestore();
  });

  // ── Test 12 ────────────────────────────────────────────────────────────────
  it("Test 12 — stopAuditWorker() calls worker.close()", async () => {
    const { startAuditWorker, stopAuditWorker } = await import("../workers/auditWorker");
    const workerInstance = startAuditWorker() as unknown as {
      close: ReturnType<typeof vi.fn>;
    };

    await stopAuditWorker();
    expect(workerInstance.close).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 9 — analyticsQueue", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); });

  // ── Test 10 ────────────────────────────────────────────────────────────────
  it("Test 10 — enqueueAnalyticsEvent() calls queue.add() with correct data", async () => {
    const { enqueueAnalyticsEvent, getAnalyticsQueue } = await import("../queues/analyticsQueue");
    const queue = getAnalyticsQueue();
    const addSpy = vi.spyOn(queue, "add").mockResolvedValue({ id: "job-10" } as never);

    await enqueueAnalyticsEvent("booking_funnel", { step: "confirm", doctorName: "Dr. Reddy" }, "sess-10");

    expect(addSpy).toHaveBeenCalledTimes(1);
    const [jobName, jobData] = addSpy.mock.calls[0];
    expect(jobName).toBe("booking_funnel");
    expect(jobData).toMatchObject({
      eventType: "booking_funnel",
      sessionId: "sess-10",
      data:      { step: "confirm" },
    });
    expect(typeof (jobData as { enqueuedAt: string }).enqueuedAt).toBe("string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 9 — Worker offline resilience", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); });

  // ── Test 5 ─────────────────────────────────────────────────────────────────
  it("Test 5 — worker offline: chatbot survives Redis enqueue failures", async () => {
    const { enqueueAuditEvent, getAuditQueue } = await import("../queues/auditQueue");
    const queue = getAuditQueue();
    vi.spyOn(queue, "add").mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(enqueueAuditEvent("s1", "booking_success", {})).resolves.toBeUndefined();
    await expect(enqueueAuditEvent("s2", "edoc_retry",      {})).resolves.toBeUndefined();
    await expect(enqueueAuditEvent("s3", "workflow_switch", {})).resolves.toBeUndefined();
  });
});
