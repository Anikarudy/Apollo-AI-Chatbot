/**
 * backend/infra/retryWithBackoff.ts
 *
 * Generic retry-with-exponential-backoff helper for external API calls.
 *
 * Behaviour:
 *  - Up to maxAttempts total tries (default 3)
 *  - Exponential delay: baseDelayMs * 2^attempt with ±20% jitter
 *  - Only retries on transient errors (network failures, 5xx, timeouts)
 *  - 4xx errors are NOT retried (client error — retrying won't help)
 *
 * Circuit-breaker light:
 *  - Tracks consecutive failures per "circuit key" (e.g. "edoc")
 *  - If failures exceed OPEN_THRESHOLD within WINDOW_MS, subsequent calls
 *    short-circuit immediately with a safe failure response.
 *  - Circuit resets after RESET_MS of no further calls.
 *
 * Usage:
 *   const result = await retryWithBackoff(
 *     () => axios.post(...),
 *     { circuitKey: "edoc", onRetry: (attempt, err) => logEvent(...) }
 *   );
 */

import type { AxiosError } from "axios";

// ── Circuit-breaker state (module-level singleton) ────────────────────────────
const OPEN_THRESHOLD = 5;   // consecutive failures before opening
const RESET_MS       = 30_000; // 30 s cooldown before allowing calls again
const WINDOW_MS      = 10_000; // window for counting consecutive failures

interface CircuitState {
  failures:    number;
  lastFailure: number; // epoch ms
  openSince:   number; // epoch ms, 0 = closed
}

const circuits = new Map<string, CircuitState>();

function getCircuit(key: string): CircuitState {
  if (!circuits.has(key)) {
    circuits.set(key, { failures: 0, lastFailure: 0, openSince: 0 });
  }
  return circuits.get(key)!;
}

function recordCircuitSuccess(key: string): void {
  const c = getCircuit(key);
  c.failures  = 0;
  c.openSince = 0;
}

function recordCircuitFailure(key: string): void {
  const now = Date.now();
  const c = getCircuit(key);

  // Reset counter if last failure was outside the window
  if (now - c.lastFailure > WINDOW_MS) c.failures = 0;

  c.failures++;
  c.lastFailure = now;

  if (c.failures >= OPEN_THRESHOLD && c.openSince === 0) {
    c.openSince = now;
  }
}

function isCircuitOpen(key: string): boolean {
  const c = getCircuit(key);
  if (c.openSince === 0) return false;
  // Auto-reset after RESET_MS
  if (Date.now() - c.openSince > RESET_MS) {
    c.openSince = 0;
    c.failures  = 0;
    return false;
  }
  return true;
}

// ── Transience check ──────────────────────────────────────────────────────────
function isTransient(err: unknown): boolean {
  const e = err as AxiosError;
  if (!e) return false;

  // Network-level: no response received (ECONNREFUSED, ETIMEDOUT, etc.)
  if (e.code && !e.response) return true;

  // axios timeout
  if (e.code === "ECONNABORTED") return true;

  // HTTP 5xx
  if (e.response?.status && e.response.status >= 500) return true;

  // Not transient (4xx, parse error, etc.)
  return false;
}

// ── Public safe-failure response ──────────────────────────────────────────────
export interface SafeFailureResponse {
  success:  false;
  message:  string;
  timedOut: boolean;
}

export function safeFailure(timedOut = false): SafeFailureResponse {
  return {
    success: false,
    message: "Live booking temporarily unavailable. Please try again in a few moments or call Apollo at 1066.",
    timedOut,
  };
}

// ── Options ───────────────────────────────────────────────────────────────────
export interface RetryOptions {
  maxAttempts?:  number;  // default 3
  baseDelayMs?:  number;  // default 500
  circuitKey?:   string;  // e.g. "edoc" — enables circuit-breaker tracking
  /** Called before each retry (not before the first attempt). */
  onRetry?: (attempt: number, err: unknown) => void;
  /** Called when circuit is open and the call is short-circuited. */
  onCircuitOpen?: () => void;
}

// ── Core ──────────────────────────────────────────────────────────────────────
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T | SafeFailureResponse> {
  const {
    maxAttempts  = 3,
    baseDelayMs  = 500,
    circuitKey,
    onRetry,
    onCircuitOpen,
  } = options;

  // ── Circuit-breaker check ───────────────────────────────────────────────────
  if (circuitKey && isCircuitOpen(circuitKey)) {
    onCircuitOpen?.();
    return safeFailure(false);
  }

  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await fn();
      if (circuitKey) recordCircuitSuccess(circuitKey);
      return result;
    } catch (err) {
      lastErr = err;

      // Non-transient failures should not be retried
      if (!isTransient(err)) {
        if (circuitKey) recordCircuitFailure(circuitKey);
        throw err;
      }

      if (circuitKey) recordCircuitFailure(circuitKey);

      const isLast = attempt === maxAttempts - 1;
      if (isLast) break;

      // Exponential backoff with ±20% jitter
      const jitter   = 0.8 + Math.random() * 0.4;
      const delayMs  = Math.round(baseDelayMs * Math.pow(2, attempt) * jitter);

      onRetry?.(attempt + 1, err);

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // All retries exhausted — return graceful degradation response
  const isTimeout = (() => {
    const e = lastErr as AxiosError;
    return e?.code === "ECONNABORTED" || String(e?.message ?? "").toLowerCase().includes("timeout");
  })();

  return safeFailure(isTimeout);
}
