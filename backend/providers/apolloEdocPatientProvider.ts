/**
 * backend/providers/apolloEdocPatientProvider.ts
 *
 * Apollo EDOC implementation of PatientProvider.
 *
 * Maps EDOC GetUHID / GenerateUHIDOnline responses to the standard PatientRecord shape.
 * createPatient() calls GenerateUHIDOnline; setUhid() is a no-op (EDOC owns the UHID).
 *
 * This provider throws on any EDOC failure so CompositePatientProvider can catch
 * and fall back to Prisma.
 */

import axios from "axios";
import type { PatientProvider, PatientRecord, CreatePatientInput } from "./PatientProvider";

// ── EDOC config — read lazily at call time so tests can set env vars ─────────
function edocBase()     { return (process.env.APOLLO_EDOC_BASE_URL ?? "").replace(/\/$/, ""); }
function edocAuth()     { return process.env.APOLLO_EDOC_AUTH_KEY  ?? ""; }
function edocRegion()   { return Number(process.env.APOLLO_EDOC_DEFAULT_REGION   ?? "5"); }
function edocLocation() { return process.env.APOLLO_EDOC_DEFAULT_LOCATION ?? ""; }

function edocHeaders() {
  return { AuthKey: edocAuth(), "Content-Type": "application/json" };
}

/** Converts an EDOC UHIDList entry to PatientRecord. */
function fromEdocEntry(entry: EdocUhidEntry, phoneNumber: string): PatientRecord {
  const now = new Date();
  return {
    // Use UHID as stable ID when coming from EDOC — no local UUID
    id:          entry.UHIDNumber ?? phoneNumber,
    phoneNumber,
    fullName:    [entry.FirstName, entry.LastName].filter(Boolean).join(" ").trim() || "Unknown",
    dob:         entry.DateOfBirth ?? "",
    uhid:        entry.UHIDNumber ?? null,
    createdAt:   now,
    updatedAt:   now,
  };
}

interface EdocUhidEntry {
  UHIDNumber?:  string;
  FirstName?:   string;
  LastName?:    string;
  DateOfBirth?: string;
}

interface EdocGetUhidResponse {
  getUHIDList?: EdocUhidEntry[];
  retcode?:     number;
}

interface EdocGenerateUhidResponse {
  result?:  string; // the assigned UHID
  retcode?: number;
}

export const apolloEdocPatientProvider: PatientProvider = {
  providerName: "apollo_edoc",

  async getPatientByPhone(phoneNumber: string): Promise<PatientRecord | null> {
    if (!edocBase() || !edocAuth()) {
      throw new Error("EDOC not configured");
    }

    const r = await axios.post<EdocGetUhidResponse>(
      `${edocBase()}/api/EDOC/GetUHID`,
      { MobileNumber: phoneNumber, RegionID: edocRegion(), UHIDNumber: "" },
      { headers: edocHeaders(), timeout: 10000 }
    );

    const list = r.data?.getUHIDList ?? [];
    const retcode = r.data?.retcode ?? -1;

    // retcode 0 with at least one entry = patient found
    if (retcode === 0 && list.length > 0) {
      return fromEdocEntry(list[0], phoneNumber);
    }

    // retcode non-zero or empty list = patient doesn't exist in EDOC
    return null;
  },

  async createPatient(input: CreatePatientInput): Promise<PatientRecord> {
    if (!edocBase() || !edocAuth()) {
      throw new Error("EDOC not configured");
    }
    if (!edocLocation()) {
      throw new Error("APOLLO_EDOC_DEFAULT_LOCATION not configured — cannot register via EDOC");
    }

    const nameParts = input.fullName.trim().split(/\s+/);
    const firstName = nameParts[0] ?? input.fullName;
    const lastName  = nameParts.slice(1).join(" ") || "";

    const r = await axios.post<EdocGenerateUhidResponse>(
      `${edocBase()}/api/EDOC/GenerateUHIDOnline`,
      {
        FirstName:   firstName,
        LastName:    lastName,
        MobileNumber: input.phoneNumber,
        DateOfBirth:  input.dob,
        LocationID:   edocLocation(),
        RegionID:     edocRegion(),
      },
      { headers: edocHeaders(), timeout: 15000 }
    );

    const uhid    = r.data?.result ?? "";
    const retcode = r.data?.retcode ?? -1;

    if (retcode !== 0 || !uhid) {
      throw new Error(`EDOC GenerateUHIDOnline failed (retcode=${retcode}, uhid=${uhid})`);
    }

    const now = new Date();
    return {
      id:          uhid,
      phoneNumber: input.phoneNumber,
      fullName:    input.fullName,
      dob:         input.dob,
      uhid,
      createdAt:   now,
      updatedAt:   now,
    };
  },

  /**
   * EDOC owns UHIDs — there is nothing to update on their side.
   * Return the record with the UHID already set.
   */
  async setUhid(_patientId: string, uhid: string): Promise<PatientRecord> {
    const now = new Date();
    return {
      id:          uhid,
      phoneNumber: "",
      fullName:    "",
      dob:         "",
      uhid,
      createdAt:   now,
      updatedAt:   now,
    };
  },
};
