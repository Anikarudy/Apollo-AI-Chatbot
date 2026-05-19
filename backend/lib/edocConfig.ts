import { Response } from "express";
import log from "./logger";

export const EDOC_BASE = (process.env.APOLLO_EDOC_BASE_URL ?? "").replace(/\/$/, "");
export const EDOC_AUTH = process.env.APOLLO_EDOC_AUTH_KEY ?? "";

export function edocHeaders(): Record<string, string> {
  return { AuthKey: EDOC_AUTH, "Content-Type": "application/json" };
}

/**
 * Guard: returns false and sends 503 if EDOC env vars are not configured.
 * Usage: if (!requireEdoc(res)) return;
 */
export function requireEdoc(res: Response): boolean {
  if (!EDOC_BASE || !EDOC_AUTH) {
    res.status(503).json({
      error: "EDOC API not configured. Set APOLLO_EDOC_BASE_URL and APOLLO_EDOC_AUTH_KEY in .env",
    });
    return false;
  }
  return true;
}

/** Structured log for EDOC request/response steps. */
export function logEdoc(step: string, payload: unknown): void {
  log.info({ data: payload }, `[EDOC] ${step}`);
}
