/**
 * api/services/sqlite/sqlitePatientProvider.ts
 *
 * SQLite implementation of IPatientService.
 * Bridges the existing db.ts functions so the migration path is safe.
 */

import { IPatientService, Patient } from "../interfaces.js";
import {
  findPatient as dbFindPatient,
  registerPatient as dbRegisterPatient,
  Patient as DbPatient,
} from "../../db.js";

function mapPatient(p: DbPatient): Patient {
  return {
    id: String(p.id),
    uhid: p.uhid,
    name: p.name,
    mobile: p.mobile,
    dob: p.dob,
  };
}

export class SqlitePatientProvider implements IPatientService {
  async findPatient(opts: {
    mobile?: string;
    uhid?: string;
    name?: string;
    dob?: string;
  }): Promise<Patient | null> {
    const row = dbFindPatient(opts.mobile, opts.uhid, opts.name, opts.dob);
    return row ? mapPatient(row) : null;
  }

  async registerPatient(name: string, mobile: string, dob: string): Promise<Patient> {
    return mapPatient(dbRegisterPatient(name, mobile, dob));
  }
}
