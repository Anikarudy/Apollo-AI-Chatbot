/**
 * api/db.ts
 *
 * SQLite database layer for patient memory.
 * - patients: identity store (name, mobile, dob, uhid)
 * - appointments: booking records linked to patients
 *
 * LLM NEVER reads or writes directly — all access goes through the functions below.
 */

import Database from "better-sqlite3";
import path from "path";
import crypto from "crypto";

const DB_PATH = path.join(__dirname, "../database.sqlite");
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ── Schema ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS patients (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    name    TEXT    NOT NULL,
    mobile  TEXT    NOT NULL,
    dob     TEXT    NOT NULL,
    uhid    TEXT    NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    appointmentId TEXT,
    patientId     INTEGER NOT NULL,
    doctorName    TEXT,
    date          TEXT,
    slot          TEXT,
    status        TEXT    DEFAULT 'confirmed',
    FOREIGN KEY(patientId) REFERENCES patients(id)
  );
`);

console.log(`[DB] SQLite ready at ${DB_PATH}`);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Patient {
  id: number;
  name: string;
  mobile: string;
  dob: string;
  uhid: string;
}

export interface Appointment {
  id: number;
  appointmentId: string | null;
  patientId: number;
  doctorName: string | null;
  date: string | null;
  slot: string | null;
  status: string;
}

export interface PatientWithAppointment extends Appointment {
  name: string;
  mobile: string;
  dob: string;
  uhid: string;
}

// ── Patient helpers ───────────────────────────────────────────────────────────

/** Look up a patient by mobile, UHID, or name+DOB. Returns null if not found. */
export function findPatient(
  mobile?: string,
  uhid?: string,
  name?: string,
  dob?: string
): Patient | null {
  console.log(`[DB] findPatient mobile=${mobile ?? "-"} uhid=${uhid ?? "-"} name=${name ?? "-"} dob=${dob ?? "-"}`);

  if (mobile) {
    const row = db.prepare("SELECT * FROM patients WHERE mobile = ?").get(mobile) as Patient | undefined;
    if (row) {
      console.log(`[DB] findPatient matched by mobile: ${row.uhid}`);
      return row;
    }
  }
  if (uhid) {
    const row = db.prepare("SELECT * FROM patients WHERE uhid = ?").get(uhid) as Patient | undefined;
    if (row) {
      console.log(`[DB] findPatient matched by uhid: ${row.uhid}`);
      return row;
    }
  }
  if (name && dob) {
    const row = db
      .prepare("SELECT * FROM patients WHERE LOWER(name) = LOWER(?) AND dob = ?")
      .get(name.trim(), dob.trim()) as Patient | undefined;
    if (row) {
      console.log(`[DB] findPatient matched by name+dob: ${row.uhid}`);
      return row;
    }
  }
  console.log("[DB] findPatient — no match");
  return null;
}

/** Generate a unique UHID (6-digit hex prefix). */
function generateUhid(): string {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

/** Register a new patient. Returns the created Patient. */
export function registerPatient(name: string, mobile: string, dob: string): Patient {
  // Deduplicate: if mobile already registered, return existing
  const existing = findPatient(mobile);
  if (existing) {
    console.log(`[DB] registerPatient — mobile already exists, returning existing uhid: ${existing.uhid}`);
    return existing;
  }

  let uhid: string;
  // Ensure UHID uniqueness
  do {
    uhid = generateUhid();
  } while (db.prepare("SELECT id FROM patients WHERE uhid = ?").get(uhid));

  const stmt = db.prepare("INSERT INTO patients (name, mobile, dob, uhid) VALUES (?, ?, ?, ?)");
  const info = stmt.run(name.trim(), mobile.trim(), dob.trim(), uhid);

  console.log(`[DB] registerPatient — inserted id=${info.lastInsertRowid} uhid=${uhid}`);
  return db.prepare("SELECT * FROM patients WHERE id = ?").get(info.lastInsertRowid) as Patient;
}

// ── Appointment helpers ───────────────────────────────────────────────────────

/** Save a new appointment for a patient (by patientId). */
export function saveAppointment(
  patientId: number,
  appointmentId: string | null,
  doctorName: string | null,
  date: string | null,
  slot: string | null,
  status = "confirmed"
): Appointment {
  const stmt = db.prepare(
    "INSERT INTO appointments (appointmentId, patientId, doctorName, date, slot, status) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const info = stmt.run(appointmentId ?? null, patientId, doctorName ?? null, date ?? null, slot ?? null, status);
  console.log(`[DB] saveAppointment — id=${info.lastInsertRowid} patientId=${patientId} doctor=${doctorName ?? "-"}`);
  return db.prepare("SELECT * FROM appointments WHERE id = ?").get(info.lastInsertRowid) as Appointment;
}

/**
 * Retrieve the most recent appointment for a patient identified by mobile, UHID, or name+DOB.
 * Returns null if no record found.
 * NEVER returns all records — only the single most recent match.
 */
export function getLatestPatientAppointment(
  mobile?: string,
  uhid?: string,
  name?: string,
  dob?: string
): PatientWithAppointment | null {
  console.log(`[DB] getLatestPatientAppointment mobile=${mobile ?? "-"} uhid=${uhid ?? "-"} name=${name ?? "-"} dob=${dob ?? "-"}`);

  const QUERY = `
    SELECT a.*, p.name, p.mobile, p.dob, p.uhid
    FROM appointments a
    JOIN patients p ON a.patientId = p.id
    WHERE p.mobile = @mobile
       OR p.uhid   = @uhid
       OR (LOWER(p.name) = LOWER(@name) AND p.dob = @dob)
    ORDER BY a.id DESC
    LIMIT 1
  `;

  const row = db.prepare(QUERY).get({
    mobile: mobile ?? "",
    uhid: uhid ?? "",
    name: name ?? "__NO_NAME__",
    dob: dob ?? "__NO_DOB__",
  }) as PatientWithAppointment | undefined;

  if (row) {
    console.log(`[DB] getLatestPatientAppointment — found appointment id=${row.id} patient=${row.name}`);
  } else {
    console.log("[DB] getLatestPatientAppointment — no record found");
  }

  return row ?? null;
}
