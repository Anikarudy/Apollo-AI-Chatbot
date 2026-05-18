/**
 * backend/providers/prismaAppointmentProvider.ts
 *
 * Prisma/Postgres implementation of AppointmentProvider.
 */

import operationalPrisma from "../db/operationalPrismaClient";
import type { AppointmentProvider, AppointmentRecord, CreateAppointmentInput } from "./AppointmentProvider";

function toRecord(a: {
  id: string;
  patientId: string;
  doctorName: string;
  specialty: string | null;
  hospital: string | null;
  appointmentDate: string;
  slotTime: string;
  status: string;
  edocAppointmentId: string | null;
  createdAt: Date;
}): AppointmentRecord {
  return {
    id:                a.id,
    patientId:         a.patientId,
    doctorName:        a.doctorName,
    specialty:         a.specialty,
    hospital:          a.hospital,
    appointmentDate:   a.appointmentDate,
    slotTime:          a.slotTime,
    status:            a.status,
    edocAppointmentId: a.edocAppointmentId,
    createdAt:         a.createdAt,
  };
}

export const prismaAppointmentProvider: AppointmentProvider = {
  async createAppointment(input: CreateAppointmentInput): Promise<AppointmentRecord> {
    const a = await operationalPrisma.appointment.create({
      data: {
        patientId:         input.patientId,
        doctorName:        input.doctorName,
        specialty:         input.specialty ?? null,
        hospital:          input.hospital ?? null,
        appointmentDate:   input.appointmentDate,
        slotTime:          input.slotTime,
        edocAppointmentId: input.edocAppointmentId ?? null,
      },
    });
    return toRecord(a);
  },

  async getAppointmentsForPatient(patientId: string): Promise<AppointmentRecord[]> {
    const rows = await operationalPrisma.appointment.findMany({
      where:   { patientId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toRecord);
  },

  async updateStatus(appointmentId: string, status: string): Promise<AppointmentRecord> {
    const a = await operationalPrisma.appointment.update({
      where: { id: appointmentId },
      data:  { status },
    });
    return toRecord(a);
  },

  async updateStatusByEdocId(edocAppointmentId: string, status: string): Promise<AppointmentRecord | null> {
    const existing = await operationalPrisma.appointment.findFirst({
      where: { edocAppointmentId },
    });
    if (!existing) return null;
    const a = await operationalPrisma.appointment.update({
      where: { id: existing.id },
      data:  { status },
    });
    return toRecord(a);
  },
};
