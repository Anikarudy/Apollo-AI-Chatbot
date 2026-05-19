import { Request, Response, NextFunction } from "express";

// Augment the Express Request type so req.sessionId is available everywhere.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      sessionId: string;
    }
  }
}

/** Reads X-Session-Id header and attaches it to req.sessionId. */
export function sessionMiddleware(req: Request, _res: Response, next: NextFunction): void {
  req.sessionId = String(req.headers["x-session-id"] ?? "anonymous");
  next();
}
