/**
 * backend/infra/edocClient.ts
 *
 * Centralised EDOC API wrapper.
 *
 * ALL EDOC HTTP calls in the backend should go through this module.
 * This ensures:
 *   - Consistent 8-second timeout on every call
 *   - Retry with exponential backoff (max 3 attempts)
 *   - Circuit-breaker protection (stops hammering EDOC when it's down)
 *   - Structured audit events: edoc_retry, edoc_timeout, edoc_failure
 *   - Graceful degradation: returns SafeFailureResponse instead of crashing
 *
 * Consumers should check `isSafeFailure(result)` before using the response.
 */

import axios from "axios";
import { retryWithBackoff, safeFailure, type SafeFailureResponse } from "./retryWithBackoff";
import { logEvent } from "../services/auditService";

// ── Config ────────────────────────────────────────────────────────────────────
const EDOC_BASE = (process.env.APOLLO_EDOC_BASE_URL ?? "").replace(/\/$/, "");
const EDOC_AUTH = process.env.APOLLO_EDOC_AUTH_KEY ?? "";

/** Default timeout for EDOC calls (ms). Tight enough to fail fast. */
const EDOC_TIMEOUT_MS = 8_000;

function edocHeaders(): Record<string, string> {
  return { AuthKey: EDOC_AUTH, "Content-Type": "application/json" };
}

/** Type-guard: true when the result is a graceful-degradation response. */
export function isSafeFailure(r: unknown): r is SafeFailureResponse {
  return typeof r === "object" && r !== null && (r as SafeFailureResponse).success === false;
}

export function isEdocConfigured(): boolean {
  return Boolean(EDOC_BASE && EDOC_AUTH);
}

// ── Internal log helper ───────────────────────────────────────────────────────
function logEdoc(step: string, payload: unknown): void {
  try {
    console.info(`[EDOC] ${step} ${JSON.stringify(payload)}`);
  } catch {
    console.info(`[EDOC] ${step}`, payload);
  }
}

// ── Core POST wrapper ─────────────────────────────────────────────────────────
/**
 * POST to an EDOC API endpoint with retry + circuit-breaker.
 *
 * @param path      Relative path, e.g. "/api/EDOC/BookAppointment"
 * @param body      JSON body to POST
 * @param sessionId Used for audit event context (pass "anonymous" when unknown)
 * @returns         Axios response data OR SafeFailureResponse on exhausted retries
 */
export async function edocPost<T = unknown>(
  path: string,
  body: Record<string, unknown>,
  sessionId = "anonymous",
): Promise<T | SafeFailureResponse> {
  const url = `${EDOC_BASE}${path}`;
  let retryCount = 0;

  logEdoc(`${path}.request`, body);

  const result = await retryWithBackoff<T>(
    () =>
      axios
        .post<T>(url, body, { headers: edocHeaders(), timeout: EDOC_TIMEOUT_MS })
        .then((r) => r.data),
    {
      circuitKey:  "edoc",
      maxAttempts: 3,
      baseDelayMs: 500,

      onRetry(attempt, err) {
        retryCount = attempt;
        const e = err as { message?: string; code?: string };
        const isTimeout =
          e.code === "ECONNABORTED" || String(e.message ?? "").toLowerCase().includes("timeout");

        logEdoc(`${path}.retry`, { attempt, error: e.message });

        void logEvent(sessionId, isTimeout ? "edoc_timeout" : "edoc_retry", {
          path,
          attempt,
          error: String(e.message ?? ""),
        }).catch(() => {});
      },

      onCircuitOpen() {
        logEdoc(`${path}.circuit_open`, {});
        void logEvent(sessionId, "edoc_failure", {
          path,
          reason: "circuit_open",
        }).catch(() => {});
      },
    },
  );

  // Log final failure if all retries exhausted
  if (isSafeFailure(result) && retryCount > 0) {
    logEdoc(`${path}.failure`, { retries: retryCount });
    void logEvent(sessionId, "edoc_failure", {
      path,
      retries: retryCount,
      timedOut: result.timedOut,
    }).catch(() => {});
  }

  if (!isSafeFailure(result)) {
    logEdoc(`${path}.response`, result);
  }

  return result;
}

/**
 * GET wrapper for EDOC (slots, calendar, doctor info).
 * Same retry + circuit-breaker logic as edocPost.
 */
export async function edocGet<T = unknown>(
  path: string,
  params: Record<string, unknown>,
  sessionId = "anonymous",
): Promise<T | SafeFailureResponse> {
  const url = `${EDOC_BASE}${path}`;
  let retryCount = 0;

  logEdoc(`${path}.get.request`, params);

  const result = await retryWithBackoff<T>(
    () =>
      axios
        .get<T>(url, { params, headers: edocHeaders(), timeout: EDOC_TIMEOUT_MS })
        .then((r) => r.data),
    {
      circuitKey:  "edoc",
      maxAttempts: 3,
      baseDelayMs: 500,

      onRetry(attempt, err) {
        retryCount = attempt;
        const e = err as { message?: string; code?: string };
        const isTimeout =
          e.code === "ECONNABORTED" || String(e.message ?? "").toLowerCase().includes("timeout");

        void logEvent(sessionId, isTimeout ? "edoc_timeout" : "edoc_retry", {
          path,
          attempt,
          error: String(e.message ?? ""),
        }).catch(() => {});
      },

      onCircuitOpen() {
        void logEvent(sessionId, "edoc_failure", {
          path,
          reason: "circuit_open",
        }).catch(() => {});
      },
    },
  );

  if (isSafeFailure(result) && retryCount > 0) {
    void logEvent(sessionId, "edoc_failure", {
      path,
      retries: retryCount,
      timedOut: (result as SafeFailureResponse).timedOut,
    }).catch(() => {});
  }

  if (!isSafeFailure(result)) {
    logEdoc(`${path}.get.response`, result);
  }

  return result;
}
