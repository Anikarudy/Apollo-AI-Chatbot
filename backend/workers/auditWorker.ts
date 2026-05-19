/**
 * backend/workers/auditWorker.ts
 *
 * BullMQ worker that consumes audit jobs and writes them to Postgres.
 *
 * Behaviour:
 *  - Processes one job at a time (concurrency: 1) to avoid DB write storms.
 *  - Logs job started / completed / failed with structured output.
 *  - On all 3 retries exhausted, logs to stderr — chatbot is unaffected.
 *  - Worker failing or being offline does NOT crash the Express server.
 *    Jobs accumulate in Redis and are drained when the worker restarts.
 *
 * To start the worker standalone (future):
 *   ts-node backend/workers/auditWorker.ts
 */

import { Worker, type Job } from "bullmq";
import { getRedisConnection } from "../lib/redis";
import { AUDIT_QUEUE_NAME, type AuditJobData } from "../queues/auditQueue";
import prisma from "../db/prismaClient";
import type { Prisma } from "@prisma/client";
import log from "../lib/logger";

/** Process a single audit job — write one AuditEvent row. */
async function processAuditJob(job: Job<AuditJobData>): Promise<void> {
  const { sessionId, eventType, payload, enqueuedAt } = job.data;

  log.info({ jobId: job.id, type: eventType, session: sessionId, enqueued: enqueuedAt }, "[worker] job started");

  await prisma.auditEvent.create({
    data: {
      sessionId,
      eventType,
      payload: (payload ?? {}) as Prisma.InputJsonValue,
    },
  });

  log.info({ jobId: job.id, type: eventType, session: sessionId }, "[worker] job completed");
}

let _worker: Worker<AuditJobData> | null = null;

/**
 * Start the audit worker.
 * Idempotent — safe to call multiple times; only one worker instance is created.
 */
export function startAuditWorker(): Worker<AuditJobData> {
  if (_worker) return _worker;

  _worker = new Worker<AuditJobData>(
    AUDIT_QUEUE_NAME,
    processAuditJob,
    {
      connection:  getRedisConnection(),
      concurrency: 1,
    },
  );

  _worker.on("failed", (job, err) => {
    const attemptsLeft = job ? (job.opts.attempts ?? 3) - (job.attemptsMade) : 0;
    if (attemptsLeft <= 0) {
      log.error({ jobId: job?.id, type: job?.data?.eventType, err: err.message }, "[worker] retries exhausted");
    } else {
      log.warn({ jobId: job?.id, type: job?.data?.eventType, attempt: job?.attemptsMade, err: err.message }, "[worker] job failed — retrying");
    }
  });

  _worker.on("error", (err) => {
    log.error({ err: err.message }, "[worker] worker error");
  });

  log.info({ queue: AUDIT_QUEUE_NAME }, "[worker] audit worker started");
  return _worker;
}

/**
 * Gracefully shut down the audit worker.
 * Called during process.on("SIGTERM") / "SIGINT" so in-flight jobs complete.
 */
export async function stopAuditWorker(): Promise<void> {
  if (_worker) {
    await _worker.close();
    _worker = null;
    log.info("[worker] audit worker stopped");
  }
}
