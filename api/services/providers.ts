/**
 * api/services/providers.ts
 *
 * Provider factory — reads DATA_PROVIDER env var and returns the correct
 * service implementations. Import only this file from api/index.ts.
 *
 *   DATA_PROVIDER=sqlite   → SQLite (default, development)
 *   DATA_PROVIDER=hasura   → Hasura Cloud / Postgres (production)
 *
 * The returned objects are singletons for the lifetime of the process.
 */

import {
  IPatientService,
  IAppointmentService,
  IChatService,
  IAuditService,
} from "./interfaces.js";

// Lazy imports keep startup fast when a provider isn't needed
let _patient: IPatientService | null = null;
let _appointment: IAppointmentService | null = null;
let _chat: IChatService | null = null;
let _audit: IAuditService | null = null;

const provider = (process.env.DATA_PROVIDER ?? "sqlite").toLowerCase();

export function getPatientService(): IPatientService {
  if (!_patient) {
    if (provider === "hasura") {
      const { HasuraPatientProvider } = require("./hasura/hasuraPatientProvider.js");
      _patient = new HasuraPatientProvider();
    } else {
      const { SqlitePatientProvider } = require("./sqlite/sqlitePatientProvider.js");
      _patient = new SqlitePatientProvider();
    }
  }
  return _patient!;
}

export function getAppointmentService(): IAppointmentService {
  if (!_appointment) {
    if (provider === "hasura") {
      const { HasuraAppointmentProvider } = require("./hasura/hasuraAppointmentProvider.js");
      _appointment = new HasuraAppointmentProvider();
    } else {
      const { SqliteAppointmentProvider } = require("./sqlite/sqliteAppointmentProvider.js");
      _appointment = new SqliteAppointmentProvider();
    }
  }
  return _appointment!;
}

export function getChatService(): IChatService {
  if (!_chat) {
    if (provider === "hasura") {
      const { HasuraChatProvider } = require("./hasura/hasuraChatProvider.js");
      _chat = new HasuraChatProvider();
    } else {
      const { NullChatProvider } = require("./null/nullChatProvider.js");
      _chat = new NullChatProvider();
    }
  }
  return _chat!;
}

export function getAuditService(): IAuditService {
  if (!_audit) {
    if (provider === "hasura") {
      const { HasuraAuditProvider } = require("./hasura/hasuraAuditProvider.js");
      _audit = new HasuraAuditProvider();
    } else {
      const { NullAuditProvider } = require("./null/nullAuditProvider.js");
      _audit = new NullAuditProvider();
    }
  }
  return _audit!;
}

export { IPatientService, IAppointmentService, IChatService, IAuditService };
