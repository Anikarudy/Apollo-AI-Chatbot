import { Request, Response, NextFunction } from "express";
import log from "../lib/logger";

/** Logs method, path, status code, and response time for every request. */
export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    const status = res.statusCode;
    const logFn =
      status >= 500 ? log.error.bind(log) :
      status >= 400 ? log.warn.bind(log) :
                      log.info.bind(log);
    logFn({ method: req.method, path: req.path, status, ms }, `${req.method} ${req.path} ${status}`);
  });
  next();
}
