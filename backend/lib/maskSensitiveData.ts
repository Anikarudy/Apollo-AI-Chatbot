const SENSITIVE_KEY_RE = /(phone|mobile|dob|dateofbirth|uhid|appointmentid|auth|authorization|token|password|otp|sessionid|bookingrequestid)/i;

function maskKeepPrefix(value: string, keep = 5): string {
  if (!value) return value;
  if (value.length <= keep) return "*".repeat(value.length);
  return `${value.slice(0, keep)}${"*".repeat(Math.max(5, value.length - keep))}`;
}

function maskPhoneString(value: string): string {
  return value.replace(/\b\+?\d{10,13}\b/g, (m) => maskKeepPrefix(m, 5));
}

function maskUhidString(value: string): string {
  return value.replace(/\bUHID[\w-]*\b/gi, (m) => maskKeepPrefix(m, 5));
}

function maskAppointmentIdString(value: string): string {
  return value.replace(/\b(AppointmentID|apptId)\s*[:=]\s*([\w-]+)\b/gi, (_m, k: string, v: string) => {
    return `${k}: ${maskKeepPrefix(v, 5)}`;
  });
}

function maskAuthString(value: string): string {
  return value
    .replace(/\b(AuthKey|Authorization)\b\s*[:=]\s*[^\s,;]+/gi, (m) => {
      const key = m.split(/[:=]/)[0] ?? "Auth";
      return `${key}: *****`;
    })
    .replace(/\b(gsk_[\w-]+|AIza[\w-]+)/g, "*****");
}

function maskString(value: string): string {
  let masked = value;
  masked = maskPhoneString(masked);
  masked = maskUhidString(masked);
  masked = maskAppointmentIdString(masked);
  masked = maskAuthString(masked);
  return masked;
}

function maskPrimitiveByKey(key: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (!SENSITIVE_KEY_RE.test(key)) return maskString(value);
  return maskKeepPrefix(value, 5);
}

export function maskSensitiveData<T>(input: T, depth = 0): T {
  if (depth > 6) return input;
  if (input === null || input === undefined) return input;

  if (typeof input === "string") {
    return maskString(input) as T;
  }

  if (Array.isArray(input)) {
    return input.map((item) => maskSensitiveData(item, depth + 1)) as T;
  }

  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (v !== null && typeof v === "object") {
        out[k] = maskSensitiveData(v, depth + 1);
      } else {
        out[k] = maskPrimitiveByKey(k, v);
      }
    }
    return out as T;
  }

  return input;
}

export function maskSessionId(sessionId: string): string {
  return maskKeepPrefix(sessionId, 8);
}
