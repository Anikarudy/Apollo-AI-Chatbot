/**
 * backend/services/appointmentService.ts
 *
 * Domain service for appointment persistence.
 * Depends only on AppointmentProvider — never on Prisma or the DB directly.
 */

import { prismaAppointmentProvider } from "../providers/prismaAppointmentProvider";
import type { AppointmentRecord, CreateAppointmentInput } from "../providers/AppointmentProvider";

const provider = prismaAppointmentProvider;

/** Persist a confirmed appointment after EDOC BookAppointment succeeds. */
export async function createAppointment(input: CreateAppointmentInput): Promise<AppointmentRecord> {
  return provider.createAppointment(input);
}

/** Retrieve all appointments for a patient, newest first. */
export async function getAppointmentsForPatient(patientId: string): Promise<AppointmentRecord[]> {
  return provider.getAppointmentsForPatient(patientId);
}

/** Mark an appointment as cancelled or rescheduled (by internal UUID). */
export async function updateAppointmentStatus(appointmentId: string, status: string): Promise<AppointmentRecord> {
  return provider.updateStatus(appointmentId, status);
}

/**
 * Mark an appointment as cancelled or rescheduled by EDOC AppointmentID.
 * Returns null silently if no matching local row is found (e.g. appointment pre-dates local DB).
 */
export async function updateAppointmentStatusByEdocId(edocAppointmentId: string, status: string): Promise<AppointmentRecord | null> {
  return provider.updateStatusByEdocId(edocAppointmentId, status);
}
