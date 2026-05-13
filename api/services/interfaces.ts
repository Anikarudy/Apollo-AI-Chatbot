/**
 * api/services/interfaces.ts
 *
 * Core service interfaces for the provider abstraction layer.
 * All data access goes through these interfaces — the bot never calls
 * SQLite or Hasura directly.
 *
 * Switch providers at runtime via the DATA_PROVIDER env var:
 *   DATA_PROVIDER=sqlite   → local SQLite (development / offline)
 *   DATA_PROVIDER=hasura   → Hasura Cloud / Postgres (production)
 */

// ── Shared types ──────────────────────────────────────────────────────────────

export interface Patient {
  id: string;          // UUID in Hasura, stringified integer in SQLite bridge
  uhid: string;
  name: string;
  mobile: string;
  dob: string;
}

export interface Appointment {
  id: string;
  appointmentId: string | null;
  patientId: string;
  doctorName: string | null;
  date: string | null;
  slot: string | null;
  status: string;
}

export interface ChatSession {
  id: string;
  sessionId: string;
  patientId: string | null;
  language: string;
  currentState: string;
  status: "active" | "ended" | "abandoned";
  startedAt: string;
  endedAt: string | null;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "bot";
  message: string;
  machineState: string | null;
  agentAction: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  sessionId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

// ── Service interfaces ────────────────────────────────────────────────────────

export interface IPatientService {
  findPatient(opts: {
    mobile?: string;
    uhid?: string;
    name?: string;
    dob?: string;
  }): Promise<Patient | null>;

  registerPatient(name: string, mobile: string, dob: string): Promise<Patient>;
}

export interface IAppointmentService {
  saveAppointment(opts: {
    patientId: string;
    appointmentId: string | null;
    doctorName: string | null;
    date: string | null;
    slot: string | null;
    status?: string;
  }): Promise<Appointment>;

  getLatestAppointment(opts: {
    mobile?: string;
    uhid?: string;
    name?: string;
    dob?: string;
  }): Promise<(Appointment & { name: string; mobile: string; dob: string; uhid: string }) | null>;
}

export interface IChatService {
  /** Create or fetch an existing session by sessionId. */
  upsertSession(sessionId: string, language?: string): Promise<ChatSession>;

  /** Update the current machine state on a session. */
  updateSessionState(sessionId: string, currentState: string): Promise<void>;

  /** Log a single chat message. Fire-and-forget callers should not await. */
  logMessage(opts: {
    sessionId: string;
    role: "user" | "bot";
    message: string;
    machineState?: string;
    agentAction?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;

  /** Mark the session ended. */
  endSession(sessionId: string): Promise<void>;
}

export interface IAuditService {
  /** Record an auditable event. Fire-and-forget callers should not await. */
  logEvent(opts: {
    sessionId: string;
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}
