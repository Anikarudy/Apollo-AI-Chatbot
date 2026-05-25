import { Request, Response } from "express";

export const ADMIN_DEBUG_KEY = process.env.ADMIN_DEBUG_KEY ?? "";
const INTERNAL_ROUTE_KEY = process.env.INTERNAL_ROUTE_KEY ?? "";

export function hasValidAdminKey(req: Request): boolean {
  const provided = String(req.headers["x-admin-key"] ?? "").trim();
  return Boolean(ADMIN_DEBUG_KEY) && Boolean(provided) && provided === ADMIN_DEBUG_KEY;
}

/**
 * Guard: returns false and sends 401/503 if request lacks a valid admin key.
 * Usage: if (!requireAdmin(req, res)) return;
 */
export function requireAdmin(req: Request, res: Response): boolean {
  if (!ADMIN_DEBUG_KEY) {
    res.status(503).json({ error: "Admin debug endpoint is not configured on this server." });
    return false;
  }
  if (!hasValidAdminKey(req)) {
    res.status(401).json({ error: "Unauthorized. Valid X-Admin-Key header required." });
    return false;
  }
  return true;
}

/**
 * Internal route guard.
 * - Dev/test: open by default
 * - Production/public mode: requires either admin key or internal route key
 */
export function requireInternalRouteAccess(req: Request, res: Response): boolean {
  const isProd = process.env.NODE_ENV === "production";
  const isPublicMode = String(process.env.PUBLIC_EXPOSURE_MODE ?? "false").toLowerCase() === "true";

  if (!isProd && !isPublicMode) return true;
  if (hasValidAdminKey(req)) return true;

  const providedInternalKey = String(req.headers["x-internal-route-key"] ?? "").trim();
  if (INTERNAL_ROUTE_KEY && providedInternalKey === INTERNAL_ROUTE_KEY) return true;

  res.status(403).json({ error: "Forbidden. Internal route access denied." });
  return false;
}
