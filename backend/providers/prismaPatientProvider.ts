/**
 * backend/providers/prismaPatientProvider.ts
 *
 * Prisma/Postgres implementation of PatientProvider.
 * To switch to Apollo's official API: create a new file implementing PatientProvider
 * and swap the import in patientService.ts. Nothing else changes.
 */

import operationalPrisma from "../db/operationalPrismaClient";
import type { PatientProvider, PatientRecord, CreatePatientInput } from "./PatientProvider";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Prisma } = require("@prisma/operational-client") as typeof import("@prisma/operational-client");

function toRecord(p: { id: string; phoneNumber: string; fullName: string; dob: string; uhid: string | null; createdAt: Date; updatedAt: Date }): PatientRecord {
  return {
    id:          p.id,
    phoneNumber: p.phoneNumber,
    fullName:    p.fullName,
    dob:         p.dob,
    uhid:        p.uhid,
    createdAt:   p.createdAt,
    updatedAt:   p.updatedAt,
  };
}

export const prismaPatientProvider: PatientProvider = {
  providerName: "prisma_local",

  async getPatientByPhone(phoneNumber: string): Promise<PatientRecord | null> {
    const p = await operationalPrisma.patient.findUnique({ where: { phoneNumber } });
    return p ? toRecord(p) : null;
  },

  async createPatient(input: CreatePatientInput): Promise<PatientRecord> {
    const p = await operationalPrisma.patient.create({
      data: {
        phoneNumber: input.phoneNumber,
        fullName:    input.fullName,
        dob:         input.dob,
        uhid:        input.uhid ?? null,
      },
    });
    return toRecord(p);
  },

  async setUhid(patientId: string, uhid: string): Promise<PatientRecord> {
    try {
      const p = await operationalPrisma.patient.update({
        where: { id: patientId },
        data:  { uhid },
      });
      return toRecord(p);
    } catch (err) {
      // P2002 = unique constraint — another patient already has this UHID
      // (edge case: EDOC reassigned an existing UHID). Log and return existing.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const existing = await operationalPrisma.patient.findFirst({ where: { uhid } });
        if (existing) return toRecord(existing);
      }
      throw err;
    }
  },
};
