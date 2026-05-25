import { Request, Response, NextFunction } from "express";

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  const raw = req.headers["x-session-id"];
  if (!raw) {
    req.sessionId = "anonymous";
    next();
    return;
  }

  const sessionId = String(raw).trim();
  if (!SESSION_ID_RE.test(sessionId)) {
    _res.status(400).json({ error: "Malformed X-Session-Id header." });
    return;
  }

  req.sessionId = sessionId;
  next();
}

export function isValidSessionId(value: string): boolean {
  return SESSION_ID_RE.test(String(value ?? "").trim());
}
