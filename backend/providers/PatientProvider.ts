/**
 * backend/providers/PatientProvider.ts
 *
 * Provider interface for patient persistence.
 * Business logic depends ONLY on this interface — never on Prisma or EDOC directly.
 * To switch data sources, create a new implementation of PatientProvider and wire it
 * in via CompositePatientProvider or patientService.
 */

export interface PatientRecord {
  id: string;
  phoneNumber: string;
  fullName: string;
  dob: string;        // "DD-Mon-YYYY"
  uhid: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePatientInput {
  phoneNumber: string;
  fullName: string;
  dob: string;   // "DD-Mon-YYYY"
  uhid?: string; // may be assigned later by EDOC
}

/** Metadata emitted alongside every provider result for audit/logging. */
export interface ProviderMetadata {
  /** Which provider actually served the result: "apollo_edoc" | "prisma_local" */
  provider: "apollo_edoc" | "prisma_local";
  /** True when the primary provider was skipped and a fallback was used. */
  fallbackUsed: boolean;
  /** Reason the primary provider was bypassed, if applicable. */
  fallbackReason?: string;
}

export interface PatientProvider {
  /** Human-readable name for logging (e.g. "apollo_edoc", "prisma_local"). */
  readonly providerName: "apollo_edoc" | "prisma_local";

  /** Find an existing patient by phone number. Returns null if not found. */
  getPatientByPhone(phoneNumber: string): Promise<PatientRecord | null>;

  /** Create a new patient record. Throws if phoneNumber already exists. */
  createPatient(input: CreatePatientInput): Promise<PatientRecord>;

  /** Update UHID on an existing patient (called after EDOC assigns one). */
  setUhid(patientId: string, uhid: string): Promise<PatientRecord>;
}
