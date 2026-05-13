/**
 * api/services/sqlite/sqliteAppointmentProvider.ts
 *
 * SQLite implementation of IAppointmentService.
 * Bridges the existing db.ts functions so the migration path is safe.
 */

import { IAppointmentService, Appointment } from "../interfaces.js";
import {
  saveAppointment as dbSaveAppointment,
  getLatestPatientAppointment,
  Appointment as DbAppointment,
  PatientWithAppointment,
} from "../../db.js";

function mapAppointment(a: DbAppointment): Appointment {
  return {
    id: String(a.id),
    appointmentId: a.appointmentId,
    patientId: String(a.patientId),
    doctorName: a.doctorName,
    date: a.date,
    slot: a.slot,
    status: a.status,
  };
}

export class SqliteAppointmentProvider implements IAppointmentService {
  async saveAppointment(opts: {
    patientId: string;
    appointmentId: string | null;
    doctorName: string | null;
    date: string | null;
    slot: string | null;
    status?: string;
  }): Promise<Appointment> {
    const row = dbSaveAppointment(
      Number(opts.patientId),
      opts.appointmentId,
      opts.doctorName,
      opts.date,
      opts.slot,
      opts.status ?? "confirmed"
    );
    return mapAppointment(row);
  }

  async getLatestAppointment(opts: {
    mobile?: string;
    uhid?: string;
    name?: string;
    dob?: string;
  }): Promise<(Appointment & { name: string; mobile: string; dob: string; uhid: string }) | null> {
    const row: PatientWithAppointment | null = getLatestPatientAppointment(
      opts.mobile,
      opts.uhid,
      opts.name,
      opts.dob
    );
    if (!row) return null;

    return {
      ...mapAppointment(row),
      name: row.name,
      mobile: row.mobile,
      dob: row.dob,
      uhid: row.uhid,
    };
  }
}
