/**
 * backend/lib/redis.ts
 *
 * Shared Redis connection for BullMQ queues and workers.
 *
 * Design rules:
 *  - Single IORedis instance shared across all queues/workers.
 *  - Reads REDIS_URL from .env; falls back to localhost:6379.
 *  - enableOfflineQueue: false → jobs fail fast when Redis is unreachable
 *    (prevents the chatbot hanging on Redis downtime).
 *  - maxRetriesPerRequest: null → required by BullMQ to use blocking commands.
 *  - Connection events are logged so Redis health is always observable.
 */

import IORedis from "ioredis";
import log from "./logger";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

let _redis: IORedis | null = null;

export function getRedisConnection(): IORedis {
  if (_redis) return _redis;

  _redis = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,   // required by BullMQ
    enableOfflineQueue:   false,  // fail-fast when Redis is down
    lazyConnect:          false,
  });

  _redis.on("connect",      () => log.info("[Redis] Connected"));
  _redis.on("ready",        () => log.info("[Redis] Ready"));
  _redis.on("error",        (err) => log.error({ err: err.message }, "[Redis] Error"));
  _redis.on("close",        () => log.warn("[Redis] Connection closed"));
  _redis.on("reconnecting", (ms: number) => log.info({ retryMs: ms }, "[Redis] Reconnecting"));

  return _redis;
}

/** Gracefully close the shared connection (used on process shutdown). */
export async function closeRedisConnection(): Promise<void> {
  if (_redis) {
    await _redis.quit().catch(() => {});
    _redis = null;
  }
}
