/**
 * api/services/providers.ts
 *
 * Provider factory — reads DATA_PROVIDER env var and returns the correct
 * service implementations. Import only this file from api/index.ts.
 *
 *   DATA_PROVIDER=hasura   → Hasura Cloud / Postgres (production) ← ACTIVE
 *   DATA_PROVIDER=sqlite   → SQLite local (development) ← commented out
 */

import {
  IPatientService,
  IAppointmentService,
  IChatService,
  IAuditService,
} from "./interfaces";

// ── Hasura providers (active) ─────────────────────────────────────────────────
import { HasuraPatientProvider } from "./hasura/hasuraPatientProvider";
import { HasuraAppointmentProvider } from "./hasura/hasuraAppointmentProvider";
import { HasuraChatProvider } from "./hasura/hasuraChatProvider";
import { HasuraAuditProvider } from "./hasura/hasuraAuditProvider";

// ── SQLite providers (commented out — uncomment + set DATA_PROVIDER=sqlite to use) ──
// import { SqlitePatientProvider } from "./sqlite/sqlitePatientProvider";
// import { SqliteAppointmentProvider } from "./sqlite/sqliteAppointmentProvider";
// import { NullChatProvider } from "./null/nullChatProvider";
// import { NullAuditProvider } from "./null/nullAuditProvider";

// Singletons
let _patient: IPatientService | null = null;
let _appointment: IAppointmentService | null = null;
let _chat: IChatService | null = null;
let _audit: IAuditService | null = null;

export function getPatientService(): IPatientService {
  if (!_patient) _patient = new HasuraPatientProvider();
  return _patient;
}

export function getAppointmentService(): IAppointmentService {
  if (!_appointment) _appointment = new HasuraAppointmentProvider();
  return _appointment;
}

export function getChatService(): IChatService {
  if (!_chat) _chat = new HasuraChatProvider();
  return _chat;
}

export function getAuditService(): IAuditService {
  if (!_audit) _audit = new HasuraAuditProvider();
  return _audit;
}

export { IPatientService, IAppointmentService, IChatService, IAuditService };


