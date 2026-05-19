/**
 * backend/lib/logger.ts
 *
 * Shared pino logger instance for all backend modules.
 * Imported by workers, infra, and services so their output goes through
 * pino-pretty in development alongside the HTTP request logs.
 */

import pino from "pino";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  ...(process.env.NODE_ENV !== "production" && {
    transport: { target: "pino-pretty", options: { colorize: true, ignore: "pid,hostname" } },
  }),
});

export default logger;
