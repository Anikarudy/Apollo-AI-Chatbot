/**
 * api/services/hasura/hasuraAppointmentProvider.ts
 *
 * Hasura (Postgres) implementation of IAppointmentService.
 */

import { IAppointmentService, Appointment } from "../interfaces";
import { hasuraQuery } from "./hasuraClient";

const INSERT_APPOINTMENT = `
  mutation InsertAppointment(
    $patientId: uuid!
    $appointmentId: String
    $doctorName: String
    $appointmentDate: date
    $slotTime: String
    $status: String
  ) {
    insert_appointments_one(object: {
      patient_id: $patientId
      appointment_id: $appointmentId
      doctor_name: $doctorName
      appointment_date: $appointmentDate
      slot_time: $slotTime
      status: $status
    }) {
      id appointment_id patient_id doctor_name appointment_date slot_time status
    }
  }
`;

const GET_LATEST_APPOINTMENT = `
  query GetLatestAppointment($mobile: String, $uhid: String, $name: String, $dob: String) {
    appointments(
      where: {
        patient: {
          _or: [
            { mobile: { _eq: $mobile } }
            { uhid: { _eq: $uhid } }
            { name: { _ilike: $name }, dob: { _eq: $dob } }
          ]
        }
      }
      order_by: { appointment_date: desc }
      limit: 1
    ) {
      id appointment_id patient_id doctor_name appointment_date slot_time status
      patient { name mobile dob uhid }
    }
  }
`;

type HasuraApptRow = {
  id: string;
  appointment_id: string | null;
  patient_id: string;
  doctor_name: string | null;
  appointment_date: string | null;
  slot_time: string | null;
  status: string;
  patient?: { name: string; mobile: string; dob: string; uhid: string };
};

function mapRow(row: HasuraApptRow): Appointment {
  return {
    id: row.id,
    appointmentId: row.appointment_id,
    patientId: row.patient_id,
    doctorName: row.doctor_name,
    date: row.appointment_date,
    slot: row.slot_time,
    status: row.status,
  };
}

export class HasuraAppointmentProvider implements IAppointmentService {
  async saveAppointment(opts: {
    patientId: string;
    appointmentId: string | null;
    doctorName: string | null;
    date: string | null;
    slot: string | null;
    status?: string;
  }): Promise<Appointment> {
    const data = await hasuraQuery<{ insert_appointments_one: HasuraApptRow }>(
      INSERT_APPOINTMENT,
      {
        patientId: opts.patientId,
        appointmentId: opts.appointmentId ?? null,
        doctorName: opts.doctorName ?? null,
        appointmentDate: opts.date ?? null,
        slotTime: opts.slot ?? null,
        status: opts.status ?? "confirmed",
      }
    );
    return mapRow(data.insert_appointments_one);
  }

  async getLatestAppointment(opts: {
    mobile?: string;
    uhid?: string;
    name?: string;
    dob?: string;
  }): Promise<(Appointment & { name: string; mobile: string; dob: string; uhid: string }) | null> {
    const data = await hasuraQuery<{ appointments: HasuraApptRow[] }>(GET_LATEST_APPOINTMENT, {
      mobile: opts.mobile ?? null,
      uhid: opts.uhid ?? null,
      name: opts.name ?? null,
      dob: opts.dob ?? null,
    });

    const row = data.appointments[0];
    if (!row) return null;

    return {
      ...mapRow(row),
      name: row.patient?.name ?? "",
      mobile: row.patient?.mobile ?? "",
      dob: row.patient?.dob ?? "",
      uhid: row.patient?.uhid ?? "",
    };
  }
}
