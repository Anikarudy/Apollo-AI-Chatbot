function maskKeepPrefix(value: string, keep = 5): string {
  if (!value) return value;
  if (value.length <= keep) return "*".repeat(value.length);
  return `${value.slice(0, keep)}${"*".repeat(Math.max(5, value.length - keep))}`;
}

function maskString(value: string): string {
  return value
    .replace(/\b\+?\d{10,13}\b/g, (m) => maskKeepPrefix(m, 5))
    .replace(/\bUHID[\w-]*\b/gi, (m) => maskKeepPrefix(m, 5))
    .replace(/\b(gsk_[\w-]+|AIza[\w-]+)/g, "*****")
    .replace(/\b(AuthKey|Authorization)\b\s*[:=]\s*[^\s,;]+/gi, "$1: *****");
}

export function maskSensitiveData<T>(input: T, depth = 0): T {
  if (depth > 6) return input;
  if (input === null || input === undefined) return input;
  if (typeof input === "string") return maskString(input) as T;
  if (Array.isArray(input)) return input.map((item) => maskSensitiveData(item, depth + 1)) as T;
  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (v !== null && typeof v === "object") out[k] = maskSensitiveData(v, depth + 1);
      else if (typeof v === "string") out[k] = maskString(v);
      else out[k] = v;
    }
    return out as T;
  }
  return input;
}
