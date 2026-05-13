/**
 * api/services/null/nullChatProvider.ts
 *
 * No-op IChatService used in SQLite/offline mode.
 * Logs nothing to the database — all operations are silent no-ops.
 * Used when DATA_PROVIDER=sqlite and no Hasura is configured.
 */

import { IChatService, ChatSession } from "../interfaces.js";

export class NullChatProvider implements IChatService {
  async upsertSession(sessionId: string, language = "en"): Promise<ChatSession> {
    return {
      id: sessionId,
      sessionId,
      patientId: null,
      language,
      currentState: "IDLE",
      status: "active",
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
  }

  async updateSessionState(_sessionId: string, _currentState: string): Promise<void> {
    // no-op
  }

  async logMessage(_opts: {
    sessionId: string;
    role: "user" | "bot";
    message: string;
    machineState?: string;
    agentAction?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    // no-op
  }

  async endSession(_sessionId: string): Promise<void> {
    // no-op
  }
}
