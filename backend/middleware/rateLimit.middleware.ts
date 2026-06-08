import rateLimit from "express-rate-limit";

function rateLimitResponse(retryAfterSecs: number) {
  return {
    error: "Too many requests",
    retryAfter: retryAfterSecs,
    message: `You're sending messages too quickly. Please wait ${retryAfterSecs} seconds and try again.`,
  };
}

/** General fallback: 120 req/min */
export const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitResponse(30),
});

/** /api/chat and /api/agent/decide: 50 req/min */
export const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitResponse(15),
});

/** Intent / language helpers: 80 req/min */
export const intentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 80,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitResponse(10),
});

/** EDOC booking mutations: 5 req/min — strict to prevent double-bookings */
export const bookingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitResponse(60),
});

/** EDOC calendar/slot reads: 180 req/min (bursty card-load friendly) */
export const calendarLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 180,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitResponse(5),
});
