export type BackendContentType =
  | "text"
  | "inline_text"
  | "file"
  | "pill"
  | "multi"
  | "doctor_card"
  | "lab_package_card"
  | "mobile_verification"
  | "tips"
  | "unknown";

export interface NormalizedContentMessage {
  id: string;
  contentType: BackendContentType;
  text?: string;
  files?: Array<{ url: string; name?: string; mimeType?: string }>;
  payload?: Record<string, unknown>;
}

function normalizeContentType(raw: unknown): BackendContentType {
  const value = String(raw ?? "").toLowerCase();
  switch (value) {
    case "text":
    case "inline_text":
    case "file":
    case "pill":
    case "multi":
    case "doctor_card":
    case "lab_package_card":
    case "mobile_verification":
    case "tips":
      return value;
    default:
      return "unknown";
  }
}

export function normalizeIncomingContent(input: {
  id?: string;
  ct?: unknown;
  data?: unknown;
}): NormalizedContentMessage {
  const contentType = normalizeContentType(input.ct);
  const data = (input.data ?? {}) as Record<string, unknown>;
  const text = typeof data.text === "string" ? data.text : undefined;

  const files = Array.isArray(data.files)
    ? (data.files as Array<Record<string, unknown>>)
        .map((file) => ({
          url: String(file.url ?? ""),
          name: typeof file.name === "string" ? file.name : undefined,
          mimeType: typeof file.mimeType === "string" ? file.mimeType : undefined,
        }))
        .filter((file) => file.url.length > 0)
    : undefined;

  return {
    id: String(input.id ?? crypto.randomUUID()),
    contentType,
    text,
    files,
    payload: data,
  };
}
