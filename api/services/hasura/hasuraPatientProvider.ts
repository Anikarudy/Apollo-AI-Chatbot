/**
 * api/services/hasura/hasuraPatientProvider.ts
 *
 * Hasura (Postgres) implementation of IPatientService.
 */

import { IPatientService, Patient } from "../interfaces";
import { hasuraQuery } from "./hasuraClient";
import { randomBytes } from "crypto";

const FIND_PATIENT = `
  query FindPatient($mobile: String, $uhid: String, $name: String, $dob: String) {
    patients(where: {
      _or: [
        { mobile: { _eq: $mobile } }
        { uhid: { _eq: $uhid } }
        { name: { _ilike: $name }, dob: { _eq: $dob } }
      ]
    }, limit: 1) {
      id uhid name mobile dob
    }
  }
`;

const INSERT_PATIENT = `
  mutation InsertPatient($name: String!, $mobile: String!, $dob: String!, $uhid: String!) {
    insert_patients_one(
      object: { name: $name, mobile: $mobile, dob: $dob, uhid: $uhid }
      on_conflict: { constraint: patients_mobile_key, update_columns: [] }
    ) {
      id uhid name mobile dob
    }
  }
`;

function generateUhid(): string {
  return randomBytes(3).toString("hex").toUpperCase();
}

export class HasuraPatientProvider implements IPatientService {
  async findPatient(opts: {
    mobile?: string;
    uhid?: string;
    name?: string;
    dob?: string;
  }): Promise<Patient | null> {
    const data = await hasuraQuery<{ patients: Patient[] }>(FIND_PATIENT, {
      mobile: opts.mobile ?? null,
      uhid: opts.uhid ?? null,
      name: opts.name ?? null,
      dob: opts.dob ?? null,
    });
    return data.patients[0] ?? null;
  }

  async registerPatient(name: string, mobile: string, dob: string): Promise<Patient> {
    // Check for existing first
    const existing = await this.findPatient({ mobile });
    if (existing) return existing;

    const uhid = generateUhid();
    const data = await hasuraQuery<{ insert_patients_one: Patient }>(INSERT_PATIENT, {
      name: name.trim(),
      mobile: mobile.trim(),
      dob: dob.trim(),
      uhid,
    });
    return data.insert_patients_one;
  }
}
