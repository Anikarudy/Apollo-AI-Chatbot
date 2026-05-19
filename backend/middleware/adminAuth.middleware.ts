import { Request, Response } from "express";

export const ADMIN_DEBUG_KEY = process.env.ADMIN_DEBUG_KEY ?? "";

/**
 * Guard: returns false and sends 401/503 if request lacks a valid admin key.
 * Usage: if (!requireAdmin(req, res)) return;
 */
export function requireAdmin(req: Request, res: Response): boolean {
  if (!ADMIN_DEBUG_KEY) {
    res.status(503).json({ error: "Admin debug endpoint is not configured on this server." });
    return false;
  }
  const provided = req.headers["x-admin-key"];
  if (!provided || provided !== ADMIN_DEBUG_KEY) {
    res.status(401).json({ error: "Unauthorized. Valid X-Admin-Key header required." });
    return false;
  }
  return true;
}
