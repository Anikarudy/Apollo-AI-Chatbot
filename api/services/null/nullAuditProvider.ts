/**
 * api/services/null/nullAuditProvider.ts
 *
 * No-op IAuditService used in SQLite/offline mode.
 * Records nothing — all audit events are silently discarded.
 */

import { IAuditService } from "../interfaces.js";

export class NullAuditProvider implements IAuditService {
  async logEvent(_opts: {
    sessionId: string;
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    // no-op
  }
}
