export interface TransportRequestOptions {
  path: string;
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
  retries?: number;
  retryDelayMs?: number;
  sessionId?: string;
  sessionToken?: string;
}

export interface ApiTransportConfig {
  baseUrl?: string;
  agentId?: string;
  getSessionToken?: () => string | null;
  refreshSessionToken?: () => Promise<string | null>;
}

function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createApiTransport(config?: ApiTransportConfig) {
  const baseUrl = String(config?.baseUrl ?? "");
  const agentId = String(config?.agentId ?? "apollo-assist-web");

  async function requestJson<T>(options: TransportRequestOptions): Promise<T> {
    const retries = options.retries ?? 2;
    const retryDelayMs = options.retryDelayMs ?? 400;
    let refreshedToken = false;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const sessionToken = options.sessionToken ?? config?.getSessionToken?.() ?? undefined;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-agent-id": agentId,
        ...(options.sessionId ? { "X-Session-Id": options.sessionId } : {}),
        ...(sessionToken ? { "x-sess-token": sessionToken } : {}),
        ...(options.headers ?? {}),
      };

      try {
        const response = await fetch(`${baseUrl}${options.path}`, {
          method: options.method ?? "GET",
          headers,
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        });

        if (response.status === 401 && !refreshedToken && config?.refreshSessionToken) {
          refreshedToken = true;
          const newToken = await config.refreshSessionToken();
          if (newToken) {
            continue;
          }
        }

        if (!response.ok) {
          if (attempt < retries && isRetriableStatus(response.status)) {
            await sleep(retryDelayMs * (attempt + 1));
            continue;
          }
          let errorBody: unknown = null;
          try {
            errorBody = await response.json();
          } catch {
            errorBody = null;
          }
          throw new Error(`HTTP ${response.status}: ${JSON.stringify(errorBody)}`);
        }

        return (await response.json()) as T;
      } catch (error) {
        if (attempt < retries) {
          await sleep(retryDelayMs * (attempt + 1));
          continue;
        }
        throw error;
      }
    }

    throw new Error("Request failed after retries");
  }

  async function requestRaw(options: Omit<TransportRequestOptions, "body"> & { body?: BodyInit | null }): Promise<Response> {
    const sessionToken = options.sessionToken ?? config?.getSessionToken?.() ?? undefined;
    const headers: Record<string, string> = {
      "x-agent-id": agentId,
      ...(options.sessionId ? { "X-Session-Id": options.sessionId } : {}),
      ...(sessionToken ? { "x-sess-token": sessionToken } : {}),
      ...(options.headers ?? {}),
    };
    return fetch(`${baseUrl}${options.path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body ?? null,
    });
  }

  return {
    requestJson,
    requestRaw,
  };
}

export function buildSessionSocketUrl(baseWsUrl: string, sessionId: string): string {
  const safeBase = baseWsUrl.replace(/\/+$/, "");
  const safeSessionId = encodeURIComponent(sessionId);
  return `${safeBase}/ws/med-assist/session/${safeSessionId}/`;
}
