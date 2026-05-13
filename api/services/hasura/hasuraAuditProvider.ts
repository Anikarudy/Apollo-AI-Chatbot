/**
 * api/services/hasura/hasuraAuditProvider.ts
 *
 * Hasura (Postgres) implementation of IAuditService.
 * Logs to the audit_events table.
 */

import { IAuditService } from "../interfaces.js";
import { hasuraQuery } from "./hasuraClient.js";

const LOG_EVENT = `
  mutation LogAuditEvent($sessionId: String!, $eventType: String!, $payload: jsonb!) {
    insert_audit_events_one(object: {
      session_id: $sessionId
      event_type: $eventType
      payload: $payload
    }) { id }
  }
`;

export class HasuraAuditProvider implements IAuditService {
  async logEvent(opts: {
    sessionId: string;
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    await hasuraQuery(LOG_EVENT, {
      sessionId: opts.sessionId,
      eventType: opts.eventType,
      payload: opts.payload,
    });
  }
}
