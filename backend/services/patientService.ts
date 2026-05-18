/**
 * backend/services/patientService.ts
 *
 * Domain service for patient data.
 * Depends only on PatientProvider — never on Prisma, EDOC, or any external API directly.
 *
 * Uses CompositePatientProvider:
 *   Apollo EDOC (primary) → Prisma/Postgres (fallback)
 */

import { compositePatientProvider } from "../providers/compositePatientProvider";
import type { PatientRecord, CreatePatientInput } from "../providers/PatientProvider";

const provider = compositePatientProvider;

/**
 * Look up a patient by phone number.
 * Returns null if the patient has no local record yet.
 */
export async function getPatientByPhone(phoneNumber: string): Promise<PatientRecord | null> {
  return provider.getPatientByPhone(phoneNumber);
}

/**
 * Create a new patient record.
 * Caller is responsible for ensuring no duplicate exists first.
 */
export async function createPatient(input: CreatePatientInput): Promise<PatientRecord> {
  return provider.createPatient(input);
}

/**
 * Look up a patient or create one if not found.
 * `input.phoneNumber` is the key.
 */
export async function getOrCreatePatient(input: CreatePatientInput): Promise<PatientRecord> {
  const existing = await provider.getPatientByPhone(input.phoneNumber);
  if (existing) return existing;
  return provider.createPatient(input);
}

/**
 * Update the UHID on an existing patient record.
 * Called after EDOC assigns (or confirms) a UHID via GenerateUHIDOnline.
 */
export async function setPatientUhid(patientId: string, uhid: string): Promise<PatientRecord> {
  return provider.setUhid(patientId, uhid);
}
