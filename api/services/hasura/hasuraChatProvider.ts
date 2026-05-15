/**
 * api/services/hasura/hasuraChatProvider.ts
 *
 * Hasura (Postgres) implementation of IChatService.
 * Handles chat_sessions and chat_messages tables.
 */

import { IChatService, ChatSession } from "../interfaces";
import { hasuraQuery } from "./hasuraClient";

const UPSERT_SESSION = `
  mutation UpsertSession($sessionId: String!, $language: String) {
    insert_chat_sessions_one(
      object: { session_id: $sessionId, language: $language, status: "active", current_state: "IDLE" }
      on_conflict: { constraint: chat_sessions_session_id_key, update_columns: [language] }
    ) {
      id session_id patient_id language current_state status started_at ended_at
    }
  }
`;

const UPDATE_SESSION_STATE = `
  mutation UpdateSessionState($sessionId: String!, $currentState: String!) {
    update_chat_sessions(
      where: { session_id: { _eq: $sessionId } }
      _set: { current_state: $currentState }
    ) { affected_rows }
  }
`;

const LOG_MESSAGE = `
  mutation LogMessage(
    $sessionUuid: uuid!
    $role: String!
    $message: String!
    $machineState: String
    $agentAction: String
    $metadata: jsonb
  ) {
    insert_chat_messages_one(object: {
      session_id: $sessionUuid
      role: $role
      message: $message
      machine_state: $machineState
      agent_action: $agentAction
      metadata: $metadata
    }) { id }
  }
`;

const GET_SESSION_UUID = `
  query GetSessionUuid($sessionId: String!) {
    chat_sessions(where: { session_id: { _eq: $sessionId } }, limit: 1) { id }
  }
`;

const END_SESSION = `
  mutation EndSession($sessionId: String!) {
    update_chat_sessions(
      where: { session_id: { _eq: $sessionId } }
      _set: { status: "ended", ended_at: "now()" }
    ) { affected_rows }
  }
`;

type HasuraSessionRow = {
  id: string;
  session_id: string;
  patient_id: string | null;
  language: string;
  current_state: string;
  status: "active" | "ended" | "abandoned";
  started_at: string;
  ended_at: string | null;
};

export class HasuraChatProvider implements IChatService {
  /** Cache: session_id (TEXT) → UUID id — avoids an extra query on every message */
  private readonly uuidCache = new Map<string, string>();

  private async resolveUuid(sessionId: string): Promise<string | null> {
    if (this.uuidCache.has(sessionId)) return this.uuidCache.get(sessionId)!;
    const data = await hasuraQuery<{ chat_sessions: { id: string }[] }>(
      GET_SESSION_UUID, { sessionId }
    );
    const uuid = data.chat_sessions[0]?.id ?? null;
    if (uuid) this.uuidCache.set(sessionId, uuid);
    return uuid;
  }

  async upsertSession(sessionId: string, language = "en"): Promise<ChatSession> {
    const data = await hasuraQuery<{ insert_chat_sessions_one: HasuraSessionRow }>(
      UPSERT_SESSION,
      { sessionId, language }
    );
    const r = data.insert_chat_sessions_one;
    // Cache UUID immediately so logMessage never needs an extra round-trip
    this.uuidCache.set(r.session_id, r.id);
    return {
      id: r.id,
      sessionId: r.session_id,
      patientId: r.patient_id,
      language: r.language,
      currentState: r.current_state,
      status: r.status,
      startedAt: r.started_at,
      endedAt: r.ended_at,
    };
  }

  async updateSessionState(sessionId: string, currentState: string): Promise<void> {
    await hasuraQuery(UPDATE_SESSION_STATE, { sessionId, currentState });
  }

  async logMessage(opts: {
    sessionId: string;
    role: "user" | "bot";
    message: string;
    machineState?: string;
    agentAction?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    // Ensure session exists and get its UUID
    let sessionUuid = await this.resolveUuid(opts.sessionId);
    if (!sessionUuid) {
      await this.upsertSession(opts.sessionId);
      sessionUuid = await this.resolveUuid(opts.sessionId);
    }
    if (!sessionUuid) return; // still not found — skip silently
    await hasuraQuery(LOG_MESSAGE, {
      sessionUuid,
      role: opts.role,
      message: opts.message,
      machineState: opts.machineState ?? null,
      agentAction: opts.agentAction ?? null,
      metadata: opts.metadata ?? {},
    });
  }

  async endSession(sessionId: string): Promise<void> {
    await hasuraQuery(END_SESSION, { sessionId });
  }
}
