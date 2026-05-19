/**
 * backend/queues/analyticsQueue.ts
 *
 * BullMQ queue for analytics aggregation events.
 *
 * Reserved for future analytics jobs such as:
 *  - session-level aggregations
 *  - booking funnel metrics
 *  - doctor popularity scoring
 *  - hourly/daily rollups
 *
 * Currently acts as a typed stub: jobs can be enqueued from anywhere
 * in the backend; workers can be added without touching the queue definition.
 *
 * Default job options mirror auditQueue for consistency.
 */

import { Queue } from "bullmq";
import { getRedisConnection } from "../lib/redis";

export const ANALYTICS_QUEUE_NAME = "apollo-analytics";

export interface AnalyticsJobData {
  eventType:  string;
  sessionId?: string;
  data:       Record<string, unknown>;
  enqueuedAt: string;
}

const defaultJobOptions = {
  attempts: 3,
  backoff: {
    type:  "exponential" as const,
    delay: 1000,
  },
  removeOnComplete: { count: 50 },
  removeOnFail:     { count: 200 },
};

let _analyticsQueue: Queue<AnalyticsJobData> | null = null;

export function getAnalyticsQueue(): Queue<AnalyticsJobData> {
  if (_analyticsQueue) return _analyticsQueue;
  _analyticsQueue = new Queue<AnalyticsJobData>(ANALYTICS_QUEUE_NAME, {
    connection:     getRedisConnection(),
    defaultJobOptions,
  });
  return _analyticsQueue;
}

/** Enqueue an analytics event. Never throws. */
export async function enqueueAnalyticsEvent(
  eventType:  string,
  data:       Record<string, unknown>,
  sessionId?: string,
): Promise<void> {
  try {
    await getAnalyticsQueue().add(
      eventType,
      { eventType, data, sessionId, enqueuedAt: new Date().toISOString() },
    );
  } catch (err) {
    console.error("[analyticsQueue] Failed to enqueue analytics event:", (err as Error).message);
  }
}
