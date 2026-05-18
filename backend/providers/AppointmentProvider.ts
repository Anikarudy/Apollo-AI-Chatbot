/**
 * backend/providers/AppointmentProvider.ts
 *
 * Provider interface for appointment persistence.
 */

export interface AppointmentRecord {
  id: string;
  patientId: string;
  doctorName: string;
  specialty: string | null;
  hospital: string | null;
  appointmentDate: string;   // "DD-Mon-YYYY"
  slotTime: string;          // "HH:MM"
  status: string;            // "confirmed" | "cancelled" | "rescheduled"
  edocAppointmentId: string | null;
  createdAt: Date;
}

export interface CreateAppointmentInput {
  patientId: string;
  doctorName: string;
  specialty?: string;
  hospital?: string;
  appointmentDate: string;
  slotTime: string;
  edocAppointmentId?: string;
}

export interface AppointmentProvider {
  /** Persist a new appointment row. */
  createAppointment(input: CreateAppointmentInput): Promise<AppointmentRecord>;

  /** Retrieve all appointments for a patient, newest first. */
  getAppointmentsForPatient(patientId: string): Promise<AppointmentRecord[]>;

  /** Update the status of an appointment by internal UUID. */
  updateStatus(appointmentId: string, status: string): Promise<AppointmentRecord>;

  /** Update the status of an appointment by EDOC AppointmentID. Returns null if not found. */
  updateStatusByEdocId(edocAppointmentId: string, status: string): Promise<AppointmentRecord | null>;
}
