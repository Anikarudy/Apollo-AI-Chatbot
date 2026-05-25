/**
 * backend/lib/logger.ts
 *
 * Shared pino logger instance for all backend modules.
 * Imported by workers, infra, and services so their output goes through
 * pino-pretty in development alongside the HTTP request logs.
 */

import pino from "pino";
import { maskSensitiveData } from "./maskSensitiveData";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  hooks: {
    logMethod(args, method) {
      const safeArgs = args.map((arg) => {
        if (typeof arg === "object" && arg !== null) return maskSensitiveData(arg);
        if (typeof arg === "string") return maskSensitiveData(arg);
        return arg;
      });
      (method as (...methodArgs: unknown[]) => void).apply(this, safeArgs as [unknown, ...unknown[]]);
    },
  },
  ...(process.env.NODE_ENV !== "production" && {
    transport: { target: "pino-pretty", options: { colorize: true, ignore: "pid,hostname" } },
  }),
});

export default logger;
