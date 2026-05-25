import { Router, Request, Response } from "express";
import { requireAdmin } from "../middleware/adminAuth.middleware";
import { buildSessionDebugPayload } from "../services/adminDebugService";
import log from "../lib/logger";
import { isValidSessionId } from "../middleware/session.middleware";

export const adminRouter = Router();

// GET /api/admin/session/:sessionId — full replay/debug timeline for a session
// Requires header: X-Admin-Key: <ADMIN_DEBUG_KEY>
adminRouter.get("/session/:sessionId", async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;

  const { sessionId } = req.params;

  if (!sessionId || typeof sessionId !== "string" || sessionId.trim().length === 0) {
    res.status(400).json({ error: "sessionId is required." });
    return;
  }
  if (!isValidSessionId(sessionId.trim())) {
    res.status(400).json({ error: "sessionId format is invalid." });
    return;
  }
  // Enforce safe length to prevent DB abuse (UUIDs are 36 chars)
  if (sessionId.length > 128) {
    res.status(400).json({ error: "sessionId is malformed." });
    return;
  }

  try {
    const payload = await buildSessionDebugPayload(sessionId.trim());
    if (!payload) {
      res.status(404).json({ error: `No session found for id: ${sessionId}` });
      return;
    }
    res.json(payload);
  } catch (err) {
    log.error({ err }, "GET /api/admin/session/:sessionId error");
    res.status(500).json({ error: "Failed to build session debug payload." });
  }
});
